// The harness has two turns on one durable Cursor SDK agent. The first turn does
// all expensive orientation while the user is recording. The second turn
// interprets the fuzzy speech and immediately executes against that hot context.

export function buildWarmPrompt({ pr, context = {} }) {
  const jira = context.jiraKey
    ? `The likely Jira ticket is ${context.jiraKey}. If an Atlassian tool is already available, read it now.`
    : "No Jira key was detected.";
  const checks = context.checksSummary
    ? `Current CI summary: ${context.checksSummary}.`
    : "No CI summary is available.";

  return `Pre-warm for an incoming voice review of ${pr.owner}/${pr.repo} PR #${pr.number},
"${pr.title}", on head branch \`${pr.headRefName}\`.

Do the expensive orientation now, before the spoken feedback arrives:
1. Inspect the current branch, repository guidance, and project structure.
2. Run \`gh pr view ${pr.number} --repo ${pr.owner}/${pr.repo} --comments\` and inspect the PR diff.
3. Read the files, tests, and conventions most relevant to this PR.
4. ${jira}
5. ${checks}

Do not edit files, commit, push, or ask the user anything in this turn. Build a
grounded mental model of what the PR changes and where likely follow-up edits belong.
Finish with a concise readiness summary and the word READY.`;
}

export function buildExecutionPrompt({
  pr,
  segments,
  context = {},
  branchHead,
  branchDrift = null,
}) {
  const drift = branchDrift
    ? `The PR moved after pre-warm from \`${branchDrift.from}\` to \`${branchDrift.to}\`.
Before editing, inspect \`git diff ${branchDrift.from}..${branchDrift.to}\` and reconcile
your earlier analysis with those new commits.`
    : "The PR head still matches the revision you pre-warmed.";
  return `The recording ended. Interpret and execute the author's spoken review
comments against the PR context you already analyzed.

## Anchored speech
${renderAnchoredSegments(segments)}

## Interpretation harness
Before editing, silently translate each fuzzy spoken comment into an actionable
statement with: intended behavior, likely target, and acceptance condition. Resolve
pronouns such as "this", "that", and "here" from the anchor, selected token/snippet,
PR diff, and the repository context you already loaded. The anchor is evidence about
where the author was looking, not a command to edit that exact line.

${drift}

- HIGH confidence: make the smallest correct change and add/update tests when behavior changes.
- LOW confidence or conflicting interpretations: do not guess; leave it unchanged and
  list the exact clarification needed in the final response.
- Do not broaden scope, refactor adjacent code, or repeat context gathering you already completed.

## Delivery contract
Work from \`${branchHead || "the current HEAD"}\`. Run focused validation, create one
coherent commit for all confident changes, and stop. Do not run \`git push\`; the
voice-pr harness owns the authenticated push to \`${pr.headRefName}\` after your run.

Never force-push, rebase, amend, or post GitHub comments. The voice-pr harness owns
the PR comment. End with exactly these sections:
- APPLIED
- SKIPPED / NEEDS CLARIFICATION
- VALIDATION
- COMMIT

Context: Jira ${context.jiraKey || "not detected"}; CI ${context.checksSummary || "unknown"}.`;
}

// Backwards-compatible name for archived fixtures and callers that only need
// the anchored speech representation.
export function buildSessionBody({ pr, segments, context = {} }) {
  return buildExecutionPrompt({ pr, segments, context, branchHead: null });
}

function renderAnchoredSegments(segments) {
  return segments
    .map((segment, index) => {
      const range =
        segment.endLine && segment.endLine !== segment.line
          ? `${segment.line}-${segment.endLine}`
          : segment.line;
      const location = segment.file
        ? `\`${segment.file}${range ? `:${range}` : ""}\``
        : "(no on-screen location — infer from the words)";
      const token = segment.token ? ` (pointing at \`${segment.token}\`)` : "";
      const snippet = segment.snippet
        ? `\n   > selected code: \`${segment.snippet.replace(/\s+/g, " ").trim().slice(0, 200)}\``
        : "";
      return `${index + 1}. ${location}${token} — "${segment.text.trim()}"${snippet}`;
    })
    .join("\n");
}
