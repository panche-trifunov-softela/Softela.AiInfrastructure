"use strict";

/**
 * A fresh machine has never launched Codex, so `config.toml` does not exist
 * yet. `plan.js#planModuleSettings` used to treat "does not exist" and
 * "exists but could not be read" as the same thing — both collapsed onto
 * `readText`'s `null` — and skipped seeding either way, so `install` reported
 * success while writing none of `agent-orchestration`'s seven Codex seed
 * settings. This suite exercises the real CLI end to end against a scratch
 * home to prove the fix: an absent `config.toml` is now created and seeded;
 * an existing-but-unreadable one is still left alone.
 */

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");
const { runCli, agentHomePath, readText } = require("./_home");
const { ensureDir, writeTextAtomic } = require("../../core/lib/fs-safe");
const { FALLBACK_MODEL_IDS } = require("../../core/lib/codex-models");

/** A path that cannot resolve to a real binary, forcing `resolveModelForTier` to its deterministic fallback step, the same way `model-tiers.test.js` does for the in-process unit tests. */
const NO_SUCH_CODEX_BIN = path.join("fake-home", "does-not-exist", "codex.exe");

/** Every pointer `agent-orchestration`'s `module.json` seeds into Codex's `config.toml`. */
const SEEDED_POINTERS = [
  "/model",
  "/model_reasoning_effort",
  "/default_subagent_reasoning_effort",
  "/approval_policy",
  "/approvals_reviewer",
  "/features/multi_agent_v2",
  "/multi_agent_v2/expose_spawn_agent_model_overrides",
];

/**
 * Resolves the absolute path Codex's `config.toml` lives at under a fake
 * home, the same way `detect.js#gather` resolves it.
 *
 * @param {string} home The fake home root.
 * @returns {string} `<home>/.codex/config.toml`.
 */
function configTomlPath(home) {
  return path.join(agentHomePath(home, "codex"), "config.toml");
}

/**
 * Runs `install --agent codex --yes` with `CODEX_BIN` forced unresolvable,
 * so every tier-based seed settles on {@link FALLBACK_MODEL_IDS} rather than
 * whatever Codex binary happens to be on the machine running this suite.
 *
 * @param {string} home The fake home root.
 * @param {string[]} [extraArgs] Extra CLI arguments appended after `--yes`.
 * @returns {{code: number, stdout: string, stderr: string}} The CLI result.
 */
function installCodex(home, extraArgs = []) {
  return runCli(home, ["install", "--agent", "codex", "--yes", ...extraArgs], { env: { CODEX_BIN: NO_SUCH_CODEX_BIN } });
}

/**
 * Finds the plan action for one `config.toml` seed pointer — `kind` is
 * `"settings"` when it is planned as a write or a keep, or `"skip"` when the
 * file cannot be read or parsed confidently; both carry `mode: "seed"` and
 * the same `pointer`/`target` shape.
 *
 * @param {object[]} actions A plan, as returned in `--json` output.
 * @param {string} pointer The seed pointer to find.
 * @returns {object | undefined} The matching action.
 */
function findSeedAction(actions, pointer) {
  return actions.find((a) => a.mode === "seed" && a.pointer === pointer && typeof a.target === "string" && a.target.endsWith("config.toml"));
}

suite("installer/codex-config-toml", ({ test, eq, ok, fakeHome }) => {
  test("an absent config.toml is created and seeded with all seven keys on install", () => {
    const home = fakeHome();
    eq(fs.existsSync(configTomlPath(home)), false, "the scratch home starts with no config.toml at all");

    const result = installCodex(home, ["--json"]);
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);
    const actions = JSON.parse(result.stdout).agents[0].actions;

    for (const pointer of SEEDED_POINTERS) {
      const a = findSeedAction(actions, pointer);
      ok(a, `expected a settings action for ${pointer}`);
      eq(a.state, "absent", `${pointer} must plan as a creation, not an edit of something that already exists`);
      eq(a.action, "write");
    }

    ok(fs.existsSync(configTomlPath(home)), "config.toml must exist after install");
    const content = readText(configTomlPath(home));
    ok(content.includes(`model = "${FALLBACK_MODEL_IDS.frontier}"`), content);
    ok(content.includes('default_subagent_reasoning_effort = "medium"'), content);
    ok(content.includes('model_reasoning_effort = "high"'), content);
    ok(content.includes('approval_policy = "on-request"'), content);
    ok(content.includes('approvals_reviewer = "auto_review"'), content);
    ok(content.includes("multi_agent_v2 = true"), content);
    ok(content.includes("expose_spawn_agent_model_overrides = true"), content);
  });

  test("a second install run does not rewrite or duplicate any seeded key, and keeps a hand-edited value", () => {
    const home = fakeHome();
    eq(installCodex(home).code, 0);

    // The developer changes one seeded value by hand before the next run.
    const before = readText(configTomlPath(home));
    const edited = before.replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "medium"');
    ok(edited !== before, "the fixture must actually change something");
    writeTextAtomic(configTomlPath(home), edited);

    const result = installCodex(home, ["--json"]);
    eq(result.code, 2, "nothing left to change on a second run against the same module selection");
    const actions = JSON.parse(result.stdout).agents[0].actions;
    for (const pointer of SEEDED_POINTERS) {
      const a = findSeedAction(actions, pointer);
      eq(a.action, "keep", `${pointer} must never be re-imposed once it exists`);
      eq(a.state, "current");
    }

    const after = readText(configTomlPath(home));
    eq(after, edited, "the developer's own hand-edited value, and everything else, must survive byte-for-byte");
    ok(after.includes('model_reasoning_effort = "medium"'));
    ok(!after.includes('model_reasoning_effort = "high"'));
  });

  test("an existing config.toml that already sets model_reasoning_effort keeps the developer's value", () => {
    const home = fakeHome();
    ensureDir(agentHomePath(home, "codex"));
    writeTextAtomic(configTomlPath(home), '# hand-maintained before softela-ai ever ran\nmodel_reasoning_effort = "low"\n');

    const result = installCodex(home, ["--json"]);
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);

    const content = readText(configTomlPath(home));
    ok(content.includes('model_reasoning_effort = "low"'), content);
    ok(!content.includes('model_reasoning_effort = "high"'), content);
    // Every other seed setting still gets written into the pre-existing file.
    ok(content.includes(`model = "${FALLBACK_MODEL_IDS.frontier}"`), content);
    ok(content.includes('approval_policy = "on-request"'), content);
  });

  test("a config.toml that exists but cannot be read is skipped, not overwritten, and the run reports it", () => {
    const home = fakeHome();
    ensureDir(agentHomePath(home, "codex"));
    // A directory at this path is unambiguously present (`fs.existsSync` is
    // true) and unambiguously unreadable as text (`readText` throws EISDIR
    // and returns `null`) — a deterministic, cross-platform way to reach the
    // `exists: true, content: null` state without touching permissions.
    fs.mkdirSync(configTomlPath(home));

    const result = installCodex(home, ["--json", "--verbose"]);
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);
    const actions = JSON.parse(result.stdout).agents[0].actions;

    for (const pointer of SEEDED_POINTERS) {
      const a = findSeedAction(actions, pointer);
      ok(a, `expected an action for ${pointer}`);
      eq(a.kind, "skip");
      eq(a.action, "none");
      ok(a.reason.includes("could not be read"), a.reason);
    }

    ok(fs.statSync(configTomlPath(home)).isDirectory(), "the unreadable config.toml must be left exactly as it was");
  });

  test("an unparseable config.toml is skipped end to end, not guessed at", () => {
    const home = fakeHome();
    ensureDir(agentHomePath(home, "codex"));
    const unparseable = 'notes = """\nmultiline\n"""\n';
    writeTextAtomic(configTomlPath(home), unparseable);

    const result = installCodex(home, ["--json"]);
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);
    const actions = JSON.parse(result.stdout).agents[0].actions;
    const a = findSeedAction(actions, "/model");
    eq(a.kind, "skip");
    ok(a.reason.includes("could not be parsed confidently"), a.reason);
    eq(readText(configTomlPath(home)), unparseable, "an unparseable file must survive byte-for-byte");
  });

  test("--dry-run creates no config.toml", () => {
    const home = fakeHome();
    const result = installCodex(home, ["--dry-run", "--verbose"]);
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);
    ok(result.stdout.includes("config.toml"), "the dry-run plan must still show the seed lines it would write");
    eq(fs.existsSync(configTomlPath(home)), false, "a dry run must never create the file it only plans to write");
  });

  test("--modules excluding agent-orchestration creates no config.toml", () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "--agent", "codex", "--yes", "--modules", "analyze-first"]);
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);
    eq(fs.existsSync(configTomlPath(home)), false, "no module in this run declares a Codex seed setting, so nothing may create the file");
  });

  test("doctor --agent codex --json reports the seeded model and effort instead of \"(not set)\"", () => {
    const home = fakeHome();
    eq(installCodex(home).code, 0);

    const doctorResult = runCli(home, ["doctor", "--agent", "codex", "--json"]);
    const fullReport = JSON.parse(doctorResult.stdout);
    const report = fullReport.agents[0];
    // A fresh install has certainly never been through Codex's one-time
    // hook-trust review, so `doctorExitCode` (core/installer/doctor.js)
    // reports exit 1 for that reason alone — assert every other input to
    // `doctorExitCode`'s `hasRealProblem` check individually, rather than
    // only the exit code number, so this still fails if the exit code ever
    // turns non-zero for a DIFFERENT reason.
    eq(doctorResult.code, 1, `doctor stdout:\n${doctorResult.stdout}\n${doctorResult.stderr}`);
    ok(
      report.codexHookTrust.applicable && report.codexHookTrust.unapproved.length > 0,
      `expected the exit code's only cause to be unapproved Codex hooks, got: ${JSON.stringify(report.codexHookTrust)}`,
    );
    eq(report.missing.length, 0);
    eq(report.settingsParseOk, true);
    eq(report.configTomlReadable, true);
    eq(report.overridesSchemaErrors.length, 0);
    eq(report.overrides.filter((o) => o.state === "invalid").length, 0);
    eq(report.unspawnableCodexHooks.length, 0);
    eq(fullReport.invalidProjects.length, 0);

    eq(report.effectiveModel, FALLBACK_MODEL_IDS.frontier);
    eq(report.effectiveReasoningEffort, "high");
  });
});
