// Adapter: port a voice batch into the local containerized pogo orchestrator
// (mayor -> polecat -> refinery) instead of running `claude -p` directly.
//
// Transport is `docker exec` against the running orchestrator container. The
// voice batch becomes an `mg` work item whose --branch is the PR head, so the
// refinery fast-forward-merges the polecat's commits onto the PR branch. We
// then signal the mayor by mail (the idiomatic "dispatch-ready" ask) and track
// the item to a merge.
import { run } from "./exec.js";
import { readFile } from "node:fs/promises";

const CONTAINER = process.env.VOICE_PR_CONTAINER || "codingagent";
const WORKSPACE = process.env.VOICE_PR_WORKSPACE || "/home/pogo/workspace";
const POLL_MS = Number(process.env.VOICE_PR_POLL_MS || 10_000);
const DISPATCH_TIMEOUT_MS = Number(process.env.VOICE_PR_DISPATCH_MS || 12 * 60_000);
// The mayor's Claude OAuth token lives in a bind-mounted file on the host. When
// it expires the mayor 401s and silently stops dispatching — so the preflight
// reads its expiry directly (deterministic; unlike scanning PTY scrollback,
// which keeps stale 401 text even after a fix).
const CRED_PATH =
  process.env.VOICE_PR_ORCH_CRED || `${process.env.HOME}/.codingagent/secrets/claude-credentials.json`;

/** docker exec (array form — no shell, so newlines/quotes in args are safe). */
function dx(args, opts = {}) {
  return run("docker", ["exec", "-u", "pogo", CONTAINER, ...args], opts);
}
async function dxJson(args) {
  const { stdout } = await dx(args);
  return JSON.parse(stdout);
}

/**
 * Preflight: can the orchestrator actually accept AND complete a submission?
 * A reachable container isn't enough — a 401'd or stopped mayor accepts work
 * items but never dispatches them (the exact "stuck on registering repo" trap).
 * So we check three things: container reachable, mayor process alive, and the
 * mayor's Claude token not expired. Non-throwing.
 */
export async function checkOrchestrator() {
  try {
    await assertOrchestrator();
  } catch (e) {
    return { ok: false, detail: e.message.split("\n")[0] };
  }
  // Mayor process alive?
  try {
    const diag = await dx(["pogo", "agent", "diagnose", "mayor"], { allowFail: true });
    const alive = /Process alive:\s*true/i.test(diag.stdout) || /^Status:\s*running/im.test(diag.stdout);
    if (!alive)
      return { ok: false, detail: `mayor agent not running — start it (docker exec ${CONTAINER} pogo agent start mayor)` };
  } catch {
    /* diagnose unavailable — fall through to the token check */
  }
  // Mayor authenticated (token not expired)?
  const tok = await mayorTokenState();
  if (!tok.ok) return { ok: false, detail: tok.detail };
  return { ok: true, detail: `container "${CONTAINER}" up, mayor running${tok.note ? ` (${tok.note})` : ""}` };
}

/** Read the mounted mayor credential and judge its expiry. Missing file or no
 *  expiry (e.g. ANTHROPIC_API_KEY auth) is treated as fine — we can't assess it,
 *  so we don't block. */
async function mayorTokenState() {
  try {
    const j = JSON.parse(await readFile(CRED_PATH, "utf8"));
    const exp = (j.claudeAiOauth || j)?.expiresAt;
    if (!exp) return { ok: true, note: "auth ok" };
    const msLeft = exp - Date.now();
    if (msLeft <= 0)
      return { ok: false, detail: "mayor Claude token expired — refresh it and restart the mayor (see README 401 note)" };
    if (msLeft < 5 * 60_000)
      return { ok: false, detail: `mayor Claude token expires in ${Math.round(msLeft / 60_000)} min — refresh it before a long session` };
    return { ok: true, note: `token ~${Math.round(msLeft / 60_000)} min left` };
  } catch {
    return { ok: true }; // no readable token file → can't assess; don't block
  }
}

/** Fail fast with a clear message if the orchestrator isn't reachable. */
export async function assertOrchestrator() {
  try {
    await dx(["pogo", "status", "--json"]);
  } catch (e) {
    throw new Error(
      `orchestrator container "${CONTAINER}" not reachable (${e.message.split("\n")[0]}). ` +
        `Is it running?  docker ps | grep ${CONTAINER}`
    );
  }
}

/**
 * Ensure the PR's repo exists in the container workspace on the head branch and
 * is registered as a pogo project. Returns the container-local repo path.
 */
export async function ensureProject({ owner, repo }, headRef, emit) {
  const path = `${WORKSPACE}/${repo}`;
  const exists = await dx(["test", "-d", `${path}/.git`], { allowFail: true });
  if (exists.code !== 0) {
    emit("cloning", { branch: headRef });
    // Clone over HTTPS; the container's git credential store carries GH_TOKEN.
    await dx([
      "git",
      "clone",
      "--branch",
      headRef,
      `https://github.com/${owner}/${repo}.git`,
      path,
    ]);
  } else {
    // Refresh the head branch so the polecat branches off origin's latest.
    await dx(["git", "-C", path, "fetch", "origin", headRef], { allowFail: true });
    await dx(["git", "-C", path, "checkout", headRef], { allowFail: true });
    await dx(["git", "-C", path, "reset", "--hard", `origin/${headRef}`], {
      allowFail: true,
    });
  }
  await dx(["pogo", "project", "add", path], { allowFail: true });
  emit("project-ready", { path });
  return path;
}

/** Create the work item; returns its id. (mg emits text: "Created <id>: <title>") */
export async function fileWorkItem({ repoPath, headRef, pr, body, title }) {
  const { stdout } = await dx([
    "mg",
    "new",
    "--repo",
    repoPath,
    "--branch",
    headRef,
    "--title",
    title,
    "--body",
    body,
    "--assignee",
    "mayor",
    "--priority",
    "high",
    "--type",
    "task",
    "--tag",
    "source=voice-pr",
    "--tag",
    `pr=${pr.number}`,
  ]);
  const id = extractId(stdout);
  if (!id) throw new Error(`could not parse work item id from: ${stdout.slice(0, 300)}`);
  return id;
}

/**
 * Signal the mayor that a work item is ready to dispatch — by mail, not a PTY
 * nudge. pogo's convention (mayor prompt): "prefer mail for asks; reserve nudges
 * for system events." An external producer asking the mayor to dispatch its
 * ticket is an attributed ask, so it goes as the documented PM pattern —
 * `mg mail send mayor --subject="dispatch-ready: <id>"`. The mayor's coordination
 * loop picks up the available item on its next cycle (no PTY interrupt needed).
 */
export async function signalMayor({ id, pr, headRef, reason }) {
  const detail = [
    pr?.number != null ? `PR #${pr.number}` : null,
    headRef ? `branch ${headRef}` : null,
    "priority high",
  ]
    .filter(Boolean)
    .join(", ");
  const body = reason
    ? `voice-pr work item ${id} (${detail}): ${reason}`
    : `voice-pr filed ${id} (${detail}, assignee=mayor). Please dispatch a polecat for it.`;
  await dx(
    [
      "mg",
      "mail",
      "send",
      "mayor",
      "--from",
      "voice-pr",
      "--subject",
      `dispatch-ready: ${id}`,
      "--body",
      body,
    ],
    { allowFail: true }
  );
}

/**
 * Track the work item to a terminal state, emitting progress. Resolves with
 * { status, refinery } where status is done/failed/timeout.
 */
export async function trackWorkItem(id, repoPath, emit) {
  const started = Date.now();
  let lastStatus = null;
  let resignaled = false;

  for (;;) {
    if (Date.now() - started > DISPATCH_TIMEOUT_MS)
      return { status: "timeout", refinery: await refineryFor(id, repoPath) };

    const item = await showItem(id);
    const status = item?.status || "unknown";
    if (status !== lastStatus) {
      emit("work-status", { id, status });
      lastStatus = status;
    }

    // If the mayor hasn't picked it up halfway through, re-signal once more.
    if (
      status === "available" &&
      !resignaled &&
      Date.now() - started > DISPATCH_TIMEOUT_MS / 2
    ) {
      resignaled = true;
      await signalMayor({
        id,
        reason: "still available past half the dispatch window — please dispatch",
      });
      emit("re-signaled", { id });
    }

    const ref = await refineryFor(id, repoPath);
    if (ref) emit("refinery", { id, status: ref.status });

    if (status === "done" || ref?.status === "merged")
      return { status: "done", item, refinery: ref };
    if (ref?.status === "failed")
      return { status: "failed", item, refinery: ref };

    await sleep(POLL_MS);
  }
}

async function showItem(id) {
  const r = await dx(["mg", "show", id], { allowFail: true });
  if (r.code !== 0) return null;
  // Text output: key/value lines including "Status:    <state>".
  const m = r.stdout.match(/^Status:\s*(\S+)/m);
  return { id, status: m ? m[1] : "unknown", raw: r.stdout };
}

/** Find this work item's most recent refinery merge request, if any. */
async function refineryFor(id, repoPath) {
  const r = await dx(["pogo", "refinery", "history", "--json"], { allowFail: true });
  if (r.code !== 0) return null;
  let hist;
  try {
    hist = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  const list = Array.isArray(hist) ? hist : hist.history || hist.requests || [];
  // Match on the polecat branch naming convention (polecat-<id>) or author.
  const mine = list.filter(
    (m) =>
      (m.branch && m.branch.includes(id)) ||
      (m.author && m.author.includes(id)) ||
      (m.id && String(m.id).includes(id))
  );
  return mine.length ? mine[mine.length - 1] : null;
}

function extractId(stdout) {
  // mg prints: "Created ca-11f8: <title>"
  const m = stdout.match(/Created\s+([a-z]+-[0-9a-f]+)/i);
  return m ? m[1] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
