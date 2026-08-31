"use strict";

const path = require("path");
const rule = require("../../core/guards/colocated-tests");
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

suite("guards/colocated-tests", ({ test, eq }) => {
  // --- field test: the real regression, against the real shipped config ---

  test("the field-regression test path denies against the real, disk-loaded Softela.ReactSCExpert.json", () => {
    eq(
      decideReal(rule, REAL_REACT_SCEXPERT_PROJECT, {
        toolName: "Write",
        filePath: "src/components/layout/ScreenSummaryChip.test.tsx",
      }),
      "deny",
    );
  });

  test("the field-regression denial names the real subject in the fix", () => {
    const result = evaluate(
      realProjectCtx(REAL_REACT_SCEXPERT_PROJECT, {
        toolName: "Write",
        filePath: "src/components/layout/ScreenSummaryChip.test.tsx",
      }),
      { rules: [rule] },
    );
    eq(result.action, "deny");
    eq(result.fix.includes("ScreenSummaryChip/__tests__/ScreenSummaryChip.test.tsx"), true);
  });

  // --- positive: genuinely misplaced ---------------------------------------

  test("a test file in a distant test tree denies", () => {
    eq(decide(rule, { toolName: "Write", filePath: "tests/components/Button.test.tsx" }), "deny");
  });

  test("a nested child's test sitting in the parent's __tests__ folder denies", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/components/Button/__tests__/SubPart.test.tsx" }), "deny");
  });

  test("a test colocated directly beside the component, with no __tests__ folder, denies", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/components/Button/Button.test.tsx" }), "deny");
  });

  // --- negative: ordinary, correctly placed or out-of-scope work ----------

  test("a correctly placed component test passes", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/components/Button/__tests__/Button.test.tsx" }), "pass");
  });

  test("a correctly placed nested child component test passes", () => {
    eq(
      decide(rule, { toolName: "Write", filePath: "src/components/Button/SubPart/__tests__/SubPart.test.tsx" }),
      "pass",
    );
  });

  test("a correctly placed test three levels of nesting deep passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/SubPart/DeepChild/__tests__/DeepChild.test.tsx",
      }),
      "pass",
    );
  });

  test("an ordinary non-test source file passes", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/components/Button/Button.tsx" }), "pass");
  });

  test("a cypress spec is excluded via notOurs", () => {
    eq(decide(rule, { toolName: "Write", filePath: "cypress/e2e/login.spec.ts" }), "pass");
  });

  test("silent when the project declares no testFolder convention", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "tests/components/Button.test.tsx",
        project: PROJECT_MINIMAL,
      }),
      "pass",
    );
  });

  // --- evasion -------------------------------------------------------------

  test("the .spec. spelling variant misplaced outside __tests__ still denies", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/components/Button/Button.spec.tsx" }), "deny");
  });

  // --- qualified test names (.integration., .a11y., .snapshot., ...) -------

  test("a correctly placed qualified test name passes", () => {
    eq(
      decide(rule, { toolName: "Write", filePath: "src/components/Button/__tests__/Button.integration.test.tsx" }),
      "pass",
    );
  });

  test("a correctly placed .a11y. qualified test name passes", () => {
    eq(
      decide(rule, { toolName: "Write", filePath: "src/components/Button/__tests__/Button.a11y.test.tsx" }),
      "pass",
    );
  });

  test("a correctly placed .spec. spelling passes, mirroring the .test. shape", () => {
    eq(
      decide(rule, { toolName: "Write", filePath: "src/components/Button/__tests__/Button.spec.tsx" }),
      "pass",
    );
  });

  test("a misplaced qualified test name still denies, naming the real subject in the fix", () => {
    const result = decision(rule, {
      toolName: "Write",
      filePath: "src/components/Button/Button.snapshot.test.tsx",
    });
    eq(result.action, "deny");
    eq(result.fix.includes("Button/"), true);
  });

  test("a different write tool creating the same misplaced test still denies", () => {
    eq(decide(rule, { toolName: "NotebookEdit", filePath: "tests/Button.test.tsx" }), "deny");
  });

  // --- repo-root resolution: case, separators and prefix boundaries -------

  test("matching root and file path spelling still denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:/repo/src/components/Button/Button.test.tsx",
        git: { repoRoot: "C:/repo" },
      }),
      "deny",
    );
  });

  test("a repo root and file path differing only in drive-letter case still denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "c:/repo/src/components/Button/Button.test.tsx",
        git: { repoRoot: "C:/repo" },
      }),
      "deny",
    );
  });

  test("a backslash-spelled file path against a forward-slash root still denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:\\repo\\src\\components\\Button\\Button.test.tsx",
        git: { repoRoot: "C:/repo" },
      }),
      "deny",
    );
  });

  test("a file genuinely outside the configured folder is excluded via notOurs and passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:/repo/cypress/e2e/login.spec.ts",
        git: { repoRoot: "C:/repo" },
      }),
      "pass",
    );
  });

  test("a path that merely resembles the root as a prefix of a longer directory name still evaluates the real trailing structure and passes when correctly placed", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:/repo-other/src/components/Button/__tests__/Button.test.tsx",
        git: { repoRoot: "C:/repo" },
      }),
      "pass",
    );
  });

  test("an unknown repository root still evaluates the real trailing structure and passes when correctly placed", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:/other/src/components/Button/__tests__/Button.test.tsx",
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
        filePath: "tests/components/Button.test.tsx",
        overrideSpec: { "colocated-tests": { action: "off" } },
      }),
      "pass",
    );
  });

  test("an override can soften the denial to ask", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "tests/components/Button.test.tsx",
        overrideSpec: { "colocated-tests": { action: "ask" } },
      }),
      "ask",
    );
  });
});
