#!/usr/bin/env node
// Supervisor for the voice-pr bridge. Runs server.js and respawns it if it ever
// exits abnormally, so a fatal crash doesn't leave the PR page staring at a dead
// "bridge not reachable" — the port comes back on its own within a second.
//
//   node scripts/serve.js        (or: npm run serve)
//
// The server itself now swallows per-request errors (see server.js), so a crash
// here should be rare — this is the backstop, not the primary defense.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "server.js");

const MAX_RESTARTS = 20; // per window, to avoid a hot crash-loop
const WINDOW_MS = 60_000;
const BACKOFF_MS = 1_000;

let restarts = [];
let shuttingDown = false;

function start() {
  const child = spawn(process.execPath, [SERVER], {
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    // Clean shutdown (0) or an intentional exit (e.g. EADDRINUSE → exit 1)
    // shouldn't be respawned into a loop.
    if (code === 0) return;
    if (code === 1) {
      console.error("\n[supervisor] server exited 1 (likely port in use) — not restarting.\n");
      process.exit(1);
    }

    const now = Date.now();
    restarts = restarts.filter((t) => now - t < WINDOW_MS);
    restarts.push(now);
    if (restarts.length > MAX_RESTARTS) {
      console.error(
        `\n[supervisor] server crashed ${restarts.length} times in ${WINDOW_MS / 1000}s — giving up. Fix the underlying error and restart.\n`
      );
      process.exit(1);
    }

    console.error(
      `\n[supervisor] server exited (code=${code} signal=${signal}) — restarting in ${BACKOFF_MS}ms…\n`
    );
    setTimeout(start, BACKOFF_MS);
  });

  const forward = (sig) => () => {
    shuttingDown = true;
    child.kill(sig);
    process.exit(0);
  };
  process.once("SIGINT", forward("SIGINT"));
  process.once("SIGTERM", forward("SIGTERM"));
}

console.log("[supervisor] starting voice-pr bridge (auto-restart on crash)…");
start();
