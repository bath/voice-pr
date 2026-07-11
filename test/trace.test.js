import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// The archive/log roots are resolved at import time from this env var, so it
// must be set before lib/trace.js (which imports lib/archive.js) is loaded.
const ROOT = await mkdtemp(join(tmpdir(), "vp-trace-test-"));
process.env.VOICE_PR_ARCHIVE_DIR = join(ROOT, "sessions");
const HOME = ROOT; // dirname(sessions) — where bridge.ndjson + last-session.json live

const { withTracer, getTracer, flush, areasFor, CODE_MAP } = await import("../lib/trace.js");

async function readSessionTrace(id) {
  const text = await readFile(join(ROOT, "sessions", id, "trace.ndjson"), "utf8");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("records carry the correlation id, event code, and source location", async () => {
  await withTracer("sess-A", { prRef: "o/r#1" }, async (t) => {
    t.event("bridge.dispatch.start", { hasAudio: true });
  });
  await flush();
  const recs = await readSessionTrace("sess-A");
  assert.equal(recs.length, 1);
  const r = recs[0];
  assert.equal(r.sessionId, "sess-A");
  assert.equal(r.code, "bridge.dispatch.start");
  assert.equal(r.prRef, "o/r#1"); // meta merged in
  assert.deepEqual(r.detail, { hasAudio: true });
  // loc is captured from the emit call site — this test file, not trace.js.
  assert.match(r.loc, /trace\.test\.js:\d+$/);
});

test("getTracer() returns the ambient tracer inside a scope", async () => {
  await withTracer("sess-B", {}, async (outer) => {
    assert.equal(getTracer(), outer);
    assert.equal(getTracer().sessionId, "sess-B");
  });
  // Outside any scope: a scopeless fallback tracer, never throws.
  assert.equal(getTracer().sessionId, "no-session");
});

test("error() records level, message, and a stack tail", async () => {
  await withTracer("sess-C", {}, async (t) => {
    const rec = t.error("bridge.dispatch.error", new Error("boom"));
    assert.equal(rec.level, "error");
    assert.equal(rec.detail.message, "boom");
    assert.match(rec.detail.stack, /Error: boom/);
    assert.equal(rec.code, "bridge.dispatch.error");
  });
  await flush();
  const recs = await readSessionTrace("sess-C");
  assert.equal(recs[0].level, "error");
});

test("safe() drops binary buffers and truncates oversized strings", async () => {
  await withTracer("sess-D", {}, async (t) => {
    t.event("exec.spawn", { buf: Buffer.alloc(1234), big: "x".repeat(5000), small: "ok" });
  });
  await flush();
  const [r] = await readSessionTrace("sess-D");
  assert.equal(r.detail.buf, "<Buffer 1234B>");
  assert.ok(r.detail.big.length < 5000 && r.detail.big.includes("…"));
  assert.equal(r.detail.small, "ok");
});

test("markLatest() writes the most-recent-session pointer", async () => {
  await withTracer("sess-E", {}, async (t) => {
    await t.markLatest({ kind: "dispatch" });
  });
  const ptr = JSON.parse(await readFile(join(HOME, "last-session.json"), "utf8"));
  assert.equal(ptr.sessionId, "sess-E");
  assert.equal(ptr.kind, "dispatch");
});

test("events also fan out to the global rolling log", async () => {
  await withTracer("sess-F", {}, async (t) => t.event("bridge.context.start", {}));
  await flush();
  const global = await readFile(join(HOME, "bridge.ndjson"), "utf8");
  assert.match(global, /"sessionId":"sess-F"/);
});

test("areasFor maps code prefixes to source locations, with a fallback", () => {
  const areas = areasFor(["exec.fail", "agent.warm"]);
  assert.ok(areas.some((a) => a.includes("lib/exec.js")));
  assert.ok(areas.some((a) => a.includes("lib/agent.js")));
  // an unmatched code still yields a non-empty hint
  assert.equal(areasFor(["totally-unknown-code"]).length, 1);
  assert.ok(Object.keys(CODE_MAP).length > 0);
});
