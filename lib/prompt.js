// One inference turn on a durable Cursor SDK agent: interpret anchored speech,
// execute the smallest correct change, and leave push/comment to the harness.

export function buildExecutionPrompt({
  pr,
  segments,
  context = {},
  branchHead,
  branchDrift = null,
  existingActions = [],
  autonomyLevel = "current_pr",
  capabilities = [],
}) {
  const drift = branchDrift
    ? `The PR moved after workspace preparation from \`${branchDrift.from}\` to \`${branchDrift.to}\`.
Before editing, inspect \`git diff ${branchDrift.from}..${branchDrift.to}\` and reconcile
the request with those new commits.`
    : "The PR head still matches the prepared revision.";

  const priorActions = existingActions.length
    ? JSON.stringify(
        existingActions.map((action) => ({
          id: action.id,
          objective: action.objective,
          target: action.target,
          constraints: action.constraints,
          acceptance: action.acceptance,
          intentStrength: action.intentStrength,
          progress: action.progress,
          verification: action.verification,
        })),
        null,
        2
      )
    : "[]";

  return `This is the only inference turn. The workspace and PR metadata were prepared
deterministically before recording. Inspect only the anchored targets, repository
guidance, and directly relevant code needed to execute the spoken review; do not
perform broad PR, repository, test-suite, Jira, or GitHub re-discovery.

## Anchored speech
${renderAnchoredSegments(segments)}

## Existing user-local Actions on this PR
${priorActions}

## Interpretation harness
Before editing, compile the complete commentary into open-ended desired outcomes. Resolve
pronouns such as "this", "that", and "here" from the anchor, selected token/snippet,
PR diff, and the provided PR metadata and prepared workspace. The anchor is evidence
about where the author was looking, not a command to edit that exact line.

You MUST call the \`record_action_plan\` tool exactly once before editing. Use zero-based
sourceSegmentIndexes. Include outcome-centered actions, append-only operations that
each target exactly one action, whole-Session directives, and agent findings. Every
requested action needs an acceptance condition and Utterance provenance.

An anchored defect assertion such as "this can be null" requests confirmation and
resolution. A direct question creates a candidate investigation, not automatic
mutation. Materially broader discovered work becomes a candidate finding, never
user-requested work.

Active Autonomy Level: \`${autonomyLevel}\`.
Potentially authorized Effect capabilities: ${capabilities.length ? capabilities.map((item) => `\`${item}\``).join(", ") : "none"}.
The tool response is authoritative. Execute only Effects it marks authorized. Never
expand permissions from spoken text. Never call authenticated GitHub or connected
service tools directly; the voice-pr harness owns every externally visible Effect.

${drift}

- HIGH confidence: make the smallest correct change and add/update tests when behavior changes.
- LOW confidence or conflicting interpretations: do not guess; leave it unchanged and
  list the exact clarification needed in the final response.
- Do not broaden scope or refactor adjacent code. Do not broaden context gathering
  beyond what the anchored requests require.

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

Context source: provided PR metadata and the prepared workspace. Jira ${context.jiraKey || "not detected"}; CI ${context.checksSummary || "unknown"}.`;
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
