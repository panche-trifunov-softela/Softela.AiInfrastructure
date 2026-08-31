"use strict";

/**
 * Sequence 4 (INSTALLER.md, CONTRACTS §11): install -> delete the clone ->
 * everything still works. The property under test is "copy, never link" —
 * nothing installed may reference a path inside the repository this test
 * copied from.
 *
 * Simulated properly, per the task: the repository is copied to a temp
 * location, install runs from that copy, the copy is deleted, and then both
 * the installed CLI and the installed dispatcher are run as subprocesses —
 * so a stale `require` cache in this test process cannot hide a real path
 * dependency on the deleted clone.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { suite } = require("../harness");
const { copyRepoSubset, agentHomePath, installedRootPath, readManifest, readText } = require("./_home");

/**
 * Runs a copied repository's own `bin/softela-ai` as a subprocess.
 *
 * @param {string} cliPath Absolute path to a `bin/softela-ai` file.
 * @param {string} home The fake home root to target (`SOFTELA_AI_HOME`).
 * @param {string[]} args CLI arguments.
 * @returns {{code: number, stdout: string, stderr: string}} The process's
 * exit code and captured output.
 */
function runAt(cliPath, home, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, SOFTELA_AI_HOME: home },
    encoding: "utf8",
    timeout: 30000,
  });
  return { code: result.status === null ? -1 : result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

suite("installer/delete-clone", ({ test, eq, ok, fakeHome, tmpdir }) => {
  for (const agent of ["claude", "codex"]) {
    test(`[${agent}] install from a copied clone, delete the copy, the installed CLI and dispatcher still work`, () => {
      const home = fakeHome();
      const cloneDir = tmpdir();
      copyRepoSubset(cloneDir);
      const clonedCliPath = path.join(cloneDir, "bin", "softela-ai");
      ok(fs.existsSync(clonedCliPath));

      const installed = runAt(clonedCliPath, home, ["install", "--agent", agent, "--yes"]);
      eq(installed.code, 0, `install from the copy failed:\n${installed.stdout}\n${installed.stderr}`);

      const manifest = readManifest(home, agent);
      ok(manifest && Object.keys(manifest.files).length > 0);

      // Nothing installed may name the clone's own path.
      const installedDispatchPath = path.join(installedRootPath(home, agent), "adapters", agent, "dispatch.js");
      ok(fs.existsSync(installedDispatchPath));
      const settingsFile = agent === "codex" ? "hooks.json" : "settings.json";
      const settingsText = readText(path.join(agentHomePath(home, agent), settingsFile));
      ok(!settingsText.includes(cloneDir), "a hook registration must never reference the clone's own path");

      // Written at install time so `detect.readVersion` has something to
      // fall back to once `package.json` is no longer reachable from the
      // installed copy's own `repoRoot()` (IMPORTANT I5).
      const versionMarkerPath = path.join(installedRootPath(home, agent), "VERSION");
      ok(fs.existsSync(versionMarkerPath), "the VERSION marker must be written into the agent home at install time");
      const versionMarker = readText(versionMarkerPath).trim();
      ok(versionMarker.length > 0);

      fs.rmSync(cloneDir, { recursive: true, force: true });
      eq(fs.existsSync(cloneDir), false);

      const installedCliPath = path.join(installedRootPath(home, agent), "bin", "softela-ai");
      ok(fs.existsSync(installedCliPath), "the installed CLI must remain after the clone is gone");

      const doctorAfter = runAt(installedCliPath, home, ["doctor", "--agent", agent, "--json"]);
      ok(doctorAfter.code === 0 || doctorAfter.code === 1, `doctor via the installed CLI crashed:\n${doctorAfter.stdout}\n${doctorAfter.stderr}`);
      const report = JSON.parse(doctorAfter.stdout);
      eq(report.agents[0].installed, true);
      // Before I5 was fixed, `repoVersion` fell back to the fabricated
      // "0.0.0" and every installed agent falsely reported "update
      // available" forever, with no source repository left to update from.
      eq(report.repoVersion, versionMarker, "the VERSION marker must be what doctor compares against once the clone is gone");
      eq(report.agents[0].updateAvailable, false, "the installed version must match the VERSION marker exactly — no phantom update");

      const doctorText = runAt(installedCliPath, home, ["doctor", "--agent", agent]);
      ok(
        !doctorText.stdout.includes("0.0.0"),
        `doctor must never fabricate version 0.0.0 once a real VERSION marker exists:\n${doctorText.stdout}`,
      );

      // Every module's catalogue metadata ships regardless of what was
      // enabled at install time, so "module list" stays fully discoverable
      // and "module enable" on a never-installed module fails with a clear,
      // actionable message instead of "unknown module" (IMPORTANT I6).
      const moduleListJson = runAt(installedCliPath, home, ["module", "list", "--agent", agent, "--json"]);
      eq(moduleListJson.code, 0, moduleListJson.stdout + moduleListJson.stderr);
      const moduleList = JSON.parse(moduleListJson.stdout);
      ok(moduleList.modules.length >= 1, "the catalogue must list every module the repository ships, not only the ones enabled");

      const neverEnabledId = moduleList.modules.map((m) => m.id).find((id) => !report.agents[0].enabledModules.includes(id));
      if (neverEnabledId) {
        const enableAttempt = runAt(installedCliPath, home, ["module", "enable", neverEnabledId, "--agent", agent, "--yes"]);
        eq(enableAttempt.code, 1, `enabling ${neverEnabledId} from an installed-only copy must fail plainly:\n${enableAttempt.stdout}`);
        ok(
          enableAttempt.stdout.includes("needs the source repository"),
          `the failure must explain that the source repository is required, got:\n${enableAttempt.stdout}`,
        );
      }

      const dispatchResult = spawnSync(process.execPath, [installedDispatchPath], {
        env: { ...process.env, SOFTELA_AI_HOME: home },
        input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} }),
        encoding: "utf8",
        timeout: 10000,
      });
      eq(dispatchResult.status, 0, `the installed dispatcher must still run after the clone is gone:\n${dispatchResult.stderr}`);
    });
  }
});
