"use strict";

const path = require("path");
const { suite } = require("../harness");
const { approvalsPath, isApproved, grant, list, DEFAULT_MINUTES } = require("../../core/lib/approvals");
const { evaluate } = require("../../core/engine");

const NOW = Date.parse("2026-08-14T12:00:00Z");

/**
 * Builds a minimal fake rule that always wants to deny, for exercising the
 * engine's approval skip without depending on any real guard's logic.
 *
 * @param {string} id The rule's id — also the approval id it is granted under.
 * @returns {object} A rule module.
 */
function fakeDenyRule(id) {
  return {
    id,
    title: "fake",
    events: ["PreToolUse"],
    tools: null,
    defaultAction: "deny",
    requiresModule: null,
    evaluate: () => ({ action: "deny", reason: "always denies" }),
  };
}

/**
 * Builds a minimal fake context for the engine-integration cases.
 *
 * @param {string} agent The agent whose approvals file should be consulted.
 * @returns {object} A fake `ctx`.
 */
function fakeCtx(agent) {
  return {
    event: "PreToolUse",
    agent,
    toolName: "Bash",
    command: "echo hi",
    filePath: "",
    modules: new Set(),
    overrides: { forRule: () => ({ action: undefined, allow: [] }) },
  };
}

suite("lib/approvals", ({ test, eq, ok, deepEq, tmpdir, fixture, fakeHome }) => {
  /* --------------------------------------------------------- isApproved */

  test("a missing file yields no approval", () => {
    const file = path.join(tmpdir(), "does-not-exist.json");
    eq(isApproved("subagent-model", { file, now: NOW }), false);
  });

  test("a live grant is approved", () => {
    const file = path.join(tmpdir(), "approvals.json");
    grant("subagent-model", 60, { file, now: NOW });
    eq(isApproved("subagent-model", { file, now: NOW + 60000 }), true);
  });

  test("an expired grant is not approved", () => {
    const file = path.join(tmpdir(), "approvals.json");
    grant("subagent-model", 60, { file, now: NOW });
    eq(isApproved("subagent-model", { file, now: NOW + 61 * 60000 }), false);
  });

  test("an approval for a different rule id does not cover this one", () => {
    const file = path.join(tmpdir(), "approvals.json");
    grant("reasoning-effort-floor", 60, { file, now: NOW });
    eq(isApproved("subagent-model", { file, now: NOW }), false);
  });

  test("malformed JSON in the file yields no approval, never a throw", () => {
    const file = fixture("approvals.json", "{ not json");
    let result;
    const threw = (() => {
      try {
        result = isApproved("subagent-model", { file, now: NOW });
        return false;
      } catch {
        return true;
      }
    })();
    eq(threw, false);
    eq(result, false);
  });

  test("an entry with no until field yields no approval", () => {
    const file = fixture("approvals.json", { "subagent-model": { scope: "session-or-time" } });
    eq(isApproved("subagent-model", { file, now: NOW }), false);
  });

  test("an entry whose until is not a parseable date yields no approval", () => {
    const file = fixture("approvals.json", { "subagent-model": { until: "not-a-date" } });
    eq(isApproved("subagent-model", { file, now: NOW }), false);
  });

  test("reading a directory as the file yields no approval, never a throw", () => {
    const dir = tmpdir();
    eq(isApproved("subagent-model", { file: dir, now: NOW }), false);
  });

  /* -------------------------------------------------------------- grant */

  test("grant defaults to 60 minutes when none is given", () => {
    eq(DEFAULT_MINUTES, 60);
    const file = path.join(tmpdir(), "approvals.json");
    grant("subagent-model", undefined, { file, now: NOW });
    eq(isApproved("subagent-model", { file, now: NOW + 59 * 60000 }), true);
    eq(isApproved("subagent-model", { file, now: NOW + 61 * 60000 }), false);
  });

  test("grant defaults to 60 minutes when given a non-positive value", () => {
    const file = path.join(tmpdir(), "approvals.json");
    grant("subagent-model", -5, { file, now: NOW });
    eq(isApproved("subagent-model", { file, now: NOW + 30 * 60000 }), true);
  });

  test("grant overwrites an existing entry for the same rule id", () => {
    const file = path.join(tmpdir(), "approvals.json");
    grant("subagent-model", 5, { file, now: NOW });
    grant("subagent-model", 120, { file, now: NOW });
    eq(isApproved("subagent-model", { file, now: NOW + 60 * 60000 }), true);
  });

  test("grant preserves an unrelated rule's existing entry", () => {
    const file = path.join(tmpdir(), "approvals.json");
    grant("reasoning-effort-floor", 60, { file, now: NOW });
    grant("subagent-model", 60, { file, now: NOW });
    ok(isApproved("reasoning-effort-floor", { file, now: NOW }));
    ok(isApproved("subagent-model", { file, now: NOW }));
  });

  test("grant returns true on success", () => {
    const file = path.join(tmpdir(), "approvals.json");
    eq(grant("subagent-model", 10, { file, now: NOW }), true);
  });

  test("grant returns false rather than throwing on an unwritable path", () => {
    // A NUL byte is never a valid path component on either platform.
    const file = path.join(tmpdir(), "sub\0dir", "approvals.json");
    eq(grant("subagent-model", 10, { file, now: NOW }), false);
  });

  /* --------------------------------------------------------------- list */

  test("list is empty when the file is missing", () => {
    const file = path.join(tmpdir(), "does-not-exist.json");
    deepEq(list({ file, now: NOW }), []);
  });

  test("list reports every entry with its live status", () => {
    const file = path.join(tmpdir(), "approvals.json");
    grant("subagent-model", 60, { file, now: NOW });
    grant("reasoning-effort-floor", 60, { file, now: NOW - 120 * 60000 });
    const entries = list({ file, now: NOW }).sort((a, b) => a.ruleId.localeCompare(b.ruleId));
    eq(entries.length, 2);
    eq(entries[0].ruleId, "reasoning-effort-floor");
    eq(entries[0].live, false);
    eq(entries[1].ruleId, "subagent-model");
    eq(entries[1].live, true);
  });

  /* --------------------------------------------------------- approvalsPath */

  test("approvalsPath resolves under the state directory for claude", () => {
    const p = approvalsPath("claude").replace(/\\/g, "/");
    ok(p.endsWith(".softela-ai/approvals.json"));
  });

  test("approvalsPath resolves under the state directory for codex", () => {
    const p = approvalsPath("codex").replace(/\\/g, "/");
    ok(p.includes("/.codex/"));
    ok(p.endsWith(".softela-ai/approvals.json"));
  });

  test("approvalsPath falls back to claude's home for an unrecognised agent", () => {
    const claude = approvalsPath("claude");
    const unknown = approvalsPath("something-else");
    eq(unknown, claude);
  });

  /* -------------------------------------------------- engine integration */

  test("the engine skips a rule with a live approval for its id", () => {
    fakeHome();
    const rule = fakeDenyRule("fake-approved-rule");
    const before = evaluate(fakeCtx("claude"), { rules: [rule], now: NOW });
    eq(before && before.action, "deny");
    grant(rule.id, 60, { agent: "claude", now: NOW });
    eq(evaluate(fakeCtx("claude"), { rules: [rule], now: NOW }), null);
  });

  test("the engine still runs the rule once the approval has expired", () => {
    fakeHome();
    const rule = fakeDenyRule("fake-expired-rule");
    grant(rule.id, 60, { agent: "claude", now: NOW });
    const result = evaluate(fakeCtx("claude"), { rules: [rule], now: NOW + 61 * 60000 });
    eq(result && result.action, "deny");
    eq(result && result.ruleId, rule.id);
  });

  test("an approval for one rule id does not skip a different rule", () => {
    fakeHome();
    grant("some-other-rule", 60, { agent: "claude", now: NOW });
    const rule = fakeDenyRule("fake-unrelated-rule");
    const result = evaluate(fakeCtx("claude"), { rules: [rule], now: NOW });
    eq(result && result.action, "deny");
  });
});
