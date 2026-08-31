"use strict";

/**
 * The `newCodeOnly` softening step in `core/engine.js#evaluate` (CONTRACTS
 * §5, step 7): a structural rule's expectations are mandatory for genuinely
 * new code and merely advisory for a file `classifyChange` proved already
 * existed — exercised here with an injected `classifyChange`, so none of
 * this needs a real git repository (`tests/lib/change-scope.test.js` covers
 * the real git resolution).
 */

const { suite } = require("../harness");
const { evaluate } = require("../../core/engine");
const { makeCtx } = require("./_ctx");
const fileSizeLimit = require("../../core/guards/file-size-limit");
const apiImportBoundary = require("../../core/guards/api-import-boundary");
const noExplicitAny = require("../../core/guards/no-explicit-any");

/**
 * A write that violates two structural rules at once — the shape the
 * developer's own acceptance case describes: a file relocated into an
 * already-existing component directory, then edited to reach into the API
 * layer directly. `file-size-limit` (`defaultAction: "ask"`) fires because
 * the project's own `limits.fileLines.ask` is overridden down to `1`, well
 * under the file's own line count; `api-import-boundary`
 * (`defaultAction: "deny"`) fires because the new content imports the API
 * layer directly.
 */
const RELOCATED_FILE = {
  toolName: "Write",
  filePath: "src/components/Widget.tsx",
  content:
    'import { fetchWidget } from "../services/api/widgets";\n\nexport function Widget() {\n  return fetchWidget();\n}\n',
  project: { limits: { fileLines: { ask: 1 } } },
};

/**
 * Builds a `classifyChange` stub that always answers the same classification
 * and records every call it receives.
 *
 * @param {"new" | "existing" | "unknown"} scope The classification to return.
 * @returns {((filePath: string, git: object) => string) & {calls: object[]}}
 * The stub, with its call log attached.
 */
function fakeClassifier(scope) {
  const calls = [];
  const fn = (filePath, git) => {
    calls.push({ filePath, git });
    return scope;
  };
  fn.calls = calls;
  return fn;
}

/**
 * Runs the engine against a context built from `makeCtx`, with the given
 * rules and an injected `classifyChange`.
 *
 * @param {object[]} rules The candidate rules.
 * @param {object} ctxPartial Fields for `makeCtx`.
 * @param {Function} classifyChange The injected classifier.
 * @returns {object | null} The decision, or `null`.
 */
function run(rules, ctxPartial, classifyChange) {
  return evaluate(makeCtx(ctxPartial), { rules, classifyChange });
}

suite("guards/legacy-advisory: newCodeOnly softening", ({ test, eq, ok }) => {
  /* ---------------------------------------------------- the acceptance case */

  test("a relocated-and-edited file classified existing produces ask, never deny, with both the advice framing and the rule's own text", () => {
    const result = run(
      [fileSizeLimit, apiImportBoundary],
      RELOCATED_FILE,
      fakeClassifier("existing"),
    );
    ok(result, "a decision is expected");
    eq(result.action, "ask");
    ok(result.reason.toUpperCase().includes("ADVICE"), "the reason states plainly that this is advice");
    ok(
      result.reason.includes("not a requirement"),
      "the reason states plainly why: the file already exists",
    );
    ok(
      result.reason.includes('"Widget.tsx" is'),
      "the winning rule's own original reason survives unedited",
    );
  });

  test("a softened decision is marked advisory, so a host with no interactive ask can surface it instead of blocking", () => {
    // The mark is what Codex reads. Without it, a decision the engine has
    // just reframed as advice arrived at a host that cannot render an `ask`
    // and became a hard denial the developer had to clear by typing an
    // approval — the nudge and the wall spelled identically.
    const result = run([fileSizeLimit, apiImportBoundary], RELOCATED_FILE, fakeClassifier("existing"));
    eq(result.action, "ask");
    eq(result.advisory, true);
  });

  test("the same write classified new denies, and carries no advisory mark", () => {
    const result = run([fileSizeLimit, apiImportBoundary], RELOCATED_FILE, fakeClassifier("new"));
    eq(result.action, "deny");
    eq(result.advisory, undefined, "a denial is never advisory, on any host");
  });

  test("a rule declaring advisoryAsk is marked even on genuinely new code", () => {
    // `file-size-limit` is a nudge by its own description, not only when
    // softened: a brand-new oversized file is still a size backstop firing,
    // not a decision only the developer can take.
    const result = run([fileSizeLimit], RELOCATED_FILE, fakeClassifier("new"));
    eq(result.action, "ask");
    eq(result.advisory, true);
  });

  test("the same write classified new produces deny — the flag softens only what it is meant to", () => {
    const result = run(
      [fileSizeLimit, apiImportBoundary],
      RELOCATED_FILE,
      fakeClassifier("new"),
    );
    eq(result.action, "deny");
    eq(result.ruleId, "api-import-boundary");
  });

  test("unknown behaves exactly like new: never having proved a file pre-exists never softens it", () => {
    const result = run(
      [fileSizeLimit, apiImportBoundary],
      RELOCATED_FILE,
      fakeClassifier("unknown"),
    );
    eq(result.action, "deny");
    eq(result.ruleId, "api-import-boundary");
  });

  /* -------------------------------------------- a rule already at "ask" */

  test("a flagged rule whose own defaultAction is already ask is unchanged by the softening", () => {
    const result = run([fileSizeLimit], RELOCATED_FILE, fakeClassifier("existing"));
    eq(result.action, "ask", "there was nothing above ask for the clamp to soften");
  });

  /* --------------------------------------------------- an unflagged rule */

  test("an unflagged rule still denies on an existing file — softening never reaches a rule that did not declare it", () => {
    const result = run(
      [noExplicitAny],
      {
        toolName: "Write",
        filePath: "src/types/contract.ts",
        content: "export function parse(value: any): unknown { return value; }\n",
      },
      fakeClassifier("existing"),
    );
    eq(result.action, "deny");
    eq(result.ruleId, "no-explicit-any");
  });

  /* ---------------------------------------------- project config, then this */

  /**
   * CONTRACTS.md §5 states the limitation this proves: the `newCodeOnly`
   * softening runs AFTER the project-config switch (§8), so a project can
   * never force hard enforcement of a structural rule on a pre-existing
   * file — the softening is a team-wide policy, applied after any per-repo
   * escalation, not a per-repository choice.
   */
  test("a project config escalating a flagged rule to deny still ends at ask on an existing file", () => {
    const result = run(
      [fileSizeLimit],
      {
        ...RELOCATED_FILE,
        project: { ...RELOCATED_FILE.project, rules: { byId: { "file-size-limit": "deny" } } },
      },
      fakeClassifier("existing"),
    );
    eq(result.action, "ask", "the project config escalated it to deny, but the softening clamps it back down");
  });

  /* ---------------------------------------------------- developer override */

  test("a developer override can still soften further, from ask to off", () => {
    const result = run(
      [fileSizeLimit],
      {
        ...RELOCATED_FILE,
        overrideSpec: { "file-size-limit": { action: "off" } },
      },
      fakeClassifier("existing"),
    );
    eq(result, null, "off drops the decision entirely, same as any other rule");
  });

  /* -------------------------------------------------------------- laziness */

  test("a shell-only context never calls the injected classifier, even with a flagged rule as a nominal candidate", () => {
    const classifier = fakeClassifier("existing");
    const alwaysCandidate = {
      id: "fake-flagged-rule",
      title: "Fake flagged rule",
      events: ["PreToolUse"],
      tools: null,
      defaultAction: "deny",
      group: "code",
      newCodeOnly: true,
      evaluate: () => ({ action: "deny", reason: "x" }),
    };
    const result = run(
      [alwaysCandidate],
      { toolName: "Bash", command: "git status", filePath: "" },
      classifier,
    );
    eq(result.action, "deny", "with no file path there is nothing to soften, so the rule's own result stands");
    eq(classifier.calls.length, 0);
  });

  test("a context whose only candidate rules are unflagged never calls the classifier either", () => {
    const classifier = fakeClassifier("existing");
    run(
      [noExplicitAny],
      {
        toolName: "Write",
        filePath: "src/types/contract.ts",
        content: "export function parse(value: any): unknown { return value; }\n",
      },
      classifier,
    );
    eq(classifier.calls.length, 0);
  });
});
