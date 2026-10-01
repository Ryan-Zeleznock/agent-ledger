// Entry point the agents execute for PreToolUse (interface pin 3, spec §7). Node built-ins only: this file imports
// node:process and ./watchdog.js, whose runtime imports are node:child_process, node:fs, node:process.
//
//   node <dist>/hooks/watchdog-main.js --agent <claude-code|codex> --deadline-ms <n> --timeout-s <n>
//        [--max-output-bytes <n>] -- <handler argv...>
//
// It reads the hook event from stdin, spawns the handler (no shell) and writes/exits per WatchdogResult. Any argv
// problem is a deny with `watchdog:config:<flag>` and exit 2: misconfiguration blocks, it never "continues".
import process from "node:process";
import { WATCHDOG_REASON_PREFIX, denyOutput, emitAndExit, parseWatchdogArgv, runWatchdog } from "./watchdog.js";

const parsed = parseWatchdogArgv(process.argv.slice(2));
if (!parsed.ok) {
  const reason = `${WATCHDOG_REASON_PREFIX}config:${parsed.field}`;
  emitAndExit({ stdout: denyOutput(reason), stderr: `${reason}\n`, exitCode: 2 });
} else {
  // runWatchdog never rejects; the defensive catch is still exit 2, never a crash the agent ignores.
  runWatchdog(parsed.opts).then(emitAndExit, (e: unknown) => {
    const reason = `${WATCHDOG_REASON_PREFIX}internal:${e instanceof Error ? e.message : String(e)}`;
    emitAndExit({ stdout: denyOutput(reason), stderr: `${reason}\n`, exitCode: 2 });
  });
}
