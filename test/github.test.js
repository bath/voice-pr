import assert from "node:assert/strict";
import test from "node:test";
import { parsePr, repoSlug } from "../lib/github.js";

// parsePr is the very first thing every request does with user input; a silent
// change here mis-routes the whole session to the wrong repo/PR.
test("parsePr accepts a full github.com pull URL", () => {
  assert.deepEqual(parsePr("https://github.com/bath/voice-pr/pull/42"), {
    owner: "bath",
    repo: "voice-pr",
    number: 42,
  });
});

test("parsePr accepts a scheme-less github.com URL", () => {
  assert.deepEqual(parsePr("github.com/o/r/pull/7"), { owner: "o", repo: "r", number: 7 });
});

test("parsePr accepts the owner/repo#N shorthand", () => {
  assert.deepEqual(parsePr("bath/voice-pr#5"), { owner: "bath", repo: "voice-pr", number: 5 });
});

test("parsePr accepts the owner/repo/N shorthand", () => {
  assert.deepEqual(parsePr("bath/voice-pr/9"), { owner: "bath", repo: "voice-pr", number: 9 });
});

test("parsePr trims surrounding whitespace before matching", () => {
  assert.deepEqual(parsePr("  https://github.com/o/r/pull/3  "), { owner: "o", repo: "r", number: 3 });
});

test("parsePr coerces the PR number to an integer, never a string", () => {
  const pr = parsePr("o/r#11");
  assert.strictEqual(pr.number, 11);
  assert.equal(typeof pr.number, "number");
});

test("parsePr throws a helpful error on empty or unparseable input", () => {
  assert.throws(() => parsePr(""), /no PR reference/i);
  assert.throws(() => parsePr(undefined), /no PR reference/i);
  assert.throws(() => parsePr("not a pr"), /could not parse PR reference/i);
  assert.throws(() => parsePr("https://github.com/o/r/issues/3"), /could not parse/i);
});

test("repoSlug renders owner/repo", () => {
  assert.equal(repoSlug({ owner: "bath", repo: "voice-pr" }), "bath/voice-pr");
});
