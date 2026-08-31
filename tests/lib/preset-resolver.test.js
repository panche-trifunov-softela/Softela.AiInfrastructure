"use strict";

const path = require("path");
const { suite } = require("../harness");
const { loadPreset, mergeProjectWithPreset } = require("../../core/lib/preset-resolver");

const REAL_PRESETS_DIR = path.join(__dirname, "..", "..", "projects", "_presets");

suite("lib/preset-resolver", ({ test, eq, deepEq, fixture }) => {
  /* ---------------------------------------------------------------- load */

  test("loads the shipped frontend preset", () => {
    const preset = loadPreset("frontend", { presetsDir: REAL_PRESETS_DIR });
    eq(preset && typeof preset === "object", true);
    eq(preset.conventions.language, "typescript");
  });

  test("loads the shipped backend preset", () => {
    const preset = loadPreset("backend", { presetsDir: REAL_PRESETS_DIR });
    eq(preset && typeof preset === "object", true);
    eq(preset.conventions.language, "csharp");
  });

  test("an unrecognised stack loads nothing", () => {
    eq(loadPreset("mobile", { presetsDir: REAL_PRESETS_DIR }), null);
  });

  test("a missing preset file loads nothing rather than throwing", () => {
    const dir = path.dirname(fixture("presets-missing/.keep", "x"));
    eq(loadPreset("frontend", { presetsDir: dir }), null);
  });

  test("a malformed preset file loads nothing rather than throwing", () => {
    const file = fixture("presets-malformed/frontend.json", "{ not valid json");
    const dir = path.dirname(file);
    eq(loadPreset("frontend", { presetsDir: dir }), null);
  });

  /* --------------------------------------------------------------- merge */

  test("a project key overrides the preset's key of the same name wholesale", () => {
    const preset = { conventions: { language: "typescript", sourceRoots: ["src"] }, limits: { fileLines: { ask: 1500 } } };
    const project = { id: "X", conventions: { language: "javascript" } };
    const merged = mergeProjectWithPreset(preset, project);
    deepEq(merged.conventions, { language: "javascript" }, "the project's conventions object replaces the preset's entirely");
    deepEq(merged.limits, { fileLines: { ask: 1500 } }, "a key the project never mentions still comes from the preset");
    eq(merged.id, "X");
  });

  test("a key only the preset declares passes through untouched", () => {
    const preset = { limits: { fileLines: { ask: 1500 } } };
    const project = { id: "X" };
    const merged = mergeProjectWithPreset(preset, project);
    deepEq(merged.limits, { fileLines: { ask: 1500 } });
  });

  test("a key only the project declares passes through untouched", () => {
    const preset = { conventions: { language: "typescript" } };
    const project = { id: "X", baseBranches: ["dev-ng"] };
    const merged = mergeProjectWithPreset(preset, project);
    deepEq(merged.baseBranches, ["dev-ng"]);
    deepEq(merged.conventions, { language: "typescript" });
  });

  test("a null preset leaves the project unchanged", () => {
    const project = { id: "X" };
    eq(mergeProjectWithPreset(null, project), project);
  });

  test("a null project is returned as-is rather than throwing", () => {
    eq(mergeProjectWithPreset({ conventions: {} }, null), null);
  });
});
