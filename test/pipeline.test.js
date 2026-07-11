import assert from "node:assert/strict";
import test from "node:test";
import { installFakeCli } from "./helpers/fake-cli.js";

const fake = installFakeCli(["gh"]);
const {
  runSession,
  getContext,
  preparePr,
  resolvePr,
  warmSession,
} = await import("../lib/pipeline.js");
const PR_URL = "https://github.com/o/r/pull/7";
const SEGMENTS = [{ text: "this retry needs backoff", file: "lib/net.js", line: 12 }];

function world(overrides = {}) {
  const meta = {
    number: 7,
    title: "Add retry",
    body: "Implements retry handling",
    url: PR_URL,
    headRefName: "feat",
    headRefOid: "a".repeat(40),
    baseRefName: "main",
    state: "OPEN",
    isCrossRepository: false,
    ...overrides.meta,
  };
  fake.setRules([
    { cmd: "gh", pattern: "headRefOid", code: 0, stdout: JSON.stringify(meta) },
    { cmd: "gh", pattern: "pr checks", code: 0, stdout: "build\tpass\thttps://ci" },
    {
      cmd: "gh",
      pattern: "issues/7/comments",
      code: 0,
      stdout: JSON.stringify({ html_url: `${PR_URL}#c1` }),
    },
  ]);
}

function fakeRuntime(overrides = {}) {
  const calls = [];
  return {
    calls,
    async preparePr(input) {
      calls.push({ kind: "prepare", input });
      return {
        key: `${input.pr.owner}/${input.pr.repo}#${input.pr.number}@${input.pr.headRefOid}`,
        state: "ready",
        cacheHit: false,
        preparationMs: 12,
      };
    },
    warm(input) {
      calls.push({ kind: "warm", input });
      return { sessionId: input.sessionId, state: "warming", startedAt: 1 };
    },
    async execute(input) {
      calls.push({ kind: "execute", input });
      input.emit("agent-ready", { agentId: "agent-1", warmWaitMs: 0 });
      input.emit("interpreting", { segments: input.segments.length });
      input.emit("agent-running", { agentId: "agent-1", runId: "run-1" });
      input.emit("agent-finished", { commits: 1, executionMs: 12 });
      return {
        backend: "cursor-sdk",
        status: "done",
        agentId: "agent-1",
        runId: "run-1",
        commits: [{ oid: "deadbeefcafe0001", messageHeadline: "add retry backoff" }],
        metrics: { patchReadyAt: 20, executionMs: 12 },
        ...overrides.result,
      };
    },
  };
}

function record() {
  const events = [];
  return {
    events,
    emit: (stage, detail) => events.push({ stage, detail }),
    stages: () => events.map((event) => event.stage),
  };
}

function assertSubsequence(actual, wanted) {
  let index = 0;
  for (const stage of actual) if (stage === wanted[index]) index++;
  assert.equal(index, wanted.length, `expected ${wanted} within ${actual}`);
}

test("resolvePr loads the head SHA and PR body needed by pre-warm", async () => {
  world();
  const pr = await resolvePr(PR_URL);
  assert.equal(pr.number, 7);
  assert.equal(pr.headRefName, "feat");
  assert.equal(pr.headRefOid, "a".repeat(40));
  assert.equal(pr.body, "Implements retry handling");
});

test("getContext surfaces PR, Jira, checks, and head SHA", async () => {
  world({ meta: { title: "ABC-123 add retry" } });
  const context = await getContext(PR_URL);
  assert.equal(context.pr.number, 7);
  assert.equal(context.pr.headSha, "a".repeat(40));
  assert.equal(context.jiraKey, "ABC-123");
  assert.equal(context.checksSummary, "1 checks, 0 failing");
});

test("preparePr caches context and performs only deterministic runtime setup", async () => {
  world({ meta: { title: "ABC-123 add retry" } });
  const runtime = fakeRuntime();
  const trace = record();
  const result = await preparePr(
    {
      prRef: "https://github.com/o/r/pull/71",
      runtime,
    },
    trace.emit
  );
  assert.equal(result.preparation.state, "ready");
  assert.equal(result.pr.headSha, "a".repeat(40));
  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0].kind, "prepare");
  assertSubsequence(trace.stages(), [
    "context-cache-miss",
    "context-cache-stored",
  ]);

  const cliCallsAfterPrepare = fake.calls().length;
  const warmTrace = record();
  const warm = await warmSession(
    {
      sessionId: "prepared-71",
      prRef: "https://github.com/o/r/pull/71",
      runtime,
    },
    warmTrace.emit
  );
  assert.equal(warm.contextCacheHit, true);
  assert.equal(fake.calls().length, cliCallsAfterPrepare);
  assert.equal(runtime.calls[1].kind, "warm");
  assert.ok(warmTrace.stages().includes("context-cache-hit"));
});

test("warmSession starts the durable agent during recording and returns context", async () => {
  world({ meta: { title: "ABC-123 add retry" } });
  const runtime = fakeRuntime();
  const result = await warmSession({
    sessionId: "session-1",
    prRef: PR_URL,
    runtime,
  });
  assert.equal(result.warm.state, "warming");
  assert.equal(result.pr.branch, "feat");
  assert.equal(runtime.calls[0].kind, "warm");
  assert.equal(runtime.calls[0].input.context.jiraKey, "ABC-123");
});

test("runSession rejects empty speech before touching GitHub or the agent", async () => {
  world();
  const runtime = fakeRuntime();
  await assert.rejects(
    runSession({ sessionId: "session-1", prRef: PR_URL, segments: [], runtime }),
    /no spoken comments/i
  );
  assert.equal(fake.calls().length, 0);
  assert.equal(runtime.calls.length, 0);
});

test("runSession refuses closed and cross-repository PRs", async () => {
  world({ meta: { state: "MERGED" } });
  await assert.rejects(
    runSession({
      sessionId: "closed",
      prRef: PR_URL,
      segments: SEGMENTS,
      runtime: fakeRuntime(),
    }),
    /is MERGED, not open/
  );

  world({ meta: { isCrossRepository: true } });
  await assert.rejects(
    runSession({
      sessionId: "fork",
      prRef: PR_URL,
      segments: SEGMENTS,
      runtime: fakeRuntime(),
    }),
    /cross-repository/i
  );
});

test("runSession executes on the warm runtime and posts a commit trail asynchronously", async () => {
  world();
  const runtime = fakeRuntime();
  const result = await runSession({
    sessionId: "session-1",
    prRef: PR_URL,
    segments: SEGMENTS,
    runtime,
  });
  assert.equal(result.status, "done");
  assert.equal(result.backend, "cursor-sdk");
  assert.equal(result.agentId, "agent-1");
  assert.equal(result.trailCommentUrl, null);
  assert.equal(result.trailCommentPending, true);
  assert.equal(runtime.calls[0].kind, "execute");
  assert.equal(runtime.calls[0].input.segments, SEGMENTS);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(
    fake.calls().some((call) => String(call.args).includes("issues/7/comments"))
  );
});

test("runSession emits the minimal hot-path stage order", async () => {
  world();
  const trace = record();
  await runSession(
    {
      sessionId: "session-2",
      prRef: PR_URL,
      segments: SEGMENTS,
      runtime: fakeRuntime(),
    },
    trace.emit
  );
  assertSubsequence(trace.stages(), [
    "pr-loaded",
    "context",
    "agent-starting",
    "agent-ready",
    "interpreting",
    "agent-running",
    "agent-finished",
    "comment-queued",
  ]);
});

test("no confident commit completes without posting an intent trail", async () => {
  world();
  const runtime = fakeRuntime({
    result: { commits: [], agentSummary: "SKIPPED / NEEDS CLARIFICATION" },
  });
  const trace = record();
  const result = await runSession(
    { sessionId: "session-3", prRef: PR_URL, segments: SEGMENTS, runtime },
    trace.emit
  );
  assert.equal(result.status, "done");
  assert.equal(result.trailCommentUrl, null);
  assert.equal(result.trailCommentPending, false);
  assert.match(result.summary, /without making a confident code change/);
  assert.ok(!trace.stages().includes("comment-queued"));
});

test("cleanup", () => fake.cleanup());
