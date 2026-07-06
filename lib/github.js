// GitHub operations via the authenticated `gh` CLI.
import { run, ghJson } from "./exec.js";

/**
 * Parse any of:
 *   https://github.com/owner/repo/pull/123
 *   github.com/owner/repo/pull/123
 *   owner/repo#123
 *   owner/repo/123
 * -> { owner, repo, number }
 */
export function parsePr(input) {
  if (!input) throw new Error("no PR reference provided");
  const s = input.trim();

  let m = s.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (m) return { owner: m[1], repo: m[2], number: Number(m[3]) };

  m = s.match(/^([^/\s]+)\/([^/#\s]+)[#/](\d+)$/);
  if (m) return { owner: m[1], repo: m[2], number: Number(m[3]) };

  throw new Error(
    `could not parse PR reference: "${input}" (try https://github.com/owner/repo/pull/N or owner/repo#N)`
  );
}

export const repoSlug = ({ owner, repo }) => `${owner}/${repo}`;

/** PR metadata needed to check out the head branch. */
export async function viewPr({ owner, repo, number }) {
  return ghJson([
    "pr",
    "view",
    String(number),
    "--repo",
    repoSlug({ owner, repo }),
    "--json",
    "number,title,url,headRefName,headRefOid,baseRefName,headRepositoryOwner,state,isCrossRepository",
  ]);
}

/** Unified diff of the PR (context for the agent). */
export async function prDiff({ owner, repo, number }) {
  const { stdout } = await run("gh", [
    "pr",
    "diff",
    String(number),
    "--repo",
    repoSlug({ owner, repo }),
  ]);
  return stdout;
}

/** List of files touched by the PR. */
export async function prFiles({ owner, repo, number }) {
  const data = await ghJson([
    "pr",
    "view",
    String(number),
    "--repo",
    repoSlug({ owner, repo }),
    "--json",
    "files",
  ]);
  return (data.files || []).map((f) => f.path);
}

/**
 * Post an inline review comment anchored to path:line of a specific commit.
 * Falls back to a plain issue comment if the line isn't part of the PR diff
 * (GitHub rejects review comments off the diff hunk).
 */
export async function postAnchoredComment(pr, { body, commit_id, path, line }) {
  const slug = repoSlug(pr);
  try {
    const res = await run(
      "gh",
      [
        "api",
        "--method",
        "POST",
        `repos/${slug}/pulls/${pr.number}/comments`,
        "-f",
        `body=${body}`,
        "-f",
        `commit_id=${commit_id}`,
        "-f",
        `path=${path}`,
        "-F",
        `line=${line}`,
        "-f",
        "side=RIGHT",
      ],
      { allowFail: true }
    );
    if (res.code === 0) {
      const url = safeJson(res.stdout)?.html_url;
      return { ok: true, kind: "inline", url };
    }
    // fall through to issue comment
    const fallback = await postIssueComment(
      pr,
      `**\`${path}:${line}\`** — ${body}\n\n_(anchored comment fell back to a PR comment: ${firstLine(
        res.stderr
      )})_`
    );
    return { ...fallback, kind: "inline-fallback" };
  } catch (e) {
    const fallback = await postIssueComment(
      pr,
      `**\`${path}:${line}\`** — ${body}`
    );
    return { ...fallback, kind: "inline-fallback", error: String(e) };
  }
}

/** Plain PR-level (issue) comment. */
export async function postIssueComment(pr, body) {
  const res = await run(
    "gh",
    [
      "api",
      "--method",
      "POST",
      `repos/${repoSlug(pr)}/issues/${pr.number}/comments`,
      "-f",
      `body=${body}`,
    ],
    { allowFail: true }
  );
  if (res.code === 0)
    return { ok: true, kind: "issue", url: safeJson(res.stdout)?.html_url };
  return { ok: false, kind: "issue", error: res.stderr };
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
const firstLine = (s) => (s || "").split("\n")[0].slice(0, 200);
