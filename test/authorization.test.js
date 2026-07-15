import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadAuthorization() {
  const source = await readFile(new URL("../extension/authorization.js", import.meta.url), "utf8");
  const context = { globalThis: {} };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.VoicePrAuthorization;
}

test("authorization starts at PR scope and is explicitly session-local", async () => {
  const { createAuthorizationController } = await loadAuthorization();
  const controller = createAuthorizationController();
  assert.deepEqual(JSON.parse(JSON.stringify(controller.snapshot())), {
    value: "current_pr",
    label: "This pull request",
    isBroad: false,
    persistence: "session",
  });
});

test("broader authorization is labelled but never persisted into a new controller", async () => {
  const { createAuthorizationController } = await loadAuthorization();
  const first = createAuthorizationController();
  assert.equal(first.set("current_repo").isBroad, true);
  assert.equal(first.value, "current_repo");
  assert.equal(createAuthorizationController().value, "current_pr");
});

test("authorization controller refuses unknown levels", async () => {
  const { createAuthorizationController } = await loadAuthorization();
  assert.throws(() => createAuthorizationController().set("all_the_things"), /Unknown authorization level/);
});
