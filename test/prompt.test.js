import assert from "node:assert/strict";
import test from "node:test";
import { buildExecutionPrompt } from "../lib/prompt.js";

const pr = {
  owner: "bath",
  repo: "voice-pr",
  number: 42,
  title: "Add retry",
  headRefName: "feat/retry",
};

function execution(segments, context = {}) {
  return buildExecutionPrompt({ pr, segments, context, branchHead: "abc123" });
}

test("execution harness renders anchored comments with file:line and speech", () => {
  const body = execution([
    { text: "this retry needs backoff", file: "lib/net.js", line: 12 },
    { text: "rename this var", file: "lib/net.js", line: 30 },
  ]);
  assert.match(body, /1\. `lib\/net\.js:12` — "this retry needs backoff"/);
  assert.match(body, /2\. `lib\/net\.js:30` — "rename this var"/);
});

test("renders ranges, tokens, snippets, and missing anchors", () => {
  const body = execution([
    { text: "extract this block", file: "a.js", line: 10, endLine: 18 },
    { text: "rename", file: "a.js", line: 5, endLine: 5 },
    {
      text: "simplify",
      file: "a.js",
      line: 3,
      token: "computeThing",
      snippet: "const x = " + "y".repeat(400),
    },
    { text: "add a guard in the parser", file: null, line: null },
  ]);
  assert.match(body, /`a\.js:10-18`/);
  assert.match(body, /`a\.js:5` —/);
  assert.doesNotMatch(body, /5-5/);
  assert.match(body, /pointing at `computeThing`/);
  const snippet = body.match(/selected code: `([^`]*)`/);
  assert.ok(snippet);
  assert.ok(snippet[1].length <= 200);
  assert.match(body, /no on-screen location — infer from the words/);
});

test("delivery contract leaves the authenticated push to the harness", () => {
  const body = execution([{ text: "x", file: "a.js", line: 1 }]);
  assert.match(body, /Work from `abc123`/);
  assert.match(body, /harness owns the authenticated push to `feat\/retry`/);
  assert.doesNotMatch(body, /git push origin/);
  assert.match(body, /Never force-push, rebase, amend/);
});

test("single hot turn interprets fuzzy speech, confidence-gates, edits, tests, and commits", () => {
  const body = execution(
    [{ text: "make this less weird", file: "a.js", line: 1 }],
    { jiraKey: "ABC-123", checksSummary: "5 checks, 1 failing" }
  );
  assert.match(body, /compile the complete commentary into open-ended desired outcomes/);
  assert.match(body, /record_action_plan/);
  assert.match(body, /HIGH confidence/);
  assert.match(body, /LOW confidence/);
  assert.match(body, /one\s+coherent commit/);
  assert.match(body, /Jira ABC-123; CI 5 checks, 1 failing/);
  assert.match(body, /only inference turn/i);
  assert.match(body, /Inspect only the anchored targets/);
  assert.match(body, /do not\s+perform broad PR/i);
  assert.doesNotMatch(body, /context you already analyzed/);
});
