"use strict";

/**
 * Detects a developer's pre-existing local infrastructure that would
 * collide with what this installer is about to register, so `index.js` can
 * surface it and ask before writing anything (INSTALLER.md's conflict
 * resolution section).
 *
 * A "conflict" here is not "these two entries are technically incompatible"
 * — Claude Code and Codex both merge hook entries from every registration
 * source, so a foreign and an softela-ai entry under the same event coexist
 * without error. The concern this module exists for is governance, not
 * mechanics: a developer's own hook or harness may duplicate, or quietly
 * disagree with, what the shared infrastructure now provides, and letting
 * both run side by side without a human ever having looked at that is
 * exactly the "quietly, at its own discretion" outcome the three-resolution
 * flow in `index.js` rules out.
 *
 * Every function here reads; none writes. `index.js` decides what to do
 * with the result.
 */

const path = require("path");
const mb = require("./managed-block");
const { extractHookScriptNeedle, baseVars } = require("./plan");

/**
 * Splits a shell command line into its whitespace-separated arguments,
 * treating a double- or single-quoted run as one argument with its quotes
 * stripped — just enough to recover the individual path-like tokens a hook
 * `command` string carries (e.g. `node "C:\...\dispatch.js"
 * --agent-home="..."`), without attempting a full shell grammar (this
 * installer's own generated commands are the only ones this needs to parse
 * reliably; a developer's arbitrarily complex command degrades to "no
 * token resolves under the agent home", which is the same as "outside it").
 *
 * @param {string} command The raw command string.
 * @returns {string[]} The recovered tokens, in order.
 */
function tokenizeCommand(command) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(String(command || ""))) !== null) {
    tokens.push(match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3]);
  }
  return tokens;
}

/**
 * Resolves the first token in a hook `command` string that names a path
 * under a given directory.
 *
 * @param {string} command The raw command string.
 * @param {string} home The directory a token must resolve under.
 * @returns {string | null} The resolved absolute path, or `null` when no
 * token in `command` resolves under `home` — the command is either not a
 * path-shaped token at all, or points somewhere else entirely (a repo-local
 * or company-wide script the developer runs deliberately, per INSTALLER.md's
 * "not a conflict" list).
 */
function scriptPathUnder(command, home) {
  const homeAbs = path.resolve(home);
  for (const token of tokenizeCommand(command)) {
    let resolved;
    try {
      resolved = path.resolve(token);
    } catch {
      continue;
    }
    if (resolved === homeAbs || resolved.startsWith(`${homeAbs}${path.sep}`)) return resolved;
  }
  return null;
}

/**
 * Builds every script path this installer would ever register a hook
 * against for one agent, across every module this repository ships —
 * enabled or not, so a module that was disabled but still has a lingering
 * registration reads as ours, pending removal, rather than as foreign —
 * plus every core registration the adapter fragments themselves make: the
 * dispatcher, and the `UserPromptSubmit` approval channel.
 *
 * Matching against this list, rather than against the manifest's own
 * `pointer` values, is deliberate: a manifest pointer is an array index
 * recorded at write time, and drifts the moment another entry is added or
 * removed ahead of it in the same event's array (`settings-json.js` already
 * relocates entries by needle for exactly this reason, never by a stored
 * index). Needle matching stays correct regardless of array order, and
 * degrades exactly right on a first install with no manifest at all: none of
 * these needles are on disk yet either, so every existing under-home hook
 * correctly reads as foreign.
 *
 * Every needle is resolved through `plan.js`'s own {@link baseVars} —
 * `DISPATCH` for the core dispatcher, `INSTALLED` (via {@link
 * extractHookScriptNeedle}, the same helper `plan.js` itself calls, never a
 * second copy of its logic) for a module's own script — rather than built
 * here from the raw `ctx.dispatchNeedle` / `ctx.installedRoot`: those never
 * appear verbatim inside a substituted `command` string, whose shape is
 * host-aware (quoted for Claude, bare-when-possible for Codex —
 * `plan.js#pathToken`'s own doc comment). A needle built from the raw path
 * instead would leave every one of this tool's own registrations reading as
 * foreign here.
 *
 * @param {object} ctx A gathered context (`detect.js#gather`) for one agent.
 * @returns {string[]} Every needle a `command` string is checked against;
 * always includes the core dispatcher's own.
 */
function ownedNeedles(ctx) {
  const vars = baseVars(ctx);
  // Every core registration the adapter fragments make, not just the
  // dispatcher: a core hook missing from this list reads as a foreign
  // registration on the NEXT run, and the installer then refuses to proceed
  // over a conflict with itself.
  const needles = [vars.DISPATCH, vars.APPROVE_HOOK];
  for (const mod of ctx.allModules || []) {
    for (const raw of Array.isArray(mod.json.hooks) ? mod.json.hooks : []) {
      if (!raw || raw.agent !== ctx.agent || typeof raw.command !== "string") continue;
      const needle = extractHookScriptNeedle(raw.command, vars.INSTALLED);
      if (needle) needles.push(needle);
    }
  }
  return needles;
}

/**
 * Checks whether a hook `command` string invokes one of this installer's own
 * scripts.
 *
 * @param {string} command The raw command string.
 * @param {string[]} needles As returned by {@link ownedNeedles}.
 * @returns {boolean} `true` when `command` contains any needle.
 */
function isOwnedCommand(command, needles) {
  const text = String(command || "");
  return needles.some((n) => n && text.includes(n));
}

/**
 * Finds every hook entry in an agent's host settings file (`settings.json`
 * for Claude, `hooks.json` for Codex — `ctx.settings.content` already reads
 * whichever applies) that this installer did not put there and that names a
 * script living under the agent's own home directory.
 *
 * Deliberately excluded, per INSTALLER.md's "not a conflict" list:
 * - anything matching {@link ownedNeedles} — this installer's own
 *   registration, whether from the current run or a prior one already
 *   recorded on disk;
 * - a command whose every token resolves outside the agent home — a
 *   repo-local or company-wide hook the developer runs deliberately;
 * - a directory's mere existence (`memory`, `memories`, anything else) —
 *   this function only ever reads hook registrations, never walks the
 *   filesystem, so a populated `<agentHome>/memory` or `<codexHome>/memories`
 *   is never seen here at all, regardless of what it contains.
 *
 * @param {object} ctx A gathered context (`detect.js#gather`) for one agent.
 * @returns {{event: string, hooks: {matcher: *, command: string, scriptPath: string}[]}[]}
 * One entry per host event carrying at least one foreign, under-home hook;
 * empty when there are none.
 */
function findHookConflicts(ctx) {
  const needles = ownedNeedles(ctx);
  const hooksObj = ctx.settings && ctx.settings.content && ctx.settings.content.hooks;
  if (!hooksObj || typeof hooksObj !== "object") return [];

  const groups = [];
  for (const [event, arr] of Object.entries(hooksObj)) {
    if (!Array.isArray(arr)) continue;
    const foreign = [];
    for (const entry of arr) {
      if (!entry || !Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (!h || typeof h.command !== "string") continue;
        if (isOwnedCommand(h.command, needles)) continue;
        const scriptPath = scriptPathUnder(h.command, ctx.home);
        if (!scriptPath) continue;
        foreign.push({ matcher: entry.matcher === undefined ? null : entry.matcher, command: h.command, scriptPath });
      }
    }
    if (foreign.length) groups.push({ event, hooks: foreign });
  }
  return groups;
}

/**
 * Detects a managed-instructions-block ambiguity in the agent's global
 * instructions file (`CLAUDE.md` / `AGENTS.md`) — content already carrying
 * more or less than one `BEGIN`/`END` marker pair this installer's own block
 * would sit alongside, which `managed-block.js` deliberately refuses to
 * guess its way through (see its own module doc).
 *
 * This installer never attempts to auto-resolve this one: unlike a foreign
 * hook registration, there is no safe "disable the conflicting part" action
 * for stray marker text sitting inside a developer-authored file — guessing
 * which occurrence is real is exactly what `managed-block.js` was built to
 * refuse. It is surfaced here only so it is reported instead of crashing the
 * run with an uncaught `AmbiguousBlockError` deep inside plan-building.
 *
 * @param {object} ctx A gathered context (`detect.js#gather`) for one agent.
 * @returns {{target: string, message: string} | null} The instructions
 * file's target path and the ambiguity's own explanation; `null` when the
 * file has no markers at all, or exactly the one pair this installer itself
 * would recognise as its own.
 */
function findManagedBlockConflict(ctx) {
  if (typeof ctx.agentsMdCurrent !== "string") return null;
  try {
    mb.hasBlock(ctx.agentsMdCurrent);
    return null;
  } catch (err) {
    if (err instanceof mb.AmbiguousBlockError) {
      return { target: ctx.agentsMdTargetPath, message: err.message };
    }
    throw err;
  }
}

/**
 * Detects every conflict one agent's current installation state carries.
 *
 * @param {object} ctx A gathered context (`detect.js#gather`) for one agent.
 * @returns {{agent: string, hookGroups: {event: string, hooks: object[]}[], managedBlock: {target: string, message: string} | null}}
 * The full conflict picture for this agent.
 */
function detectConflicts(ctx) {
  return { agent: ctx.agent, hookGroups: findHookConflicts(ctx), managedBlock: findManagedBlockConflict(ctx) };
}

/**
 * Checks whether a {@link detectConflicts} result carries anything at all.
 *
 * @param {{hookGroups: object[], managedBlock: object | null} | null | undefined} conflicts
 * A result from {@link detectConflicts}.
 * @returns {boolean} `true` when at least one hook conflict or a
 * managed-block ambiguity was found.
 */
function hasConflicts(conflicts) {
  return !!conflicts && ((conflicts.hookGroups && conflicts.hookGroups.length > 0) || !!conflicts.managedBlock);
}

/**
 * Builds the plan actions the `"replace"` resolution needs to disable every
 * foreign hook conflict {@link findHookConflicts} found — reusing
 * `apply.js`'s existing settings-write path (backup, atomic write, manifest
 * bookkeeping already skips a removed pointer) rather than a parallel one.
 *
 * Never touches the managed-block conflict — see {@link
 * findManagedBlockConflict}'s own doc for why that one has no safe automated
 * fix; `index.js` keeps it blocking the run regardless of the chosen
 * resolution.
 *
 * @param {object} ctx A gathered context (`detect.js#gather`) for one agent.
 * @param {{hookGroups: {event: string, hooks: {command: string}[]}[]}} conflicts
 * A result from {@link detectConflicts}.
 * @returns {object[]} One `kind: "settings", action: "remove"` plan action
 * per foreign hook — `apply.js#applyJsonSettings` already knows how to
 * execute this shape (it is the same one `plan.js` produces when a disabled
 * module's own registration is removed), backing up the target file first.
 */
function buildReplaceActions(ctx, conflicts) {
  const actions = [];
  for (const group of conflicts.hookGroups) {
    for (const hook of group.hooks) {
      actions.push({
        kind: "settings",
        agent: ctx.agent,
        target: ctx.settingsFile,
        action: "remove",
        state: "obsolete",
        event: group.event,
        needle: hook.command,
        reason: `conflict resolution "replace" — disabling your own hooks.${group.event} registration (${hook.command}) so softela-ai's own takes effect`,
        // Excluded from the generic per-line plan rendering
        // (`index.js#renderPlan`, the same way a `kind: "config-error"` entry
        // is): that renderer assumes every `kind: "settings"` action carries
        // `mode`/`module` in the shape `plan.js` always gives it, which this
        // action deliberately does not — it is not an `enforce`/`seed`
        // registration of ours, it is the developer's own foreign one being
        // removed. `index.js`'s dedicated "conflict resolution disabled"
        // summary reports it instead, correctly labelled.
        conflictRemoval: true,
      });
    }
  }
  return actions;
}

module.exports = {
  detectConflicts,
  hasConflicts,
  buildReplaceActions,
  scriptPathUnder,
  ownedNeedles,
  isOwnedCommand,
};
