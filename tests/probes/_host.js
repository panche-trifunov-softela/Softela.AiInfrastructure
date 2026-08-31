"use strict";

/**
 * Shared host-detection and process-probing helpers for `tests/probes/`.
 *
 * A probe exercises the real `codex` or `claude` binary installed on this
 * machine, so none of this is testable in isolation the way `core/` is.
 * Everything here stays mechanical — resolving an executable, running it
 * with a bounded timeout, and disposing of a scratch home directory
 * afterwards. Deciding what a captured transcript *means* is the probe
 * file's job, not this module's.
 *
 * No dependency on a shell is used anywhere, including to resolve a
 * Windows `.cmd`/`.bat` shim: the shim is read as plain text and its real
 * script target is extracted, so the target is always invoked directly
 * through `process.execPath`, never through `cmd.exe`.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

/** How long a plain `--version` check is given before it counts as absent. */
const DEFAULT_VERSION_TIMEOUT_MS = 5000;

/**
 * Blocks the calling thread for a short duration.
 *
 * Used only to space out cleanup retries; `Atomics.wait` is part of the
 * Node standard library, so this adds no dependency.
 *
 * @param {number} ms How long to block, in milliseconds.
 * @returns {void}
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Searches `PATH` for an executable, the way a shell would, without
 * invoking one.
 *
 * @param {string} name The bare command name, e.g. `"codex"`.
 * @returns {string | null} The first matching file's absolute path, or
 * `null` when nothing on `PATH` matches.
 */
function resolveExecutable(name) {
  const pathEnv = process.env.PATH || process.env.Path || "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const isWindows = process.platform === "win32";
  const exts = isWindows ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, isWindows ? `${name}${ext}` : name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Not here — try the next candidate.
      }
    }
  }
  return null;
}

/**
 * Builds a directly-invocable command for a resolved executable, resolving
 * a Windows npm shim to the script it ultimately runs so the shim itself
 * never has to be executed through `cmd.exe`.
 *
 * @param {string} resolvedPath The absolute path returned by
 * {@link resolveExecutable}.
 * @returns {{command: string, prefixArgs: string[]} | null} A command and
 * the argument prefix to invoke it with, or `null` when the target is a
 * `.cmd`/`.bat` shim whose real script could not be located.
 */
function buildInvocation(resolvedPath) {
  const ext = path.extname(resolvedPath).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return { command: resolvedPath, prefixArgs: [] };

  let content;
  try {
    content = fs.readFileSync(resolvedPath, "utf8");
  } catch {
    return null;
  }

  // npm's generated shim always ends by invoking "%dp0%\<relative>.js" —
  // read it back out instead of asking cmd.exe to run the shim itself.
  const match = content.match(/"%dp0%\\([^"]+\.js)"/i);
  if (!match) return null;

  const jsPath = path.join(path.dirname(resolvedPath), match[1]);
  return fs.existsSync(jsPath) ? { command: process.execPath, prefixArgs: [jsPath] } : null;
}

/**
 * Runs an already-resolved invocation to completion or until it is killed
 * by its timeout, capturing everything written to stdout and stderr.
 *
 * @param {{command: string, prefixArgs: string[]}} invocation A value from
 * {@link buildInvocation}.
 * @param {string[]} args Arguments appended after the invocation's own
 * prefix arguments.
 * @param {{env?: object, cwd?: string, timeoutMs?: number, input?: string}}
 * [options] `env` defaults to the current process environment; `timeoutMs`
 * defaults to {@link DEFAULT_VERSION_TIMEOUT_MS}; `input` is written to
 * stdin and defaults to `""`, so a process that reads stdin never blocks
 * waiting on a terminal.
 * @returns {{stdout: string, stderr: string, status: number | null, signal:
 * string | null, error: Error | null, timedOut: boolean}} The captured
 * outcome. `timedOut` is `true` when the process was still running at the
 * deadline and had to be killed.
 */
function run(invocation, args, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_VERSION_TIMEOUT_MS;
  const result = spawnSync(invocation.command, [...invocation.prefixArgs, ...args], {
    cwd: options.cwd,
    env: options.env || process.env,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    encoding: "utf8",
    windowsHide: true,
    input: options.input !== undefined ? options.input : "",
  });

  const timedOut = Boolean(result.error && result.error.code === "ETIMEDOUT");
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
    signal: result.signal,
    error: result.error || null,
    timedOut,
  };
}

/**
 * Detects a host CLI and, when it can be invoked, its version.
 *
 * @param {string} name The bare command name, e.g. `"codex"` or `"claude"`.
 * @returns {{
 *   present: boolean,
 *   invocable: boolean,
 *   path: string | null,
 *   version: string | null,
 *   invocation: {command: string, prefixArgs: string[]} | null
 * }} `present` is whether anything on `PATH` matches the name. `invocable`
 * is whether this module could build a shell-free invocation for it — a
 * `.cmd` shim it could not parse leaves `present` true and `invocable`
 * false. `version` is the trimmed `--version` output, or `null` when it
 * could not be captured.
 */
function detectHost(name) {
  const resolvedPath = resolveExecutable(name);
  if (!resolvedPath) return { present: false, invocable: false, path: null, version: null, invocation: null };

  const invocation = buildInvocation(resolvedPath);
  if (!invocation) return { present: true, invocable: false, path: resolvedPath, version: null, invocation: null };

  const result = run(invocation, ["--version"]);
  const version = !result.error && result.stdout ? result.stdout.trim() : null;
  return { present: true, invocable: true, path: resolvedPath, version, invocation };
}

/**
 * Resolves Claude Code's real home directory on this machine.
 *
 * Deliberately independent of `core/lib/paths.js`, whose `SOFTELA_AI_HOME`
 * override exists precisely so tests can point away from the real
 * directory — a probe wants the opposite: the directory the installed host
 * actually reads.
 *
 * @returns {string} `<os.homedir()>/.claude`.
 */
function claudeRealHome() {
  return path.join(os.homedir(), ".claude");
}

/**
 * Resolves Codex's real home directory on this machine, for the same
 * reason as {@link claudeRealHome}.
 *
 * @returns {string} `<os.homedir()>/.codex`.
 */
function codexRealHome() {
  return path.join(os.homedir(), ".codex");
}

/**
 * Creates a disposable directory for a probe to point a host's own home
 * override at.
 *
 * @param {string} prefix A short label folded into the directory name, for
 * easier identification if cleanup ever fails to run.
 * @returns {string} The created directory's absolute path.
 */
function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Removes a disposable directory, retrying briefly when the platform still
 * holds a lock on a file the just-killed process created.
 *
 * Never throws: a directory that still cannot be removed after retrying is
 * left in the OS temp directory, which is harmless and eventually cleaned
 * up by the platform itself.
 *
 * @param {string} dir The directory to remove.
 * @returns {void}
 */
function removeTempDir(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      sleepSync(200);
    }
  }
}

/**
 * Registers a probe result with the suite, choosing between a real
 * assertion and a distinctly-recorded skip.
 *
 * The expensive work — spawning the host and inspecting what it did — runs
 * once, in `attempt`, before either path is chosen. `attempt` never runs
 * twice, so a probe that spawns a process is never spawned again just to
 * decide how to log it.
 *
 * @param {{
 *   test: (label: string, fn: () => void) => void,
 *   skip: (label: string, reason: string) => void
 * }} ctx The suite's `test` and `skip` functions.
 * @param {string} label The probe's name.
 * @param {() => {skip: string} | {assert: () => void}} attempt Runs the
 * probe and returns either `{skip: reason}` when the run was inconclusive,
 * or `{assert}` — a function performing the real assertions — when it
 * produced a decisive answer.
 * @returns {void}
 */
function runProbe(ctx, label, attempt) {
  const outcome = attempt();
  if (outcome && typeof outcome.skip === "string") {
    ctx.skip(label, outcome.skip);
    return;
  }
  ctx.test(label, outcome.assert);
}

module.exports = {
  resolveExecutable,
  buildInvocation,
  run,
  detectHost,
  claudeRealHome,
  codexRealHome,
  mkTempDir,
  removeTempDir,
  runProbe,
};
