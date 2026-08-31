#!/usr/bin/env node
"use strict";

/**
 * Standalone helper process for `memory-as-context-stdin.test.js`.
 *
 * `child_process.spawnSync` cannot reproduce the condition this test proves
 * a fix for: without an explicit `input`, Node closes a synchronous child's
 * stdin pipe almost immediately, which is not what a host that opens a pipe
 * and simply never writes to it or closes it actually does. This script
 * spawns the target script with the asynchronous `child_process.spawn`
 * instead — which genuinely keeps `child.stdin` open until something closes
 * it — and never writes to or ends that stream, then reports how the child
 * behaved as one line of JSON on this script's own stdout.
 *
 * The test itself invokes this script synchronously via `spawnSync`, so the
 * test harness's own synchronous `test()` callback still works unchanged;
 * only this intermediary process needs an event loop to hold the pipe open
 * and to time the child out if it never exits on its own.
 *
 * Usage: `node _stdin-holder.js <safetyTimeoutMs> <targetScript> [...args]`
 */

const { spawn } = require("child_process");

const [, , safetyTimeoutMsArg, targetScript, ...targetArgs] = process.argv;
const safetyTimeoutMs = Number(safetyTimeoutMsArg);

const start = Date.now();
const child = spawn(process.execPath, [targetScript, ...targetArgs], { stdio: ["pipe", "pipe", "pipe"] });

// Deliberately never written to and never closed — the exact condition a
// bare synchronous `fs.readFileSync(0)` blocks forever against.
child.stdout.resume();
child.stderr.resume();

let settled = false;

/**
 * Reports the outcome once, however the child ended up terminating, and
 * exits this script itself.
 *
 * @param {{code: number | null, signal: string | null, killedBySafetyTimeout: boolean}} outcome
 * The child's own exit code and signal, plus whether this script had to
 * intervene because the child never exited on its own within
 * {@link safetyTimeoutMs}.
 * @returns {void}
 */
function report(outcome) {
  if (settled) return;
  settled = true;
  clearTimeout(safetyTimer);
  process.stdout.write(JSON.stringify({ elapsedMs: Date.now() - start, ...outcome }));
  process.exit(0);
}

// A circuit breaker only — this must never be what makes a passing run look
// fast. If the target script is still blocked on stdin when this fires, the
// child is killed outright and the outcome is reported as a failure to the
// caller, which has its own, tighter budget to assert against.
const safetyTimer = setTimeout(() => {
  child.kill("SIGKILL");
  report({ code: null, signal: null, killedBySafetyTimeout: true });
}, safetyTimeoutMs);

child.once("exit", (code, signal) => {
  report({ code, signal, killedBySafetyTimeout: false });
});
