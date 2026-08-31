"use strict";

/**
 * Resolves the local overrides file into a per-rule lookup.
 *
 * The file this reads is never created, written, or read by anything else
 * in this repository — it is purely a local softening knob a developer
 * maintains by hand at `<agentHome>/.softela-ai/overrides.json`.
 */

const { readJson } = require("./fs-safe");
const { compileAll } = require("./safe-regexp");
const { clamp } = require("./decision");
const { overridesPath } = require("./paths");

/** Actions a rule override may soften a decision to — mirrors `overrides.schema.json`'s `ruleOverride.action` enum. */
const ACTIONS = new Set(["off", "ask", "deny"]);

/**
 * Looks up the registered rule modules, without ever throwing.
 *
 * Used to classify override entries for `doctor` — an unknown rule id, or
 * one whose rule is `mandatory` — without letting a broken or empty
 * registry crash the lookup itself.
 *
 * @returns {Record<string, {mandatory?: boolean}>} Rule id -> rule module;
 * empty when the registry cannot be loaded.
 */
function registryRules() {
  try {
    return require("../guards").byId || {};
  } catch {
    return {};
  }
}

/**
 * Looks up the registered rule ids, without ever throwing.
 *
 * Used only to classify unknown rule ids for `doctor`; a failure here
 * (including the guards directory being empty) simply yields an empty set,
 * so every id is reported as unknown rather than the lookup crashing.
 *
 * @returns {Set<string>} The known rule ids.
 */
function knownRuleIds() {
  return new Set(Object.keys(registryRules()));
}

/**
 * Classifies one raw override entry against the rule registry, for
 * `doctor`'s "a machine that has quietly disabled half the rule set should
 * be obvious" requirement (CONTRACTS.md §6) — three states, not one
 * undifferentiated list:
 *
 * - `"effective"` — the rule is registered, is not `mandatory`, and the
 *   entry resolves to a usable `action` and/or at least one `allow` pattern
 *   that actually compiles.
 * - `"ignored"` — the rule is registered but `mandatory`; `core/engine.js`
 *   never consults an override for a mandatory rule (§6), so this entry
 *   changes nothing no matter what it says.
 * - `"invalid"` — the rule id is not registered, the entry's shape is wrong
 *   (a non-string/unrecognised `action`, an `allow` that is not an array),
 *   or every `allow` pattern fails to compile with no usable `action`
 *   either — the entry does not, and never will, soften anything.
 *
 * @param {string} ruleId The rule id the entry is written against.
 * @param {*} entry The raw entry, of whatever shape a hand-edited file wrote.
 * @returns {{state: "effective"|"ignored"|"invalid", problems: string[]}}
 * `problems` lists every issue found; it can be non-empty even when `state`
 * is `"effective"` (e.g. one bad pattern alongside an otherwise usable one).
 */
function classifyOverrideEntry(ruleId, entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { state: "invalid", problems: ["override entry must be an object"] };
  }

  const problems = [];
  let structurallyValid = true;

  const hasAction = entry.action !== undefined;
  if (hasAction && typeof entry.action !== "string") {
    problems.push(`action must be a string ("off", "ask" or "deny"), got ${typeof entry.action}`);
    structurallyValid = false;
  } else if (hasAction && !ACTIONS.has(entry.action)) {
    problems.push(`action "${entry.action}" is not one of off, ask, deny`);
    structurallyValid = false;
  }

  const hasAllow = entry.allow !== undefined;
  if (hasAllow && !Array.isArray(entry.allow)) {
    problems.push("allow must be an array of regex pattern strings");
    structurallyValid = false;
  }

  const rule = registryRules()[ruleId];
  if (!rule) {
    problems.push("unknown rule id — not a registered rule, this override can never match anything");
    structurallyValid = false;
  }

  const { regexps, invalid: badPatterns } = compileAll(hasAllow && Array.isArray(entry.allow) ? entry.allow : []);
  for (const bad of badPatterns) problems.push(`allow pattern ${JSON.stringify(bad)} is not a valid regular expression`);

  if (!structurallyValid) return { state: "invalid", problems };
  if (rule.mandatory) return { state: "ignored", problems };

  const usableAction = hasAction && ACTIONS.has(entry.action);
  if (!usableAction && regexps.length === 0) {
    if (!problems.length) problems.push("neither the action nor any allow pattern is usable — this override has no effect");
    return { state: "invalid", problems };
  }

  return { state: "effective", problems };
}

/**
 * Reads a single rule's raw override entry from a `rules` map.
 *
 * @param {object | undefined} rulesMap The `rules` map to read from.
 * @param {string} id The rule id.
 * @returns {object | undefined} The raw entry, or `undefined` when absent.
 */
function readEntry(rulesMap, id) {
  return rulesMap && typeof rulesMap === "object" ? rulesMap[id] : undefined;
}

/**
 * Resolves overrides for an agent and project into a per-rule lookup.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @param {string} projectId The resolved project's id.
 * @param {{file?: string}} [options] `file` overrides the default
 * `<agentHome>/.softela-ai/overrides.json` location, mainly for tests.
 * @returns {{
 *   forRule: (id: string) => {action: string | undefined, allow: RegExp[], reason: string | undefined},
 *   invalid: string[],
 *   raw: object | null
 * }} The resolved lookup. Never throws; a missing or malformed file yields
 * an object whose `forRule` always returns no override.
 */
function resolveOverrides(agent, projectId, options = {}) {
  const file = options.file || overridesPath(agent);
  const raw = readJson(file);
  const invalid = [];

  if (raw && typeof raw === "object") {
    const known = knownRuleIds();
    const globalRules = raw.rules && typeof raw.rules === "object" ? raw.rules : {};
    const projectRules =
      raw.projects && projectId && raw.projects[projectId] && raw.projects[projectId].rules
        ? raw.projects[projectId].rules
        : {};
    for (const id of new Set([...Object.keys(globalRules), ...Object.keys(projectRules)])) {
      if (known.size && !known.has(id)) invalid.push(id);
    }
  }

  /**
   * Resolves the effective override for one rule.
   *
   * @param {string} id The rule id.
   * @returns {{action: string | undefined, allow: RegExp[], reason: string | undefined}}
   * The resolved override; `action` is `undefined` when no override applies.
   */
  function forRule(id) {
    const globalEntry = readEntry(raw && raw.rules, id);
    const projectEntry = readEntry(
      raw && raw.projects && projectId && raw.projects[projectId] && raw.projects[projectId].rules,
      id,
    );

    let action;
    if (globalEntry && typeof globalEntry.action === "string") action = globalEntry.action;
    if (projectEntry && typeof projectEntry.action === "string") {
      action = action !== undefined ? clamp(projectEntry.action, action) : projectEntry.action;
    }

    const allowPatterns = [
      ...(globalEntry && Array.isArray(globalEntry.allow) ? globalEntry.allow : []),
      ...(projectEntry && Array.isArray(projectEntry.allow) ? projectEntry.allow : []),
    ];
    const { regexps, invalid: badPatterns } = compileAll(allowPatterns);
    for (const bad of badPatterns) {
      const tag = `${id}: ${bad}`;
      if (!invalid.includes(tag)) invalid.push(tag);
    }

    const reason =
      (projectEntry && typeof projectEntry.reason === "string" && projectEntry.reason) ||
      (globalEntry && typeof globalEntry.reason === "string" && globalEntry.reason) ||
      undefined;

    return { action, allow: regexps, reason };
  }

  return { forRule, invalid, raw: raw && typeof raw === "object" ? raw : null };
}

module.exports = { resolveOverrides, classifyOverrideEntry };
