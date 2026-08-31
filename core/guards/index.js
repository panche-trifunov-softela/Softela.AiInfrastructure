"use strict";

/**
 * Discovers and validates the rule registry.
 *
 * Every `*.js` file in this directory except this one is treated as a rule
 * module. A malformed module is skipped and recorded on `loadErrors` — one
 * broken rule file must never disable every other rule.
 *
 * That isolation covers the whole per-file pipeline — `require()` AND shape
 * validation share a single `try`, in that order, for one file at a time —
 * not only the load step: a module that requires cleanly but throws while
 * `validate()` merely reads one of its fields (a getter that throws instead
 * of returning, for example) is exactly as isolated as a plain syntax error.
 * Nothing here is allowed to propagate out of the per-file loop and abort
 * the whole module — that would make `require("./guards")` itself throw,
 * and `core/engine.js#defaultRules` would then report an EMPTY catalogue
 * instead of "every rule but one."
 */

const fs = require("fs");
const path = require("path");

/** Stacks a rule's "stacks" field may name — see CONTRACTS.md §8a. */
const KNOWN_STACKS = new Set(["frontend", "backend"]);

/**
 * Validates a loaded module against the rule contract.
 *
 * @param {object} mod The required module.
 * @param {string} expectedId The filename, without `.js`, the module was
 * loaded from.
 * @returns {string | null} A description of the first problem found, or
 * `null` when the module is a well-formed rule.
 */
function validate(mod, expectedId) {
  if (!mod || typeof mod !== "object") return "module does not export an object";
  if (typeof mod.id !== "string" || !mod.id) return "missing id";
  if (mod.id !== expectedId) return `id "${mod.id}" does not match filename "${expectedId}.js"`;
  if (typeof mod.title !== "string" || !mod.title) return "missing title";
  if (!Array.isArray(mod.events) || mod.events.length === 0) return "events must be a non-empty array";
  if (mod.defaultAction !== "deny" && mod.defaultAction !== "ask") return "defaultAction must be \"deny\" or \"ask\"";
  if (mod.group !== "git" && mod.group !== "code" && mod.group !== "agent") {
    return "group must be \"git\", \"code\" or \"agent\"";
  }
  if (mod.requiresConfig !== undefined && !Array.isArray(mod.requiresConfig)) {
    return "requiresConfig must be an array when present";
  }
  if (mod.mandatory !== undefined && typeof mod.mandatory !== "boolean") {
    return "mandatory must be a boolean when present";
  }
  if (mod.newCodeOnly !== undefined && typeof mod.newCodeOnly !== "boolean") {
    return "newCodeOnly must be a boolean when present";
  }
  if (mod.stacks !== undefined) {
    if (!Array.isArray(mod.stacks) || mod.stacks.length === 0) return "stacks must be a non-empty array when present";
    for (const stack of mod.stacks) {
      if (!KNOWN_STACKS.has(stack)) return `stacks contains an unrecognised stack "${stack}"`;
    }
  }
  if (typeof mod.evaluate !== "function") return "missing evaluate function";
  return null;
}

/** Problems found while loading rule modules, as `{file, error}`. */
const loadErrors = [];
/** The successfully loaded rules, sorted alphabetically by id. */
const rules = [];
/** The successfully loaded rules, keyed by id. */
const byId = {};

let files = [];
try {
  files = fs
    .readdirSync(__dirname)
    .filter((f) => f.toLowerCase().endsWith(".js") && f !== "index.js")
    .sort();
} catch (error) {
  loadErrors.push({ file: null, error: String((error && error.message) || error) });
}

for (const file of files) {
  const expectedId = file.slice(0, -3);
  // `require()` and `validate()` share this one `try` deliberately: a
  // module that loads fine but throws while validate() merely reads one of
  // its fields (a throwing getter, for example) must be isolated exactly
  // like a `require()`-time syntax error, or this loop could still abort
  // partway through and leave every file after it unprocessed.
  try {
    const mod = require(path.join(__dirname, file));
    const problem = validate(mod, expectedId);
    if (problem) {
      loadErrors.push({ file, error: problem });
      continue;
    }
    rules.push(mod);
    byId[mod.id] = mod;
  } catch (error) {
    loadErrors.push({ file, error: String((error && error.message) || error) });
  }
}

module.exports = { rules, byId, loadErrors };
