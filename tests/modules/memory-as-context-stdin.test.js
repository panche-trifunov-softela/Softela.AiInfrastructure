"use strict";

const path = require("path");
const { spawnSync } = require("child_process");
const { suite } = require("../harness");
const { paths } = require("./_helpers");
const coreHookStdin = require("../../core/lib/hook-stdin");
const dispatchCore = require("../../adapters/shared/dispatch-core");
const moduleStdinShim = require("../../modules/memory-as-context/hooks/stdin");

const HOOKS_DIR = path.join(paths.repoRoot(), "modules", "memory-as-context", "hooks");
const HOLDER_SCRIPT = path.join(__dirname, "_stdin-holder.js");

/**
 * Wall-clock budget a hook must exit within once stdin has actually
 * arrived (or timed out internally) — well above `core/lib/hook-stdin.js`'s
 * own 500ms `STDIN_TIMEOUT_MS`, to absorb process-startup and filesystem
 * overhead without tolerating an actual hang.
 */
const EXIT_BUDGET_MS = 2000;

/**
 * How long `_stdin-holder.js` waits before forcibly killing a hook that
 * never exits on its own — a circuit breaker so a regression fails this
 * test instead of hanging the test runner.
 */
const SAFETY_TIMEOUT_MS = 8000;

/**
 * Every argument flag one of this module's four stdin-reading hooks might
 * read, so none of them exits early for lacking a flag it needs.
 *
 * @param {string} agentHome A real, disposable agent home directory.
 * @returns {string[]} `--agent=claude --agent-home=<home> --location=infrastructure --checkpoint=on`.
 */
function hookArgs(agentHome) {
  return ["--agent=claude", `--agent-home=${agentHome}`, "--location=infrastructure", "--checkpoint=on"];
}

/**
 * A directory guaranteed to hold no `module.json`, handed to every hook
 * subprocess here as `seed-memory.js`'s catalogue-directory override, so
 * `inject-memory.js`'s own seed-before-read call (and `seed-memory.js`
 * itself, tested directly below) never depends on this repository's real,
 * independently-evolving `modules/memory-as-context/seed/` content — this
 * file only cares about stdin-hang safety, not about what seeding actually
 * does.
 */
let noSeedCatalogDir;

/**
 * Runs one of this module's hook scripts through `_stdin-holder.js`, which
 * holds the child's stdin pipe open — never written to, never closed — the
 * exact condition a bare synchronous `fs.readFileSync(0)` blocks forever
 * against.
 *
 * @param {string} script The script's file name under `hooks/`.
 * @param {string} agentHome A real, disposable agent home directory.
 * @returns {{elapsedMs: number, code: number | null, signal: string | null, killedBySafetyTimeout: boolean}}
 * How long the hook actually took to exit, its exit code and signal, and
 * whether the holder had to kill it after {@link SAFETY_TIMEOUT_MS}.
 */
function runWithOpenStdin(script, agentHome) {
  const scriptPath = path.join(HOOKS_DIR, script);
  const result = spawnSync(
    process.execPath,
    [HOLDER_SCRIPT, String(SAFETY_TIMEOUT_MS), scriptPath, ...hookArgs(agentHome)],
    { timeout: SAFETY_TIMEOUT_MS + 5000, encoding: "utf8", env: { ...process.env, SOFTELA_AI_SEED_CATALOG_DIR: noSeedCatalogDir } },
  );
  if (result.status !== 0 || !result.stdout) {
    throw new Error(`_stdin-holder.js itself failed to report an outcome: ${JSON.stringify(result)}`);
  }
  return JSON.parse(result.stdout);
}

/** The five hook scripts in this module that read a host payload from stdin. */
const STDIN_READING_HOOKS = ["guard-memory.js", "inject-memory.js", "memory-autocommit.js", "compact-checkpoint.js", "seed-memory.js"];

suite("modules/memory-as-context: stdin never hangs against an open, unwritten pipe", ({ test, ok, eq, tmpdir }) => {
  noSeedCatalogDir = tmpdir();

  test("core/lib/hook-stdin.js is the single implementation — adapters/shared/dispatch-core.js re-exports it unchanged", () => {
    ok(dispatchCore.readStdin === coreHookStdin.readStdin, "dispatch-core.readStdin must be the exact same function, not a second copy");
    ok(dispatchCore.parsePayload === coreHookStdin.parsePayload, "dispatch-core.parsePayload must be the exact same function, not a second copy");
  });

  test("modules/memory-as-context/hooks/stdin.js resolves to the same core implementation, not a copy", () => {
    ok(moduleStdinShim.readStdin === coreHookStdin.readStdin, "the module shim must re-export the canonical readStdin, not reimplement it");
    ok(moduleStdinShim.parsePayload === coreHookStdin.parsePayload, "the module shim must re-export the canonical parsePayload, not reimplement it");
  });

  for (const script of STDIN_READING_HOOKS) {
    test(`${script}: exits on its own well within ${EXIT_BUDGET_MS}ms when the host's stdin pipe is opened but never written to or closed`, () => {
      const { elapsedMs, code, signal, killedBySafetyTimeout } = runWithOpenStdin(script, tmpdir());
      ok(!killedBySafetyTimeout, `${script} never exited on its own — it had to be killed after the ${SAFETY_TIMEOUT_MS}ms safety timeout`);
      eq(signal, null, `${script} should exit on its own, not be killed by a signal`);
      eq(code, 0, `${script} should exit 0 even when stdin never arrives`);
      ok(elapsedMs < EXIT_BUDGET_MS, `${script} took ${elapsedMs}ms to exit against an open stdin pipe, expected under ${EXIT_BUDGET_MS}ms`);
    });
  }
});
