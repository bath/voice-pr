// Local speech-to-text via whisper.cpp — audio never leaves the machine.
import { run } from "./exec.js";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WHISPER = process.env.VOICE_PR_WHISPER_BIN || "whisper-cli";
const MODEL =
  process.env.VOICE_PR_WHISPER_MODEL ||
  `${process.env.HOME}/.cache/whisper/ggml-large-v3-turbo-q5_0.bin`;

/** Preflight: are the local STT dependencies actually present? */
export async function checkStt() {
  const out = { ffmpeg: false, whisper: false, model: false, detail: "" };
  try { await run("ffmpeg", ["-version"]); out.ffmpeg = true; }
  catch (e) { out.detail = `ffmpeg not runnable (${e.message.split("\n")[0]})`; }
  try { await run(WHISPER, ["--help"], { allowFail: true }); out.whisper = true; }
  catch (e) { out.detail ||= `whisper binary "${WHISPER}" not runnable (${e.message.split("\n")[0]})`; }
  try { await access(MODEL); out.model = true; }
  catch { out.detail ||= `whisper model missing: ${MODEL}`; }
  return out;
}

/**
 * Transcribe an audio buffer to timed segments.
 * @param {Buffer} audio  raw audio bytes (webm/opus/wav/…)
 * @param {string} ext    source container extension (for ffmpeg)
 * @returns {Promise<Array<{start:number,end:number,text:string}>>}  start/end in seconds
 */
export async function transcribe(audio, ext = "webm") {
  const dir = await mkdtemp(join(tmpdir(), "vp-stt-"));
  const inPath = join(dir, `a.${ext}`);
  const wav = join(dir, "a.wav");
  const outPrefix = join(dir, "out");
  try {
    await writeFile(inPath, audio);
    // whisper wants 16 kHz mono PCM
    await run("ffmpeg", ["-y", "-i", inPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
    await run(WHISPER, ["-m", MODEL, "-f", wav, "-oj", "-of", outPrefix]);
    const json = JSON.parse(await readFile(`${outPrefix}.json`, "utf8"));
    return (json.transcription || [])
      .map((t) => ({
        start: (t.offsets?.from ?? 0) / 1000,
        end: (t.offsets?.to ?? 0) / 1000,
        text: (t.text || "").trim(),
      }))
      .filter((s) => s.text && !/^\[.*\]$/.test(s.text) && !isHallucination(s.text));
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Whisper hallucinates stock phrases on silence/noise. Drop them when they are
// the entire segment (conservative — only exact, well-known artifacts).
const HALLUCINATIONS = new Set([
  "thank you.", "thank you", "thanks for watching!", "thanks for watching.",
  "you", "you.", ".", "bye.", "bye", "so", "okay.", "please subscribe.",
]);
function isHallucination(text) {
  return HALLUCINATIONS.has(text.toLowerCase().trim());
}

/**
 * Join transcript segments to the anchor timeline: each spoken segment inherits
 * the file/line/selection that was active when the user started saying it.
 * @param {Array} segs      transcript segments (start in seconds)
 * @param {Array} timeline  [{t (ms since session start), file, line, endLine, snippet}]
 * @param {Object} opts
 * @param {number} opts.offsetMs  segment timestamp offset from session start
 */
export function anchorSegments(segs, timeline = [], { offsetMs = 0 } = {}) {
  const tl = [...timeline].sort((a, b) => a.t - b.t);
  const at = (ms) => {
    let cur = null;
    for (const e of tl) {
      if (e.t <= ms) cur = e;
      else break;
    }
    return cur;
  };
  return segs.map((s) => {
    const a = at(s.start * 1000 + offsetMs) || tl[0] || {};
    const seg = {
      text: s.text,
      file: a.file || null,
      line: a.line ?? null,
      endLine: a.endLine ?? null,
      snippet: a.snippet || null,
      token: a.token || null, // the symbol the user was pointing at when speaking
    };
    // Newer anchors may carry dwell weight (ms) and/or the capture path that
    // produced them (select/click/hover/viewport/gaze) — carry them through
    // only when present, so older timelines still produce the original shape.
    if (a.weight != null) seg.weight = a.weight;
    if (a.via || a.source) seg.via = a.via || a.source;
    return seg;
  });
}
