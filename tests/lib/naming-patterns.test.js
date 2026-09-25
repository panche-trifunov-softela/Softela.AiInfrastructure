"use strict";

/**
 * `core/lib/naming-patterns.js` — the naming shapes `docs/standards/naming.md`
 * defines, exercised directly rather than through a guard, so a change to a
 * shape shows up here first instead of only as a guard's own symptom.
 */

const { suite } = require("../harness");
const {
  PASCAL_CASE,
  HOOK_NAME,
  HOOK_FILE_NAME,
  CONTEXT_NAME,
  isComponentName,
  isContextName,
  isHookFileName,
} = require("../../core/lib/naming-patterns");

suite("lib/naming-patterns", ({ test, eq, ok }) => {
  test("PASCAL_CASE matches a component name", () => {
    ok(PASCAL_CASE.test("OrderPanel"));
  });

  test("PASCAL_CASE rejects camelCase and snake_case", () => {
    eq(PASCAL_CASE.test("orderPanel"), false);
    eq(PASCAL_CASE.test("order_panel"), false);
  });

  test("HOOK_NAME matches a bare hook name", () => {
    ok(HOOK_NAME.test("useOrderPersistence"));
  });

  test("HOOK_NAME rejects a name merely starting with 'use'", () => {
    eq(HOOK_NAME.test("usedFieldsPanel"), false);
    eq(HOOK_NAME.test("userProfileCard"), false);
  });

  test("CONTEXT_NAME matches a PascalCase Context suffix", () => {
    ok(CONTEXT_NAME.test("OrderPanelContext"));
  });

  test("CONTEXT_NAME rejects a plain component name", () => {
    eq(CONTEXT_NAME.test("OrderPanel"), false);
  });

  test("CONTEXT_NAME rejects a camelCase context-like name", () => {
    eq(CONTEXT_NAME.test("orderPanelContext"), false);
  });

  test("isComponentName accepts a PascalCase name", () => {
    ok(isComponentName("OrderPanel"));
  });

  test("isComponentName rejects a camelCase name", () => {
    eq(isComponentName("orderPanel"), false);
  });

  test("isComponentName rejects a non-string", () => {
    eq(isComponentName(undefined), false);
    eq(isComponentName(null), false);
    eq(isComponentName(42), false);
  });

  test("isContextName accepts a context name", () => {
    ok(isContextName("OrderPanelContext"));
  });

  test("isContextName rejects a component that is not a context", () => {
    eq(isContextName("OrderPanel"), false);
  });

  test("isContextName rejects a non-string", () => {
    eq(isContextName(undefined), false);
  });

  test("isHookFileName accepts a TypeScript hook file", () => {
    ok(isHookFileName("useOrderPersistence.ts"));
  });

  test("isHookFileName accepts a TSX hook file", () => {
    ok(isHookFileName("useOrderPersistence.tsx"));
  });

  test("isHookFileName accepts a plain-JavaScript hook file", () => {
    ok(isHookFileName("useOrderPersistence.js"));
  });

  test("isHookFileName accepts a JSX hook file", () => {
    ok(isHookFileName("useOrderPersistence.jsx"));
  });

  test("isHookFileName rejects a view file that merely starts with 'use'", () => {
    eq(isHookFileName("usedFieldsPanel.tsx"), false);
  });

  test("isHookFileName rejects an ordinary camelCase file", () => {
    eq(isHookFileName("user.js"), false);
  });

  test("isHookFileName rejects a hook name with no extension", () => {
    eq(isHookFileName("useOrderPersistence"), false);
  });

  test("isHookFileName rejects a non-string", () => {
    eq(isHookFileName(undefined), false);
  });

  test("HOOK_FILE_NAME matches every accepted extension via isHookFileName", () => {
    for (const ext of ["ts", "tsx", "js", "jsx"]) {
      ok(isHookFileName(`useOrderPersistence.${ext}`), `expected .${ext} to be accepted`);
    }
  });
});
