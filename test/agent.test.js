import assert from "node:assert/strict";
import test from "node:test";
import { createAgentRuntime } from "../lib/agent.js";

const pr = {
  owner: "o",
  repo: "r",
  number: 7,
  title: "Add retry",
  headRefName: "feat",
  headRefOid: "a".repeat(40),
};
const segments = [{ text: "this needs backoff", file: "lib/net.js", line: 12 }];

function harness({
  executionStatus = "finished",
  model = "test-model",
  prepareTtlMs = 60_000,
  prepareMax = 6,
  preparedHead = null,
  warmSetupDelayMs = 0,
  warmHeartbeatMs = 1_000,
  skipActionPlan = false,
} = {}) {
  const prompts = [];
  const sendOptions = [];
  const commands = [];
  const prepareCalls = [];
  let disposed = 0;
  let createdWith = null;
  let headReads = 0;
  let committed = false;
  let pushed = false;
  const base = "a".repeat(40);
  const changed = "b".repeat(40);
  const agent = {
    agentId: "agent-1",
    async send(prompt, options) {
      prompts.push(prompt);
      sendOptions.push(options);
      const warm = options.mode === "plan";
      return {
        id: warm ? "warm-run" : "execute-run",
        async wait() {
          if (warm && warmSetupDelayMs)
            await new Promise((resolve) => setTimeout(resolve, warmSetupDelayMs));
          if (!warm) {
            if (!skipActionPlan) {
              await options.local.customTools.record_action_plan.execute({
                schemaVersion: 1,
                directives: [],
                actions: [
                  {
                    ref: "retry-backoff",
                    objective: "Add retry backoff",
                    sourceSegmentIndexes: [0],
                    target: { file: "lib/net.js", line: 12 },
                    constraints: [],
                    acceptance: ["Focused retry tests pass"],
                    intentStrength: "requested",
                    dependsOn: [],
                    effects: [
                      { ref: "edit", capability: "edit_workspace", summary: "Edit retry logic" },
                      { ref: "test", capability: "run_validation", summary: "Run retry tests" },
                      { ref: "commit", capability: "create_commit", summary: "Commit retry logic" },
                      { ref: "push", capability: "push_current_pr", summary: "Push current PR" },
                      { ref: "trail", capability: "update_current_pr", summary: "Post intent trail" },
                    ],
                  },
                ],
                operations: [
                  {
                    ref: "create-retry",
                    kind: "create",
                    actionRef: "retry-backoff",
                    sourceSegmentIndexes: [0],
                    summary: "Create requested retry outcome",
                  },
                ],
                findings: [],
              });
            }
            committed = true;
          }
          return warm
            ? { id: "warm-run", status: "finished", result: "READY" }
            : {
                id: "execute-run",
                status: executionStatus,
                result: "APPLIED\nretry backoff",
                error: executionStatus === "finished" ? undefined : { message: "boom" },
              };
        },
      };
    },
    close() {},
    async [Symbol.asyncDispose]() {
      disposed++;
    },
  };
  const runCommand = async (cmd, args, options = {}) => {
    commands.push({ cmd, args, cwd: options.cwd });
    const joined = args.join(" ");
    if (joined === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
    if (joined === "rev-parse FETCH_HEAD")
      return { code: 0, stdout: `${base}\n`, stderr: "" };
    if (joined === "rev-parse HEAD") {
      headReads++;
      const sha = committed ? changed : base;
      return {
        code: 0,
        stdout: `${sha}\n`,
        stderr: "",
      };
    }
    if (joined.startsWith("log --format="))
      return {
        code: 0,
        stdout: `${changed}\tadd retry backoff\n`,
        stderr: "",
      };
    if (args.includes("push")) {
      pushed = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (joined.startsWith("ls-remote"))
      return {
        code: 0,
        stdout: `${pushed ? changed : base}\trefs/heads/feat\n`,
        stderr: "",
      };
    return { code: 0, stdout: "", stderr: "" };
  };
  const runtime = createAgentRuntime({
    apiKey: "test-key",
    ...(model ? { model } : {}),
    ttlMs: 60_000,
    prepareTtlMs,
    prepareMax,
    warmHeartbeatMs,
    createAgent: async (options) => {
      createdWith = options;
      if (warmSetupDelayMs)
        await new Promise((resolve) => setTimeout(resolve, warmSetupDelayMs));
      return agent;
    },
    listModels: async () => [{ id: "test-model" }],
    prepareWorkspace: async (input) => {
      prepareCalls.push(input);
      return {
        path: `/tmp/voice-pr-agent-test/${input.sessionId}`,
        headSha: preparedHead || base,
        mirror: "/tmp/voice-pr-agent-test.git",
        localBranch: `voice-pr/${input.sessionId}`,
      };
    },
    runCommand,
    actionStore: {
      async listOpen() { return []; },
      async record() {},
    },
  });
  return {
    runtime,
    prompts,
    sendOptions,
    commands,
    prepareCalls,
    createdWith: () => createdWith,
    disposed: () => disposed,
  };
}

test("warm stages an idle agent without running inference", async () => {
  const { runtime, prompts, sendOptions, createdWith } = harness();
  const status = runtime.warm({ sessionId: "s1", pr, context: { jiraKey: "ABC-1" } });
  assert.equal(status.state, "warming");
  await waitFor(() => runtime.status("s1")?.state === "ready");
  assert.equal(prompts.length, 0);
  assert.equal(createdWith().mode, "plan");
  assert.equal(createdWith().local.sandboxOptions.enabled, true);
  assert.ok(!createdWith().local.settingSources.includes("project"));
  assert.equal(sendOptions.length, 0);
  await runtime.shutdown();
});

test("passive preparation coalesces by PR head and never creates an agent", async () => {
  const { runtime, prepareCalls, prompts, createdWith } = harness();
  const events = [];
  const emit = (stage, detail) => events.push({ stage, detail });
  const first = await runtime.preparePr({ pr, emit });
  const second = await runtime.preparePr({ pr, emit });
  assert.equal(first.state, "ready");
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(prepareCalls.length, 1);
  assert.equal(prompts.length, 0);
  assert.equal(createdWith(), null);
  assert.ok(events.some((event) => event.stage === "preparation-cache-miss"));
  assert.ok(events.some((event) => event.stage === "preparation-cache-hit"));
  await runtime.shutdown();
});

test("preparation rekeys itself when the mirror observes a newer PR head", async () => {
  const newer = "c".repeat(40);
  const movingPr = { ...pr };
  const { runtime } = harness({ preparedHead: newer });
  const events = [];
  const result = await runtime.preparePr({
    pr: movingPr,
    emit: (stage, detail) => events.push({ stage, detail }),
  });
  assert.equal(movingPr.headRefOid, newer);
  assert.match(result.key, new RegExp(`@${newer}$`));
  assert.ok(events.some((event) => event.stage === "workspace-prepare-refreshed"));
  await runtime.shutdown();
});

test("record start atomically leases the prepared PR-head worktree", async () => {
  const { runtime, prepareCalls, createdWith } = harness();
  await runtime.preparePr({ pr });
  const events = [];
  runtime.warm({
    sessionId: "prepared-session",
    pr,
    context: {},
    recordStartedAt: Date.now(),
    emit: (stage, detail) => events.push({ stage, detail }),
  });
  await waitFor(() => runtime.status("prepared-session")?.state === "ready");
  assert.equal(prepareCalls.length, 1, "warm must not create a second worktree");
  assert.match(createdWith().local.cwd, /prepared-o-r-7-/);
  assert.ok(
    events.some(
      (event) =>
        event.stage === "workspace-ready" &&
        event.detail.preparationHit === true
    )
  );
  await runtime.shutdown();
});

test("a second concurrent recording cannot share an already-leased worktree", async () => {
  const { runtime, prepareCalls } = harness();
  await runtime.preparePr({ pr });
  runtime.warm({ sessionId: "lease-a", pr, context: {} });
  runtime.warm({ sessionId: "lease-b", pr, context: {} });
  await waitFor(
    () =>
      runtime.status("lease-a")?.state === "ready" &&
      runtime.status("lease-b")?.state === "ready"
  );
  assert.equal(
    prepareCalls.length,
    2,
    "one recording leases the prepared tree; the other gets an isolated tree"
  );
  await runtime.shutdown();
});

test("unused prepared worktrees expire and are removed", async () => {
  const { runtime, commands, createdWith } = harness({ prepareTtlMs: 5 });
  const events = [];
  await runtime.preparePr({
    pr,
    emit: (stage, detail) => events.push({ stage, detail }),
  });
  await waitFor(() =>
    commands.some((call) => call.args.join(" ").includes("worktree remove --force"))
  );
  assert.equal(createdWith(), null);
  assert.ok(
    events.some(
      (event) =>
        event.stage === "preparation-cache-invalidated" &&
        /TTL expired/.test(event.detail.reason)
    )
  );
  await runtime.shutdown();
});

test("execute reuses the warm agent for interpretation, edits, validation, commit, and push", async () => {
  const { runtime, prompts, sendOptions, commands, disposed } = harness();
  runtime.warm({ sessionId: "s2", pr, context: {} });
  await waitFor(() => runtime.status("s2")?.state === "ready");
  const events = [];
  const result = await runtime.execute({
    sessionId: "s2",
    pr,
    context: {},
    segments,
    emit: (stage, detail) => events.push({ stage, detail }),
  });
  assert.equal(prompts.length, 1, "one execution turn after staging");
  assert.match(prompts[0], /Interpretation harness/);
  assert.equal(sendOptions[0].mode, "agent");
  assert.match(sendOptions[0].idempotencyKey, /:execute$/);
  assert.equal(typeof sendOptions[0].local.customTools.record_action_plan.execute, "function");
  assert.equal(result.status, "done");
  assert.equal(result.agentId, "agent-1");
  assert.equal(result.commits.length, 1);
  assert.equal(result.published, true);
  assert.equal(result.actionSummary.totalActions, 1);
  assert.equal(result.commits[0].oid, "b".repeat(40));
  assert.ok(
    commands.some((call) =>
      call.args
        .join(" ")
        .includes("-c remote.origin.mirror=false push origin HEAD:refs/heads/feat")
    ),
    "the harness, not the sandboxed agent, must push the committed change"
  );
  assert.ok(commands.some((call) => call.args[0] === "ls-remote"));
  assert.ok(events.some((event) => event.stage === "agent-ready"));
  assert.ok(events.some((event) => event.stage === "actions-compiled"));
  assert.ok(events.some((event) => event.stage === "agent-finished"));
  assert.equal(disposed(), 1);
});

test("execute emits heartbeat progress while agent setup is still running", async () => {
  const { runtime } = harness({ warmSetupDelayMs: 20, warmHeartbeatMs: 5 });
  const events = [];
  runtime.warm({ sessionId: "slow-warm", pr, context: {} });
  await runtime.execute({
    sessionId: "slow-warm",
    pr,
    context: {},
    segments,
    emit: (stage, detail) => events.push({ stage, detail }),
  });
  const waiting = events.filter(
    (event) => event.stage === "agent-warm-waiting"
  );
  assert.ok(waiting.length >= 2);
  assert.equal(waiting[0].detail.state, "warming");
  assert.ok(waiting.some((event) => event.detail.elapsedMs >= 5));
  assert.ok(
    events.findIndex((event) => event.stage === "agent-warm-waiting") <
      events.findIndex((event) => event.stage === "agent-ready")
  );
  await runtime.shutdown();
});

test("execute performs only one inference turn after staging", async () => {
  const { runtime, prompts, sendOptions } = harness();
  runtime.warm({
    sessionId: "single-turn",
    pr,
    context: {},
  });
  await waitFor(() => runtime.status("single-turn")?.state === "ready");
  assert.equal(prompts.length, 0, "record start must not run inference");

  const result = await runtime.execute({
    sessionId: "single-turn",
    pr,
    context: {},
    segments,
  });
  assert.equal(prompts.length, 1);
  assert.equal(sendOptions[0].mode, "agent");
  assert.match(prompts[0], /only inference turn/i);
  assert.equal(result.metrics.inferenceTurnsBeforeStop, 0);
  await runtime.shutdown();
});

test("local-workspace autonomy prepares commits without publishing", async () => {
  const { runtime, commands } = harness();
  const events = [];
  const result = await runtime.execute({
    sessionId: "local-only",
    pr,
    context: {},
    segments,
    autonomyLevel: "local_workspace",
    emit: (stage, detail) => events.push({ stage, detail }),
  });
  assert.equal(result.commits.length, 1);
  assert.equal(result.published, false);
  assert.equal(result.localWorkspaceRetained, true);
  assert.match(result.workspace, /local-only$/);
  assert.ok(events.some((event) => event.stage === "agent-push-blocked"));
  assert.ok(!commands.some((call) => call.args.includes("push")));
  assert.ok(!commands.some((call) => call.args.includes("worktree") && call.args.includes("remove")));
  await runtime.shutdown();
  assert.ok(commands.some((call) => call.args.includes("worktree") && call.args.includes("remove")));
});

test("missing Action Plans prevent publication", async () => {
  const { runtime, commands } = harness({ skipActionPlan: true });
  await assert.rejects(
    runtime.execute({ sessionId: "missing-plan", pr, context: {}, segments }),
    /without recording the required Action Plan/
  );
  assert.ok(!commands.some((call) => call.args.includes("push")));
  await runtime.shutdown();
});

test("execute is idempotent for a completed session", async () => {
  const { runtime, prompts } = harness();
  const input = { sessionId: "s3", pr, context: {}, segments };
  const first = await runtime.execute(input);
  const second = await runtime.execute(input);
  assert.equal(second, first);
  assert.equal(prompts.length, 1);
});

test("run failures are distinct from successful agent completion", async () => {
  const { runtime } = harness({ executionStatus: "error" });
  await assert.rejects(
    runtime.execute({ sessionId: "s4", pr, context: {}, segments }),
    /Cursor agent execution failed: boom/
  );
  assert.equal(runtime.status("s4").state, "error");
});

test("preflight checks SDK authentication and model discovery", async () => {
  const { runtime } = harness();
  const result = await runtime.check();
  assert.equal(result.ok, true);
  assert.match(result.detail, /model test-model/);
});

test("defaults to Composer 2.5 Fast when no model override is configured", async () => {
  const previous = process.env.VOICE_PR_MODEL;
  delete process.env.VOICE_PR_MODEL;
  const { runtime, createdWith } = harness({ model: null });
  try {
    runtime.warm({ sessionId: "s5", pr, context: {} });
    await waitFor(() => runtime.status("s5")?.state === "ready");
    assert.deepEqual(createdWith().model, {
      id: "composer-2.5",
      params: [{ id: "fast", value: "true" }],
    });
  } finally {
    if (previous == null) delete process.env.VOICE_PR_MODEL;
    else process.env.VOICE_PR_MODEL = previous;
    await runtime.shutdown();
  }
});

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("timed out waiting for condition");
}
