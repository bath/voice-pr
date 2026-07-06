// Builds the headless-claude prompt for one voice batch.
//
// Design decisions baked in (from the grill-me session):
//  - Speaker is the PR AUTHOR dictating changes to their OWN pushed PR.
//  - Source of truth is the pushed head branch (what the author sees on GitHub).
//  - Confident items -> real edits + one commit each.
//  - Unclear items -> NOT acted on; surfaced back as a clarification comment.
//  - Comments are an "anchored intent trail": each committed change explains
//    WHY that line changed, pinned to the line.

export function buildPrompt({ pr, transcript, manifestPath }) {
  return `You are the coding agent behind "voice-pr". The author of pull request
#${pr.number} ("${pr.title}") is reviewing their OWN PR on GitHub and just spoke
the feedback below out loud. Your job is to turn that spoken feedback into real
commits on the current branch — the same way the author would if they sat down
and did it themselves.

You are running inside a fresh checkout of the PR's head branch (${pr.headRefName}).
This checkout is isolated; the branch HEAD here is exactly what is on GitHub.

=== WHAT THE AUTHOR SAID (raw transcript, may be rambling / elliptical) ===
${transcript}
=== END TRANSCRIPT ===

TASK
1. Segment the transcript into discrete, actionable items. One intent per item.
   Ignore filler and thinking-aloud that isn't a request.

2. For EACH item decide your confidence that you know the EXACT code change meant:
   - HIGH: you can point to the specific code and make the change with no guessing.
     Use \`git diff\`, \`rg\`/grep, and reading files to locate the target. The author
     is describing code in THIS repo — usually code that appears in the PR diff.
   - LOW: the request is ambiguous, under-specified, could map to several places,
     or is too large to do safely in one small commit. When unsure, choose LOW.
     Do NOT guess on a LOW item — a wrong confident commit is worse than asking.

3. For each HIGH item:
   - Make the minimal, correct edit(s). Add or update a test if the item asks for
     behavior the author clearly wants verified.
   - Commit ONLY that item's changes as its own commit:
       git add -A && git commit -m "<concise conventional message> (voice-pr)"
   - Record the commit sha (git rev-parse HEAD), the PRIMARY file changed, and a
     specific line number IN THE NEW FILE that your commit added or modified
     (right side of the diff) — this is where the intent-trail comment anchors.
   - Do NOT push. The harness pushes after you finish.

4. For each LOW item: do NOT edit anything. Record what you understood and exactly
   what you'd need the author to clarify.

CONSTRAINTS
- One commit per HIGH item. Keep commits scoped; don't touch unrelated code.
- Never force-push, rebase, amend existing commits, or change branches.
- Do NOT commit the manifest file (it lives outside the repo — see below).

OUTPUT — write a JSON file to this ABSOLUTE path (it is OUTSIDE the git repo; do
not \`git add\` it): ${manifestPath}

Schema:
{
  "summary": "one sentence describing what you did overall",
  "items": [
    {
      "title": "short imperative title",
      "spoken": "the paraphrased request this item came from",
      "confidence": "high" | "low",
      "status": "committed" | "needs-clarification" | "failed",
      "file": "path/from/repo/root",        // committed items only
      "line": 42,                             // a changed line, new-file side
      "commitSha": "full sha",                // committed items only
      "rationale": "one sentence: WHY this line changed (author-requested via voice)",
      "clarification": "what was unclear and what you need"  // low/failed items
    }
  ]
}

Write the manifest as the LAST thing you do, after all commits. Make it valid JSON.
If you edited but the commit failed, mark that item "failed" with a clarification.
Return a one-line summary as your final message.`;
}

/**
 * Body for the ORCHESTRATOR path: this becomes the `mg` work-item body handed
 * to a pogo polecat. The polecat template already owns the claim / commit /
 * `refinery submit` / done protocol and merges onto the PR branch (the work
 * item's --branch). So this body only describes WHAT to change + the voice-pr
 * conventions (confidence gate, anchored intent-trail comments).
 */
export function buildOrchestratorBody({ pr, transcript }) {
  return `This work item was created from the PR author's **spoken feedback** on
pull request #${pr.number} of ${pr.owner}/${pr.repo} ("${pr.title}"). You are
implementing the changes the author would have made themselves. Your worktree is
based on the PR head branch \`${pr.headRefName}\`, and the refinery will merge
your commits back onto that branch — so your work updates the PR directly.

=== WHAT THE AUTHOR SAID (raw transcript, may ramble) ===
${transcript}
=== END TRANSCRIPT ===

DO THIS:
1. Segment the transcript into discrete, actionable items (one intent each).
   Ignore filler and thinking-aloud.
2. For each item, judge your confidence you know the EXACT change meant. The
   author is describing code in THIS repo — usually code on the PR branch. Use
   \`git diff ${pr.baseRefName || "main"}..HEAD\`, grep, and file reads to locate it.
   - HIGH confidence: make the minimal correct edit; add/update a test if the
     item wants verified behavior. Use a separate focused commit per item.
   - LOW confidence (ambiguous, could map to several places, or too large to do
     safely): DO NOT guess and DO NOT edit. A wrong confident change is worse
     than asking. Collect these as "needs clarification".
3. Use a separate, focused commit per HIGH item, with the work item id in the
   commit message (as the polecat protocol above already instructs). For any
   LOW-confidence item, note it in your final message but DO NOT edit or commit
   it. Then follow the standard polecat protocol to push and submit to the
   refinery (target branch \`${pr.headRefName}\`).

Do NOT post PR comments yourself — pogod stops you the moment your merge lands,
so post-merge work won't run. The voice-pr harness posts the intent trail (and
any clarification note) on the PR after it observes the merge. Your job is the
merged code; call out LOW-confidence items in your final message so they're
visible.`;
}

/**
 * Body for a live VOICE REVIEW SESSION captured by the Chrome extension: the
 * author scrolled the diff and spoke, and each spoken chunk is anchored to the
 * file+line that was in their viewport at that moment. This body carries those
 * anchors plus context pointers the polecat should pull via its MCP tools.
 *
 * @param {{pr:object, segments:Array<{text,file,line}>, context:object}} a
 */
export function buildSessionBody({ pr, segments, context = {} }) {
  const anchored = segments
    .map((s, i) => {
      const range = s.endLine && s.endLine !== s.line ? `${s.line}-${s.endLine}` : s.line;
      const loc = s.file
        ? `\`${s.file}${range ? `:${range}` : ""}\``
        : "(no on-screen location — infer from the words)";
      const tok = s.token ? ` (pointing at \`${s.token}\`)` : "";
      const snip = s.snippet ? `\n   > selected code: \`${s.snippet.replace(/\s+/g, " ").trim().slice(0, 200)}\`` : "";
      return `${i + 1}. ${loc}${tok} — "${s.text.trim()}"${snip}`;
    })
    .join("\n");

  // Optional enrichment — listed as available-if-present, never as a blocker.
  const optional = [];
  if (context.jiraKey)
    optional.push(
      `- Jira ticket \`${context.jiraKey}\` (from the branch/title) — if Atlassian tools are available, a quick read can sharpen intent.`
    );
  optional.push(
    `- Slack — if Slack tools are available, a search for "#${pr.number}" + the repo name may surface decisions.`
  );
  if (context.checksSummary)
    optional.push(`- CI / checks: ${context.checksSummary}.`);

  return `This work item came from a **live voice review session**: the PR author
scrolled the diff of ${pr.owner}/${pr.repo} #${pr.number} ("${pr.title}") and spoke
their feedback. Each comment is anchored to the file+line on screen when they said
it. Implement the changes as the author would have. Your worktree is based on the
PR head branch \`${pr.headRefName}\`; the refinery merges your commits back onto it,
so your work updates the PR directly.

## Do this now — the spoken comments (anchored to what was on screen)
${anchored}

The anchor is where they were looking, not necessarily the exact edit site — if a
comment clearly refers to code elsewhere ("the retry loop" while scrolled past it),
follow the meaning over the anchor.

For EACH comment:
- Judge your confidence you know the exact change, from the anchor + the diff (below).
- HIGH: make the minimal correct edit (+ a test if behavior changes). One focused
  commit per item, with the work item id in the message.
- LOW (ambiguous, could map to several places, or too large): DO NOT guess or edit —
  note it in your final message as needing clarification.

Then follow the standard polecat protocol to push + submit to the refinery (target
branch \`${pr.headRefName}\`). Do NOT post PR comments yourself — the voice-pr harness
posts the intent trail after your merge.

## Optional context — DO NOT block on this
The diff + anchors above are enough to do the work; start there. Only IF these tools
are already available to you, you MAY briefly consult them to sharpen intent — if
they are not present, skip them entirely and do NOT spend time searching. Never let
context-gathering delay the edits.
${optional.join("\n")}`;
}
