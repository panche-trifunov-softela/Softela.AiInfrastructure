"use strict";

/**
 * Cross-cutting stack-scoping behaviour (CONTRACTS.md §8a), exercised
 * against real, shipped rule modules rather than a fake — `tests/lib/`
 * already proves `resolveStack` and the preset merge as pure functions in
 * isolation; this suite proves the wiring actually reaches a rule.
 */

const { suite } = require("../harness");
const { evaluate, applicableRules } = require("../../core/engine");
const { PROJECT, PROJECT_BACKEND, decide, makeCtx } = require("./_ctx");
const componentFolderShape = require("../../core/guards/component-folder-shape");
const patchManifest = require("../../core/guards/patch-manifest");
const reuseBeforeNew = require("../../core/guards/reuse-before-new");
const namingStandards = require("../../core/guards/naming-standards");
const branchNaming = require("../../core/guards/branch-naming");

/** A new component export, badly placed — component-folder-shape's own positive case. */
const MISPLACED_COMPONENT = { toolName: "Write", filePath: "src/components/Button.tsx" };

suite("guards: stack scoping end to end", ({ test, eq }) => {
  /* --------------------------------------- a frontend rule off its stack */

  test("a frontend-scoped rule fires on the frontend stack", () => {
    eq(decide(componentFolderShape, { ...MISPLACED_COMPONENT, project: PROJECT }), "deny");
  });

  test("a frontend-scoped rule is silent on the backend stack, even with the same triggering shape", () => {
    eq(decide(componentFolderShape, { ...MISPLACED_COMPONENT, project: PROJECT_BACKEND }), "pass");
  });

  /* ---------------------------------------- a backend rule off its stack */

  const DECLARED_CHANGE_NO_ENTRY = {
    toolName: "Write",
    filePath: "deploy/patch.manifest.xml",
    content: '<Database table="Orders"><Comment>no script</Comment></Database>',
  };

  test("a backend-scoped rule fires on the backend stack", () => {
    eq(decide(patchManifest, { ...DECLARED_CHANGE_NO_ENTRY, project: PROJECT_BACKEND }), "deny");
  });

  test("a backend-scoped rule is silent on the frontend stack, even fully configured", () => {
    eq(
      decide(patchManifest, {
        ...DECLARED_CHANGE_NO_ENTRY,
        project: { ...PROJECT, patchManifest: PROJECT_BACKEND.patchManifest },
      }),
      "pass",
    );
  });

  /* --------------------------------------------------- a stack-agnostic rule */

  test("a stack-agnostic rule is a live candidate on the frontend stack", () => {
    const ctx = makeCtx({
      toolName: "Write",
      filePath: "src/newHelper.ts",
      content: "export function newHelper() { return 1; }",
      project: PROJECT,
    });
    const candidates = applicableRules(ctx, { rules: [reuseBeforeNew] });
    eq(candidates.length, 1, "reuse-before-new declares no stacks field and must never be excluded by stack alone");
  });

  test("a stack-agnostic rule is a live candidate on the backend stack too", () => {
    const ctx = makeCtx({
      toolName: "Write",
      filePath: "src/NewHelper.cs",
      content: "public class NewHelper {}",
      project: PROJECT_BACKEND,
    });
    const candidates = applicableRules(ctx, { rules: [reuseBeforeNew] });
    eq(candidates.length, 1, "reuse-before-new declares no stacks field and must never be excluded by stack alone");
  });

  /* --------------------------------------------------------- non-file case */

  test("a frontend-scoped rule never fires on a shell command, whatever the project's stack", () => {
    eq(decide(componentFolderShape, { toolName: "Bash", command: "git status", project: PROJECT }), "pass");
  });

  test("a stack-agnostic git rule still fires on a shell command under a frontend project", () => {
    eq(decide(branchNaming, { command: "git checkout -b whatever", project: PROJECT }), "ask");
  });

  test("a stack-agnostic git rule still fires on a shell command under a backend project", () => {
    eq(decide(branchNaming, { command: "git checkout -b whatever", project: PROJECT_BACKEND }), "ask");
  });

  /* -------------------------------------------------------------- monorepo */

  const MONOREPO_STACKS = [
    { paths: ["src/Web/ClientApp/**"], stack: "frontend" },
    { paths: ["src/Server/**"], stack: "backend" },
  ];

  test("a monorepo frontend path fires the frontend rule", () => {
    eq(
      decide(componentFolderShape, {
        toolName: "Write",
        filePath: "src/Web/ClientApp/src/components/Button.tsx",
        project: { conventions: { componentFolders: "src/Web/ClientApp/src/components/**" }, stacks: MONOREPO_STACKS },
      }),
      "deny",
    );
  });

  test("a monorepo backend path does not fire the frontend rule", () => {
    eq(
      decide(componentFolderShape, {
        toolName: "Write",
        filePath: "src/Server/Widgets/Widget.tsx",
        project: { conventions: { componentFolders: "src/Server/**" }, stacks: MONOREPO_STACKS },
      }),
      "pass",
    );
  });

  test("a monorepo path matching no declared stack entry does not fire the frontend rule", () => {
    eq(
      decide(componentFolderShape, {
        toolName: "Write",
        filePath: "docs/components/Button.tsx",
        project: { conventions: { componentFolders: "docs/components/**" }, stacks: MONOREPO_STACKS },
      }),
      "pass",
    );
  });

  /* --------------------------------------------- preset merge, real registry */

  test("a backend project declaring only its stack still satisfies naming-standards from the backend preset", () => {
    const ctx = Object.freeze({
      event: "PreToolUse",
      agent: "claude",
      toolName: "Write",
      input: {},
      command: "",
      filePath: "/repo/Widgets/Something.cs",
      content: "public interface Something {}\n",
      cwd: "/repo",
      project: { id: "Test.Backend.Preset", stack: "backend" },
      git: { repoRoot: "/repo", branch: "dev", remote: null, base: "dev", rebaseInProgress: false, staged: () => [] },
      session: { model: "sonnet", effort: "high" },
      modules: new Set(),
      overrides: { forRule: () => ({ action: undefined, allow: [], reason: "" }), invalid: [], raw: {} },
      raw: {},
      readFile: () => null,
    });

    const result = evaluate(ctx, { rules: [namingStandards] });
    eq(result && result.ruleId, "naming-standards");
    eq(result && result.action, "deny");
  });

  test("the same project with no stack at all gets no language from anywhere and stays silent", () => {
    const ctx = Object.freeze({
      event: "PreToolUse",
      agent: "claude",
      toolName: "Write",
      input: {},
      command: "",
      filePath: "/repo/Widgets/Something.cs",
      content: "public interface Something {}\n",
      cwd: "/repo",
      project: { id: "Test.NoStack" },
      git: { repoRoot: "/repo", branch: "dev", remote: null, base: "dev", rebaseInProgress: false, staged: () => [] },
      session: { model: "sonnet", effort: "high" },
      modules: new Set(),
      overrides: { forRule: () => ({ action: undefined, allow: [], reason: "" }), invalid: [], raw: {} },
      raw: {},
      readFile: () => null,
    });

    const result = evaluate(ctx, { rules: [namingStandards] });
    eq(result, null);
  });
});
