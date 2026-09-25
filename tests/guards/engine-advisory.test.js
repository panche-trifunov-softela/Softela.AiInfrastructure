"use strict";

/**
 * Covers `core/engine.js`'s final-step advisory marking for a rule whose
 * `evaluate` result itself carries `advisory` — a per-call value a rule with
 * more than one code path can set for itself (e.g. a rule such as
 * `reuse-before-new` that judges different kinds of matches with different
 * confidence), which a single static `advisoryAsk` flag on the rule module
 * cannot express.
 *
 * These live beside the other guard suites, not `tests/lib/engine.test.js`,
 * because the behaviour under test exists specifically to serve a guard,
 * even though the code being tested is the engine.
 */

const { suite } = require("../harness");
const { evaluate } = require("../../core/engine");

/**
 * Builds a minimal fake evaluation context, self-contained so this suite
 * never depends on `lib/context.js` or the real guard registry.
 *
 * @param {object} [fields] Overrides merged over the defaults.
 * @returns {object} A fake `ctx`.
 */
function fakeCtx(fields = {}) {
  return {
    event: "PreToolUse",
    toolName: "Write",
    command: "",
    filePath: "",
    modules: new Set(),
    overrides: { forRule: () => ({ action: undefined, allow: [] }) },
    ...fields,
  };
}

/**
 * Builds a minimal fake rule module.
 *
 * @param {object} fields Fields to override the defaults with; `evaluate`
 * is required.
 * @returns {object} A fake rule.
 */
function fakeRule(fields) {
  return {
    id: "fake-rule",
    title: "Fake rule",
    events: ["PreToolUse"],
    tools: null,
    defaultAction: "ask",
    requiresModule: null,
    evaluate: () => null,
    ...fields,
  };
}

suite("guards/engine-advisory", ({ test, eq }) => {
  test("a rule returning { action: 'ask', advisory: true } is marked advisory, with no advisoryAsk flag on the rule", () => {
    const rules = [
      fakeRule({
        id: "result-advisory-true",
        advisoryAsk: undefined,
        evaluate: () => ({ action: "ask", reason: "a per-call nudge", advisory: true }),
      }),
    ];
    const result = evaluate(fakeCtx(), { rules });
    eq(result.action, "ask");
    eq(result.advisory, true);
  });

  test("a rule declaring advisoryAsk: true stays advisory even when its own result sets advisory: false", () => {
    const rules = [
      fakeRule({
        id: "advisory-ask-wins",
        advisoryAsk: true,
        evaluate: () => ({ action: "ask", reason: "a genuine ask, despite the flag", advisory: false }),
      }),
    ];
    const result = evaluate(fakeCtx(), { rules });
    eq(result.action, "ask");
    eq(result.advisory, true);
  });

  test("neither advisoryAsk nor result.advisory set: the ask is not marked advisory", () => {
    const rules = [
      fakeRule({
        id: "plain-ask",
        evaluate: () => ({ action: "ask", reason: "a genuine ask" }),
      }),
    ];
    const result = evaluate(fakeCtx(), { rules });
    eq(result.action, "ask");
    eq(result.advisory, undefined);
  });

  test("result.advisory is only ever meaningful on an ask, never surviving a project-config escalation to deny", () => {
    const rules = [
      fakeRule({
        id: "escalated-by-project-switch",
        defaultAction: "deny",
        evaluate: () => ({ action: "ask", reason: "a per-call nudge", advisory: true }),
      }),
    ];
    const project = { rules: { byId: { "escalated-by-project-switch": "deny" } } };
    const result = evaluate(fakeCtx({ project }), { rules });
    eq(result.action, "deny");
    eq(result.advisory, undefined);
  });
});
