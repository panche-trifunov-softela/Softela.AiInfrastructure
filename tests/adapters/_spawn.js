"use strict";

/**
 * Shared child-process helper for the adapter test suites.
 *
 * Every adapter test runs a dispatcher as a real, separate Node process fed
 * a JSON payload on stdin — the same path a host actually invokes — rather
 * than calling its exported functions in-process. That is the property that
 * makes these tests worth having: a mocked call cannot catch a dispatcher
 * that hangs on stdin, writes to the wrong stream, or exits non-zero.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const paths = require("../../core/lib/paths");

/** Absolute path to Claude Code's `PreToolUse` dispatcher. */
const CLAUDE_DISPATCH = path.join(__dirname, "..", "..", "adapters", "claude", "dispatch.js");

/** Absolute path to Codex's `PreToolUse` dispatcher. */
const CODEX_DISPATCH = path.join(__dirname, "..", "..", "adapters", "codex", "dispatch.js");

/**
 * Serialises a payload for a dispatcher's stdin.
 *
 * @param {*} payload `undefined`/`null` for empty stdin; a string sent
 * verbatim, so a test can feed deliberately malformed text; anything else
 * JSON-stringified.
 * @returns {string} The bytes to write to the child's stdin.
 */
function toStdin(payload) {
  if (payload === undefined || payload === null) return "";
  if (typeof payload === "string") return payload;
  return JSON.stringify(payload);
}

/**
 * Runs a dispatcher script as a real child process.
 *
 * @param {string} dispatchPath Absolute path to the dispatcher's entry file.
 * @param {*} payload The stdin payload; see {@link toStdin}.
 * @param {{home: string, cwd?: string, env?: object, timeout?: number, args?: string[]}} options
 * `home` becomes `SOFTELA_AI_HOME` for the child, so nothing it does can touch a
 * real agent home; `cwd` is the child's working directory, defaulting to
 * `home`; `env` overrides individual environment variables on top of the
 * inherited set; `timeout` bounds how long the child may run; `args` are
 * extra argv entries after the script path, for a hook the installer invokes
 * with flags of its own (the approval channel takes `--agent=<host>`).
 * @returns {{stdout: string, stderr: string, code: number, parsed: object | null}}
 * The child's raw output; its exit code (`1` when no numeric status was
 * reported, e.g. the process was killed by a signal); and `stdout` parsed as
 * JSON when it is non-empty and valid, `null` otherwise.
 */
function runDispatcher(dispatchPath, payload, options) {
  const opts = options || {};
  if (!opts.home) throw new Error("runDispatcher requires options.home");

  const env = { ...process.env };
  delete env.SOFTELA_AI_EXIT2;
  delete env.SOFTELA_AI_DEBUG;
  env.SOFTELA_AI_HOME = opts.home;
  Object.assign(env, opts.env || {});

  const result = spawnSync(process.execPath, [dispatchPath, ...(opts.args || [])], {
    input: toStdin(payload),
    cwd: opts.cwd || opts.home,
    env,
    encoding: "utf8",
    timeout: opts.timeout || 10000,
  });

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const code = typeof result.status === "number" ? result.status : 1;

  let parsed = null;
  const trimmed = stdout.trim();
  if (trimmed) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = null;
    }
  }

  return { stdout, stderr, code, parsed };
}

/**
 * Resolves the on-disk paths a dispatcher run against a given fake home
 * would read or write, by borrowing `core/lib/paths.js` itself rather than
 * duplicating its directory-naming conventions here.
 *
 * `SOFTELA_AI_HOME` is read fresh on every call inside `core/lib/paths.js`, so
 * this only needs to hold the override for the duration of the resolution —
 * it never leaves the environment variable changed for the caller.
 *
 * @param {string} home The disposable home directory a test is using.
 * @param {"claude" | "codex"} agent Which host's paths to resolve.
 * @returns {{stateDir: string, stateFile: string, approvals: string, overrides: string, installedRoot: string}}
 * The paths the corresponding dispatcher would use for this `home`.
 */
function agentPaths(home, agent) {
  const previous = process.env.SOFTELA_AI_HOME;
  process.env.SOFTELA_AI_HOME = home;
  try {
    const dir = paths.stateDir(agent);
    return {
      stateDir: dir,
      stateFile: path.join(dir, "state.json"),
      approvals: path.join(dir, "approvals.json"),
      overrides: path.join(dir, "overrides.json"),
      installedRoot: paths.installedRoot(agent),
    };
  } finally {
    if (previous === undefined) delete process.env.SOFTELA_AI_HOME;
    else process.env.SOFTELA_AI_HOME = previous;
  }
}

/**
 * Writes this installation's local state file for an agent, mainly to
 * enable a module a rule requires or to seed adapter options such as
 * Codex's `askMode`.
 *
 * @param {string} home The disposable home directory a test is using.
 * @param {"claude" | "codex"} agent Which host's state file to write.
 * @param {object} state The state object, written verbatim as JSON.
 * @returns {void}
 */
function writeState(home, agent, state) {
  const p = agentPaths(home, agent);
  fs.mkdirSync(p.stateDir, { recursive: true });
  fs.writeFileSync(p.stateFile, JSON.stringify(state, null, 2), "utf8");
}

module.exports = { CLAUDE_DISPATCH, CODEX_DISPATCH, runDispatcher, agentPaths, writeState, toStdin };
