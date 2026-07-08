import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionBody } from "../lib/prompt.js";

const pr = { owner: "bath", repo: "voice-pr", number: 42, title: "Add retry", headRefName: "feat/retry" };

test("renders each anchored comment with its file:line and the spoken text", () => {
  const body = buildSessionBody({
    pr,
    segments: [
      { text: "this retry needs backoff", file: "lib/net.js", line: 12 },
      { text: "rename this var", file: "lib/net.js", line: 30 },
    ],
    context: {},
  });
  assert.match(body, /1\. `lib\/net\.js:12` — "this retry needs backoff"/);
  assert.match(body, /2\. `lib\/net\.js:30` — "rename this var"/);
});

test("renders a line range when endLine differs from line", () => {
  const body = buildSessionBody({
    pr,
    segments: [{ text: "extract this block", file: "a.js", line: 10, endLine: 18 }],
    context: {},
  });
  assert.match(body, /`a\.js:10-18`/);
});

test("collapses a range to a single line when endLine equals line", () => {
  const body = buildSessionBody({
    pr,
    segments: [{ text: "x", file: "a.js", line: 5, endLine: 5 }],
    context: {},
  });
  assert.match(body, /`a\.js:5` —/);
  assert.doesNotMatch(body, /5-5/);
});

test("falls back to an infer-from-words note when a segment has no on-screen file", () => {
  const body = buildSessionBody({
    pr,
    segments: [{ text: "over in the parser, add a guard", file: null, line: null }],
    context: {},
  });
  assert.match(body, /no on-screen location — infer from the words/);
});

test("includes the pointed-at token and truncates a long selected snippet to 200 chars", () => {
  const snippet = "const x = " + "y".repeat(400);
  const body = buildSessionBody({
    pr,
    segments: [{ text: "simplify", file: "a.js", line: 3, token: "computeThing", snippet }],
    context: {},
  });
  assert.match(body, /pointing at `computeThing`/);
  const m = body.match(/selected code: `([^`]*)`/);
  assert.ok(m, "expected a selected-code snippet in the body");
  assert.ok(m[1].length <= 200, `snippet should be capped at 200 chars, got ${m[1].length}`);
});

test("carries the PR head branch as the refinery merge target in the instructions", () => {
  const body = buildSessionBody({ pr, segments: [{ text: "x", file: "a.js", line: 1 }], context: {} });
  assert.match(body, /worktree is based on the\s+PR head branch `feat\/retry`/);
  assert.match(body, /target\s+branch `feat\/retry`/);
});

test("lists optional context (Jira key, CI checks) only when present, never as a blocker", () => {
  const withCtx = buildSessionBody({
    pr,
    segments: [{ text: "x", file: "a.js", line: 1 }],
    context: { jiraKey: "ABC-123", checksSummary: "5 checks, 1 failing" },
  });
  assert.match(withCtx, /Jira ticket `ABC-123`/);
  assert.match(withCtx, /CI \/ checks: 5 checks, 1 failing/);
  assert.match(withCtx, /DO NOT block on this/);

  const withoutCtx = buildSessionBody({ pr, segments: [{ text: "x", file: "a.js", line: 1 }], context: {} });
  assert.doesNotMatch(withoutCtx, /Jira ticket/);
  assert.doesNotMatch(withoutCtx, /CI \/ checks:/);
});

test("instructs confidence-gating: HIGH edits + one commit each, LOW left for clarification", () => {
  const body = buildSessionBody({ pr, segments: [{ text: "x", file: "a.js", line: 1 }], context: {} });
  assert.match(body, /HIGH:/);
  assert.match(body, /LOW/);
  assert.match(body, /needing clarification/);
  assert.match(body, /Do NOT post PR comments yourself/);
});
