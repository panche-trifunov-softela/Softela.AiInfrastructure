"use strict";

/**
 * Blocks a package-install invocation that omits a flag this project
 * requires.
 *
 * The trap pattern, the reason and the fix are entirely
 * `ctx.project.commands.install` — nothing here names a package manager or a
 * flag. A project that declares no `commands.install` has nothing enforced.
 */

const { deny, pass } = require("../lib/decision");
const { hasCommand, splitStatements } = require("../lib/shell-parse");
const { compile } = require("../lib/safe-regexp");

/** Tool names this rule evaluates — shell invocations on either host. */
const SHELL_TOOLS = /^(Bash|PowerShell|shell|local_shell|exec_command|shell_command)$/;

module.exports = {
  id: "package-install-flags",
  title: "Require the project's mandatory package-install flags",
  events: ["PreToolUse"],
  tools: SHELL_TOOLS,
  defaultAction: "deny",
  group: "git",
  requiresConfig: ["commands.install.deny"],
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: "deny", reason: string, fix?: string}} The
   * decision, or `null` when nothing configured applies.
   */
  evaluate(ctx) {
    const install = ctx.project && ctx.project.commands && ctx.project.commands.install;
    if (!install || typeof install.deny !== "string" || !compile(install.deny)) return pass();

    for (const statement of splitStatements(ctx.command)) {
      if (hasCommand(statement, install.deny)) {
        return deny(
          install.reason || "This install command is missing a flag this project requires.",
          install.fix,
        );
      }
    }

    return pass();
  },
};
