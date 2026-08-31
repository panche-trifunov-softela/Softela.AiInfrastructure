"use strict";

const { suite } = require("../harness");
const { resolveOverrides, classifyOverrideEntry } = require("../../core/lib/override-resolver");
const { clamp } = require("../../core/lib/decision");

suite("lib/override-resolver", ({ test, eq, ok, deepEq, fixture }) => {
  test("a missing file yields no overrides for any rule", () => {
    const overrides = resolveOverrides("claude", "SomeProject", { file: "/does/not/exist/overrides.json" });
    eq(overrides.raw, null);
    deepEq(overrides.invalid, []);
    const resolved = overrides.forRule("no-push-to-base");
    eq(resolved.action, undefined);
    deepEq(resolved.allow, []);
    eq(resolved.reason, undefined);
  });

  test("a global rule override is returned for its id", () => {
    const file = fixture("overrides.json", {
      rules: { "no-explicit-any": { action: "ask", reason: "team decision" } },
    });
    const overrides = resolveOverrides("claude", "SomeProject", { file });
    const resolved = overrides.forRule("no-explicit-any");
    eq(resolved.action, "ask");
    eq(resolved.reason, "team decision");
  });

  test("the clamp invariant: an override of deny on an ask result still yields ask", () => {
    const file = fixture("overrides.json", {
      rules: { "some-rule": { action: "deny" } },
    });
    const overrides = resolveOverrides("claude", "SomeProject", { file });
    const override = overrides.forRule("some-rule");
    eq(override.action, "deny");
    // The rule itself returned "ask"; clamping against the override never sharpens it.
    eq(clamp("ask", override.action), "ask");
  });

  test("allow patterns compile to regexes that match the intended command", () => {
    const file = fixture("overrides.json", {
      rules: { "forbidden-commands": { allow: ["\\bkubectl\\b"], reason: "DevOps tooling" } },
    });
    const overrides = resolveOverrides("claude", "SomeProject", { file });
    const resolved = overrides.forRule("forbidden-commands");
    eq(resolved.allow.length, 1);
    ok(resolved.allow[0].test("kubectl get pods"));
    eq(resolved.allow[0].test("git push"), false);
  });

  test("an invalid allow pattern is collected into invalid, not thrown", () => {
    const file = fixture("overrides.json", {
      rules: { "forbidden-commands": { allow: ["(unclosed"] } },
    });
    const overrides = resolveOverrides("claude", "SomeProject", { file });
    const resolved = overrides.forRule("forbidden-commands");
    deepEq(resolved.allow, []);
    ok(overrides.invalid.some((entry) => entry.includes("(unclosed")));
  });

  test("a project override softens beyond a stricter global override", () => {
    const file = fixture("overrides.json", {
      rules: { "colocated-tests": { action: "deny" } },
      projects: { MyProject: { rules: { "colocated-tests": { action: "ask" } } } },
    });
    const overrides = resolveOverrides("claude", "MyProject", { file });
    eq(overrides.forRule("colocated-tests").action, "ask");
  });

  test("a project override cannot sharpen beyond a softer global override", () => {
    const file = fixture("overrides.json", {
      rules: { "colocated-tests": { action: "ask" } },
      projects: { MyProject: { rules: { "colocated-tests": { action: "deny" } } } },
    });
    const overrides = resolveOverrides("claude", "MyProject", { file });
    // deny is more severe than the global ask, so the clamp keeps it at ask.
    eq(overrides.forRule("colocated-tests").action, "ask");
  });

  test("a project override only applies to its own project id", () => {
    const file = fixture("overrides.json", {
      projects: { MyProject: { rules: { "colocated-tests": { action: "off" } } } },
    });
    const overrides = resolveOverrides("claude", "OtherProject", { file });
    eq(overrides.forRule("colocated-tests").action, undefined);
  });

  test("reason prefers the project-scoped entry over the global one", () => {
    const file = fixture("overrides.json", {
      rules: { "colocated-tests": { action: "off", reason: "global reason" } },
      projects: { MyProject: { rules: { "colocated-tests": { action: "off", reason: "project reason" } } } },
    });
    const overrides = resolveOverrides("claude", "MyProject", { file });
    eq(overrides.forRule("colocated-tests").reason, "project reason");
  });

  test("classifyOverrideEntry: an unknown rule id is invalid, not a working override", () => {
    const { state, problems } = classifyOverrideEntry("typo-rule-id-xyz", { action: "off" });
    eq(state, "invalid");
    ok(problems.some((p) => p.includes("unknown rule id")), JSON.stringify(problems));
  });

  test("classifyOverrideEntry: an override that only carries an unparseable regex is invalid, not silently working", () => {
    const { state, problems } = classifyOverrideEntry("forbidden-commands", { allow: ["(unterminated"] });
    eq(state, "invalid");
    ok(problems.some((p) => p.includes("(unterminated") && p.includes("not a valid regular expression")), JSON.stringify(problems));
  });

  test("classifyOverrideEntry: a non-string action is invalid, not silently ignored", () => {
    const { state, problems } = classifyOverrideEntry("no-explicit-any", { action: 12345 });
    eq(state, "invalid");
    ok(problems.some((p) => p.includes("must be a string")), JSON.stringify(problems));
  });

  test("classifyOverrideEntry: a mandatory rule's override is ignored, not reported as effective", () => {
    const { state } = classifyOverrideEntry("infra-self-protection", { action: "off" });
    eq(state, "ignored");
  });

  test("classifyOverrideEntry: a well-formed override on a real, non-mandatory rule is effective", () => {
    const { state, problems } = classifyOverrideEntry("colocated-tests", { action: "off", reason: "team decision" });
    eq(state, "effective");
    deepEq(problems, []);
  });

  test("classifyOverrideEntry: one bad allow pattern alongside a good one and a valid action still counts as effective, but the bad pattern is still reported", () => {
    const { state, problems } = classifyOverrideEntry("forbidden-commands", { action: "ask", allow: ["\\bkubectl\\b", "(bad"] });
    eq(state, "effective");
    ok(problems.some((p) => p.includes("(bad")), JSON.stringify(problems));
  });
});
