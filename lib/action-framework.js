// Voice commentary compiler boundary. The model proposes an Action Plan through
// one typed callback tool; this module validates the plan and applies the user's
// configured authorization envelope before the harness permits publication.

export const AUTONOMY_LEVELS = Object.freeze([
  { id: "read_only", rank: 0, scope: "read-only" },
  { id: "local_workspace", rank: 1, scope: "local workspace" },
  { id: "current_pr", rank: 2, scope: "current pull request" },
  { id: "current_repo", rank: 3, scope: "current repository" },
  { id: "connected_services", rank: 4, scope: "connected services" },
]);

export const DEFAULT_AUTONOMY_LEVEL = "current_pr";

export const EFFECT_CAPABILITIES = Object.freeze({
  inspect_code: { rank: 0, scope: "read-only", external: false },
  answer_question: { rank: 0, scope: "read-only", external: false },
  edit_workspace: { rank: 1, scope: "local workspace", external: false },
  run_validation: { rank: 1, scope: "local workspace", external: false },
  create_commit: { rank: 1, scope: "local workspace", external: false },
  push_current_pr: { rank: 2, scope: "current pull request", external: true },
  update_current_pr: { rank: 2, scope: "current pull request", external: true },
  create_repo_issue: { rank: 3, scope: "current repository", external: true },
  request_repo_reviewer: { rank: 3, scope: "current repository", external: true },
  update_repo_metadata: { rank: 3, scope: "current repository", external: true },
  call_connected_service: { rank: 4, scope: "connected services", external: true },
});

const OPERATION_KINDS = new Set([
  "create",
  "refine",
  "constrain",
  "reclassify",
  "cancel",
  "reopen",
  "contextualize",
  "invalidate",
]);
const INTENT_STRENGTHS = new Set(["observed", "candidate", "requested"]);
const DIRECTIVE_SCOPES = new Set(["session", "subsequent", "explicit"]);
const LEVEL_BY_ID = new Map(AUTONOMY_LEVELS.map((level) => [level.id, level]));

export const ACTION_PLAN_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "actions", "operations"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    directives: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "text", "scope", "sourceSegmentIndexes"],
        properties: {
          ref: { type: "string", minLength: 1 },
          text: { type: "string", minLength: 1 },
          scope: { type: "string", enum: [...DIRECTIVE_SCOPES] },
          narrowsTo: {
            type: "string",
            enum: AUTONOMY_LEVELS.map((level) => level.id),
          },
          sourceSegmentIndexes: {
            type: "array",
            items: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "ref",
          "objective",
          "sourceSegmentIndexes",
          "acceptance",
          "intentStrength",
          "effects",
        ],
        properties: {
          ref: { type: "string", minLength: 1 },
          objective: { type: "string", minLength: 1 },
          sourceSegmentIndexes: {
            type: "array",
            items: { type: "integer", minimum: 0 },
          },
          target: {
            type: "object",
            additionalProperties: false,
            properties: {
              file: { type: "string" },
              line: { type: "number" },
              endLine: { type: "number" },
              symbol: { type: "string" },
              description: { type: "string" },
            },
          },
          constraints: { type: "array", items: { type: "string", minLength: 1 } },
          acceptance: { type: "array", items: { type: "string", minLength: 1 } },
          disposition: { type: "string" },
          intentStrength: { type: "string", enum: [...INTENT_STRENGTHS] },
          dependsOn: { type: "array", items: { type: "string", minLength: 1 } },
          effects: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["ref", "capability", "summary"],
              properties: {
                ref: { type: "string", minLength: 1 },
                capability: {
                  type: "string",
                  enum: Object.keys(EFFECT_CAPABILITIES),
                },
                summary: { type: "string", minLength: 1 },
                args: { type: "object", additionalProperties: true },
              },
            },
          },
        },
      },
    },
    operations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "kind", "actionRef", "sourceSegmentIndexes", "summary"],
        properties: {
          ref: { type: "string", minLength: 1 },
          kind: { type: "string", enum: [...OPERATION_KINDS] },
          actionRef: { type: "string", minLength: 1 },
          sourceSegmentIndexes: {
            type: "array",
            items: { type: "integer", minimum: 0 },
          },
          summary: { type: "string", minLength: 1 },
          supersedes: { type: "string" },
        },
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "summary"],
        properties: {
          ref: { type: "string", minLength: 1 },
          summary: { type: "string", minLength: 1 },
          actionRef: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
  },
});

/** Validate and normalize untrusted model output. Throws before any Effect. */
export function validateActionPlan(input, { segments = [] } = {}) {
  object(input, "Action Plan");
  if (input.schemaVersion !== 1) throw new Error("Action Plan schemaVersion must be 1");

  const directives = array(input.directives ?? [], "directives").map((value, index) =>
    normalizeDirective(value, index, segments)
  );
  const actions = array(input.actions, "actions").map((value, index) =>
    normalizeAction(value, index, segments)
  );
  const operations = array(input.operations, "operations").map((value, index) =>
    normalizeOperation(value, index, segments)
  );
  const findings = array(input.findings ?? [], "findings").map((value, index) =>
    normalizeFinding(value, index)
  );

  unique(actions.map((action) => action.ref), "action ref");
  unique(operations.map((operation) => operation.ref), "operation ref");
  unique(directives.map((directive) => directive.ref), "directive ref");
  const actionRefs = new Set(actions.map((action) => action.ref));

  for (const action of actions) {
    for (const dependency of action.dependsOn) {
      if (!actionRefs.has(dependency))
        throw new Error(`Action ${action.ref} depends on unknown action ${dependency}`);
      if (dependency === action.ref)
        throw new Error(`Action ${action.ref} cannot depend on itself`);
    }
  }
  assertAcyclic(actions);

  for (const operation of operations) {
    if (!actionRefs.has(operation.actionRef))
      throw new Error(`Operation ${operation.ref} targets unknown action ${operation.actionRef}`);
  }
  for (const finding of findings) {
    if (finding.actionRef && !actionRefs.has(finding.actionRef))
      throw new Error(`Finding ${finding.ref} targets unknown action ${finding.actionRef}`);
  }

  return { schemaVersion: 1, directives, actions, operations, findings };
}

/** Apply a discrete, inspectable permission envelope to a validated plan. */
export function authorizeActionPlan(plan, requestedLevel = DEFAULT_AUTONOMY_LEVEL) {
  const requested = requireLevel(requestedLevel);
  let effective = requested;
  for (const directive of plan.directives) {
    if (!directive.narrowsTo) continue;
    const narrowed = requireLevel(directive.narrowsTo);
    if (narrowed.rank < effective.rank) effective = narrowed;
  }

  let authorizedEffects = 0;
  let blockedEffects = 0;
  const actions = plan.actions.map((action) => {
    const effects = action.effects.map((effect) => {
      const capability = EFFECT_CAPABILITIES[effect.capability];
      const authorized = capability.rank <= effective.rank;
      if (authorized) authorizedEffects += 1;
      else blockedEffects += 1;
      return {
        ...effect,
        authorization: authorized ? "authorized" : "required",
        authorizationReason: authorized
          ? `allowed by ${effective.id}`
          : `${effect.capability} requires ${levelForRank(capability.rank).id}`,
      };
    });
    const actionAuthorization = !effects.length
      ? "not_required"
      : effects.every((effect) => effect.authorization === "authorized")
        ? "authorized"
        : "required";
    return { ...action, authorization: actionAuthorization, effects };
  });

  const envelope = {
    level: effective.id,
    scope: effective.scope,
    capabilities: Object.entries(EFFECT_CAPABILITIES)
      .filter(([, capability]) => capability.rank <= effective.rank)
      .map(([id]) => id),
  };
  const summary = {
    totalActions: actions.length,
    requestedActions: actions.filter((action) => action.intentStrength === "requested").length,
    authorizedEffects,
    blockedEffects,
    actionsNeedingPermission: actions.filter((action) => action.authorization === "required").length,
  };
  return {
    ...plan,
    requestedAutonomyLevel: requested.id,
    effectiveAutonomyLevel: effective.id,
    envelope,
    actions,
    summary,
  };
}

/**
 * Custom Cursor SDK callback tool. It is deliberately single-use: a model may
 * not rewrite the accepted plan after observing its authorization result.
 */
export function createActionPlanRecorder({
  sessionId,
  pr,
  segments,
  autonomyLevel = DEFAULT_AUTONOMY_LEVEL,
  store,
  emit = () => {},
  now = () => new Date(),
}) {
  let recorded = null;
  const tool = {
    description:
      "Record the complete voice-pr Action Plan before editing or requesting any external Effect. Call exactly once.",
    inputSchema: ACTION_PLAN_INPUT_SCHEMA,
    async execute(input) {
      if (recorded) throw new Error("Action Plan already recorded for this Session");
      const validated = validateActionPlan(input, { segments });
      const candidate = {
        ...authorizeActionPlan(validated, autonomyLevel),
        sessionId,
        compiledAt: now().toISOString(),
      };
      if (store?.record) await store.record({ pr, sessionId, plan: candidate });
      recorded = candidate;
      const detail = publicActionSummary(recorded);
      emit("actions-compiled", detail);
      return {
        content: [
          {
            type: "text",
            text:
              `${detail.totalActions} Actions compiled; ` +
              `${detail.authorizedEffects} Effects authorized; ` +
              `${detail.blockedEffects} require permission. Execute only authorized Effects.`,
          },
        ],
        structuredContent: {
          summary: detail,
          effectiveAutonomyLevel: recorded.effectiveAutonomyLevel,
          actions: recorded.actions.map((action) => ({
            ref: action.ref,
            objective: action.objective,
            authorization: action.authorization,
            effects: action.effects.map((effect) => ({
              ref: effect.ref,
              capability: effect.capability,
              authorization: effect.authorization,
            })),
          })),
        },
      };
    },
  };
  return { tool, getPlan: () => recorded };
}

export function publicActionSummary(plan) {
  return {
    totalActions: plan.summary.totalActions,
    requestedActions: plan.summary.requestedActions,
    authorizedEffects: plan.summary.authorizedEffects,
    blockedEffects: plan.summary.blockedEffects,
    actionsNeedingPermission: plan.summary.actionsNeedingPermission,
    effectiveAutonomyLevel: plan.effectiveAutonomyLevel,
    outcomes: plan.actions.map((action) => ({
      objective: action.objective,
      intentStrength: action.intentStrength,
      authorization: action.authorization,
    })),
  };
}

function normalizeDirective(value, index, segments) {
  object(value, `directive ${index}`);
  const scope = optionalString(value.scope) || "subsequent";
  if (!DIRECTIVE_SCOPES.has(scope)) throw new Error(`Directive ${index} has invalid scope ${scope}`);
  const narrowsTo = optionalString(value.narrowsTo);
  if (narrowsTo) requireLevel(narrowsTo);
  return {
    ref: requiredString(value.ref, `directive ${index} ref`),
    text: requiredString(value.text, `directive ${index} text`),
    scope,
    narrowsTo: narrowsTo || null,
    sourceSegmentIndexes: sourceIndexes(value.sourceSegmentIndexes ?? [], segments, `directive ${index}`),
  };
}

function normalizeAction(value, index, segments) {
  object(value, `action ${index}`);
  const intentStrength = optionalString(value.intentStrength) || "candidate";
  if (!INTENT_STRENGTHS.has(intentStrength))
    throw new Error(`Action ${index} has invalid intent strength ${intentStrength}`);
  const acceptance = stringArray(value.acceptance ?? [], `action ${index} acceptance`);
  if (intentStrength === "requested" && !acceptance.length)
    throw new Error(`Requested Action ${index} requires an acceptance condition`);
  const effects = array(value.effects ?? [], `action ${index} effects`).map((effect, effectIndex) => {
    object(effect, `action ${index} effect ${effectIndex}`);
    const capability = requiredString(effect.capability, `action ${index} effect capability`);
    if (!EFFECT_CAPABILITIES[capability])
      throw new Error(`Action ${index} uses unknown capability ${capability}`);
    return {
      ref: requiredString(effect.ref, `action ${index} effect ref`),
      capability,
      summary: requiredString(effect.summary, `action ${index} effect summary`),
      args: jsonObject(effect.args ?? {}, `action ${index} effect args`),
    };
  });
  unique(effects.map((effect) => effect.ref), `effect ref in action ${index}`);
  const sources = sourceIndexes(value.sourceSegmentIndexes ?? [], segments, `action ${index}`);
  if (intentStrength === "requested" && !sources.length)
    throw new Error(`Requested Action ${index} requires Utterance provenance`);
  return {
    ref: requiredString(value.ref, `action ${index} ref`),
    objective: requiredString(value.objective, `action ${index} objective`),
    sourceSegmentIndexes: sources,
    target: normalizeTarget(value.target),
    constraints: stringArray(value.constraints ?? [], `action ${index} constraints`),
    acceptance,
    disposition: optionalString(value.disposition) || null,
    intentStrength,
    progress: "open",
    verification: "unverified",
    dependsOn: stringArray(value.dependsOn ?? [], `action ${index} dependencies`),
    effects,
  };
}

function normalizeOperation(value, index, segments) {
  object(value, `operation ${index}`);
  const kind = requiredString(value.kind, `operation ${index} kind`);
  if (!OPERATION_KINDS.has(kind)) throw new Error(`Operation ${index} has invalid kind ${kind}`);
  return {
    ref: requiredString(value.ref, `operation ${index} ref`),
    kind,
    actionRef: requiredString(value.actionRef, `operation ${index} actionRef`),
    sourceSegmentIndexes: sourceIndexes(
      value.sourceSegmentIndexes ?? [],
      segments,
      `operation ${index}`
    ),
    summary: requiredString(value.summary, `operation ${index} summary`),
    supersedes: optionalString(value.supersedes) || null,
  };
}

function normalizeFinding(value, index) {
  object(value, `finding ${index}`);
  return {
    ref: requiredString(value.ref, `finding ${index} ref`),
    summary: requiredString(value.summary, `finding ${index} summary`),
    actionRef: optionalString(value.actionRef) || null,
    evidence: optionalString(value.evidence) || null,
  };
}

function normalizeTarget(value) {
  if (value == null) return null;
  object(value, "action target");
  const line = optionalNumber(value.line);
  const endLine = optionalNumber(value.endLine);
  return {
    file: optionalString(value.file) || null,
    line,
    endLine,
    symbol: optionalString(value.symbol) || null,
    description: optionalString(value.description) || null,
  };
}

function assertAcyclic(actions) {
  const dependencies = new Map(actions.map((action) => [action.ref, action.dependsOn]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (ref) => {
    if (visiting.has(ref)) throw new Error(`Action dependency cycle includes ${ref}`);
    if (visited.has(ref)) return;
    visiting.add(ref);
    for (const dependency of dependencies.get(ref) || []) visit(dependency);
    visiting.delete(ref);
    visited.add(ref);
  };
  for (const action of actions) visit(action.ref);
}

function sourceIndexes(value, segments, label) {
  const indexes = array(value, `${label} sourceSegmentIndexes`).map((entry) => {
    if (!Number.isInteger(entry) || entry < 0 || entry >= segments.length)
      throw new Error(`${label} has invalid segment index ${entry}`);
    return entry;
  });
  return [...new Set(indexes)];
}

function requireLevel(id) {
  const level = LEVEL_BY_ID.get(id);
  if (!level) throw new Error(`Unknown Autonomy Level ${id}`);
  return level;
}

function levelForRank(rank) {
  return AUTONOMY_LEVELS.find((level) => level.rank === rank) || AUTONOMY_LEVELS.at(-1);
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a string`);
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalNumber(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function stringArray(value, label) {
  return array(value, label).map((entry, index) => requiredString(entry, `${label} ${index}`));
}

function array(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value;
}

function jsonObject(value, label) {
  object(value, label);
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new Error(`${label} must be JSON serializable`);
  }
}

function unique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label} ${value}`);
    seen.add(value);
  }
}
