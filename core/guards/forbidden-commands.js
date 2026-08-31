"use strict";

/**
 * Blocks shell commands a project has explicitly forbidden, and commands
 * that run a test suite living under a path another team owns.
 *
 * The pattern, action and reason for a forbidden command, and the owned
 * paths themselves, all come from `ctx.project` — no project-specific fact
 * is written here. A project that declares neither `commands.forbidden` nor
 * `notOurs` gives this rule nothing to do.
 *
 * Telling "reads a notOurs path" apart from "runs it" needs a little
 * generic infrastructure of its own — a runtime launcher, a `test` verb —
 * the same way the git exemption a few lines below is generic shell
 * knowledge, not a fact about any one repository. A statement hidden behind
 * a nested-shell wrapper (`bash -c`, `powershell -Command`, …) is unwrapped
 * by `shell-parse.splitStatements` itself, so this rule sees it for free.
 */

const { deny, ask, pass } = require("../lib/decision");
const { hasCommand, splitStatements } = require("../lib/shell-parse");
const { compile } = require("../lib/safe-regexp");
const { globToRegex } = require("../lib/project-resolver");

/** Tool names this rule evaluates — shell invocations on either host. */
const SHELL_TOOLS = /^(Bash|PowerShell|shell|local_shell|exec_command|shell_command)$/;

/**
 * Runtime launchers that execute whatever path follows them regardless of
 * that path's own name — recognizing them is what lets `node
 * cypress/e2e/x.js` or `npx mocha cypress/e2e/x.js` read as execution even
 * though neither mentions the word "test". These are generic
 * interpreter/launcher names, true of any project that uses that runtime —
 * never one repository's own build quirk, the way `git` a few lines below
 * is already a universal exemption rather than a project fact.
 */
const RUNTIME_LAUNCHERS = new Set([
  "node",
  "npx",
  "deno",
  "bun",
  "python",
  "python3",
  "ruby",
  "dotnet",
  "java",
]);

/**
 * Splits a statement into whitespace-separated tokens, stripping one
 * matching pair of wrapping quotes from each so a quoted path or launcher
 * still compares as itself.
 *
 * @param {string} statement One shell statement.
 * @returns {string[]} The tokens, in order.
 */
function tokenize(statement) {
  return statement
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/^(["'])([\s\S]*)\1$/, "$2"));
}

/**
 * Decides whether a statement executes its arguments rather than merely
 * reading or reporting on them — the distinction the notOurs backstop needs
 * so `cat` / `grep` / `Get-Content` against a path passes while a runtime
 * launcher or a bare `test` verb targeting the same path does not.
 *
 * @param {string[]} tokens The statement's tokens.
 * @returns {boolean} `true` when the statement looks like it runs code.
 */
function looksLikeExecution(tokens) {
  if (tokens.length === 0) return false;
  if (RUNTIME_LAUNCHERS.has(tokens[0].toLowerCase())) return true;
  return tokens.some((t) => !t.includes("/") && !t.includes("\\") && t.toLowerCase() === "test");
}

/**
 * Builds the decision a configured action maps to.
 *
 * @param {string} action `"deny"`, `"ask"` or `"off"`, as configured on the
 * forbidden-command entry.
 * @param {string} reason The reason to report to the developer.
 * @param {string} [fix] The corrected next step, when the config supplies
 * one.
 * @returns {null | {action: string, reason: string, fix?: string}} The
 * decision, or `null` when the action is `"off"` or unrecognized.
 */
function decisionFor(action, reason, fix) {
  if (action === "deny") return deny(reason, fix);
  if (action === "ask") return ask(reason, fix);
  return null;
}

/**
 * Derives an unanchored, substring-matching regex from a glob, by reusing
 * the project resolver's glob-to-regex conversion rather than
 * re-implementing glob syntax here.
 *
 * @param {string} glob A glob pattern such as `"cypress/**"`.
 * @returns {RegExp | null} A case-insensitive regex matching the glob as a
 * path fragment anywhere in a string, or `null` when the glob does not
 * compile.
 */
function globToFragmentRegex(glob) {
  const anchored = globToRegex(glob);
  if (!anchored) return null;
  const fragment = anchored.source.replace(/^\^/, "").replace(/\$$/, "");
  try {
    return new RegExp(fragment, "i");
  } catch {
    return null;
  }
}

module.exports = {
  id: "forbidden-commands",
  title: "Block project-declared forbidden commands and other teams' test suites",
  events: ["PreToolUse"],
  tools: SHELL_TOOLS,
  defaultAction: "deny",
  group: "git",
  // Fires from either commands.forbidden OR notOurs, which requiresConfig's
  // all-of-these-paths semantics cannot express; the rule's own emptiness
  // checks already produce the same silence without inventing anything.
  requiresConfig: [],
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: string, reason: string, fix?: string}} The
   * decision, or `null` when nothing configured applies.
   */
  evaluate(ctx) {
    const project = ctx.project || {};
    const forbidden =
      project.commands && Array.isArray(project.commands.forbidden) ? project.commands.forbidden : [];
    const notOurs = Array.isArray(project.notOurs) ? project.notOurs : [];
    if (forbidden.length === 0 && notOurs.length === 0) return pass();

    const statements = splitStatements(ctx.command);

    for (const statement of statements) {
      for (const entry of forbidden) {
        if (!entry || typeof entry.pattern !== "string" || !compile(entry.pattern)) continue;
        if (!hasCommand(statement, entry.pattern)) continue;
        const result = decisionFor(
          entry.action || "deny",
          entry.reason || "This command is forbidden in this project.",
          entry.fix,
        );
        if (result) return result;
      }

      // A git operation reads or records history; it never executes a test
      // suite, so it is exempt from the notOurs backstop below regardless of
      // what its commit message or diff happens to mention.
      if (notOurs.length === 0 || hasCommand(statement, "git")) continue;
      if (!looksLikeExecution(tokenize(statement))) continue;

      for (const glob of notOurs) {
        const fragment = globToFragmentRegex(glob);
        if (fragment && fragment.test(statement)) {
          return deny(
            `${glob} is owned by another team; this repository does not run or maintain those tests.`,
            "Let the owning team run this suite, or ask them before touching it.",
          );
        }
      }
    }

    return pass();
  },
};
