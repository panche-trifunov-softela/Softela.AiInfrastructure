"use strict";

/**
 * A scripted unattended first install (INSTALLER.md, CONTRACTS §11) must
 * ship what its own option flags say, not the module's plain default — the
 * exact use case `--memory-location` and `--reply-language` exist for.
 * Before this was fixed, `runInstallOrUpdate` built the plan from the state
 * already on disk, then folded the CLI flags into a *new* state object only
 * afterwards — so the very first run installed the module's own default and
 * only a later, unrelated run picked up what the flags actually asked for.
 */

const { suite } = require("../harness");
const { runCli, readSettingsJson, readText, agentHomePath } = require("./_home");
const path = require("path");

suite("installer/first-run-flags", ({ test, eq, ok, fakeHome }) => {
  test("[claude] --memory-location and --reply-language on the very first install land in this same run, not only in state.json", () => {
    const home = fakeHome();
    const installed = runCli(home, [
      "install",
      "--agent",
      "claude",
      "--yes",
      "--modules",
      "memory-as-context,reply-language",
      "--memory-location",
      "repo",
      "--reply-language",
      "de,en",
    ]);
    eq(installed.code, 0, `install stdout:\n${installed.stdout}\n${installed.stderr}`);

    const settings = readSettingsJson(home, "claude");
    const sessionStartEntries = (settings.hooks && settings.hooks.SessionStart) || [];
    const injectCommand = sessionStartEntries
      .flatMap((e) => e.hooks || [])
      .map((h) => h.command)
      .find((c) => typeof c === "string" && c.includes("inject-memory.js"));
    ok(injectCommand, "the memory-as-context SessionStart hook must be registered");
    ok(
      injectCommand.includes("--location=repo"),
      `the first run's own --memory-location flag must reach the installed hook command, got: ${injectCommand}`,
    );
    ok(
      !injectCommand.includes("--location=global"),
      "the module's plain default must not win over a flag passed on the very first run",
    );

    const claudeMd = readText(path.join(agentHomePath(home, "claude"), "CLAUDE.md"));
    ok(
      claudeMd.includes("Reply to the developer in de, en"),
      `the first run's own --reply-language flag must reach the rendered prompt block, got:\n${claudeMd}`,
    );
  });
});
