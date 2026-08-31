"use strict";

/**
 * The project config's `rules: {groups, byId}` switch (CONTRACTS §8),
 * exercised against real rule modules through `decide()` — not a synthetic
 * fake rule — so this proves the production guards actually experience the
 * tier the engine tests in `tests/lib/engine.test.js` prove abstractly.
 */

const { suite } = require("../harness");
const { decide } = require("./_ctx");
const namingStandards = require("../../core/guards/naming-standards");
const branchNaming = require("../../core/guards/branch-naming");

/** A write that naming-standards asks about under the default project fixture. */
const BADLY_NAMED_COMPONENT = {
  toolName: "Write",
  filePath: "/repo/src/components/widget.tsx",
  content: "export default function widget() { return null; }\n",
};

/** A branch-create command branch-naming asks about under the default project fixture. */
const BADLY_NAMED_BRANCH = { command: "git checkout -b whatever" };

suite("guards/rules-switch: project config groups/byId", ({ test, eq }) => {
  test("group off silences a real rule that would otherwise fire", () => {
    eq(
      decide(namingStandards, { ...BADLY_NAMED_COMPONENT, project: { rules: { groups: { code: "off" } } } }),
      "pass",
    );
  });

  test("byId off silences one specific rule without touching its group", () => {
    eq(
      decide(namingStandards, {
        ...BADLY_NAMED_COMPONENT,
        project: { rules: { byId: { "naming-standards": "off" } } },
      }),
      "pass",
    );
  });

  test("byId escalates a real rule's ask past its own default", () => {
    eq(
      decide(namingStandards, {
        ...BADLY_NAMED_COMPONENT,
        project: { rules: { byId: { "naming-standards": { action: "deny", reason: "this team treats it as a blocker" } } } },
      }),
      "deny",
    );
  });

  test("byId beats groups: a group switched off can be re-enabled and escalated for one id", () => {
    eq(
      decide(namingStandards, {
        ...BADLY_NAMED_COMPONENT,
        project: { rules: { groups: { code: "off" }, byId: { "naming-standards": "deny" } } },
      }),
      "deny",
    );
  });

  test("a rule outside the switched-off group is unaffected", () => {
    eq(
      decide(branchNaming, { ...BADLY_NAMED_BRANCH, project: { rules: { groups: { code: "off" } } } }),
      "ask",
    );
  });

  test("evaluation order end to end: rule asks, project config escalates to deny, developer override softens back to ask", () => {
    eq(
      decide(namingStandards, {
        ...BADLY_NAMED_COMPONENT,
        project: { rules: { byId: { "naming-standards": "deny" } } },
        overrideSpec: { "naming-standards": { action: "ask" } },
      }),
      "ask",
    );
  });

  test("a developer override still cannot escalate past what the project config set", () => {
    eq(
      decide(namingStandards, {
        ...BADLY_NAMED_COMPONENT,
        project: { rules: { byId: { "naming-standards": "ask" } } },
        overrideSpec: { "naming-standards": { action: "deny" } },
      }),
      "ask",
    );
  });
});
