"use strict";

/**
 * `softela-ai doctor` (INSTALLER.md §8): drift after a local edit, active
 * overrides with their reason, a real problem (missing file, unparseable
 * settings) driving a non-zero exit, the Codex hook-trust caveat stated
 * plainly rather than asserted either way, a registered Codex hook command
 * whose executable token can never spawn (judged exactly the way Codex
 * itself does), a registered Codex hook carrying no `[hooks.state]` trust
 * entry at all, the informational parity row stating Codex's `askMode`, and
 * — for `formatDoctorReport` itself — that the rendered report fits every
 * probed terminal width and carries no trailing whitespace on any line.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");
const { suite } = require("../harness");
const { runCli, seedForeign, agentHomePath, installedRootPath, CLI_PATH } = require("./_home");
const { writeTextAtomic, writeJsonAtomic, readJson } = require("../../core/lib/fs-safe");
const doctor = require("../../core/installer/doctor");
const paths = require("../../core/lib/paths");
const tty = require("../../core/installer/tty");

/**
 * Runs the CLI under test at a given working directory — {@link runCli}'s
 * own always fixes `cwd` at this repository's own root, which is exactly
 * wrong for the one scenario below that needs `memory-as-context`'s own
 * `"repo"` location to resolve inside a *disposable* git repository, never
 * this real, live repository's own working tree.
 *
 * @param {string} cwd The working directory to run the CLI from.
 * @param {string} home The fake home root (`SOFTELA_AI_HOME`).
 * @param {string[]} args The CLI arguments.
 * @returns {{code: number, stdout: string, stderr: string}} The process's exit code and captured output.
 */
function runCliAt(cwd, home, args) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, SOFTELA_AI_HOME: home },
    encoding: "utf8",
    timeout: 30000,
  });
  return { code: result.status === null ? -1 : result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

/**
 * Runs the real, just-installed `inject-memory.js` `SessionStart` hook as a
 * subprocess — exactly what a host does on session start — so a doctor test
 * below can verify against an actually-seeded memory directory rather than
 * one this test file poked into shape by hand.
 *
 * @param {string} home The fake home root.
 * @param {"claude" | "codex"} agent The agent.
 * @param {string} [location] The `--location=` value; `"global"` by default.
 * @param {Record<string, string>} [extraEnv] Extra environment variables to
 * merge over the inherited `process.env` — e.g. `seed-memory.js`'s own
 * `CATALOG_DIR_OVERRIDE_ENV`, to point a run at a fixture seed catalogue
 * instead of this module's real, shipped one.
 * @returns {{code: number, stdout: string, stderr: string}} The hook's exit code and output.
 */
function runInstalledInjectMemory(home, agent, location = "global", extraEnv = {}) {
  const script = path.join(installedRootPath(home, agent), "hooks", "inject-memory.js");
  const result = spawnSync(process.execPath, [script, `--agent-home=${agentHomePath(home, agent)}`, `--location=${location}`], {
    input: "{}",
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, ...extraEnv },
  });
  return { code: result.status === null ? -1 : result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

/** This repository's own `project.schema.json`, read once for every test below that validates against it directly (not through a fake `SOFTELA_AI_HOME`). */
const PROJECT_SCHEMA = readJson(path.join(paths.repoRoot(), "core", "schema", "project.schema.json"));

/**
 * Widths every width-invariant scenario below drives `doctor` at: both ends
 * of `tty.js`'s own clamp range, its `FALLBACK_WIDTH`, and two points above
 * it — wide enough to also exercise `doctor.js#formatParitySection`'s own
 * table/stacked-block switch on both sides of its threshold, not only its
 * narrowest, always-stacked case.
 */
const PROBE_WIDTHS = [40, 60, 80, 100, 120];

/**
 * Writes a `[hooks.state.'<key>']` trust entry into a fake Codex home's
 * `config.toml` for every hook currently registered in its `hooks.json` —
 * simulating a developer who has completed Codex's one-time hook-trust
 * review for the whole installation, so a test can isolate an assertion
 * from `doctor.js#listUnapprovedCodexHooks`'s own real-problem contribution
 * to the exit code.
 *
 * Uses `doctor.js`'s own exported {@link listRegisteredCodexHooks} and
 * {@link codexHookTrustSectionPath} to compute the exact key doctor itself
 * would look for, rather than reimplementing that shape by hand.
 *
 * @param {string} home The fake home root.
 * @returns {void}
 */
function approveAllCodexHooks(home) {
  const hooksJsonPath = path.join(agentHomePath(home, "codex"), "hooks.json");
  const registered = doctor.listRegisteredCodexHooks(readJson(hooksJsonPath));
  const configPath = path.join(agentHomePath(home, "codex"), "config.toml");
  let content = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  for (const hook of registered) {
    content += `\n[${doctor.codexHookTrustSectionPath(hooksJsonPath, hook)}]\ntrusted_hash = "sha256:test-fixture"\n`;
  }
  fs.writeFileSync(configPath, content, "utf8");
}

/**
 * Rewrites every registered Codex hook's `command` to a trivially spawnable
 * form — a bare `node` executable token, carrying no path separator, so
 * `doctor.js#judgeCodexHookExecutable` never needs a filesystem check to
 * call it healthy — isolating a test from the shipped dispatcher command's
 * own executable-token shape, which is platform-dependent
 * (`core/lib/short-path.js` quotes unconditionally on any non-Windows
 * platform) and must not leak into an assertion about something else.
 *
 * @param {string} home The fake home root.
 * @returns {void}
 */
function neutralizeCodexHookSpawnability(home) {
  const hooksJsonPath = path.join(agentHomePath(home, "codex"), "hooks.json");
  const hooksJson = readJson(hooksJsonPath);
  for (const groups of Object.values((hooksJson && hooksJson.hooks) || {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const hook of (group && Array.isArray(group.hooks) && group.hooks) || []) {
        if (hook && typeof hook.command === "string") hook.command = "node --version";
      }
    }
  }
  writeJsonAtomic(hooksJsonPath, hooksJson);
}

/**
 * Asserts every non-empty line a `doctor` invocation printed (stdout and
 * stderr together) fits within `width` display columns, and carries no
 * trailing whitespace.
 *
 * Measured in Unicode code points via `tty.displayWidth`
 * (`Array.from(line).length` under the hood), never in UTF-8 bytes — this
 * output's em dashes and ellipses are multi-byte in UTF-8, so a byte-length
 * check would report a false failure on a line that actually fits.
 *
 * @param {(a: *, b: *, c?: *) => void} ok The harness's own assertion.
 * @param {{stdout: string, stderr: string}} result A `runCli` result.
 * @param {number} width The width this run was driven at.
 * @returns {void}
 */
function assertDoctorFitsWidth(ok, result, width) {
  const lines = `${result.stdout}${result.stderr}`.split("\n");
  for (const line of lines) {
    if (!line) continue;
    ok(line === line.trimEnd(), `line ends in whitespace at width ${width}: ${JSON.stringify(line)}`);
    // A real, copy-pasteable filesystem path — deliberately never wrapped;
    // see `doctor.js#formatDoctorReport`'s own comment on this exact line.
    if (line.startsWith("  run via:")) continue;
    ok(
      tty.displayWidth(line) <= width,
      `line exceeds width ${width} (${tty.displayWidth(line)} columns): ${JSON.stringify(line)}\nfull output:\n${result.stdout}${result.stderr}`,
    );
  }
}

suite("installer/doctor", ({ test, eq, ok, deepEq, notThrows, fakeHome, tmpdir }) => {
  test("a freshly installed agent reports no drift", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    const result = runCli(home, ["doctor", "--agent", "claude", "--json"]);
    eq(result.code, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    eq(report.agents[0].installed, true);
    eq(report.agents[0].drift.length, 0);
  });

  test("an edited shipped file is reported as drift, and drives a non-zero exit once it goes missing", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    const manifestPath = path.join(agentHomePath(home, "claude"), ".softela-ai", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const relPath = Object.keys(manifest.files).find((p) => p.endsWith("core/lib/decision.js"));
    const abs = path.join(agentHomePath(home, "claude"), relPath.split("/").join(path.sep));

    fs.appendFileSync(abs, "\n// edited\n", "utf8");
    const afterEdit = JSON.parse(runCli(home, ["doctor", "--agent", "claude", "--json"]).stdout);
    const driftEntry = afterEdit.agents[0].drift.find((d) => d.relPath === relPath);
    ok(driftEntry, "an edited shipped file must show up as drift");
    eq(driftEntry.issue, "locally modified");

    fs.rmSync(abs);
    const afterDelete = runCli(home, ["doctor", "--agent", "claude", "--json"]);
    const afterDeleteReport = JSON.parse(afterDelete.stdout);
    const missingEntry = afterDeleteReport.agents[0].drift.find((d) => d.relPath === relPath);
    eq(missingEntry.issue, "missing");
    eq(afterDelete.code, 1, "a missing installed file is a real problem doctor must fail on");
  });

  test("a corrupt or truncated manifest.json still reports the installer's own previously-written files as installed, not as untracked", () => {
    const manifestPath = (home) => path.join(agentHomePath(home, "claude"), ".softela-ai", "manifest.json");

    for (const corrupt of ["{ not actually json", ""]) {
      const home = fakeHome();
      seedForeign(home, "claude");
      eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

      const before = JSON.parse(fs.readFileSync(manifestPath(home), "utf8"));
      const trackedCount = Object.keys(before.files).length;
      ok(trackedCount > 0, "expected the fresh install to have tracked at least one file");

      fs.writeFileSync(manifestPath(home), corrupt, "utf8");

      const result = runCli(home, ["doctor", "--agent", "claude", "--json"]);
      const report = JSON.parse(result.stdout);
      const agentReport = report.agents[0];
      ok(
        agentReport.installed,
        `expected installed:true once every tracked file's content is recognised as recovered, got: ${JSON.stringify(agentReport)} (manifest content: ${JSON.stringify(corrupt)})`,
      );
      const untracked = agentReport.drift.filter((d) => d.issue === "present but not tracked by the manifest");
      eq(
        untracked.length,
        0,
        `expected no file to still read as untracked once its content matches exactly what was shipped, got: ${JSON.stringify(untracked)}`,
      );
      eq(result.code, 0, `a fully recovered installation must not be reported as a real problem: ${result.stdout}${result.stderr}`);
    }
  });

  test("a genuine developer file is still reported as untracked even while a corrupt manifest is otherwise fully recovered", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    const claudeHome = agentHomePath(home, "claude");
    const manifestPath = path.join(claudeHome, ".softela-ai", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const relPath = Object.keys(manifest.files).find((p) => p.endsWith("core/lib/decision.js"));
    const abs = path.join(claudeHome, relPath.split("/").join(path.sep));

    // The developer edited this one shipped file after install, then the
    // manifest was separately corrupted — its content now matches neither
    // "what was shipped" nor any manifest record, since the manifest itself
    // is gone. This must never be silently adopted as the installer's own.
    fs.appendFileSync(abs, "\n// developer's own edit, made after install\n", "utf8");
    fs.writeFileSync(manifestPath, "{ not actually json", "utf8");

    const report = JSON.parse(runCli(home, ["doctor", "--agent", "claude", "--json"]).stdout).agents[0];
    ok(report.installed, "the rest of the installation must still recover and read as installed");
    const flagged = report.drift.find((d) => d.relPath === relPath);
    ok(flagged, "the genuinely edited file must still be reported, not silently absorbed");
    eq(flagged.issue, "present but not tracked by the manifest");
  });

  test("update recovers a single manifest entry lost to a write-then-checkpoint race, without leaving a permanent byte-identical .new sibling", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    const claudeHome = agentHomePath(home, "claude");
    const manifestPath = path.join(claudeHome, ".softela-ai", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const relPath = Object.keys(manifest.files).find((p) => p.endsWith("core/lib/decision.js"));
    const abs = path.join(claudeHome, relPath.split("/").join(path.sep));
    const contentBefore = fs.readFileSync(abs, "utf8");

    // Simulates the write-then-checkpoint race: the file itself was written
    // fine, but its manifest entry never made it to disk.
    delete manifest.files[relPath];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

    const result = runCli(home, ["update", "--agent", "claude", "--yes"]);
    eq(result.code, 0, result.stdout + result.stderr);
    ok(!fs.existsSync(`${abs}.new`), `expected no .new sibling for a file whose content already matched what this version ships; stdout:\n${result.stdout}`);
    eq(fs.readFileSync(abs, "utf8"), contentBefore, "the recovered file's content must be unchanged");

    const after = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    ok(relPath in after.files, "the recovered file must be tracked again after update");
  });

  test("an untouched file whose manifest entry carries the wrong hash is recovered, not reported as locally modified forever", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    const claudeHome = agentHomePath(home, "claude");
    const manifestPath = path.join(claudeHome, ".softela-ai", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const relPath = Object.keys(manifest.files).find((p) => p.endsWith("core/lib/decision.js"));
    const abs = path.join(claudeHome, relPath.split("/").join(path.sep));
    const contentBefore = fs.readFileSync(abs, "utf8");

    // The file's own bytes are untouched — only the manifest's recorded hash
    // for it is wrong, as a hand-edit or a torn write could leave it. This is
    // deliberately a different value than the file's real hash, but still a
    // well-formed one, so `readManifest` itself stays perfectly happy; only
    // the recorded value disagrees with reality.
    manifest.files[relPath] = "0000000000000000000000000000000000000000000000000000000000000000";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

    const doctorResult = runCli(home, ["doctor", "--agent", "claude", "--json"]);
    eq(doctorResult.code, 0, doctorResult.stdout + doctorResult.stderr);
    const report = JSON.parse(doctorResult.stdout).agents[0];
    const flagged = report.drift.find((d) => d.relPath === relPath);
    eq(flagged, undefined, `expected no drift for a file whose content matches exactly what this version ships, got: ${JSON.stringify(flagged)}`);

    // The wrong hash must also never survive an update as a permanent
    // byte-identical `.new` sibling — the whole point of recovering by
    // content is that a healthy file is never treated as the developer's own.
    const updateResult = runCli(home, ["update", "--agent", "claude", "--yes"]);
    eq(updateResult.code, 0, updateResult.stdout + updateResult.stderr);
    ok(!fs.existsSync(`${abs}.new`), `expected no .new sibling for a file whose content already matched what this version ships; stdout:\n${updateResult.stdout}`);
    eq(fs.readFileSync(abs, "utf8"), contentBefore, "the recovered file's content must be unchanged");

    const after = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    eq(after.files[relPath], require("../../core/lib/fs-safe").sha256(contentBefore), "the manifest's wrong hash must be corrected, not left disagreeing with reality forever");
  });

  test("a manifest entry naming a path that was never shipped and is not on disk is reported as absent, not as locally modified", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    const claudeHome = agentHomePath(home, "claude");
    const manifestPath = path.join(claudeHome, ".softela-ai", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    // Neither ever shipped by this version nor present on disk — e.g. a
    // manifest entry left behind by a module that was removed from the
    // repository, on a machine where the file was already deleted by hand.
    const ghostRelPath = "softela-ai/core/guards/a-rule-that-was-never-shipped.js";
    manifest.files[ghostRelPath] = "1111111111111111111111111111111111111111111111111111111111111111";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

    const result = runCli(home, ["doctor", "--agent", "claude", "--json"]);
    eq(result.code, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout).agents[0];
    const flagged = report.drift.find((d) => d.relPath === ghostRelPath);
    eq(flagged, undefined, `expected a never-shipped, never-installed path to be reported as absent, not as drift, got: ${JSON.stringify(flagged)}`);
  });

  test("an active override is listed with its reason", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    writeJsonAtomic(path.join(agentHomePath(home, "claude"), ".softela-ai", "overrides.json"), {
      rules: { "forbidden-commands": { allow: ["\\bkubectl\\b"], reason: "DevOps tooling on this machine" } },
    });

    const report = JSON.parse(runCli(home, ["doctor", "--agent", "claude", "--json"]).stdout);
    const override = report.agents[0].overrides.find((o) => o.ruleId === "forbidden-commands");
    ok(override, "the override must be listed");
    eq(override.reason, "DevOps tooling on this machine");
    eq(override.state, "effective");
  });

  test("an override on an unknown rule id is reported as invalid, not as a working override, and drives a non-zero exit", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    writeJsonAtomic(path.join(agentHomePath(home, "claude"), ".softela-ai", "overrides.json"), {
      rules: {
        "typo-rule-id-xyz": { action: "off", reason: "unknown rule id" },
        "forbidden-commands": { allow: ["(unterminated"], reason: "syntactically invalid regex" },
        "no-explicit-any": { action: 12345, reason: "wrong type" },
      },
    });

    const result = runCli(home, ["doctor", "--agent", "claude", "--json"]);
    eq(result.code, 1, "a doctor run with only invalid overrides must not report success");
    const report = JSON.parse(result.stdout);
    const overrides = report.agents[0].overrides;

    const unknownId = overrides.find((o) => o.ruleId === "typo-rule-id-xyz");
    eq(unknownId.state, "invalid");
    ok(unknownId.problems.some((p) => p.includes("unknown rule id")), JSON.stringify(unknownId.problems));

    const badRegex = overrides.find((o) => o.ruleId === "forbidden-commands");
    eq(badRegex.state, "invalid");
    ok(badRegex.problems.some((p) => p.includes("not a valid regular expression")), JSON.stringify(badRegex.problems));

    const badType = overrides.find((o) => o.ruleId === "no-explicit-any");
    eq(badType.state, "invalid");
    ok(badType.problems.some((p) => p.includes("must be a string")), JSON.stringify(badType.problems));
  });

  test("an override written against the mandatory infra-self-protection rule is reported as ignored, never as effective", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    writeJsonAtomic(path.join(agentHomePath(home, "claude"), ".softela-ai", "overrides.json"), {
      rules: { "infra-self-protection": { action: "off", reason: "attempt to disable the mandatory rule by hand-editing" } },
    });

    const result = runCli(home, ["doctor", "--agent", "claude", "--json"]);
    const report = JSON.parse(result.stdout);
    const override = report.agents[0].overrides.find((o) => o.ruleId === "infra-self-protection");
    ok(override, "the override must still be listed, just not as effective");
    eq(override.state, "ignored");

    const engine = require("../../core/engine");
    const infraSelfProtection = require("../../core/guards/infra-self-protection");
    const { resolveOverrides } = require("../../core/lib/override-resolver");
    const overrides = resolveOverrides("claude", "SomeProject", {
      file: path.join(agentHomePath(home, "claude"), ".softela-ai", "overrides.json"),
    });
    const decision = engine.evaluate(
      { agent: "claude", event: "PreToolUse", toolName: "Bash", command: "softela-ai approve infra-self-protection", project: { id: "SomeProject" }, overrides },
      { rules: [infraSelfProtection] },
    );
    eq(decision && decision.action, "deny", "the engine must still deny — the mandatory rule was never actually softened");
  });

  test("an overrides.json that fails its own schema is reported and drives a non-zero exit", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    writeJsonAtomic(path.join(agentHomePath(home, "claude"), ".softela-ai", "overrides.json"), {
      rules: { "colocated-tests": { action: "off" } },
      unexpectedTopLevelKey: true,
    });

    const result = runCli(home, ["doctor", "--agent", "claude", "--json"]);
    eq(result.code, 1);
    const report = JSON.parse(result.stdout);
    ok(report.agents[0].overridesSchemaErrors.length > 0, "the unexpected top-level key must be flagged");
  });

  /**
   * The CLI stamps every override it writes with a `setAt` timestamp. A
   * schema that rejects its own tool's output makes `doctor` report a
   * failure — and exit non-zero — for a perfectly ordinary override, which
   * is worse than useless: it trains a developer to ignore the one signal
   * that is supposed to mean something.
   */
  test("an override written by the CLI itself validates against the shipped schema", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    const set = runCli(home, ["override", "file-size-limit", "ask", "--reason", "legacy area", "--agent", "claude", "--yes"]);
    eq(set.code, 0, `override set failed: ${set.stderr}`);

    const stored = readJson(path.join(agentHomePath(home, "claude"), ".softela-ai", "overrides.json"));
    ok(
      stored && stored.rules && typeof stored.rules["file-size-limit"].setAt === "string",
      "this test proves nothing unless the CLI actually wrote a setAt stamp",
    );

    const result = runCli(home, ["doctor", "--agent", "claude", "--json"]);
    const report = JSON.parse(result.stdout);
    deepEq(report.agents[0].overridesSchemaErrors, [], "the CLI's own output must satisfy the CLI's own schema");
  });

  test("an unparseable settings.json is reported as a real problem, not silently overwritten", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    writeTextAtomic(path.join(agentHomePath(home, "claude"), "settings.json"), "{ this is not json");

    const result = runCli(home, ["doctor", "--agent", "claude", "--json"]);
    eq(result.code, 1);
    const report = JSON.parse(result.stdout);
    eq(report.agents[0].settingsParseOk, false);
  });

  test("[codex] a seed setting present with a different value than shipped is reported as changed, not silently missed", () => {
    const home = fakeHome();
    // seedForeign's config.toml already sets model_reasoning_effort = "low",
    // which differs from agent-orchestration's own shipped default "high" —
    // present, so install leaves it alone, exactly the case doctor's drift
    // check exists to surface.
    seedForeign(home, "codex");
    eq(runCli(home, ["install", "--agent", "codex", "--yes"]).code, 0);

    const report = JSON.parse(runCli(home, ["doctor", "--agent", "codex", "--json"]).stdout);
    const changed = report.agents[0].changedSeedSettings.find((s) => s.pointer === "/model_reasoning_effort");
    ok(changed, `expected /model_reasoning_effort to be reported as changed; got: ${JSON.stringify(report.agents[0].changedSeedSettings)}`);
    eq(changed.shipped, "high");
    eq(changed.module, "agent-orchestration");
  });

  test("[codex] a configured model carrying no tier token is reported, informationally, without changing the exit code", () => {
    const home = fakeHome();
    // seedForeign's config.toml sets model = "gpt-6-titan" — present, so
    // install leaves it alone, and it carries none of the sol/terra/luna tier
    // tokens `model-tiers.js#tierOf` recognises.
    seedForeign(home, "codex");
    eq(runCli(home, ["install", "--agent", "codex", "--yes"]).code, 0);

    // Isolates this assertion from the two Codex-only real problems doctor
    // now also reports (a fresh install is genuinely unapproved, and the
    // shipped dispatcher command's own quoting is platform-dependent) —
    // neither has anything to do with what THIS test checks.
    approveAllCodexHooks(home);
    neutralizeCodexHookSpawnability(home);

    const result = runCli(home, ["doctor", "--agent", "codex", "--json"]);
    eq(result.code, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    const unrecognized = report.agents[0].unrecognizedTierModels;
    ok(
      unrecognized.some((u) => u.pointer === "/model" && u.value === "gpt-6-titan"),
      `expected /model = "gpt-6-titan" to be reported; got: ${JSON.stringify(unrecognized)}`,
    );
  });

  test("[codex] a fresh install --agent all reports no changed seed settings for either agent — the false alarm a clean install must never raise", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "all", "--yes"]).code, 0);

    const report = JSON.parse(runCli(home, ["doctor", "--agent", "all", "--json"]).stdout);
    for (const agentReport of report.agents) {
      deepEq(
        agentReport.changedSeedSettings,
        [],
        `expected no changed seed settings for ${agentReport.agent} right after a clean install, got: ${JSON.stringify(agentReport.changedSeedSettings)}`,
      );
    }
  });

  test("[codex] a hand-edited /model pointer is reported as changed, naming both the shipped and current value", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "codex", "--yes"]).code, 0);

    const configPath = path.join(agentHomePath(home, "codex"), "config.toml");
    const content = fs.readFileSync(configPath, "utf8");
    const shippedModel = content.match(/^model = "([^"]+)"$/m)[1];
    fs.writeFileSync(configPath, content.replace(/^model = "[^"]+"$/m, 'model = "gpt-9-hand-edited"'), "utf8");

    const report = JSON.parse(runCli(home, ["doctor", "--agent", "codex", "--json"]).stdout);
    const changed = report.agents[0].changedSeedSettings;
    eq(changed.length, 1, `expected exactly one changed seed setting, got: ${JSON.stringify(changed)}`);
    eq(changed[0].pointer, "/model");
    eq(changed[0].shipped, shippedModel);
    eq(changed[0].current, "gpt-9-hand-edited");
  });

  test("[codex] a boolean feature-flag seed setting compares correctly in both directions", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "codex", "--yes"]).code, 0);

    const configPath = path.join(agentHomePath(home, "codex"), "config.toml");

    // Direction one: the freshly-seeded boolean `true` must compare equal to
    // the shipped `true` — a naive `raw === shipped` (string vs. boolean)
    // would report this, wrongly, as changed on every single install.
    const unchanged = JSON.parse(runCli(home, ["doctor", "--agent", "codex", "--json"]).stdout).agents[0].changedSeedSettings;
    eq(unchanged.length, 0, `expected the freshly-seeded boolean to compare equal to its shipped default, got: ${JSON.stringify(unchanged)}`);

    // Direction two: flipped to `false` by hand, it must now compare unequal.
    const content = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(
      configPath,
      content.replace(/^expose_spawn_agent_model_overrides = true$/m, "expose_spawn_agent_model_overrides = false"),
      "utf8",
    );

    const report = JSON.parse(runCli(home, ["doctor", "--agent", "codex", "--json"]).stdout);
    const changed = report.agents[0].changedSeedSettings;
    eq(changed.length, 1, `expected exactly one changed seed setting, got: ${JSON.stringify(changed)}`);
    eq(changed[0].pointer, "/multi_agent_v2/expose_spawn_agent_model_overrides");
    eq(changed[0].shipped, true);
    eq(changed[0].current, "false");
  });

  test("[codex] an unparseable config.toml reports no changed seed settings, rather than throwing", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "codex", "--yes"]).code, 0);

    const configPath = path.join(agentHomePath(home, "codex"), "config.toml");
    fs.appendFileSync(configPath, '\nweird = """\nmulti\nline\n"""\n', "utf8");

    const result = runCli(home, ["doctor", "--agent", "codex", "--json"]);
    const report = JSON.parse(result.stdout);
    eq(
      report.agents[0].changedSeedSettings.length,
      0,
      `expected no seed drift reported for a file this tool cannot parse confidently, got: ${JSON.stringify(report.agents[0].changedSeedSettings)}`,
    );
  });

  test("codex doctor states the hooks are installed but not yet trusted, without asserting either way", () => {
    const home = fakeHome();
    seedForeign(home, "codex");
    eq(runCli(home, ["install", "--agent", "codex", "--yes"]).code, 0);

    const result = runCli(home, ["doctor", "--agent", "codex"]);
    // A fresh install has certainly never been through Codex's one-time
    // hook-trust review — no [hooks.state] entry exists for anything it
    // just registered — which is a real, actionable failure now, not merely
    // informational: nothing softela-ai just installed is actually enforced yet.
    eq(result.code, 1, result.stdout + result.stderr);
    // `formatDoctorReport` word-wraps this caveat to the terminal's own
    // width (INSTALLER.md §8's own width-aware rendering), so the phrase
    // below can legitimately fall across a line break in the raw output;
    // whitespace is collapsed first so the substring check still holds
    // regardless of exactly where that break lands.
    const normalized = result.stdout.replace(/\s+/g, " ");
    ok(normalized.includes("hooks awaiting approval"), `expected the concrete unapproved-hooks finding, got:\n${result.stdout}`);
    ok(
      normalized.includes("expected right after a fresh install, not a broken installation"),
      `expected the finding to read as expected, not broken:\n${result.stdout}`,
    );
    ok(
      normalized.includes("until a human completes Codex's one-time hook-trust review, Codex runs none of these hooks and says nothing when it skips them"),
      `expected the finding to state what unapproved means in practice:\n${result.stdout}`,
    );
    ok(normalized.includes("nothing here is enforced yet"), `expected the finding to state that nothing is enforced yet:\n${result.stdout}`);
    ok(normalized.includes("complete its one-time hook-trust review"), `expected the finding to name the concrete fix:\n${result.stdout}`);
    ok(!/is (active|trusted)\b/i.test(result.stdout), "doctor must not claim to know the trust state it cannot read");
    // The "codex trust:" caveat restates the same "won't run until reviewed"
    // point in different words (plus a hashing-verification nuance the
    // finding above never states) — it must not also appear here, or a
    // developer reads the same fact twice.
    ok(
      !normalized.includes("reproducing Codex's own hashing function"),
      `expected the codex trust: caveat to be skipped as duplicative once the unapproved-hooks finding already covers it:\n${result.stdout}`,
    );

    const report = JSON.parse(runCli(home, ["doctor", "--agent", "codex", "--json"]).stdout).agents[0];
    ok(report.codexHookTrust.applicable, "a freshly installed codex agent registers hooks, so this check must be applicable");
    ok(report.codexHookTrust.unapproved.length > 0, "every freshly registered hook must be reported unapproved");
    eq(report.codexHookTrust.allApproved, false);
  });

  /**
   * `judgeCodexHookExecutable` judges a hook command's executable token
   * exactly the way Codex itself does, confirmed against the real binary:
   * split on whitespace, first token is the executable, no shell, no quote
   * handling. More negative cases than positive — this table exists because
   * the failure mode (a hook that silently never runs) is exactly the one a
   * developer cannot see on their own.
   */
  test("judgeCodexHookExecutable judges a command's executable token exactly the way Codex itself does", () => {
    const existingFile = path.join(tmpdir(), "node.exe");
    writeTextAtomic(existingFile, "not a real binary, just needs to exist");
    const spacedDir = path.join(tmpdir(), "a directory with spaces");
    const spacedFile = path.join(spacedDir, "node.exe");
    writeTextAtomic(spacedFile, "not a real binary, just needs to exist");

    const cases = [
      // Negative: a quoted executable token can never name a real file,
      // regardless of whether the quoted path itself exists on disk.
      { command: `"${spacedFile}" script.js`, ok: false, note: "quoted token, path exists" },
      { command: `"${existingFile}" script.js`, ok: false, note: "quoted token, no space in the path at all" },
      // Negative: unquoted, but the first whitespace-delimited token is cut
      // off mid-path by the very space that made quoting seem necessary.
      { command: `${spacedFile} script.js`, ok: false, note: "unquoted token truncated at its first internal space" },
      // Negative: a token with a path separator naming a file that is
      // simply wrong.
      { command: `${path.join(tmpdir(), "no-such-file.exe")} script.js`, ok: false, note: "separator present, file does not exist" },
      // Negative: nothing to spawn at all.
      { command: "", ok: false, note: "empty command" },
      { command: "   ", ok: false, note: "whitespace-only command" },
      // Positive: a bare name with no path separator is resolved against
      // PATH by Codex itself — never checked against this machine's disk.
      { command: "node script.js", ok: true, note: "bare executable name" },
      // Positive: an unquoted, space-free, existing absolute path.
      { command: `${existingFile} script.js`, ok: true, note: "unquoted existing path with no space" },
    ];

    for (const c of cases) {
      const verdict = doctor.judgeCodexHookExecutable(c.command);
      eq(verdict.ok, c.ok, `case "${c.note}" (command: ${JSON.stringify(c.command)}) — got: ${JSON.stringify(verdict)}`);
      if (!c.ok) ok(typeof verdict.reason === "string" && verdict.reason.length > 0, `case "${c.note}" must carry a reason`);
    }
  });

  test("a Codex hook command whose executable token can never spawn is reported as a real failure, naming the fix", () => {
    const home = fakeHome();
    seedForeign(home, "codex");
    eq(runCli(home, ["install", "--agent", "codex", "--yes"]).code, 0);
    approveAllCodexHooks(home);

    const hooksJsonPath = path.join(agentHomePath(home, "codex"), "hooks.json");
    const hooksJson = readJson(hooksJsonPath);
    hooksJson.hooks.SessionStart[0].hooks[0].command = '"C:\\Program Files\\nodejs\\node.exe" C:\\some\\script.js';
    writeJsonAtomic(hooksJsonPath, hooksJson);

    const result = runCli(home, ["doctor", "--agent", "codex", "--json"]);
    eq(result.code, 1, "a hook that can never spawn must drive a non-zero exit");
    const report = JSON.parse(result.stdout).agents[0];
    const flagged = report.unspawnableCodexHooks.find((h) => h.event === "SessionStart" && h.groupIndex === 0 && h.hookIndex === 0);
    ok(flagged, `expected the hand-edited hook to be reported, got: ${JSON.stringify(report.unspawnableCodexHooks)}`);
    ok(/quote/i.test(flagged.reason), `expected the reason to explain the quoting, got: ${flagged.reason}`);

    const text = runCli(home, ["doctor", "--agent", "codex"]).stdout.replace(/\s+/g, " ");
    ok(text.includes("hook commands that cannot spawn"), text);
    ok(text.includes("softela-ai update"), `expected the fix to name the update command, got: ${text}`);
  });

  test("a Codex hook command with a bare, space-free executable token is never reported as unspawnable", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "codex", "--yes"]).code, 0);
    approveAllCodexHooks(home);
    neutralizeCodexHookSpawnability(home);

    const result = runCli(home, ["doctor", "--agent", "codex", "--json"]);
    eq(result.code, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout).agents[0];
    deepEq(report.unspawnableCodexHooks, []);
  });

  test("once every registered Codex hook carries a [hooks.state] trust entry, doctor reports allApproved and drops it as a real problem", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "codex", "--yes"]).code, 0);
    approveAllCodexHooks(home);
    neutralizeCodexHookSpawnability(home);

    const result = runCli(home, ["doctor", "--agent", "codex"]);
    eq(result.code, 0, result.stdout + result.stderr);
    const normalized = result.stdout.replace(/\s+/g, " ");
    ok(normalized.includes("a command edited since approval still needs approving again"), result.stdout);
    ok(!normalized.includes("hooks awaiting approval"), `no hook should read as unapproved once every one is trusted:\n${result.stdout}`);

    const report = JSON.parse(runCli(home, ["doctor", "--agent", "codex", "--json"]).stdout).agents[0];
    eq(report.codexHookTrust.allApproved, true);
    deepEq(report.codexHookTrust.unapproved, []);
  });

  test("one hook left unapproved among several is reported by itself, not the whole set", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "codex", "--yes"]).code, 0);
    approveAllCodexHooks(home);
    neutralizeCodexHookSpawnability(home);

    // Undo trust for exactly one already-approved hook by removing exactly
    // its own trust block (the same shape `approveAllCodexHooks` appended),
    // leaving every other hook's own block untouched wherever it sits.
    const hooksJsonPath = path.join(agentHomePath(home, "codex"), "hooks.json");
    const registered = doctor.listRegisteredCodexHooks(readJson(hooksJsonPath));
    ok(registered.length > 1, "expected more than one registered hook to make this a meaningful test");
    const target = registered[0];
    const configPath = path.join(agentHomePath(home, "codex"), "config.toml");
    const targetBlock = `\n[${doctor.codexHookTrustSectionPath(hooksJsonPath, target)}]\ntrusted_hash = "sha256:test-fixture"\n`;
    const content = fs.readFileSync(configPath, "utf8");
    ok(content.includes(targetBlock), "expected the target hook's own trust block to already be present");
    fs.writeFileSync(configPath, content.replace(targetBlock, ""), "utf8");

    const report = JSON.parse(runCli(home, ["doctor", "--agent", "codex", "--json"]).stdout).agents[0];
    eq(report.codexHookTrust.unapproved.length, 1, `expected exactly one unapproved hook, got: ${JSON.stringify(report.codexHookTrust.unapproved)}`);
    eq(report.codexHookTrust.unapproved[0].event, target.event);
    eq(report.codexHookTrust.unapproved[0].groupIndex, target.groupIndex);
    eq(report.codexHookTrust.unapproved[0].hookIndex, target.hookIndex);
  });

  test("codex doctor with no config.toml at all reports every registered hook as unapproved, never as unknown", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "codex", "--yes"]).code, 0);
    neutralizeCodexHookSpawnability(home);

    fs.rmSync(path.join(agentHomePath(home, "codex"), "config.toml"));

    const result = runCli(home, ["doctor", "--agent", "codex", "--json"]);
    eq(result.code, 1, "a fresh install with config.toml deleted has certainly never been through hook trust review");
    const report = JSON.parse(result.stdout).agents[0];
    ok(report.codexHookTrust.applicable, "an absent config.toml must still be judged, not skipped");
    ok(report.codexHookTrust.unapproved.length > 0);
  });

  test("the codex askMode parity row states the current mode and never reports a mismatch", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    seedForeign(home, "codex");
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);
    eq(runCli(home, ["install", "--agent", "codex", "--yes"]).code, 0);

    const blockReport = JSON.parse(runCli(home, ["doctor", "--agent", "all", "--json"]).stdout);
    const blockRow = blockReport.parity.rows.find((r) => r.aspect === "codex askMode");
    ok(blockRow, `expected a "codex askMode" parity row, got: ${JSON.stringify(blockReport.parity.rows.map((r) => r.aspect))}`);
    eq(blockRow.matched, true);
    ok(blockRow.codex.includes("block"), blockRow.codex);

    const statePath = path.join(agentHomePath(home, "codex"), ".softela-ai", "state.json");
    const state = readJson(statePath);
    state.adapterOptions.askMode = "advise";
    writeJsonAtomic(statePath, state);

    const adviseReport = JSON.parse(runCli(home, ["doctor", "--agent", "all", "--json"]).stdout);
    const adviseRow = adviseReport.parity.rows.find((r) => r.aspect === "codex askMode");
    eq(adviseRow.matched, true);
    ok(adviseRow.codex.includes("advise"), adviseRow.codex);
  });

  test("a rules.groups switch set to a string outside the ruleSwitch oneOf is rejected, naming the path", () => {
    const errors = doctor.validateAgainst(PROJECT_SCHEMA, { id: "x", rules: { groups: { code: "banana" } } }, "project");
    ok(errors.length > 0, "a garbage group value must be rejected, not silently accepted");
    ok(errors.some((e) => e.includes("project.rules.groups.code")), `expected an error naming project.rules.groups.code, got: ${JSON.stringify(errors)}`);
  });

  test("a rules.groups switch set to a number is rejected, naming the path", () => {
    const errors = doctor.validateAgainst(PROJECT_SCHEMA, { id: "x", rules: { groups: { code: 5 } } }, "project");
    ok(errors.length > 0, "a numeric group value must be rejected, not silently accepted");
    ok(errors.some((e) => e.includes("project.rules.groups.code")), `expected an error naming project.rules.groups.code, got: ${JSON.stringify(errors)}`);
  });

  test("a rules.byId entry with a misspelled action is rejected, naming the path", () => {
    const errors = doctor.validateAgainst(
      PROJECT_SCHEMA,
      { id: "x", rules: { byId: { "branch-naming": { action: "aks" } } } },
      "project",
    );
    ok(errors.length > 0, "action: \"aks\" must be rejected, not silently accepted");
    ok(errors.some((e) => e.includes("project.rules.byId.branch-naming")), `expected an error naming project.rules.byId.branch-naming, got: ${JSON.stringify(errors)}`);
  });

  test("a rules.byId entry missing the required action is rejected, naming the path", () => {
    const errors = doctor.validateAgainst(
      PROJECT_SCHEMA,
      { id: "x", rules: { byId: { "branch-naming": { reason: "why" } } } },
      "project",
    );
    ok(errors.length > 0, "an entry with no action must be rejected, not silently accepted");
    ok(errors.some((e) => e.includes("project.rules.byId.branch-naming")), `expected an error naming project.rules.byId.branch-naming, got: ${JSON.stringify(errors)}`);
  });

  test("a typo'd rule id in rules.byId is rejected, instead of silently becoming a permanent no-op", () => {
    const errors = doctor.validateAgainst(
      PROJECT_SCHEMA,
      { id: "x", rules: { byId: { "branch-namign": { action: "off", reason: "typo — meant to disable branch-naming" } } } },
      "project",
    );
    ok(errors.length > 0, "a rule id that is not registered must be rejected, not silently accepted");
    ok(errors.some((e) => e.includes("project.rules.byId.branch-namign")), `expected an error naming project.rules.byId.branch-namign, got: ${JSON.stringify(errors)}`);

    // Confirm the mechanism the finding describes: absent the schema fix, the
    // engine would run the real branch-naming rule at full, unmodified
    // strength while the team believed they had switched it off.
    const engine = require("../../core/engine");
    const ctx = {
      event: "PreToolUse",
      agent: "claude",
      toolName: "Bash",
      command: "git checkout -b my-random-branch",
      project: {
        id: "Fake",
        stack: "frontend",
        branchNaming: {
          pattern: "^(feature|bugfix|fix|hotfix)/((task|ticket)[_-])?\\d+[_-].+$",
          action: "ask",
          preferred: "feature/task_00000_short_name",
        },
        rules: { byId: { "branch-namign": { action: "off", reason: "typo" } } },
      },
      overrides: { forRule: () => ({ action: undefined, allow: [], reason: undefined }) },
      modules: new Set(),
    };
    const result = engine.evaluate(ctx);
    ok(result && result.ruleId === "branch-naming", "the typo'd byId key never actually reaches the real rule, proving this is exactly the schema gap doctor must now catch");
  });

  test("project.schema.json's rules.byId enum is kept in sync with the real rule registry", () => {
    const registryIds = Object.keys(require("../../core/guards").byId).sort();
    const schemaIds = [...PROJECT_SCHEMA.definitions.ruleId.enum].sort();
    deepEq(schemaIds, registryIds, "the schema's rule-id enum has drifted from core/guards/ — update both together");
  });

  test("a rule module that failed to load is reported by name and reason, and drives doctor's exit code to 1", () => {
    // `agents: []` and an injected `ruleRegistryStatus` keep this a pure
    // unit test of the registry-visibility wiring itself, never touching
    // the real `core/guards/` directory or a fake agent home.
    const fakeStatus = {
      rules: [{ id: "kept-rule" }],
      loadErrors: [{ file: "broken-rule.js", error: "missing evaluate function" }],
    };
    const report = doctor.buildReport([], { ruleRegistryStatus: fakeStatus });
    deepEq(report.ruleLoadErrors, fakeStatus.loadErrors);
    eq(report.ruleRegistryEmpty, false, "one rule still loaded — this must not read as total failure");
    eq(doctor.doctorExitCode(report), 1, "a rule module that cannot load is a real problem, not merely informational");

    const rendered = doctor.formatDoctorReport(report, 100).join("\n");
    ok(rendered.includes("broken-rule.js"), `expected the broken module's filename in the report:\n${rendered}`);
    ok(rendered.includes("missing evaluate function"), `expected the reported reason in the report:\n${rendered}`);
    ok(!/critical/i.test(rendered), `a partial failure must not read as the total-failure CRITICAL case:\n${rendered}`);
  });

  test("the rule registry loading zero rules at all is reported loud and distinct from an ordinary partial failure", () => {
    const fakeStatus = { rules: [], loadErrors: [{ file: "everything.js", error: "boom" }] };
    const report = doctor.buildReport([], { ruleRegistryStatus: fakeStatus });
    eq(report.ruleRegistryEmpty, true);
    eq(doctor.doctorExitCode(report), 1);

    const rendered = doctor.formatDoctorReport(report, 100).join("\n");
    ok(/critical/i.test(rendered), `expected a loud, hard-to-miss marker when the whole registry failed to load anything:\n${rendered}`);
    ok(rendered.includes("everything.js"), `the underlying broken file must still be named even in the total-failure case:\n${rendered}`);
  });

  test("the real, healthy rule registry reports no load errors and never drives the exit code", () => {
    const report = doctor.buildReport([]);
    deepEq(report.ruleLoadErrors, [], `expected the real registry to load cleanly: ${JSON.stringify(report.ruleLoadErrors)}`);
    eq(report.ruleRegistryEmpty, false);
    eq(doctor.doctorExitCode(report), 0);
  });

  test("a rules.byId entry with an unknown key is rejected, naming the path", () => {
    const errors = doctor.validateAgainst(
      PROJECT_SCHEMA,
      { id: "x", rules: { byId: { "branch-naming": { action: "off", bogus: true } } } },
      "project",
    );
    ok(errors.length > 0, "an unknown key inside a rule switch object must be rejected, not silently accepted");
    ok(errors.some((e) => e.includes("project.rules.byId.branch-naming")), `expected an error naming project.rules.byId.branch-naming, got: ${JSON.stringify(errors)}`);
  });

  test("a valid rules config still passes validation", () => {
    const errors = doctor.validateAgainst(PROJECT_SCHEMA, { id: "x", rules: { groups: { code: "off" } } }, "project");
    eq(errors.length, 0, `expected no errors, got: ${JSON.stringify(errors)}`);
  });

  test("every shipped projects/*.json config validates clean against the schema — the regression guard for a stricter validator", () => {
    const invalid = doctor.validateProjectConfigs();
    eq(invalid.length, 0, `a shipped project config failed schema validation: ${JSON.stringify(invalid)}`);
  });

  test("every shipped projects/_presets/*.json config validates clean when merged the way preset-resolver.js actually merges it", () => {
    // A preset is a fragment merged UNDER a project's own config
    // (core/lib/preset-resolver.js#mergeProjectWithPreset) — it never
    // carries its own "id", so it is validated here the way it is really
    // consumed: merged under a minimal stub that supplies the one property
    // the schema requires, not as a standalone document.
    const presetsDir = path.join(paths.repoRoot(), "projects", "_presets");
    const files = fs.readdirSync(presetsDir).filter((f) => f.toLowerCase().endsWith(".json"));
    ok(files.length > 0, "expected at least one shipped preset to check");
    for (const file of files) {
      const preset = readJson(path.join(presetsDir, file));
      ok(preset, `${file} must parse as JSON`);
      const merged = Object.assign({ id: "preset-check" }, preset);
      const errors = doctor.validateAgainst(PROJECT_SCHEMA, merged, file);
      eq(errors.length, 0, `${file} failed schema validation once merged under a project: ${JSON.stringify(errors)}`);
    }
  });

  test("an unresolvable $ref produces an explicit error naming the pointer, not silence", () => {
    const root = { definitions: { Real: { type: "string" } } };
    const errors = doctor.validateAgainst({ $ref: "#/definitions/Typo" }, "value", "at", root);
    eq(errors.length, 1);
    ok(errors[0].includes("#/definitions/Typo"), `expected the unresolvable pointer named in the message, got: ${errors[0]}`);
  });

  test("a cyclic $ref (A -> B -> A) terminates with an error instead of hanging", () => {
    const root = {
      definitions: {
        A: { $ref: "#/definitions/B" },
        B: { $ref: "#/definitions/A" },
      },
    };
    const errors = doctor.validateAgainst({ $ref: "#/definitions/A" }, "value", "at", root);
    eq(errors.length, 1);
    ok(/cycle/i.test(errors[0]), `expected a cycle error, got: ${JSON.stringify(errors)}`);
  });

  test("oneOf with zero matching branches fails and names the offending value", () => {
    const ruleSwitchRef = { $ref: "#/definitions/ruleSwitch" };
    const errors = doctor.validateAgainst(ruleSwitchRef, "banana", "ruleSwitch", PROJECT_SCHEMA);
    eq(errors.length, 1);
    ok(errors[0].includes('"banana"'), `expected the rejected value named in the message, got: ${errors[0]}`);
    ok(errors[0].includes("oneOf"), `expected the message to mention oneOf, got: ${errors[0]}`);
  });

  test("oneOf with exactly one matching branch passes — both the string form and the object form of ruleSwitch", () => {
    const ruleSwitchRef = { $ref: "#/definitions/ruleSwitch" };
    eq(doctor.validateAgainst(ruleSwitchRef, "off", "ruleSwitch", PROJECT_SCHEMA).length, 0);
    eq(doctor.validateAgainst(ruleSwitchRef, { action: "deny" }, "ruleSwitch", PROJECT_SCHEMA).length, 0);
  });

  test("ruleSwitch's two oneOf branches are mutually exclusive by type, so no shipped value can match both", () => {
    // project.schema.json's own oneOf (string vs. object) can never be
    // ambiguous — every JS value is either a string or not, never both —
    // so this asserts that documented non-ambiguity directly rather than
    // relying on the synthetic-schema test below to stand in for it.
    const ruleSwitchRef = { $ref: "#/definitions/ruleSwitch" };
    for (const value of ["off", "ask", "deny", { action: "off" }, { action: "ask", reason: "r" }]) {
      const errors = doctor.validateAgainst(ruleSwitchRef, value, "ruleSwitch", PROJECT_SCHEMA);
      eq(errors.length, 0, `expected ${JSON.stringify(value)} to match exactly one branch, got: ${JSON.stringify(errors)}`);
    }
  });

  test("oneOf with two matching branches is rejected as ambiguous, naming the value (synthetic schema — no shipped oneOf can reach this)", () => {
    const schema = { oneOf: [{ type: "string" }, { type: "string", minLength: 0 }] };
    const errors = doctor.validateAgainst(schema, "hi", "at");
    eq(errors.length, 1);
    ok(errors[0].includes('"hi"'), `expected the ambiguous value named in the message, got: ${errors[0]}`);
    ok(errors[0].includes("2 oneOf branches"), `expected the branch count in the message, got: ${errors[0]}`);
  });

  test("minItems rejects an empty array where the schema requires at least one element", () => {
    const errors = doctor.validateAgainst(
      PROJECT_SCHEMA,
      { id: "x", stacks: [{ paths: [], stack: "frontend" }] },
      "project",
    );
    ok(errors.some((e) => e.includes("project.stacks[0].paths")), `expected an error naming project.stacks[0].paths, got: ${JSON.stringify(errors)}`);
  });

  test("the shipped project schema uses no keyword the validator leaves unhandled", () => {
    eq(doctor.findUnhandledSchemaKeywords(PROJECT_SCHEMA).length, 0, `unhandled keyword(s) found: ${JSON.stringify(doctor.findUnhandledSchemaKeywords(PROJECT_SCHEMA))}`);
    eq(doctor.unhandledSchemaKeywords().length, 0);
  });

  test("an unimplemented keyword is surfaced rather than silently skipped", () => {
    const found = doctor.findUnhandledSchemaKeywords({ type: "string", pattern: "^[a-z]+$" });
    ok(found.includes("pattern"), `expected "pattern" to be reported as unhandled, got: ${JSON.stringify(found)}`);
  });

  test("doctor's own report fits every probed terminal width for a freshly installed claude agent, with no drift", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    for (const width of PROBE_WIDTHS) {
      const result = runCli(home, ["doctor", "--agent", "claude"], { env: { SOFTELA_AI_COLUMNS: String(width) } });
      eq(result.code, 0, `doctor at width ${width} stdout:\n${result.stdout}\n${result.stderr}`);
      assertDoctorFitsWidth(ok, result, width);
    }
  });

  test("doctor's own report fits every probed terminal width for --agent all, with both agents installed — the parity table's widest, most demanding case", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    seedForeign(home, "codex");
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);
    eq(runCli(home, ["install", "--agent", "codex", "--yes"]).code, 0);

    for (const width of PROBE_WIDTHS) {
      const result = runCli(home, ["doctor", "--agent", "all"], { env: { SOFTELA_AI_COLUMNS: String(width) } });
      assertDoctorFitsWidth(ok, result, width);
      ok(result.stdout.includes("parity ("), `expected both agents installed to produce a comparable parity table:\n${result.stdout}`);
    }
  });

  test("doctor --json output never depends on terminal width — the JSON path never renders through formatDoctorReport", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    let previous = null;
    for (const width of PROBE_WIDTHS) {
      const result = runCli(home, ["doctor", "--agent", "claude", "--json"], { env: { SOFTELA_AI_COLUMNS: String(width) } });
      eq(result.code, 0, `doctor --json at width ${width} stdout:\n${result.stdout}\n${result.stderr}`);
      JSON.parse(result.stdout); // must always still be valid JSON, regardless of width
      if (previous !== null) {
        eq(result.stdout, previous, `--json output must be identical across terminal widths; differed at width ${width}`);
      }
      previous = result.stdout;
    }
  });

  test("doctor's own report fits every probed terminal width for an uninstalled home", () => {
    const home = fakeHome();

    for (const width of PROBE_WIDTHS) {
      const result = runCli(home, ["doctor", "--agent", "claude"], { env: { SOFTELA_AI_COLUMNS: String(width) } });
      eq(result.code, 0, `doctor at width ${width} stdout:\n${result.stdout}\n${result.stderr}`);
      assertDoctorFitsWidth(ok, result, width);
      ok(result.stdout.includes("not installed"), result.stdout);
    }
  });

  test("doctor's own report fits every probed terminal width once a shipped file has drifted", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    const manifestPath = path.join(agentHomePath(home, "claude"), ".softela-ai", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const relPath = Object.keys(manifest.files).find((p) => p.endsWith("core/lib/decision.js"));
    const abs = path.join(agentHomePath(home, "claude"), relPath.split("/").join(path.sep));
    fs.appendFileSync(abs, "\n// a deliberate drift for the width-invariant test\n", "utf8");

    for (const width of PROBE_WIDTHS) {
      const result = runCli(home, ["doctor", "--agent", "claude"], { env: { SOFTELA_AI_COLUMNS: String(width) } });
      assertDoctorFitsWidth(ok, result, width);
      ok(result.stdout.includes("locally modified"), `expected the drifted file to still be reported at width ${width}:\n${result.stdout}`);
    }
  });

  /* ------------------------------------- M1b: memory-as-context reporting */

  test("doctor reports the module as not enabled when memory-as-context is off", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(runCli(home, ["install", "--agent", "claude", "--modules", "analyze-first", "--yes"]).code, 0);

    const report = JSON.parse(runCli(home, ["doctor", "--agent", "claude", "--json"]).stdout);
    deepEq(report.agents[0].memory, { moduleEnabled: false });
  });

  test("doctor reports 'not yet seeded' before any session-start hook has ever run", () => {
    // No `seedForeign` here, deliberately — that fixture pre-populates a
    // memory directory of its own (to test "preserve what we do not own"
    // elsewhere), which would make `exists` true before install even runs.
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "claude", "--modules", "memory-as-context", "--yes"]).code, 0);

    const report = JSON.parse(runCli(home, ["doctor", "--agent", "claude", "--json"]).stdout);
    const memory = report.agents[0].memory;
    eq(memory.moduleEnabled, true);
    eq(memory.location, "global");
    eq(memory.exists, false);
    eq(memory.seeded, false);
    eq(memory.fileCount, null);
    eq(memory.indexBlocked, false);
  });

  test("doctor reports the real, honest seed state — landed, real on-disk file count, index present — after a real session-start hook run (location=global)", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(runCli(home, ["install", "--agent", "claude", "--modules", "memory-as-context", "--yes"]).code, 0);

    const seedRun = runInstalledInjectMemory(home, "claude", "global");
    eq(seedRun.code, 0, seedRun.stdout + seedRun.stderr);

    const memoryDir = path.join(agentHomePath(home, "claude"), "memory");
    const onDiskFiles = fs.readdirSync(path.join(memoryDir, "softela")).filter((n) => n.endsWith(".md")).length;
    ok(onDiskFiles > 0, "sanity check: the real hook run must have actually seeded something");

    const report = JSON.parse(runCli(home, ["doctor", "--agent", "claude", "--json"]).stdout);
    const memory = report.agents[0].memory;
    eq(memory.moduleEnabled, true);
    eq(memory.location, "global");
    eq(memory.memoryDir, memoryDir);
    eq(memory.exists, true);
    eq(memory.seeded, true);
    eq(memory.indexPresent, true);
    eq(memory.indexBlocked, false);
    // The real on-disk count, not whatever a marker claims — this is the
    // exact honesty gap M1 exploited: a marker can claim success while
    // lying about it.
    eq(memory.fileCount, onDiskFiles);
    deepEq(memory.skippedFiles, []);

    const textReport = runCli(home, ["doctor", "--agent", "claude"]).stdout;
    ok(textReport.includes("seeded"), textReport);
    ok(!textReport.includes("STUCK"), textReport);
  });

  test("doctor's memory section renders a populated skipped-files list, at every probed terminal width", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(runCli(home, ["install", "--agent", "claude", "--modules", "memory-as-context", "--yes"]).code, 0);

    // A fixture seed catalogue this run's own `SOFTELA_AI_SEED_CATALOG_DIR`
    // override points the real, installed `seed-memory.js` at instead of
    // this module's real shipped `seed/` directory — one file with no
    // frontmatter fence at all, the exact shape `seed-memory.js#parseFrontmatter`
    // cannot use and records in its skipped-files diagnostic rather than
    // simply dropping.
    const catalogDir = tmpdir();
    fs.writeFileSync(path.join(catalogDir, "module.json"), JSON.stringify({ id: "memory-as-context" }));
    const seedDir = path.join(catalogDir, "seed");
    fs.mkdirSync(seedDir, { recursive: true });
    fs.writeFileSync(path.join(seedDir, "bad-seed.md"), "This file carries no frontmatter fence at all.\n");

    const seedRun = runInstalledInjectMemory(home, "claude", "global", { SOFTELA_AI_SEED_CATALOG_DIR: catalogDir });
    eq(seedRun.code, 0, seedRun.stdout + seedRun.stderr);

    const jsonReport = JSON.parse(runCli(home, ["doctor", "--agent", "claude", "--json"]).stdout);
    const skippedFiles = jsonReport.agents[0].memory.skippedFiles;
    eq(skippedFiles.length, 1, JSON.stringify(skippedFiles));
    eq(skippedFiles[0].file, "bad-seed.md");
    ok(typeof skippedFiles[0].reason === "string" && skippedFiles[0].reason.length > 0, skippedFiles[0].reason);

    for (const width of PROBE_WIDTHS) {
      const result = runCli(home, ["doctor", "--agent", "claude"], { env: { SOFTELA_AI_COLUMNS: String(width) } });
      eq(result.code, 0, `doctor at width ${width} stdout:\n${result.stdout}\n${result.stderr}`);
      assertDoctorFitsWidth(ok, result, width);
      ok(result.stdout.includes("bad-seed.md"), `expected the skipped file's name at width ${width}:\n${result.stdout}`);
      ok(result.stdout.includes("skipped"), `expected the skipped-files label at width ${width}:\n${result.stdout}`);
    }
  });

  test("doctor reports and fails on a seed stuck behind an ambiguous MEMORY.md, and text output names it STUCK", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(runCli(home, ["install", "--agent", "claude", "--modules", "memory-as-context", "--yes"]).code, 0);

    // An ambiguous MEMORY.md, present BEFORE the very first session-start
    // hook ever runs — the exact shape that left the on-disk marker falsely
    // claiming success before this defect was fixed.
    const seedMemoryLib = require(path.join(installedRootPath(home, "claude"), "modules", "memory-as-context", "hooks", "seed-memory.js"));
    const memoryDir = path.join(agentHomePath(home, "claude"), "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    const ambiguous = `${seedMemoryLib.BEGIN}\n\nold\n\n${seedMemoryLib.END}\n\n${seedMemoryLib.BEGIN}\n\nold2\n\n${seedMemoryLib.END}\n`;
    fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), ambiguous);

    const seedRun = runInstalledInjectMemory(home, "claude", "global");
    eq(seedRun.code, 0, seedRun.stdout + seedRun.stderr);

    const jsonReport = JSON.parse(runCli(home, ["doctor", "--agent", "claude", "--json"]).stdout);
    const memory = jsonReport.agents[0].memory;
    eq(memory.moduleEnabled, true);
    eq(memory.seeded, false, "the marker must never be stamped for a run stuck on an ambiguous index");
    eq(memory.indexBlocked, true);
    ok(typeof memory.indexBlockedReason === "string" && memory.indexBlockedReason.length > 0, memory.indexBlockedReason);
    ok(typeof memory.indexBlockedSince === "string" && memory.indexBlockedSince.length > 0, memory.indexBlockedSince);

    const textResult = runCli(home, ["doctor", "--agent", "claude"]);
    ok(textResult.stdout.includes("STUCK"), textResult.stdout);
    eq(textResult.code, 1, "a stuck seed must drive doctor's own exit code non-zero — this is the mechanism that catches M1's silent failure");
  });

  test("doctor's memory section resolves and reports correctly for the infrastructure location", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(runCli(home, ["install", "--agent", "claude", "--modules", "memory-as-context", "--yes", "--memory-location", "infrastructure"]).code, 0);

    const report = JSON.parse(runCli(home, ["doctor", "--agent", "claude", "--json"]).stdout);
    const memory = report.agents[0].memory;
    eq(memory.moduleEnabled, true);
    eq(memory.location, "infrastructure");
    ok(
      memory.memoryDir.startsWith(path.join(agentHomePath(home, "claude"), "softela-ai", "memory")),
      `infrastructure location must resolve under the tool-owned directory, got: ${memory.memoryDir}`,
    );
    eq(memory.exists, false);
  });

  test("doctor's memory section resolves and reports correctly for the repo location", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    const repoDir = tmpdir();
    execFileSync("git", ["init", "-q"], { cwd: repoDir });

    eq(runCliAt(repoDir, home, ["install", "--agent", "claude", "--modules", "memory-as-context", "--yes", "--memory-location", "repo"]).code, 0);

    const result = runCliAt(repoDir, home, ["doctor", "--agent", "claude", "--json"]);
    eq(result.code, 0, result.stdout + result.stderr);
    const memory = JSON.parse(result.stdout).agents[0].memory;
    eq(memory.moduleEnabled, true);
    eq(memory.location, "repo");
    eq(memory.memoryDir, path.join(repoDir, ".softela-ai-memory"));
    eq(memory.exists, false);
  });

  test("a synthetic per-agent report that never claims to model memory-as-context renders unchanged and never throws", () => {
    const width = 80;
    // A hand-built fixture exercising only the fields this narrower scenario
    // cares about — deliberately missing `memory` entirely, the same shape
    // `tests/installer/help-output.test.js`'s own DOCTOR_AGENT_REPORT fixture
    // uses, since a report built before this section existed must still
    // render exactly as it always did.
    const agentReport = {
      agent: "claude",
      installed: true,
      installedVersion: "1.0.0",
      repoVersion: "1.0.0",
      updateAvailable: false,
      manifestUnreadable: false,
      drift: [],
      missing: [],
      overrides: [],
      overridesSchemaErrors: [],
      approvals: [],
      enabledModules: [],
      changedSeedSettings: [],
      unrecognizedTierModels: [],
      settingsParseOk: true,
      settingsFile: "C:\\Users\\dev\\.claude\\settings.json",
      configTomlReadable: null,
      unspawnableCodexHooks: [],
      codexHookTrust: { applicable: false, unapproved: [], allApproved: false },
      runCommand: 'node "C:\\Users\\dev\\.claude\\softela-ai\\bin\\softela-ai"',
      registeredHookEvents: [],
      effectiveModel: null,
      effectiveReasoningEffort: null,
      askMode: null,
    };
    const report = { agents: [agentReport], invalidProjects: [], schemaKeywordsUnhandled: [], parity: { comparable: false, missing: "codex" } };

    notThrows(() => doctor.formatDoctorReport(report, width), "formatDoctorReport must tolerate an agent report with no memory field at all");
    const lines = doctor.formatDoctorReport(report, width);
    ok(!lines.some((l) => l.includes("memory:")), "no memory section should render for a report that never modeled one");
    eq(doctor.doctorExitCode(report), 0, "a missing memory field must never itself drive the exit code");
  });
});
