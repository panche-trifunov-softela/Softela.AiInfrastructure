"use strict";

/**
 * The scenario registry: every scenario `tools/acceptance/run.js` can run,
 * keyed by its own `id`. Each entry is data — a prompt, a repository
 * fixture spec, which assertions apply, and which recorded fixture backs
 * non-`--live` scoring — never behaviour; the behaviour lives entirely in
 * `tools/acceptance/score.js`.
 */

const crossRepoDelegation = require("./cross-repo-delegation");
const trivialRead = require("./trivial-read");

/** Every known scenario, keyed by id. */
const SCENARIOS = {
  [crossRepoDelegation.id]: crossRepoDelegation,
  [trivialRead.id]: trivialRead,
};

/**
 * Resolves a scenario by id.
 *
 * @param {string} id The scenario id.
 * @returns {object | null} The scenario, or `null` when `id` is not known.
 */
function getScenario(id) {
  return Object.prototype.hasOwnProperty.call(SCENARIOS, id) ? SCENARIOS[id] : null;
}

module.exports = { SCENARIOS, getScenario };
