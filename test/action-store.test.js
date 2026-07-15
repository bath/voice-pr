import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createActionStore } from "../lib/action-store.js";

const pr = { owner: "acme", repo: "checkout", number: 7 };

function authorizedPlan(sessionId, objective = "Resolve null handling") {
  return {
    schemaVersion: 1,
    sessionId,
    compiledAt: "2026-07-12T00:00:00.000Z",
    requestedAutonomyLevel: "current_pr",
    effectiveAutonomyLevel: "current_pr",
    directives: [],
    actions: [
      {
        ref: "null-risk",
        objective,
        sourceSegmentIndexes: [0],
        target: { file: "lib/token.js", line: 12 },
        constraints: [],
        acceptance: ["Tests pass"],
        intentStrength: "requested",
        dependsOn: [],
        effects: [
          {
            ref: "edit",
            capability: "edit_workspace",
            summary: "Edit the null path",
            authorization: "authorized",
          },
        ],
      },
    ],
    operations: [
      {
        ref: "create",
        kind: "create",
        actionRef: "null-risk",
        sourceSegmentIndexes: [0],
        summary: "Create the action",
      },
    ],
    findings: [],
    summary: { totalActions: 1, requestedActions: 1, authorizedEffects: 1, blockedEffects: 0 },
  };
}

test("persists append-only operations and a PR-scoped projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "voice-pr-actions-"));
  const store = createActionStore({ root });
  const first = await store.record({ pr, sessionId: "s1", plan: authorizedPlan("s1") });
  assert.equal(first.actions.length, 1);
  assert.match(first.actions[0].id, /^action_/);
  assert.equal(first.operations.length, 1);

  const actionId = first.actions[0].id;
  const secondPlan = authorizedPlan("s2", "Resolve null handling without API changes");
  secondPlan.actions[0].ref = actionId;
  secondPlan.operations[0].actionRef = actionId;
  secondPlan.operations[0].kind = "refine";
  const second = await store.record({ pr, sessionId: "s2", plan: secondPlan });

  assert.equal(second.actions.length, 1);
  assert.equal(second.actions[0].objective, "Resolve null handling without API changes");
  assert.equal(second.operations.length, 2);
  assert.deepEqual((await store.listOpen(pr)).map((item) => item.id), [actionId]);

  const history = await readFile(join(root, "acme_checkout_7.ndjson"), "utf8");
  assert.equal(history.trim().split("\n").length, 2);
});

test("recording the same session is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "voice-pr-actions-"));
  const store = createActionStore({ root });
  const first = await store.record({ pr, sessionId: "same", plan: authorizedPlan("same") });
  const second = await store.record({ pr, sessionId: "same", plan: authorizedPlan("same") });
  assert.deepEqual(second, first);
  const history = await readFile(join(root, "acme_checkout_7.ndjson"), "utf8");
  assert.equal(history.trim().split("\n").length, 1);
});

test("records Effect receipts without duplicating them", async () => {
  const root = await mkdtemp(join(tmpdir(), "voice-pr-actions-"));
  const store = createActionStore({ root });
  await store.record({ pr, sessionId: "receipt", plan: authorizedPlan("receipt") });
  const first = await store.recordEffectReceipt({
    pr,
    sessionId: "receipt",
    capability: "edit_workspace",
    receipt: { status: "complete", head: "abc123" },
  });
  const second = await store.recordEffectReceipt({
    pr,
    sessionId: "receipt",
    capability: "edit_workspace",
    receipt: { status: "complete", head: "abc123" },
  });
  assert.equal(first.recorded, 1);
  assert.equal(second.recorded, 0);
  assert.equal(first.snapshot.effects[0].receipt.head, "abc123");
});
