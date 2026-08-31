"use strict";

/**
 * Forbids a delegated agent from spawning a subagent of its own.
 *
 * Delegation is meant to run one level deep: an orchestrator spawns a
 * subagent to do a bounded piece of reading or writing, and that subagent
 * does the work itself rather than fanning it out again. A subagent that
 * spawns another subagent burns tokens on a second layer of coordination
 * overhead for no corresponding gain, and the result is harder to review —
 * the orchestrator that approved the first spawn never sees what the second
 * one actually did.
 *
 * `ctx.agentId` is the signal this rule keys on: a Claude Code `PreToolUse`
 * payload carries it only when the hook fires inside a subagent call, so a
 * non-null value is exactly "this tool call is happening inside a delegated
 * agent". A main-thread call — the ordinary, intended shape of every spawn —
 * always has it `null`, so this rule has nothing to say about it. This is a
 * Claude Code payload field; Codex is not known to send an equivalent one, so
 * this rule is silent there rather than wrong.
 *
 * Unlike `delegate-bulk-reading`, which only ever guesses and so can only
 * ever advise, this is a genuine, unambiguous rule about who is allowed to
 * spawn: never a subagent. It denies rather than asks.
 */

const { deny, pass } = require("../lib/decision");
const { isSpawnTool } = require("../lib/spawn-tools");

module.exports = {
  id: "no-nested-delegation",
  title: "A delegated agent may not spawn a subagent of its own",
  events: ["PreToolUse"],
  tools: null,
  defaultAction: "deny",
  group: "agent",
  requiresConfig: [],
  requiresModule: "agent-orchestration",

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: "deny", reason: string, fix: string}} `deny`
   * when a delegated agent (`ctx.agentId` set) attempts to spawn a subagent;
   * `pass` otherwise, including every main-thread spawn.
   */
  evaluate(ctx) {
    if (!ctx.agentId) return pass();

    const toolName = String(ctx.toolName || "");
    const input = ctx.input && typeof ctx.input === "object" ? ctx.input : {};
    if (!isSpawnTool(toolName, input)) return pass();

    return deny(
      "NESTED DELEGATION: this tool call is running inside a delegated agent, and it is trying to spawn a " +
        "subagent of its own. Delegation runs one level deep — a subagent does the work itself rather than " +
        "delegating it on, since fanning out a second layer burns tokens and degrades quality.",
      "Do the reading or work directly, in this agent's own context, and report the result back to the " +
        "orchestrator that spawned this agent.",
    );
  },
};
