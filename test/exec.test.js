import assert from "node:assert/strict";
import test from "node:test";
import { run } from "../lib/exec.js";

test("run pipes stdin when provided", async () => {
  const { stdout } = await run(
    process.execPath,
    ["-e", "process.stdin.on('data', d => process.stdout.write(d))"],
    { stdin: "hello from stdin" }
  );

  assert.equal(stdout, "hello from stdin");
});
