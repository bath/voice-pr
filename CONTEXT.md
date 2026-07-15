# Voice Review

Voice Review turns one user's situated pull-request speech into explicit developer actions without treating transcription boundaries as intent boundaries or replacing GitHub as the collaboration surface.

## Language

**Utterance**:
An immutable span of captured speech with its words, timing, audio range, and page anchor.
_Avoid_: Statement, comment, transcript segment

**Operation**:
An append-only interpreted change to exactly one action accepted into that action's history.
_Avoid_: Command, instruction, tool call

**Action**:
A mutable, independently resolvable desired outcome assembled from operations and eligible for authorisation, execution, and verification.
_Avoid_: Statement, comment, transcript segment, job, tool call, side effect

**Effect**:
A local or externally visible state change performed to realise an action.
_Avoid_: Action, objective

**Effect Capability**:
A named, permission-controlled class of effect with declared scope and reconciliation behaviour.
_Avoid_: Action category, risk score

**Effect Receipt**:
The durable evidence that a specific planned effect already occurred or was reconciled against external state.
_Avoid_: Progress event, agent log

**Acceptance Condition**:
The evidence threshold that establishes whether an action's desired outcome was achieved.
_Avoid_: Effect completion, agent success

**Compensating Action**:
A new action whose desired outcome reverses or mitigates effects already applied by an earlier action.
_Avoid_: Cancellation, history deletion

**Action Binding**:
The association of one operation with exactly one existing or newly created action.
_Avoid_: Semantic similarity, guessed reference

**Finding**:
Agent-discovered evidence that can refine an action or propose a new candidate action without claiming user intent.
_Avoid_: Utterance, request

**Action Dependency**:
A causal requirement that one action resolve before another can safely proceed.
_Avoid_: Utterance order, visual order

**Action Plan**:
The validated compilation output containing action changes and their proposed effects before execution.
_Avoid_: Raw transcript, agent prompt

**Dispatch Target**:
A selected black-box inference and execution boundary that proposes an Action Plan from anchored Utterances and realises only the Effects authorised by Voice Review.
_Avoid_: Provider, model, orchestrator, agent harness, execution destination

**Dispatch Target Status**:
The declared readiness of a Dispatch Target as either selectable and verified or visible only as a contribution placeholder.
_Avoid_: Runtime health, model availability, permission state

**Session**:
A bounded capture and dispatch envelope that contributes utterances and operations without owning their actions.
_Avoid_: Action, review, agent run

**Session Directive**:
An utterance-derived constraint or default that applies across a session without representing a desired outcome.
_Avoid_: Action, operation, permission expansion

**Compilation**:
The post-capture, pre-mutation interpretation of a session's utterances into operations and actions.
_Avoid_: Live transcription, execution, agent run

**Specificity Tax**:
The effort required to translate situated developer intent into explicit targets, instructions, and tool commands an agent can execute.
_Avoid_: Model capability, execution latency

**Intent Strength**:
The degree to which an action expresses an observation, candidate, or explicit request.
_Avoid_: Status, progress

**Authorisation**:
The permission facet stating whether an action needs approval and whether that approval was granted or denied.
_Avoid_: Intent strength, progress

**Authorisation Envelope**:
The predeclared set of effects that Dispatch permits compilation to execute without further approval.
_Avoid_: Blanket consent, inferred permission

**Autonomy Level**:
A named, inspectable preset that selects an authorisation envelope beneath a non-overridable safety ceiling.
_Avoid_: Risk score, percentage, safety override

**Progress**:
The resolution facet stating whether an action is open, in progress, blocked, resolved, or cancelled.
_Avoid_: Authorisation, verification

**Verification**:
The evidence facet stating whether an action is unverified, verified, or invalidated by later evidence.
_Avoid_: Execution, progress

## Relationships

- An **Utterance** can yield zero or more **Operations**
- An **Operation** targets exactly one **Action**, while one **Utterance** can yield a grouped set of operations across multiple actions
- **Compilation** creates an **Action Binding** automatically only when the utterance, anchor, and recent action history identify one high-confidence target; ambiguous bindings require clarification
- An **Action** accumulates one or more **Operations** from one or more **Utterances**
- An **Action** is the current mutable projection of its immutable, append-only **Operation** history
- An **Action** normally remains implicit and is surfaced only when it needs user intervention or explicit inspection
- A **Session** contains one or more **Utterances** and can contribute **Operations** to existing or new **Actions**
- A **Session Directive** can narrow permissions, constrain all session actions, or set defaults for subsequent actions, but cannot expand an **Authorisation Envelope**
- A **Session Directive** applies forward from its utterance unless the speaker explicitly gives it broader scope
- **Compilation** begins only after a **Session** stops capturing and completes before any inferred mutation begins
- An **Action** belongs to one user within one pull request and remains durable throughout that pull request's lifecycle
- An **Action** is reconciled against the latest pull-request head before execution; its anchor is evidence for retargeting rather than part of its identity
- **Actions**, **Operations**, **Utterances**, and raw audio remain user-local; collaborators see only authorised effects applied through the pull request and its existing tools
- Every **Action** has independent **Intent Strength**, **Authorisation**, **Progress**, and **Verification** facets rather than one linear lifecycle
- Dispatch grants **Authorisation** only when an action's effects fit the active **Authorisation Envelope**
- An **Autonomy Level** selects a concrete **Authorisation Envelope**, while user and organisation policy cap the maximum available level
- An **Utterance** can request an effect but cannot expand the **Authorisation Envelope**
- An **Action** boundary is determined by independent resolvability, not by the number of tool calls or externally visible effects needed to realise it
- An **Action** expresses an open-ended outcome rather than belonging to a fixed effect-based category, and one action can require multiple **Effects**
- **Actions** and commit **Effects** have a many-to-many relationship; code coherence rather than action count determines commit boundaries
- A requested **Action** has an inferred **Acceptance Condition**, and successful **Effects** do not alone establish **Verification**
- In pull-request review context, an anchored defect assertion creates a requested **Action** to confirm and resolve the asserted risk without requiring an explicit imperative
- An explicit question creates a candidate investigation without authorising mutation, while a hedged preference creates a candidate action
- **Effect** capabilities, rather than action categories, determine whether execution fits the active **Authorisation Envelope**
- Every executable effect maps to one validated **Effect Capability** enforced outside the agent prompt
- Every planned **Effect** has stable identity and an **Effect Receipt** so retries reconcile rather than duplicate external work
- Partial failure preserves successful **Effect Receipts**, blocks only affected actions, and retries missing effects without a session-wide rollback
- Ambiguity blocks only the affected **Action** and its dependants; independent authorised actions in the same **Session** can continue
- **Action Dependencies** form an acyclic execution order based on causality rather than utterance order
- Contradictory active constraints block only affected actions until clarified
- Execution can add necessary in-scope **Effects**, but materially broader outcomes become separate proposed actions rather than silently expanding an existing action
- A **Finding** can refine an existing action or create a candidate action, but cannot claim requested intent or execute outside policy
- **Compilation** produces a validated **Action Plan** before any externally visible effect can execute
- A **Session** uses exactly one **Dispatch Target** for both **Compilation** and execution
- A user's selected **Dispatch Target** remains active across restarts until that user changes it
- Only a verified **Dispatch Target** is selectable; a placeholder remains visible but cannot receive a **Session**
- Every semantic inference within a **Session** occurs inside its selected **Dispatch Target**
- A **Dispatch Target** proposes an **Action Plan**, while Voice Review validates and authorises that plan before returning executable Effects to the same target
- A **Dispatch Target** may use any internal provider, model, agent harness, or orchestration strategy without exposing it to Voice Review
- If its selected **Dispatch Target** is unavailable or cannot complete Compilation, a **Session** fails without routing inference to another target
- A headless Voice Review process without a valid selected **Dispatch Target** fails before a **Session** begins
- Cancelling an unresolved **Action** prevents future effects, while undoing applied effects creates a **Compensating Action** under the normal authorisation and verification rules
- A transcription boundary does not establish an **Action** boundary

## Example dialogue

> **Dev:** “Whisper returned one segment containing a question, a correction, and a requested edit. Is that one **Action**?”
> **Domain expert:** “No. Preserve it as one **Utterance**, infer three **Operations**, and let those operations resolve or create the appropriate **Actions**.”

## Flagged ambiguities

- “statement,” “comment,” and “segment” previously described both captured speech and requested work — resolved: captured speech is an **Utterance**, inferred effects are **Operations**, and durable work is an **Action**.
- “action” previously risked meaning an individual GitHub or agent side effect — resolved: an **Action** is the desired outcome; tool calls and external effects are mechanisms used to realise it.
- “session” previously acted as the lifetime of interpreted work — resolved: a **Session** only captures and dispatches evidence; **Actions** persist for the lifetime of their pull request.
- “status” previously risked collapsing commitment, permission, progress, and evidence into one ladder — resolved: **Intent Strength**, **Authorisation**, **Progress**, and **Verification** are independent facets.
- The Action Tape prototype appeared to compile commentary live — resolved: **Compilation** occurs after capture stops, and any visual replay is explanatory rather than live inference.
- “dispatch” previously risked implying blanket consent to whatever compilation inferred — resolved: Dispatch authorises only effects inside the active **Authorisation Envelope**.
- “safe to yolo” describes the intended **Autonomy Level** control, but its production preset names remain unresolved.
- Editing an accepted operation in place would erase how an action changed — resolved: **Operations** become append-only when **Compilation** completes, and later corrections append superseding or invalidating operations.
- “PR-scoped” risked implying shared action state among collaborators — resolved: action state is local to one user, and GitHub remains the team collaboration surface.
- The framework does not add agent or GitHub capabilities — it reduces the **Specificity Tax** of expressing and dispatching existing capabilities from situated vocal commentary.
- The Action Tape risked replacing specificity tax with action-management tax — resolved: the normal path remains Record to Dispatch to result, and detailed **Actions** surface by exception or request.
- Fixed Action slots risked splitting one outcome by tool or delivery mechanism — resolved: **Actions** are open-ended outcomes and code edits, comments, issues, assignments, and notifications are **Effects**.
- Agent-discovered scope risked being attributed to the user — resolved: agent discoveries are **Findings** and any new work starts as a candidate action.
- “provider,” “orchestrator,” “agent harness,” and “execution destination” risked leaking target internals into Voice Review — resolved: Voice Review selects a **Dispatch Target** and treats its implementation as opaque.
