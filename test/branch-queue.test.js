import assert from "node:assert/strict";
import test from "node:test";
import { createBranchQueue, branchQueueKey } from "../lib/branch-queue.js";

test("serializes dispatches for the same branch in enqueue order", async () => {
  const queue = createBranchQueue();
  const firstGate = deferred();
  const events = [];
  const queued = [];

  const first = queue.run("bath-tub/voice-pr:feature", async () => {
    events.push("first-start");
    await firstGate.promise;
    events.push("first-end");
    return "first";
  });
  await flushMicrotasks();

  const second = queue.run(
    "bath-tub/voice-pr:feature",
    async () => {
      events.push("second-start");
      events.push("second-end");
      return "second";
    },
    { onQueued: (detail) => queued.push(detail) }
  );
  const third = queue.run("bath-tub/voice-pr:feature", async () => {
    events.push("third-start");
    events.push("third-end");
    return "third";
  });
  await flushMicrotasks();

  assert.deepEqual(events, ["first-start"]);
  assert.deepEqual(queued, [{ key: "bath-tub/voice-pr:feature", position: 2 }]);

  firstGate.resolve();

  assert.deepEqual(await Promise.all([first, second, third]), [
    "first",
    "second",
    "third",
  ]);
  assert.deepEqual(events, [
    "first-start",
    "first-end",
    "second-start",
    "second-end",
    "third-start",
    "third-end",
  ]);
  assert.equal(queue.pending("bath-tub/voice-pr:feature"), 0);
});

test("runs dispatches for different branches concurrently", async () => {
  const queue = createBranchQueue();
  const branchAGate = deferred();
  const branchBGate = deferred();
  const events = [];

  const branchA = queue.run("bath-tub/voice-pr:feature-a", async () => {
    events.push("a-start");
    await branchAGate.promise;
    events.push("a-end");
    return "a";
  });
  const branchB = queue.run("bath-tub/voice-pr:feature-b", async () => {
    events.push("b-start");
    await branchBGate.promise;
    events.push("b-end");
    return "b";
  });
  await flushMicrotasks();

  assert.deepEqual(events, ["a-start", "b-start"]);

  branchBGate.resolve();
  assert.equal(await branchB, "b");
  assert.deepEqual(events, ["a-start", "b-start", "b-end"]);

  branchAGate.resolve();
  assert.equal(await branchA, "a");
  assert.deepEqual(events, ["a-start", "b-start", "b-end", "a-end"]);
});

test("a failed task does not poison the queue — later tasks for the same branch still run", async () => {
  const queue = createBranchQueue();
  const order = [];

  const first = queue
    .run("o/r:feat", async () => {
      order.push("first");
      throw new Error("first blew up");
    })
    .catch((e) => `caught:${e.message}`);

  const second = queue.run("o/r:feat", async () => {
    order.push("second");
    return "second-ok";
  });

  assert.equal(await first, "caught:first blew up");
  assert.equal(await second, "second-ok");
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(queue.pending("o/r:feat"), 0);
});

test("the failed task's rejection is the caller's own — it is not swallowed", async () => {
  const queue = createBranchQueue();
  await assert.rejects(
    queue.run("o/r:feat", async () => {
      throw new Error("boom");
    }),
    /boom/
  );
});

test("pending() reflects depth as tasks are enqueued and drains back to zero", async () => {
  const queue = createBranchQueue();
  const gate = deferred();

  const a = queue.run("o/r:feat", async () => {
    await gate.promise;
    return "a";
  });
  await flushMicrotasks();
  assert.equal(queue.pending("o/r:feat"), 1);

  const b = queue.run("o/r:feat", async () => "b");
  await flushMicrotasks();
  assert.equal(queue.pending("o/r:feat"), 2);
  assert.equal(queue.pending("o/r:other"), 0); // unrelated branch unaffected

  gate.resolve();
  await Promise.all([a, b]);
  assert.equal(queue.pending("o/r:feat"), 0);
});

test("onStarted fires only when a task actually begins, after the one ahead of it finishes", async () => {
  const queue = createBranchQueue();
  const gate = deferred();
  const started = [];

  const first = queue.run("o/r:feat", async () => {
    await gate.promise;
    return "first";
  }, { onStarted: () => started.push("first") });
  await flushMicrotasks();

  const second = queue.run("o/r:feat", async () => "second", {
    onStarted: () => started.push("second"),
  });
  await flushMicrotasks();

  assert.deepEqual(started, ["first"]); // second hasn't started while first holds the lock
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(started, ["first", "second"]);
});

test("rejects a non-function task and a blank key", async () => {
  const queue = createBranchQueue();
  await assert.rejects(queue.run("o/r:feat", "not a function"), /must be a function/);
  await assert.rejects(queue.run("   ", async () => 1), /key is required/);
});

test("branchQueueKey derives a stable per-branch key from the PR", () => {
  const key = branchQueueKey({ owner: "bath", repo: "voice-pr", headRefName: "feat/x" });
  assert.equal(key, "bath/voice-pr:feat/x");
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}
