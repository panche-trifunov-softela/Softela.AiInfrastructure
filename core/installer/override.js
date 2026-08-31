"use strict";

/**
 * Business logic behind `softela-ai override` (INSTALLER.md's override CLI
 * section): sets a local softening override for one rule, lists what is
 * currently active, and undoes the most recent change.
 *
 * `overrides.json` is otherwise hand-edited only (`core/lib/override-resolver.js`
 * reads it, nothing else in this repository writes it) — every write this
 * module makes reuses `apply.js`'s own backup mechanics (`backupStamp`,
 * `relToHome`) so an override change lands in the exact same
 * `<agentHome>/.softela-ai/backups/<timestamp>/` tree an install or update
 * would use, rather than inventing a second backup scheme.
 */

const fs = require("fs");
const path = require("path");
const { readText, readJson, writeTextAtomic, writeJsonAtomic, copyFileSafe } = require("../lib/fs-safe");
const paths = require("../lib/paths");
const { severity } = require("../lib/decision");
const apply = require("./apply");
const doctor = require("./doctor");

/** The only three actions a rule, or an override, can carry. */
const ACTIONS = new Set(["off", "ask", "deny"]);

/**
 * Looks up a rule's registered definition, without ever throwing.
 *
 * @param {string} ruleId The rule id.
 * @returns {{id: string, defaultAction: string, mandatory?: boolean} | null}
 * The rule, or `null` when the id is unknown or the registry itself failed
 * to load.
 */
function ruleById(ruleId) {
  try {
    return require("../guards").byId[ruleId] || null;
  } catch {
    return null;
  }
}

/**
 * Validates a request to set one override, before anything is written.
 *
 * Refuses two shapes of request that would otherwise appear to succeed and
 * then silently do nothing, because the engine (`core/engine.js`) only ever
 * clamps a rule's action down to an override's action, never up:
 *
 * - an override on a `mandatory` rule, which the engine never consults;
 *
 * - an override more severe than the rule's own `defaultAction`, which the
 *   engine's clamp would immediately soften back down.
 *
 * @param {{ruleId: string, action: string, reason: string}} request The
 * requested override.
 * @returns {{ok: true} | {ok: false, message: string}} `ok: false` carries a
 * human-readable explanation, ready to print as-is.
 */
function validateSet(request) {
  const { ruleId, action, reason } = request;

  if (!ACTIONS.has(action)) {
    return { ok: false, message: `action must be one of off, ask, deny (got "${action}").` };
  }
  if (!reason || !reason.trim()) {
    return {
      ok: false,
      message: 'a --reason is required: state why this override exists, so it is not silent drift.',
    };
  }

  const rule = ruleById(ruleId);
  if (!rule) {
    const known = (() => {
      try {
        return Object.keys(require("../guards").byId).sort().join(", ");
      } catch {
        return "(rule registry unavailable)";
      }
    })();
    return { ok: false, message: `unknown rule id "${ruleId}". Known: ${known || "(none loaded)"}` };
  }
  if (rule.mandatory) {
    return {
      ok: false,
      message: `rule "${ruleId}" is mandatory — the engine never consults an override for a mandatory rule, so writing one would silently do nothing.`,
    };
  }
  if (severity(action) > severity(rule.defaultAction)) {
    return {
      ok: false,
      message:
        `"${action}" is more severe than "${ruleId}"'s own default action ("${rule.defaultAction}"). ` +
        `An override can only soften a rule, never sharpen it — the engine clamps it back to at most "${rule.defaultAction}", ` +
        `so this would be written but have no effect. Use "${rule.defaultAction}" or something softer instead.`,
    };
  }
  return { ok: true };
}

/**
 * Deep-clones the two maps an overrides file is built from, leaving
 * anything else on the raw object behind — this module only ever writes the
 * shape `core/lib/override-resolver.js` reads.
 *
 * @param {object | null} raw A parsed overrides object, or `null` when
 * absent or unusable.
 * @returns {{rules: object, projects: object}} A fresh, independently
 * mutable copy.
 */
function cloneOverrides(raw) {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const rules = {};
  for (const [id, entry] of Object.entries(base.rules || {})) rules[id] = { ...entry };

  const projects = {};
  for (const [projectId, projectEntry] of Object.entries(base.projects || {})) {
    const projectRules = {};
    for (const [id, entry] of Object.entries((projectEntry && projectEntry.rules) || {})) projectRules[id] = { ...entry };
    projects[projectId] = { rules: projectRules };
  }

  return { rules, projects };
}

/**
 * Builds the overrides object a set request should be written as, starting
 * from whatever currently parses.
 *
 * @param {object | null} raw The current file's parsed content, or `null`.
 * @param {{ruleId: string, action: string, reason: string, projectId: string | null}} request
 * The validated request.
 * @param {number} now The write's clock, in epoch milliseconds — recorded on
 * the entry as `setAt` for the audit trail, never read by the engine.
 * @returns {object} The full object to write.
 */
function buildNextOverrides(raw, request, now) {
  const next = cloneOverrides(raw);
  const entry = { action: request.action, reason: request.reason, setAt: new Date(now).toISOString() };

  if (request.projectId) {
    if (!next.projects[request.projectId]) next.projects[request.projectId] = { rules: {} };
    next.projects[request.projectId].rules[request.ruleId] = entry;
  } else {
    next.rules[request.ruleId] = entry;
  }
  return next;
}

/**
 * Reads the current state of an agent's `overrides.json`, distinguishing
 * "absent" from "present but not valid JSON" — the latter must be backed up
 * before being replaced, never silently discarded.
 *
 * @param {string} file The overrides file path.
 * @returns {{text: string | null, raw: object | null, malformed: boolean}}
 * `text` is the raw bytes (`null` when the file does not exist); `raw` is
 * the parsed object when it is a usable `{rules, projects}` shape; `malformed`
 * is `true` when the file exists but is not that shape.
 */
function readCurrent(file) {
  const text = readText(file);
  if (text === null) return { text: null, raw: null, malformed: false };
  const raw = readJson(file);
  const usable = raw !== null && typeof raw === "object" && !Array.isArray(raw);
  return { text, raw: usable ? raw : null, malformed: !usable };
}

/**
 * Backs up a file's current bytes into a fresh backup generation, reusing
 * `apply.js`'s own stamp format and relative-path convention.
 *
 * @param {string} home The agent home.
 * @param {string} file The file about to be overwritten.
 * @param {number} now The write's clock, in epoch milliseconds.
 * @returns {string | null} The backup generation's directory, or `null` when
 * there was nothing on disk to preserve.
 */
function backupBeforeWrite(home, file, now) {
  const text = readText(file);
  if (text === null) return null;
  const backupsRoot = path.join(home, ".softela-ai", "backups", apply.backupStamp(now));
  const dest = path.join(backupsRoot, apply.relToHome(home, file));
  return copyFileSafe(file, dest) ? backupsRoot : null;
}

/**
 * Sets one override for one agent, backing up the previous content first
 * (INSTALLER.md §7's existing backup mechanism, extended to this file).
 *
 * Assumes the caller already ran {@link validateSet} — this function does
 * not re-check the escalation or mandatory-rule rules, only writes.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @param {{ruleId: string, action: string, reason: string, projectId: string | null}} request
 * The validated override request.
 * @param {{now?: number}} [options] `now` overrides the clock, mainly for
 * tests.
 * @returns {{agent: string, file: string, scope: string, backupsDir: string | null, malformed: boolean}}
 * A summary of what happened.
 */
function applySet(agent, request, options = {}) {
  const now = typeof options.now === "number" ? options.now : Date.now();
  const home = paths.agentHome(agent);
  const file = paths.overridesPath(agent);
  const current = readCurrent(file);

  const backupsDir = backupBeforeWrite(home, file, now);
  const next = buildNextOverrides(current.raw, request, now);
  writeJsonAtomic(file, next);

  return {
    agent,
    file,
    scope: request.projectId ? `project:${request.projectId}` : "global",
    backupsDir,
    malformed: current.malformed,
  };
}

/**
 * Lists every active override for an agent, in the same shape `doctor`
 * reports them in.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @returns {{scope: string, ruleId: string, action?: string, allow?: string[], reason?: string, setAt?: string}[]}
 * One entry per active override; an empty array when none exist.
 */
function listActive(agent) {
  return doctor.listOverrides(agent);
}

/**
 * Lists every backup generation for an agent that actually captured
 * `overrides.json`, oldest first — a generation created by `install` or
 * `update` for unrelated files is not a candidate for `--undo`.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @returns {string[]} Generation directory names (the ISO-ish timestamp
 * `apply.js#backupStamp` produces), sorted chronologically; an empty array
 * when the backups root cannot be read or none qualify. ISO-8601 stamps sort
 * correctly as plain strings, so no date parsing is needed.
 */
function listOverrideBackupGenerations(agent) {
  const root = paths.backupsDir(agent);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  return entries.filter((name) => readText(path.join(root, name, ".softela-ai", "overrides.json")) !== null).sort();
}

/**
 * Describes what differs between two overrides states, for `--undo`'s "what
 * changed" report.
 *
 * @param {object | null} beforeRaw The parsed content before the change.
 * @param {object | null} afterRaw The parsed content after the change.
 * @returns {string[]} One line per rule whose override was added, removed or
 * changed, sorted for stable output; an empty array when nothing differs.
 */
function diffOverrides(beforeRaw, afterRaw) {
  const before = new Map(doctor.listOverridesFromRaw(beforeRaw).map((o) => [`${o.scope} ${o.ruleId}`, o]));
  const after = new Map(doctor.listOverridesFromRaw(afterRaw).map((o) => [`${o.scope} ${o.ruleId}`, o]));
  const lines = [];

  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(key);
    const is = after.get(key);
    if (was && !is) {
      lines.push(`removed  ${was.scope}  ${was.ruleId}  (was action=${was.action || "(none)"})`);
    } else if (!was && is) {
      lines.push(`added    ${is.scope}  ${is.ruleId}  (action=${is.action || "(none)"})`);
    } else if (was && is && JSON.stringify(was) !== JSON.stringify(is)) {
      lines.push(`changed  ${is.scope}  ${is.ruleId}  action ${was.action || "(none)"} -> ${is.action || "(none)"}`);
    }
  }
  return lines.sort();
}

/**
 * Restores an agent's `overrides.json` from its most recent qualifying
 * backup generation.
 *
 * The content about to be replaced is itself backed up first, exactly like
 * any other write to this file (§7) — so an `--undo` is itself undoable by
 * running `--undo` a second time.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @param {{now?: number, dryRun?: boolean}} [options] `now` overrides the
 * clock, mainly for tests; `dryRun` computes and returns the outcome without
 * writing anything.
 * @returns {{ok: boolean, reason?: string, restoredFrom?: string, changes?: string[]}}
 * `ok: false` with a human-readable `reason` when there is nothing to
 * restore; otherwise which generation was restored from and what changed.
 */
function undo(agent, options = {}) {
  const now = typeof options.now === "number" ? options.now : Date.now();
  const generations = listOverrideBackupGenerations(agent);
  if (!generations.length) {
    return { ok: false, reason: "no backup of overrides.json exists yet for this agent — nothing to undo." };
  }

  const latest = generations[generations.length - 1];
  const backupFile = path.join(paths.backupsDir(agent), latest, ".softela-ai", "overrides.json");
  const restoredText = readText(backupFile);
  if (restoredText === null) {
    return { ok: false, reason: `backup generation "${latest}" could not be read.` };
  }

  const file = paths.overridesPath(agent);
  const currentText = readText(file);
  const changes = diffOverrides(currentText === null ? null : readJson(file), readJson(backupFile));

  if (options.dryRun) return { ok: true, dryRun: true, restoredFrom: latest, changes };

  if (currentText !== null) backupBeforeWrite(paths.agentHome(agent), file, now);
  writeTextAtomic(file, restoredText);

  return { ok: true, restoredFrom: latest, changes };
}

module.exports = {
  ACTIONS,
  validateSet,
  applySet,
  listActive,
  undo,
  buildNextOverrides,
  diffOverrides,
};
