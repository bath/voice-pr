import { access, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Agent, Cursor } from "@cursor/sdk";
import { run } from "./exec.js";
import { buildExecutionPrompt, buildWarmPrompt } from "./prompt.js";

const DEFAULT_TTL_MS = Number(process.env.VOICE_PR_AGENT_TTL_MS || 30 * 60_000);
const DEFAULT_WORKSPACE_ROOT =
  process.env.VOICE_PR_WORKSPACE_DIR || join(homedir(), ".voice-pr", "workspaces");
const DEFAULT_CACHE_ROOT =
  process.env.VOICE_PR_REPO_CACHE_DIR || join(homedir(), ".voice-pr", "repo-cache");

export function createAgentRuntime(options = {}) {
  const createAgent = options.createAgent || ((agentOptions) => Agent.create(agentOptions));
  const listModels = options.listModels || ((requestOptions) => Cursor.models.list(requestOptions));
  const runCommand = options.runCommand || run;
  const prepare = options.prepareWorkspace || prepareWorkspace;
  const workspaceRoot = options.workspaceRoot || DEFAULT_WORKSPACE_ROOT;
  const cacheRoot = options.cacheRoot || DEFAULT_CACHE_ROOT;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const sessions = new Map();
  const repoLocks = new Map();
  let checkCache = null;

  function warm({ sessionId, pr, context = {}, emit = () => {} }) {
    requireSessionId(sessionId);
    const prior = sessions.get(sessionId);
    if (prior) {
      if (prKey(prior.pr) !== prKey(pr))
        throw new Error(`session ${sessionId} is already warming a different PR`);
      return publicStatus(prior);
    }

    const entry = {
      sessionId,
      pr,
      context,
      state: "warming",
      startedAt: Date.now(),
      readyAt: null,
      executeStartedAt: null,
      completedAt: null,
      workspace: null,
      mirror: null,
      localBranch: null,
      headSha: null,
      agent: null,
      agentId: null,
      runId: null,
      error: null,
      result: null,
      executionPromise: null,
      timer: null,
      executing: false,
    };
    sessions.set(sessionId, entry);
    entry.promise = doWarm(entry, emit);
    // A recording may be abandoned. Keep a rejected warm promise observable to a
    // later dispatch without creating an unhandled rejection in the bridge.
    entry.promise.catch(() => {});
    scheduleExpiry(entry);
    return publicStatus(entry);
  }

  async function doWarm(entry, emit) {
    try {
      emit("workspace-preparing", { sessionId: entry.sessionId });
      const workspace = await withRepoLock(repoKey(entry.pr), () =>
        prepare({
          sessionId: entry.sessionId,
          pr: entry.pr,
          workspaceRoot,
          cacheRoot,
          runCommand,
        })
      );
      entry.workspace = workspace.path;
      entry.mirror = workspace.mirror;
      entry.localBranch = workspace.localBranch;
      entry.headSha = workspace.headSha;
      emit("workspace-ready", { path: workspace.path, headSha: workspace.headSha });

      const apiKey = options.apiKey ?? process.env.CURSOR_API_KEY;
      if (!apiKey) throw new Error("CURSOR_API_KEY is required for the Cursor SDK agent");
      const model = configuredModel(options);
      entry.agent = await createAgent({
        apiKey,
        name: `voice-pr ${entry.pr.owner}/${entry.pr.repo}#${entry.pr.number}`,
        model,
        mode: "plan",
        idempotencyKey: `voice-pr:${entry.sessionId}:agent`,
        local: {
          cwd: workspace.path,
          autoReview: true,
          settingSources: options.settingSources || ["user", "team", "plugins"],
          sandboxOptions: { enabled: true },
          enableAgentRetries: true,
        },
      });
      entry.agentId = entry.agent.agentId;
      emit("agent-warming", { agentId: entry.agentId, model: modelLabel(model) });

      const warmRun = await entry.agent.send(
        buildWarmPrompt({ pr: entry.pr, context: entry.context }),
        {
          mode: "plan",
          idempotencyKey: `voice-pr:${entry.sessionId}:warm`,
        }
      );
      entry.runId = warmRun.id;
      const warmResult = await warmRun.wait();
      assertFinished(warmResult, "pre-warm");
      const dirty = (
        await runCommand("git", ["status", "--porcelain"], { cwd: entry.workspace })
      ).stdout.trim();
      const headAfterWarm = await gitHead(entry.workspace, runCommand);
      if (dirty || headAfterWarm !== entry.headSha)
        throw new Error(
          "Cursor agent changed the managed worktree during the read-only pre-warm turn"
        );

      entry.readyAt = Date.now();
      entry.state = "ready";
      entry.warmSummary = warmResult.result || "";
      emit("agent-warm", {
        agentId: entry.agentId,
        runId: warmRun.id,
        warmMs: entry.readyAt - entry.startedAt,
      });
      return entry;
    } catch (error) {
      entry.state = "error";
      entry.error = error;
      await closeAgent(entry);
      throw error;
    }
  }

  function execute({ sessionId, pr, context = {}, segments, emit = () => {} }) {
    requireSessionId(sessionId);
    let entry = sessions.get(sessionId);
    if (!entry) {
      warm({ sessionId, pr, context, emit });
      entry = sessions.get(sessionId);
    }
    if (entry.result) return entry.result;
    if (entry.executionPromise) return entry.executionPromise;
    entry.executionPromise = executeEntry(entry, { pr, context, segments, emit });
    entry.executionPromise.catch(() => {});
    return entry.executionPromise;
  }

  async function executeEntry(entry, { pr, context, segments, emit }) {
    const waitStartedAt = Date.now();
    await entry.promise;
    const warmWaitMs = Date.now() - waitStartedAt;
    entry.executing = true;
    entry.executeStartedAt = Date.now();
    entry.state = "executing";
    clearTimeout(entry.timer);

    try {
      const warmHead = entry.headSha;
      const sync = await withRepoLock(repoKey(pr), () =>
        syncWorkspace({
          workspace: entry.workspace,
          pr,
          runCommand,
        })
      );
      if (sync.changed) {
        entry.headSha = sync.headSha;
        emit("workspace-refreshed", { headSha: sync.headSha });
      }

      emit("agent-ready", {
        agentId: entry.agentId,
        warmWaitMs,
        warmLeadMs: Math.max(0, entry.executeStartedAt - entry.startedAt),
      });
      emit("interpreting", { segments: segments.length });

      const beforeHead = await gitHead(entry.workspace, runCommand);
      const executionRun = await entry.agent.send(
        buildExecutionPrompt({
          pr,
          segments,
          context,
          branchHead: beforeHead,
          branchDrift: sync.changed ? { from: warmHead, to: sync.headSha } : null,
        }),
        {
          mode: "agent",
          idempotencyKey: `voice-pr:${entry.sessionId}:execute`,
        }
      );
      entry.runId = executionRun.id;
      emit("agent-running", { agentId: entry.agentId, runId: executionRun.id });
      const executionResult = await executionRun.wait();
      assertFinished(executionResult, "execution");

      const dirty = (await runCommand("git", ["status", "--porcelain"], {
        cwd: entry.workspace,
      })).stdout.trim();
      if (dirty)
        throw new Error(
          `Cursor agent finished with uncommitted changes in ${entry.workspace}: ${dirty.split("\n")[0]}`
        );

      const afterHead = await gitHead(entry.workspace, runCommand);
      const commits = await commitsBetween(entry.workspace, beforeHead, afterHead, runCommand);
      if (afterHead !== beforeHead) {
        emit("agent-pushing", {
          branch: pr.headRefName,
          commits: commits.length,
        });
        await pushAndVerify({
          workspace: entry.workspace,
          branch: pr.headRefName,
          expectedHead: afterHead,
          runCommand,
        });
      }

      entry.completedAt = Date.now();
      entry.state = "done";
      entry.result = {
        backend: "cursor-sdk",
        status: "done",
        agentId: entry.agentId,
        runId: executionRun.id,
        workspace: entry.workspace,
        commits,
        agentSummary: executionResult.result || "",
        metrics: {
          warmStartedAt: entry.startedAt,
          warmReadyAt: entry.readyAt,
          executionStartedAt: entry.executeStartedAt,
          patchReadyAt: entry.completedAt,
          warmMs: entry.readyAt - entry.startedAt,
          warmWaitMs,
          executionMs: entry.completedAt - entry.executeStartedAt,
        },
      };
      emit("agent-finished", {
        commits: commits.length,
        executionMs: entry.result.metrics.executionMs,
      });
      return entry.result;
    } catch (error) {
      entry.state = "error";
      entry.error = error;
      throw error;
    } finally {
      entry.executing = false;
      entry.completedAt ||= Date.now();
      await closeAgent(entry);
      scheduleExpiry(entry);
    }
  }

  async function check() {
    if (checkCache && Date.now() - checkCache.at < 60_000) return checkCache.value;
    const version = process.versions.node.split(".").map(Number);
    if (version[0] < 22 || (version[0] === 22 && version[1] < 13)) {
      return { ok: false, detail: `Node ${process.versions.node}; Cursor SDK requires >=22.13` };
    }
    const apiKey = options.apiKey ?? process.env.CURSOR_API_KEY;
    if (!apiKey) return { ok: false, detail: "CURSOR_API_KEY is not set" };
    try {
      const models = await listModels({ apiKey });
      const model = configuredModel(options);
      const value = {
        ok: true,
        detail: `authenticated · model ${modelLabel(model)} · ${models.length} available`,
      };
      checkCache = { at: Date.now(), value };
      return value;
    } catch (error) {
      return { ok: false, detail: `Cursor SDK unavailable (${firstLine(error.message)})` };
    }
  }

  function status(sessionId) {
    const entry = sessions.get(sessionId);
    return entry ? publicStatus(entry) : null;
  }

  async function shutdown() {
    await Promise.all(
      [...sessions.values()].map(async (entry) => {
        clearTimeout(entry.timer);
        await closeAgent(entry);
      })
    );
  }

  function scheduleExpiry(entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      if (entry.executing) return scheduleExpiry(entry);
      await closeAgent(entry);
      await cleanupWorkspace(entry);
      sessions.delete(entry.sessionId);
    }, ttlMs);
    entry.timer.unref?.();
  }

  async function closeAgent(entry) {
    if (!entry.agent) return;
    const agent = entry.agent;
    entry.agent = null;
    try {
      await agent[Symbol.asyncDispose]();
    } catch {
      try {
        agent.close();
      } catch {}
    }
  }

  async function cleanupWorkspace(entry) {
    if (!entry.workspace || !entry.mirror) return;
    await runCommand(
      "git",
      ["--git-dir", entry.mirror, "worktree", "remove", "--force", entry.workspace],
      { allowFail: true }
    ).catch(() => {});
    if (entry.localBranch)
      await runCommand(
        "git",
        ["--git-dir", entry.mirror, "branch", "-D", entry.localBranch],
        { allowFail: true }
      ).catch(() => {});
  }

  async function withRepoLock(key, task) {
    const previous = repoLocks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    repoLocks.set(key, current);
    try {
      return await current;
    } finally {
      if (repoLocks.get(key) === current) repoLocks.delete(key);
    }
  }

  return { warm, execute, check, status, shutdown };
}

async function prepareWorkspace({
  sessionId,
  pr,
  workspaceRoot,
  cacheRoot,
  runCommand,
}) {
  const repoName = safeName(`${pr.owner}--${pr.repo}`);
  const safeSession = safeName(sessionId);
  const mirror = join(cacheRoot, `${repoName}.git`);
  const workspace = join(workspaceRoot, safeSession);
  const localBranch = `voice-pr/${safeSession}`;
  await mkdir(dirname(mirror), { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });

  if (!(await exists(join(mirror, "HEAD")))) {
    await runCommand("gh", [
      "repo",
      "clone",
      `${pr.owner}/${pr.repo}`,
      mirror,
      "--",
      "--mirror",
    ]);
  } else {
    await runCommand("git", ["--git-dir", mirror, "fetch", "--prune", "origin"]);
  }

  if (await exists(join(workspace, ".git"))) {
    const headSha = await gitHead(workspace, runCommand);
    return { path: workspace, headSha, mirror, localBranch };
  }
  if (await exists(workspace)) await rm(workspace, { recursive: true, force: true });

  await runCommand("git", ["--git-dir", mirror, "worktree", "prune"]);
  await runCommand("git", [
    "--git-dir",
    mirror,
    "worktree",
    "add",
    "--force",
    "-B",
    localBranch,
    workspace,
    `refs/heads/${pr.headRefName}`,
  ]);
  const headSha = await gitHead(workspace, runCommand);
  return { path: workspace, headSha, mirror, localBranch };
}

async function syncWorkspace({ workspace, pr, runCommand }) {
  const dirty = (await runCommand("git", ["status", "--porcelain"], { cwd: workspace }))
    .stdout.trim();
  if (dirty)
    throw new Error(
      `managed workspace is dirty before execution: ${dirty.split("\n")[0]}`
    );
  const before = await gitHead(workspace, runCommand);
  await runCommand("git", ["fetch", "origin", `refs/heads/${pr.headRefName}`], {
    cwd: workspace,
  });
  const fetched = (
    await runCommand("git", ["rev-parse", "FETCH_HEAD"], { cwd: workspace })
  ).stdout.trim();
  if (fetched !== before)
    await runCommand("git", ["merge", "--ff-only", "FETCH_HEAD"], { cwd: workspace });
  return { changed: fetched !== before, headSha: fetched };
}

async function gitHead(workspace, runCommand) {
  return (
    await runCommand("git", ["rev-parse", "HEAD"], { cwd: workspace })
  ).stdout.trim();
}

async function commitsBetween(workspace, before, after, runCommand) {
  if (!before || !after || before === after) return [];
  const { stdout } = await runCommand(
    "git",
    ["log", "--format=%H%x09%s", `${before}..${after}`],
    { cwd: workspace }
  );
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [oid, ...message] = line.split("\t");
      return { oid, messageHeadline: message.join("\t") };
    })
    .reverse();
}

export async function pushAndVerify({
  workspace,
  branch,
  expectedHead,
  runCommand = run,
}) {
  await runCommand(
    "git",
    [
      "-c",
      "remote.origin.mirror=false",
      "push",
      "origin",
      `HEAD:refs/heads/${branch}`,
    ],
    { cwd: workspace }
  );
  const remoteHead = (
    await runCommand(
      "git",
      ["ls-remote", "--heads", "origin", `refs/heads/${branch}`],
      { cwd: workspace }
    )
  ).stdout.trim().split(/\s+/)[0];
  if (remoteHead !== expectedHead)
    throw new Error(
      `voice-pr pushed ${expectedHead.slice(0, 8)} but ${branch} points to ${remoteHead?.slice(0, 8) || "nothing"}`
    );
  return remoteHead;
}

function assertFinished(result, phase) {
  if (result?.status === "finished") return;
  const detail = result?.error?.message || result?.result || result?.status || "unknown error";
  throw new Error(`Cursor agent ${phase} failed: ${detail}`);
}

function publicStatus(entry) {
  return {
    sessionId: entry.sessionId,
    state: entry.state,
    agentId: entry.agentId,
    startedAt: entry.startedAt,
    readyAt: entry.readyAt,
    error: entry.error?.message || null,
  };
}

function requireSessionId(sessionId) {
  if (!String(sessionId || "").trim()) throw new Error("sessionId is required to warm an agent");
}

function prKey(pr) {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}

function repoKey(pr) {
  return `${pr.owner}/${pr.repo}`;
}

function safeName(value) {
  return String(value || "").replace(/[^A-Za-z0-9._-]/g, "-");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function firstLine(value) {
  return String(value || "").split("\n")[0];
}

function configuredModel(options) {
  const override = options.model || process.env.VOICE_PR_MODEL;
  if (override) return { id: override };
  return {
    id: "composer-2.5",
    params: [{ id: "fast", value: "true" }],
  };
}

function modelLabel(model) {
  const fast = model.params?.some(
    (parameter) => parameter.id === "fast" && parameter.value === "true"
  );
  return `${model.id}${fast ? " (fast)" : ""}`;
}

export const agentRuntime = createAgentRuntime();
