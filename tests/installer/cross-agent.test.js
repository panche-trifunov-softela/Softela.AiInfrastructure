"use strict";

/**
 * Cross-agent install/update safety — the "delete the clone and everything
 * keeps working" promise (INSTALLER.md, CONTRACTS §11), extended across BOTH
 * agents at once rather than only the one a developer happens to be standing
 * in:
 *
 * - Layer 1 (`detect.js#listShippedFiles`): every install copies every known
 *   agent's adapter directory, not only the one being targeted, so an
 *   installed copy of any one agent is a complete source for every agent.
 *   Hook registration and settings writes still stay strictly scoped to the
 *   agent actually being installed.
 * - Layer 2 (`plan.js#planFiles`): a prune is skipped, with a loud warning,
 *   for any shipped area the running source cannot currently produce right
 *   now — a directory that is absent or empty is evidence the SOURCE is
 *   incomplete, never evidence the files it used to ship should not exist.
 *
 * Before this fix, running `update` (including the default `--agent all`)
 * from an installed copy of one agent deleted the other agent's adapter and
 * left its hook registrations pointing at files that no longer existed.
 */

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");
const { runCli, copyRepoSubset, agentHomePath, installedRootPath, readManifest, readSettingsJson, findHookEntries } = require("./_home");
const { listFilesRecursive } = require("../../core/lib/fs-safe");

/**
 * Counts every file under an installed root.
 *
 * @param {string} dir An installed root (`<agentHome>/softela-ai`).
 * @returns {number} The file count; `0` when `dir` does not exist.
 */
function countFiles(dir) {
  return listFilesRecursive(dir).length;
}

/**
 * Extracts every `.js` script path a hook command string references.
 *
 * A command is split into whitespace-delimited words first, then each word
 * has its quote characters removed, because a path can carry quotes in three
 * different places depending on the host and the machine:
 *
 * - fully bare (`C:\...\dispatch.js`) — a path with no space, on either host.
 * - fully quoted (`"C:\...\dispatch.js"`) — the space-carrying fallback shape
 *   from `core/lib/short-path.js#resolvePathToken`.
 * - quoted only in its leading segment (`"C:\...\softela-ai"/hooks/x.js`) — what
 *   Claude Code's commands look like, since only the substituted
 *   `{{INSTALLED}}` token is quoted and the template appends the rest of the
 *   path outside the closing quote. A POSIX shell joins the two halves back
 *   into one word; a naive regex leaves the quote embedded and the resulting
 *   path matches nothing on disk.
 *
 * @param {string} command A `hooks[].hooks[].command` string.
 * @returns {string[]} Every `.js` path found, with quoting removed.
 */
function extractScriptPaths(command) {
  const paths = [];
  for (const word of String(command).split(/\s+/)) {
    const unquoted = word.replace(/["']/g, "");
    if (unquoted.toLowerCase().endsWith(".js")) paths.push(unquoted);
  }
  return paths;
}

/**
 * Asserts that every hook command registered in a settings/hooks object
 * names a script that actually exists on disk — a registration naming a
 * missing file, with nothing else erroring because every hook fails open, is
 * the exact silent-wreckage shape this suite guards against.
 *
 * @param {(value: *, message?: string) => void} ok The suite's `ok`
 * assertion.
 * @param {object | null} settingsObj A parsed `settings.json` or
 * `hooks.json`.
 * @param {string} label A short label prefixed to any failure message.
 * @returns {void}
 */
function assertAllHookScriptsExist(ok, settingsObj, label) {
  const hooks = settingsObj && settingsObj.hooks && typeof settingsObj.hooks === "object" ? settingsObj.hooks : {};
  let checked = 0;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || !Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (!h || typeof h.command !== "string") continue;
        for (const scriptPath of extractScriptPaths(h.command)) {
          checked++;
          ok(fs.existsSync(scriptPath), `${label}: hooks.${event} registers a command naming a missing file: ${scriptPath}`);
        }
      }
    }
  }
  ok(checked > 0, `${label}: expected at least one hook command to check`);
}

/**
 * Installs both agents into a fresh fake home from this repository's own
 * source (the real, patched `bin/softela-ai`), recording each installed root's
 * file count immediately afterward.
 *
 * @param {string} home The fake home root.
 * @returns {{
 *   claude: {root: string, count: number},
 *   codex: {root: string, count: number}
 * }} Each agent's installed root and file count right after install.
 */
function installBoth(home) {
  const claudeInstall = runCli(home, ["install", "--agent", "claude", "--yes"]);
  if (claudeInstall.code !== 0) throw new Error(`claude install failed:\n${claudeInstall.stdout}\n${claudeInstall.stderr}`);
  const codexInstall = runCli(home, ["install", "--agent", "codex", "--yes"]);
  if (codexInstall.code !== 0) throw new Error(`codex install failed:\n${codexInstall.stdout}\n${codexInstall.stderr}`);

  const result = {};
  for (const agent of ["claude", "codex"]) {
    const root = installedRootPath(home, agent);
    result[agent] = { root, count: countFiles(root) };
  }
  return result;
}

suite("installer/cross-agent", ({ test, eq, ok, fakeHome, tmpdir }) => {
  test("install claude, then codex, from the clone: both adapters present and complete", () => {
    const home = fakeHome();
    const before = installBoth(home);

    ok(fs.existsSync(path.join(before.claude.root, "adapters", "claude", "dispatch.js")));
    ok(fs.existsSync(path.join(before.codex.root, "adapters", "codex", "dispatch.js")));
    // Layer 1: an installed copy of either agent must be a complete source
    // for the other agent too.
    ok(
      fs.existsSync(path.join(before.claude.root, "adapters", "codex", "dispatch.js")),
      "the claude install must also carry codex's adapter as a complete source",
    );
    ok(
      fs.existsSync(path.join(before.codex.root, "adapters", "claude", "dispatch.js")),
      "the codex install must also carry claude's adapter as a complete source",
    );

    ok(before.claude.count > 0, `expected claude to have installed files, got ${before.claude.count}`);
    ok(before.codex.count > 0, `expected codex to have installed files, got ${before.codex.count}`);
  });

  for (const [from, to] of [
    ["claude", "codex"],
    ["codex", "claude"],
  ]) {
    test(`update --agent ${to} from the installed ${from} copy leaves ${to} intact`, () => {
      const home = fakeHome();
      const before = installBoth(home);
      const installedCli = path.join(before[from].root, "bin", "softela-ai");
      ok(fs.existsSync(installedCli), `expected an installed CLI at ${installedCli}`);

      const updated = runCli(home, ["update", "--agent", to, "--yes"], { cliPath: installedCli });
      ok(updated.code === 0 || updated.code === 2, `update from the installed ${from} copy failed:\n${updated.stdout}\n${updated.stderr}`);

      ok(
        fs.existsSync(path.join(before[to].root, "adapters", to, "dispatch.js")),
        `the ${to} adapter must survive an update run from the installed ${from} copy`,
      );
      ok(countFiles(before[to].root) >= before[to].count, `the ${to} install's file count must never shrink from a cross-agent update`);

      const settings = readSettingsJson(home, to);
      assertAllHookScriptsExist(ok, settings, `${to} settings after cross-agent update`);
    });
  }

  for (const from of ["claude", "codex"]) {
    test(`update --agent all from the installed ${from} copy leaves both installations intact`, () => {
      const home = fakeHome();
      const before = installBoth(home);
      const installedCli = path.join(before[from].root, "bin", "softela-ai");

      const updated = runCli(home, ["update", "--agent", "all", "--yes"], { cliPath: installedCli });
      ok(updated.code === 0 || updated.code === 2, `update --agent all from the installed ${from} copy failed:\n${updated.stdout}\n${updated.stderr}`);

      ok(fs.existsSync(path.join(before.claude.root, "adapters", "claude", "dispatch.js")));
      ok(fs.existsSync(path.join(before.codex.root, "adapters", "codex", "dispatch.js")));
      ok(countFiles(before.claude.root) >= before.claude.count, "claude's file count must never shrink");
      ok(countFiles(before.codex.root) >= before.codex.count, "codex's file count must never shrink");
    });
  }

  test("installing only claude never creates ~/.codex, registers a codex hook, or writes codex settings", () => {
    const home = fakeHome();
    eq(fs.existsSync(agentHomePath(home, "codex")), false);

    const installed = runCli(home, ["install", "--agent", "claude", "--yes"]);
    eq(installed.code, 0, `install stdout:\n${installed.stdout}\n${installed.stderr}`);

    // Layer 1 copies codex's adapter FILES into the claude install...
    ok(fs.existsSync(path.join(installedRootPath(home, "claude"), "adapters", "codex", "dispatch.js")));
    // ...but must never create, or write into, codex's own home.
    eq(fs.existsSync(agentHomePath(home, "codex")), false, "installing claude must never create ~/.codex");
    eq(fs.existsSync(path.join(agentHomePath(home, "codex"), "hooks.json")), false, "installing claude must never register a codex hook");
    eq(fs.existsSync(path.join(agentHomePath(home, "codex"), "config.toml")), false, "installing claude must never write codex settings");
  });

  test("uninstall removes exactly what install added, leaving no orphaned file and no orphaned registration", () => {
    const home = fakeHome();
    const before = installBoth(home);
    ok(fs.existsSync(path.join(before.claude.root, "adapters", "codex", "dispatch.js")), "the extra Layer 1 file must exist before uninstall");

    const uninstalled = runCli(home, ["uninstall", "--agent", "claude", "--yes"]);
    eq(uninstalled.code, 0, `uninstall stdout:\n${uninstalled.stdout}\n${uninstalled.stderr}`);

    eq(fs.existsSync(before.claude.root), false, "the whole claude softela-ai/ payload, including the extra Layer 1 files, must be gone");
    const claudeSettings = readSettingsJson(home, "claude");
    const claudeDispatchNeedle = path.join("adapters", "claude", "dispatch.js");
    eq(findHookEntries(claudeSettings, claudeDispatchNeedle).length, 0, "no orphaned dispatcher registration must remain in claude's own settings.json");

    // Codex, installed alongside, must be entirely untouched by claude's uninstall.
    ok(fs.existsSync(path.join(before.codex.root, "adapters", "codex", "dispatch.js")));

    const codexUninstalled = runCli(home, ["uninstall", "--agent", "codex", "--yes"]);
    eq(codexUninstalled.code, 0, `uninstall stdout:\n${codexUninstalled.stdout}\n${codexUninstalled.stderr}`);
    eq(fs.existsSync(before.codex.root), false, "the whole codex softela-ai/ payload must be gone too");
  });

  test("Layer 2 on its own: a deliberately incomplete source skips the prune and warns, rather than deleting", () => {
    const home = fakeHome();
    const cloneDir = tmpdir();
    copyRepoSubset(cloneDir);
    const clonedCli = path.join(cloneDir, "bin", "softela-ai");
    ok(fs.existsSync(clonedCli));

    const installed = runCli(home, ["install", "--agent", "codex", "--yes"], { cliPath: clonedCli });
    eq(installed.code, 0, `install stdout:\n${installed.stdout}\n${installed.stderr}`);

    const dispatchPath = path.join(installedRootPath(home, "codex"), "adapters", "codex", "dispatch.js");
    ok(fs.existsSync(dispatchPath));

    // Deliberately break the source: the codex adapter directory a run would
    // otherwise sweep to decide what is "no longer shipped" is gone.
    fs.rmSync(path.join(cloneDir, "adapters", "codex"), { recursive: true, force: true });

    const updated = runCli(home, ["update", "--agent", "codex", "--yes"], { cliPath: clonedCli });
    ok(updated.code === 0 || updated.code === 2, `update from the incomplete clone crashed:\n${updated.stdout}\n${updated.stderr}`);

    ok(
      fs.existsSync(dispatchPath),
      "the codex adapter must survive an update whose source cannot produce it, rather than being pruned as 'no longer shipped'",
    );
    ok(updated.stdout.includes("WARNING"), `expected a loud warning in:\n${updated.stdout}`);
    ok(updated.stdout.includes("adapters/codex"), `expected the warning to name the missing area:\n${updated.stdout}`);

    const manifest = readManifest(home, "codex");
    ok(
      Object.keys(manifest.files).some((p) => p.endsWith("adapters/codex/dispatch.js")),
      "the manifest must still track the file the guard refused to prune",
    );
  });
});
