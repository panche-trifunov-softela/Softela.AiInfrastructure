"use strict";

/**
 * `--dry-run` (INSTALLER.md §2, §3): writes nothing at all, and the plan it
 * prints matches what a real run then executes.
 */

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");
const { runCli, seedForeign, installedRootPath, readManifest, readText } = require("./_home");

/**
 * Strips a plan's leading `softela-ai install/update -> <agent>` header line and
 * its trailing closing summary — both legitimately differ between a dry run
 * and a real run (the header names the preview explicitly; the closing
 * summary reports what was actually written, or that nothing was) — leaving
 * only the per-action lines a real run's own plan should match exactly.
 *
 * @param {string} stdout The CLI's captured stdout.
 * @returns {string[]} The remaining lines, trimmed of trailing blanks.
 */
function planBodyLines(stdout) {
  const lines = stdout.split("\n").slice(1);
  // printClosingSummary's own first line is the only unindented line that
  // starts with "Done." (a real run) or "Preview only" (a dry run) —
  // everything from there on is the closing section, not part of the plan
  // itself, and the two legitimately differ.
  const closingStart = lines.findIndex((l) => /^(Done\.|Preview only\b)/.test(l));
  const body = closingStart === -1 ? lines : lines.slice(0, closingStart);
  return body
    .filter((l) => l.trim().length > 0)
    // A real run additionally reports what it actually did (backups
    // written, locally-modified files kept); a dry run never applies
    // anything, so it has nothing to report there — only the plan itself,
    // which is what this comparison is about, needs to match.
    .filter((l) => !/^ {2}(backups|kept locally-modified|error):/.test(l));
}

suite("installer/dry-run", ({ test, eq, deepEq, ok, fakeHome }) => {
  for (const agent of ["claude", "codex"]) {
    test(`[${agent}] --dry-run writes nothing at all`, () => {
      const home = fakeHome();
      const foreign = seedForeign(home, agent);
      const settingsBefore = readText(foreign.settingsPath);

      const result = runCli(home, ["install", "--agent", agent, "--yes", "--dry-run"]);
      eq(result.code, 0, `dry-run install stdout:\n${result.stdout}\n${result.stderr}`);

      eq(fs.existsSync(installedRootPath(home, agent)), false, "no payload may be written on a dry run");
      eq(fs.existsSync(path.join(require("./_home").agentHomePath(home, agent), ".softela-ai", "manifest.json")), false);
      eq(readText(foreign.settingsPath), settingsBefore, "the settings file must be byte-for-byte untouched");
    });

    test(`[${agent}] --dry-run's plan matches what the real run then does`, () => {
      const home = fakeHome();
      seedForeign(home, agent);

      const dry = runCli(home, ["install", "--agent", agent, "--yes", "--dry-run"]);
      const real = runCli(home, ["install", "--agent", agent, "--yes"]);
      eq(real.code, 0, `real install stdout:\n${real.stdout}\n${real.stderr}`);

      deepEq(planBodyLines(dry.stdout), planBodyLines(real.stdout));
    });

    test(`[${agent}] --dry-run on update reports the same "nothing changed" state as a real update`, () => {
      const home = fakeHome();
      seedForeign(home, agent);
      eq(runCli(home, ["install", "--agent", agent, "--yes"]).code, 0);
      const manifestBefore = readManifest(home, agent);

      const dryUpdate = runCli(home, ["update", "--agent", agent, "--yes", "--dry-run"]);
      eq(dryUpdate.code, 2);
      deepEq(readManifest(home, agent), manifestBefore, "a dry-run update must never write the manifest");

      ok(fs.existsSync(installedRootPath(home, agent)));
    });
  }
});
