import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFakeCli } from "./helpers/fake-cli.js";

// End-to-end critical path (record -> anchor -> dispatch -> commit) exercised
// against fake `gh` + `docker` binaries on PATH. No network, no container, no
// git pushes: every process boundary is a deterministic stand-in, so the real
// pipeline/orchestrator/github code runs unchanged and we pin its behavior.
const ROOT = mkdtempSync(join(tmpdir(), "vp-pipeline-test-"));
process.env.VOICE_PR_ARCHIVE_DIR = join(ROOT, "sessions");
process.env.VOICE_PR_POLL_MS = "1";
process.env.VOICE_PR_DISPATCH_MS = "60000";
process.env.VOICE_PR_CONTAINER = "codingagent";

const fake = installFakeCli(["docker", "gh"]);
const { runSession, getContext, resolvePr } = await import("../lib/pipeline.js");

const PR_URL = "https://github.com/o/r/pull/7";

// One coherent "healthy orchestrator + open PR" world. Individual tests override
// single rules to probe a branch (e.g. a closed PR, a commit without the id).
function world(overrides = {}) {
  const meta = {
    number: 7,
    title: "Add retry",
    url: PR_URL,
    headRefName: "feat",
    baseRefName: "main",
    state: "OPEN",
    isCrossRepository: false,
    ...overrides.meta,
  };
  const commits = overrides.commits ?? [
    { oid: "deadbeefcafe0001", messageHeadline: "add exponential backoff (ca-1234)" },
  ];
  const rules = [
    // gh — PR metadata (matched by a field unique to this call)
    { cmd: "gh", pattern: "headRefName", code: 0, stdout: JSON.stringify(meta) },
    // gh — checks summary
    { cmd: "gh", pattern: "pr checks", code: 0, stdout: "build\tpass\thttps://ci" },
    // gh — commit list after merge
    { cmd: "gh", pattern: "--json commits", code: 0, stdout: JSON.stringify({ commits }) },
    // gh — intent-trail comment post
    { cmd: "gh", pattern: "issues/7/comments", code: 0, stdout: JSON.stringify({ html_url: `${PR_URL}#c1` }) },
    // docker — orchestrator surface
    { cmd: "docker", pattern: "pogo status", code: 0, stdout: "{}" },
    { cmd: "docker", pattern: "test -d", code: 0, stdout: "" }, // repo already checked out -> refresh
    { cmd: "docker", pattern: "project add", code: 0, stdout: "" },
    { cmd: "docker", pattern: "mg new", code: 0, stdout: "Created ca-1234: voice-pr session" },
    { cmd: "docker", pattern: "mg mail send", code: 0, stdout: "" },
    { cmd: "docker", pattern: "mg show", code: 0, stdout: "Status: done" },
    { cmd: "docker", pattern: "refinery history", code: 0, stdout: "[]" },
  ];
  fake.setRules([...rules, ...(overrides.extra ?? [])]);
}

const SEGMENTS = [{ text: "this retry needs backoff", file: "lib/net.js", line: 12 }];

function record() {
  const events = [];
  const emit = (stage, detail) => events.push({ stage, detail });
  return { events, emit, stages: () => events.map((e) => e.stage) };
}

// Assert `wanted` appears as an ordered subsequence of `actual`.
function assertSubsequence(actual, wanted) {
  let i = 0;
  for (const s of actual) if (s === wanted[i]) i++;
  assert.equal(
    i,
    wanted.length,
    `expected ordered subsequence ${JSON.stringify(wanted)} within ${JSON.stringify(actual)}`
  );
}

test("resolvePr loads and validates PR metadata off `gh pr view`", async () => {
  world();
  const pr = await resolvePr(PR_URL);
  assert.equal(pr.number, 7);
  assert.equal(pr.headRefName, "feat");
  assert.equal(pr.state, "OPEN");
  assert.equal(pr.isCrossRepository, false);
});

test("getContext surfaces the PR, detected Jira key, and checks summary the extension shows at record-start", async () => {
  world({ meta: { title: "ABC-123 add retry", headRefName: "feat" } });
  const ctx = await getContext(PR_URL);
  assert.equal(ctx.pr.number, 7);
  assert.equal(ctx.jiraKey, "ABC-123");
  assert.equal(ctx.checksSummary, "1 checks, 0 failing");
});

test("runSession rejects an empty segment list before touching gh or the orchestrator", async () => {
  world();
  await assert.rejects(runSession({ prRef: PR_URL, segments: [] }), /no spoken comments/i);
  assert.equal(fake.calls().length, 0, "must fail fast — no external calls for an empty session");
});

test("runSession refuses a PR that is not open", async () => {
  world({ meta: { state: "MERGED" } });
  await assert.rejects(runSession({ prRef: PR_URL, segments: SEGMENTS }), /is MERGED, not open/);
});

test("runSession refuses a cross-repository (fork) PR", async () => {
  world({ meta: { isCrossRepository: true } });
  await assert.rejects(runSession({ prRef: PR_URL, segments: SEGMENTS }), /cross-repository/i);
});

test("runSession runs the full happy path and reports a merged, done result", async () => {
  world();
  const { emit } = record();
  const result = await runSession({ prRef: PR_URL, segments: SEGMENTS }, emit);
  assert.equal(result.status, "done");
  assert.equal(result.backend, "orchestrator");
  assert.equal(result.workItemId, "ca-1234");
  assert.equal(result.pr.branch, "feat");
  assert.equal(result.trailCommentUrl, `${PR_URL}#c1`);
});

test("runSession advances the stages in the expected critical-path order", async () => {
  world();
  const { emit, stages } = record();
  await runSession({ prRef: PR_URL, segments: SEGMENTS }, emit);
  assertSubsequence(stages(), [
    "pr-loaded",
    "context",
    "branch-dispatch-start",
    "work-filed",
    "dispatching",
    "work-status",
    "commenting",
    "done",
  ]);
});

test("runSession posts the intent-trail comment ONLY for commits carrying the (workItemId) tag", async () => {
  // A commit whose headline lacks `(ca-1234)` must not be claimed as ours.
  world({ commits: [{ oid: "beef", messageHeadline: "unrelated drive-by change" }] });
  const { emit, stages } = record();
  const result = await runSession({ prRef: PR_URL, segments: SEGMENTS }, emit);
  assert.equal(result.status, "done");
  assert.equal(result.trailCommentUrl, null, "no matching commit -> no trail comment");
  assert.ok(!stages().includes("commenting"), "commenting stage must be skipped when nothing matches");
});

test("runSession serializes through the per-branch queue (emits branch-dispatch-start)", async () => {
  world();
  const { emit, stages } = record();
  await runSession({ prRef: PR_URL, segments: SEGMENTS }, emit);
  assert.ok(stages().includes("branch-dispatch-start"));
});

test("runSession files the work item on the PR head branch (so refinery merges onto the PR)", async () => {
  world();
  await runSession({ prRef: PR_URL, segments: SEGMENTS }, record().emit);
  const mgNew = fake.calls().find((c) => c.args.includes("mg new"));
  assert.ok(mgNew, "expected an `mg new` call");
  assert.match(mgNew.args, /--branch feat/);
  assert.match(mgNew.args, /--assignee mayor/);
  assert.match(mgNew.args, /source=voice-pr/);
});

test("cleanup", () => {
  fake.cleanup();
});
