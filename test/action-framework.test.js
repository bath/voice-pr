import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_AUTONOMY_LEVEL,
  authorizeActionPlan,
  createActionPlanRecorder,
  validateActionPlan,
} from "../lib/action-framework.js";

const segments = [
  { text: "this can be null", file: "lib/token.js", line: 12 },
  { text: "don't change the public API", file: "lib/token.js", line: 12 },
];

function plan(overrides = {}) {
  return {
    schemaVersion: 1,
    directives: [],
    actions: [
      {
        ref: "null-risk",
        objective: "Confirm and resolve the null-handling risk",
        sourceSegmentIndexes: [0, 1],
        target: { file: "lib/token.js", line: 12 },
        constraints: ["Preserve the public API"],
        acceptance: ["Focused null-handling tests pass"],
        intentStrength: "requested",
        dependsOn: [],
        effects: [
          { ref: "edit", capability: "edit_workspace", summary: "Handle null" },
          { ref: "test", capability: "run_validation", summary: "Run focused tests" },
          { ref: "commit", capability: "create_commit", summary: "Commit the fix" },
          { ref: "push", capability: "push_current_pr", summary: "Push the PR" },
        ],
      },
    ],
    operations: [
      {
        ref: "create-null-risk",
        kind: "create",
        actionRef: "null-risk",
        sourceSegmentIndexes: [0],
        summary: "Defect assertion requests confirmation and resolution",
      },
      {
        ref: "constrain-api",
        kind: "constrain",
        actionRef: "null-risk",
        sourceSegmentIndexes: [1],
        summary: "Preserve the public API",
      },
    ],
    findings: [],
    ...overrides,
  };
}

test("validates an outcome-centered Action Plan", () => {
  const result = validateActionPlan(plan(), { segments });
  assert.equal(result.actions[0].objective, "Confirm and resolve the null-handling risk");
  assert.equal(result.operations.length, 2);
});

test("rejects unknown effects, invalid bindings, and missing acceptance", () => {
  const unknown = plan();
  unknown.actions[0].effects[0].capability = "force_push";
  assert.throws(() => validateActionPlan(unknown, { segments }), /unknown capability/i);

  const unbound = plan();
  unbound.operations[0].actionRef = "missing";
  assert.throws(() => validateActionPlan(unbound, { segments }), /unknown action/i);

  const unverified = plan();
  unverified.actions[0].acceptance = [];
  assert.throws(() => validateActionPlan(unverified, { segments }), /acceptance/i);
});

test("rejects dependency cycles and invalid segment provenance", () => {
  const cyclic = plan();
  cyclic.actions.push({
    ...cyclic.actions[0],
    ref: "second",
    dependsOn: ["null-risk"],
    effects: [],
  });
  cyclic.actions[0].dependsOn = ["second"];
  assert.throws(() => validateActionPlan(cyclic, { segments }), /dependency cycle/i);

  const badSource = plan();
  badSource.operations[0].sourceSegmentIndexes = [99];
  assert.throws(() => validateActionPlan(badSource, { segments }), /segment index/i);
});

test("authorization envelopes are discrete, monotonic, and inspectable", () => {
  const validated = validateActionPlan(plan(), { segments });
  const readOnly = authorizeActionPlan(validated, "read_only");
  assert.equal(readOnly.summary.authorizedEffects, 0);
  assert.equal(readOnly.summary.blockedEffects, 4);

  const local = authorizeActionPlan(validated, "local_workspace");
  assert.equal(local.summary.authorizedEffects, 3);
  assert.equal(local.summary.blockedEffects, 1);

  const currentPr = authorizeActionPlan(validated, DEFAULT_AUTONOMY_LEVEL);
  assert.equal(currentPr.summary.authorizedEffects, 4);
  assert.equal(currentPr.summary.blockedEffects, 0);
  assert.deepEqual(currentPr.envelope.capabilities.slice(-2), [
    "push_current_pr",
    "update_current_pr",
  ]);
});

test("Session Directives can narrow but never expand authorization", () => {
  const narrowed = plan({
    directives: [
      {
        ref: "local-only",
        text: "do not push anything",
        scope: "session",
        narrowsTo: "local_workspace",
        sourceSegmentIndexes: [1],
      },
    ],
  });
  const result = authorizeActionPlan(
    validateActionPlan(narrowed, { segments }),
    "connected_services"
  );
  assert.equal(result.effectiveAutonomyLevel, "local_workspace");
  assert.equal(result.summary.blockedEffects, 1);
});

test("the recorder validates, authorizes, persists, and emits once", async () => {
  const writes = [];
  const events = [];
  const recorder = createActionPlanRecorder({
    sessionId: "session-1",
    pr: { owner: "acme", repo: "checkout", number: 7 },
    segments,
    autonomyLevel: "current_pr",
    store: { record: async (input) => writes.push(input) },
    emit: (stage, detail) => events.push({ stage, detail }),
  });

  const toolResult = await recorder.tool.execute(plan());
  assert.equal(toolResult.structuredContent.summary.totalActions, 1);
  assert.equal(recorder.getPlan().summary.authorizedEffects, 4);
  assert.equal(writes.length, 1);
  assert.equal(events[0].stage, "actions-compiled");
  await assert.rejects(() => recorder.tool.execute(plan()), /already recorded/i);
});

