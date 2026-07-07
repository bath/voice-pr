// The voice-pr batch pipeline: transcript -> commits + anchored comments.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, ghJson } from "./exec.js";
import {
  parsePr,
  viewPr,
  prDiff,
  repoSlug,
  postAnchoredComment,
  postIssueComment,
} from "./github.js";
import {
  buildPrompt,
  buildOrchestratorBody,
  buildSessionBody,
} from "./prompt.js";
import {
  assertOrchestrator,
  ensureProject,
  fileWorkItem,
  signalMayor,
  trackWorkItem,
} from "./orchestrator.js";

const MODEL = process.env.VOICE_PR_MODEL || "claude-sonnet-5";
const AGENT_TIMEOUT_MS = Number(process.env.VOICE_PR_TIMEOUT_MS || 6 * 60_000);
// "direct": run `claude -p` here. "orchestrator": file work into the pogo loop.
const BACKEND = process.env.VOICE_PR_BACKEND || "direct";

/**
 * Run one voice batch end-to-end.
 * @param {{prRef:string, transcript:string}} input
 * @param {(stage:string, detail?:object)=>void} emit  progress callback
 */
export async function runBatch({ prRef, transcript }, emit = () => {}) {
  if (!transcript || !transcript.trim())
    throw new Error("empty transcript — nothing was said");

  const pr = parsePr(prRef);
  emit("parsed", { pr });

  const meta = await viewPr(pr);
  pr.headRefName = meta.headRefName;
  pr.baseRefName = meta.baseRefName;
  pr.title = meta.title;
  pr.url = meta.url;
  if (meta.state !== "OPEN")
    throw new Error(`PR #${pr.number} is ${meta.state}, not open`);
  if (meta.isCrossRepository)
    throw new Error(
      "cross-repository (fork) PRs aren't supported in this MVP — the head branch must live in the base repo"
    );
  emit("pr-loaded", { title: meta.title, branch: meta.headRefName, url: meta.url });

  if (BACKEND === "orchestrator") return runViaOrchestrator(pr, transcript, emit);

  const diff = await prDiff(pr);

  // --- isolated checkout of the head branch (co-author model) ---------------
  const workRoot = await mkdtemp(join(tmpdir(), "voice-pr-"));
  const checkout = join(workRoot, pr.repo);
  const manifestPath = join(workRoot, "manifest.json");
  emit("cloning", { branch: pr.headRefName });
  await run("gh", [
    "repo",
    "clone",
    repoSlug(pr),
    checkout,
    "--",
    "--branch",
    pr.headRefName,
    "--depth",
    "50",
  ]);
  // Deterministic commit identity for the agent's commits.
  await run("git", ["config", "user.name", "voice-pr agent"], { cwd: checkout });
  await run("git", ["config", "user.email", "voice-pr@localhost"], {
    cwd: checkout,
  });

  // --- run the agent --------------------------------------------------------
  emit("agent-start", { model: MODEL });
  const prompt =
    buildPrompt({ pr, transcript, manifestPath }) +
    `\n\n=== PR DIFF (for locating the code the author is describing) ===\n${diff}`;

  const agent = await runWithTimeout(
    run(
      "claude",
      [
        "-p",
        prompt,
        "--model",
        MODEL,
        "--dangerously-skip-permissions",
        "--output-format",
        "json",
      ],
      {
        cwd: checkout,
        onStderr: (line) => emit("agent-log", { line: line.trim() }),
        allowFail: true,
      }
    ),
    AGENT_TIMEOUT_MS
  );
  emit("agent-done", { exit: agent.code });

  // --- read the manifest the agent wrote ------------------------------------
  const manifest = await readManifest(manifestPath, agent);
  const committed = manifest.items.filter((i) => i.status === "committed");
  const unclear = manifest.items.filter((i) => i.status !== "committed");
  emit("manifest", {
    summary: manifest.summary,
    committed: committed.length,
    unclear: unclear.length,
  });

  // --- push the agent's commits ---------------------------------------------
  let pushed = false;
  if (committed.length) {
    emit("pushing", { branch: pr.headRefName });
    await run("git", ["push", "origin", pr.headRefName], { cwd: checkout });
    pushed = true;
  }

  // --- post anchored intent-trail comments ----------------------------------
  const results = [];
  for (const item of committed) {
    if (!item.file || !item.line || !item.commitSha) {
      results.push({ item, comment: { ok: false, error: "incomplete anchor" } });
      continue;
    }
    emit("commenting", { file: item.file, line: item.line, title: item.title });
    const body =
      `🎙️ **${item.title}** — ${item.rationale || "author-requested via voice"}\n\n` +
      `_Requested by voice; implemented in ${short(item.commitSha)}._`;
    const comment = await postAnchoredComment(pr, {
      body,
      commit_id: item.commitSha,
      path: item.file,
      line: item.line,
    });
    results.push({ item, comment });
  }

  // --- one aggregated clarification comment for the unclear items -----------
  let clarification = null;
  if (unclear.length) {
    emit("clarifying", { count: unclear.length });
    const lines = unclear
      .map(
        (i) =>
          `- **${i.title}** — ${i.clarification || "your direction wasn't clear enough to act on confidently."}`
      )
      .join("\n");
    clarification = await postIssueComment(
      pr,
      `🎙️ I processed your voice feedback and handled ${committed.length} item(s). ` +
        `These I couldn't act on confidently — your direction wasn't clear enough, so I left them for you:\n\n${lines}\n\n` +
        `_Re-record with a bit more detail and I'll take another pass._`
    );
  }

  // best-effort cleanup of the isolated checkout
  rm(workRoot, { recursive: true, force: true }).catch(() => {});

  const result = {
    pr: { number: pr.number, url: pr.url, title: pr.title, branch: pr.headRefName },
    summary: manifest.summary,
    pushed,
    committed: results.map(({ item, comment }) => ({
      title: item.title,
      file: item.file,
      line: item.line,
      commit: item.commitSha,
      rationale: item.rationale,
      commentUrl: comment.url || null,
      commentKind: comment.kind,
    })),
    needsClarification: unclear.map((i) => ({
      title: i.title,
      clarification: i.clarification,
    })),
    clarificationCommentUrl: clarification?.url || null,
  };
  emit("done", result);
  return result;
}

/**
 * Shared orchestrator submit: file the work item, signal the mayor by mail,
 * track it to a merge, then post the intent trail host-side (pogod reaps the
 * polecat at merge, so post-merge work can't run in the polecat itself).
 */
async function submitToOrchestrator(pr, { title, body }, emit) {
  await assertOrchestrator();
  const repoPath = await ensureProject(pr, pr.headRefName, emit);

  const id = await fileWorkItem({ repoPath, headRef: pr.headRefName, pr, body, title });
  emit("work-filed", { id, title });

  emit("dispatching", { id });
  await signalMayor({ id, pr, headRef: pr.headRefName });

  const outcome = await trackWorkItem(id, repoPath, emit);

  let trailComment = null;
  if (outcome.status === "done") {
    try {
      const data = await ghJson([
        "pr", "view", String(pr.number), "--repo", repoSlug(pr), "--json", "commits",
      ]);
      const mine = (data.commits || []).filter((c) =>
        (c.messageHeadline || "").includes(`(${id})`)
      );
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

/** Orchestrator backend for a plain transcript batch (localhost UI path). */
async function runViaOrchestrator(pr, transcript, emit) {
  const body = buildOrchestratorBody({ pr, transcript });
  const title = `voice-pr: address spoken feedback on PR #${pr.number}`;
  return submitToOrchestrator(pr, { title, body }, emit);
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

async function readManifest(manifestPath, agent) {
  try {
    const raw = await readFile(manifestPath, "utf8");
    const m = JSON.parse(raw);
    if (!Array.isArray(m.items)) throw new Error("manifest.items not an array");
    return m;
  } catch (e) {
    // The agent finished but produced no usable manifest. Surface its own
    // final text so the failure is legible instead of silent.
    const tail = agentText(agent);
    throw new Error(
      `agent produced no valid manifest (${e.message}). Agent exit=${agent.code}. ` +
        `Last output:\n${tail.slice(-800)}`
    );
  }
}

function agentText(agent) {
  try {
    const j = JSON.parse(agent.stdout);
    return j.result || j.text || agent.stdout;
  } catch {
    return agent.stdout || agent.stderr || "";
  }
}

function runWithTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`agent timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

const short = (sha) => (sha || "").slice(0, 8);
