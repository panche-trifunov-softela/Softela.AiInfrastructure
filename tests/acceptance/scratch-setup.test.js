"use strict";

/**
 * Proves `tools/acceptance/run.js --live`'s own scratch setup — the scratch
 * agent home, the real `softela-ai install`, and the scratch git repository —
 * actually works, entirely on its own and WITHOUT ever launching an agent
 * binary, per this project's own task instructions. This is the suite that
 * makes the `--live` code path trustworthy without costing anything or
 * needing a real, authenticated agent.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { suite } = require("../harness");
const { buildScratchHome, installInto, readInstalledModules, CLI_PATH } = require("../../tools/acceptance/scratch-home");
const { buildFixtureRepo } = require("../../tools/acceptance/fixture-repo");
const { getScenario } = require("../../tools/acceptance/scenarios");

suite("acceptance/scratch-setup", ({ test, eq, deepEq, ok, tmpdir }) => {
  test("bin/softela-ai exists at the path scratch-home.js drives", () => {
    ok(fs.existsSync(CLI_PATH), `expected the real CLI at ${CLI_PATH}`);
  });

  test("buildScratchHome creates an empty, disposable directory", () => {
    const home = buildScratchHome(tmpdir());
    ok(fs.existsSync(home), "the scratch home directory must exist");
    eq(fs.readdirSync(home).length, 0, "a freshly built scratch home must start empty");
  });

  test("installInto(home, 'claude') runs the real CLI and actually installs — manifest, settings hooks, dispatcher script all land", () => {
    const home = buildScratchHome(tmpdir());
    const result = installInto(home, "claude");
    eq(result.code, 0, `install should exit 0; stderr: ${result.stderr}`);

    const agentDir = path.join(home, ".claude");
    ok(fs.existsSync(path.join(agentDir, ".softela-ai", "manifest.json")), "manifest.json should be written");
    ok(fs.existsSync(path.join(agentDir, "softela-ai", "adapters", "claude", "dispatch.js")), "the real dispatcher should be installed");

    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    ok(settings.hooks && Array.isArray(settings.hooks.PreToolUse) && settings.hooks.PreToolUse.length > 0, "a PreToolUse hook should be registered");
  });

  test("installInto(home, 'codex') runs the real CLI and actually installs — manifest and hooks.json both land", () => {
    const home = buildScratchHome(tmpdir());
    const result = installInto(home, "codex");
    eq(result.code, 0, `install should exit 0; stderr: ${result.stderr}`);

    const agentDir = path.join(home, ".codex");
    ok(fs.existsSync(path.join(agentDir, ".softela-ai", "manifest.json")), "manifest.json should be written");

    const hooks = JSON.parse(fs.readFileSync(path.join(agentDir, "hooks.json"), "utf8"));
    ok(hooks.hooks && Array.isArray(hooks.hooks.PreToolUse) && hooks.hooks.PreToolUse.length > 0, "a PreToolUse hook should be registered");
  });

  test("H3: readInstalledModules reads the REAL module set a default install just wrote into the scratch home, not a scenario's own hand-maintained duplicate", () => {
    // `run.js --live` used to score against `cross-repo-delegation.js`'s own
    // hardcoded `modules` array instead of reading what `softela-ai install`
    // actually enabled — a hand-maintained duplicate of truth this asserts
    // stays truthful: it drives the SAME real CLI `--live` itself drives,
    // then reads the SAME state file `--live` now reads, and checks the
    // result actually matches what the scenario's own doc comment claims a
    // default install enables. A future default-module change breaks THIS
    // test, not `--live` silently drifting from reality.
    const home = buildScratchHome(tmpdir());
    const result = installInto(home, "claude");
    eq(result.code, 0, `install should exit 0; stderr: ${result.stderr}`);

    const modules = readInstalledModules(home, "claude");
    ok(Array.isArray(modules) && modules.length > 0, "a default install must enable at least one module");

    const scenario = getScenario("cross-repo-delegation");
    eq(
      modules.slice().sort().join(","),
      scenario.modules.slice().sort().join(","),
      "a real default install's own module set must match this scenario's own doc-commented claim about what a default install enables",
    );
  });

  test("H3: readInstalledModules answers per scratch home, never leaking the real developer machine's own module set", () => {
    const home = buildScratchHome(tmpdir());
    // No install run at all — a scratch home with no `.softela-ai/state.json` on
    // disk must read as "nothing enabled", never fall through to the real
    // developer home's own state (the exact hazard reading state through the
    // env-var-driven `core/installer/state.js#readState` inside this SAME
    // process would risk, since that resolves against `SOFTELA_AI_HOME` at call
    // time, not against whichever scratch home the caller means).
    deepEq(readInstalledModules(home, "claude"), []);
  });

  test("installInto never touches the real developer home — a scratch install leaves no trace outside its own directory", () => {
    const home = buildScratchHome(tmpdir());
    const before = fs.existsSync(path.join(require("os").homedir(), ".claude", ".softela-ai", "manifest.json"))
      ? fs.readFileSync(path.join(require("os").homedir(), ".claude", ".softela-ai", "manifest.json"), "utf8")
      : null;
    installInto(home, "claude");
    const after = fs.existsSync(path.join(require("os").homedir(), ".claude", ".softela-ai", "manifest.json"))
      ? fs.readFileSync(path.join(require("os").homedir(), ".claude", ".softela-ai", "manifest.json"), "utf8")
      : null;
    eq(before, after, "the real home's own manifest must be byte-identical before and after a scratch install");
  });

  test("buildFixtureRepo builds a real git repository whose remote resolves to the scenario's own project", () => {
    const scenario = getScenario("cross-repo-delegation");
    const { repo, parent } = buildFixtureRepo(tmpdir, scenario.repo);
    ok(fs.existsSync(path.join(repo, ".git")), "a real .git directory must exist");
    eq(path.dirname(repo), parent);

    const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: repo, encoding: "utf8" }).trim();
    eq(remote, scenario.repo.remote);

    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    eq(branch, scenario.repo.featureBranch);

    for (const rel of Object.keys(scenario.repo.seedFiles)) {
      ok(fs.existsSync(path.join(repo, ...rel.split("/"))), `seed file ${rel} should exist`);
    }
  });

  test("buildFixtureRepo's repo root is git's own resolved path, never a short-name spelling of tmpdir's own result", () => {
    // The exact regression `tests/acceptance/enforcement.test.js#buildFixture`'s
    // own doc comment documents: fs.mkdtempSync can hand back an 8.3 short
    // name while git reports the long form. Every project-scoped rule
    // compares ctx.filePath against ctx.git.repoRoot as literal string
    // prefixes, so the two spellings must agree here too.
    const scenario = getScenario("trivial-read");
    const { repo } = buildFixtureRepo(tmpdir, scenario.repo);
    const gitReported = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).trim().split("/").join(path.sep);
    eq(repo, gitReported);
  });
});
