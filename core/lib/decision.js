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

/**
 * Decides whether a candidate decision displaces the one already kept.
 *
 * The more severe action wins. At equal severity the incumbent stays — the
 * earlier rule in registry order, or the earlier operation in extraction
 * order — with one exception: a genuine `ask` (a question for the developer)
 * displaces an advisory `ask` (a nudge), so a nudge registered earlier can
 * never hide a prompt that has to be answered.
 *
 * @param {{action: string, advisory?: boolean}} candidate The decision under
 * consideration.
 * @param {{action: string, advisory?: boolean} | null | undefined} incumbent
 * The decision kept so far, if any.
 * @returns {boolean} `true` when the candidate should replace the incumbent.
 */
function outranks(candidate, incumbent) {
  if (!incumbent) return true;

  const candidateSeverity = severity(candidate.action);
  const incumbentSeverity = severity(incumbent.action);
  if (candidateSeverity !== incumbentSeverity) return candidateSeverity > incumbentSeverity;

  return candidate.action === "ask" && candidate.advisory !== true && incumbent.advisory === true;
}

module.exports = { SEVERITY, deny, ask, pass, severity, clamp, outranks };
