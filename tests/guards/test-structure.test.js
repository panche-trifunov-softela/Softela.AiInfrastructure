"use strict";

/**
 * Table-driven suite for `test-structure`.
 */

const { suite } = require("../harness");
const { PROJECT, PROJECT_BACKEND, decide } = require("./_ctx");
const rule = require("../../core/guards/test-structure");

const NO_SHAPE = [
  "it('does the thing', () => {",
  "  const svc = new Service();",
  "  expect(svc.run()).toBe(1);",
  "  svc.reset();",
  "  expect(svc.run()).toBe(1);",
  "});",
].join("\n");

const BLANK_GROUPED = [
  "it('does the thing', () => {",
  "  const svc = new Service();",
  "",
  "  const result = svc.run();",
  "",
  "  expect(result).toBe(1);",
  "});",
].join("\n");

const MARKERS = [
  "it('does the thing', () => {",
  "  // Arrange",
  "  const svc = new Service();",
  "  // Act",
  "  const result = svc.run();",
  "  // Assert",
  "  expect(result).toBe(1);",
  "});",
].join("\n");

const SINGLE_ASSERTION = [
  "it('does the thing', () => {",
  "  const svc = new Service();",
  "  expect(svc.run()).toBe(1);",
  "});",
].join("\n");

/** A backend project fixture that also declares the folder-based test convention. */
const PROJECT_BACKEND_WITH_TEST_FOLDER = {
  ...PROJECT_BACKEND,
  conventions: { ...PROJECT_BACKEND.conventions, testFolder: "__tests__" },
};

const CASES = [
  // positive — fires on its own stack (backend)
  {
    label: "a backend test file with no blank grouping, no markers, and interleaved assertions denies",
    ctx: { toolName: "Write", filePath: "/repo/src/OrderService.test.cs", content: NO_SHAPE, project: PROJECT_BACKEND },
    want: "deny",
  },
  {
    label: "the same shape inside a backend testFolder path (no suffix) also denies",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/__tests__/order-service-behaviour.cs",
      content: NO_SHAPE,
      project: PROJECT_BACKEND_WITH_TEST_FOLDER,
    },
    want: "deny",
  },

  // scope — backend only (CONTRACTS.md §8a)
  {
    label: "the rule is silent on a frontend test file with exactly the same unshaped body",
    ctx: { toolName: "Write", filePath: "/repo/src/components/__tests__/Widget.test.ts", content: NO_SHAPE, project: PROJECT },
    want: "pass",
  },
  {
    label: "no file path means no stack resolves, so the rule is never a candidate",
    ctx: { toolName: "Write", filePath: "", content: NO_SHAPE, project: PROJECT_BACKEND },
    want: "pass",
  },
  {
    label: "a shell command is not a file write and passes",
    ctx: { toolName: "Bash", command: "npx vitest run" },
    want: "pass",
  },

  // negative — ordinary daily work, on the backend stack so evaluate() genuinely runs
  {
    label: "blank-line grouping is enough to pass",
    ctx: { toolName: "Write", filePath: "/repo/src/OrderService.test.cs", content: BLANK_GROUPED, project: PROJECT_BACKEND },
    want: "pass",
  },
  {
    label: "Arrange/Act/Assert markers are enough to pass",
    ctx: { toolName: "Write", filePath: "/repo/src/OrderService.test.cs", content: MARKERS, project: PROJECT_BACKEND },
    want: "pass",
  },
  {
    label: "a single assertion has nothing to interleave with and passes",
    ctx: { toolName: "Write", filePath: "/repo/src/OrderService.test.cs", content: SINGLE_ASSERTION, project: PROJECT_BACKEND },
    want: "pass",
  },
  {
    label: "empty content passes",
    ctx: { toolName: "Write", filePath: "/repo/src/OrderService.test.cs", content: "", project: PROJECT_BACKEND },
    want: "pass",
  },
  {
    label: "a non-test source file is not judged at all",
    ctx: { toolName: "Write", filePath: "/repo/src/OrderService.cs", content: NO_SHAPE, project: PROJECT_BACKEND },
    want: "pass",
  },
  {
    label: "a .cy.ts spec uses a different suffix and is not recognised as a test file",
    ctx: { toolName: "Write", filePath: "/repo/cypress/e2e/flow.cy.ts", content: NO_SHAPE, project: PROJECT_BACKEND },
    want: "pass",
  },

  // evasion
  {
    label: "a Codex-style apply_patch write is still judged",
    ctx: { toolName: "apply_patch", filePath: "/repo/src/OrderService.test.cs", content: NO_SHAPE, project: PROJECT_BACKEND },
    want: "deny",
  },
  {
    label: "a .cs test file recognised through Assert.* calls also denies",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/api/OrderService.test.cs",
      content: [
        "public void RunsOrder() {",
        "  var svc = new OrderService();",
        "  Assert.AreEqual(1, svc.Run());",
        "  svc.Reset();",
        "  Assert.AreEqual(1, svc.Run());",
        "}",
      ].join("\n"),
      project: PROJECT_BACKEND,
    },
    want: "deny",
  },

  // override
  {
    label: "an override softens the rule to off",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/OrderService.test.cs",
      content: NO_SHAPE,
      project: PROJECT_BACKEND,
      overrideSpec: { "test-structure": { action: "off" } },
    },
    want: "pass",
  },
  {
    label: "an override softens a denial to ask",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/OrderService.test.cs",
      content: NO_SHAPE,
      project: PROJECT_BACKEND,
      overrideSpec: { "test-structure": { action: "ask" } },
    },
    want: "ask",
  },

  // silent absent config
  {
    label: "without a declared testFolder, a non-suffixed backend path is not recognised as a test file",
    ctx: { toolName: "Write", filePath: "/repo/src/__tests__/order-service-behaviour.cs", content: NO_SHAPE, project: PROJECT_BACKEND },
    want: "pass",
  },
];

suite("guards/test-structure", ({ test, eq }) => {
  for (const c of CASES) {
    test(c.label, () => {
      eq(decide(rule, c.ctx), c.want, c.label);
    });
  }
});
