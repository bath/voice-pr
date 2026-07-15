// The voice-pr pipeline: page-load deterministic preparation -> record-start
// agent warm -> anchored speech -> interpretation + execution.
import { run } from "./exec.js";
import { parsePr, viewPr, repoSlug, postIssueComment } from "./github.js";
import { agentRuntime } from "./agent.js";
import { branchDispatchQueue, branchQueueKey } from "./branch-queue.js";

const preparedSessions = new Map();
const contextCache = new Map();
const CONTEXT_TTL_MS = Number(process.env.VOICE_PR_CONTEXT_TTL_MS || 2 * 60_000);
const CONTEXT_CACHE_MAX = Number(process.env.VOICE_PR_CONTEXT_CACHE_MAX || 50);
const PREPARED_SESSION_TTL_MS = Number(
  process.env.VOICE_PR_AGENT_TTL_MS || 30 * 60_000
);

async function submitToAgent(
  pr,
  { sessionId, segments, context, autonomyLevel, runtime },
  emit
) {
  const queueKey = branchQueueKey(pr);
  return branchDispatchQueue.run(
    queueKey,
    () =>
      submitToAgentUnlocked(
        pr,
        { sessionId, segments, context, autonomyLevel, runtime },
        emit
      ),
    {
      onQueued: ({ position }) =>
        emit("branch-queued", { branch: pr.headRefName, position }),
      onStarted: () => emit("agent-starting", { branch: pr.headRefName }),
    }
  );
}

async function submitToAgentUnlocked(
  pr,
  { sessionId, segments, context, autonomyLevel, runtime },
  emit
) {
  const outcome = await runtime.execute({
    sessionId,
    pr,
    context,
    segments,
    autonomyLevel,
    emit,
  });

  let trailCommentPending = false;
  if (
    outcome.trailCommentUrl === undefined &&
    outcome.status === "done" &&
    outcome.commits?.length &&
    outcome.published !== false &&
    outcome.mayPostIntentTrail !== false
  ) {
    trailCommentPending = true;
    outcome.trailCommentUrl = null;
    scheduleTrailComment({
      pr,
      commits: outcome.commits,
      emit,
      runtime,
      sessionId,
    });
  } else if (outcome.trailCommentUrl === undefined) {
    outcome.trailCommentUrl = null;
  }

  const result = {
    ...outcome,
    pr: { number: pr.number, url: pr.url, title: pr.title, branch: pr.headRefName },
    trailCommentUrl: outcome.trailCommentUrl ?? null,
    trailCommentPending,
    summary: outcome.commits?.length
      ? outcome.published === false
        ? `Prepared ${outcome.commits.length} voice-driven commit${outcome.commits.length === 1 ? "" : "s"} locally; publication needs permission.`
        : `Pushed ${outcome.commits.length} voice-driven commit${outcome.commits.length === 1 ? "" : "s"} to ${pr.headRefName}.`
      : "The agent completed the review without making a confident code change.",
  };
  return result;
}

function scheduleTrailComment({ pr, commits, emit, runtime, sessionId }) {
  const lines = commits
    .map((commit) => `- \`${commit.oid.slice(0, 8)}\` ${commit.messageHeadline}`)
    .join("\n");
  const body =
    `🎙️ Addressed your spoken feedback with a pre-warmed coding agent on ` +
    `\`${pr.headRefName}\`:\n\n${lines}\n\n` +
    `_Ambiguous requests were left unchanged rather than guessed._`;
  emit("comment-queued", { count: commits.length });
  void postIssueComment(pr, body)
    .then((trailComment) => {
      if (trailComment?.url) {
        emit("comment-posted", { url: trailComment.url, count: commits.length });
        void runtime?.recordEffectReceipt?.({
          pr,
          sessionId,
          capability: "update_current_pr",
          receipt: { status: "complete", url: trailComment.url },
        });
        return;
      }
      emit("agent-log", {
        line: `intent-trail comment failed: ${trailComment?.error || "unknown error"}`,
      });
    })
    .catch((error) => {
      emit("agent-log", { line: `intent-trail comment skipped: ${error.message}` });
    });
}

/** Parse + load + validate a PR reference into a working pr object. */
export async function resolvePr(prRef) {
  const pr = parsePr(prRef);
  const meta = await viewPr(pr);
  pr.headRefName = meta.headRefName;
  pr.baseRefName = meta.baseRefName;
  pr.title = meta.title;
  pr.url = meta.url;
  pr.state = meta.state;
  pr.isCrossRepository = meta.isCrossRepository;
  pr.headRefOid = meta.headRefOid;
  pr.body = meta.body || "";
  return pr;
}

function detectJiraKey(pr) {
  const m = `${pr.headRefName} ${pr.title}`.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
  return m ? m[1] : null;
}

async function checksSummary(pr) {
  try {
    const r = await run("gh", ["pr", "checks", String(pr.number), "--repo", repoSlug(pr)], {
      allowFail: true,
    });
    const rows = r.stdout.trim().split("\n").filter(Boolean);
    if (!rows.length) return null;
    const fail = rows.filter((l) => /\bfail/i.test(l)).length;
    return `${rows.length} checks, ${fail} failing`;
  } catch {
    return null;
  }
}

/**
 * Lightweight context for the extension to show the moment recording starts:
 * which PR, detected Jira key, checks status.
 */
export async function getContext(prRef, emit = () => {}) {
  const loaded = await loadPrContext(prRef, emit);
  return contextResponse(loaded.pr, loaded.context, {
    contextCacheHit: loaded.cacheHit,
  });
}

/**
 * Passive page-load entry point. It resolves and caches PR context, then
 * completes deterministic clone/fetch/worktree preparation without creating a
 * Cursor agent or running inference.
 */
export async function preparePr(
  { prRef, runtime = agentRuntime },
  emit = () => {}
) {
  const startedAt = Date.now();
  const loaded = await loadPrContext(prRef, emit);
  const preparation = await runtime.preparePr({ pr: loaded.pr, emit });
  const preparedAt = Date.now();
  return contextResponse(loaded.pr, loaded.context, {
    contextCacheHit: loaded.cacheHit,
    preparation,
    metrics: {
      prepareStartedAt: startedAt,
      preparedAt,
      preparationMs: preparedAt - startedAt,
    },
  });
}

/**
 * Record-start entry point. Resolve the PR and start the expensive workspace +
 * agent analysis in the background while the user is still speaking.
 */
export async function warmSession(
  {
    sessionId,
    prRef,
    recordStartedAt = null,
    runtime = agentRuntime,
  },
  emit = () => {}
) {
  const loaded = await loadPrContext(prRef, emit);
  rememberPreparedSession(sessionId, {
    prRef,
    pr: loaded.pr,
    context: loaded.context,
  });
  const warm = runtime.warm({
    sessionId,
    pr: loaded.pr,
    context: loaded.context,
    recordStartedAt,
    emit,
  });
  return contextResponse(loaded.pr, loaded.context, {
    warm,
    contextCacheHit: loaded.cacheHit,
  });
}

/**
 * Recording-end entry point. The comments are interpreted and executed by the
 * same agent that was warmed at record start.
 * @param {{sessionId:string, prRef:string, segments:Array<{text,file,line}>, runtime?:object}} input
 * @param {(stage:string, detail?:object)=>void} emit  progress callback
 */
export async function runSession(
  {
    sessionId,
    prRef,
    segments,
    autonomyLevel = "current_pr",
    runtime = agentRuntime,
  },
  emit = () => {}
) {
  if (!Array.isArray(segments) || !segments.length)
    throw new Error("no spoken comments were captured in this session");
  const prepared = preparedSessions.get(sessionId);
  const canReuse = prepared && samePr(prepared.pr, parsePr(prRef));
  const pr = canReuse ? prepared.pr : await resolveOpenPr(prRef);
  emit("pr-loaded", { title: pr.title, branch: pr.headRefName, url: pr.url });

  const context = canReuse ? prepared.context : await contextFor(pr);
  emit("context", { ...context, segments: segments.length });

  try {
    const result = await submitToAgent(
      pr,
      { sessionId, segments, context, autonomyLevel, runtime },
      emit
    );
    if (result.commits?.length && result.published !== false) {
      contextCache.delete(prIdentity(pr));
      emit("context-cache-invalidated", {
        key: prIdentity(pr),
        reason: "PR branch updated by voice-pr",
        headSha: result.commits.at(-1)?.oid || null,
      });
    }
    return result;
  } finally {
    forgetPreparedSession(sessionId);
  }
}

async function resolveOpenPr(prRef) {
  const pr = await resolvePr(prRef);
  if (pr.state !== "OPEN")
    throw new Error(`PR #${pr.number} is ${pr.state}, not open`);
  if (pr.isCrossRepository)
    throw new Error("cross-repository (fork) PRs aren't supported in this MVP");
  return pr;
}

async function contextFor(pr) {
  return {
    jiraKey: detectJiraKey(pr),
    checksSummary: await checksSummary(pr),
    prBody: pr.body || "",
  };
}

async function loadPrContext(prRef, emit = () => {}) {
  const parsed = parsePr(prRef);
  const key = prIdentity(parsed);
  const cached = contextCache.get(key);
  if (cached && Date.now() - cached.cachedAt < CONTEXT_TTL_MS) {
    emit("context-cache-hit", {
      key,
      ageMs: Date.now() - cached.cachedAt,
      ttlMs: CONTEXT_TTL_MS,
      headSha: cached.pr.headRefOid,
    });
    return { pr: cached.pr, context: cached.context, cacheHit: true };
  }
  if (cached) {
    contextCache.delete(key);
    emit("context-cache-invalidated", {
      key,
      reason: "TTL expired",
      ageMs: Date.now() - cached.cachedAt,
      ttlMs: CONTEXT_TTL_MS,
      headSha: cached.pr.headRefOid,
    });
  } else {
    emit("context-cache-miss", { key, reason: "no cached PR context" });
  }
  const pr = await resolveOpenPr(prRef);
  const context = await contextFor(pr);
  contextCache.set(key, { pr, context, cachedAt: Date.now() });
  emit("context-cache-stored", {
    key,
    headSha: pr.headRefOid,
    ttlMs: CONTEXT_TTL_MS,
  });
  while (contextCache.size > CONTEXT_CACHE_MAX) {
    contextCache.delete(contextCache.keys().next().value);
  }
  return { pr, context, cacheHit: false };
}

function contextResponse(pr, context, extra = {}) {
  return {
    ...extra,
    pr: {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      branch: pr.headRefName,
      headSha: pr.headRefOid,
    },
    ...context,
  };
}

function rememberPreparedSession(sessionId, value) {
  forgetPreparedSession(sessionId);
  const timer = setTimeout(
    () => preparedSessions.delete(sessionId),
    PREPARED_SESSION_TTL_MS
  );
  timer.unref?.();
  preparedSessions.set(sessionId, { ...value, timer });
}

function forgetPreparedSession(sessionId) {
  const prepared = preparedSessions.get(sessionId);
  if (prepared?.timer) clearTimeout(prepared.timer);
  preparedSessions.delete(sessionId);
}

function prIdentity(pr) {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}

function samePr(a, b) {
  return (
    a?.owner === b?.owner &&
    a?.repo === b?.repo &&
    Number(a?.number) === Number(b?.number)
  );
}
