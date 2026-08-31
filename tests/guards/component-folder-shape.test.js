"use strict";

const path = require("path");
const rule = require("../../core/guards/component-folder-shape");
const { evaluate } = require("../../core/engine");
const { readJson } = require("../../core/lib/fs-safe");
const { suite } = require("../harness");
const { PROJECT_MINIMAL, decide, decision, makeGit, makeOverrides } = require("./_ctx");

/**
 * The real, shipped `Softela.ReactSCExpert.json` — loaded from disk, not a
 * hand-written fixture, so the field-test case below exercises exactly the
 * config a real session resolves, `conventions` included only through the
 * engine's own frontend-stack preset merge.
 */
const REAL_REACT_SCEXPERT_PROJECT = readJson(
  path.join(__dirname, "..", "..", "projects", "Softela.ReactSCExpert.json"),
);

/**
 * Builds a context around a project object exactly as given — no merge onto
 * the hand-written `PROJECT` fixture `_ctx.js#makeCtx` always applies — so a
 * real project file's `stack` field drives the engine's own preset
 * resolution instead of a fixture's pre-baked `conventions`.
 *
 * @param {object} project The project config to evaluate against.
 * @param {object} partial Context fields for this case.
 * @returns {object} A frozen context.
 */
function realProjectCtx(project, partial) {
  return Object.freeze({
    event: "PreToolUse",
    agent: "claude",
    toolName: partial.toolName || "Write",
    input: {},
    command: "",
    filePath: partial.filePath || "",
    content: partial.content || "",
    cwd: "/repo",
    project,
    git: makeGit(partial.git),
    session: { model: "sonnet", effort: "high" },
    modules: new Set(),
    overrides: makeOverrides({}),
    raw: {},
    readFile: () => null,
  });
}

/**
 * Runs the rule against a real, disk-loaded project config.
 *
 * @param {object} testRule The rule module under test.
 * @param {object} project The project config to evaluate against.
 * @param {object} partial Context fields for this case.
 * @returns {string} `"deny"`, `"ask"` or `"pass"`.
 */
function decideReal(testRule, project, partial) {
  const result = evaluate(realProjectCtx(project, partial), { rules: [testRule] });
  return result ? result.action : "pass";
}

suite("guards/component-folder-shape", ({ test, eq }) => {
  // --- field test: the real regression, against the real shipped config ---

  test("the field-regression path denies against the real, disk-loaded Softela.ReactSCExpert.json", () => {
    eq(
      decideReal(rule, REAL_REACT_SCEXPERT_PROJECT, {
        toolName: "Write",
        filePath: "src/components/layout/ScreenSummaryChip.tsx",
      }),
      "deny",
    );
  });

  test("the field-regression denial names the corrected folder-and-index shape", () => {
    const result = evaluate(
      realProjectCtx(REAL_REACT_SCEXPERT_PROJECT, {
        toolName: "Write",
        filePath: "src/components/layout/ScreenSummaryChip.tsx",
      }),
      { rules: [rule] },
    );
    eq(result.action, "deny");
    eq(result.fix.includes("src/components/layout/ScreenSummaryChip/ScreenSummaryChip.tsx"), true);
    eq(result.fix.includes("index"), true);
  });

  // --- positive: the shape is genuinely broken ---------------------------

  test("new component file dropped straight into the shared root denies", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/components/Button.tsx" }), "deny");
  });

  test("new component file inside a wrongly-named subfolder denies", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/components/button/Button.tsx" }), "deny");
  });

  test("the denial names the concrete corrected path", () => {
    const result = decision(rule, { toolName: "Write", filePath: "src/components/Button.tsx" });
    eq(result.action, "deny");
    eq(result.fix, 'Move it to "src/components/Button/Button.tsx", with an "index.tsx" barrel beside it.');
  });

  // --- negative: ordinary, correctly shaped or out-of-scope work ---------

  test("a correctly shaped new component file passes", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/components/Button/Button.tsx" }), "pass");
  });

  test("editing an existing file that already breaks the shape is not relitigated", () => {
    eq(
      decide(rule, {
        toolName: "Edit",
        filePath: "src/components/Button.tsx",
        files: { "src/components/Button.tsx": "export const Button = () => null;\n" },
      }),
      "pass",
    );
  });

  test("a sibling file sharing the component's own base name passes", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/components/Button/Button.stories.tsx" }), "pass");
  });

  test("a new index.tsx beside the component passes", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/components/Button/index.tsx" }), "pass");
  });

  test("a new test file inside __tests__ is left to the colocated-tests rule", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/components/Button/__tests__/Button.test.tsx" }), "pass");
  });

  test("a file outside the componentFolders convention passes", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/services/api/foo.tsx" }), "pass");
  });

  test("a new .ts helper file is out of scope, only .tsx/.jsx are checked", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/components/utils.ts" }), "pass");
  });

  test("silent when the project declares no componentFolders convention", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button.tsx",
        project: PROJECT_MINIMAL,
      }),
      "pass",
    );
  });

  // --- evasion -------------------------------------------------------------

  test("a different write tool creating the same badly placed file still denies", () => {
    eq(decide(rule, { toolName: "apply_patch", filePath: "src/components/Card.tsx" }), "deny");
  });

  test("backslash-separated Windows-style path still denies after normalisation", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src\\components\\Card.tsx" }), "deny");
  });

  // --- repo-root resolution: case, separators and prefix boundaries -------

  test("matching root and file path spelling still denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:/repo/src/components/Button.tsx",
        git: { repoRoot: "C:/repo" },
      }),
      "deny",
    );
  });

  test("a repo root and file path differing only in drive-letter case still denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "c:/repo/src/components/Button.tsx",
        git: { repoRoot: "C:/repo" },
      }),
      "deny",
    );
  });

  test("a backslash-spelled file path against a forward-slash root still denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:\\repo\\src\\components\\Button.tsx",
        git: { repoRoot: "C:/repo" },
      }),
      "deny",
    );
  });

  test("a file genuinely outside the configured folder passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:/repo/src/services/api/foo.tsx",
        git: { repoRoot: "C:/repo" },
      }),
      "pass",
    );
  });

  test("a path that merely resembles the root as a prefix of a longer directory name passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:/repo-other/src/components/Button.tsx",
        git: { repoRoot: "C:/repo" },
      }),
      "pass",
    );
  });

  test("an unknown repository root leaves an unresolvable absolute path alone and passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:/other/src/components/Button.tsx",
        git: { repoRoot: null },
      }),
      "pass",
    );
  });

  // --- override --------------------------------------------------------------

  test("an override can turn the rule off entirely", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button.tsx",
        overrideSpec: { "component-folder-shape": { action: "off" } },
      }),
      "pass",
    );
  });

  test("an override can soften the denial to ask", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button.tsx",
        overrideSpec: { "component-folder-shape": { action: "ask" } },
      }),
      "ask",
    );
  });
});
