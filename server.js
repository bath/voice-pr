#!/usr/bin/env node
// voice-pr — local service. Serves the mic UI and streams batch progress.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { runBatch, runSession, getContext } from "./lib/pipeline.js";
import { transcribe, anchorSegments } from "./lib/transcribe.js";
import { saveAudio, saveJson, ARCHIVE_ROOT } from "./lib/archive.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "public");
const PORT = Number(process.env.PORT || 4100);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

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
    if (req.method === "POST" && url.pathname === "/api/transcribe")
      return await handleTranscribe(req, res);
    if (req.method === "POST" && url.pathname === "/api/dispatch")
      return await handleDispatch(req, res);
    if (req.method === "POST" && url.pathname === "/api/session")
      return await handleStream(req, res, (input, send) => runSession(input, send));
    if (req.method === "POST" && url.pathname === "/api/batch")
      return await handleStream(req, res, (input, send) => runBatch(input, send));
    if (req.method === "GET") return await serveStatic(req, res);
    res.writeHead(405).end("method not allowed");
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

  res.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
  });
  const t0 = Date.now();
  const events = [];
  const send = (stage, detail) => {
    events.push({ stage, detail, t: Math.round((Date.now() - t0) / 1000) });
    res.write(JSON.stringify({ stage, detail, t: Math.round((Date.now() - t0) / 1000) }) + "\n");
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
  } catch (e) {
    err = e.message;
    console.error(`[dispatch] error: ${e.message}`);
    send("error", { message: e.message });
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
}

async function handleTranscribe(req, res) {
  try {
    const body = await readBody(req);
    const { audioB64, ext = "webm", timeline = [], audioStartMs = 0, sessionId, prUrl } = JSON.parse(body || "{}");
    if (!audioB64) throw new Error("no audio");
    const audio = Buffer.from(audioB64, "base64");
    console.log(`[transcribe] ${(audio.length / 1024).toFixed(0)}KB ${ext}, ${timeline.length} timeline pts`);
    const t0 = Date.now();
    const segs = await transcribe(audio, ext);
    const anchored = anchorSegments(segs, timeline, { offsetMs: audioStartMs });
    console.log(`[transcribe] ${segs.length} segments in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
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
    console.error(`[transcribe] error: ${e.message}`);
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function handleContext(url, res) {
  const prRef = url.searchParams.get("pr");
  try {
    const ctx = await getContext(prRef);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(ctx));
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function serveStatic(req, res) {
  const rel = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const path = join(PUBLIC, rel);
  if (!path.startsWith(PUBLIC)) return res.writeHead(403).end("forbidden");
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": MIME[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

async function handleStream(req, res, runner) {
  const body = await readBody(req);
  const input = JSON.parse(body || "{}");

  // Stream progress as newline-delimited JSON so the client can render it live.
  res.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
  });
  const t0 = Date.now();
  const events = [];
  const send = (stage, detail) => {
    events.push({ stage, detail, t: Math.round((Date.now() - t0) / 1000) });
    res.write(JSON.stringify({ stage, detail, t: Math.round((Date.now() - t0) / 1000) }) + "\n");
  };

  let result = null,
    err = null;
  try {
    console.log(
      `[req] PR=${input.prRef} ${input.segments ? `${input.segments.length} segments` : "transcript"}`
    );
    result = await runner(input, send);
    send("result", result);
    console.log(
      result.backend === "orchestrator"
        ? `[req] orchestrator: work item ${result.workItemId} -> ${result.status}`
        : `[req] done: ${result.committed.length} committed`
    );
  } catch (e) {
    err = e.message;
    console.error(`[req] error: ${e.message}`);
    send("error", { message: e.message });
  } finally {
    // archive the whole session (input + every event + result) as a fixture
    if (input.sessionId) {
      await saveJson(input.sessionId, "session.json", {
        at: new Date().toISOString(),
        prRef: input.prRef,
        segments: input.segments || null,
        transcript: (input.segments || []).map((s) => s.text).join(" "),
        result,
        error: err,
        events,
      }).catch(() => {});
    }
    res.end();
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}

server.listen(PORT, () => {
  console.log(`\n  🎙️  voice-pr running → http://localhost:${PORT}\n`);
  console.log("  Open it in Chrome, paste a PR URL, hold the button, talk.\n");
});
