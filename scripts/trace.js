#!/usr/bin/env node
// `npm run trace [sessionId]` — dump a recording session's full trace, formatted
// for an AI agent to diagnose. With no id it opens the most recent session, so
// "tell an agent to look at my last recording and figure out what happened" is
// literally one command. Every line carries a `code` (a literal string in the
// source) and a `loc` (file:line), so the agent can walk symptom → code → fix.
//
//   npm run trace                 # most recent session
//   npm run trace <sessionId>     # a specific session
//   npm run trace --list          # recent sessions, newest first
//   npm run trace [id] --json     # raw parsed records (for programmatic use)
import { readFile, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { ARCHIVE_ROOT } from "../lib/archive.js";
import { areasFor } from "../lib/trace.js";

const HOME = dirname(ARCHIVE_ROOT);
const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const wantList = args.includes("--list");
const idArg = args.find((a) => !a.startsWith("--"));

async function listSessions() {
  let names;
  try {
    names = await readdir(ARCHIVE_ROOT);
  } catch {
    return [];
  }
  const rows = [];
  for (const n of names) {
    try {
      const s = await stat(join(ARCHIVE_ROOT, n));
      if (s.isDirectory()) rows.push({ id: n, mtime: s.mtimeMs });
    } catch {
      /* skip */
    }
  }
  return rows.sort((a, b) => b.mtime - a.mtime);
}

async function lastSessionId() {
  try {
    const ptr = JSON.parse(await readFile(join(HOME, "last-session.json"), "utf8"));
    return ptr.sessionId;
  } catch {
    const [latest] = await listSessions();
    return latest?.id || null;
  }
}

async function readNdjson(path) {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { code: "PARSE_ERROR", detail: { raw: l } };
      }
    });
}

async function readJsonMaybe(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function fmtRecord(r) {
  const t = (r.t || "").slice(11, 23);
  const lvl = r.level === "error" ? "ERR " : r.level === "warn" ? "WARN" : "    ";
  const loc = r.loc ? `  (${r.loc})` : "";
  const msg = r.detail && r.detail.message ? `  ${r.detail.message}` : "";
  return `${String(r.seq ?? "").padStart(3)}  ${t}  ${lvl}  ${r.code}${loc}${msg}`;
}

async function main() {
  if (wantList) {
    const rows = await listSessions();
    const last = await lastSessionId();
    if (!rows.length) {
      console.log(`no sessions yet under ${ARCHIVE_ROOT}`);
      return;
    }
    console.log(`recent sessions (${ARCHIVE_ROOT}):\n`);
    for (const r of rows.slice(0, 25))
      console.log(`  ${r.id === last ? "→" : " "} ${r.id}   ${new Date(r.mtime).toISOString()}`);
    return;
  }

  const id = idArg || (await lastSessionId());
  if (!id) {
    console.error(`no session found. Record something first, or pass an id. (${ARCHIVE_ROOT})`);
    process.exitCode = 1;
    return;
  }

  const dir = join(ARCHIVE_ROOT, String(id).replace(/[^\w.-]/g, "_"));
  let records;
  try {
    records = await readNdjson(join(dir, "trace.ndjson"));
  } catch {
    console.error(`no trace.ndjson for session "${id}" (looked in ${dir}).`);
    console.error(`run \`npm run trace --list\` to see available sessions.`);
    process.exitCode = 1;
    return;
  }

  if (jsonOut) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }

  const session = await readJsonMaybe(join(dir, "session.json"));
  const errors = records.filter((r) => r.level === "error");
  const codes = [...new Set(records.map((r) => r.code))];

  const out = [];
  out.push("===== voice-pr session trace =====");
  out.push(`session:  ${id}`);
  out.push(`dir:      ${dir}`);
  if (session) {
    out.push(`pr:       ${session.prRef || "?"}`);
    if (session.result) out.push(`result:   ${session.result.status} (agent ${session.result.agentId || "?"})`);
    if (session.error) out.push(`error:    ${session.error}`);
    if (session.transcript) out.push(`spoken:   "${session.transcript.slice(0, 160)}"`);
  }
  out.push(`events:   ${records.length} (${errors.length} error)`);
  out.push("");
  out.push("--- trace (seq · time · level · code · loc · message) ---");
  for (const r of records) out.push(fmtRecord(r));

  if (errors.length) {
    out.push("");
    out.push("--- error records (full detail) ---");
    for (const e of errors) out.push(JSON.stringify(e, null, 2));
  }

  out.push("");
  out.push("--- areas to look (from the codes in this trace) ---");
  for (const a of areasFor(codes)) out.push(`  - ${a}`);

  out.push("");
  out.push("===== FOR AN AI AGENT (you are in the voice-pr repo) =====");
  out.push(
    "voice-pr is a Chrome extension (extension/) + local Node bridge (server.js + lib/) that sends spoken PR feedback to a pre-warmed Cursor SDK agent. Diagnose this session:"
  );
  out.push("");
  out.push(
    "1. The last `ERR` record above is the proximate cause; its `loc` is the file:line that threw and its detail carries the message + a stack tail."
  );
  out.push(
    "2. Every `code` is a literal string in the source — `git grep` it to find the exact emit site. `exec.fail` records carry the failing child process's stderr (gh/git/docker/ffmpeg/whisper) and are usually the real cause."
  );
  out.push(
    "3. Happy-path flow — walk it until a step's trace diverges: content.js (page-load prepare → record + warm → Dispatch) → background.js (relay) → server.js /api/prepare or /api/dispatch → lib/pipeline.js → lib/agent.js (prepared worktree + Cursor SDK) → lib/exec.js (child processes)."
  );
  out.push(
    "4. The recording + transcript for this session are in the same dir (audio.*, transcript.json) if you need to reproduce."
  );
  out.push("5. Report the root cause as code + file:line, then the minimal fix.");
  out.push("==========================================================");

  console.log(out.join("\n"));
}

main().catch((e) => {
  console.error(`trace failed: ${e.message}`);
  process.exitCode = 1;
});
