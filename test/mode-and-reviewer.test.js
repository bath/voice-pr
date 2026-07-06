import test from "node:test";
import assert from "node:assert/strict";
import { MODES, normalizeMode } from "../lib/mode.js";
import { reviewOnlyBody, runReviewerBatch, runReviewerSession } from "../lib/pipeline.js";

const pr = {
  owner: "bath-tub",
  repo: "voice-pr",
  number: 17,
  title: "split dispatch button",
  url: "https://github.com/bath-tub/voice-pr/pull/17",
  headRefName: "feature",
  headRefOid: "abc123",
};

test("normalizes the explicit dispatch modes", () => {
  assert.equal(normalizeMode(), MODES.AUTHOR);
  assert.equal(normalizeMode("author"), MODES.AUTHOR);
  assert.equal(normalizeMode("reviewer"), MODES.REVIEWER);
  assert.equal(normalizeMode("review"), MODES.REVIEWER);
  assert.throws(() => normalizeMode("comment-and-commit"), /invalid mode/);
});

test("reviewer session posts comments without commit-oriented events", async () => {
  const calls = [];
  const events = [];
  const result = await runReviewerSession(
    pr,
    [
      { text: "This name is confusing", file: "src/example.js", line: 12 },
      { text: "Please explain the retry behavior" },
    ],
    (stage) => events.push(stage),
    {
      postAnchoredComment: async (_pr, payload) => {
        calls.push(["anchored", payload]);
        return { ok: true, kind: "inline", url: "https://example.test/inline" };
      },
      postIssueComment: async (_pr, body) => {
        calls.push(["issue", body]);
        return { ok: true, kind: "issue", url: "https://example.test/issue" };
      },
    }
  );

  assert.equal(result.mode, MODES.REVIEWER);
  assert.equal(result.status, "done");
  assert.equal(result.pushed, false);
  assert.deepEqual(result.committed, []);
  assert.equal(result.reviewComments.length, 2);
  assert.deepEqual(calls.map(([kind]) => kind), ["anchored", "issue"]);
  assert.equal(calls[0][1].commit_id, pr.headRefOid);
  assert.match(calls[0][1].body, /no commits were made/i);
  assert.doesNotMatch(events.join(","), /cloning|agent-start|pushing|dispatching|work-filed/);
});

test("reviewer batch posts a plain PR comment only", async () => {
  const events = [];
  const calls = [];
  const result = await runReviewerBatch(
    pr,
    "This branch should use a simpler label.",
    (stage) => events.push(stage),
    {
      postIssueComment: async (_pr, body) => {
        calls.push(body);
        return { ok: true, kind: "issue", url: "https://example.test/issue" };
      },
    }
  );

  assert.equal(result.mode, MODES.REVIEWER);
  assert.equal(result.pushed, false);
  assert.deepEqual(result.committed, []);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /This branch should use a simpler label/);
  assert.match(calls[0], /no commits were made/i);
  assert.deepEqual(events, ["review-commenting", "done"]);
});

test("review-only comment body states the no-commit contract", () => {
  assert.match(reviewOnlyBody("Please rename this."), /Reviewer mode: no commits were made/);
});
