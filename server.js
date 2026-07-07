#!/usr/bin/env node
// voice-pr — local bridge for the Chrome extension. The content script can't
// fetch localhost directly, so the extension's background worker proxies to
// these endpoints, which transcribe locally and dispatch to the orchestrator.
import { createServer } from "node:http";
import { runSession, getContext } from "./lib/pipeline.js";
import { transcribe, anchorSegments, checkStt } from "./lib/transcribe.js";
import { checkOrchestrator } from "./lib/orchestrator.js";
import { run } from "./lib/exec.js";
import { saveAudio, saveJson } from "./lib/archive.js";
import { withTracer } from "./lib/trace.js";

const PORT = Number(process.env.PORT || 4100);

// The Chrome extension calls these endpoints from the github.com origin, so
// every response is CORS-open and preflights are answered.
function cors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  // Chrome Private Network Access: an https page (github.com) fetching this
  // localhost bridge needs the server to opt in, or the preflight is blocked.
  res.setHeader("access-control-allow-private-network", "true");
}

const server = createServer(async (req, res) => {
  try {
    cors(res);
    const url = new URL(req.url, "http://localhost");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    if (req.method === "GET" && url.pathname === "/api/context")
      return await handleContext(url, res);
    if (req.method === "GET" && url.pathname === "/api/preflight")
      return await handlePreflight(res);
    if (req.method === "POST" && url.pathname === "/api/transcribe")
      return await handleTranscribe(req, res);
    if (req.method === "POST" && url.pathname === "/api/dispatch")
      return await handleDispatch(req, res);
    res.writeHead(404).end("not found");
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end(`error: ${e.message}`);
  }
});

// Combined, fire-and-forget path for the extension: transcribe the recording
// AND dispatch to the orchestrator, entirely server-side, streaming progress.
// Completes even if the client closes the tab.
async function handleDispatch(req, res) {
  const body = await readBody(req);
  const input = JSON.parse(body || "{}");
  const { prRef, sessionId, audioB64, ext = "webm", timeline = [], audioStartMs = 0, typedSegments = [] } = input;
  const sid = sessionId || `anon-${Date.now()}`;

  res.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
  });
  // The client (PR tab) can close mid-run — that's the whole point ("close the
  // tab, work continues"). Swallow the socket error so a dead client can't
  // bubble an uncaught 'error' and take the whole server down.
  res.on("error", () => {});

  // Open a trace scope for the whole session: everything below — transcribe,
  // the pipeline, every child process — logs to this sessionId, and the
  // recording's trace.ndjson sits next to its audio.webm on disk.
  return withTracer(sid, { prRef }, async (tracer) => {
    await tracer.markLatest({ prRef, kind: "dispatch" });
    tracer.event("bridge.dispatch.start", {
      prRef,
      hasAudio: !!audioB64,
      ext,
      timeline: timeline.length,
      typed: (typedSegments || []).length,
      audioBytes: audioB64 ? Math.round(audioB64.length * 0.75) : 0,
    });

    const t0 = Date.now();
    const events = [];
    // Single funnel for every progress event streamed to the client. Each stage
    // name is also traced verbatim as its `code`, so grepping the code string
    // lands on the emit site (in this file, lib/pipeline.js, or orchestrator.js).
    const send = (stage, detail) => {
      const t = Math.round((Date.now() - t0) / 1000);
      events.push({ stage, detail, t });
      if (stage !== "error") tracer.event(stage, detail || {});
      // Skip the write once the client is gone; keep running so the session still
      // finishes and archives server-side.
      if (res.writableEnded || res.destroyed) return;
      res.write(JSON.stringify({ stage, detail, t }) + "\n");
    };

    let segs = [...(typedSegments || [])];
    let result = null,
      err = null;
    try {
      if (audioB64) {
        send("transcribing", {});
        const audio = Buffer.from(audioB64, "base64");
        const raw = await transcribe(audio, ext);
        const anchored = anchorSegments(raw, timeline, { offsetMs: audioStartMs });
        if (sessionId) {
          await saveAudio(sessionId, audio, ext);
          await saveJson(sessionId, "transcript.json", {
            at: new Date().toISOString(),
            prUrl: prRef,
            raw: raw.map((s) => s.text).join(" "),
            segments: anchored,
            rawSegments: raw,
            timeline,
          });
        }
        send("transcribed", { count: anchored.length, text: raw.map((s) => s.text).join(" ") });
        segs = [...anchored, ...segs];
      }
      if (!segs.length) throw new Error("nothing captured — no speech and no typed comments");
      result = await runSession({ prRef, segments: segs }, send);
      send("result", result);
      tracer.event("bridge.dispatch.done", { workItemId: result?.workItemId, status: result?.status });
    } catch (e) {
      err = e.message;
      // The error record carries the origin (loc) + a stable code; forward both
      // to the client so the panel's "Copy error" report can point an AI agent
      // straight at the failing code path.
      const rec = tracer.error("bridge.dispatch.error", e);
      send("error", { message: e.message, code: rec.code, loc: rec.loc, sessionId: sid });
    } finally {
      if (sessionId)
        await saveJson(sessionId, "session.json", {
          at: new Date().toISOString(),
          prRef,
          segments: segs,
          transcript: segs.map((s) => s.text).join(" "),
          result,
          error: err,
          events,
        }).catch(() => {});
      res.end();
    }
  });
}

async function handleTranscribe(req, res) {
  const body = await readBody(req);
  const { audioB64, ext = "webm", timeline = [], audioStartMs = 0, sessionId, prUrl } = JSON.parse(body || "{}");
  const sid = sessionId || `transcribe-${Date.now()}`;
  return withTracer(sid, { prUrl }, async (tracer) => {
    try {
      if (!audioB64) throw new Error("no audio");
      const audio = Buffer.from(audioB64, "base64");
      await tracer.markLatest({ prRef: prUrl, kind: "transcribe" });
      tracer.event("bridge.transcribe.start", { kb: Math.round(audio.length / 1024), ext, timeline: timeline.length });
      const t0 = Date.now();
      const segs = await transcribe(audio, ext);
      const anchored = anchorSegments(segs, timeline, { offsetMs: audioStartMs });
      tracer.event("bridge.transcribe.done", { segments: segs.length, ms: Date.now() - t0 });
      // archive the recording + transcript as a reusable fixture
      if (sessionId) {
        await saveAudio(sessionId, audio, ext);
        await saveJson(sessionId, "transcript.json", {
          at: new Date().toISOString(),
          prUrl: prUrl || null,
          raw: segs.map((s) => s.text).join(" "),
          segments: anchored,
          rawSegments: segs,
          timeline,
        });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ segments: anchored, raw: segs.map((s) => s.text).join(" ") }));
    } catch (e) {
      const rec = tracer.error("bridge.transcribe.error", e);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message, code: rec.code, loc: rec.loc, sessionId: sid }));
    }
  });
}

// End-to-end preflight for the debug panel: probe every dependency the dispatch
// path actually needs, so you can confirm the whole chain is live BEFORE you
// record. Each check is independent and non-fatal — the report lists what's up
// and what's not.
async function handlePreflight(res) {
  return withTracer(`preflight-${Date.now()}`, {}, async (tracer) => {
    tracer.event("bridge.preflight.start", {});
    const report = await runPreflight();
    tracer.event("bridge.preflight.done", { ok: report.ok, failing: report.checks.filter((c) => !c.ok).map((c) => c.name) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(report));
  });
}

async function runPreflight() {
  const checks = [{ name: "bridge", ok: true, detail: `listening on :${PORT}` }];

  const stt = await checkStt();
  checks.push({ name: "ffmpeg", ok: stt.ffmpeg, detail: stt.ffmpeg ? "ok" : stt.detail });
  checks.push({ name: "whisper", ok: stt.whisper, detail: stt.whisper ? "ok" : stt.detail });
  checks.push({ name: "whisper model", ok: stt.model, detail: stt.model ? "ok" : stt.detail });

  let gh = { ok: false, detail: "" };
  try { await run("gh", ["auth", "status"]); gh.ok = true; gh.detail = "authenticated"; }
  catch (e) { gh.detail = `gh not authenticated (${e.message.split("\n")[0]})`; }
  checks.push({ name: "gh auth", ok: gh.ok, detail: gh.detail });

  const orch = await checkOrchestrator();
  checks.push({ name: "orchestrator", ok: orch.ok, detail: orch.detail });

  return { ok: checks.every((c) => c.ok), checks };
}

async function handleContext(url, res) {
  const prRef = url.searchParams.get("pr");
  return withTracer(`context-${Date.now()}`, { prRef }, async (tracer) => {
    try {
      tracer.event("bridge.context.start", { prRef });
      const ctx = await getContext(prRef);
      tracer.event("bridge.context.done", { pr: ctx?.pr?.number, jiraKey: ctx?.jiraKey });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(ctx));
    } catch (e) {
      const rec = tracer.error("bridge.context.error", e);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message, code: rec.code, loc: rec.loc }));
    }
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}

// Fault isolation: a single in-flight session spawns many child processes
// (docker exec, gh, git, claude) over several minutes. Before, ANY async error
// with no local catch — a child stdin EPIPE, a broken pipe, a stray rejection —
// killed the whole process and every other in-flight session with it. Log and
// stay up instead; the offending request already reports its own error, and the
// supervisor (scripts/serve.js) is the backstop for a truly fatal state.
process.on("uncaughtException", (e) => {
  console.error(`[uncaughtException] ${e?.stack || e}`);
});
process.on("unhandledRejection", (e) => {
  console.error(`[unhandledRejection] ${e?.stack || e}`);
});

server.on("error", (e) => {
  if (e?.code === "EADDRINUSE") {
    console.error(`\n  ✗ port ${PORT} is already in use — is voice-pr already running?\n`);
    process.exit(1);
  }
  console.error(`[server] ${e?.stack || e}`);
});

server.listen(PORT, () => {
  console.log(`\n  🎙️  voice-pr bridge running → http://localhost:${PORT}\n`);
  console.log("  Load the extension, open a PR's Files changed tab, and talk.\n");
});
