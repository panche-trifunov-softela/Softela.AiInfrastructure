"use strict";

/**
 * The installer sequences INSTALLER.md and CONTRACTS §11 make the whole
 * project stand or fall on:
 *
 * 1. install -> update -> nothing changes
 * 2. install -> a shipped file is edited -> update -> the edit survives,
 *    the new version lands beside it as `.new`
 * 3. install onto a home that already has hooks, skills, settings and
 *    memory -> all of it is still present and unmodified afterwards
 * 5. install -> uninstall -> only managed artefacts are gone
 *
 * (Sequence 4, deleting the clone, is `delete-clone.test.js` — it needs its
 * own copied repository and is slow enough to keep separate.)
 *
 * Every assertion here drives the real `bin/softela-ai` as a subprocess, exactly
 * as a developer would, against a fake home pre-populated with content that
 * predates softela-ai (`_home.js#seedForeign`).
 */

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");
const { runCli, seedForeign, agentHomePath, installedRootPath, readManifest, readState, readSettingsJson, findHookEntries, readText } = require("./_home");

const AGENTS = ["claude", "codex"];

suite("installer/sequences", ({ test, eq, deepEq, ok, fakeHome }) => {
  for (const agent of AGENTS) {
    // A suffix of the absolute needle `plan.js` matches hook ownership on —
    // built with `path.join` so its separators match the command string's,
    // whatever the platform.
    const dispatchNeedle = path.join("adapters", agent, "dispatch.js");

    test(`[${agent}] sequence 1 — install, then update, changes nothing`, () => {
      const home = fakeHome();
      const foreign = seedForeign(home, agent);

      const installed = runCli(home, ["install", "--agent", agent, "--yes"]);
      eq(installed.code, 0, `install stdout:\n${installed.stdout}\n${installed.stderr}`);

      const manifestAfterInstall = readManifest(home, agent);
      const stateAfterInstall = readState(home, agent);
      ok(manifestAfterInstall && Object.keys(manifestAfterInstall.files).length > 0);

      const updated = runCli(home, ["update", "--agent", agent, "--yes"]);
      eq(updated.code, 2, `update stdout:\n${updated.stdout}\n${updated.stderr}`);
      // Every unchanged line still prints as "=" (kept), so absence of change
      // is asserted through the exit code and the untouched manifest below,
      // not by scraping for a literal "nothing to do" string.
      ok(!/\n {2}[+~!-] /.test(updated.stdout), `expected no actionable lines in:\n${updated.stdout}`);

      deepEq(readManifest(home, agent), manifestAfterInstall);
      deepEq(readState(home, agent), stateAfterInstall);
      eq(readText(foreign.foreignHookPath), foreign.foreignHookContent);
      eq(readText(foreign.memoryPath), foreign.memoryContent);
    });

    test(`[${agent}] sequence 2 — an edited shipped file survives update, and the new version lands as .new`, () => {
      const home = fakeHome();
      seedForeign(home, agent);
      eq(runCli(home, ["install", "--agent", agent, "--yes"]).code, 0);

      const manifest = readManifest(home, agent);
      const relPath = Object.keys(manifest.files).find((p) => p.endsWith("core/lib/decision.js"));
      ok(relPath, "expected core/lib/decision.js to be tracked by the manifest");
      const installedAbsPath = path.join(agentHomePath(home, agent), relPath.split("/").join(path.sep));

      const edited = `${readText(installedAbsPath)}\n// the developer's own local edit\n`;
      fs.writeFileSync(installedAbsPath, edited, "utf8");

      const updated = runCli(home, ["update", "--agent", agent, "--yes"]);
      eq(updated.code, 0, `update stdout:\n${updated.stdout}\n${updated.stderr}`);

      eq(readText(installedAbsPath), edited, "the developer's edit must survive an update untouched");

      const newSiblingPath = `${installedAbsPath}.new`;
      ok(fs.existsSync(newSiblingPath), "the shipped version must land beside the edit as .new");
      const shippedSource = readText(path.join(require("./_home").REPO_ROOT, relPath.replace(/^softela-ai\//, "")));
      eq(readText(newSiblingPath), shippedSource);
    });

    test(`[${agent}] sequence 3 — installing onto a home with existing hooks, skills, settings and memory leaves all of it intact`, () => {
      const home = fakeHome();
      const foreign = seedForeign(home, agent);
      const settingsBeforeBytes = readText(foreign.settingsPath);

      eq(runCli(home, ["install", "--agent", agent, "--yes"]).code, 0);

      eq(readText(foreign.foreignHookPath), foreign.foreignHookContent, "the developer's own hook must survive byte-for-byte");
      eq(readText(foreign.skillPath), foreign.skillContent, "the developer's own skill must survive byte-for-byte");
      eq(readText(foreign.memoryPath), foreign.memoryContent, "the developer's own memory must survive byte-for-byte");

      const settingsAfter = readSettingsJson(home, agent);
      if (agent === "codex") {
        ok(JSON.stringify(settingsAfter).includes("own-session-hook.js"), "the developer's own hook registration must survive inside hooks.json");
        const configAfter = readText(foreign.configPath);
        ok(configAfter.includes("# personal config, hand maintained"));
        ok(configAfter.includes('model = "gpt-6-titan"'), "an already-set seed value must not be overwritten");
        ok(configAfter.includes("[sandbox]"));
        const agentsMdAfter = readText(foreign.agentsMdPath);
        ok(agentsMdAfter.includes("My own Codex notes"), "the developer's own AGENTS.md content must survive outside the managed block");
      } else {
        ok(JSON.stringify(settingsAfter).includes("own-hook.js"), "the developer's own hook registration must survive inside settings.json");
        eq(settingsAfter.model, "opus-4-custom", "an already-set seed value must not be overwritten");
        deepEq(settingsAfter.permissions, { allow: ["Bash(ls:*)"] }, "settings the installer does not manage must be preserved key-for-key");
        const claudeMdAfter = readText(foreign.claudeMdPath);
        ok(claudeMdAfter.includes("Always answer in German."), "the developer's own CLAUDE.md content must survive outside the managed block");
      }

      // The pre-existing settings entry itself is still there — not replaced,
      // only merged into: the installer's own entries were added, not written
      // in place of the developer's.
      ok(settingsBeforeBytes.length > 0);
      const foreignEntries = findHookEntries(settingsAfter, agent === "codex" ? "own-session-hook.js" : "own-hook.js");
      ok(foreignEntries.length >= 1);
      const ourEntries = findHookEntries(settingsAfter, dispatchNeedle);
      ok(ourEntries.length >= 1);
    });

    test(`[${agent}] sequence 5 — uninstall removes only managed artefacts`, () => {
      const home = fakeHome();
      const foreign = seedForeign(home, agent);
      eq(runCli(home, ["install", "--agent", agent, "--yes"]).code, 0);

      const seedSnapshot = agent === "codex" ? readText(foreign.configPath) : readSettingsJson(home, agent).model;

      const uninstalled = runCli(home, ["uninstall", "--agent", agent, "--yes"]);
      eq(uninstalled.code, 0, `uninstall stdout:\n${uninstalled.stdout}\n${uninstalled.stderr}`);

      eq(fs.existsSync(installedRootPath(home, agent)), false, "the softela-ai/ payload must be fully removed");

      const settingsAfter = readSettingsJson(home, agent);
      eq(findHookEntries(settingsAfter, dispatchNeedle).length, 0, "our dispatcher registration must be gone");
      const foreignEntries = findHookEntries(settingsAfter, agent === "codex" ? "own-session-hook.js" : "own-hook.js");
      ok(foreignEntries.length >= 1, "the developer's own hook registration must remain");

      // The default install also enables memory-as-context, which registers
      // three of its own hooks (SessionStart/PreToolUse/PostToolUse). Each
      // one must be gone too — not only the core dispatcher's own entry —
      // since uninstall just deleted the files these commands invoke.
      for (const script of ["inject-memory.js", "guard-memory.js", "memory-autocommit.js"]) {
        eq(
          findHookEntries(settingsAfter, script).length,
          0,
          `memory-as-context's ${script} registration must be removed by uninstall too, not just the core dispatcher's`,
        );
      }

      if (agent === "codex") {
        eq(readText(foreign.configPath), seedSnapshot, "seed settings in config.toml are never touched by uninstall");
      } else {
        eq(settingsAfter.model, seedSnapshot, "a seed setting is the developer's own now and must survive uninstall");
      }

      eq(readText(foreign.foreignHookPath), foreign.foreignHookContent);
      eq(readText(foreign.skillPath), foreign.skillContent);
      eq(readText(foreign.memoryPath), foreign.memoryContent);

      const globalDocPath = agent === "codex" ? foreign.agentsMdPath : foreign.claudeMdPath;
      const globalDocAfter = readText(globalDocPath);
      ok(!globalDocAfter.includes("BEGIN softela-ai"), "the managed block markers must be gone");
      ok(
        globalDocAfter.includes(agent === "codex" ? "My own Codex notes" : "Always answer in German."),
        "content outside the managed block must survive uninstall",
      );

      const again = runCli(home, ["uninstall", "--agent", agent, "--yes"]);
      eq(again.code, 2, "uninstalling an already-uninstalled agent has nothing to do");

      const againDry = runCli(home, ["uninstall", "--agent", agent, "--yes", "--dry-run"]);
      eq(againDry.code, 2, "a dry-run uninstall with nothing to do must also report exit code 2");
    });

    test(`[${agent}] uninstall refuses to delete a locally modified shipped file`, () => {
      const home = fakeHome();
      seedForeign(home, agent);
      eq(runCli(home, ["install", "--agent", agent, "--yes"]).code, 0);

      const manifest = readManifest(home, agent);
      const relPath = Object.keys(manifest.files).find((p) => p.endsWith("core/lib/decision.js"));
      const installedAbsPath = path.join(agentHomePath(home, agent), relPath.split("/").join(path.sep));
      const edited = `${readText(installedAbsPath)}\n// kept on purpose\n`;
      fs.writeFileSync(installedAbsPath, edited, "utf8");

      const uninstalled = runCli(home, ["uninstall", "--agent", agent, "--yes"]);
      eq(uninstalled.code, 3, "a locally modified file must make uninstall refuse, not silently succeed");
      eq(fs.existsSync(installedAbsPath), true, "the locally modified file itself must survive");
      eq(readText(installedAbsPath), edited);
    });
  }
});
