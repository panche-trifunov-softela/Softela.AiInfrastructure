"use strict";

/**
 * Reads and writes this installation's own local state
 * (`<agentHome>/.softela-ai/state.json`).
 *
 * Distinct from the manifest: the manifest is *what was written and its
 * hash*; state is *what the developer has chosen* — the enabled module
 * set, host-specific adapter options such as Codex's `askMode`, and the
 * option values (memory location, reply languages) modules were installed
 * with. `adapters/shared/dispatch-core.js` reads this file at every tool
 * call, so its shape here is load-bearing for the running dispatcher, not
 * only for the installer.
 */

const path = require("path");
const { readJson, writeJsonAtomic } = require("../lib/fs-safe");
const { stateDir } = require("../lib/paths");

/**
 * Resolves the state file path for an agent.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @returns {string} `<agentHome>/.softela-ai/state.json`.
 */
function statePath(agent) {
  return path.join(stateDir(agent), "state.json");
}

/**
 * Builds the default state for a fresh installation.
 *
 * @returns {{modules: string[], adapterOptions: object, options: object}}
 * An empty state: no modules enabled, no adapter options, no option
 * values. Callers fold in module defaults and CLI flags before writing.
 */
function defaultState() {
  return { modules: [], adapterOptions: {}, options: {} };
}

/**
 * Reads and normalises the local state for an agent.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @returns {{modules: string[], adapterOptions: object, options: object}}
 * The normalised state, or {@link defaultState}'s shape when the file is
 * missing, unreadable or malformed. Never throws.
 */
function readState(agent) {
  const data = readJson(statePath(agent));
  if (!data || typeof data !== "object") return defaultState();
  return {
    modules: Array.isArray(data.modules) ? data.modules : [],
    adapterOptions: data.adapterOptions && typeof data.adapterOptions === "object" ? data.adapterOptions : {},
    options: data.options && typeof data.options === "object" ? data.options : {},
  };
}

/**
 * Writes the local state for an agent, atomically.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @param {{modules: string[], adapterOptions: object, options: object}} state
 * The state to write.
 * @returns {void}
 */
function writeState(agent, state) {
  writeJsonAtomic(statePath(agent), state);
}

module.exports = { statePath, defaultState, readState, writeState };
