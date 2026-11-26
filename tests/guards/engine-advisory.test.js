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

  /* ------------------------------------------------------------ tie-break */

  const nudgeRule = (id) =>
    fakeRule({ id, advisoryAsk: true, evaluate: () => ({ action: "ask", reason: `nudge from ${id}`, fix: "do x" }) });
  const questionRule = (id, extra = {}) =>
    fakeRule({ id, evaluate: () => ({ action: "ask", reason: `question from ${id}` }), ...extra });
  const denyRule = (id) =>
    fakeRule({ id, defaultAction: "deny", evaluate: () => ({ action: "deny", reason: `block from ${id}` }) });

  test("tie-break: an earlier advisory ask does not hide a later genuine ask", () => {
    const result = evaluate(fakeCtx(), { rules: [nudgeRule("a-nudge"), questionRule("z-question")] });
    eq(result.ruleId, "z-question");
    eq(result.action, "ask");
    eq(result.advisory, undefined);
    eq("fix" in result, false, "the displaced nudge's fix must not leak onto the genuine ask");
  });

  test("tie-break: a later advisory ask does not displace an earlier genuine ask", () => {
    const result = evaluate(fakeCtx(), { rules: [questionRule("a-question"), nudgeRule("z-nudge")] });
    eq(result.ruleId, "a-question");
    eq(result.advisory, undefined);
  });

  test("tie-break: two genuine asks keep the first", () => {
    const result = evaluate(fakeCtx(), { rules: [questionRule("a-question"), questionRule("z-question")] });
    eq(result.ruleId, "a-question");
    eq(result.advisory, undefined);
  });

  test("tie-break: two advisory asks keep the first, still advisory", () => {
    const result = evaluate(fakeCtx(), { rules: [nudgeRule("a-nudge"), nudgeRule("z-nudge")] });
    eq(result.ruleId, "a-nudge");
    eq(result.advisory, true);
  });

  test("tie-break: a deny beats an advisory ask in either registry order", () => {
    const forward = evaluate(fakeCtx(), { rules: [nudgeRule("a-nudge"), denyRule("z-deny")] });
    eq(forward.ruleId, "z-deny");
    eq(forward.action, "deny");
    eq(forward.advisory, undefined);

    const backward = evaluate(fakeCtx(), { rules: [denyRule("a-deny"), nudgeRule("z-nudge")] });
    eq(backward.ruleId, "a-deny");
    eq(backward.action, "deny");
  });

  test("tie-break: a mandatory genuine ask after an advisory ask wins", () => {
    const result = evaluate(fakeCtx(), {
      rules: [nudgeRule("a-nudge"), questionRule("z-mandatory", { mandatory: true })],
    });
    eq(result.ruleId, "z-mandatory");
    eq(result.advisory, undefined);
  });
});
