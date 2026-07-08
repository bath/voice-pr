// voice-pr traceability spine.
//
// Every meaningful thing the bridge does — a request, a child process, a stage
// transition, an error — is recorded as one structured NDJSON line carrying:
//   - sessionId : the correlation id that also names the recording on disk, so a
//                 single id ties the audio, transcript, and every downstream
//                 event together.
//   - code      : a stable dotted event name (e.g. "bridge.dispatch.transcribe").
//                 Grep the codebase for the literal string and you land on the
//                 exact emit site — this is what lets an AI agent map an error
//                 back to the program flow with zero guessing.
//   - loc       : file:line of the emit call, captured automatically from the
//                 stack. Same idea, but exact.
//
// Records fan out to three sinks: the session's own trace.ndjson (full backup of
// one recording's life), a global rolling bridge.ndjson (chronological across
// sessions), and the console. A last-session.json pointer makes "look at my most
// recent recording and figure out what happened" a one-lookup operation.
//
// Ambient propagation is via AsyncLocalStorage: whoever handles a request opens
// a `tracer.run(sessionId, …)` scope, and any code beneath it — exec.run, the
// pipeline, the orchestrator — logs to that session's tracer via getTracer()
// without threading a tracer argument through every call.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir, writeFile, stat, rename } from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHIVE_ROOT } from "./archive.js";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME_DIR = dirname(ARCHIVE_ROOT); // ~/.voice-pr
const GLOBAL_LOG = join(HOME_DIR, "bridge.ndjson");
const LAST_POINTER = join(HOME_DIR, "last-session.json");
const GLOBAL_LOG_MAX_BYTES = Number(process.env.VOICE_PR_LOG_MAX_BYTES || 5_000_000);
const sessionDir = (id) => join(ARCHIVE_ROOT, String(id).replace(/[^\w.-]/g, "_"));

const als = new AsyncLocalStorage();

// Serialize appends per file so concurrent sessions can't interleave a line.
const tails = new Map();
function append(path, text) {
  const prev = tails.get(path) || Promise.resolve();
  const next = prev
    .then(() => mkdir(dirname(path), { recursive: true }))
    .then(() => appendFile(path, text))
    .catch((e) => {
      // Logging must never take down the thing it's logging.
      process.stderr.write(`[trace] sink write failed (${path}): ${e.message}\n`);
    });
  tails.set(path, next);
  return next;
}

// Best-effort, once per process: keep the global log from growing without bound
// by rotating a single backup when it crosses the cap.
let rotated = false;
async function rotateGlobalOnce() {
  if (rotated) return;
  rotated = true;
  try {
    const s = await stat(GLOBAL_LOG);
    if (s.size > GLOBAL_LOG_MAX_BYTES) await rename(GLOBAL_LOG, `${GLOBAL_LOG}.1`);
  } catch {
    /* no log yet, or rename raced — fine */
  }
}

// Turn a stack into the first call site outside this module: "lib/pipeline.js:96".
function callSite() {
  const stack = new Error().stack || "";
  const lines = stack.split("\n").slice(1);
  for (const raw of lines) {
    const m = raw.match(/\(?((?:\/|[A-Za-z]:\\|file:).*?):(\d+):(\d+)\)?\s*$/);
    if (!m) continue;
    let file = m[1];
    if (file.startsWith("file:")) file = fileURLToPath(file);
    if (file === fileURLToPath(import.meta.url)) continue; // skip trace.js frames
    const rel = isAbsolute(file) ? relative(REPO_ROOT, file) : file;
    return `${rel}:${m[2]}`;
  }
  return null;
}

let seq = 0;

export class Tracer {
  constructor(sessionId, meta = {}) {
    this.sessionId = sessionId || "no-session";
    this.meta = meta;
  }

  /**
   * Record one event. `code` is a stable dotted name; `detail` is any
   * JSON-serializable context. Returns the written record so callers can, e.g.,
   * forward its `loc` to a client.
   */
  event(code, detail = {}, level = "info") {
    const rec = {
      seq: seq++,
      t: new Date().toISOString(),
      level,
      sessionId: this.sessionId,
      code,
      loc: callSite(),
      ...this.meta,
      detail: safe(detail),
    };
    const line = JSON.stringify(rec) + "\n";
    if (this.sessionId && this.sessionId !== "no-session")
      append(join(sessionDir(this.sessionId), "trace.ndjson"), line);
    rotateGlobalOnce().then(() => append(GLOBAL_LOG, line));
    // Console mirror: one grep-able line per event. The exec.* spawn/exit pair
    // fires twice every poll cycle while a session is tracked (see trackWorkItem
    // in orchestrator.js) — high volume, low signal — so those info lines are
    // muted from the console by default. They're still written to both NDJSON
    // sinks; set VOICE_PR_TRACE_EXEC=1 to also see them here. Warnings and
    // errors (e.g. exec.fail) always print regardless.
    if (!(level === "info" && code.startsWith("exec.") && !process.env.VOICE_PR_TRACE_EXEC)) {
      const tag = level === "error" ? "✗" : level === "warn" ? "!" : "·";
      const msg = detail && detail.message ? ` ${detail.message}` : "";
      (level === "error" ? console.error : console.log)(
        `[${this.sessionId}] ${tag} ${code}${msg}`
      );
    }
    return rec;
  }

  warn(code, detail) {
    return this.event(code, detail, "warn");
  }

  /**
   * Record an error with its message + stack. Returns the record (with `loc`)
   * so the caller can surface the origin to the user / client.
   */
  error(code, err, detail = {}) {
    return this.event(
      code,
      {
        ...detail,
        message: err?.message || String(err),
        stack: (err?.stack || "").split("\n").slice(0, 6).join("\n"),
      },
      "error"
    );
  }

  /** Mark the correlation id as the most recent session (for `npm run trace`). */
  async markLatest(extra = {}) {
    if (!this.sessionId || this.sessionId === "no-session") return;
    await mkdir(HOME_DIR, { recursive: true }).catch(() => {});
    await writeFile(
      LAST_POINTER,
      JSON.stringify({ sessionId: this.sessionId, at: new Date().toISOString(), ...extra }, null, 2)
    ).catch(() => {});
  }
}

/** Await all pending sink writes — for tests and orderly shutdown. */
export function flush() {
  return Promise.allSettled([...tails.values()]);
}

/** Run `fn` inside a tracer scope so ambient code can reach it via getTracer(). */
export function withTracer(sessionId, meta, fn) {
  const tracer = new Tracer(sessionId, meta);
  return als.run(tracer, () => fn(tracer));
}

/**
 * The tracer for the current async scope. Falls back to a scopeless tracer that
 * still logs (to the global log + console) — so ambient callers like exec.run
 * can log unconditionally, whether or not a request opened a scope.
 */
export function getTracer() {
  return als.getStore() || new Tracer(null);
}

// Drop obviously-huge / binary fields so a stray audio buffer can never bloat
// the log. Shallow — detail objects here are small and flat by construction.
function safe(detail) {
  if (!detail || typeof detail !== "object") return detail;
  const out = {};
  for (const [k, v] of Object.entries(detail)) {
    if (typeof v === "string" && v.length > 4000) out[k] = v.slice(0, 4000) + `…(+${v.length - 4000})`;
    else if (Buffer.isBuffer(v)) out[k] = `<Buffer ${v.length}B>`;
    else out[k] = v;
  }
  return out;
}

/**
 * Where each event-code prefix lives, for the "areas to look" section of a
 * diagnostic report. Keys are matched as prefixes against a code.
 */
export const CODE_MAP = {
  "bridge.": "server.js — HTTP endpoints (context/preflight/transcribe/dispatch)",
  "exec.": "lib/exec.js — child-process spawns (gh, git, docker, ffmpeg, whisper)",
  "stt.": "lib/transcribe.js — local whisper transcription",
  "pipeline.": "lib/pipeline.js — session → PR resolution → orchestrator submit",
  "orchestrator.": "lib/orchestrator.js — docker exec into the pogo container",
  "queue.": "lib/branch-queue.js — per-branch dispatch serialization",
  "github.": "lib/github.js — gh PR view / comment",
};

/** Human-readable "areas to look" for the codes actually present in a trace. */
export function areasFor(codes) {
  const hits = new Set();
  for (const code of codes)
    for (const [prefix, where] of Object.entries(CODE_MAP))
      if (code.startsWith(prefix)) hits.add(where);
  if (!hits.size) hits.add("grep the codes in this trace across server.js, lib/, and extension/");
  return [...hits];
}
