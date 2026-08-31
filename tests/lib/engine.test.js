"use strict";

const path = require("path");
const { suite } = require("../harness");
const { evaluate, applicableRules } = require("../../core/engine");

/**
 * Builds a minimal fake evaluation context for engine tests, so these tests
 * never depend on `lib/context.js` or real guard files.
 *
 * @param {object} [fields] Overrides merged over the defaults.
 * @returns {object} A fake `ctx`.
 */
function fakeCtx(fields = {}) {
  return {
    event: "PreToolUse",
    toolName: "Bash",
    command: "git push",
    filePath: "",
    modules: new Set(),
    overrides: { forRule: () => ({ action: undefined, allow: [] }) },
    ...fields,
  };
}

/**
 * Builds a minimal fake rule module.
 *
 * `defaultAction` defaults to `"deny"` — the weakest possible ceiling for
 * the clamp introduced alongside this fixture (§5, D-A) — so that every
 * existing case in this file, most of which return `"deny"` from
 * `evaluate` without caring about the clamp, is unaffected by it. A test
 * that means to exercise the clamp itself sets a stricter `defaultAction`
 * explicitly.
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
    defaultAction: "deny",
    requiresModule: null,
    evaluate: () => null,
    ...fields,
  };
}

suite("engine", ({ test, eq, deepEq, ok, fixture }) => {
  test("a rule with nothing to say produces no decision", () => {
    const rules = [fakeRule({ id: "silent", evaluate: () => null })];
    eq(evaluate(fakeCtx(), { rules }), null);
  });

  test("the most severe result wins across rules", () => {
    const rules = [
      fakeRule({ id: "asker", evaluate: () => ({ action: "ask", reason: "a" }) }),
      fakeRule({ id: "denier", evaluate: () => ({ action: "deny", reason: "b" }) }),
    ];
    const result = evaluate(fakeCtx(), { rules });
    eq(result.action, "deny");
    eq(result.ruleId, "denier");
  });

  test("ties are broken by registry order", () => {
    const rules = [
      fakeRule({ id: "first", evaluate: () => ({ action: "deny", reason: "first" }) }),
      fakeRule({ id: "second", evaluate: () => ({ action: "deny", reason: "second" }) }),
    ];
    const result = evaluate(fakeCtx(), { rules });
    eq(result.ruleId, "first");
  });

  test("order in the array is what counts, not the id's alphabetical order", () => {
    const rules = [
      fakeRule({ id: "z-rule", evaluate: () => ({ action: "deny", reason: "z" }) }),
      fakeRule({ id: "a-rule", evaluate: () => ({ action: "deny", reason: "a" }) }),
    ];
    const result = evaluate(fakeCtx(), { rules });
    eq(result.ruleId, "z-rule");
  });

  test("a throwing rule is skipped and recorded in diagnostics", () => {
    const rules = [
      fakeRule({
        id: "broken",
        evaluate: () => {
          throw new Error("boom");
        },
      }),
      fakeRule({ id: "healthy", evaluate: () => ({ action: "ask", reason: "ok" }) }),
    ];
    const diagnostics = [];
    const result = evaluate(fakeCtx(), { rules, diagnostics });
    eq(result.action, "ask");
    eq(result.ruleId, "healthy");
    eq(diagnostics.length, 1);
    eq(diagnostics[0].ruleId, "broken");
    ok(diagnostics[0].error instanceof Error);
  });

  test("a rule requiring an unset module is not applied", () => {
    const rules = [fakeRule({ id: "gated", requiresModule: "extra", evaluate: () => ({ action: "deny", reason: "x" }) })];
    eq(evaluate(fakeCtx({ modules: new Set() }), { rules }), null);
  });

  test("a rule requiring an enabled module is applied", () => {
    const rules = [fakeRule({ id: "gated", requiresModule: "extra", evaluate: () => ({ action: "deny", reason: "x" }) })];
    const result = evaluate(fakeCtx({ modules: new Set(["extra"]) }), { rules });
    eq(result.ruleId, "gated");
  });

  test("a rule for a different event is not applied", () => {
    const rules = [fakeRule({ id: "wrong-event", events: ["PostToolUse"], evaluate: () => ({ action: "deny", reason: "x" }) })];
    eq(evaluate(fakeCtx({ event: "PreToolUse" }), { rules }), null);
  });

  test("a rule with a non-matching tools filter is not applied", () => {
    const rules = [fakeRule({ id: "wrong-tool", tools: /^Edit$/, evaluate: () => ({ action: "deny", reason: "x" }) })];
    eq(evaluate(fakeCtx({ toolName: "Bash" }), { rules }), null);
  });

  test("a rule with tools: null applies to every tool", () => {
    const rules = [fakeRule({ id: "any-tool", tools: null, evaluate: () => ({ action: "ask", reason: "x" }) })];
    const result = evaluate(fakeCtx({ toolName: "AnythingAtAll" }), { rules });
    eq(result.ruleId, "any-tool");
  });

  test("an override allow pattern drops the decision entirely", () => {
    const rules = [fakeRule({ id: "pushable", evaluate: () => ({ action: "deny", reason: "no push" }) })];
    const ctx = fakeCtx({
      command: "git push",
      overrides: { forRule: () => ({ action: undefined, allow: [/git push/] }) },
    });
    eq(evaluate(ctx, { rules }), null);
  });

  test("an override action clamps the result down", () => {
    const rules = [fakeRule({ id: "strict", evaluate: () => ({ action: "deny", reason: "no push" }) })];
    const ctx = fakeCtx({ overrides: { forRule: () => ({ action: "ask", allow: [] }) } });
    const result = evaluate(ctx, { rules });
    eq(result.action, "ask");
  });

  test("an override cannot sharpen a result beyond what the rule returned", () => {
    const rules = [fakeRule({ id: "gentle", evaluate: () => ({ action: "ask", reason: "careful" }) })];
    const ctx = fakeCtx({ overrides: { forRule: () => ({ action: "deny", allow: [] }) } });
    const result = evaluate(ctx, { rules });
    eq(result.action, "ask");
  });

  test("the fix field passes through when present, and is omitted when absent", () => {
    const rules = [fakeRule({ id: "with-fix", evaluate: () => ({ action: "deny", reason: "x", fix: "do y" }) })];
    const result = evaluate(fakeCtx(), { rules });
    eq(result.fix, "do y");

    const rulesNoFix = [fakeRule({ id: "no-fix", evaluate: () => ({ action: "deny", reason: "x" }) })];
    const resultNoFix = evaluate(fakeCtx(), { rules: rulesNoFix });
    eq("fix" in resultNoFix, false);
  });

  test("a rule declaring requiresConfig is not applied when the path is absent", () => {
    const rules = [
      fakeRule({ id: "needs-cfg", requiresConfig: ["limits.fileLines"], evaluate: () => ({ action: "deny", reason: "x" }) }),
    ];
    eq(evaluate(fakeCtx({ project: {} }), { rules }), null);
  });

  test("a rule declaring requiresConfig runs once every listed path is present", () => {
    const rules = [
      fakeRule({ id: "needs-cfg", requiresConfig: ["limits.fileLines"], evaluate: () => ({ action: "deny", reason: "x" }) }),
    ];
    const ctx = fakeCtx({ project: { limits: { fileLines: { ask: 10 } } } });
    const result = evaluate(ctx, { rules });
    eq(result.ruleId, "needs-cfg");
  });

  test("requiresConfig treats an explicit false as present, not absent", () => {
    const rules = [fakeRule({ id: "flag", requiresConfig: ["flags.enabled"], evaluate: () => ({ action: "ask", reason: "x" }) })];
    const result = evaluate(fakeCtx({ project: { flags: { enabled: false } } }), { rules });
    eq(result.ruleId, "flag");
  });

  test("requiresConfig treats an explicit 0 as present, not absent", () => {
    const rules = [fakeRule({ id: "zero", requiresConfig: ["limits.count"], evaluate: () => ({ action: "ask", reason: "x" }) })];
    const result = evaluate(fakeCtx({ project: { limits: { count: 0 } } }), { rules });
    eq(result.ruleId, "zero");
  });

  test("requiresConfig treats an explicit null the same as undefined: absent", () => {
    const rules = [fakeRule({ id: "nulled", requiresConfig: ["limits.count"], evaluate: () => ({ action: "ask", reason: "x" }) })];
    eq(evaluate(fakeCtx({ project: { limits: { count: null } } }), { rules }), null);
  });

  test("the project config's rules.groups switch turns a whole group off", () => {
    const rules = [fakeRule({ id: "coded", group: "code", evaluate: () => ({ action: "deny", reason: "x" }) })];
    const ctx = fakeCtx({ project: { rules: { groups: { code: "off" } } } });
    eq(evaluate(ctx, { rules }), null);
  });

  test("rules.byId beats rules.groups: a group switched off can be re-enabled for one rule id", () => {
    const rules = [fakeRule({ id: "special", group: "code", evaluate: () => ({ action: "ask", reason: "x" }) })];
    const ctx = fakeCtx({ project: { rules: { groups: { code: "off" }, byId: { special: "deny" } } } });
    const result = evaluate(ctx, { rules });
    eq(result.action, "deny");
    eq(result.ruleId, "special");
  });

  test("a project config can escalate a rule's action beyond what it itself returned", () => {
    const rules = [fakeRule({ id: "escalatable", group: "code", evaluate: () => ({ action: "ask", reason: "x" }) })];
    const ctx = fakeCtx({ project: { rules: { byId: { escalatable: { action: "deny", reason: "team decided" } } } } });
    const result = evaluate(ctx, { rules });
    eq(result.action, "deny");
  });

  test("a project config can also soften a rule's action — it sets or clears, in either direction", () => {
    const rules = [fakeRule({ id: "softenable", group: "code", evaluate: () => ({ action: "deny", reason: "x" }) })];
    const ctx = fakeCtx({ project: { rules: { byId: { softenable: "ask" } } } });
    const result = evaluate(ctx, { rules });
    eq(result.action, "ask");
  });

  test("evaluation order: the rule's action, then the project config, then the developer override softening further", () => {
    const rules = [fakeRule({ id: "chain", group: "code", evaluate: () => ({ action: "ask", reason: "x" }) })];
    const ctx = fakeCtx({
      project: { rules: { byId: { chain: "deny" } } },
      overrides: { forRule: () => ({ action: "ask", allow: [] }) },
    });
    const result = evaluate(ctx, { rules });
    eq(result.action, "ask");
  });

  test("a developer override cannot escalate past what the project config already set", () => {
    const rules = [fakeRule({ id: "chain2", group: "code", evaluate: () => ({ action: "ask", reason: "x" }) })];
    const ctx = fakeCtx({
      project: { rules: { byId: { chain2: "ask" } } },
      overrides: { forRule: () => ({ action: "deny", allow: [] }) },
    });
    const result = evaluate(ctx, { rules });
    eq(result.action, "ask");
  });

  test("an unrecognised rules.byId action is ignored rather than applied", () => {
    const rules = [fakeRule({ id: "weird", group: "code", evaluate: () => ({ action: "ask", reason: "x" }) })];
    const ctx = fakeCtx({ project: { rules: { byId: { weird: "yolo" } } } });
    const result = evaluate(ctx, { rules });
    eq(result.action, "ask");
  });

  test("mandatory: true ignores the project config's off switch entirely", () => {
    const rules = [fakeRule({ id: "guarded", group: "agent", mandatory: true, evaluate: () => ({ action: "deny", reason: "x" }) })];
    const ctx = fakeCtx({ project: { rules: { groups: { agent: "off" }, byId: { guarded: "off" } } } });
    const result = evaluate(ctx, { rules });
    eq(result.ruleId, "guarded");
    eq(result.action, "deny");
  });

  test("mandatory: true ignores a developer override's clamp", () => {
    const rules = [fakeRule({ id: "guarded2", group: "agent", mandatory: true, evaluate: () => ({ action: "deny", reason: "x" }) })];
    const ctx = fakeCtx({ overrides: { forRule: () => ({ action: "ask", allow: [] }) } });
    const result = evaluate(ctx, { rules });
    eq(result.action, "deny");
  });

  test("mandatory: true ignores a developer override's allow pattern too", () => {
    const rules = [fakeRule({ id: "guarded3", group: "agent", mandatory: true, evaluate: () => ({ action: "deny", reason: "x" }) })];
    const ctx = fakeCtx({ command: "git push", overrides: { forRule: () => ({ action: undefined, allow: [/git push/] }) } });
    const result = evaluate(ctx, { rules });
    eq(result.action, "deny");
  });

  test("applicableRules lists candidates without running them", () => {
    let ran = false;
    const rules = [
      fakeRule({
        id: "would-run",
        evaluate: () => {
          ran = true;
          return { action: "deny", reason: "x" };
        },
      }),
      fakeRule({ id: "wrong-event", events: ["PostToolUse"], evaluate: () => ({ action: "deny", reason: "x" }) }),
    ];
    const candidates = applicableRules(fakeCtx(), { rules });
    eq(candidates.length, 1);
    eq(candidates[0].id, "would-run");
    eq(ran, false);
  });

  /* ------------------------------------------------- D-A: defaultAction clamp */

  test("a rule that tries to exceed its own defaultAction is clamped down to it", () => {
    const rules = [fakeRule({ id: "overreaching", defaultAction: "ask", evaluate: () => ({ action: "deny", reason: "x" }) })];
    const result = evaluate(fakeCtx(), { rules });
    eq(result.action, "ask");
    eq(result.ruleId, "overreaching");
  });

  test("a rule returning exactly its own defaultAction is unaffected by the clamp", () => {
    const rules = [fakeRule({ id: "honest", defaultAction: "ask", evaluate: () => ({ action: "ask", reason: "x" }) })];
    const result = evaluate(fakeCtx(), { rules });
    eq(result.action, "ask");
  });

  test("the defaultAction clamp applies even to a mandatory rule — its own honesty, not a policy tier", () => {
    const rules = [
      fakeRule({ id: "guarded-overreach", group: "agent", mandatory: true, defaultAction: "ask", evaluate: () => ({ action: "deny", reason: "x" }) }),
    ];
    const result = evaluate(fakeCtx(), { rules });
    eq(result.action, "ask");
  });

  test("the project config can still escalate a clamped result past the rule's own defaultAction", () => {
    const rules = [fakeRule({ id: "clamped-then-escalated", group: "code", defaultAction: "ask", evaluate: () => ({ action: "deny", reason: "x" }) })];
    const ctx = fakeCtx({ project: { rules: { byId: { "clamped-then-escalated": "deny" } } } });
    const result = evaluate(ctx, { rules });
    eq(result.action, "deny", "the project tier is allowed to move a rule's action in either direction, past its own default");
  });

  /* --------------------------------------------------------- stack scoping */

  test("a rule with no stacks field runs regardless of the resolved stack", () => {
    const rules = [fakeRule({ id: "agnostic", evaluate: () => ({ action: "deny", reason: "x" }) })];
    const ctx = fakeCtx({ project: { stack: "backend" }, filePath: "/repo/Widget.tsx", command: "" });
    const result = evaluate(ctx, { rules });
    eq(result && result.ruleId, "agnostic");
  });

  test("a rule scoped to frontend is silent when the resolved stack is backend", () => {
    const rules = [fakeRule({ id: "frontend-only", stacks: ["frontend"], evaluate: () => ({ action: "deny", reason: "x" }) })];
    const ctx = fakeCtx({ project: { stack: "backend" }, filePath: "/repo/Widget.tsx", command: "" });
    eq(evaluate(ctx, { rules }), null);
  });

  test("a rule scoped to frontend runs when the resolved stack is frontend", () => {
    const rules = [fakeRule({ id: "frontend-only", stacks: ["frontend"], evaluate: () => ({ action: "deny", reason: "x" }) })];
    const ctx = fakeCtx({ project: { stack: "frontend" }, filePath: "/repo/Widget.tsx", command: "" });
    const result = evaluate(ctx, { rules });
    eq(result && result.ruleId, "frontend-only");
  });

  test("a stack-scoped rule never runs on a no-file context, whatever the project declares", () => {
    const rules = [fakeRule({ id: "frontend-only", stacks: ["frontend"], evaluate: () => ({ action: "deny", reason: "x" }) })];
    const ctx = fakeCtx({ project: { stack: "frontend" }, filePath: "", command: "git push" });
    eq(evaluate(ctx, { rules }), null);
  });

  test("a stack-agnostic rule still runs on a no-file context", () => {
    const rules = [fakeRule({ id: "agnostic", evaluate: () => ({ action: "deny", reason: "x" }) })];
    const ctx = fakeCtx({ project: { stack: "frontend" }, filePath: "", command: "git push" });
    const result = evaluate(ctx, { rules });
    eq(result && result.ruleId, "agnostic");
  });

  test("a monorepo path resolves per-file: the same registry fires a backend rule on a backend path and stays silent on an unmatched one", () => {
    const rules = [fakeRule({ id: "backend-only", stacks: ["backend"], evaluate: () => ({ action: "deny", reason: "x" }) })];
    const project = { stacks: [{ paths: ["src/Server/**"], stack: "backend" }] };
    const git = { repoRoot: "/repo" };

    const hit = evaluate(fakeCtx({ project, git, filePath: "/repo/src/Server/Program.cs", command: "" }), { rules });
    eq(hit && hit.ruleId, "backend-only");

    const miss = evaluate(fakeCtx({ project, git, filePath: "/repo/src/Web/App.tsx", command: "" }), { rules });
    eq(miss, null, "a path matching no declared stack entry resolves to no stack, same as the no-file case");
  });

  /* ------------------------------------------------------------ presets */

  test("evaluate merges a stack's preset under the project config before requiresConfig is checked", () => {
    const presetsDir = path.dirname(fixture("presets-merge/frontend.json", { conventions: { language: "typescript" } }));
    const rules = [
      fakeRule({
        id: "needs-language",
        requiresConfig: ["conventions.language"],
        evaluate: (ctx) => ({ action: "ask", reason: ctx.project.conventions.language }),
      }),
    ];
    const ctx = fakeCtx({ project: { stack: "frontend" }, filePath: "/repo/Widget.tsx", command: "" });
    const result = evaluate(ctx, { rules, presetsDir });
    eq(result && result.action, "ask");
    eq(result && result.reason, "typescript");
  });

  test("evaluate leaves the project untouched when the resolved stack has no preset file on disk", () => {
    const presetsDir = path.dirname(fixture("presets-empty/.keep", "x"));
    const rules = [fakeRule({ id: "needs-language", requiresConfig: ["conventions.language"], evaluate: () => ({ action: "ask", reason: "x" }) })];
    const ctx = fakeCtx({ project: { stack: "frontend" }, filePath: "/repo/Widget.tsx", command: "" });
    eq(evaluate(ctx, { rules, presetsDir }), null);
  });

  test("a project's own key wins over the preset's key of the same name", () => {
    const presetsDir = path.dirname(fixture("presets-precedence/frontend.json", { conventions: { language: "typescript" } }));
    const rules = [
      fakeRule({
        id: "reads-language",
        requiresConfig: ["conventions.language"],
        evaluate: (ctx) => ({ action: "ask", reason: ctx.project.conventions.language }),
      }),
    ];
    const ctx = fakeCtx({
      project: { stack: "frontend", conventions: { language: "javascript" } },
      filePath: "/repo/Widget.tsx",
      command: "",
    });
    const result = evaluate(ctx, { rules, presetsDir });
    eq(result && result.reason, "javascript", "the project's own conventions object replaces the preset's entirely");
  });
});
