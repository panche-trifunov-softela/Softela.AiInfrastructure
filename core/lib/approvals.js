"use strict";

/**
 * Session approvals — the "yes" that makes `ask` usable (CONTRACTS §7a).
 *
 * State lives at `<agentHome>/.softela-ai/approvals.json`, a flat map of rule id
 * to `{until, scope}`. Every function accepts an injected `file` so tests
 * never touch a real agent home, and every function fails open: a missing,
 * unreadable or malformed file behaves exactly like no approval at all
 * rather than throwing.
 */

const path = require("path");
const { readJson, writeJsonAtomic } = require("./fs-safe");
const { stateDir } = require("./paths");

/** Approvals never persist indefinitely; this is the default grant length. */
const DEFAULT_MINUTES = 60;

/**
 * Resolves the default approvals file for an agent.
 *
 * @param {string} [agent] `"claude"` or `"codex"`; anything else resolves to
 * Claude's home.
 * @returns {string} `<agentHome>/.softela-ai/approvals.json`.
 */
function approvalsPath(agent) {
  return path.join(stateDir(agent === "codex" ? "codex" : "claude"), "approvals.json");
}

/**
 * Resolves the file an approvals call should read or write: the caller's
 * explicit override when given, otherwise the default path for its agent.
 *
 * @param {{file?: string, agent?: string}} options Caller-supplied options.
 * @returns {string} The file path to use.
 */
function resolveFile(options) {
  return (options && options.file) || approvalsPath(options && options.agent);
}

/**
 * Resolves the clock a call should measure expiry against.
 *
 * @param {{now?: number}} options Caller-supplied options.
 * @returns {number} `options.now` when it is a number, otherwise the real
 * current time.
 */
function resolveNow(options) {
  return options && typeof options.now === "number" ? options.now : Date.now();
}

/**
 * Checks whether a rule has a live approval.
 *
 * @param {string} ruleId The rule's id.
 * @param {{file?: string, agent?: string, now?: number}} [options] `file`
 * overrides the default approvals path, mainly for tests; `agent` selects
 * which host's default path to use when `file` is absent; `now` overrides
 * the clock, mainly for tests — the engine passes its own so evaluation stays
 * deterministic.
 * @returns {boolean} `true` when the file holds an entry for `ruleId` whose
 * `until` timestamp is still in the future. `false` on any missing, expired
 * or malformed state, and never throws.
 */
function isApproved(ruleId, options = {}) {
  try {
    const data = readJson(resolveFile(options));
    if (!data || typeof data !== "object") return false;
    const entry = data[ruleId];
    if (!entry || typeof entry.until !== "string") return false;
    const untilMs = Date.parse(entry.until);
    if (Number.isNaN(untilMs)) return false;
    return untilMs > resolveNow(options);
  } catch {
    return false;
  }
}

/**
 * Grants a time-boxed approval for a rule, replacing any existing entry for
 * the same id.
 *
 * @param {string} ruleId The rule's id.
 * @param {number} [minutes] How long the approval stays live; defaults to
 * {@link DEFAULT_MINUTES} for anything that is not a positive number.
 * @param {{file?: string, agent?: string, now?: number}} [options] Same
 * meaning as in {@link isApproved}.
 * @returns {boolean} `true` once the file has been written, `false` when the
 * write failed. Never throws.
 */
function grant(ruleId, minutes, options = {}) {
  try {
    const mins = typeof minutes === "number" && minutes > 0 ? minutes : DEFAULT_MINUTES;
    const now = resolveNow(options);
    const file = resolveFile(options);
    const data = readJson(file) || {};
    data[ruleId] = { until: new Date(now + mins * 60000).toISOString(), scope: "session-or-time" };
    writeJsonAtomic(file, data);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lists every entry currently in the approvals file, live or expired.
 *
 * @param {{file?: string, agent?: string, now?: number}} [options] Same
 * meaning as in {@link isApproved}.
 * @returns {{ruleId: string, until: string, live: boolean}[]} One entry per
 * rule id with a well-formed `until`; an empty array when the file is
 * missing or malformed. Never throws.
 */
function list(options = {}) {
  try {
    const data = readJson(resolveFile(options));
    if (!data || typeof data !== "object") return [];
    const now = resolveNow(options);
    return Object.keys(data)
      .filter((ruleId) => data[ruleId] && typeof data[ruleId].until === "string")
      .map((ruleId) => ({
        ruleId,
        until: data[ruleId].until,
        live: Date.parse(data[ruleId].until) > now,
      }));
  } catch {
    return [];
  }
}

module.exports = { DEFAULT_MINUTES, approvalsPath, isApproved, grant, list };
