// Thin promisified wrappers around child_process. No deps.
import { spawn } from "node:child_process";
import { getTracer } from "./trace.js";

/**
 * Run a command, buffering stdout/stderr. Rejects on non-zero exit unless
 * opts.allowFail is set (then it resolves with the failed result).
 *
 * Every spawn is traced: `exec.spawn` when it starts and `exec.exit` /
 * `exec.fail` when it ends, all tagged with the ambient session id. This is the
 * layer where the program actually touches gh/git/docker/ffmpeg/whisper, so its
 * trace is usually where an AI agent finds the real cause of a failure.
 */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const tracer = getTracer();
    const t0 = Date.now();
    tracer.event("exec.spawn", { cmd, args: redact(args), cwd: opts.cwd || null });
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
    child.on("error", (e) => {
      tracer.error("exec.error", e, { cmd });
      reject(e);
    });
    child.on("close", (code) => {
      const result = { code, stdout, stderr, cmd: `${cmd} ${args.join(" ")}` };
      const ms = Date.now() - t0;
      if (code === 0 || opts.allowFail) {
        tracer.event(code === 0 ? "exec.exit" : "exec.fail-ok", {
          cmd, code, ms, allowFail: !!opts.allowFail,
          stderr: code === 0 ? undefined : tail(stderr),
        });
        resolve(result);
      } else {
        tracer.event("exec.fail", { cmd, code, ms, stderr: tail(stderr || stdout) }, "error");
        reject(
          new Error(
            `\`${cmd} ${args.join(" ")}\` exited ${code}\n${stderr || stdout}`
          )
        );
      }
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

// Keep the trace readable + safe: cap long args (work-item bodies carry the full
// transcript) and the tail of stderr we keep for failures.
function redact(args) {
  return (args || []).map((a) =>
    typeof a === "string" && a.length > 200 ? a.slice(0, 200) + `…(+${a.length - 200})` : a
  );
}
function tail(s, n = 800) {
  s = (s || "").trim();
  return s.length > n ? "…" + s.slice(-n) : s;
}
