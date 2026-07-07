// Thin promisified wrappers around child_process. No deps.
import { spawn } from "node:child_process";

/**
 * Run a command, buffering stdout/stderr. Rejects on non-zero exit unless
 * opts.allowFail is set (then it resolves with the failed result).
 */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
      if (opts.onStdout) opts.onStdout(d.toString());
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      if (opts.onStderr) opts.onStderr(d.toString());
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code, stdout, stderr, cmd: `${cmd} ${args.join(" ")}` };
      if (code === 0 || opts.allowFail) resolve(result);
      else
        reject(
          new Error(
            `\`${cmd} ${args.join(" ")}\` exited ${code}\n${stderr || stdout}`
          )
        );
    });
    if (opts.stdin != null) {
      // If the child exits before draining stdin, the write emits EPIPE on this
      // stream; without a listener that becomes an uncaught exception and used
      // to crash the whole bridge. The `close` handler above already reports the
      // real failure, so swallow the pipe error here.
      child.stdin.on("error", () => {});
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}

/** Convenience: run `gh` and parse JSON stdout. */
export async function ghJson(args, opts = {}) {
  const { stdout } = await run("gh", args, opts);
  return JSON.parse(stdout);
}
