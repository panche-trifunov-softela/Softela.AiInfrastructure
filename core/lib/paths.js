"use strict";

/**
 * Path resolution for both host homes.
 *
 * Every other module reaches the filesystem through these functions instead
 * of calling `os.homedir()` directly, so the whole repository can be pointed
 * at a disposable fake home in tests via `SOFTELA_AI_HOME`.
 */

const os = require("os");
const path = require("path");

/**
 * Resolves the effective home directory.
 *
 * @returns {string} `SOFTELA_AI_HOME` when set, otherwise `os.homedir()`.
 */
function homeDir() {
  return process.env.SOFTELA_AI_HOME || os.homedir();
}

/**
 * Resolves Claude Code's home directory.
 *
 * @returns {string} `<home>/.claude`.
 */
function claudeHome() {
  return path.join(homeDir(), ".claude");
}

/**
 * Resolves Codex's home directory.
 *
 * @returns {string} `<home>/.codex`.
 */
function codexHome() {
  return path.join(homeDir(), ".codex");
}

/**
 * Resolves the home directory for a given agent.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @returns {string} The agent's home directory.
 */
function agentHome(agent) {
  return agent === "codex" ? codexHome() : claudeHome();
}

/**
 * Resolves the directory this repository writes its own state into.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @returns {string} `<agentHome>/.softela-ai`.
 */
function stateDir(agent) {
  return path.join(agentHome(agent), ".softela-ai");
}

/**
 * Resolves the installer's ownership manifest path.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @returns {string} `<stateDir>/manifest.json`.
 */
function manifestPath(agent) {
  return path.join(stateDir(agent), "manifest.json");
}

/**
 * Resolves the local, never-distributed overrides file.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @returns {string} `<stateDir>/overrides.json`.
 */
function overridesPath(agent) {
  return path.join(stateDir(agent), "overrides.json");
}

/**
 * Formats a date the way the guard-activity log names its files.
 *
 * Local time, not UTC: the log is a developer-facing record of what happened
 * during their working day, and a UTC rollover would split an evening's work
 * across two files for anyone west of Greenwich.
 *
 * @param {Date} date The date to format.
 * @returns {string} The date as `YYYY-MM-DD`.
 */
function formatLogDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Resolves the guard-activity log path for one calendar day.
 *
 * The date is taken as an argument rather than read off the clock in here,
 * so this helper stays testable against a fixed date instead of whatever day
 * happens to be current when a test runs. Callers that do mean "today" format
 * it with `formatLogDate` above, so the process writing the log and the one
 * reading it can never disagree about which file that is.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @param {string} date The day the log covers, already formatted
 * `YYYY-MM-DD`.
 * @returns {string} `<stateDir>/logs/guard-activity-<date>.jsonl`.
 */
function guardLogPath(agent, date) {
  return path.join(stateDir(agent), "logs", `guard-activity-${date}.jsonl`);
}

/**
 * Resolves the directory the installer copies pre-write backups into.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @returns {string} `<stateDir>/backups`.
 */
function backupsDir(agent) {
  return path.join(stateDir(agent), "backups");
}

/**
 * Resolves the directory shipped files are installed into.
 *
 * Distinct from {@link stateDir}, which holds this repository's own state
 * rather than the copied files themselves.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @returns {string} `<agentHome>/softela-ai`.
 */
function installedRoot(agent) {
  return path.join(agentHome(agent), "softela-ai");
}

/**
 * Resolves the root of this repository.
 *
 * @returns {string} The repository root, derived from `__dirname`, never
 * from the process's current working directory.
 */
function repoRoot() {
  return path.resolve(__dirname, "..", "..");
}

/**
 * Detects which agents have a home directory present on this machine.
 *
 * @returns {string[]} The subset of `["claude", "codex"]` whose home
 * directory exists.
 */
function detectAgents() {
  const fs = require("fs");
  const agents = [];
  for (const agent of ["claude", "codex"]) {
    try {
      if (fs.existsSync(agentHome(agent))) agents.push(agent);
    } catch {
      // Fail open: an unreadable home simply is not detected.
    }
  }
  return agents;
}

module.exports = {
  homeDir,
  claudeHome,
  codexHome,
  agentHome,
  stateDir,
  manifestPath,
  overridesPath,
  formatLogDate,
  guardLogPath,
  backupsDir,
  installedRoot,
  repoRoot,
  detectAgents,
};
