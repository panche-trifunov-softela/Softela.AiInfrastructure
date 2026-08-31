"use strict";

/**
 * Denies a local merge into a base branch — whether it was already checked
 * out, or the same command line just switched to it — and denies a
 * force-push to a base branch, since a rewritten base-branch history is the
 * same failure by another door.
 *
 * Base branches are reached only through a pull request and a squash merge;
 * anything that lands a merge commit or rewritten history there locally
 * bypasses that review entirely.
 */

const { gitVerb, hasFlag, splitStatements, splitTokens } = require("../lib/shell-parse");
const { deny, pass } = require("../lib/decision");

/**
 * Resolves the branch a plain `checkout`/`switch` (not `-b`/`-c`) targets, by
 * walking {@link splitTokens}'s fully dequoted token list by value rather
 * than matching a regex against character positions in a masked copy of the
 * statement. That is what lets a quoted command word (`'git' checkout
 * dev-ng`), an ANSI-C quoted one, an `${IFS}`-joined one, or a
 * backslash-continued one all read identically to the plain spelling.
 *
 * Deliberately as literal as the regex it replaces: `git` must be followed
 * immediately by `checkout`/`switch` and then the target, with no flag
 * tolerated in either gap. A statement carrying a flag there — including
 * `-b`/`-c`, which create a new branch rather than switching to one — is
 * left to {@link module:guards/branch-naming} instead.
 *
 * @param {string} statement A single, already-isolated shell statement.
 * @returns {string | null} The target branch name, or `null` when the
 * statement is not a plain `checkout`/`switch`.
 */
function switchTarget(statement) {
  const tokens = splitTokens(statement);
  if (!/^git$/i.test(tokens[0] || "")) return null;
  if (!/^(?:checkout|switch)$/i.test(tokens[1] || "")) return null;
  const target = tokens[2];
  return target && !target.startsWith("-") ? target : null;
}

/**
 * Locates the text following a `push` invocation within one statement.
 *
 * @param {string} stmt A statement already known to invoke `git push` via
 * {@link gitVerb}.
 * @returns {string[]} The non-flag tokens found after the verb.
 */
function pushPositionalArgs(stmt) {
  const flag = "(?:(?:-c|-C)\\s+\\S+|-[^\\s]+(?:=\\S*)?)";
  const re = new RegExp(`git\\s+(?:${flag}\\s+)*push\\b`, "i");
  const m = stmt.match(re);
  const rest = m ? stmt.slice(m.index + m[0].length).trim() : "";
  return rest.length ? rest.split(/\s+/).filter((t) => !t.startsWith("-")) : [];
}

/**
 * Resolves the remote branch a push's positional arguments would land on,
 * following the same refspec rules `git push` itself follows.
 *
 * @param {string[]} positional The non-flag tokens after the `push` verb.
 * @param {string} currentBranch The branch currently checked out, used
 * whenever the push carries no explicit refspec or names `HEAD`.
 * @returns {string | null} The normalised remote branch name, or `null`.
 */
function pushTarget(positional, currentBranch) {
  const refspec = positional.length >= 2 ? positional[1] : undefined;
  let target;
  if (refspec === undefined) {
    target = currentBranch;
  } else {
    const stripped = refspec.replace(/^\+/, "");
    const colon = stripped.indexOf(":");
    if (colon === -1) target = stripped === "HEAD" ? currentBranch : stripped;
    else target = stripped.slice(colon + 1) || null;
  }
  return target ? target.replace(/^refs\/heads\//, "") : null;
}

module.exports = {
  /** kebab-case, unique, equals the filename without .js */
  id: "no-local-merge-to-base",

  /** one line, shown by `softela-ai doctor` */
  title: "Never merge or force-push into a base branch locally",

  /** which host events this rule can fire on */
  events: ["PreToolUse"],

  /** which tool names it applies to; null means every tool */
  tools: /^(Bash|PowerShell|shell|local_shell|exec_command|shell_command)$/,

  /** the strongest action this rule may ever return */
  defaultAction: "deny",

  /** which catalogue group this rule belongs to */
  group: "git",

  /**
   * Deliberately empty, not `["baseBranches"]`: an absent or empty
   * `baseBranches` already produces the same silent "nothing to compare
   * against" result inside this rule's own logic, with no substitute value
   * invented — so gating candidacy on it would add nothing but a mismatch
   * against `PROJECT_MINIMAL`, which declares `baseBranches: []` on purpose.
   */
  requiresConfig: [],

  /** optional: only active when this module is enabled */
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: "deny", reason: string, fix?: string}} The
   * decision.
   */
  evaluate(ctx) {
    const baseBranches = Array.isArray(ctx.project.baseBranches) ? ctx.project.baseBranches : [];
    if (baseBranches.length === 0) return pass();

    let branchInFlight = ctx.git.branch || "";

    for (const stmt of splitStatements(ctx.command)) {
      const target = switchTarget(stmt);
      if (target) branchInFlight = target;

      if (gitVerb(stmt, "merge") && baseBranches.includes(branchInFlight)) {
        return deny(
          "RULE: no local merge into a base branch. Base branches are reached only through a pull request and a squash merge.",
          "Open a pull request instead and let it land by squash merge.",
        );
      }

      if (
        gitVerb(stmt, "push") &&
        (hasFlag(stmt, "--force") || hasFlag(stmt, "--force-with-lease(?:=[^\\s]*)?"))
      ) {
        const target = pushTarget(pushPositionalArgs(stmt), ctx.git.branch || "");
        if (target && baseBranches.includes(target)) {
          return deny(
            "RULE: no force-push to a base branch. History there must never be rewritten outside review.",
            "Open a pull request instead and let it land by squash merge.",
          );
        }
      }
    }

    return pass();
  },
};
