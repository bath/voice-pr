import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadReceipt() {
  const source = await readFile(new URL("../extension/receipt.js", import.meta.url), "utf8");
  const context = { globalThis: {} };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.VoicePrReceipt;
}

const effect = (capability, summary, authorization = "required") => ({ capability, summary, authorization });
const resultWith = (effects, overrides = {}) => ({
  status: "done",
  commits: [{ oid: "abc" }],
  actionPlan: { actions: [{ effects }] },
  actionSummary: { blockedEffects: effects.filter((item) => item.authorization === "required").length },
  ...overrides,
});

test("local-only push receipt names the exact effect and retained workspace", async () => {
  const { deriveReceipt } = await loadReceipt();
  const receipt = deriveReceipt(resultWith(
    [effect("push_current_pr", "Push current PR")],
    { published: false, localWorkspaceRetained: true }
  ));
  assert.equal(receipt.effectLabel, "Push current PR");
  assert.equal(receipt.localRetained, true);
  assert.equal(receipt.canRefresh, false);
  assert.equal(receipt.nextScope, "current_pr");
  assert.match(receipt.retentionText, /remains in the local workspace/);
});

test("published commit with a separate repo exception stays refreshable", async () => {
  const { deriveReceipt } = await loadReceipt();
  const receipt = deriveReceipt(resultWith(
    [effect("push_current_pr", "Push current PR", "authorized"), effect("request_repo_reviewer", "Request reviewer")],
    { published: true, localWorkspaceRetained: false }
  ));
  assert.equal(receipt.effectLabel, "Request reviewer");
  assert.equal(receipt.localRetained, false);
  assert.equal(receipt.canRefresh, true);
  assert.equal(receipt.nextScope, "current_repo");
  assert.match(receipt.retentionText, /update was published/);
});

test("connected-service exceptions recommend only the matching session scope", async () => {
  const { deriveReceipt } = await loadReceipt();
  const receipt = deriveReceipt(resultWith(
    [effect("call_connected_service", "Notify Linear")],
    { published: true }
  ));
  assert.equal(receipt.nextScope, "connected_services");
  assert.equal(receipt.nextLabel, "Use connected services scope next session");
});
