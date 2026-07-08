// The voice-pr session pipeline: spoken segments -> orchestrator work item.
import { run } from "./exec.js";
import { parsePr, viewPr, repoSlug, postIssueComment, listPrCommits } from "./github.js";
import { buildSessionBody } from "./prompt.js";
import {
  assertOrchestrator,
  assertMayorAuth,
  ensureProject,
  fileWorkItem,
  signalMayor,
  trackWorkItem,
} from "./orchestrator.js";
import { branchDispatchQueue, branchQueueKey } from "./branch-queue.js";

/**
 * Shared orchestrator submit: file the work item, signal the mayor by mail,
 * track it to a merge, then post the intent trail host-side (pogod reaps the
 * polecat at merge, so post-merge work can't run in the polecat itself).
 */
async function submitToOrchestrator(pr, { title, body }, emit) {
  const queueKey = branchQueueKey(pr);
  return branchDispatchQueue.run(
    queueKey,
    () => submitToOrchestratorUnlocked(pr, { title, body }, emit),
    {
      onQueued: ({ position }) =>
        emit("branch-queued", { branch: pr.headRefName, position }),
      onStarted: () => emit("branch-dispatch-start", { branch: pr.headRefName }),
    }
  );
}

async function submitToOrchestratorUnlocked(pr, { title, body }, emit) {
  await assertOrchestrator();
  // Gate on Claude auth BEFORE filing a work item: an expired mayor token
  // otherwise accepts the item then silently never dispatches it (issue #10).
  await assertMayorAuth();
  // Captured before the polecat can possibly commit: any commit newer than this
  // landed during this session and is ground-truth "the work landed".
  const dispatchStartedAt = Date.now();
  const repoPath = await ensureProject(pr, pr.headRefName, emit);

  const id = await fileWorkItem({ repoPath, headRef: pr.headRefName, pr, body, title });
  emit("work-filed", { id, title });

  emit("dispatching", { id });
  await signalMayor({ id, pr, headRef: pr.headRefName });

  const outcome = await trackWorkItem(id, repoPath, emit, {
    // Poll the PR head for commits that landed since dispatch — the signal the
    // user is actually watching. Failures are swallowed to a no-op so a flaky
    // `gh` never breaks tracking; the mg/refinery poll still runs.
    commitsLanded: async () => {
      try {
        return (await listPrCommits(pr)).filter((c) => committedAfter(c, dispatchStartedAt));
      } catch {
        return [];
      }
    },
  });

  let trailComment = null;
  if (outcome.status === "done") {
    try {
      // Prefer commits explicitly tagged with the work-item id; otherwise fall
      // back to the commits that landed during this session (associate by commit
      // time, not a strict `(id)` headline substring) so a real merge whose
      // headline doesn't carry the id still gets a trail comment.
      const commits = outcome.commits?.length ? outcome.commits : await listPrCommits(pr);
      const tagged = commits.filter((c) => (c.messageHeadline || "").includes(`(${id})`));
      const session = commits.filter((c) => committedAfter(c, dispatchStartedAt));
      const mine = tagged.length ? tagged : session;
      if (mine.length) {
        const lines = mine
          .map((c) => `- \`${c.oid.slice(0, 8)}\` ${c.messageHeadline}`)
          .join("\n");
        emit("commenting", { count: mine.length });
        trailComment = await postIssueComment(
          pr,
          `🎙️ Addressed your spoken feedback via the orchestrator (work item \`${id}\`), ` +
            `merged onto \`${pr.headRefName}\`:\n\n${lines}\n\n` +
            `_Anything I couldn't act on confidently isn't in this list — re-record with more detail and I'll take another pass._`
        );
      }
    } catch (e) {
      emit("agent-log", { line: `intent-trail comment skipped: ${e.message}` });
    }
  }

  const result = {
    backend: "orchestrator",
    workItemId: id,
    pr: { number: pr.number, url: pr.url, title: pr.title, branch: pr.headRefName },
    status: outcome.status, // done | failed | timeout
    refinery: outcome.refinery
      ? { status: outcome.refinery.status, branch: outcome.refinery.branch }
      : null,
    trailCommentUrl: trailComment?.url || null,
    summary:
      outcome.status === "done"
        ? `Merged your voice feedback onto ${pr.headRefName} via the orchestrator (work item ${id}).`
        : outcome.status === "failed"
          ? `The polecat's branch failed the refinery's quality gates (work item ${id}). See the PR / refinery history.`
          : `Work item ${id} is filed and dispatched but hadn't merged before the tracking window closed — it may still land. Check \`pogo status\`.`,
  };
  emit("done", result);
  return result;
}

/** True if a commit's timestamp is strictly after `sinceMs` (ms epoch). */
function committedAfter(commit, sinceMs) {
  const t = Date.parse(commit?.committedDate || commit?.authoredDate || "");
  return Number.isFinite(t) && t > sinceMs;
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
  return {
    pr: { number: pr.number, title: pr.title, url: pr.url, branch: pr.headRefName },
    jiraKey: detectJiraKey(pr),
    checksSummary: await checksSummary(pr),
  };
}

/**
 * Chrome-extension entry point: a live voice review session. Segments are the
 * spoken chunks, each anchored to the file+line the author was viewing. Always
 * routes through the orchestrator.
 * @param {{prRef:string, segments:Array<{text,file,line}>}} input
 * @param {(stage:string, detail?:object)=>void} emit  progress callback
 */
export async function runSession({ prRef, segments }, emit = () => {}) {
  if (!Array.isArray(segments) || !segments.length)
    throw new Error("no spoken comments were captured in this session");
  const pr = await resolvePr(prRef);
  if (pr.state !== "OPEN")
    throw new Error(`PR #${pr.number} is ${pr.state}, not open`);
  if (pr.isCrossRepository)
    throw new Error("cross-repository (fork) PRs aren't supported in this MVP");
  emit("pr-loaded", { title: pr.title, branch: pr.headRefName, url: pr.url });

  const jiraKey = detectJiraKey(pr);
  const checks = await checksSummary(pr);
  emit("context", { jiraKey, checksSummary: checks, segments: segments.length });

  const body = buildSessionBody({ pr, segments, context: { jiraKey, checksSummary: checks } });
  const title =
    `voice-pr: live review session on PR #${pr.number}` +
    (jiraKey ? ` (${jiraKey})` : "");
  return submitToOrchestrator(pr, { title, body }, emit);
}
