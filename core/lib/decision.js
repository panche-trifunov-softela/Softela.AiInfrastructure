"use strict";

/**
 * Decision constructors shared by every rule module.
 *
 * A rule never builds its result object by hand — going through these keeps
 * the shape identical for every rule and every adapter.
 */

/**
 * Severity ordering used everywhere a comparison between two actions is
 * needed.
 *
 * - `off` — the rule is disabled, weakest.
 *
 * - `ask` — the developer is prompted before the tool call proceeds.
 *
 * - `deny` — the tool call is blocked, strongest.
 */
const SEVERITY = { off: 0, ask: 1, deny: 2 };

/**
 * Builds a deny decision.
 *
 * @param {string} reason One or two sentences stating the rule and why it
 * exists.
 * @param {string} [fix] The corrected command or the concrete next step.
 * @returns {{action: "deny", reason: string, fix?: string}} The decision.
 */
function deny(reason, fix) {
  const result = { action: "deny", reason };
  if (fix !== undefined) result.fix = fix;
  return result;
}

/**
 * Builds an ask decision.
 *
 * @param {string} reason One or two sentences stating the rule and why it
 * exists.
 * @param {string} [fix] The corrected command or the concrete next step.
 * @returns {{action: "ask", reason: string, fix?: string}} The decision.
 */
function ask(reason, fix) {
  const result = { action: "ask", reason };
  if (fix !== undefined) result.fix = fix;
  return result;
}

/**
 * Builds a pass decision.
 *
 * @returns {null} A rule with nothing to say always returns `null`, never an
 * object carrying `action: "allow"`.
 */
function pass() {
  return null;
}

/**
 * Resolves the numeric severity of an action.
 *
 * @param {string} action One of `"off"`, `"ask"`, `"deny"`.
 * @returns {number} The severity, or `0` for an unrecognised action.
 */
function severity(action) {
  return SEVERITY[action] || 0;
}

/**
 * Clamps an action to at most as severe as a maximum.
 *
 * @param {string} action The action a rule wants to return.
 * @param {string} maxAction The strongest action still allowed.
 * @returns {string} Whichever of the two is less severe.
 */
function clamp(action, maxAction) {
  return severity(action) <= severity(maxAction) ? action : maxAction;
}

module.exports = { SEVERITY, deny, ask, pass, severity, clamp };
