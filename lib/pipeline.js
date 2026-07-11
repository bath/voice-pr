// The voice-pr session pipeline: record-start pre-warm -> anchored speech ->
// interpretation + execution on one durable Cursor SDK agent.
import { run } from "./exec.js";
import { parsePr, viewPr, repoSlug, postIssueComment } from "./github.js";
import { agentRuntime } from "./agent.js";
import { branchDispatchQueue, branchQueueKey } from "./branch-queue.js";

const preparedSessions = new Map();

async function submitToAgent(
  pr,
  { sessionId, segments, context, runtime },
  emit
) {
  const queueKey = branchQueueKey(pr);
  return branchDispatchQueue.run(
    queueKey,
    () => submitToAgentUnlocked(pr, { sessionId, segments, context, runtime }, emit),
    {
      onQueued: ({ position }) =>
        emit("branch-queued", { branch: pr.headRefName, position }),
      onStarted: () => emit("agent-starting", { branch: pr.headRefName }),
    }
  );
}

async function submitToAgentUnlocked(
  pr,
  { sessionId, segments, context, runtime },
  emit
) {
  const outcome = await runtime.execute({
    sessionId,
    pr,
    context,
    segments,
    emit,
  });

  let trailComment =
    outcome.trailCommentUrl === undefined
      ? null
      : { url: outcome.trailCommentUrl };
  if (
    outcome.trailCommentUrl === undefined &&
    outcome.status === "done" &&
    outcome.commits?.length
  ) {
    try {
      const lines = outcome.commits
        .map((commit) => `- \`${commit.oid.slice(0, 8)}\` ${commit.messageHeadline}`)
        .join("\n");
      emit("commenting", { count: outcome.commits.length });
      trailComment = await postIssueComment(
        pr,
        `🎙️ Addressed your spoken feedback with a pre-warmed coding agent on ` +
          `\`${pr.headRefName}\`:\n\n${lines}\n\n` +
          `_Ambiguous requests were left unchanged rather than guessed._`
      );
      outcome.trailCommentUrl = trailComment?.url || null;
    } catch (e) {
      emit("agent-log", { line: `intent-trail comment skipped: ${e.message}` });
      outcome.trailCommentUrl = null;
    }
  } else if (outcome.trailCommentUrl === undefined) {
    outcome.trailCommentUrl = null;
  }

  const result = {
    ...outcome,
    pr: { number: pr.number, url: pr.url, title: pr.title, branch: pr.headRefName },
    trailCommentUrl: trailComment?.url || null,
    summary: outcome.commits?.length
      ? `Pushed ${outcome.commits.length} voice-driven commit${outcome.commits.length === 1 ? "" : "s"} to ${pr.headRefName}.`
      : "The agent completed the review without making a confident code change.",
  };
  return result;
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
export async function getContext(prRef) {
  const pr = await resolvePr(prRef);
  const context = await contextFor(pr);
  return {
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

/**
 * Record-start entry point. Resolve the PR and start the expensive workspace +
 * agent analysis in the background while the user is still speaking.
 */
export async function warmSession(
  { sessionId, prRef, runtime = agentRuntime },
  emit = () => {}
) {
  const pr = await resolveOpenPr(prRef);
  const context = await contextFor(pr);
  preparedSessions.set(sessionId, { prRef, pr, context });
  const warm = runtime.warm({ sessionId, pr, context, emit });
  return {
    warm,
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

/**
 * Recording-end entry point. The comments are interpreted and executed by the
 * same agent that was warmed at record start.
 * @param {{sessionId:string, prRef:string, segments:Array<{text,file,line}>, runtime?:object}} input
 * @param {(stage:string, detail?:object)=>void} emit  progress callback
 */
export async function runSession(
  { sessionId, prRef, segments, runtime = agentRuntime },
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

  return submitToAgent(pr, { sessionId, segments, context, runtime }, emit);
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

function samePr(a, b) {
  return (
    a?.owner === b?.owner &&
    a?.repo === b?.repo &&
    Number(a?.number) === Number(b?.number)
  );
}
