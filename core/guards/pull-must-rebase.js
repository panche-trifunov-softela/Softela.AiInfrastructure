"use strict";

/**
 * Denies `git pull` unless it explicitly rebases, since a plain pull merges
 * the base into the branch — exactly the merge-based history this project
 * avoids everywhere else.
 *
 * Looks only at the command line, never at `pull.rebase` from git config:
 * reading config means shelling out for a fact the developer already typed
 * on the line in front of them.
 */

const { gitVerb, hasFlag, splitStatements } = require("../lib/shell-parse");
const { deny, pass } = require("../lib/decision");

module.exports = {
  /** kebab-case, unique, equals the filename without .js */
  id: "pull-must-rebase",

  /** one line, shown by `softela-ai doctor` */
  title: "git pull must rebase, never merge",

  /** which host events this rule can fire on */
  events: ["PreToolUse"],

  /** which tool names it applies to; null means every tool */
  tools: /^(Bash|PowerShell|shell|local_shell|exec_command|shell_command)$/,

  /** the strongest action this rule may ever return */
  defaultAction: "deny",

  /** which catalogue group this rule belongs to */
  group: "git",

  /** dotted project-config paths this rule needs to be meaningful */
  requiresConfig: [],

  /** optional: only active when this module is enabled */
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: "deny", reason: string, fix?: string}} The
   * decision.
   */
  evaluate(ctx) {
    for (const stmt of splitStatements(ctx.command)) {
      if (!gitVerb(stmt, "pull")) continue;

      // `--rebase` on its own and `--rebase=<mode>` both actually rebase.
      // `--rebase=false` is deliberately excluded, so it still falls through
      // to the deny below as the equivalent of not rebasing at all.
      const rebases =
        hasFlag(stmt, "--rebase(?:=(?:true|merges|interactive))?") || hasFlag(stmt, "-r\\b");
      const optedOut = hasFlag(stmt, "--no-rebase");

      if (optedOut || !rebases) {
        return deny(
          "RULE: git pull without --rebase merges the base into the branch. The branch is kept current by rebasing, never by merging.",
          "Use: git pull --rebase",
        );
      }
    }

    return pass();
  },
};
