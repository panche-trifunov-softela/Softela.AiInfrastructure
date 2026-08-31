"use strict";

/**
 * Blocks a type-check invocation shaped like a project's known trap — one
 * that appears to run but silently checks nothing.
 *
 * The trap pattern, the reason and the fix are entirely
 * `ctx.project.commands.typecheck`. This is the archetype of the whole
 * configuration idea: the trap belongs to one repository's build, never to
 * guard code.
 */

const { deny, pass } = require("../lib/decision");
const { hasCommand, splitStatements } = require("../lib/shell-parse");
const { compile } = require("../lib/safe-regexp");

/** Tool names this rule evaluates — shell invocations on either host. */
const SHELL_TOOLS = /^(Bash|PowerShell|shell|local_shell|exec_command|shell_command)$/;

module.exports = {
  id: "typecheck-invocation",
  title: "Block a type-check invocation known to check nothing",
  events: ["PreToolUse"],
  tools: SHELL_TOOLS,
  defaultAction: "deny",
  group: "git",
  requiresConfig: ["commands.typecheck.deny"],
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: "deny", reason: string, fix?: string}} The
   * decision, or `null` when nothing configured applies.
   */
  evaluate(ctx) {
    const typecheck = ctx.project && ctx.project.commands && ctx.project.commands.typecheck;
    if (!typecheck || typeof typecheck.deny !== "string" || !compile(typecheck.deny)) return pass();

    for (const statement of splitStatements(ctx.command)) {
      if (hasCommand(statement, typecheck.deny)) {
        return deny(
          typecheck.reason || "This type-check invocation is known to silently check nothing.",
          typecheck.fix,
        );
      }
    }

    return pass();
  },
};
