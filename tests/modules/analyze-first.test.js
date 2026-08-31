"use strict";

const path = require("path");
const { suite } = require("../harness");
const { readText } = require("../../core/lib/fs-safe");
const { loadModule, validateModuleJson, runInstall, snapshotAgentHome, paths } = require("./_helpers");

const MODULE_ID = "analyze-first";

suite("modules/analyze-first", ({ test, eq, deepEq, ok, fakeHome }) => {
  const mod = loadModule(MODULE_ID);

  test("module.json validates against the shape MODULES.md documents", () => {
    deepEq(validateModuleJson(mod), []);
  });

  test("this module owns nothing of its own: no guard, no shipped files, no hooks, no settings, no options, and no prompt.md — it only gates a section of the base rulebook", () => {
    eq(mod.json.prompt, undefined);
    eq(mod.json.guards.length, 0);
    eq(mod.json.files.length, 0);
    eq(mod.json.hooks.length, 0);
    eq(mod.json.settings.length, 0);
    deepEq(mod.json.options, {});
  });

  test("defaults on, per MODULES.md", () => {
    eq(mod.json.defaultEnabled, true);
  });

  test("enabling then disabling leaves the agent home exactly as it was", () => {
    fakeHome();
    runInstall("codex", []);
    const baseline = snapshotAgentHome("codex");

    runInstall("codex", [MODULE_ID]);
    const enabled = snapshotAgentHome("codex");
    ok(enabled.globalInstructions.includes("## Analyse first, then wait"), "the rulebook's own section should appear once enabled");
    ok(
      Object.keys(enabled.files).some((f) => f.includes(`modules/${MODULE_ID}/`)),
      "the module's own catalogue copy (module.json/README.md) should be installed",
    );

    runInstall("codex", []);
    const after = snapshotAgentHome("codex");
    deepEq(after.files, baseline.files);
    deepEq(after.settingsHooks, baseline.settingsHooks);
    eq(after.globalInstructions, baseline.globalInstructions);
  });

  test("disabling this module removes only its own rulebook section — the rest of the base rulebook, which every install always carries, stays in place", () => {
    fakeHome();
    const claudeMdPath = path.join(paths.agentHome("claude"), "CLAUDE.md");

    runInstall("claude", [MODULE_ID]);
    const enabled = readText(claudeMdPath);
    ok(enabled && enabled.includes("## Analyse first, then wait"), "the section should be written once enabled");
    ok(enabled.includes("BEGIN softela-ai"), "the managed markers should be present while the rulebook contributes text");

    runInstall("claude", []);
    const disabled = readText(claudeMdPath);
    // The base rulebook (`core/installer/rulebook.js`) is generated fresh at
    // plan time on every install, independent of which modules are
    // enabled — its "Authority hierarchy", "Reuse before writing anything
    // new", "What is mechanically enforced" and "Concrete facts" sections
    // always contribute text, so disabling the only module that used to be
    // the sole contributor no longer empties the block.
    ok(disabled && disabled.includes("BEGIN softela-ai"), "the base rulebook still contributes instructions, so the managed block must remain");
    ok(!disabled.includes("Analyse first, then wait"), "the disabled module's own conditional section must not survive in CLAUDE.md");
  });
});
