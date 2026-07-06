// Persist each session — the audio recording + all event data — as a reusable
// fixture (test cases / examples / replay). One folder per session.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const ARCHIVE_ROOT =
  process.env.VOICE_PR_ARCHIVE_DIR || join(homedir(), ".voice-pr", "sessions");

const dirFor = (id) => join(ARCHIVE_ROOT, String(id).replace(/[^\w.-]/g, "_"));

async function ensure(id) {
  const d = dirFor(id);
  await mkdir(d, { recursive: true });
  return d;
}

/** Save the raw recording. */
export async function saveAudio(id, buf, ext = "webm") {
  if (!id) return null;
  const d = await ensure(id);
  const p = join(d, `audio.${ext}`);
  await writeFile(p, buf);
  return p;
}

/** Save any JSON artifact (transcript.json, session.json, …). */
export async function saveJson(id, name, obj) {
  if (!id) return null;
  const d = await ensure(id);
  const p = join(d, name);
  await writeFile(p, JSON.stringify(obj, null, 2));
  return p;
}
