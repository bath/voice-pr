# Voice Action Framework Decision Log

## Language and boundaries

- Utterances preserve immutable timed, anchored speech evidence.
- Operations append one change to exactly one Action.
- Actions represent independently resolvable desired outcomes.
- Effects realize Actions through existing capabilities.
- Sessions capture evidence but never own Actions.
- Findings represent agent discoveries, never user intent.
- Action state remains user-local and PR-scoped.
- GitHub remains the only team collaboration surface.

## Lifecycle

- Actions persist throughout their pull request lifecycle.
- Actions project current state from immutable Operation history.
- Action facets remain independent, never one lifecycle ladder.
- Cancellation stops unresolved work; compensation reverses applied Effects.
- Commit boundaries follow code coherence, not Action boundaries.
- Dependencies follow causality, never utterance ordering.
- Closed PRs archive Actions and block Effects.

## Compilation

- Compilation happens post-recording and before external Effects.
- Recording performs zero semantic inference.
- Statements may produce multiple independently bound Operations.
- Ambiguous bindings pause only affected Actions.
- Defect assertions request confirmation and resolution.
- Questions request investigation without automatic mutation.
- Hedged preferences create candidates, not requested Actions.
- Material scope expansion creates candidate Actions.
- Agent Findings create candidate Actions.
- Session Directives set defaults and constraints.
- Directives may narrow, never expand, permissions.
- Conflicting constraints block affected Actions.
- Anchors provide evidence, never durable Action identity.

## Execution and recovery

- Action Plans validate before external Effects execute.
- Harnesses enforce capabilities; prompts never grant permissions.
- Agents receive only currently authorized capabilities.
- Harnesses own all externally visible Effects.
- Single warmed runs compile before requesting Effects.
- Missing Action Plans prevent pushes and publication.
- Necessary in-scope Effects may emerge during execution.
- Effect receipts make retries idempotent.
- Partial failures preserve completed Effects.
- Retries execute only missing Effects.
- Session-wide rollback never follows partial failure.
- Concurrent compilation rebases against latest Action state.
- Branch-writing Effects serialize per PR branch.

## Authorization

- Dispatch authorizes only active Authorization Envelopes.
- Autonomy Levels select inspectable capability presets.
- Hard safety ceilings override every Autonomy Level.
- Spoken commentary cannot expand authorization.
- User defaults persist; Session overrides remain explicit.
- Authorization labels remain intentionally unresolved.

## Privacy and interface

- Raw audio and Utterances remain local.
- Published Effects exclude raw speech by default.
- Actions remain internal until exceptions require attention.
- Successful Sessions show compact outcome summaries.
- Detailed Action history remains opt-in.
- Authorization controls never resemble pipeline progress.

## Measurement and non-goals

- Stop-to-patch remains the latency metric.
- Hands-off resolution measures Specificity Tax reduction.
- Corrections and blocked Effects remain safety guardrails.
- Shared Action state remains out-of-scope.
- Live inference remains out-of-scope.
- Deterministic code safety remains separate.
- New GitHub capabilities remain out-of-scope.
- General workflow automation remains out-of-scope.

