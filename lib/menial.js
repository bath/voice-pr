// Deterministic "menial task" fast path: anchored snippet replace with no LLM.
import { readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

export function menialFastPathEnabled() {
  const value = process.env.VOICE_PR_MENIAL_FAST_PATH;
  return value === "1" || value === "true";
}

const BROAD_SCOPE = /\b(everywhere|all files|refactor|across the|whole repo)\b/i;

const REPLACE_PATTERNS = [
  /^change(?:\s+(?:this|the|that))?(?:\s+\w+)*\s+to\s+(.+)$/i,
  /^rename(?:\s+(?:this|the|that|it))?(?:\s+\w+)*\s+to\s+(.+)$/i,
  /^replace(?:\s+(?:this|the|that|it))?(?:\s+\w+)*\s+with\s+(.+)$/i,
  /^make(?:\s+(?:this|it))?\s+say\s+(.+)$/i,
  /^should\s+(?:say|be)\s+(.+)$/i,
];

/** @returns {{ newValue: string } | null} */
export function parseMenialReplaceIntent(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  for (const pattern of REPLACE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    const newValue = stripQuotes(match[1].trim());
    if (newValue) return { newValue };
  }
  return null;
}

/**
 * Decide whether anchored speech qualifies for the menial fast path.
 * @returns {{ eligible: true, segment: object, oldValue: string, newValue: string, commitMessage: string } | { eligible: false, reason: string }}
 */
export function planMenialEdit(segments) {
  if (!menialFastPathEnabled()) return { eligible: false, reason: "disabled" };
  if (!Array.isArray(segments) || segments.length !== 1)
    return { eligible: false, reason: "requires exactly one segment" };

  const segment = segments[0];
  const text = String(segment.text || "").trim();
  if (!text) return { eligible: false, reason: "empty speech" };
  if (!segment.file) return { eligible: false, reason: "missing file anchor" };

  const oldValue = String(segment.snippet || "").trim();
  if (!oldValue) return { eligible: false, reason: "missing snippet anchor" };
  if (BROAD_SCOPE.test(text)) return { eligible: false, reason: "broad scope" };

  const intent = parseMenialReplaceIntent(text);
  if (!intent) return { eligible: false, reason: "unrecognized replace intent" };
  if (intent.newValue === oldValue)
    return { eligible: false, reason: "new value matches snippet" };

  const commitMessage = `fix: update ${basename(segment.file)} per voice review`;
  return {
    eligible: true,
    segment,
    oldValue,
    newValue: intent.newValue,
    commitMessage,
  };
}

/**
 * Apply a planned menial edit inside the managed worktree.
 * @returns {Promise<{ applied: true, file: string, oldValue: string, newValue: string, commitMessage: string } | { applied: false, reason: string }>}
 */
export async function applyMenialEdit({ plan, workspace }) {
  if (!plan?.eligible) return { applied: false, reason: plan?.reason || "not eligible" };

  const filePath = resolveWithinWorkspace(workspace, plan.segment.file);
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return { applied: false, reason: "anchored file not found in workspace" };
  }

  const occurrences = countOccurrences(content, plan.oldValue);
  if (occurrences === 0) return { applied: false, reason: "snippet not found in file" };
  if (occurrences > 1) return { applied: false, reason: "snippet is not unique in file" };

  const updated = content.replace(plan.oldValue, plan.newValue);
  if (updated === content) return { applied: false, reason: "replace made no change" };

  await writeFile(filePath, updated, "utf8");
  return {
    applied: true,
    file: plan.segment.file,
    oldValue: plan.oldValue,
    newValue: plan.newValue,
    commitMessage: plan.commitMessage,
  };
}

export async function tryMenialEdit({ segments, workspace }) {
  const plan = planMenialEdit(segments);
  if (!plan.eligible) return { applied: false, reason: plan.reason };
  return applyMenialEdit({ plan, workspace });
}

function stripQuotes(value) {
  return value.replace(/^[`'"]+/, "").replace(/[`'"]+$/, "").trim();
}

function basename(file) {
  const parts = String(file || "").split(/[/\\]/);
  return parts[parts.length - 1] || "file";
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count++;
    index += needle.length;
  }
  return count;
}

function resolveWithinWorkspace(workspace, file) {
  const root = resolve(workspace);
  const target = resolve(root, file);
  if (target !== root && !target.startsWith(root + sep))
    throw new Error(`anchored path escapes workspace: ${file}`);
  return target;
}
