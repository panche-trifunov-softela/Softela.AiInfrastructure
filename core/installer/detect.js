"use strict";

/**
 * Gathers everything `plan.js` needs to know about what is on disk and what
 * the repository ships, so `plan.js` itself never has to touch the
 * filesystem.
 *
 * Every function here reads; none writes. `index.js` calls this module,
 * hands the result to `plan.js`, and hands `plan.js`'s output to `apply.js`.
 */

const fs = require("fs");
const path = require("path");
const { readJson, readText, sha256, listFilesRecursive } = require("../lib/fs-safe");
const paths = require("../lib/paths");
const manifest = require("./manifest");
const state = require("./state");
const rulebook = require("./rulebook");

/**
 * Every agent this repository ships an adapter for, independent of what the
 * running source's own `adapters/` directory happens to contain right now.
 *
 * This is what makes a completely MISSING adapter directory detectable as
 * missing (Layer 2's `unavailableAreas`) instead of simply not being seen at
 * all — the exact shape of the cross-agent update defect, where an installed
 * claude-only copy's own `adapters/` never had a `codex/` subdirectory to
 * begin with, so nothing derived from reading that directory could ever
 * notice it is gone.
 */
const KNOWN_AGENTS = ["claude", "codex"];

/**
 * Resolves the version this running installer's own code identifies as.
 *
 * `repoRoot()` is derived from `__dirname` (`lib/paths.js`), so it silently
 * points at different places depending on which copy is running: the source
 * clone when running from there, or `<agentHome>/softela-ai` once the clone is
 * gone and only the installed copy remains. Reading `VERSION` from the same
 * self-relative root as a fallback is what lets both cases resolve correctly
 * without knowing which one this is (IMPORTANT I5).
 *
 * @returns {string | null} `package.json`'s `version` field when running
 * from a source repository clone; failing that, the `VERSION` marker this
 * installer writes into `<agentHome>/softela-ai/` at install and update time
 * (INSTALLER.md §1); `null` when neither is readable — there is genuinely no
 * version information available, which callers must say plainly rather than
 * fabricate.
 */
function readVersion() {
  const pkg = readJson(path.join(paths.repoRoot(), "package.json"));
  if (pkg && typeof pkg.version === "string" && pkg.version) return pkg.version;
  const marker = readText(path.join(paths.repoRoot(), "VERSION"));
  return marker && marker.trim() ? marker.trim() : null;
}

/**
 * Resolves which agents a run should target.
 *
 * @param {string | undefined} agentFlag The `--agent` flag's value.
 * @returns {string[]} `["claude", "codex"]` when the flag is `"all"` —
 * naming both explicitly, forcing each as a target even if its home does not
 * exist yet, exactly like naming one does; `["claude"]` or `["codex"]` when
 * the flag names one of them; otherwise the subset of `["claude", "codex"]`
 * whose home directory is already present.
 */
function resolveAgents(agentFlag) {
  if (agentFlag === "all") return ["claude", "codex"];
  if (agentFlag === "claude" || agentFlag === "codex") return [agentFlag];
  return paths.detectAgents();
}

/**
 * Adds every file under a repository directory to a shipped-file list, and,
 * when asked, records whether this directory could produce anything at all.
 *
 * @param {string} repoRoot The repository root.
 * @param {string} relRoot The directory to walk, relative to `repoRoot`.
 * @param {string} installedPrefix The `<agentHome>`-relative prefix files
 * under this directory install to, e.g. `"softela-ai/core"`.
 * @param {{relPath: string, sourceAbsPath: string}[]} out The list to push
 * onto.
 * @param {{prefix: string, available: boolean}[]} [areas] When given, one
 * entry is appended per call recording whether `relRoot` actually produced
 * any files — `available: false` covers both an absent directory and one
 * that exists but is empty, since a prune decision must treat both the same
 * way (Layer 2, {@link gather}'s `unavailableAreas`).
 * @returns {void}
 */
function addShippedDir(repoRoot, relRoot, installedPrefix, out, areas) {
  const abs = path.join(repoRoot, relRoot);
  const rels = listFilesRecursive(abs);
  if (areas) areas.push({ prefix: installedPrefix, available: rels.length > 0 });
  for (const rel of rels) {
    out.push({
      relPath: `${installedPrefix}/${rel}`,
      sourceAbsPath: path.join(abs, rel),
    });
  }
}

/**
 * Discovers every module this repository ships, whether or not it is
 * enabled.
 *
 * @returns {{id: string, dir: string, json: object}[]} One entry per
 * `modules/<id>/module.json` that parses to an object with a matching `id`;
 * an empty array when `modules/` does not exist, which is the current state
 * of this repository.
 */
function discoverModules() {
  const modulesDir = path.join(paths.repoRoot(), "modules");
  let ids;
  try {
    ids = fs.readdirSync(modulesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const out = [];
  for (const id of ids) {
    const dir = path.join(modulesDir, id);
    const json = readJson(path.join(dir, "module.json"));
    if (!json || typeof json !== "object" || json.id !== id) continue;
    const promptText = typeof json.prompt === "string" ? readText(path.join(dir, json.prompt)) : null;
    out.push({ id, dir, json, promptText });
  }
  return out;
}

/**
 * Lists every file this installer would place under `<agentHome>/` for one
 * agent, for the core payload, every enabled module's own copy and hook
 * entry points, plus a catalogue-only `module.json`/`README.md` pair for
 * every module that is NOT enabled.
 *
 * Shipping every module's metadata regardless of enabled state is what keeps
 * `module list` and `module enable` working once the source clone is gone
 * (IMPORTANT I6): without it, only the modules chosen at install time are
 * ever discoverable again, and a module never enabled cannot be found by id.
 * Runtime assets (hook scripts, `prompt.md`, anything in `files[]`) still
 * ship only when enabled — {@link moduleAssetsAvailable} is how a caller
 * tells a fully-shipped module from a metadata-only stub.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @param {{id: string, dir: string, json: object}[]} enabledModules The
 * modules to fully install, already resolved and filtered to the enabled
 * set.
 * @param {{id: string, dir: string, json: object}[]} [allModules] Every
 * module this repository discovers, enabled or not; defaults to
 * `enabledModules` so existing callers that only care about a fixed enabled
 * set keep working unchanged.
 * @returns {{
 *   files: {relPath: string, sourceAbsPath: string}[],
 *   areas: {prefix: string, available: boolean}[]
 * }} `files` are paths relative to `<agentHome>`, e.g.
 * `"softela-ai/core/engine.js"` or `"hooks/inject-memory.js"` — matching the
 * manifest's own key shape (INSTALLER.md §4). `areas` is one entry per
 * directory this function swept, recording whether that directory actually
 * produced anything — the input {@link gather} turns into `unavailableAreas`
 * for Layer 2's prune guard.
 */
/**
 * Resolves a module's `commands[]` entries for one agent.
 *
 * A command is the one thing a module ships that must NOT land under
 * `<agentHome>/softela-ai/`: each host discovers its own commands at a fixed
 * location of its own — `<agentHome>/commands/<name>.md` on Claude Code,
 * `<agentHome>/skills/<name>/SKILL.md` on Codex — and a file anywhere else is
 * simply never found. So unlike `files[]`, whose `to` is relative to the
 * installed root, a command's `to` is relative to the agent home itself.
 *
 * Entries are agent-scoped, because the two hosts' formats are genuinely
 * different documents rather than the same file in two places.
 *
 * @param {{dir: string, json: object}} mod A discovered module.
 * @param {string} agent `"claude"` or `"codex"`.
 * @returns {{from: string, relPath: string}[]} One entry per command this
 * module ships for this agent; `relPath` is agent-home-relative, matching the
 * manifest's own key shape.
 */
function moduleCommandsFor(mod, agent) {
  const declared = Array.isArray(mod.json && mod.json.commands) ? mod.json.commands : [];
  const out = [];
  for (const c of declared) {
    if (!c || c.agent !== agent || typeof c.from !== "string" || typeof c.to !== "string") continue;
    out.push({ from: c.from, relPath: c.to.split(path.sep).join("/") });
  }
  return out;
}

function listShippedFiles(agent, enabledModules, allModules = enabledModules) {
  const repoRoot = paths.repoRoot();
  const out = [];
  const areas = [];

  addShippedDir(repoRoot, "core", "softela-ai/core", out, areas);
  // Every known agent's adapter directory ships into EVERY install, not only
  // the one being targeted right now — an installed copy of any one agent
  // must be a complete source for every other agent too, so deleting the
  // clone never leaves another agent's installation unable to update itself
  // (Layer 1, the cross-agent update invariant). Hook registration and
  // settings writes stay scoped to `agent` alone — they are driven by
  // `ctx.fragment` and `mod.json.hooks[].agent` elsewhere in this module and
  // in `plan.js`, never by which adapter directories were copied here.
  for (const knownAgent of KNOWN_AGENTS) {
    addShippedDir(repoRoot, path.join("adapters", knownAgent), `softela-ai/adapters/${knownAgent}`, out, areas);
  }
  addShippedDir(repoRoot, path.join("adapters", "shared"), "softela-ai/adapters/shared", out, areas);
  addShippedDir(repoRoot, "projects", "softela-ai/projects", out, areas);
  addShippedDir(repoRoot, path.join("docs", "standards"), "softela-ai/docs/standards", out, areas);
  addShippedDir(repoRoot, path.join("docs", "projects"), "softela-ai/docs/projects", out, areas);
  out.push({ relPath: "softela-ai/bin/softela-ai", sourceAbsPath: path.join(repoRoot, "bin", "softela-ai") });

  const enabledIds = new Set(enabledModules.map((m) => m.id));

  for (const mod of enabledModules) {
    addShippedDir(repoRoot, path.join("modules", mod.id), `softela-ai/modules/${mod.id}`, out, areas);
    for (const f of Array.isArray(mod.json.files) ? mod.json.files : []) {
      if (!f || typeof f.from !== "string" || typeof f.to !== "string") continue;
      // `to` is resolved relative to `{{INSTALLED}}` (`<agentHome>/softela-ai`), matching
      // the `{{INSTALLED}}/hooks/...` paths module.json's own `hooks[].command`
      // entries use — a hook script and its registration must agree on where it lives.
      out.push({
        relPath: `softela-ai/${f.to.split(path.sep).join("/")}`,
        sourceAbsPath: path.join(mod.dir, f.from),
      });
    }
    for (const c of moduleCommandsFor(mod, agent)) {
      out.push({ relPath: c.relPath, sourceAbsPath: path.join(mod.dir, c.from) });
    }
  }

  for (const mod of allModules) {
    if (enabledIds.has(mod.id)) continue;
    out.push({ relPath: `softela-ai/modules/${mod.id}/module.json`, sourceAbsPath: path.join(mod.dir, "module.json") });
    out.push({ relPath: `softela-ai/modules/${mod.id}/README.md`, sourceAbsPath: path.join(mod.dir, "README.md") });
  }

  return { files: out, areas };
}

/**
 * Checks whether a discovered module's runtime assets — its `prompt` file
 * and every `files[].from` path it declares — are actually readable from its
 * own directory, as opposed to only the catalogue `module.json`/`README.md`
 * pair {@link listShippedFiles} always ships (IMPORTANT I6).
 *
 * @param {{dir: string, json: object} | undefined} mod A discovered module,
 * or `undefined` for an unknown id.
 * @returns {boolean} `true` when every asset the module declares is
 * currently readable, meaning it can be enabled from here; `false` for an
 * unknown module, or one shipped as catalogue metadata only because the
 * source repository it was copied from is not this one.
 */
function moduleAssetsAvailable(mod) {
  if (!mod || !mod.json) return false;
  if (typeof mod.json.prompt === "string" && readText(path.join(mod.dir, mod.json.prompt)) === null) return false;
  for (const f of Array.isArray(mod.json.files) ? mod.json.files : []) {
    if (!f || typeof f.from !== "string") continue;
    if (readText(path.join(mod.dir, f.from)) === null) return false;
  }
  // A command's source counts the same way: a module whose command file
  // cannot be read here is a catalogue stub, not something that can be
  // enabled from this copy.
  for (const c of Array.isArray(mod.json.commands) ? mod.json.commands : []) {
    if (!c || typeof c.from !== "string") continue;
    if (readText(path.join(mod.dir, c.from)) === null) return false;
  }
  return true;
}

/**
 * Hashes every shipped and previously-installed file on disk, so `plan.js`
 * can compare against both the manifest and the current repository without
 * touching the filesystem itself.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @param {{relPath: string, sourceAbsPath: string}[]} shippedFiles As
 * returned by {@link listShippedFiles}.
 * @param {object} manifestFiles The manifest's `files` map, `relPath` to
 * hash.
 * @returns {{
 *   relPath: string,
 *   sourceAbsPath: string,
 *   shippedHash: string,
 *   onDiskHash: string | null,
 *   manifestHash: string | undefined
 * }[]} One entry per shipped file, plus one per manifest entry that is no
 * longer shipped (obsolete), with `shippedHash: null` and no `sourceAbsPath`
 * for those.
 */
function hashFiles(agent, shippedFiles, manifestFiles) {
  const home = paths.agentHome(agent);
  const seen = new Set();
  const out = [];

  for (const file of shippedFiles) {
    seen.add(file.relPath);
    const shippedText = readText(file.sourceAbsPath);
    const onDiskText = readText(path.join(home, file.relPath));
    out.push({
      relPath: file.relPath,
      sourceAbsPath: file.sourceAbsPath,
      shippedHash: shippedText === null ? null : sha256(shippedText),
      onDiskHash: onDiskText === null ? null : sha256(onDiskText),
      manifestHash: manifestFiles[file.relPath],
    });
  }

  for (const relPath of Object.keys(manifestFiles)) {
    if (seen.has(relPath)) continue;
    const onDiskText = readText(path.join(home, relPath));
    out.push({
      relPath,
      sourceAbsPath: null,
      shippedHash: null,
      onDiskHash: onDiskText === null ? null : sha256(onDiskText),
      manifestHash: manifestFiles[relPath],
    });
  }

  return out;
}

/**
 * Reads a JSON settings file tolerantly, reporting whether it parsed.
 *
 * @param {string} p The file path.
 * @returns {{content: object, parseOk: boolean, existed: boolean}} `content`
 * is `{}` for a missing or unparseable file — never `null`, so callers can
 * read pointers out of it unconditionally; `parseOk` is `false` only when
 * the file exists but is not valid JSON, which `doctor` surfaces rather
 * than silently overwriting.
 */
function readJsonSettings(p) {
  const existed = fs.existsSync(p);
  if (!existed) return { content: {}, parseOk: true, existed: false };
  const parsed = readJson(p);
  if (parsed && typeof parsed === "object") return { content: parsed, parseOk: true, existed: true };
  return { content: {}, parseOk: false, existed: true };
}

/**
 * Resolves the `memory-as-context` module's currently configured `location`
 * option — the developer's own stored choice when present and still one of
 * the option's declared `values`, else the option's own shipped default.
 *
 * Mirrors `doctor.js#resolveMemoryLocationOption`'s own fallback rule rather
 * than importing it: `doctor.js` requires this very module, so the reverse
 * `require` would be circular, and each side only needs this one narrow rule
 * — reporting there, generating the rulebook's own memory section here.
 *
 * @param {{id: string, json: object}[]} enabledModules This run's own
 * enabled modules, as {@link gather} already computed them.
 * @param {{options?: object}} currentState This run's own local state, as
 * {@link gather} already resolved it.
 * @returns {string} One of the option's declared `values` (`"repo"`,
 * `"infrastructure"` or `"global"`) when `memory-as-context` is enabled and
 * declares the option; `"global"` — the module's own shipped default —
 * otherwise, including when the module is not enabled at all, since
 * `rulebook.js#buildMemorySection` is only ever rendered when it is.
 */
function resolveMemoryLocationOption(enabledModules, currentState) {
  const mod = enabledModules.find((m) => m.id === "memory-as-context");
  const def = (mod && mod.json.options && mod.json.options.location) || {};
  const stored = currentState && currentState.options && currentState.options["memory-as-context"] && currentState.options["memory-as-context"].location;
  if (typeof stored === "string" && Array.isArray(def.values) && def.values.includes(stored)) return stored;
  return def.default || "global";
}

/**
 * Gathers the full on-disk and repository picture for one agent.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @param {{enabledModuleIds?: string[], state?: object}} [options]
 * `enabledModuleIds` selects which discovered modules to include; defaults
 * to the module ids already recorded in local state. `state` overrides the
 * local state read from disk — IMPORTANT B3: a caller that has already
 * folded this run's CLI flags into a new state object must pass it here, so
 * planning sees the same state that gets written, rather than the stale
 * state still on disk at gather time.
 * @returns {object} Everything `plan.js` needs: paths, the current
 * manifest and state, the shipped file list already hashed against both the
 * repository and disk, `unavailableAreas` (Layer 2's prune guard — shipped
 * directories the running source could not currently produce, absent or
 * empty), the raw settings file(s), and the modules this repository ships.
 * Never throws — a missing or unreadable piece degrades to its emptiest
 * form.
 */
function gather(agent, options = {}) {
  const home = paths.agentHome(agent);
  const installedRoot = paths.installedRoot(agent);
  const currentManifest = manifest.readManifest(agent);
  const currentState = options.state || state.readState(agent);
  const allModules = discoverModules();
  const enabledIds = new Set(options.enabledModuleIds || currentState.modules);
  const enabledModules = allModules.filter((m) => enabledIds.has(m.id));

  const shipped = listShippedFiles(agent, enabledModules, allModules);
  const files = hashFiles(agent, shipped.files, currentManifest ? currentManifest.files : {});
  const unavailableAreas = shipped.areas.filter((a) => !a.available).map((a) => a.prefix);

  const settingsFile = agent === "codex" ? path.join(home, "hooks.json") : path.join(home, "settings.json");
  const settings = readJsonSettings(settingsFile);

  // `exists` separates "absent" from "present but unreadable" — `content`
  // alone cannot, since `readText` returns `null` for both. `plan.js` needs
  // the distinction: an absent file is a fresh machine a `seed` setting
  // should still write into; an unreadable one must stay untouched.
  // - `exists: false` — no file. A seed may create it.
  // - `exists: true, content: <string>` — readable; today's behaviour.
  // - `exists: true, content: null` — present but unreadable; still skipped.
  const configTomlPath = agent === "codex" ? path.join(home, "config.toml") : null;
  const configToml = configTomlPath
    ? { path: configTomlPath, exists: fs.existsSync(configTomlPath), content: readText(configTomlPath) }
    : null;

  // Codex reads a global `AGENTS.md`; Claude Code's equivalent is `CLAUDE.md`
  // (this very repository's own user-level instructions live at
  // `~/.claude/CLAUDE.md`, confirming the name) — never a second copy of
  // the same content under a different filename.
  const globalInstructionsName = agent === "codex" ? "AGENTS.md" : "CLAUDE.md";
  const agentsMdTargetPath = path.join(home, globalInstructionsName);
  const agentsMdCurrent = readText(agentsMdTargetPath);

  const fragmentName = agent === "codex" ? "hooks.fragment.json" : "settings.fragment.json";
  const fragment = readJson(path.join(paths.repoRoot(), "adapters", agent, fragmentName)) || { hooks: {} };

  // Generated fresh from this run's own facts, never read from a checked-in
  // file: `rulebook.js` needs to know which modules THIS install actually
  // has enabled (so its memory, analyse-first and delegation sections match,
  // rather than a module's own retired prompt.md being the only place that
  // instruction lived), this install's own resolved `memory-as-context`
  // `location` option (so the memory section names where the knowledge base
  // actually resolves to here, not a generic default), and, for Codex, this
  // install's own `askMode` (so the enforcement section describes what an
  // `ask` rule actually does here, not the opposite of it under `askMode:
  // "advise"`). Computed here, not in `plan.js`, so `plan.js#buildPlan` stays
  // a pure function of `ctx` alone — every filesystem read this whole module
  // needs stays isolated to this gathering layer, the same separation
  // `agentsMdTemplate` used to keep before this field replaced it.
  const askMode = agent === "codex" && currentState.adapterOptions && currentState.adapterOptions.askMode === "advise" ? "advise" : "block";
  const rulebookBody = rulebook.buildRulebookBody(agent, {
    enabledModuleIds: new Set(enabledModules.map((m) => m.id)),
    askMode,
    memoryLocation: resolveMemoryLocationOption(enabledModules, currentState),
  });

  return {
    fragment,
    agent,
    home,
    installedRoot,
    settingsFile,
    manifest: currentManifest,
    state: currentState,
    allModules,
    enabledModules,
    files,
    unavailableAreas,
    settings,
    configToml,
    rulebookBody,
    agentsMdTargetPath,
    agentsMdCurrent,
    dispatchNeedle: path.join(installedRoot, "adapters", agent, "dispatch.js"),
    nodeExe: process.execPath,
  };
}

module.exports = {
  readVersion,
  resolveAgents,
  discoverModules,
  listShippedFiles,
  moduleAssetsAvailable,
  hashFiles,
  readJsonSettings,
  gather,
};
