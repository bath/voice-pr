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
    "number,title,body,url,headRefName,headRefOid,baseRefName,headRepositoryOwner,state,isCrossRepository",
  ]);
}

/**
 * Commits currently on the PR head branch, newest last. Each carries oid,
 * messageHeadline, and committedDate/authoredDate — the timestamps let callers
 * tell commits that landed during this session from ones already on the branch.
 */
export async function listPrCommits({ owner, repo, number }) {
  const data = await ghJson([
    "pr",
    "view",
    String(number),
    "--repo",
    repoSlug({ owner, repo }),
    "--json",
    "commits",
  ]);
  return data.commits || [];
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
