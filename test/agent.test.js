import assert from "node:assert/strict";
import test from "node:test";
import { createAgentRuntime } from "../lib/agent.js";

const pr = {
  owner: "o",
  repo: "r",
  number: 7,
  title: "Add retry",
  headRefName: "feat",
};
const segments = [{ text: "this needs backoff", file: "lib/net.js", line: 12 }];

function harness({ executionStatus = "finished" } = {}) {
  const prompts = [];
  const sendOptions = [];
  const commands = [];
  let disposed = 0;
  let createdWith = null;
  let headReads = 0;
  const base = "a".repeat(40);
  const changed = "b".repeat(40);
  const agent = {
    agentId: "agent-1",
    async send(prompt, options) {
      prompts.push(prompt);
      sendOptions.push(options);
      const warm = prompts.length === 1;
      return {
        id: warm ? "warm-run" : "execute-run",
        async wait() {
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
      return {
        code: 0,
        stdout: `${headReads < 4 ? base : changed}\n`,
        stderr: "",
      };
    }
    if (joined.startsWith("log --format="))
      return {
        code: 0,
        stdout: `${changed}\tadd retry backoff\n`,
        stderr: "",
      };
    if (joined.startsWith("ls-remote"))
      return { code: 0, stdout: `${changed}\trefs/heads/feat\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const runtime = createAgentRuntime({
    apiKey: "test-key",
    model: "test-model",
    ttlMs: 60_000,
    createAgent: async (options) => {
      createdWith = options;
      return agent;
    },
    listModels: async () => [{ id: "test-model" }],
    prepareWorkspace: async () => ({ path: "/tmp/voice-pr-agent-test", headSha: base }),
    runCommand,
  });
  return {
    runtime,
    prompts,
    sendOptions,
    commands,
    createdWith: () => createdWith,
    disposed: () => disposed,
  };
}

test("warm starts immediately and performs the expensive analysis turn", async () => {
  const { runtime, prompts, sendOptions, createdWith } = harness();
  const status = runtime.warm({ sessionId: "s1", pr, context: { jiraKey: "ABC-1" } });
  assert.equal(status.state, "warming");
  await waitFor(() => runtime.status("s1")?.state === "ready");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Pre-warm/);
  assert.match(prompts[0], /Do not edit files/);
  assert.equal(createdWith().mode, "plan");
  assert.equal(createdWith().local.sandboxOptions.enabled, true);
  assert.ok(!createdWith().local.settingSources.includes("project"));
  assert.equal(sendOptions[0].mode, "plan");
  await runtime.shutdown();
});

test("execute reuses the warm agent for interpretation, edits, validation, commit, and push", async () => {
  const { runtime, prompts, sendOptions, commands, disposed } = harness();
  runtime.warm({ sessionId: "s2", pr, context: {} });
  const events = [];
  const result = await runtime.execute({
    sessionId: "s2",
    pr,
    context: {},
    segments,
    emit: (stage, detail) => events.push({ stage, detail }),
  });
  assert.equal(prompts.length, 2, "one warm turn + one execution turn");
  assert.match(prompts[1], /Interpretation harness/);
  assert.equal(sendOptions[1].mode, "agent");
  assert.match(sendOptions[1].idempotencyKey, /:execute$/);
  assert.equal(result.status, "done");
  assert.equal(result.agentId, "agent-1");
  assert.equal(result.commits.length, 1);
  assert.equal(result.commits[0].oid, "b".repeat(40));
  assert.ok(commands.some((call) => call.args[0] === "ls-remote"));
  assert.ok(events.some((event) => event.stage === "agent-ready"));
  assert.ok(events.some((event) => event.stage === "agent-finished"));
  assert.equal(disposed(), 1);
});

test("execute is idempotent for a completed session", async () => {
  const { runtime, prompts } = harness();
  const input = { sessionId: "s3", pr, context: {}, segments };
  const first = await runtime.execute(input);
  const second = await runtime.execute(input);
  assert.equal(second, first);
  assert.equal(prompts.length, 2);
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

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("timed out waiting for condition");
}
