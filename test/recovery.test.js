import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

// Values returned from the VM realm carry a foreign prototype, so compare their
// plain JSON projection (same trick as anchors.test.js).
const plain = (value) => JSON.parse(JSON.stringify(value));

// Load the browser module the same way anchors.test.js does: run it in a fresh
// VM context and read the global it exports. No DOM/chrome needed — the recovery
// decision is a pure function.
async function loadRecovery() {
  const source = await readFile(join(process.cwd(), "extension/recovery.js"), "utf8");
  const context = { globalThis: {} };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.VoicePrRecovery;
}

test("no saved bundle → recovery UI stays hidden", async () => {
  const { decideRecovery } = await loadRecovery();
  assert.deepEqual(plain(decideRecovery(null, null)), { show: false, mode: "none" });
  // A stray hand-off marker with no bundle must not conjure a banner.
  assert.deepEqual(plain(decideRecovery(null, { handedOff: true, agentId: "agent-1" })), {
    show: false,
    mode: "none",
  });
});

test("bundle saved but never handed off → genuine crash-recovery (resend)", async () => {
  const { decideRecovery } = await loadRecovery();
  const bundle = { prRef: "pr", audioB64: "x", savedAt: 1 };
  assert.deepEqual(plain(decideRecovery(bundle, null)), { show: true, mode: "undispatched" });
});

test("bundle + hand-off marker → awaiting result, NOT the false 'un-dispatched' banner (#46)", async () => {
  const { decideRecovery } = await loadRecovery();
  const bundle = { prRef: "pr", audioB64: "x", savedAt: 1 };
  const handoff = { handedOff: true, agentId: "agent-42", at: 2 };
  assert.deepEqual(plain(decideRecovery(bundle, handoff)), {
    show: true,
    mode: "awaiting-result",
    agentId: "agent-42",
  });
});

test("handed off without a captured agent id still resumes as awaiting-result", async () => {
  const { decideRecovery } = await loadRecovery();
  const bundle = { prRef: "pr", savedAt: 1 };
  assert.deepEqual(plain(decideRecovery(bundle, { handedOff: true })), {
    show: true,
    mode: "awaiting-result",
    agentId: null,
  });
});

test("legacy marker shape without handedOff:true is treated conservatively as un-dispatched", async () => {
  const { decideRecovery } = await loadRecovery();
  const bundle = { prRef: "pr", savedAt: 1 };
  // A stored object that isn't a real hand-off marker must not suppress the
  // genuine crash-recovery path.
  assert.deepEqual(plain(decideRecovery(bundle, {})), { show: true, mode: "undispatched" });
  assert.deepEqual(plain(decideRecovery(bundle, { handedOff: false })), { show: true, mode: "undispatched" });
});
