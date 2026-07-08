// Deterministic, zero-dependency stand-ins for the external binaries the bridge
// shells out to (docker, gh, ...). Everything voice-pr touches at the process
// boundary goes through lib/exec.js -> child_process.spawn, which resolves the
// command name against PATH at spawn time. So we install tiny fake executables
// on a temp dir at the FRONT of PATH: the real code runs unchanged, but every
// `docker`/`gh` invocation hits our script instead. Each call is logged (for
// assertions) and answered from a per-test rules table matched against the
// joined argv.
//
// No real containers, no network, no git pushes — and no npm deps: the fakes are
// a few lines of POSIX shell, driven by two env-var file paths.
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A generic fake: log the call, then return the stdout/exit code of the first
// rule (TSV: name \t substring-pattern \t exit-code \t single-line-stdout) whose
// name matches argv[0]'s basename and whose pattern is a substring of the argv.
const FAKE_SCRIPT = `#!/usr/bin/env bash
name="$(basename "$0")"
argstr="$*"
if [ -n "\${FAKE_CLI_LOG:-}" ]; then
  # Flatten newlines so one call is always one log line (arg values such as a
  # work-item --body are multi-line); the joined-arg matching below is unaffected.
  flat="$(printf '%s' "$argstr" | tr '\\n' ' ')"
  printf '%s\\t%s\\n' "$name" "$flat" >> "$FAKE_CLI_LOG"
fi
if [ -n "\${FAKE_CLI_RULES:-}" ] && [ -f "\${FAKE_CLI_RULES}" ]; then
  while IFS=$'\\t' read -r rname rpat rcode rout || [ -n "$rname" ]; do
    [ "$rname" = "$name" ] || continue
    case "$argstr" in
      *"$rpat"*)
        if [ -n "$rout" ]; then printf '%s\\n' "$rout"; fi
        exit "\${rcode:-0}"
        ;;
    esac
  done < "$FAKE_CLI_RULES"
fi
exit 0
`;

/**
 * Install fake executables for the given command names on the front of PATH and
 * point the fakes at a rules file + call log. Call once per test file (before the
 * module under test is imported, so PATH/env are already in place for spawn).
 * @param {string[]} commands  e.g. ["docker", "gh"]
 * @returns {{ setRules(rules:Array):void, calls():Array<{cmd,args}>, reset():void, dir:string, cleanup():void }}
 */
export function installFakeCli(commands = ["docker", "gh"]) {
  const dir = mkdtempSync(join(tmpdir(), "vp-fakecli-"));
  const rulesPath = join(dir, "rules.tsv");
  const logPath = join(dir, "calls.log");

  // Each fake is its own copy of the generic script named for the command, so
  // the script's `basename "$0"` yields the command name it must answer as.
  for (const cmd of commands) {
    const p = join(dir, cmd);
    writeFileSync(p, FAKE_SCRIPT);
    chmodSync(p, 0o755);
  }

  writeFileSync(rulesPath, "");
  writeFileSync(logPath, "");

  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.FAKE_CLI_RULES = rulesPath;
  process.env.FAKE_CLI_LOG = logPath;

  function setRules(rules = []) {
    const tsv = rules
      .map((r) => [r.cmd, r.pattern, String(r.code ?? 0), (r.stdout ?? "").replace(/\n/g, " ")].join("\t"))
      .join("\n");
    writeFileSync(rulesPath, tsv + (tsv ? "\n" : ""));
    writeFileSync(logPath, ""); // fresh call log per scenario
  }

  function calls() {
    const text = readFileSync(logPath, "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [cmd, args = ""] = line.split("\t");
        return { cmd, args };
      });
  }

  function reset() {
    writeFileSync(logPath, "");
  }

  function cleanup() {
    rmSync(dir, { recursive: true, force: true });
  }

  return { setRules, calls, reset, dir, cleanup };
}
