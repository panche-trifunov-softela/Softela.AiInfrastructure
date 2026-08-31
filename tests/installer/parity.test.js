"use strict";

/**
 * `doctor`'s Claude/Codex parity report (INSTALLER.md §8's parity block,
 * `core/installer/doctor.js#buildParityReport`) — this repository exists so
 * both agents behave identically, and this is what actually shows a
 * developer whether they do.
 */

const path = require("path");
const { suite } = require("../harness");
const { runCli, agentHomePath, readJson } = require("./_home");
const { writeJsonAtomic, writeTextAtomic } = require("../../core/lib/fs-safe");
const doctor = require("../../core/installer/doctor");

/**
 * Runs `doctor --json` and parses its report.
 *
 * @param {string} home The fake home root.
 * @param {string[]} [extraArgs] Extra CLI arguments, e.g. `["--agent", "claude"]`.
 * @returns {object} The parsed `doctor` report.
 */
function doctorReport(home, extraArgs = []) {
  const result = runCli(home, ["doctor", "--json", ...extraArgs]);
  return JSON.parse(result.stdout);
}

/**
 * Pre-seeds a `config.toml` carrying nothing but a comment, so a case can
 * assert against a file whose content this tool did not write.
 *
 * An install no longer needs this to seed at all — `plan.js#planModuleSettings`
 * creates an absent `config.toml` and writes every Codex seed into it — so
 * this exists purely to exercise the "the file was already there" path
 * alongside the "we created it" one.
 *
 * @param {string} home The fake home root.
 * @returns {void}
 */
function seedEmptyCodexConfig(home) {
  writeTextAtomic(path.join(agentHomePath(home, "codex"), "config.toml"), "# seeded for parity testing\n");
}

suite("installer/parity", ({ test, eq, ok, deepEq, fakeHome }) => {
  test("two identically-installed agent homes report every row matched", () => {
    const home = fakeHome();
    seedEmptyCodexConfig(home);
    eq(runCli(home, ["install", "--agent", "all", "--yes"]).code, 0);

    const report = doctorReport(home, ["--agent", "all"]);
    ok(report.parity.comparable, "both agents are installed — parity must be assessable");
    eq(report.parity.verdict, "match");
    for (const row of report.parity.rows) {
      ok(row.matched, `expected every row matched, but "${row.aspect}" was not: claude=${row.claude} codex=${row.codex} note=${row.note}`);
    }

    // A clean install actually has a real Codex value to compare against
    // what shipped — this row must report that match plainly, not fall back
    // to "not independently verifiable" now that a real comparison exists.
    const seedRow = report.parity.rows.find((r) => r.aspect === "seed settings changed from shipped default");
    ok(seedRow, "expected a seed-settings-changed parity row");
    eq(seedRow.codex, "(none)", `expected codex's column to report a real match, got: ${JSON.stringify(seedRow)}`);

    const lines = runCli(home, ["doctor", "--agent", "all"]).stdout;
    ok(lines.includes("parity (claude vs codex): match"), lines);
  });

  test("an asymmetric module set produces exactly one mismatched row", () => {
    const home = fakeHome();
    seedEmptyCodexConfig(home);
    eq(runCli(home, ["install", "--agent", "all", "--yes"]).code, 0);

    // session-cleanup ships no hooks and no settings, so enabling it for one
    // agent only touches the enabled-module set, nothing else this report
    // compares.
    eq(runCli(home, ["module", "enable", "session-cleanup", "--agent", "claude", "--yes"]).code, 0);

    const report = doctorReport(home, ["--agent", "all"]);
    eq(report.parity.verdict, "mismatch");
    const mismatched = report.parity.rows.filter((r) => !r.matched);
    eq(mismatched.length, 1, `expected exactly one mismatched row, got: ${JSON.stringify(mismatched)}`);
    eq(mismatched[0].aspect, "enabled modules");
    ok(mismatched[0].note.includes("session-cleanup"), mismatched[0].note);
  });

  test("an asymmetric model tier produces exactly one mismatched row", () => {
    const home = fakeHome();
    seedEmptyCodexConfig(home);
    eq(runCli(home, ["install", "--agent", "all", "--yes"]).code, 0);

    // Hand-edit claude's own settings.json to a different, still-recognised
    // tier than what was seeded ("opus", frontier) — a developer's own
    // deliberate choice, exactly what "seed" mode is supposed to leave alone
    // on every later run.
    const settingsPath = path.join(agentHomePath(home, "claude"), "settings.json");
    const settings = readJson(settingsPath);
    settings.model = "sonnet";
    writeJsonAtomic(settingsPath, settings);

    const report = doctorReport(home, ["--agent", "all"]);
    eq(report.parity.verdict, "mismatch");
    const mismatched = report.parity.rows.filter((r) => !r.matched);
    eq(mismatched.length, 1, `expected exactly one mismatched row, got: ${JSON.stringify(mismatched)}`);
    eq(mismatched[0].aspect, "main model");
  });

  test("an asymmetric rule override produces exactly one mismatched row", () => {
    const home = fakeHome();
    seedEmptyCodexConfig(home);
    eq(runCli(home, ["install", "--agent", "all", "--yes"]).code, 0);

    const overrideResult = runCli(home, [
      "override",
      "forbidden-commands",
      "off",
      "--reason",
      "asymmetric parity test",
      "--agent",
      "claude",
      "--yes",
    ]);
    eq(overrideResult.code, 0, `override stdout:\n${overrideResult.stdout}\n${overrideResult.stderr}`);

    const report = doctorReport(home, ["--agent", "all"]);
    eq(report.parity.verdict, "mismatch");
    const mismatched = report.parity.rows.filter((r) => !r.matched);
    eq(mismatched.length, 1, `expected exactly one mismatched row, got: ${JSON.stringify(mismatched)}`);
    eq(mismatched[0].aspect, "rule overrides");
    ok(mismatched[0].note.includes("forbidden-commands"), mismatched[0].note);
  });

  test("with only one agent installed, parity reports which agent is missing and cannot be assessed", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    // No --agent flag: auto-detection only finds claude's home, since
    // codex's was never created.
    const report = doctorReport(home);
    eq(report.agents.length, 1);
    eq(report.agents[0].agent, "claude");
    deepEq(report.parity, { comparable: false, missing: "codex" });

    const textResult = runCli(home, ["doctor"]);
    ok(textResult.stdout.includes("parity: cannot be assessed"), textResult.stdout);
    ok(textResult.stdout.includes("codex"), textResult.stdout);
  });

  test("doctorExitCode is unaffected by a parity mismatch, in both directions", () => {
    const home = fakeHome();
    seedEmptyCodexConfig(home);
    eq(runCli(home, ["install", "--agent", "all", "--yes"]).code, 0);

    // A fresh install has certainly never been through Codex's one-time
    // hook-trust review, so doctorExitCode (core/installer/doctor.js) reports
    // exit 1 for that reason alone, on both sides of this test — assert every
    // other input to hasRealProblem individually, rather than only the exit
    // code number, so this still fails if the exit code ever turns non-zero
    // for a DIFFERENT reason. The point being tested stays intact: the exit
    // code — and its one real cause — must not move when parity flips from
    // match to mismatch.
    const assertOnlyHookTrustIsWrong = (report) => {
      for (const a of report.agents) {
        eq(a.missing.length, 0, `${a.agent}: ${JSON.stringify(a.missing)}`);
        eq(a.settingsParseOk, true, a.agent);
        ok(a.configTomlReadable !== false, a.agent);
        eq(a.overridesSchemaErrors.length, 0, a.agent);
        eq(a.overrides.filter((o) => o.state === "invalid").length, 0, a.agent);
        eq(a.unspawnableCodexHooks.length, 0, a.agent);
      }
      eq(report.invalidProjects.length, 0);
      const codexAgent = report.agents.find((a) => a.agent === "codex");
      ok(
        codexAgent.codexHookTrust.applicable && codexAgent.codexHookTrust.unapproved.length > 0,
        `expected the exit code's only cause to be unapproved Codex hooks, got: ${JSON.stringify(codexAgent.codexHookTrust)}`,
      );
    };

    const matchedReport = doctorReport(home, ["--agent", "all"]);
    eq(matchedReport.parity.verdict, "match");
    assertOnlyHookTrustIsWrong(matchedReport);
    eq(doctor.doctorExitCode(matchedReport), 1);

    eq(runCli(home, ["module", "enable", "session-cleanup", "--agent", "claude", "--yes"]).code, 0);
    const mismatchedReport = doctorReport(home, ["--agent", "all"]);
    eq(mismatchedReport.parity.verdict, "mismatch");
    assertOnlyHookTrustIsWrong(mismatchedReport);
    eq(
      doctor.doctorExitCode(mismatchedReport),
      doctor.doctorExitCode(matchedReport),
      "a parity mismatch alone must never flip doctor's exit code",
    );

    const cliResult = runCli(home, ["doctor", "--agent", "all"]);
    eq(cliResult.code, 1, "the real CLI invocation must agree: doctor's own exit code ignores parity, but still reflects the hook-trust cause");
  });
});
