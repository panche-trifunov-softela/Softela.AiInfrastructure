"use strict";

/**
 * Cross-cutting property: `PROJECT_MINIMAL` (a project that declares nothing
 * beyond its id — see `tests/guards/_ctx.js`) must genuinely silence every
 * rule whose behaviour depends on project config.
 *
 * Individual rule suites already prove this one case at a time with a
 * hand-built triggering `ctx`. This suite proves it a different, stronger
 * way: it walks the real registry `core/guards` ships and asserts, through
 * `applicableRules` (the same engine surface `core/engine.js#evaluate` uses
 * to select candidates), that a rule declaring `requiresConfig` is never even
 * a candidate under `PROJECT_MINIMAL` — not merely that it happens to decide
 * "pass" for one scenario.
 */

const { suite } = require("../harness");
const { applicableRules } = require("../../core/engine");
const { makeCtx, PROJECT_MINIMAL } = require("./_ctx");
const { rules } = require("../../core/guards");

/**
 * Picks a tool name a rule's own `tools` filter accepts, so this suite's
 * assertion is attributable to `requiresConfig` specifically, never to an
 * unrelated tool-name mismatch that would exclude the rule regardless.
 *
 * @param {object} rule A rule module.
 * @returns {string} `"Write"` when the rule inspects file writes, `"Bash"`
 * when it inspects shell statements, `"Write"` as a harmless default for a
 * rule whose `tools` filter is `null` (matches every tool name).
 */
function toolNameFor(rule) {
  if (!rule.tools || typeof rule.tools.test !== "function") return "Write";
  if (rule.tools.test("Write")) return "Write";
  if (rule.tools.test("Bash")) return "Bash";
  return "Write";
}

/**
 * Every `requiresModule` id any shipped rule declares, so enabling them all
 * at once keeps that gate from masking what this suite actually tests.
 */
const ALL_MODULES = rules.map((r) => r.requiresModule).filter(Boolean);

suite("guards/project-minimal silences every config-driven rule", ({ test, eq }) => {
  const configDriven = rules.filter((r) => Array.isArray(r.requiresConfig) && r.requiresConfig.length > 0);

  test("at least one shipped rule actually declares requiresConfig", () => {
    eq(configDriven.length > 0, true, "this suite would otherwise assert nothing");
  });

  for (const rule of configDriven) {
    test(`${rule.id}: excluded from applicableRules under PROJECT_MINIMAL`, () => {
      const ctx = makeCtx({
        project: PROJECT_MINIMAL,
        toolName: toolNameFor(rule),
        modules: ALL_MODULES,
      });
      const candidates = applicableRules(ctx, { rules: [rule] });
      eq(candidates.length, 0, `${rule.id} must not be a candidate when its requiresConfig paths are absent`);
    });
  }
});
