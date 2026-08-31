"use strict";

/**
 * Executes a plan built by `plan.js`. Performs the actions; decides
 * nothing — every choice already lives on the plan's entries
 * (CONTRACTS §9, INSTALLER.md §3).
 *
 * Every file this touches is backed up first, into one timestamped
 * directory shared by the whole run (INSTALLER.md §7). Settings files are
 * mutated once in memory per target and written once, so several actions
 * against the same `settings.json` do not race each other's read/write.
 */

const fs = require("fs");
const path = require("path");
const {
  readText,
  writeTextAtomic,
  writeJsonAtomic,
  sha256,
  copyFileSafe,
  removeIfExists,
} = require("../lib/fs-safe");
const sj = require("./settings-json");
const st = require("./settings-toml");
const manifestStore = require("./manifest");

/**
 * Formats a run's backup timestamp as a filesystem-safe directory name.
 *
 * @param {number} now The run's clock, in epoch milliseconds.
 * @returns {string} An ISO-8601 instant with `:` replaced by `-`, since a
 * literal `:` is not a legal path character on Windows.
 */
function backupStamp(now) {
  return new Date(now).toISOString().replace(/:/g, "-");
}

/**
 * Copies a file's current bytes into this run's backup directory, at most
 * once per target no matter how many actions touch it.
 *
 * @param {string} home The agent home a backup path is computed relative
 * to.
 * @param {string} backupsRoot This run's own `<timestamp>` directory under
 * `.softela-ai/backups/`.
 * @param {string} target The absolute path about to be modified.
 * @param {Set<string>} done Targets already considered this run; mutated.
 * @param {Set<string>} backedUp Targets whose bytes actually got copied;
 * mutated. Distinct from `done`, so a target with nothing on disk yet is
 * not reported as backed up.
 * @returns {void}
 */
function backupOnce(home, backupsRoot, target, done, backedUp) {
  if (done.has(target)) return;
  done.add(target);
  if (readText(target) === null) return; // nothing on disk yet — nothing to preserve
  copyFileSafe(target, path.join(backupsRoot, path.relative(home, target)));
  backedUp.add(target);
}

/**
 * Resolves a path relative to the agent home, for manifest and backup
 * bookkeeping — POSIX-separated so the manifest is stable across
 * platforms.
 *
 * @param {string} home The agent home.
 * @param {string} target An absolute path under `home`.
 * @returns {string} The relative path, with `\` normalised to `/`.
 */
function relToHome(home, target) {
  return path.relative(home, target).split(path.sep).join("/");
}

/**
 * Executes every `copy`, `remove` and `skip` file action, updating the
 * manifest's `files` map to match what was actually written.
 *
 * @param {object} ctx The gathered context (`detect.js#gather`, plus
 * `version`/`now`).
 * @param {object[]} fileActions This plan's `kind: "copy"` and
 * `kind: "remove"` and `kind: "skip"` entries.
 * @param {string} backupsRoot This run's backup directory.
 * @param {Set<string>} considered Targets already offered to
 * {@link backupOnce} this run, whether or not anything existed to copy.
 * @param {Set<string>} backedUp Targets whose original bytes were actually
 * copied into `backupsRoot` this run.
 * @param {object} newFiles The manifest's `files` map being built; mutated.
 * @param {{written: string[], backedUp: string[], removed: string[], modifiedKept: string[], errors: string[]}} report
 * Mutated with what happened.
 * @param {() => void} [checkpoint] Called after each action that actually
 * changed disk, so a run killed partway through never leaves the manifest
 * claiming less — or more — than what is really there (INSTALLER.md §4).
 * @returns {void}
 */
function applyFiles(ctx, fileActions, backupsRoot, considered, backedUp, newFiles, report, checkpoint) {
  for (const a of fileActions) {
    const rel = a.relPath || relToHome(ctx.home, a.target);

    if (a.kind === "skip") {
      if (a.locallyModified) report.modifiedKept.push(rel);
      continue;
    }

    if (a.kind === "remove") {
      if (a.action !== "remove") continue;
      backupOnce(ctx.home, backupsRoot, a.target, considered, backedUp);
      removeIfExists(a.target);
      if (fs.existsSync(a.target)) {
        // removeIfExists swallows its own failures — verify the target is
        // actually gone before the manifest is allowed to forget it, or a
        // permission-denied delete would leave an untracked file behind
        // exactly like the write failure this function guards against.
        report.errors.push(`${rel}: could not be removed`);
      } else {
        delete newFiles[rel];
        report.removed.push(rel);
        if (checkpoint) checkpoint();
      }
      continue;
    }

    if (a.kind !== "copy" || a.action === "none") continue;

    const sourceText = readText(a.source);
    if (sourceText === null) {
      report.errors.push(`${rel}: shipped source is unreadable, skipped`);
      continue;
    }

    if (a.action === "write-new") {
      try {
        writeTextAtomic(`${a.target}.new`, sourceText);
      } catch (err) {
        report.errors.push(`${rel}.new: ${err.message}`);
        continue;
      }
      report.written.push(`${rel}.new (yours kept)`);
      if (a.state === "modified" && newFiles[rel] === undefined) {
        // Previously untracked but present on disk: start tracking its
        // current bytes, so future runs treat it as an ordinary local
        // modification instead of repeating "unexpected file" every time.
        const onDiskText = readText(a.target);
        if (onDiskText !== null) newFiles[rel] = sha256(onDiskText);
      }
      report.modifiedKept.push(rel);
      if (checkpoint) checkpoint();
      continue;
    }

    backupOnce(ctx.home, backupsRoot, a.target, considered, backedUp);
    try {
      writeTextAtomic(a.target, sourceText);
    } catch (err) {
      // A write that fails here (e.g. EPERM on a read-only target) must
      // never abort the run: every file already written above this one, and
      // every entry already folded into `newFiles`, is real on disk and must
      // reach the manifest regardless of what happens to this one file — the
      // whole point being that the manifest never claims a hash for bytes
      // that failed to land (INSTALLER.md §4).
      report.errors.push(`${rel}: ${err.message}`);
      continue;
    }
    newFiles[rel] = sha256(sourceText);
    report.written.push(rel);
    if (checkpoint) checkpoint();
  }
}

/**
 * Executes every `kind: "settings"` action against Claude Code's
 * `settings.json` or Codex's `hooks.json`, batched into a single
 * read-mutate-write per target file.
 *
 * @param {object} ctx The gathered context.
 * @param {object[]} settingsActions This plan's `kind: "settings"` entries
 * whose `target` is a JSON file (i.e. not `config.toml`).
 * @param {string} backupsRoot This run's backup directory.
 * @param {Set<string>} considered Targets already offered to
 * {@link backupOnce} this run.
 * @param {Set<string>} backedUp Targets whose original bytes were actually
 * copied this run.
 * @param {{file: string, pointer: string, mode: string}[]} newSettings The
 * manifest's `settings` list being built; mutated.
 * @param {{written: string[], errors: string[]}} report Mutated with what
 * happened.
 * @param {() => void} [checkpoint] Called after each target file is
 * successfully written, or found to need no write, so a mid-run crash never
 * leaves the manifest out of step with what {@link writeJsonAtomic} actually
 * put on disk.
 * @returns {void}
 */
function applyJsonSettings(ctx, settingsActions, backupsRoot, considered, backedUp, newSettings, report, checkpoint) {
  const byTarget = new Map();
  for (const a of settingsActions) {
    if (!byTarget.has(a.target)) byTarget.set(a.target, []);
    byTarget.get(a.target).push(a);
  }

  /**
   * Replaces every `newSettings` entry already recorded for one target file
   * with a freshly computed set, instead of appending — `newSettings` starts
   * seeded from the prior manifest (see {@link applyPlan}), so appending
   * unconditionally would duplicate every pointer this target already had.
   *
   * @param {string} targetRel The target's manifest-relative path.
   * @param {object[]} entries The entries to install in its place.
   * @returns {void}
   */
  function replaceEntriesFor(targetRel, entries) {
    for (let i = newSettings.length - 1; i >= 0; i--) {
      if (newSettings[i].file === targetRel) newSettings.splice(i, 1);
    }
    newSettings.push(...entries);
  }

  for (const [target, actionsForTarget] of byTarget) {
    const targetRel = relToHome(ctx.home, target);
    const content = target === ctx.settingsFile ? ctx.settings.content : {};
    let changed = false;
    const freshEntries = [];

    for (const a of actionsForTarget) {
      const needle = a.needle || ctx.dispatchNeedle;
      if (a.action === "remove") {
        if (a.event && sj.removeHookEvent(content, a.event, needle)) changed = true;
        continue; // module disabled or uninstalling — this pointer no longer belongs in the manifest
      }
      freshEntries.push({ file: targetRel, pointer: a.pointer, mode: a.mode, module: a.module || null, event: a.event || null });
      if (a.action !== "write") continue;
      if (a.mode === "enforce" && a.event) {
        sj.upsertHookEvent(content, a.event, a.value, needle);
      } else {
        sj.setPointer(content, a.pointer, a.value);
      }
      changed = true;
    }

    if (!changed) {
      replaceEntriesFor(targetRel, freshEntries);
      continue;
    }

    backupOnce(ctx.home, backupsRoot, target, considered, backedUp);
    try {
      writeJsonAtomic(target, content);
    } catch (err) {
      // Nothing reached disk for this target — record whatever the manifest
      // already had for it (i.e. nothing changed), never the entries this
      // run only planned to write, or the manifest would claim a
      // registration that a failed write never actually made.
      report.errors.push(`${targetRel}: ${err.message}`);
      replaceEntriesFor(targetRel, ((ctx.manifest && ctx.manifest.settings) || []).filter((s) => s.file === targetRel));
      continue;
    }
    replaceEntriesFor(targetRel, freshEntries);
    report.written.push(targetRel);
    if (checkpoint) checkpoint();
  }
}

/**
 * Executes every `kind: "settings"` action targeting Codex's
 * `config.toml`, batched into a single insert pass.
 *
 * @param {object} ctx The gathered context.
 * @param {object[]} tomlActions This plan's `kind: "settings"` entries
 * whose `target` is `config.toml`.
 * @param {string} backupsRoot This run's backup directory.
 * @param {Set<string>} considered Targets already offered to
 * {@link backupOnce} this run.
 * @param {Set<string>} backedUp Targets whose original bytes were actually
 * copied this run.
 * @param {{file: string, pointer: string, mode: string}[]} newSettings The
 * manifest's `settings` list being built; mutated.
 * @param {{written: string[], errors: string[]}} report Mutated with what
 * happened.
 * @param {() => void} [checkpoint] Called once the write actually reaches
 * disk, mirroring {@link applyJsonSettings}'s checkpointing.
 * @returns {void}
 */
function applyTomlSettings(ctx, tomlActions, backupsRoot, considered, backedUp, newSettings, report, checkpoint) {
  if (!tomlActions.length) return;
  const target = tomlActions[0].target;
  const targetRel = relToHome(ctx.home, target);
  const toWrite = tomlActions.filter((a) => a.action === "write").map((a) => ({ pointer: a.pointer, value: a.value }));
  const freshEntries = tomlActions.map((a) => ({ file: targetRel, pointer: a.pointer, mode: a.mode }));

  // `newSettings` starts seeded from the prior manifest (see `applyPlan`), so
  // replacing this target's slice rather than appending is what stops it
  // from duplicating entries that were already there.
  const replace = (entries) => {
    for (let i = newSettings.length - 1; i >= 0; i--) {
      if (newSettings[i].file === targetRel) newSettings.splice(i, 1);
    }
    newSettings.push(...entries);
  };

  if (!toWrite.length) {
    replace(freshEntries);
    return;
  }

  const current = readText(target) || "";
  const result = st.writeSeedKeys(current, toWrite);
  if (!result.ok) {
    report.errors.push(`${targetRel}: ${result.reason}`);
    replace(((ctx.manifest && ctx.manifest.settings) || []).filter((s) => s.file === targetRel));
    return;
  }
  if (!result.written.length) {
    replace(freshEntries);
    return;
  }

  backupOnce(ctx.home, backupsRoot, target, considered, backedUp);
  try {
    writeTextAtomic(target, result.content.endsWith("\n") ? result.content : `${result.content}\n`);
  } catch (err) {
    report.errors.push(`${targetRel}: ${err.message}`);
    replace(((ctx.manifest && ctx.manifest.settings) || []).filter((s) => s.file === targetRel));
    return;
  }
  replace(freshEntries);
  report.written.push(targetRel);
  if (checkpoint) checkpoint();
}

/**
 * Executes the single `kind: "block"` action, when present.
 *
 * @param {object} ctx The gathered context.
 * @param {object[]} blockActions This plan's `kind: "block"` entries — at
 * most one per agent today.
 * @param {string} backupsRoot This run's backup directory.
 * @param {Set<string>} considered Targets already offered to
 * {@link backupOnce} this run.
 * @param {Set<string>} backedUp Targets whose original bytes were actually
 * copied this run.
 * @param {{file: string, marker: string}[]} newBlocks The manifest's
 * `blocks` list being built; mutated.
 * @param {{written: string[], errors: string[]}} report Mutated with what
 * happened.
 * @param {() => void} [checkpoint] Called after each successful write.
 * @returns {void}
 */
function applyBlocks(ctx, blockActions, backupsRoot, considered, backedUp, newBlocks, report, checkpoint) {
  for (const a of blockActions) {
    const rel = relToHome(ctx.home, a.target);
    // `newBlocks` starts seeded from the prior manifest (see `applyPlan`), so
    // this target's existing entry (if any) is dropped before re-adding it —
    // otherwise a file already carrying a block would end up listed twice.
    // The manifest only tracks that this file carries a managed block, not
    // its bytes, so this entry stays correct whether or not the write below
    // succeeds — a failed write leaves the block exactly as it was, and
    // "as it was" is what this entry has always meant.
    const already = newBlocks.findIndex((b) => b.file === rel);
    if (already !== -1) newBlocks.splice(already, 1);
    newBlocks.push({ file: rel, marker: "softela-ai" });
    if (a.action !== "write") continue;
    backupOnce(ctx.home, backupsRoot, a.target, considered, backedUp);
    try {
      writeTextAtomic(a.target, a.content);
    } catch (err) {
      report.errors.push(`${rel}: ${err.message}`);
      continue;
    }
    report.written.push(rel);
    if (checkpoint) checkpoint();
  }
}

/**
 * Executes a plan for one agent and returns the updated manifest alongside
 * a human-readable report of what happened.
 *
 * @param {object[]} plan The plan built by `plan.js#buildPlan`.
 * @param {object} ctx The same gathered context the plan was built from.
 * @returns {{
 *   manifest: object,
 *   backupsDir: string | null,
 *   report: {
 *     written: string[], removed: string[], modifiedKept: string[],
 *     backedUp: string[], errors: string[]
 *   }
 * }} The manifest ready to write via `manifest.js#writeManifest`, the
 * backup directory used (`null` when nothing was backed up), and a summary
 * for the CLI to print.
 */
function applyPlan(plan, ctx) {
  const considered = new Set();
  const backedUp = new Set();
  const backupsRoot = path.join(ctx.home, ".softela-ai", "backups", backupStamp(ctx.now));
  const report = { written: [], removed: [], modifiedKept: [], backedUp: [], errors: [] };

  const newFiles = { ...(ctx.manifest ? ctx.manifest.files : {}) };
  // Seeded from the prior manifest, not built empty, so a checkpoint taken
  // before `applyJsonSettings`/`applyTomlSettings`/`applyBlocks` have run yet
  // (e.g. while `applyFiles` is still working through a long file list) never
  // writes a manifest that claims zero settings or blocks are registered —
  // each function below replaces only the entries for the targets it itself
  // touches, once it has confirmed what actually reached disk.
  const newSettings = [...((ctx.manifest && ctx.manifest.settings) || [])];
  const newBlocks = [...((ctx.manifest && ctx.manifest.blocks) || [])];

  /**
   * Builds the manifest for exactly what has been folded into `newFiles`,
   * `newSettings` and `newBlocks` so far — never what the plan intends, only
   * what {@link applyFiles}, {@link applyJsonSettings}, {@link applyTomlSettings}
   * and {@link applyBlocks} have actually confirmed reached disk at the
   * moment it is called.
   *
   * @returns {object} The manifest shape `manifest.js#writeManifest` expects.
   */
  const buildManifest = () => ({
    version: ctx.version,
    installedAt: (ctx.manifest && ctx.manifest.installedAt) || new Date(ctx.now).toISOString(),
    agent: ctx.agent,
    files: newFiles,
    settings: newSettings,
    blocks: newBlocks,
    modules: ctx.enabledModules.map((m) => m.id),
  });

  // Persisted after every individual write across the whole run (not only
  // once at the end), so a crash or kill mid-run — before this function ever
  // returns — leaves manifest.json describing exactly the files, settings and
  // blocks actually written so far, never zero of them (INSTALLER.md §4).
  const checkpoint = () => manifestStore.writeManifest(ctx.agent, buildManifest());

  const fileActions = plan.filter((a) => a.kind === "copy" || a.kind === "remove" || (a.kind === "skip" && a.relPath));
  const settingsActions = plan.filter((a) => a.kind === "settings");
  const jsonSettingsActions = settingsActions.filter((a) => a.target === ctx.settingsFile);
  const tomlSettingsActions = settingsActions.filter((a) => a.target !== ctx.settingsFile);
  const blockActions = plan.filter((a) => a.kind === "block");

  applyFiles(ctx, fileActions, backupsRoot, considered, backedUp, newFiles, report, checkpoint);
  applyJsonSettings(ctx, jsonSettingsActions, backupsRoot, considered, backedUp, newSettings, report, checkpoint);
  applyTomlSettings(ctx, tomlSettingsActions, backupsRoot, considered, backedUp, newSettings, report, checkpoint);
  applyBlocks(ctx, blockActions, backupsRoot, considered, backedUp, newBlocks, report, checkpoint);

  report.backedUp = [...backedUp].map((t) => relToHome(ctx.home, t));

  return { manifest: buildManifest(), backupsDir: backedUp.size ? backupsRoot : null, report };
}

/**
 * Removes empty directories under a root, deepest first, stopping at the
 * root itself.
 *
 * @param {string} dir The directory to prune.
 * @returns {void} Best-effort only — any failure is swallowed, since a
 * leftover empty directory is cosmetic, never a correctness problem.
 */
function pruneEmptyDirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) pruneEmptyDirs(path.join(dir, entry.name));
  }
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // Best-effort only.
  }
}

module.exports = { applyPlan, backupStamp, relToHome, pruneEmptyDirs };
