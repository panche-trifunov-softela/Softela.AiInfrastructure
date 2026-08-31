"use strict";

/**
 * Flags a newly created branch whose name does not match the project's
 * naming convention.
 *
 * Only branch-creating invocations are in scope — `git checkout -b <name>`,
 * `git switch -c <name>`, `git branch <name>` — never a checkout or switch
 * onto a branch that already exists. Real branches on origin legitimately
 * vary in shape, so this rule never denies: an unset action defaults to
 * `ask`, and any configured action stronger than `ask` is treated as `ask`
 * as well.
 */

const { splitStatements, splitTokens } = require("../lib/shell-parse");
const { compile } = require("../lib/safe-regexp");
const { ask } = require("../lib/decision");

/**
 * Checks whether a token is a `-c`/`-C` global git flag — its value is a
 * separate following token rather than folded into the flag token itself
 * (`git -c x=y checkout -b name`).
 *
 * @param {string | undefined} token A dequoted statement token.
 * @returns {boolean} `true` for `-c` or `-C`.
 */
function isValueFlag(token) {
  return typeof token === "string" && /^-[cC]$/.test(token);
}

/**
 * Checks whether a token is an ordinary single- or double-dash flag whose
 * value, if any, is folded into the same token (`-q`, `--quiet`).
 *
 * @param {string | undefined} token A dequoted statement token.
 * @returns {boolean} `true` when the token opens with a single `-`.
 */
function isBareFlag(token) {
  return typeof token === "string" && /^-[^\s]+(?:=\S*)?$/.test(token);
}

/**
 * Extracts the requested branch name from a statement, when it creates one.
 *
 * Walks {@link splitTokens}'s fully dequoted token list by value, rather
 * than matching a regex against character positions in a masked copy of the
 * statement. That is what lets a quoted command word (`'git' checkout -b
 * name`), an ANSI-C quoted one, an `${IFS}`-joined one, or a
 * backslash-continued one all read identically to the plain spelling —
 * `splitTokens` already normalises every one of those shapes down to the
 * same token values.
 *
 * `checkout -b` and `switch -c` tolerate any short or long flag in between
 * (`-q`, `--quiet`). `git branch` only counts when its argument is a plain
 * name or the explicit `-f`/`--force` create-or-reset form; every other
 * leading flag — listing (`-a`/`-l`/`-v`), deleting (`-d`/`-D`), renaming
 * (`-m`/`-M`) — never matches.
 *
 * @param {string} statement A single, already-isolated shell statement.
 * @returns {string | null} The requested branch name, or `null` when the
 * statement does not create a new branch.
 */
function newBranchName(statement) {
  const tokens = splitTokens(statement);
  if (!tokens.length || !/^git$/i.test(tokens[0])) return null;

  let idx = 1;
  while (isValueFlag(tokens[idx])) idx += 2;

  const verb = tokens[idx];
  if (verb === undefined) return null;

  if (/^checkout$/i.test(verb) || /^switch$/i.test(verb)) {
    const wantFlag = /^checkout$/i.test(verb) ? "-b" : "-c";
    idx += 1;
    while (idx < tokens.length && isBareFlag(tokens[idx]) && !new RegExp(`^${wantFlag}$`, "i").test(tokens[idx])) {
      idx += 1;
    }
    if (idx < tokens.length && new RegExp(`^${wantFlag}$`, "i").test(tokens[idx])) {
      idx += 1;
      return idx < tokens.length ? tokens[idx] : null;
    }
    return null;
  }

  if (/^branch$/i.test(verb)) {
    idx += 1;
    if (idx >= tokens.length) return null;
    if (/^(?:-f|--force)$/i.test(tokens[idx])) {
      idx += 1;
      return idx < tokens.length ? tokens[idx] : null;
    }
    return tokens[idx].startsWith("-") ? null : tokens[idx];
  }

  return null;
}

module.exports = {
  id: "branch-naming",
  title: "New branches follow the team naming convention",
  events: ["PreToolUse"],
  tools: /^(Bash|PowerShell|shell|local_shell|exec_command|shell_command)$/,
  defaultAction: "ask",
  group: "git",
  requiresConfig: ["branchNaming.pattern"],
  requiresModule: null,

  evaluate(ctx) {
    const naming = ctx.project && ctx.project.branchNaming;
    if (!naming || typeof naming.pattern !== "string") return null;
    if (naming.action === "off") return null;

    const pattern = compile(naming.pattern);
    if (!pattern) return null;

    for (const statement of splitStatements(ctx.command)) {
      const name = newBranchName(statement);
      if (!name || pattern.test(name)) continue;

      const preferred = typeof naming.preferred === "string" ? naming.preferred : null;
      const reason =
        `Branch name "${name}" does not match this project's naming convention.` +
        (preferred ? ` Preferred shape: ${preferred}.` : "");
      return ask(reason, preferred ? `Rename to something like ${preferred}.` : undefined);
    }

    return null;
  },
};
