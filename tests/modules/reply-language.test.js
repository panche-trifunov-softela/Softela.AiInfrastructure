"use strict";

const { suite } = require("../harness");
const { loadModule, validateModuleJson, renderPrompt, unsubstitutedTokens, runInstall, snapshotAgentHome } = require("./_helpers");

const MODULE_ID = "reply-language";

/** The categories the carve-out must name for every configured language, per MODULES.md. */
const CARVE_OUT_CATEGORIES = ["code", "comments", "documentation", "commit messages", "test names", "CLI"];

/** Language configurations to exercise, well beyond the single default case. */
const LANGUAGE_CASES = [["English"], ["German"], ["French", "English"], ["Hebrew", "Spanish", "English"]];

suite("modules/reply-language", ({ test, eq, deepEq, ok, fakeHome }) => {
  const mod = loadModule(MODULE_ID);

  test("module.json validates against the shape MODULES.md documents", () => {
    deepEq(validateModuleJson(mod), []);
  });

  test("declares languages as an ordered string list, defaulting to English", () => {
    eq(mod.json.options.languages.type, "stringList");
    deepEq(mod.json.options.languages.default, ["English"]);
  });

  test("defaults off, per MODULES.md", () => {
    eq(mod.json.defaultEnabled, false);
  });

  test("ships no guard — there is no tool call whose input tells a guard which language a reply used", () => {
    eq(mod.json.guards.length, 0);
  });

  for (const languages of LANGUAGE_CASES) {
    test(`renders cleanly and uses the configured order for [${languages.join(", ")}]`, () => {
      const rendered = renderPrompt(mod, { languages });
      deepEq(unsubstitutedTokens(rendered), []);
      ok(rendered.includes(languages.join(", ")), "the configured, comma-joined language order must appear");
    });

    test(`states the English-only carve-out for every category, for [${languages.join(", ")}]`, () => {
      const rendered = renderPrompt(mod, { languages });
      for (const category of CARVE_OUT_CATEGORIES) {
        ok(rendered.includes(category), `carve-out must name "${category}" when languages = [${languages.join(", ")}]`);
      }
      ok(rendered.includes("stays English"), "must say the excluded categories stay English");
    });
  }

  test("the carve-out is unconditional even when English is itself the configured language", () => {
    const rendered = renderPrompt(mod, { languages: ["English"] });
    ok(
      rendered.includes("is wrong even when") && rendered.includes("never satisfied by"),
      "the block must rule out reading the carve-out as already satisfied by choosing English",
    );
  });

  /* ------------------------------------------- enable/disable round trip */

  test("enabling then disabling leaves the agent home exactly as it was", () => {
    fakeHome();
    runInstall("codex", []);
    const baseline = snapshotAgentHome("codex");

    runInstall("codex", [MODULE_ID], { options: { [MODULE_ID]: { languages: ["German", "English"] } } });
    const enabled = snapshotAgentHome("codex");
    ok(enabled.globalInstructions.includes("German, English"), "the configured language order should render into the block");
    for (const category of CARVE_OUT_CATEGORIES) {
      ok(enabled.globalInstructions.includes(category), `installed block must carry the "${category}" carve-out`);
    }

    runInstall("codex", []);
    const after = snapshotAgentHome("codex");
    deepEq(after.files, baseline.files);
    deepEq(after.settingsHooks, baseline.settingsHooks);
    eq(after.globalInstructions, baseline.globalInstructions);
  });
});
