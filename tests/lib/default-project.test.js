"use strict";

/**
 * `projects/_default.json` — the configuration every repository nobody has
 * written a project file for actually runs under.
 *
 * The property this suite exists to hold: **no repository is unconfigured.**
 * A project file that declares only `baseBranches` and `branchNaming` leaves
 * `admittedByStack` (`core/engine.js`) with no stack to admit and the stack
 * presets with nothing to merge, so the whole `code` catalogue silently
 * declines to fire — the rules read as installed and enforce nothing. That
 * failure is invisible from the outside, which is exactly why it is asserted
 * here rather than left to a rule suite.
 *
 * Every case runs the real shipped file through the real engine surface, not
 * a fixture, so editing `_default.json` down to a stub fails this suite
 * instead of quietly disarming the catalogue.
 */

const path = require("path");
const { suite } = require("../harness");
const { readJson } = require("../../core/lib/fs-safe");
const { resolveStack } = require("../../core/lib/stack-resolver");
const { applicableRules } = require("../../core/engine");
const { rules } = require("../../core/guards");

const REPO_ROOT = path.join(__dirname, "..", "..");
const PRESETS_DIR = path.join(REPO_ROOT, "projects", "_presets");
const DEFAULT_PROJECT = readJson(path.join(REPO_ROOT, "projects", "_default.json"));

/** The repository root every fixture path in this suite is relativised against. */
const REPO = "C:/work/SomeUnconfiguredRepo";

/**
 * Builds a context shaped like the one `core/lib/context.js` produces for a
 * write into a repository with no project file of its own.
 *
 * @param {string} relativePath The path being written, relative to {@link REPO}.
 * @param {object} [extra] Fields merged over the base context.
 * @returns {object} The context.
 */
function writeCtx(relativePath, extra = {}) {
  return {
    event: "PreToolUse",
    agent: "claude",
    toolName: "Write",
    input: {},
    command: "",
    filePath: `${REPO}/${relativePath}`,
    content: "",
    cwd: REPO,
    project: DEFAULT_PROJECT,
    git: { repoRoot: REPO, branch: "feature/task_00000_x", remote: null, base: "dev", rebaseInProgress: false, staged: () => [] },
    session: { model: null, effort: null },
    modules: new Set(rules.map((r) => r.requiresModule).filter(Boolean)),
    overrides: { forRule: () => ({ action: undefined, allow: [], reason: undefined }), invalid: [], raw: null },
    raw: {},
    readFile: () => null,
    ...extra,
  };
}

/**
 * Lists the ids of every rule the engine would run for a context, judged
 * against the real shipped stack presets.
 *
 * @param {object} ctx The evaluation context.
 * @returns {string[]} The candidate rule ids, in registry order.
 */
function candidateIds(ctx) {
  return applicableRules(ctx, { presetsDir: PRESETS_DIR }).map((r) => r.id);
}

suite("projects/_default.json is not an empty configuration", ({ test, eq, ok }) => {
  /* ------------------------------------------------------- stack routing */

  test("a TypeScript file resolves to the frontend stack", () => {
    eq(resolveStack(writeCtx("src/components/Widget/index.ts")), "frontend");
  });

  test("a file at the repository root resolves too, not only a nested one", () => {
    eq(resolveStack(writeCtx("vite.config.ts")), "frontend");
  });

  test("a C# file resolves to the backend stack", () => {
    eq(resolveStack(writeCtx("src/Api/OrderController.cs")), "backend");
  });

  test("an extension belonging to neither stack resolves to no stack, never a guess", () => {
    eq(resolveStack(writeCtx("README.md")), null);
    eq(resolveStack(writeCtx("deploy/pipeline.yml")), null);
  });

  /* --------------------------------------- the stack preset actually lands */

  test("a frontend write admits the frontend-only code rules through the preset's conventions", () => {
    const ids = candidateIds(writeCtx("src/components/Widget/index.ts"));
    for (const id of ["barrel-exports-only", "component-folder-shape", "api-import-boundary", "no-explicit-any"]) {
      ok(ids.includes(id), `${id} must be a candidate in an unconfigured repository, got: ${ids.join(", ")}`);
    }
  });

  test("a backend write admits the backend rules and none of the frontend-only ones", () => {
    const ids = candidateIds(writeCtx("src/Api/OrderController.cs"));
    ok(ids.includes("naming-standards"), `naming-standards missing, got: ${ids.join(", ")}`);
    eq(ids.includes("barrel-exports-only"), false, "a frontend-only rule must not reach a C# file");
    eq(ids.includes("no-explicit-any"), false, "a frontend-only rule must not reach a C# file");
  });

  test("the file-size limit reaches an unconfigured repository", () => {
    ok(candidateIds(writeCtx("src/pages/Big.tsx")).includes("file-size-limit"));
  });

  /* ------------------------------------------------- the stack-free rules */

  test("branch naming is configured, so its rule is a candidate for a shell call", () => {
    const ids = candidateIds(writeCtx("x.ts", { toolName: "Bash", filePath: "", command: "git status" }));
    ok(ids.includes("branch-naming"), `got: ${ids.join(", ")}`);
  });

  test("credential-bearing paths are protected by default", () => {
    ok(candidateIds(writeCtx(".env")).includes("protected-paths"));
  });

  test("local-config isolation reaches an unconfigured repository", () => {
    ok(candidateIds(writeCtx("public/config.js")).includes("local-config-isolation"));
  });

  /* -------------------------------------------------- shape of the file itself */

  test("the shipped file declares the keys the assertions above depend on", () => {
    ok(Array.isArray(DEFAULT_PROJECT.stacks) && DEFAULT_PROJECT.stacks.length >= 2);
    ok(Array.isArray(DEFAULT_PROJECT.protectedPaths) && DEFAULT_PROJECT.protectedPaths.length > 0);
    ok(Array.isArray(DEFAULT_PROJECT.baseBranches) && DEFAULT_PROJECT.baseBranches.length > 0);
    ok(Boolean(DEFAULT_PROJECT.branchNaming && DEFAULT_PROJECT.branchNaming.pattern));
    ok(Array.isArray(DEFAULT_PROJECT.localConfig) && DEFAULT_PROJECT.localConfig.length > 0);
    ok(
      DEFAULT_PROJECT.localConfig.some((entry) => typeof entry.tracked === "string" && typeof entry.perMachine === "string"),
      "a localConfig entry must carry both tracked and perMachine",
    );
  });
});
