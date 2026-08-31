"use strict";

/**
 * Conflict detection and its three resolutions (INSTALLER.md's conflict
 * resolution section, `core/installer/conflicts.js`): a pre-existing local
 * hook registration this installer did not put there, found under the
 * agent's own home directory, must be surfaced and resolved deliberately —
 * never silently coexisted with, and never silently clobbered.
 */

const path = require("path");
const { suite } = require("../harness");
const {
  runCli,
  seedForeign,
  seedForeignHookUnderHome,
  agentHomePath,
  readManifest,
  readSettingsJson,
  listBackupDirs,
  readText,
} = require("./_home");
const { writeTextAtomic } = require("../../core/lib/fs-safe");
const detect = require("../../core/installer/detect");
const conflicts = require("../../core/installer/conflicts");

suite("installer/conflicts", ({ test, eq, ok, deepEq, fakeHome }) => {
  test("[claude] a foreign hook registered under the agent home is detected as a conflict", () => {
    const home = fakeHome();
    const seeded = seedForeignHookUnderHome(home, "claude");

    const found = conflicts.detectConflicts(detect.gather("claude"));
    ok(conflicts.hasConflicts(found), "expected a conflict to be detected");
    eq(found.hookGroups.length, 1);
    eq(found.hookGroups[0].event, seeded.event);
    eq(found.hookGroups[0].hooks.length, 1);
    eq(found.hookGroups[0].hooks[0].command, seeded.command);
    eq(found.hookGroups[0].hooks[0].scriptPath, path.resolve(seeded.scriptPath));
    eq(found.managedBlock, null);
  });

  test("[codex] a foreign hook group registered under the agent home is detected as a conflict", () => {
    const home = fakeHome();
    const seeded = seedForeignHookUnderHome(home, "codex");

    const found = conflicts.detectConflicts(detect.gather("codex"));
    ok(conflicts.hasConflicts(found), "expected a conflict to be detected");
    eq(found.hookGroups.length, 1);
    eq(found.hookGroups[0].event, seeded.event);
    eq(found.hookGroups[0].hooks[0].command, seeded.command);
  });

  test("a hook whose command points outside the agent home is not a conflict", () => {
    const home = fakeHome();
    // seedForeign's own hook command references /home/dev/own-hook.js —
    // deliberately outside the fake agent home.
    seedForeign(home, "claude");

    const found = conflicts.detectConflicts(detect.gather("claude"));
    ok(!conflicts.hasConflicts(found), "a deliberately external hook must never be reported as a conflict");
  });

  test("an softela-ai-owned hook is not a conflict", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    const found = conflicts.detectConflicts(detect.gather("claude"));
    ok(!conflicts.hasConflicts(found), "the installer's own registration must never be reported as a conflict against itself");
  });

  test("a populated memory directory, with or without its own git repository, is not a conflict", () => {
    const home = fakeHome();
    const agentDir = agentHomePath(home, "claude");
    writeTextAtomic(path.join(agentDir, "memory", "MEMORY.md"), "# pre-existing memory\n\npredates softela-ai.\n");
    writeTextAtomic(path.join(agentDir, "memory", ".git", "HEAD"), "ref: refs/heads/main\n");

    const found = conflicts.detectConflicts(detect.gather("claude"));
    ok(!conflicts.hasConflicts(found), "a memory directory must never be reported as a conflict, regardless of its own git repo");
  });

  test("[codex] the memories directory is not a conflict, and install never reads or writes it", () => {
    const home = fakeHome();
    const memoriesFile = path.join(agentHomePath(home, "codex"), "memories", "some-native-memory.json");
    writeTextAtomic(memoriesFile, '{"native": true}\n');
    const before = readText(memoriesFile);

    const found = conflicts.detectConflicts(detect.gather("codex"));
    ok(!conflicts.hasConflicts(found), "codex's own native memories directory must never be reported as a conflict");

    eq(runCli(home, ["install", "--agent", "codex", "--yes"]).code, 0);
    eq(readText(memoriesFile), before, "codex's native memories file must survive install byte-for-byte, untouched");
  });

  test("non-interactive with an unresolved conflict and no flag: aborts, writes nothing, and names all three flag values", () => {
    const home = fakeHome();
    const seeded = seedForeignHookUnderHome(home, "claude");

    const result = runCli(home, ["install", "--agent", "claude", "--yes"]);
    ok(result.code !== 0, `expected a non-zero exit, got ${result.code}:\n${result.stdout}\n${result.stderr}`);
    ok(result.stdout.includes("--on-conflict=replace"), result.stdout);
    ok(result.stdout.includes("--on-conflict=reconcile"), result.stdout);
    ok(result.stdout.includes("--on-conflict=abort"), result.stdout);

    eq(readManifest(home, "claude"), null, "nothing must be written when a conflict is left unresolved");
    const settingsAfter = readSettingsJson(home, "claude");
    deepEq(
      settingsAfter.hooks[seeded.event][0].hooks[0].command,
      seeded.command,
      "the developer's own registration must survive completely untouched",
    );
  });

  test("--on-conflict=abort: exits non-zero, nothing written", () => {
    const home = fakeHome();
    const seeded = seedForeignHookUnderHome(home, "claude");

    const result = runCli(home, ["install", "--agent", "claude", "--yes", "--on-conflict", "abort"]);
    ok(result.code !== 0, `expected a non-zero exit, got ${result.code}:\n${result.stdout}\n${result.stderr}`);
    ok(result.stdout.includes(seeded.command), result.stdout);

    eq(readManifest(home, "claude"), null);
    const settingsAfter = readSettingsJson(home, "claude");
    deepEq(settingsAfter.hooks[seeded.event][0].hooks[0].command, seeded.command);
  });

  test('--on-conflict=reconcile: exits non-zero, no merge attempted, and the output names the conflict and its question', () => {
    const home = fakeHome();
    const seeded = seedForeignHookUnderHome(home, "claude");

    const result = runCli(home, ["install", "--agent", "claude", "--yes", "--on-conflict", "reconcile"]);
    ok(result.code !== 0, `expected a non-zero exit, got ${result.code}:\n${result.stdout}\n${result.stderr}`);
    ok(result.stdout.toLowerCase().includes("does not merge"), result.stdout);
    ok(result.stdout.includes(seeded.command), "the reconcile report must name what the developer already has");
    ok(result.stdout.toLowerCase().includes("question:"), "the reconcile report must state the question to answer");

    eq(readManifest(home, "claude"), null, "reconcile must never write anything");
    const settingsAfter = readSettingsJson(home, "claude");
    deepEq(settingsAfter.hooks[seeded.event][0].hooks[0].command, seeded.command);
  });

  test('--on-conflict=replace: the foreign registration is gone, softela-ai\'s own is registered, the script file survives, and the backup is made and named', () => {
    const home = fakeHome();
    const seeded = seedForeignHookUnderHome(home, "claude");
    const settingsBefore = readText(path.join(agentHomePath(home, "claude"), "settings.json"));

    const result = runCli(home, ["install", "--agent", "claude", "--yes", "--on-conflict", "replace"]);
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);

    const settingsAfter = readSettingsJson(home, "claude");
    const stillForeign = (settingsAfter.hooks[seeded.event] || []).some((entry) =>
      (entry.hooks || []).some((h) => h.command === seeded.command),
    );
    ok(!stillForeign, "the foreign registration must be gone");

    const registeredOurs = (settingsAfter.hooks.PreToolUse || []).some((entry) =>
      (entry.hooks || []).some((h) => typeof h.command === "string" && h.command.includes("dispatch.js")),
    );
    ok(registeredOurs, "softela-ai's own dispatcher hook must be registered");

    ok(readText(seeded.scriptPath) !== null, "the developer's own script file must still exist on disk");

    const dirs = listBackupDirs(home, "claude");
    eq(dirs.length, 1);
    eq(readText(path.join(dirs[0], "settings.json")), settingsBefore, "the backup must hold exactly the pre-change settings.json");

    ok(result.stdout.includes(dirs[0]), "the output must name the backup path");
    ok(result.stdout.includes(seeded.command), "the output must name what was disabled");
    ok(!result.stdout.includes("(undefined)"), `the conflict-removal action must never leak into the generic plan line renderer:\n${result.stdout}`);

    const manifest = readManifest(home, "claude");
    ok(manifest && manifest.files && Object.keys(manifest.files).length > 0, "a normal install must still proceed once the conflict is resolved");
  });

  test("--on-conflict=replace --dry-run: nothing changes on disk", () => {
    const home = fakeHome();
    const seeded = seedForeignHookUnderHome(home, "claude");
    const settingsBefore = readText(path.join(agentHomePath(home, "claude"), "settings.json"));

    const result = runCli(home, ["install", "--agent", "claude", "--yes", "--on-conflict", "replace", "--dry-run"]);
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);

    eq(readText(path.join(agentHomePath(home, "claude"), "settings.json")), settingsBefore, "dry-run must never write settings.json");
    eq(readManifest(home, "claude"), null, "dry-run must never write a manifest");
    eq(listBackupDirs(home, "claude").length, 0, "dry-run must never create a backup");
    ok(readText(seeded.scriptPath) !== null);
  });

  test("update sees the same unresolved conflict as install, and also refuses to guess", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "claude", "--yes", "--on-conflict", "replace"]).code, 0);

    const seeded = seedForeignHookUnderHome(home, "claude", { relScriptPath: "hooks/mine-second.js" });
    const manifestBefore = readManifest(home, "claude");

    const result = runCli(home, ["update", "--agent", "claude", "--yes"]);
    ok(result.code !== 0, `expected a non-zero exit, got ${result.code}:\n${result.stdout}\n${result.stderr}`);
    ok(result.stdout.includes(seeded.command), result.stdout);

    deepEq(readManifest(home, "claude"), manifestBefore, "an unresolved conflict on update must change nothing, including the manifest");
  });
});
