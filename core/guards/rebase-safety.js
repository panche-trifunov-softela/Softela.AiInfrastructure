"use strict";

/**
 * Asks before a command that could discard an in-progress rebase's conflict
 * resolutions — work that took real analysis to reach and cannot be
 * reconstructed from git history once it is gone.
 *
 * Silent whenever `ctx.git.rebaseInProgress` is false: every command this
 * rule watches is completely ordinary outside a rebase.
 */

const { gitVerb, hasFlag, splitStatements } = require("../lib/shell-parse");
const { ask, pass } = require("../lib/decision");

/** Reason shared by every case this rule fires on. */
const REASON =
  "RULE: a rebase is currently in progress. This command can discard conflict resolutions that already took real analysis to reach.";

/** Fix shared by every case this rule fires on. */
const FIX = "Finish the rebase first with git rebase --continue, or proceed deliberately.";

module.exports = {
  /** kebab-case, unique, equals the filename without .js */
  id: "rebase-safety",

  /** one line, shown by `softela-ai doctor` */
  title: "Guard destructive commands during an active rebase",

  /** which host events this rule can fire on */
  events: ["PreToolUse"],

  /** which tool names it applies to; null means every tool */
  tools: /^(Bash|PowerShell|shell|local_shell|exec_command|shell_command)$/,

  /** the strongest action this rule may ever return */
  defaultAction: "ask",

  /** which catalogue group this rule belongs to */
  group: "git",

  /** dotted project-config paths this rule needs to be meaningful */
  requiresConfig: [],

  /** optional: only active when this module is enabled */
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: "ask", reason: string, fix?: string}} The
   * decision.
   */
  evaluate(ctx) {
    if (!ctx.git.rebaseInProgress) return pass();

    for (const stmt of splitStatements(ctx.command)) {
      if (gitVerb(stmt, "rebase") && (hasFlag(stmt, "--abort") || hasFlag(stmt, "--skip"))) {
        return ask(REASON, FIX);
      }
      if (gitVerb(stmt, "reset") && (hasFlag(stmt, "--hard") || hasFlag(stmt, "--merge"))) {
        return ask(REASON, FIX);
      }
      if (gitVerb(stmt, "checkout") || gitVerb(stmt, "switch") || gitVerb(stmt, "stash")) {
        return ask(REASON, FIX);
      }
      if (gitVerb(stmt, "clean") && hasFlag(stmt, "-[fdx]+")) {
        return ask(REASON, FIX);
      }
    }

    return pass();
  },
};
