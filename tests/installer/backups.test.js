"use strict";

/**
 * Backups (INSTALLER.md §7): every file the installer is about to modify is
 * copied into `<agentHome>/.softela-ai/backups/<timestamp>/` first, holding
 * exactly what was on disk immediately before the write.
 */

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");
const { runCli, seedForeign, agentHomePath, listBackupDirs, readText } = require("./_home");
const { writeJsonAtomic } = require("../../core/lib/fs-safe");

suite("installer/backups", ({ test, eq, ok, fakeHome }) => {
  test("[claude] the pre-existing settings.json and CLAUDE.md are backed up on first install", () => {
    const home = fakeHome();
    const foreign = seedForeign(home, "claude");
    const settingsBefore = readText(foreign.settingsPath);
    const claudeMdBefore = readText(foreign.claudeMdPath);

    const result = runCli(home, ["install", "--agent", "claude", "--yes"]);
    eq(result.code, 0);
    ok(/backups: /.test(result.stdout), "a run that wrote something must print where the backup went");

    const dirs = listBackupDirs(home, "claude");
    eq(dirs.length, 1);
    eq(readText(path.join(dirs[0], "settings.json")), settingsBefore, "the backup must hold exactly the pre-install bytes");
    eq(readText(path.join(dirs[0], "CLAUDE.md")), claudeMdBefore);
  });

  test("[codex] the pre-existing hooks.json, config.toml and AGENTS.md are backed up on first install", () => {
    const home = fakeHome();
    const foreign = seedForeign(home, "codex");
    const hooksBefore = readText(foreign.settingsPath);
    const configBefore = readText(foreign.configPath);
    const agentsMdBefore = readText(foreign.agentsMdPath);

    eq(runCli(home, ["install", "--agent", "codex", "--yes"]).code, 0);

    const dirs = listBackupDirs(home, "codex");
    eq(dirs.length, 1);
    eq(readText(path.join(dirs[0], "hooks.json")), hooksBefore);
    eq(readText(path.join(dirs[0], "config.toml")), configBefore);
    eq(readText(path.join(dirs[0], "AGENTS.md")), agentsMdBefore);
  });

  test("nothing is backed up for a file that did not exist before install", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    const dirs = listBackupDirs(home, "claude");
    const backedUpRelPaths = dirs.flatMap((d) => walkFiles(d, home, "claude"));
    ok(!backedUpRelPaths.some((p) => p.includes("softela-ai/core/engine.js")), "a brand-new shipped file has nothing on disk yet to back up");
  });

  test("a second write against an already-backed-up-once file creates a fresh backup generation", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);
    const firstGenerationCount = listBackupDirs(home, "claude").length;

    // Tamper with the enforce hook entry so the next update has to rewrite
    // settings.json again, triggering a second backup generation.
    const settingsPath = path.join(agentHomePath(home, "claude"), "settings.json");
    const settings = JSON.parse(readText(settingsPath));
    settings.hooks.PreToolUse[settings.hooks.PreToolUse.length - 1].matcher = "Changed";
    writeJsonAtomic(settingsPath, settings);
    const tamperedBytes = readText(settingsPath);

    eq(runCli(home, ["update", "--agent", "claude", "--yes"]).code, 0);
    const dirs = listBackupDirs(home, "claude");
    eq(dirs.length, firstGenerationCount + 1, "each run that writes something gets its own backup generation");

    const latest = dirs.sort().pop();
    eq(readText(path.join(latest, "settings.json")), tamperedBytes, "the newest backup must hold what was on disk right before this run's write");
  });
});

/**
 * Lists a backup directory's own files as manifest-style relative paths, for
 * comparing against what an install would have tracked.
 *
 * @param {string} backupDir A single `<timestamp>` backup directory.
 * @param {string} home The fake home root.
 * @param {"claude" | "codex"} agent The agent.
 * @returns {string[]} Paths relative to the backup directory, POSIX-separated.
 */
function walkFiles(backupDir, home, agent) {
  const out = [];
  function walk(dir, rel) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, relPath);
      else out.push(relPath);
    }
  }
  walk(backupDir, "");
  return out;
}
