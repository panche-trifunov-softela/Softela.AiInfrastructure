"use strict";

/**
 * Shared fixtures and mechanics for the `tests/modules/` suites.
 *
 * Every suite that needs to prove "enable then disable leaves the home as
 * it was" drives the real `core/installer/` plan-then-apply pipeline
 * directly (`detect.gather` → `plan.buildPlan` → `apply.applyPlan`) instead
 * of reinventing install/enable/disable, so a passing test reflects the
 * mechanism a developer's machine actually runs.
 *
 * Those round-trip checks target the Codex agent specifically, simply
 * because both hosts always carry a base rulebook — `core/installer/rulebook.js`
 * generates it fresh at plan time from this run's own live facts
 * (`detect.js#gather` calls it; there is no checked-in template file any
 * more), so the managed instructions block is never empty and is always
 * rewritten on disable, on either host — a steady baseline to diff against.
 * A project with no module enabled at all still keeps its rulebook text in
 * `CLAUDE.md`/`AGENTS.md`. What `core/installer/plan.js#planGlobalInstructions`
 * clears is only the case neither the rulebook nor any module contributes
 * anything — which cannot happen on either host today, since the rulebook
 * always contributes — and that clearing path has its own regression test
 * in `tests/installer/rulebook.test.js`.
 */

const path = require("path");
const { readJson, readText, sha256, listFilesRecursive } = require("../../core/lib/fs-safe");
const paths = require("../../core/lib/paths");
const sj = require("../../core/installer/settings-json");
const st = require("../../core/installer/settings-toml");
const detect = require("../../core/installer/detect");
const plan = require("../../core/installer/plan");
const apply = require("../../core/installer/apply");
const manifestStore = require("../../core/installer/manifest");
const stateStore = require("../../core/installer/state");
const guards = require("../../core/guards");

/** Repository root, resolved the same way `core/lib/paths.js` resolves it. */
const REPO_ROOT = paths.repoRoot();

/** Fixed, obviously-fake substitution values for token-rendering checks. */
const FIXED_VARS = {
  NODE: '"C:/fake/node.exe"',
  INSTALLED: "C:/fake/home/softela-ai",
  AGENT_HOME: "C:/fake/home",
  STATE_DIR: "C:/fake/home/.softela-ai",
  VERSION: "9.9.9",
};

/**
 * Lists every module id this repository ships, by directory name.
 *
 * @returns {string[]} Directory names under `modules/`.
 */
function allModuleIds() {
  const fs = require("fs");
  try {
    return fs
      .readdirSync(path.join(REPO_ROOT, "modules"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Reads one shipped module's directory, `module.json` and prompt text.
 *
 * @param {string} id The module id; must match its directory name.
 * @returns {{id: string, dir: string, json: object | null, promptText: string | null}}
 * The loaded module. `json` is `null` when `module.json` is missing or
 * unparseable, so a validator sees a clear absence instead of throwing.
 */
function loadModule(id) {
  const dir = path.join(REPO_ROOT, "modules", id);
  const json = readJson(path.join(dir, "module.json"));
  const promptText = json && typeof json.prompt === "string" ? readText(path.join(dir, json.prompt)) : null;
  return { id, dir, json, promptText };
}

/**
 * Validates a module's `module.json` against the shape `MODULES.md`
 * documents, and cross-checks it against what actually exists on disk and
 * in the guard registry.
 *
 * @param {{id: string, dir: string, json: object | null, promptText: string | null}} mod
 * A loaded module, as returned by {@link loadModule}.
 * @returns {string[]} Every problem found; empty when the module validates
 * cleanly.
 */
function validateModuleJson(mod) {
  const j = mod.json;
  if (!j || typeof j !== "object") return ["module.json is missing or not valid JSON"];

  const problems = [];
  const knownModuleIds = new Set(allModuleIds());

  if (j.id !== mod.id) problems.push(`id "${j.id}" does not match directory name "${mod.id}"`);
  if (typeof j.title !== "string" || !j.title) problems.push("title must be a non-empty string");
  if (typeof j.summary !== "string" || !j.summary) problems.push("summary must be a non-empty string");
  if (typeof j.defaultEnabled !== "boolean") problems.push("defaultEnabled must be a boolean");
  if (!Array.isArray(j.requires)) problems.push("requires must be an array");
  if (!Array.isArray(j.guards)) problems.push("guards must be an array");
  if (!Array.isArray(j.files)) problems.push("files must be an array");
  if (!Array.isArray(j.hooks)) problems.push("hooks must be an array");
  if (!Array.isArray(j.settings)) problems.push("settings must be an array");
  if (!j.options || typeof j.options !== "object" || Array.isArray(j.options)) problems.push("options must be an object");

  for (const req of Array.isArray(j.requires) ? j.requires : []) {
    if (!knownModuleIds.has(req)) problems.push(`requires references unknown module id "${req}"`);
  }

  for (const guardId of Array.isArray(j.guards) ? j.guards : []) {
    const rule = guards.byId[guardId];
    if (!rule) problems.push(`guards references unknown rule id "${guardId}"`);
    else if (rule.requiresModule !== mod.id) {
      problems.push(`rule "${guardId}" declares requiresModule "${rule.requiresModule}", not "${mod.id}"`);
    }
  }

  if (typeof j.prompt === "string") {
    if (readText(path.join(mod.dir, j.prompt)) === null) problems.push(`prompt file "${j.prompt}" is not readable`);
  } else if (j.prompt !== undefined) {
    problems.push("prompt must be a string path when present");
  }

  for (const f of Array.isArray(j.files) ? j.files : []) {
    if (!f || typeof f.from !== "string" || typeof f.to !== "string") {
      problems.push(`files entry ${JSON.stringify(f)} must declare string "from" and "to"`);
      continue;
    }
    if (readText(path.join(mod.dir, f.from)) === null) problems.push(`files[].from "${f.from}" is not a readable file`);
  }

  for (const h of Array.isArray(j.hooks) ? j.hooks : []) {
    if (!h || (h.agent !== "claude" && h.agent !== "codex")) {
      problems.push(`hooks entry ${JSON.stringify(h)} needs agent "claude" or "codex"`);
    }
    if (!h || typeof h.event !== "string" || !h.event) problems.push(`hooks entry ${JSON.stringify(h)} needs a string event`);
    if (!h || typeof h.command !== "string" || !h.command) problems.push(`hooks entry ${JSON.stringify(h)} needs a string command`);
  }

  for (const s of Array.isArray(j.settings) ? j.settings : []) {
    if (!s || (s.agent !== "claude" && s.agent !== "codex")) {
      problems.push(`settings entry ${JSON.stringify(s)} needs agent "claude" or "codex"`);
    }
    // MODULES.md: "every model, effort and approval setting a module ships is `seed`, never `enforce`".
    if (!s || s.mode !== "seed") problems.push(`settings entry ${JSON.stringify(s)} must be mode "seed" — a module may never ship "enforce"`);
    if (!s || typeof s.pointer !== "string" || !s.pointer.startsWith("/")) {
      problems.push(`settings entry ${JSON.stringify(s)} needs a "/"-rooted pointer`);
    }
    if (s && s.pointer === "/sandbox_mode") problems.push('settings must never point at "/sandbox_mode" (MODULES.md)');
    if (s) {
      // A seed setting declares exactly one of a literal "value" (every agent)
      // or a "tier" (codex only — Codex has no bare tier alias, so a module
      // that wants to seed a cost tier rather than a version-pinned model id
      // needs it resolved at install time; MODULES.md documents both forms).
      const hasValue = Object.prototype.hasOwnProperty.call(s, "value");
      const hasTier = Object.prototype.hasOwnProperty.call(s, "tier");
      if (hasValue === hasTier) {
        problems.push(`settings entry ${JSON.stringify(s)} must declare exactly one of "value" or "tier"`);
      } else if (hasTier && s.agent !== "codex") {
        problems.push(`settings entry ${JSON.stringify(s)} declares "tier" for agent "${s.agent}" — tier resolution is codex-only`);
      }
    }
  }

  const allowedTokens = new Set(Object.keys(FIXED_VARS));
  for (const [name, def] of Object.entries(j.options || {})) {
    allowedTokens.add(`OPT_${name.toUpperCase()}`);
    if (!def || typeof def.prompt !== "string" || !def.prompt) problems.push(`options.${name} needs a string "prompt"`);
    if (def && def.type === "enum") {
      if (!Array.isArray(def.values) || !def.values.includes(def.default)) {
        problems.push(`options.${name} is an enum whose values must include its default`);
      }
    } else if (def && def.type === "stringList") {
      if (!Array.isArray(def.default)) problems.push(`options.${name} is a stringList whose default must be an array`);
    } else if (def && def.type !== undefined) {
      problems.push(`options.${name} has an unrecognised type "${def.type}"`);
    }
  }

  const tokenPattern = /\{\{([A-Z_]+)\}\}/g;
  const textsToScan = [mod.promptText || "", ...(Array.isArray(j.hooks) ? j.hooks.map((h) => (h && h.command) || "") : [])];
  for (const text of textsToScan) {
    let m;
    tokenPattern.lastIndex = 0;
    while ((m = tokenPattern.exec(text))) {
      if (!allowedTokens.has(m[1])) problems.push(`references unknown substitution token "{{${m[1]}}}"`);
    }
  }

  return problems;
}

/**
 * Renders a module's `prompt.md` with every substitution token filled in,
 * the same way `core/installer/plan.js#planGlobalInstructions` does.
 *
 * @param {{dir: string, json: object}} mod A loaded module.
 * @param {object} [optOverrides] Option values keyed by option name,
 * overriding the module's own declared default.
 * @returns {string} The rendered prompt text.
 */
function renderPrompt(mod, optOverrides = {}) {
  const text = readText(path.join(mod.dir, mod.json.prompt));
  const vars = { ...FIXED_VARS };
  for (const [name, def] of Object.entries(mod.json.options || {})) {
    const value = optOverrides[name] !== undefined ? optOverrides[name] : def.default;
    vars[`OPT_${name.toUpperCase()}`] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return sj.substitute(text, vars);
}

/**
 * Finds every `{{TOKEN}}` placeholder left unsubstituted in a string.
 *
 * @param {string} text The text to scan.
 * @returns {string[]} Every remaining placeholder, verbatim braces included.
 */
function unsubstitutedTokens(text) {
  return text.match(/\{\{[A-Z_]+\}\}/g) || [];
}

/**
 * Runs the real installer plan-then-apply pipeline for one agent — the same
 * mechanism `core/installer/index.js` drives for `install` / `module
 * enable` / `module disable`.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @param {string[]} moduleIds The module ids that should end up enabled.
 * @param {{options?: object, adapterOptions?: object}} [stateOverrides]
 * Values folded into local state before planning, so a module's own option
 * (e.g. `reply-language`'s `languages`) takes effect on this same run
 * rather than only on a subsequent one.
 * @returns {{actions: object[], applied: object, ctx: object}} The plan,
 * the applied result (including the updated manifest and a report of what
 * happened), and the gathered context the plan was built from.
 */
function runInstall(agent, moduleIds, stateOverrides = {}) {
  const prior = stateStore.readState(agent);
  stateStore.writeState(agent, {
    modules: moduleIds,
    adapterOptions: { ...prior.adapterOptions, ...(stateOverrides.adapterOptions || {}) },
    options: { ...prior.options, ...(stateOverrides.options || {}) },
  });

  const ctx = detect.gather(agent, { enabledModuleIds: moduleIds });
  ctx.version = detect.readVersion();
  ctx.now = Date.now();
  const actions = plan.buildPlan(ctx);
  const applied = apply.applyPlan(actions, ctx);
  manifestStore.writeManifest(agent, applied.manifest);
  apply.pruneEmptyDirs(ctx.installedRoot);
  return { actions, applied, ctx };
}

/**
 * Snapshots everything an "enable then disable" round trip should restore:
 * every installed file's content hash, the raw settings/hooks file content,
 * and the global instructions file's content.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @returns {{files: Record<string, string>, settingsHooks: object, globalInstructions: string | null}}
 * `files` is deliberately narrowed to `softela-ai/modules/` and `softela-ai/hooks/`
 * — the paths a module's own `module.json` (its own directory copy, plus
 * every `files[].to`) can ever put something at. The shared core payload
 * (`softela-ai/core/`, `adapters/`, `docs/`, `projects/`, `bin/`) is excluded on
 * purpose: it is identical for every module and irrelevant to whether *this*
 * module's enable/disable left the home as it was, and hashing it wholesale
 * makes the check hostage to the base repository's own file contents
 * happening to be unchanged between two calls — nothing this suite owns or
 * should assert on. `.softela-ai/` (manifest, backups, local state) is excluded
 * for the same reason `agent-orchestration`'s seed settings are excluded: a
 * module's own remembered option value legitimately survives in
 * `.softela-ai/state.json` across a disable. `settingsHooks` reads only the
 * `hooks` key of `settings.json` / `hooks.json`, the part enable/disable
 * actually owns.
 */
function snapshotAgentHome(agent) {
  const home = paths.agentHome(agent);
  const files = {};
  for (const rel of listFilesRecursive(home)) {
    // A module's own files live under the installed root; a host COMMAND
    // deliberately does not — each host only discovers commands at a fixed
    // location of its own, outside `softela-ai/` entirely. Both are the module's
    // to place and the module's to take away, so both belong in a snapshot
    // that asks "what did enabling this change, and did disabling undo it".
    const isModuleFile = rel.startsWith("softela-ai/modules/") || rel.startsWith("softela-ai/hooks/");
    const isHostCommand = rel.startsWith("commands/") || rel.startsWith("skills/");
    if (!isModuleFile && !isHostCommand) continue;
    files[rel] = sha256(readText(path.join(home, ...rel.split("/"))) || "");
  }
  const settingsFile = agent === "codex" ? path.join(home, "hooks.json") : path.join(home, "settings.json");
  const globalInstructionsFile = path.join(home, agent === "codex" ? "AGENTS.md" : "CLAUDE.md");
  const settings = readJson(settingsFile) || {};
  return {
    files,
    settingsHooks: settings.hooks || {},
    globalInstructions: readText(globalInstructionsFile),
  };
}

module.exports = {
  REPO_ROOT,
  FIXED_VARS,
  allModuleIds,
  loadModule,
  validateModuleJson,
  renderPrompt,
  unsubstitutedTokens,
  runInstall,
  snapshotAgentHome,
  sj,
  st,
  paths,
};
