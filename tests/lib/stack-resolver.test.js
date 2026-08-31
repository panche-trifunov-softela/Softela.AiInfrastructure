"use strict";

const { suite } = require("../harness");
const { resolveStack } = require("../../core/lib/stack-resolver");

/**
 * Builds a minimal fake context for `resolveStack`, so this suite never
 * depends on `lib/context.js` or a real project file.
 *
 * @param {object} [fields] Overrides merged over the defaults.
 * @returns {object} A fake `ctx`.
 */
function fakeCtx(fields = {}) {
  return {
    project: {},
    filePath: "",
    git: { repoRoot: "/repo" },
    cwd: "/repo",
    ...fields,
  };
}

suite("lib/stack-resolver", ({ test, eq }) => {
  /* ---------------------------------------------- single-stack shorthand */

  test("the single-stack shorthand resolves for any file in the repository", () => {
    const ctx = fakeCtx({ project: { stack: "frontend" }, filePath: "/repo/src/components/Button.tsx" });
    eq(resolveStack(ctx), "frontend");
  });

  test("the single-stack shorthand resolves the same way for a backend project", () => {
    const ctx = fakeCtx({ project: { stack: "backend" }, filePath: "/repo/src/Server/Program.cs" });
    eq(resolveStack(ctx), "backend");
  });

  /* --------------------------------------------------------- non-file case */

  test("a shell command with no file path resolves to no stack, even under the shorthand", () => {
    const ctx = fakeCtx({ project: { stack: "frontend" }, filePath: "" });
    eq(resolveStack(ctx), null);
  });

  test("a shell command with no file path resolves to no stack under a monorepo config too", () => {
    const ctx = fakeCtx({
      project: { stacks: [{ paths: ["src/Web/**"], stack: "frontend" }] },
      filePath: "",
    });
    eq(resolveStack(ctx), null);
  });

  /* ------------------------------------------------------------ monorepo */

  test("a monorepo path resolves to the frontend entry that matches it", () => {
    const ctx = fakeCtx({
      project: {
        stacks: [
          { paths: ["src/Web/ClientApp/**"], stack: "frontend" },
          { paths: ["src/**"], stack: "backend" },
        ],
      },
      filePath: "/repo/src/Web/ClientApp/src/components/Button.tsx",
    });
    eq(resolveStack(ctx), "frontend");
  });

  test("a monorepo path resolves to the backend entry that matches it", () => {
    const ctx = fakeCtx({
      project: {
        stacks: [
          { paths: ["src/Web/ClientApp/**"], stack: "frontend" },
          { paths: ["src/**"], stack: "backend" },
        ],
      },
      filePath: "/repo/src/Server/Program.cs",
    });
    eq(resolveStack(ctx), "backend");
  });

  test("declaration order matters: the first matching entry wins", () => {
    const ctx = fakeCtx({
      project: {
        stacks: [
          { paths: ["src/Web/ClientApp/**"], stack: "frontend" },
          { paths: ["src/**"], stack: "backend" },
        ],
      },
      filePath: "/repo/src/Web/ClientApp/src/components/Button.tsx",
    });
    eq(resolveStack(ctx), "frontend", "the narrow frontend entry, listed first, must win over the broad backend one");
  });

  test("a broad glob listed before a narrow one silently swallows it — the authoring mistake this ordering allows", () => {
    const ctx = fakeCtx({
      project: {
        stacks: [
          { paths: ["src/**"], stack: "backend" },
          { paths: ["src/Web/ClientApp/**"], stack: "frontend" },
        ],
      },
      filePath: "/repo/src/Web/ClientApp/src/components/Button.tsx",
    });
    eq(resolveStack(ctx), "backend", "the broad entry matches first and wins, even though a narrower one follows");
  });

  test("a path matching no declared stack entry resolves to no stack", () => {
    const ctx = fakeCtx({
      project: { stacks: [{ paths: ["src/Web/ClientApp/**"], stack: "frontend" }] },
      filePath: "/repo/docs/README.md",
    });
    eq(resolveStack(ctx), null);
  });

  /* --------------------------------------------------------- precedence */

  test("stacks (the monorepo list) takes precedence over stack when a project declares both", () => {
    const ctx = fakeCtx({
      project: { stack: "frontend", stacks: [{ paths: ["src/Server/**"], stack: "backend" }] },
      filePath: "/repo/src/Server/Program.cs",
    });
    eq(resolveStack(ctx), "backend");
  });

  /* ------------------------------------------------------------- absence */

  test("a project with neither stack nor stacks resolves to no stack", () => {
    const ctx = fakeCtx({ project: {}, filePath: "/repo/src/components/Button.tsx" });
    eq(resolveStack(ctx), null);
  });

  test("a missing project object resolves to no stack rather than throwing", () => {
    const ctx = fakeCtx({ project: null, filePath: "/repo/src/components/Button.tsx" });
    eq(resolveStack(ctx), null);
  });

  test("backslash-separated Windows-style paths are still matched correctly", () => {
    const ctx = fakeCtx({
      project: {
        stacks: [
          { paths: ["src/Web/ClientApp/**"], stack: "frontend" },
          { paths: ["src/**"], stack: "backend" },
        ],
      },
      filePath: "C:\\repo\\src\\Web\\ClientApp\\src\\components\\Button.tsx",
      git: { repoRoot: "C:\\repo" },
    });
    eq(resolveStack(ctx), "frontend");
  });
});
