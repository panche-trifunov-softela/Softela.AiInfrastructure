"use strict";

/**
 * Layer 2's scratch agent-home setup: a disposable directory this
 * repository's own `SOFTELA_AI_HOME` override (`core/lib/paths.js`) can point
 * at, plus the real CLI (`bin/softela-ai`) driven against it exactly the way a
 * developer runs it themselves — never by importing installer internals.
 *
 * Deliberately separate from `tools/acceptance/binaries.js`: building this
 * scratch home and running the install touches no agent binary at all, so
 * it can be — and, per this project's own task, MUST be — exercised on its
 * own without `--live` ever launching an agent
 * (`tests/acceptance/scratch-setup.test.js`).
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { readJson } = require("../../core/lib/fs-safe");

/** This repository's own root. */
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** The CLI entry point a scratch install is driven through. */
const CLI_PATH = path.join(REPO_ROOT, "bin", "softela-ai");

/**
 * Builds a scratch home directory — `core/lib/paths.js#homeDir`'s own
 * override target — under a caller-supplied base. Empty, exactly as a
 * machine that has never run this installer would be; the install itself is
 * a separate step ({@link installInto}), never folded into this one, so a
 * caller that only wants the empty directory (a `doctor`-shaped check, a
 * dry-run) never pays for an install it did not ask for.
 *
 * @param {string} baseDir An existing, disposable directory to nest the
 * scratch home under.
 * @returns {string} The created scratch home's absolute path.
 */
function buildScratchHome(baseDir) {
  const home = path.join(baseDir, "home");
  fs.mkdirSync(home, { recursive: true });
  return home;
}

/**
 * Runs the real `softela-ai` CLI as a subprocess against a scratch home, the
 * same technique `tests/installer/_home.js#runCli` already proved out for
 * this repository's own installer test suite.
 *
 * @param {string} home A scratch home from {@link buildScratchHome}.
 * @param {string[]} args The CLI arguments, e.g. `["install", "--agent=claude", "--yes"]`.
 * @param {{timeoutMs?: number}} [options] `timeoutMs` bounds the subprocess;
 * defaults to 60 seconds — generous next to how long a real install takes,
 * but bounded so a hang cannot block the acceptance run indefinitely.
 * @returns {{code: number, stdout: string, stderr: string}} The process's
 * exit code and captured output.
 */
function runCli(home, args, options = {}) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, SOFTELA_AI_HOME: home },
    encoding: "utf8",
    timeout: options.timeoutMs || 60000,
  });
  return { code: result.status === null ? -1 : result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

/**
 * Installs this repository's rules into a scratch home for one agent — the
 * real `softela-ai install` a developer would run, non-interactively.
 *
 * @param {string} home A scratch home from {@link buildScratchHome}.
 * @param {"claude" | "codex"} agent Which agent's rules to install.
 * @param {{timeoutMs?: number}} [options] Forwarded to {@link runCli}.
 * @returns {{code: number, stdout: string, stderr: string}} The install
 * run's result. `code === 0` on success.
 */
function installInto(home, agent, options = {}) {
  return runCli(home, ["install", `--agent=${agent}`, "--yes", "--json"], options);
}

/**
 * Reads the module set a real install actually wrote into a scratch home's
 * own local state (`<agentHome>/.softela-ai/state.json`, `core/installer/state.js`)
 * — the real developer-chosen module list, read the same way
 * `tests/installer/_home.js#readState` already reads it under a fake home,
 * rather than through `core/installer/state.js#readState`'s own
 * `SOFTELA_AI_HOME`-driven resolution, which would answer for whichever home
 * this PROCESS's own environment points at, not the scratch home
 * {@link installInto} actually installed into.
 *
 * `--live` needs this precisely because it replays a captured transcript
 * through the real dispatcher (`score.js#standardsObeyed`): the dispatcher's
 * `requiresModule`-gated guards only fire for a module actually enabled, and
 * the only trustworthy source for "actually enabled" is the state a real
 * install just wrote — never a scenario's own hand-maintained module list,
 * which can silently drift from what `softela-ai install` really does.
 *
 * @param {string} home A scratch home from {@link buildScratchHome}, already
 * installed into via {@link installInto}.
 * @param {"claude" | "codex"} agent Which agent's state to read.
 * @returns {string[]} The installed module ids, in `state.json`'s own order;
 * empty when the state file is missing, unreadable, or carries none.
 */
function readInstalledModules(home, agent) {
  const statePath = path.join(home, agent === "codex" ? ".codex" : ".claude", ".softela-ai", "state.json");
  const data = readJson(statePath);
  return data && Array.isArray(data.modules) ? data.modules : [];
}

module.exports = { REPO_ROOT, CLI_PATH, buildScratchHome, runCli, installInto, readInstalledModules };
