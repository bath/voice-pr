import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFakeCli } from "./helpers/fake-cli.js";

// --- Deterministic environment, set BEFORE importing the module under test ---
// orchestrator.js reads POLL_MS / DISPATCH_TIMEOUT_MS / CONTAINER / CRED_PATH at
// import time, so they must be in place first. Traces are redirected to a temp
// dir so the suite never writes into the real ~/.voice-pr.
const ROOT = mkdtempSync(join(tmpdir(), "vp-orch-test-"));
process.env.VOICE_PR_ARCHIVE_DIR = join(ROOT, "sessions");
process.env.VOICE_PR_POLL_MS = "1";
process.env.VOICE_PR_DISPATCH_MS = "60000"; // generous: terminal tests return on the first poll
process.env.VOICE_PR_CONTAINER = "codingagent";
const CRED_PATH = join(ROOT, "cred.json");
process.env.VOICE_PR_ORCH_CRED = CRED_PATH;

const fake = installFakeCli(["docker"]);

const {
  assertOrchestrator,
  assertMayorAuth,
  checkOrchestrator,
  ensureProject,
  fileWorkItem,
  signalMayor,
  trackWorkItem,
} = await import("../lib/orchestrator.js");

const collector = () => {
  const events = [];
  const emit = (stage, detail) => events.push({ stage, detail });
  return { events, emit, stages: () => events.map((e) => e.stage) };
};

test("assertOrchestrator resolves when `pogo status` succeeds", async () => {
  fake.setRules([{ cmd: "docker", pattern: "pogo status", code: 0, stdout: "{}" }]);
  await assert.doesNotReject(assertOrchestrator());
});

test("assertOrchestrator throws a container-not-reachable error when `pogo status` fails", async () => {
  fake.setRules([{ cmd: "docker", pattern: "pogo status", code: 1, stdout: "" }]);
  await assert.rejects(assertOrchestrator(), /not reachable/i);
});

test("checkOrchestrator reports ok when container is up, mayor alive, and token valid", async () => {
  writeFileSync(CRED_PATH, JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 3600_000 } }));
  fake.setRules([
    { cmd: "docker", pattern: "pogo status", code: 0, stdout: "{}" },
    { cmd: "docker", pattern: "agent diagnose", code: 0, stdout: "Process alive: true" },
  ]);
  const r = await checkOrchestrator();
  assert.equal(r.ok, true);
  assert.match(r.detail, /mayor running/);
});

test("checkOrchestrator flags an unreachable container (not-ok, single-line detail)", async () => {
  fake.setRules([{ cmd: "docker", pattern: "pogo status", code: 1, stdout: "" }]);
  const r = await checkOrchestrator();
  assert.equal(r.ok, false);
  assert.match(r.detail, /not reachable/i);
});

test("checkOrchestrator flags a stopped mayor even when the container is reachable", async () => {
  writeFileSync(CRED_PATH, JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 3600_000 } }));
  fake.setRules([
    { cmd: "docker", pattern: "pogo status", code: 0, stdout: "{}" },
    { cmd: "docker", pattern: "agent diagnose", code: 0, stdout: "Process alive: false" },
  ]);
  const r = await checkOrchestrator();
  assert.equal(r.ok, false);
  assert.match(r.detail, /mayor agent not running/i);
});

test("checkOrchestrator flags an expired mayor Claude token (the silent-stall trap)", async () => {
  writeFileSync(CRED_PATH, JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() - 1000 } }));
  fake.setRules([
    { cmd: "docker", pattern: "pogo status", code: 0, stdout: "{}" },
    { cmd: "docker", pattern: "agent diagnose", code: 0, stdout: "Process alive: true" },
  ]);
  const r = await checkOrchestrator();
  assert.equal(r.ok, false);
  assert.match(r.detail, /token expired/i);
});

test("assertMayorAuth resolves when the mayor token is valid", async () => {
  writeFileSync(CRED_PATH, JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 3600_000 } }));
  await assert.doesNotReject(assertMayorAuth());
});

test("assertMayorAuth throws an actionable error when the mayor token is expired (dispatch fast-fail)", async () => {
  writeFileSync(CRED_PATH, JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() - 1000 } }));
  await assert.rejects(assertMayorAuth(), /token expired/i);
});

test("assertMayorAuth does not block when the token file is missing/unreadable (can't assess)", async () => {
  writeFileSync(CRED_PATH, "not json at all");
  await assert.doesNotReject(assertMayorAuth());
});

test("ensureProject clones and registers when the repo is absent from the workspace", async () => {
  fake.setRules([
    { cmd: "docker", pattern: "test -d", code: 1, stdout: "" }, // .git absent
    { cmd: "docker", pattern: "git clone", code: 0, stdout: "" },
    { cmd: "docker", pattern: "project add", code: 0, stdout: "" },
  ]);
  const { events, emit, stages } = collector();
  const path = await ensureProject({ owner: "o", repo: "r" }, "feat", emit);
  assert.equal(path, "/home/pogo/workspace/r");
  assert.deepEqual(stages(), ["cloning", "project-ready"]);
  assert.equal(events[0].detail.branch, "feat");
  assert.ok(fake.calls().some((c) => c.args.includes("git clone") && c.args.includes("--branch feat")));
});

test("ensureProject refreshes an existing checkout instead of re-cloning", async () => {
  fake.setRules([
    { cmd: "docker", pattern: "test -d", code: 0, stdout: "" }, // .git present
    { cmd: "docker", pattern: "project add", code: 0, stdout: "" },
  ]);
  const { stages } = collector();
  const c = collector();
  const path = await ensureProject({ owner: "o", repo: "r" }, "feat", c.emit);
  assert.equal(path, "/home/pogo/workspace/r");
  assert.deepEqual(c.stages(), ["project-ready"]); // no clone
  const calls = fake.calls().map((x) => x.args).join("\n");
  assert.doesNotMatch(calls, /git clone/);
  assert.match(calls, /reset --hard origin\/feat/);
});

test("fileWorkItem parses the work-item id out of mg's `Created <id>` line", async () => {
  fake.setRules([{ cmd: "docker", pattern: "mg new", code: 0, stdout: "Created ca-11f8: voice-pr session" }]);
  const id = await fileWorkItem({ repoPath: "/w/r", headRef: "feat", pr: { number: 7 }, body: "b", title: "t" });
  assert.equal(id, "ca-11f8");
});

test("fileWorkItem throws when mg output has no parseable id", async () => {
  fake.setRules([{ cmd: "docker", pattern: "mg new", code: 0, stdout: "something unexpected" }]);
  await assert.rejects(
    fileWorkItem({ repoPath: "/w/r", headRef: "feat", pr: { number: 7 }, body: "b", title: "t" }),
    /could not parse work item id/i
  );
});

test("signalMayor mails the mayor a dispatch-ready ask (not a PTY nudge)", async () => {
  fake.setRules([{ cmd: "docker", pattern: "mg mail send", code: 0, stdout: "" }]);
  await signalMayor({ id: "ca-11f8", pr: { number: 7 }, headRef: "feat" });
  const call = fake.calls().find((c) => c.args.includes("mg mail send"));
  assert.ok(call, "expected an `mg mail send` call");
  assert.match(call.args, /mg mail send mayor/);
  assert.match(call.args, /dispatch-ready: ca-11f8/);
});

test("trackWorkItem derives done from a done work-item status", async () => {
  fake.setRules([
    { cmd: "docker", pattern: "mg show", code: 0, stdout: "Status: done" },
    { cmd: "docker", pattern: "refinery history", code: 0, stdout: "[]" },
  ]);
  const { emit, stages } = collector();
  const outcome = await trackWorkItem("ca-11f8", "/w/r", emit);
  assert.equal(outcome.status, "done");
  assert.ok(stages().includes("work-status"));
});

test("trackWorkItem derives done from a merged refinery request even if the item still reads available", async () => {
  fake.setRules([
    { cmd: "docker", pattern: "mg show", code: 0, stdout: "Status: available" },
    {
      cmd: "docker",
      pattern: "refinery history",
      code: 0,
      stdout: '[{"branch":"polecat-ca-11f8","status":"merged"}]',
    },
  ]);
  const { emit } = collector();
  const outcome = await trackWorkItem("ca-11f8", "/w/r", emit);
  assert.equal(outcome.status, "done");
  assert.equal(outcome.refinery.status, "merged");
});

test("trackWorkItem derives failed from a failed refinery request", async () => {
  fake.setRules([
    { cmd: "docker", pattern: "mg show", code: 0, stdout: "Status: in_progress" },
    {
      cmd: "docker",
      pattern: "refinery history",
      code: 0,
      stdout: '[{"branch":"polecat-ca-11f8","status":"failed"}]',
    },
  ]);
  const { emit } = collector();
  const outcome = await trackWorkItem("ca-11f8", "/w/r", emit);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.refinery.status, "failed");
});

test("#47: trackWorkItem completes via landed commits even when the poll never flips terminal", async () => {
  // The exact stuck-forever world: mg stays available, refinery empty. A commit
  // landing on the branch must end the track as done via the commit signal.
  fake.setRules([
    { cmd: "docker", pattern: "mg show", code: 0, stdout: "Status: available" },
    { cmd: "docker", pattern: "refinery history", code: 0, stdout: "[]" },
  ]);
  const { emit, stages } = collector();
  const landed = [{ oid: "cafef00d", messageHeadline: "landed work" }];
  const outcome = await trackWorkItem("ca-11f8", "/w/r", emit, {
    commitsLanded: async () => landed,
  });
  assert.equal(outcome.status, "done");
  assert.equal(outcome.via, "commits");
  assert.deepEqual(outcome.commits, landed);
  assert.ok(stages().includes("commits-landed"));
});

test("#47: trackWorkItem advances promptly the moment commits land (not before)", async () => {
  fake.setRules([
    { cmd: "docker", pattern: "mg show", code: 0, stdout: "Status: available" },
    { cmd: "docker", pattern: "refinery history", code: 0, stdout: "[]" },
  ]);
  const { emit } = collector();
  let polls = 0;
  // Empty for the first two polls, then a commit lands.
  const outcome = await trackWorkItem("ca-11f8", "/w/r", emit, {
    commitsLanded: async () => (++polls >= 3 ? [{ oid: "abc123", messageHeadline: "x" }] : []),
  });
  assert.equal(outcome.status, "done");
  assert.equal(outcome.via, "commits");
  assert.equal(polls, 3, "should return on the poll where the commit first appears");
});

test("cleanup", () => {
  fake.cleanup();
});
