"use strict";

/**
 * `no-nested-delegation` — forbids a delegated agent from spawning a
 * subagent of its own.
 *
 * Unlike `delegate-bulk-reading`, this is a genuine, unambiguous rule: the
 * one signal it keys on (`ctx.agentId` set) is exactly the shape a nested
 * spawn has, so it denies rather than guesses. Negative cases still
 * outnumber positive ones — the ordinary, intended shape of every spawn is a
 * main-thread call, and this rule must stay silent for every one of those.
 */

const { suite } = require("../harness");
const { decide, decision } = require("./_ctx");
const rule = require("../../core/guards/no-nested-delegation");

/** The module this rule is only meaningful under. */
const MODULES = ["agent-orchestration"];

suite("guards/no-nested-delegation", ({ test, eq, ok }) => {
  /* -------------------------------------------------- main thread: silent */

  test("a direct spawn from the main thread passes", () => {
    eq(decide(rule, { toolName: "Agent", input: { prompt: "x", model: "sonnet" }, modules: MODULES }), "pass");
  });

  test("a Task spawn from the main thread passes", () => {
    eq(decide(rule, { toolName: "Task", input: { prompt: "x", model: "haiku" }, modules: MODULES }), "pass");
  });

  test("a Workflow spawn from the main thread passes", () => {
    eq(decide(rule, { toolName: "Workflow", input: { script: "agent({model: 'sonnet'})" }, modules: MODULES }), "pass");
  });

  test("Codex's own spawn tool from the main thread passes", () => {
    eq(
      decide(rule, {
        agent: "codex",
        toolName: "collaborationspawn_agent",
        input: { task_name: "t", model: "gpt-5.6-luna" },
        modules: MODULES,
      }),
      "pass",
    );
  });

  test("an unknown spawn-like tool carrying a model key, from the main thread, passes", () => {
    eq(decide(rule, { toolName: "delegate_work", input: { model: "sonnet" }, modules: MODULES }), "pass");
  });

  /* -------------------------------------------------- inside a subagent: deny */

  test("the same Agent spawn, from inside a delegated agent, is denied", () => {
    eq(
      decide(rule, {
        toolName: "Agent",
        input: { prompt: "x", model: "sonnet" },
        agentId: "agent-1",
        modules: MODULES,
      }),
      "deny",
    );
  });

  test("the same Task spawn, from inside a delegated agent, is denied", () => {
    eq(
      decide(rule, {
        toolName: "Task",
        input: { prompt: "x", model: "haiku" },
        agentId: "agent-1",
        modules: MODULES,
      }),
      "deny",
    );
  });

  test("the same Workflow spawn, from inside a delegated agent, is denied", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: { script: "agent({model: 'sonnet'})" },
        agentId: "agent-1",
        modules: MODULES,
      }),
      "deny",
    );
  });

  test("the same unknown spawn-like tool, from inside a delegated agent, is denied", () => {
    eq(
      decide(rule, {
        toolName: "delegate_work",
        input: { model: "sonnet" },
        agentId: "agent-1",
        modules: MODULES,
      }),
      "deny",
    );
  });

  test("the denial names the fix: do the work directly and report back", () => {
    const d = decision(rule, {
      toolName: "Agent",
      input: { prompt: "x", model: "sonnet" },
      agentId: "agent-1",
      modules: MODULES,
    });
    eq(d.action, "deny");
    ok(/NESTED DELEGATION/.test(d.reason));
    ok(/directly/i.test(d.fix));
    ok(/report/i.test(d.fix));
  });

  /* --------------------------------------------- non-spawn calls, gating */

  test("a non-spawn tool call from inside a delegated agent still passes", () => {
    eq(decide(rule, { toolName: "Bash", command: "ls -la", agentId: "agent-1", modules: MODULES }), "pass");
  });

  test("a Read call from inside a delegated agent passes — reading is the subagent's own job", () => {
    eq(
      decide(rule, { toolName: "Read", input: { file_path: "a.ts" }, agentId: "agent-1", modules: MODULES }),
      "pass",
    );
  });

  test("silent when the orchestration module is not enabled, even inside a delegated agent", () => {
    eq(
      decide(rule, { toolName: "Agent", input: { prompt: "x", model: "sonnet" }, agentId: "agent-1", modules: [] }),
      "pass",
    );
  });

  test("an override can turn it off, the same as any other rule", () => {
    eq(
      decide(rule, {
        toolName: "Agent",
        input: { prompt: "x", model: "sonnet" },
        agentId: "agent-1",
        modules: MODULES,
        overrideSpec: { "no-nested-delegation": { action: "off" } },
      }),
      "pass",
    );
  });
});
