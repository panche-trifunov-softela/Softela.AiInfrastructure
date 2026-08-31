"use strict";

/**
 * `softela-ai override` (INSTALLER.md's override CLI section): sets a local
 * softening override for one rule, backed up first, with a required reason
 * and a required refusal for anything the engine's clamp would silently
 * undo — plus `--list` and `--undo`.
 */

const path = require("path");
const { suite } = require("../harness");
const { runCli, agentHomePath, listBackupDirs, readText, readJson } = require("./_home");
const { resolveOverrides } = require("../../core/lib/override-resolver");
const engine = require("../../core/engine");
const forbiddenCommands = require("../../core/guards/forbidden-commands");
const infraSelfProtection = require("../../core/guards/infra-self-protection");

/** A minimal project config that gives `forbidden-commands` something to fire on. */
const PROJECT_WITH_FORBIDDEN_COMMAND = {
  id: "SomeProject",
  commands: { forbidden: [{ pattern: "kubectl", action: "deny", reason: "no direct cluster access from here" }] },
};

/**
 * Builds a `PreToolUse` shell-command context, as `forbidden-commands`
 * expects it.
 *
 * @param {object} overrides The resolved overrides lookup to attach.
 * @returns {object} The evaluation context.
 */
function shellCtx(overrides) {
  return {
    agent: "claude",
    event: "PreToolUse",
    toolName: "Bash",
    command: "kubectl get pods",
    project: PROJECT_WITH_FORBIDDEN_COMMAND,
    overrides,
  };
}

/**
 * Resolves the path to an agent's local overrides file under a fake home.
 *
 * @param {string} home The fake home root.
 * @param {"claude" | "codex"} agent The agent.
 * @returns {string} `<agentHome>/.softela-ai/overrides.json`.
 */
function overridesFile(home, agent) {
  return path.join(agentHomePath(home, agent), ".softela-ai", "overrides.json");
}

suite("installer/override", ({ test, eq, ok, deepEq, fakeHome }) => {
  test("setting an override is honoured by the engine", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    // forbidden-commands defaults to "deny"; without an override it fires.
    const overridesBefore = resolveOverrides("claude", "SomeProject", { file: overridesFile(home, "claude") });
    const bare = engine.evaluate(shellCtx(overridesBefore), { rules: [forbiddenCommands] });
    ok(bare && bare.action === "deny", "the rule must fire before any override exists");

    const result = runCli(home, ["override", "forbidden-commands", "off", "--reason", "flaky on this machine", "--agent", "claude", "--yes"]);
    eq(result.code, 0, result.stdout + result.stderr);

    const overridesAfter = resolveOverrides("claude", "SomeProject", { file: overridesFile(home, "claude") });
    const softened = engine.evaluate(shellCtx(overridesAfter), { rules: [forbiddenCommands] });
    eq(softened, null, 'an "off" override must silence the rule entirely');
  });

  test("a missing --reason is refused, and nothing is written", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    const result = runCli(home, ["override", "colocated-tests", "off", "--agent", "claude", "--yes"]);
    eq(result.code, 1);
    ok(/--reason is required/.test(result.stdout), result.stdout);
    eq(readText(overridesFile(home, "claude")), null, "a refused request must not create the file");
  });

  test("an escalation above the rule's own default action is refused, not clamped later", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    // file-size-limit defaults to "ask" — a threshold with legitimate
    // exceptions is never raised past that. "deny" would be clamped straight
    // back down by the engine, so the command must refuse it up front.
    const result = runCli(home, ["override", "file-size-limit", "deny", "--reason", "team wants it stricter", "--agent", "claude", "--yes"]);
    eq(result.code, 1);
    ok(/more severe than/.test(result.stdout), result.stdout);
    eq(readText(overridesFile(home, "claude")), null);
  });

  test("an override on a mandatory rule is refused, since the engine never consults it", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);
    ok(infraSelfProtection.mandatory, "fixture assumption: infra-self-protection is mandatory");

    const result = runCli(home, ["override", "infra-self-protection", "off", "--reason", "testing", "--agent", "claude", "--yes"]);
    eq(result.code, 1);
    ok(/mandatory/.test(result.stdout), result.stdout);
  });

  test("the write backs up the previous content, byte for byte", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);
    eq(runCli(home, ["override", "colocated-tests", "off", "--reason", "first", "--agent", "claude", "--yes"]).code, 0);
    const beforeSecond = readText(overridesFile(home, "claude"));

    eq(runCli(home, ["override", "colocated-tests", "ask", "--reason", "changed my mind", "--agent", "claude", "--yes"]).code, 0);

    const dirs = listBackupDirs(home, "claude");
    ok(dirs.length >= 1, "at least one backup generation must exist");
    const latest = dirs.sort().pop();
    eq(readText(path.join(latest, ".softela-ai", "overrides.json")), beforeSecond, "the backup must hold exactly what was on disk before the second write");
  });

  test("a first-ever write has nothing to back up, and does not crash", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);
    const result = runCli(home, ["override", "colocated-tests", "off", "--reason", "first ever", "--agent", "claude", "--yes"]);
    eq(result.code, 0, result.stdout + result.stderr);
    ok(!/backup:/.test(result.stdout), "nothing existed before, so nothing should be reported as backed up");
  });

  test("--undo restores the most recent backup and reports what changed", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);
    eq(runCli(home, ["override", "colocated-tests", "off", "--reason", "first", "--agent", "claude", "--yes"]).code, 0);
    const afterFirst = readText(overridesFile(home, "claude"));
    eq(runCli(home, ["override", "colocated-tests", "ask", "--reason", "changed my mind", "--agent", "claude", "--yes"]).code, 0);

    const undoResult = runCli(home, ["override", "--undo", "--agent", "claude", "--yes"]);
    eq(undoResult.code, 0, undoResult.stdout + undoResult.stderr);
    ok(/restored from backup/.test(undoResult.stdout), undoResult.stdout);
    ok(/colocated-tests/.test(undoResult.stdout), "the undo report must say what changed");
    eq(readText(overridesFile(home, "claude")), afterFirst, "undo must restore the exact prior bytes");
  });

  test("--undo with no backup is handled cleanly, not as a crash", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    const result = runCli(home, ["override", "--undo", "--agent", "claude", "--yes"]);
    eq(result.code, 1);
    ok(/no backup/.test(result.stdout), result.stdout);
  });

  test("--list shows the action, reason and scope for every active override", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);
    eq(runCli(home, ["override", "colocated-tests", "off", "--reason", "global reason here", "--agent", "claude", "--yes"]).code, 0);

    const listed = runCli(home, ["override", "--list", "--agent", "claude"]);
    eq(listed.code, 0);
    ok(listed.stdout.includes("colocated-tests"));
    ok(listed.stdout.includes("global reason here"));
    ok(listed.stdout.includes("action=off"));

    const listedJson = JSON.parse(runCli(home, ["override", "--list", "--agent", "claude", "--json"]).stdout);
    const entry = listedJson.agents[0].overrides.find((o) => o.ruleId === "colocated-tests");
    ok(entry, "the override must appear in --json output too");
    eq(entry.scope, "global");
    eq(entry.reason, "global reason here");
    ok(typeof entry.setAt === "string" && entry.setAt.length > 0, "each entry must carry when it was set");
  });

  test("a project-scoped override is distinct from a global one, and both list separately", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);
    eq(runCli(home, ["override", "colocated-tests", "off", "--reason", "global", "--agent", "claude", "--yes"]).code, 0);
    eq(runCli(home, ["override", "colocated-tests", "ask", "--reason", "project only", "--project", "MyProject", "--agent", "claude", "--yes"]).code, 0);

    const raw = readJson(overridesFile(home, "claude"));
    eq(raw.rules["colocated-tests"].action, "off");
    eq(raw.projects.MyProject.rules["colocated-tests"].action, "ask");

    const listedJson = JSON.parse(runCli(home, ["override", "--list", "--agent", "claude", "--json"]).stdout);
    const scopes = listedJson.agents[0].overrides.map((o) => o.scope).sort();
    deepEq(scopes, ["global", "project:MyProject"]);

    // The project scope only applies to its own project id.
    const forOtherProject = resolveOverrides("claude", "OtherProject", { file: overridesFile(home, "claude") });
    eq(forOtherProject.forRule("colocated-tests").action, "off", "an unrelated project must still see only the global override");
  });

  test("a malformed existing overrides.json is neither crashed on nor silently discarded", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);
    const file = overridesFile(home, "claude");
    require("../../core/lib/fs-safe").writeTextAtomic(file, "{ this is not valid json");

    const result = runCli(home, ["override", "colocated-tests", "off", "--reason", "recovering from corruption", "--agent", "claude", "--yes"]);
    eq(result.code, 0, result.stdout + result.stderr);
    ok(/not valid JSON/.test(result.stdout), "the command must say the previous file was unusable");

    const after = readJson(file);
    ok(after && after.rules && after.rules["colocated-tests"], "the new override must still be written despite the corruption");

    const dirs = listBackupDirs(home, "claude");
    const latest = dirs.sort().pop();
    eq(readText(path.join(latest, ".softela-ai", "overrides.json")), "{ this is not valid json", "the corrupted bytes must be preserved in the backup, not lost");
  });
});
