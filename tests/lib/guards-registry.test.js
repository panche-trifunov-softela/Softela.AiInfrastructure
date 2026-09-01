"use strict";

/**
 * Registry-wide invariants over every shipped rule module in `core/guards/`.
 *
 * `core/guards/index.js` drops a malformed module into `loadErrors` instead
 * of throwing, which keeps one broken rule file from disabling every other
 * rule — but it also means a mistake in one module's new `group` /
 * `requiresConfig` / `mandatory` fields fails silently rather than loudly.
 * This suite is what turns that silence into a hard failure.
 */

const { suite } = require("../harness");
const guards = require("../../core/guards");

/** The three groups RULES.md documents: git, code, agent. */
const KNOWN_GROUPS = new Set(["git", "code", "agent"]);

/** How many rules RULES.md's own catalogue lists per group. */
const EXPECTED_GROUP_COUNTS = { git: 11, code: 17, agent: 7 };

/**
 * Every rule id the registry is expected to hold, sorted. Asserted as the
 * exact set below rather than a bare count: a bare number only says
 * "something changed" and makes the developer go find what — the exact,
 * sorted id list fails with a diff naming precisely which id was added,
 * removed, or renamed, which is what actually needs updating (here, and in
 * RULES.md's own catalogue) when a rule lands.
 */
const EXPECTED_RULE_IDS = [
  "api-import-boundary",
  "barrel-exports-only",
  "branch-naming",
  "colocated-tests",
  "commit-message",
  "component-folder-shape",
  "component-types-file",
  "component-view-logic",
  "delegate-bulk-reading",
  "doc-comment-style",
  "file-size-limit",
  "forbidden-commands",
  "hook-locality",
  "immutable-migrations",
  "infra-self-protection",
  "layer-dependencies",
  "local-config-isolation",
  "naming-standards",
  "no-edit-generated-docs",
  "no-explicit-any",
  "no-local-merge-to-base",
  "no-nested-delegation",
  "no-push-to-base",
  "package-install-flags",
  "patch-manifest",
  "protected-paths",
  "pull-must-rebase",
  "reasoning-effort-floor",
  "rebase-safety",
  "reuse-before-new",
  "shell-file-write",
  "subagent-model",
  "test-structure",
  "transactional-outbox",
  "typecheck-invocation",
];

suite("guards/index registry invariants", ({ test, eq, deepEq, ok }) => {
  test("every guard file in core/guards/ loaded without error", () => {
    deepEq(guards.loadErrors, [], `unexpected load errors: ${JSON.stringify(guards.loadErrors)}`);
  });

  test("the registry holds exactly the expected set of shipped rule ids", () => {
    deepEq(
      guards.rules.map((r) => r.id).sort(),
      EXPECTED_RULE_IDS,
      "a rule was added, removed, or renamed — update EXPECTED_RULE_IDS above (and RULES.md's own catalogue) to match",
    );
  });

  test("every rule declares a recognised group", () => {
    for (const rule of guards.rules) {
      ok(KNOWN_GROUPS.has(rule.group), `${rule.id} has an unrecognised group "${rule.group}"`);
    }
  });

  test("every rule declares requiresConfig as an array", () => {
    for (const rule of guards.rules) {
      ok(Array.isArray(rule.requiresConfig), `${rule.id}.requiresConfig must be an array`);
    }
  });

  test("group membership counts match RULES.md's catalogue", () => {
    const counts = { git: 0, code: 0, agent: 0 };
    for (const rule of guards.rules) counts[rule.group] = (counts[rule.group] || 0) + 1;
    deepEq(counts, EXPECTED_GROUP_COUNTS);
  });

  test("infra-self-protection is the only mandatory rule in the whole registry", () => {
    const mandatoryIds = guards.rules.filter((r) => r.mandatory === true).map((r) => r.id);
    deepEq(mandatoryIds, ["infra-self-protection"]);
  });
});
