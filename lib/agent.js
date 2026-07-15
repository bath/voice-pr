import { access, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Agent, Cursor } from "@cursor/sdk";
import { run } from "./exec.js";
import { buildExecutionPrompt } from "./prompt.js";
import {
  DEFAULT_AUTONOMY_LEVEL,
  authorizeActionPlan,
  createActionPlanRecorder,
} from "./action-framework.js";
import { actionStore as defaultActionStore } from "./action-store.js";

const DEFAULT_TTL_MS = Number(process.env.VOICE_PR_AGENT_TTL_MS || 30 * 60_000);
const DEFAULT_PREPARE_TTL_MS = Number(
  process.env.VOICE_PR_PREPARE_TTL_MS || 10 * 60_000
);
const DEFAULT_PREPARE_MAX = Number(process.env.VOICE_PR_PREPARE_MAX || 6);
const DEFAULT_WORKSPACE_ROOT =
  process.env.VOICE_PR_WORKSPACE_DIR || join(homedir(), ".voice-pr", "workspaces");
const DEFAULT_CACHE_ROOT =
  process.env.VOICE_PR_REPO_CACHE_DIR || join(homedir(), ".voice-pr", "repo-cache");

export function createAgentRuntime(options = {}) {
  const createAgent = options.createAgent || ((agentOptions) => Agent.create(agentOptions));
  const listModels = options.listModels || ((requestOptions) => Cursor.models.list(requestOptions));
  const runCommand = options.runCommand || run;
  const prepareWorkspaceFn = options.prepareWorkspace || prepareWorkspace;
  const workspaceRoot = options.workspaceRoot || DEFAULT_WORKSPACE_ROOT;
  const cacheRoot = options.cacheRoot || DEFAULT_CACHE_ROOT;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const prepareTtlMs = options.prepareTtlMs ?? DEFAULT_PREPARE_TTL_MS;
  const prepareMax = options.prepareMax ?? DEFAULT_PREPARE_MAX;
  const warmHeartbeatMs = options.warmHeartbeatMs ?? 1_000;
  const actionStore = options.actionStore || defaultActionStore;
  const sessions = new Map();
  const preparations = new Map();
  const repoLocks = new Map();
  let checkCache = null;

  async function preparePr({ pr, emit = () => {} }) {
    const key = preparationKey(pr);
    const existing = preparations.get(key);
    if (existing) {
      emit("preparation-cache-hit", {
        key,
        state: existing.state,
        leased: !!existing.leasedBy,
        ageMs: Date.now() - existing.startedAt,
        headSha: existing.headSha || pr.headRefOid,
      });
      await existing.promise;
      return publicPreparation(existing, true);
    }
    emit("preparation-cache-miss", {
      key,
      reason: "no prepared worktree for this PR head",
      headSha: pr.headRefOid,
    });

    const readyToEvict = [...preparations.values()]
      .filter((entry) => entry.state !== "preparing" && !entry.leasedBy)
      .sort((a, b) => a.startedAt - b.startedAt);
    while (preparations.size >= prepareMax && readyToEvict.length) {
      const oldest = readyToEvict.shift();
      preparations.delete(oldest.key);
      clearTimeout(oldest.timer);
      emit("preparation-cache-invalidated", {
        key: oldest.key,
        reason: "capacity eviction",
        headSha: oldest.headSha,
      });
      await cleanupWorkspaceLocked(oldest);
    }
    if (preparations.size >= prepareMax) {
      emit("preparation-cache-skipped", {
        key,
        reason: "all preparation slots are active",
        size: preparations.size,
        max: prepareMax,
      });
      return {
        key,
        state: "skipped",
        cacheHit: false,
        reason: "preparation capacity reached",
      };
    }

    const entry = {
      key,
      pr,
      state: "preparing",
      startedAt: Date.now(),
      readyAt: null,
      workspace: null,
      mirror: null,
      localBranch: null,
      headSha: null,
      leasedBy: null,
      timer: null,
      emit,
      error: null,
    };
    preparations.set(key, entry);
    entry.promise = doPrepare(entry);
    entry.promise.catch(() => {});
    schedulePreparationExpiry(entry);
    await entry.promise;
    return publicPreparation(entry, false);
  }

  async function doPrepare(entry) {
    try {
      entry.emit("workspace-prepare-start", {
        key: entry.key,
        headSha: entry.pr.headRefOid,
      });
      const workspace = await withRepoLock(repoKey(entry.pr), () =>
        prepareWorkspaceFn({
          sessionId: preparationWorkspaceId(entry.pr),
          pr: entry.pr,
          workspaceRoot,
          cacheRoot,
          runCommand,
          emit: entry.emit,
        })
      );
      assignWorkspace(entry, workspace);
      if (entry.headSha && entry.headSha !== entry.pr.headRefOid) {
        const previousKey = entry.key;
        preparations.delete(previousKey);
        entry.pr.headRefOid = entry.headSha;
        entry.key = preparationKey(entry.pr);
        preparations.set(entry.key, entry);
        entry.emit("preparation-cache-invalidated", {
          key: previousKey,
          reason: "PR head changed during repository refresh",
          replacementKey: entry.key,
          headSha: entry.headSha,
        });
        entry.emit("workspace-prepare-refreshed", {
          previousKey,
          key: entry.key,
          headSha: entry.headSha,
        });
      }
      entry.readyAt = Date.now();
      entry.state = "ready";
      entry.emit("workspace-prepared", {
        key: entry.key,
        path: entry.workspace,
        headSha: entry.headSha,
        preparationMs: entry.readyAt - entry.startedAt,
      });
      return entry;
    } catch (error) {
      entry.state = "error";
      entry.error = error;
      preparations.delete(entry.key);
      await cleanupWorkspaceLocked(entry);
      throw error;
    }
  }

  function warm({
    sessionId,
    pr,
    context = {},
    recordStartedAt = null,
    emit = () => {},
  }) {
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
      recordStartedAt: Number.isFinite(recordStartedAt) ? recordStartedAt : null,
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
      preparationHit: false,
      preparationKey: null,
      preparationAgeMs: null,
      recordToAgentReadyMs: null,
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
      const prepared = leasePreparation(entry.pr, entry.sessionId);
      if (prepared) {
        try {
          await prepared.promise;
          assignWorkspace(entry, prepared);
          entry.preparationHit = true;
          entry.preparationKey = prepared.key;
          entry.preparationAgeMs = Math.max(
            0,
            entry.startedAt - (prepared.readyAt || entry.startedAt)
          );
        } catch (error) {
          emit("workspace-prepare-miss", {
            reason: `prepared workspace failed: ${firstLine(error.message)}`,
          });
        }
      }
      if (!entry.workspace) {
        const workspace = await withRepoLock(repoKey(entry.pr), () =>
          prepareWorkspaceFn({
            sessionId: entry.sessionId,
            pr: entry.pr,
            workspaceRoot,
            cacheRoot,
            runCommand,
            emit,
          })
        );
        assignWorkspace(entry, workspace);
      }
      emit("workspace-ready", {
        path: entry.workspace,
        headSha: entry.headSha,
        preparationHit: entry.preparationHit,
        preparationAgeMs: entry.preparationAgeMs,
      });

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
          cwd: entry.workspace,
          autoReview: true,
          settingSources: options.settingSources || ["user", "team", "plugins"],
          sandboxOptions: { enabled: true },
          enableAgentRetries: true,
        },
      });
      entry.agentId = entry.agent.agentId;
      entry.recordToAgentReadyMs = entry.recordStartedAt
        ? Math.max(0, Date.now() - entry.recordStartedAt)
        : null;
      const agentReadyDetail = {
        agentId: entry.agentId,
        model: modelLabel(model),
        preparationHit: entry.preparationHit,
        preparationAgeMs: entry.preparationAgeMs,
        recordToAgentReadyMs: entry.recordToAgentReadyMs,
      };
      entry.readyAt = Date.now();
      entry.state = "ready";
      emit("agent-staged", {
        ...agentReadyDetail,
        setupMs: entry.readyAt - entry.startedAt,
      });
      return entry;
    } catch (error) {
      entry.state = "error";
      entry.error = error;
      await closeAgent(entry);
      throw error;
    }
  }

  function execute({
    sessionId,
    pr,
    context = {},
    segments,
    autonomyLevel = DEFAULT_AUTONOMY_LEVEL,
    emit = () => {},
  }) {
    requireSessionId(sessionId);
    let entry = sessions.get(sessionId);
    if (!entry) {
      warm({ sessionId, pr, context, emit });
      entry = sessions.get(sessionId);
    }
    if (entry.result) return entry.result;
    if (entry.executionPromise) return entry.executionPromise;
    entry.executionPromise = executeEntry(entry, {
      pr,
      context,
      segments,
      autonomyLevel,
      emit,
    });
    entry.executionPromise.catch(() => {});
    return entry.executionPromise;
  }

  async function executeEntry(entry, { pr, context, segments, autonomyLevel, emit }) {
    const waitStartedAt = Date.now();
    let warmHeartbeat = null;
    if (entry.state !== "ready") {
      const reportWarmWait = () =>
        emit("agent-warm-waiting", {
          elapsedMs: Date.now() - waitStartedAt,
          warmElapsedMs: Date.now() - entry.startedAt,
          state: entry.state,
          preparationHit: entry.preparationHit,
        });
      reportWarmWait();
      warmHeartbeat = setInterval(reportWarmWait, warmHeartbeatMs);
      warmHeartbeat.unref?.();
    }
    try {
      await entry.promise;
    } finally {
      if (warmHeartbeat) clearInterval(warmHeartbeat);
    }
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
      const existingActions = actionStore?.listOpen
        ? await actionStore.listOpen(pr)
        : [];
      const previewEnvelope = authorizeActionPlan(
        { schemaVersion: 1, directives: [], actions: [], operations: [], findings: [] },
        autonomyLevel
      );
      const recorder = createActionPlanRecorder({
        sessionId: entry.sessionId,
        pr,
        segments,
        autonomyLevel,
        store: actionStore,
        emit,
      });
      const executionRun = await entry.agent.send(
        buildExecutionPrompt({
          pr,
          segments,
          context,
          branchHead: beforeHead,
          branchDrift: sync.changed ? { from: warmHead, to: sync.headSha } : null,
          existingActions,
          autonomyLevel,
          capabilities: previewEnvelope.envelope.capabilities,
        }),
        {
          mode: "agent",
          idempotencyKey: `voice-pr:${entry.sessionId}:execute`,
          local: { customTools: { record_action_plan: recorder.tool } },
        }
      );
      entry.runId = executionRun.id;
      emit("agent-running", { agentId: entry.agentId, runId: executionRun.id });
      const executionResult = await executionRun.wait();
      assertFinished(executionResult, "execution");

      const actionPlan = recorder.getPlan();
      if (!actionPlan)
        throw new Error(
          "Cursor agent finished without recording the required Action Plan; refusing publication"
        );
      const allows = (capability) =>
        actionPlan.actions.some((action) =>
          action.effects.some(
            (effect) =>
              effect.capability === capability && effect.authorization === "authorized"
          )
        );

      const dirty = (await runCommand("git", ["status", "--porcelain"], {
        cwd: entry.workspace,
      })).stdout.trim();
      if (dirty)
        throw new Error(
          `Cursor agent finished with uncommitted changes in ${entry.workspace}: ${dirty.split("\n")[0]}`
        );

      const afterHead = await gitHead(entry.workspace, runCommand);
      const commits = await commitsBetween(entry.workspace, beforeHead, afterHead, runCommand);
      if (afterHead !== beforeHead && !allows("create_commit"))
        throw new Error(
          "Agent created a commit outside the active Authorization Envelope"
        );
      let published = false;
      if (afterHead !== beforeHead) {
        await actionStore?.recordEffectReceipt?.({
          pr,
          sessionId: entry.sessionId,
          capability: "create_commit",
          receipt: { status: "complete", head: afterHead, commits: commits.length },
        });
        if (allows("push_current_pr")) {
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
          await actionStore?.recordEffectReceipt?.({
            pr,
            sessionId: entry.sessionId,
            capability: "push_current_pr",
            receipt: { status: "complete", head: afterHead, branch: pr.headRefName },
          });
          published = true;
        } else {
          emit("agent-push-blocked", {
            branch: pr.headRefName,
            commits: commits.length,
            reason: "push_current_pr requires a higher Autonomy Level",
          });
        }
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
        published,
        localWorkspaceRetained: commits.length > 0 && !published,
        actionPlan,
        actionSummary: actionPlan.summary,
        mayPostIntentTrail: allows("update_current_pr"),
        agentSummary: executionResult.result || "",
        metrics: {
          warmStartedAt: entry.startedAt,
          warmReadyAt: entry.readyAt,
          executionStartedAt: entry.executeStartedAt,
          patchReadyAt: entry.completedAt,
          warmMs: entry.readyAt - entry.startedAt,
          warmWaitMs,
          executionMs: entry.completedAt - entry.executeStartedAt,
          preparationHit: entry.preparationHit,
          preparationAgeMs: entry.preparationAgeMs,
          recordToAgentReadyMs: entry.recordToAgentReadyMs,
          staleHeadRefresh: sync.changed,
          inferenceTurnsBeforeStop: 0,
        },
      };
      emit("agent-finished", {
        commits: commits.length,
        published,
        actions: actionPlan.summary.totalActions,
        blockedEffects: actionPlan.summary.blockedEffects,
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
      const retainLocalWorkspace =
        entry.state === "done" && entry.result?.localWorkspaceRetained;
      if (!retainLocalWorkspace) await cleanupWorkspaceLocked(entry);
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

  function recordEffectReceipt(input) {
    return actionStore?.recordEffectReceipt?.(input) || Promise.resolve({ recorded: 0 });
  }

  function leasePreparation(pr, sessionId) {
    const key = preparationKey(pr);
    const entry = preparations.get(key);
    if (!entry || entry.leasedBy) return null;
    entry.leasedBy = sessionId;
    clearTimeout(entry.timer);
    entry.emit("workspace-prepare-leased", {
      key,
      sessionId,
      preparationAgeMs: entry.readyAt
        ? Math.max(0, Date.now() - entry.readyAt)
        : 0,
    });
    return entry;
  }

  async function shutdown() {
    await Promise.all(
      [...sessions.values()].map(async (entry) => {
        clearTimeout(entry.timer);
        await closeAgent(entry);
        await cleanupWorkspaceLocked(entry);
      })
    );
    await Promise.all(
      [...preparations.values()].map(async (entry) => {
        clearTimeout(entry.timer);
        await entry.promise.catch(() => {});
        await cleanupWorkspaceLocked(entry);
      })
    );
    sessions.clear();
    preparations.clear();
  }

  function scheduleExpiry(entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      if (entry.executing) return scheduleExpiry(entry);
      await closeAgent(entry);
      await cleanupWorkspaceLocked(entry);
      sessions.delete(entry.sessionId);
    }, ttlMs);
    entry.timer.unref?.();
  }

  function schedulePreparationExpiry(entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      if (entry.leasedBy) return;
      if (entry.state === "preparing") return schedulePreparationExpiry(entry);
      if (preparations.get(entry.key) !== entry) return;
      preparations.delete(entry.key);
      entry.emit("preparation-cache-invalidated", {
        key: entry.key,
        reason: "unused preparation TTL expired",
        ageMs: Date.now() - entry.startedAt,
        headSha: entry.headSha,
      });
      await cleanupWorkspaceLocked(entry);
      entry.emit("workspace-prepare-expired", {
        key: entry.key,
        unused: true,
      });
    }, prepareTtlMs);
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

  async function cleanupWorkspaceLocked(entry) {
    if (entry.workspace && entry.mirror)
      await withRepoLock(repoKey(entry.pr), () => cleanupWorkspace(entry));
    if (entry.preparationKey) {
      const prepared = preparations.get(entry.preparationKey);
      if (prepared?.leasedBy === entry.sessionId)
        preparations.delete(entry.preparationKey);
      entry.preparationKey = null;
    }
    entry.workspace = null;
    entry.mirror = null;
    entry.localBranch = null;
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

  return { preparePr, warm, execute, check, status, recordEffectReceipt, shutdown };
}

async function prepareWorkspace({
  sessionId,
  pr,
  workspaceRoot,
  cacheRoot,
  runCommand,
  emit = () => {},
}) {
  const repoName = safeName(`${pr.owner}--${pr.repo}`);
  const safeSession = safeName(sessionId);
  const mirror = join(cacheRoot, `${repoName}.git`);
  const workspace = join(workspaceRoot, safeSession);
  const localBranch = `voice-pr/${safeSession}`;
  await mkdir(dirname(mirror), { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });

  const targetRef = `refs/heads/${pr.headRefName}`;
  let targetHead = null;
  if (!(await exists(join(mirror, "HEAD")))) {
    emit("repo-cache-miss", {
      repo: repoKey(pr),
      mirror,
      reason: "no local mirror; cloning for the first time",
    });
    await runCommand("gh", [
      "repo",
      "clone",
      `${pr.owner}/${pr.repo}`,
      mirror,
      "--",
      "--mirror",
    ]);
    targetHead = (
      await runCommand("git", ["--git-dir", mirror, "rev-parse", targetRef])
    ).stdout.trim();
    emit("repo-cache-created", {
      repo: repoKey(pr),
      mirror,
      headSha: targetHead,
    });
  } else {
    const before = (
      await runCommand(
        "git",
        ["--git-dir", mirror, "rev-parse", targetRef],
        { allowFail: true }
      )
    ).stdout.trim();
    emit("repo-cache-hit", {
      repo: repoKey(pr),
      mirror,
      cachedHeadSha: before || null,
      action: "validating against origin",
    });
    await runCommand("git", ["--git-dir", mirror, "fetch", "--prune", "origin"]);
    targetHead = (
      await runCommand("git", ["--git-dir", mirror, "rev-parse", targetRef])
    ).stdout.trim();
    if (before === targetHead) {
      emit("repo-cache-current", {
        repo: repoKey(pr),
        mirror,
        headSha: targetHead,
        action: "remote validation found no changes",
      });
    } else {
      emit("repo-cache-updated", {
        repo: repoKey(pr),
        mirror,
        fromHeadSha: before || null,
        toHeadSha: targetHead,
      });
    }
  }

  if (await exists(join(workspace, ".git"))) {
    const status = await runCommand("git", ["status", "--porcelain"], {
      cwd: workspace,
      allowFail: true,
    });
    const head = await runCommand("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      allowFail: true,
    });
    const valid = status.code === 0 && head.code === 0;
    const dirty = valid ? status.stdout.trim() : "";
    const headSha = valid ? head.stdout.trim() : null;
    if (valid && !dirty && headSha === targetHead) {
      emit("workspace-cache-current", {
        path: workspace,
        headSha,
        action: "prepared worktree already matches PR head",
      });
      return { path: workspace, headSha, mirror, localBranch };
    }
    if (valid && !dirty) {
      const update = await runCommand(
        "git",
        ["merge", "--ff-only", targetHead],
        { cwd: workspace, allowFail: true }
      );
      if (update.code === 0) {
        emit("workspace-cache-updated", {
          path: workspace,
          fromHeadSha: headSha,
          toHeadSha: targetHead,
        });
        return { path: workspace, headSha: targetHead, mirror, localBranch };
      }
    }
    emit("workspace-cache-invalidated", {
      path: workspace,
      headSha,
      targetHeadSha: targetHead,
      reason: !valid
        ? "worktree metadata is stale or no longer registered"
        : dirty
        ? `worktree is dirty: ${dirty.split("\n")[0]}`
        : "worktree cannot fast-forward to the PR head",
    });
    await runCommand(
      "git",
      ["--git-dir", mirror, "worktree", "remove", "--force", workspace],
      { allowFail: true }
    );
    if (await exists(workspace))
      await rm(workspace, { recursive: true, force: true });
  }
  if (await exists(workspace)) {
    emit("workspace-cache-invalidated", {
      path: workspace,
      reason: "path exists without a registered git worktree",
    });
    await rm(workspace, { recursive: true, force: true });
  }

  emit("workspace-cache-miss", {
    path: workspace,
    reason: "no reusable prepared worktree",
    headSha: targetHead,
  });
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
    targetRef,
  ]);
  const headSha = await gitHead(workspace, runCommand);
  emit("workspace-cache-created", {
    path: workspace,
    headSha,
    localBranch,
  });
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

function publicPreparation(entry, cacheHit) {
  return {
    key: entry.key,
    state: entry.state,
    cacheHit,
    leased: !!entry.leasedBy,
    startedAt: entry.startedAt,
    readyAt: entry.readyAt,
    headSha: entry.headSha,
    preparationMs: entry.readyAt ? entry.readyAt - entry.startedAt : null,
    error: entry.error?.message || null,
  };
}

function assignWorkspace(entry, workspace) {
  entry.workspace = workspace.path || workspace.workspace;
  entry.mirror = workspace.mirror;
  entry.localBranch = workspace.localBranch;
  entry.headSha = workspace.headSha;
}

function requireSessionId(sessionId) {
  if (!String(sessionId || "").trim()) throw new Error("sessionId is required to warm an agent");
}

function prKey(pr) {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}

function preparationKey(pr) {
  return `${prKey(pr)}@${pr.headRefOid || "unknown"}`;
}

function preparationWorkspaceId(pr) {
  return `prepared-${safeName(`${pr.owner}-${pr.repo}-${pr.number}`)}-${String(
    pr.headRefOid || "unknown"
  ).slice(0, 12)}`;
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
