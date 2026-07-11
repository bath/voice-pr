// Deterministic "menial task" fast path: anchored snippet replace with no LLM.
import { readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

export function menialFastPathEnabled() {
  const value = process.env.VOICE_PR_MENIAL_FAST_PATH;
  return value === "1" || value === "true";
}

const BROAD_SCOPE = /\b(everywhere|all files|refactor|across the|whole repo)\b/i;
const VAGUE_OLD =
  /^(?:the(?:\s+\w+){0,4}\s+(?:line|heading|word|text|section))\b/i;
const PRONOUN_OLD = /^(?:this|that|it|here)\.?$/i;

const SNIPPET_REPLACE_PATTERNS = [
  /^change(?:\s+(?:this|the|that))?(?:\s+\w+)*\s+to\s+(.+)$/i,
  /^rename(?:\s+(?:this|the|that|it))?(?:\s+\w+)*\s+to\s+(.+)$/i,
  /^replace(?:\s+(?:this|the|that|it))?(?:\s+\w+)*\s+with\s+(.+)$/i,
  /^make(?:\s+(?:this|it))?\s+say\s+(.+)$/i,
  /^should\s+(?:say|be)\s+(.+)$/i,
];

const EXPLICIT_REPLACE_PATTERNS = [
  /^change (.+?) to (.+?)\.?$/i,
  /^rename (.+?) to (.+?)\.?$/i,
];

/**
 * @returns {{ newValue: string } | null}
 */
export function parseSnippetReplaceIntent(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  for (const pattern of SNIPPET_REPLACE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    const newValue = stripQuotes(match[1].trim());
    if (newValue) return { newValue };
  }
  return null;
}

/**
 * @returns {{ oldValue: string, newValue: string } | null}
 */
export function parseExplicitReplaceIntent(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  for (const pattern of EXPLICIT_REPLACE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    const oldValue = stripQuotes(match[1].trim());
    const newValue = stripQuotes(match[2].trim());
    if (oldValue && newValue) return { oldValue, newValue };
  }
  return null;
}

/** @returns {{ mode: "snippet", newValue: string } | { mode: "explicit", oldValue: string, newValue: string } | null} */
export function parseMenialReplaceIntent(text) {
  const explicit = parseExplicitReplaceIntent(text);
  if (explicit) return { mode: "explicit", ...explicit };
  const snippet = parseSnippetReplaceIntent(text);
  if (snippet) return { mode: "snippet", ...snippet };
  return null;
}

/**
 * @returns {{ eligible: true, segment: object, oldValue: string, newValue: string, commitMessage: string, lineScoped: boolean } | { eligible: false, reason: string }}
 */
export function planMenialEdit(segments) {
  if (!menialFastPathEnabled()) return { eligible: false, reason: "disabled" };
  if (!Array.isArray(segments) || segments.length !== 1)
    return { eligible: false, reason: "requires exactly one segment" };

  const segment = segments[0];
  const text = String(segment.text || "").trim();
  if (!text) return { eligible: false, reason: "empty speech" };
  if (!segment.file) return { eligible: false, reason: "missing file anchor" };
  if (BROAD_SCOPE.test(text)) return { eligible: false, reason: "broad scope" };

  let oldValue;
  let newValue;
  let lineScoped = false;
  const snippetText = String(segment.snippet || "").trim();

  if (snippetText) {
    const intent = parseSnippetReplaceIntent(text);
    if (!intent) return { eligible: false, reason: "unrecognized replace intent" };
    oldValue = snippetText;
    newValue = intent.newValue;
  } else {
    const explicit = parseExplicitReplaceIntent(text);
    if (explicit) {
      if (PRONOUN_OLD.test(explicit.oldValue))
        return { eligible: false, reason: "missing snippet anchor" };
      if (VAGUE_OLD.test(explicit.oldValue))
        return { eligible: false, reason: "explicit old value too vague" };
      if (!Number.isFinite(segment.line))
        return { eligible: false, reason: "explicit replace requires line anchor or snippet" };
      oldValue = explicit.oldValue;
      newValue = explicit.newValue;
      lineScoped = true;
    } else if (parseSnippetReplaceIntent(text)) {
      return { eligible: false, reason: "missing snippet anchor" };
    } else {
      return { eligible: false, reason: "unrecognized replace intent" };
    }
  }

  if (oldValue === newValue)
    return { eligible: false, reason: "new value matches old value" };

  const commitMessage = `fix: update ${basename(segment.file)} per voice review`;
  return {
    eligible: true,
    segment,
    oldValue,
    newValue,
    commitMessage,
    lineScoped,
  };
}

/**
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

  let updated = content;
  if (plan.lineScoped && Number.isFinite(plan.segment.line)) {
    const lines = content.split("\n");
    const index = plan.segment.line - 1;
    if (index < 0 || index >= lines.length)
      return { applied: false, reason: "anchored line out of range" };
    const line = lines[index];
    if (!line.includes(plan.oldValue))
      return { applied: false, reason: "old value not found on anchored line" };
    if (countOccurrences(line, plan.oldValue) !== 1)
      return { applied: false, reason: "old value not unique on anchored line" };
    lines[index] = line.replace(plan.oldValue, plan.newValue);
    updated = lines.join("\n");
  } else {
    const occurrences = countOccurrences(content, plan.oldValue);
    if (occurrences === 0) return { applied: false, reason: "old value not found in file" };
    if (occurrences > 1)
      return { applied: false, reason: "old value is not unique in file" };
    updated = content.replace(plan.oldValue, plan.newValue);
  }

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
