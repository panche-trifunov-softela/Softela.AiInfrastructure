"use strict";

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");
const { loadModule, validateModuleJson, runInstall, snapshotAgentHome, sj, st, paths } = require("./_helpers");
const { decide } = require("../guards/_ctx");
const subagentModel = require("../../core/guards/subagent-model");
const reasoningEffortFloor = require("../../core/guards/reasoning-effort-floor");

const MODULE_ID = "agent-orchestration";

suite("modules/agent-orchestration", ({ test, eq, deepEq, ok, fakeHome }) => {
  const mod = loadModule(MODULE_ID);

  test("module.json validates against the shape MODULES.md documents", () => {
    deepEq(validateModuleJson(mod), []);
  });

  test("names exactly the guards it activates", () => {
    deepEq(mod.json.guards.slice().sort(), [
      "delegate-bulk-reading",
      "no-nested-delegation",
      "reasoning-effort-floor",
      "subagent-model",
    ]);
  });

  test("every settings entry it ships is seed mode, and none touches sandbox_mode", () => {
    for (const s of mod.json.settings) {
      eq(s.mode, "seed");
      ok(!s.pointer.includes("sandbox_mode"), `pointer "${s.pointer}" must never be sandbox_mode`);
    }
  });

  test("ships no prompt.md of its own — only module.json and README.md", () => {
    eq(mod.json.prompt, undefined);
  });

  /* ------------------------------------------------- guard activation gate */

  test("subagent-model stays silent when agent-orchestration is not enabled, even for a modelless spawn", () => {
    eq(decide(subagentModel, { toolName: "Agent", input: {}, modules: [] }), "pass");
  });

  test("subagent-model denies a modelless spawn once agent-orchestration is enabled", () => {
    eq(decide(subagentModel, { toolName: "Agent", input: {}, modules: [MODULE_ID] }), "deny");
  });

  test("reasoning-effort-floor stays silent when agent-orchestration is not enabled, even for a low-effort spawn", () => {
    eq(decide(reasoningEffortFloor, { toolName: "Agent", input: { effort: "low" }, modules: [] }), "pass");
  });

  test("reasoning-effort-floor denies a low-effort spawn once agent-orchestration is enabled", () => {
    eq(decide(reasoningEffortFloor, { toolName: "Agent", input: { effort: "low" }, modules: [MODULE_ID] }), "deny");
  });

  /* --------------------------------------------------------- seed settings */

  test("seed (Claude): an absent model key gets the module's default written", () => {
    eq(sj.planSeedKey({}, "/model").action, "write");
  });

  test("seed (Claude): a developer's own model choice is never overwritten", () => {
    const info = sj.planSeedKey({ model: "haiku" }, "/model");
    eq(info.present, true);
    eq(info.action, "keep");
  });

  test("seed (Codex): an absent key gets the module's declared value inserted", () => {
    const settingEntry = mod.json.settings.find((s) => s.agent === "codex" && s.pointer === "/model_reasoning_effort");
    const info = st.planSeedKey("", settingEntry.pointer);
    eq(info.confident, true);
    eq(info.action, "write");
  });

  test("seed (Codex): a developer's own top-level key is left alone", () => {
    const info = st.planSeedKey('model = "custom-model"\n', "/model");
    eq(info.present, true);
    eq(info.action, "keep");
  });

  test("seed (Codex): a developer's own value inside a section is left alone", () => {
    const info = st.planSeedKey('[agents]\ndefault_subagent_model = "my-own-choice"\n', "/agents/default_subagent_model");
    eq(info.present, true);
    eq(info.action, "keep");
  });

  /* --------------------------------------------------- end-to-end (Codex) */

  test("enabling seeds every declared default only where the developer has none, end to end", () => {
    fakeHome();
    const codexHome = paths.agentHome("codex");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "custom-model"\n# a developer comment, must survive verbatim\n');

    runInstall("codex", [MODULE_ID]);

    const toml = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    ok(toml.includes('model = "custom-model"'), "the pre-existing model must not be overwritten");
    ok(toml.includes("a developer comment"), "the developer's own comment must survive verbatim");
    ok(toml.includes('model_reasoning_effort = "high"'), "the absent reasoning-effort key must be seeded");
    ok(toml.includes('default_subagent_reasoning_effort = "medium"'), "the subagent effort floor must be seeded");
    ok(toml.includes('approval_policy = "on-request"'), "the absent approval policy must be seeded");
    ok(toml.includes('approvals_reviewer = "auto_review"'), "the absent approvals reviewer must be seeded");
    ok(!toml.includes("sandbox_mode"), "sandbox_mode must never be written");

    // The two flags without which delegation on Codex is either unavailable
    // or untierable — both measured against the real binary.
    ok(toml.includes("multi_agent_v2 = true"), `features.multi_agent_v2 must be seeded, got:\n${toml}`);
    ok(
      toml.includes("expose_spawn_agent_model_overrides = true"),
      `the per-spawn model override must be seeded, got:\n${toml}`,
    );

    // Keys that do not exist on the host must never appear.
    ok(!toml.includes("per_spawn_model_override ="), "an invented feature flag must never be written");
    ok(!toml.includes("[agents]"), "nothing may be written into a section Codex does not have");
  });

  test("disabling deactivates both guards but leaves every seed setting exactly as it is", () => {
    fakeHome();
    const codexHome = paths.agentHome("codex");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "config.toml"), "");

    runInstall("codex", [MODULE_ID]);
    const seeded = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    ok(seeded.includes('model = "gpt-5.6-sol"'));

    const { applied } = runInstall("codex", []);
    ok(!applied.manifest.modules.includes(MODULE_ID), "the module should no longer be recorded as enabled");
    const afterDisable = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    eq(afterDisable, seeded, "seed settings are the developer's own now — disabling must not touch them");

    eq(decide(subagentModel, { toolName: "Agent", input: {}, modules: [] }), "pass");
    eq(decide(reasoningEffortFloor, { toolName: "Agent", input: { effort: "low" }, modules: [] }), "pass");
  });

  /* ---------------------------------------- enable/disable: files & hooks */

  test("enabling then disabling removes the module's own copied files, leaving the rest of the home as it was", () => {
    fakeHome();
    runInstall("codex", []);
    const baseline = snapshotAgentHome("codex");

    runInstall("codex", [MODULE_ID]);
    const enabled = snapshotAgentHome("codex");
    ok(
      Object.keys(enabled.files).some((f) => f.includes(`modules/${MODULE_ID}/module.json`)),
      "the module's own copy should be installed while enabled",
    );

    runInstall("codex", []);
    const after = snapshotAgentHome("codex");
    ok(
      !Object.keys(after.files).some((f) => f.includes(`modules/${MODULE_ID}/prompt.md`)),
      "the module's own runtime files should be gone once disabled",
    );
    ok(
      Object.keys(after.files).some((f) => f.includes(`modules/${MODULE_ID}/module.json`)),
      "catalogue metadata (module.json/README.md) stays shipped even while disabled, so the module remains " +
        "discoverable by `module list`/`module enable` without the source repository (INSTALLER.md I6)",
    );
    deepEq(after.files, baseline.files);
    // config.toml is not part of hooks.json/AGENTS.md and carries the seed
    // settings this module intentionally leaves behind on disable — settings
    // (hooks.json) and the prompt block are the parts genuinely owned by
    // enable/disable, and both fully revert.
    deepEq(after.settingsHooks, baseline.settingsHooks);
    eq(after.globalInstructions, baseline.globalInstructions);
  });
});
