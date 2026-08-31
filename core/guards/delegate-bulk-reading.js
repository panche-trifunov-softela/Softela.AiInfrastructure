"use strict";

/**
 * Advises delegating a survey of the codebase instead of reading it into the
 * orchestrator's own context.
 *
 * Reading is the delegable activity that quietly stops being delegated. Two
 * kinds of read are legitimately the orchestrator's own and are never the
 * target here: reviewing what a subagent produced, and establishing the one
 * fact a decision actually turns on. Neither is distinguishable from any
 * other read at the point a hook sees it, so this rule does not try. What it
 * recognises instead is shape: a command that sweeps a whole tree, or opens
 * a fistful of files in one go, is a survey — and a survey is what a
 * subagent is for.
 *
 * Advisory by construction. It never blocks, on either host: the guess it
 * makes is a good one often enough to be worth saying and wrong often enough
 * that stopping the work over it would be indefensible.
 *
 * Silent inside a delegated agent (`ctx.agentId` set): the advice is
 * addressed to an orchestrator deciding whether to read a survey itself or
 * spawn a subagent for it. A subagent cannot act on that advice — it has
 * nothing further to delegate to — and telling one to spawn a subagent of
 * its own is exactly the nested delegation `no-nested-delegation` forbids.
 *
 * A bounded search is not a survey: a statement whose output is piped into
 * `head`, `tail`, `wc`, or `sort` piped into one of those, caps what reaches
 * the context the same way the locator flags this rule already honours do,
 * so it reads as ordinary work rather than a sweep.
 */

const { pass, ask } = require("../lib/decision");
const { splitStatements, splitTokens } = require("../lib/shell-parse");

/** Commands that read file contents rather than searching them. */
const READ_COMMANDS = new Set(["cat", "head", "tail", "bat", "type"]);

/** Commands that search across files. */
const SEARCH_COMMANDS = new Set(["grep", "rg", "ripgrep", "ack", "ag", "findstr", "select-string"]);

/**
 * How many distinct file arguments one read command may name before it stops
 * looking like "open the file I am working on" and starts looking like a
 * survey. Four is deliberately past the point of an ordinary read: a rule
 * that fires on opening a file and its test would be switched off inside a
 * day, and then it would advise nothing at all.
 */
const MANY_FILES = 4;

/** Flags that make a search recursive, in the spellings the real tools use. */
const RECURSIVE_FLAGS = /^-(?:r|R|-recursive)$|^-[a-zA-Z]*r[a-zA-Z]*$/;

/**
 * Flags that turn a search into a locator: it reports which files matched,
 * or how many times, and never the surrounding content.
 *
 * These are the cheap search an orchestrator is supposed to run — the answer
 * is a handful of paths, not a tree's worth of source — so a sweep carrying
 * one of them is not what this rule is looking for.
 */
const LOCATOR_FLAGS = /^-(?:l|L|c)$|^--(?:files-with-matches|files-without-match|count)$/;

/**
 * Strips a token down to the argument it carries, dropping the redirection
 * and pipe punctuation `splitTokens` leaves in place.
 *
 * @param {string} token One token.
 * @returns {string} The token, or `""` when it is punctuation.
 */
function bareArgument(token) {
  if (!token || /^[|;&<>()]+$/.test(token)) return "";
  return token.replace(/^["']|["']$/g, "");
}

/**
 * Counts the distinct file-shaped arguments a command names.
 *
 * A file-shaped argument is anything that is not a flag and carries either a
 * separator or an extension. A bare word is not counted: `head -n 5 output`
 * naming a variable, a heredoc label or a subcommand must not read as a
 * fourth file.
 *
 * @param {string[]} tokens The command's tokens, command word included.
 * @returns {number} How many distinct file arguments were named.
 */
function countFileArguments(tokens) {
  const files = new Set();
  for (const token of tokens.slice(1)) {
    const arg = bareArgument(token);
    if (!arg || arg.startsWith("-")) continue;
    if (!/[/\\]/.test(arg) && !/\.[A-Za-z0-9]+$/.test(arg)) continue;
    files.add(arg);
  }
  return files.size;
}

/**
 * Decides whether a search command sweeps a tree rather than one file.
 *
 * A recursive flag is the clearest signal. `rg` needs no flag — it is
 * recursive by default — so it counts as a sweep whenever it names no file
 * argument at all, or names only a directory.
 *
 * A locator flag settles it the other way first, whatever else the command
 * says: `rg -l Thing src/components` sweeps a tree and comes back with a
 * short list of paths, which is the search this rule wants an orchestrator
 * to keep running.
 *
 * @param {string} command The command word, lowercased.
 * @param {string[]} tokens The command's tokens.
 * @returns {boolean} `true` when this searches across a tree.
 */
function isTreeSearch(command, tokens) {
  const args = tokens.slice(1).map(bareArgument).filter(Boolean);
  if (args.some((arg) => LOCATOR_FLAGS.test(arg))) return false;
  if (args.some((arg) => arg.startsWith("-") && RECURSIVE_FLAGS.test(arg))) return true;

  if (command !== "rg" && command !== "ripgrep") return false;

  const positional = args.filter((arg) => !arg.startsWith("-"));
  if (positional.length <= 1) return true;
  return positional.slice(1).every((arg) => !/\.[A-Za-z0-9]+$/.test(arg));
}

/**
 * Commands whose output caps what a piped-into survey can put in the
 * context — the same bound `LOCATOR_FLAGS` already grants a search that
 * reports only file names or a count.
 */
const BOUNDING_COMMANDS = new Set(["head", "tail", "wc"]);

/** A command that only bounds a stream when ITS OWN output feeds a {@link BOUNDING_COMMANDS} stage next. */
const SORT_COMMAND = "sort";

/**
 * Resolves a statement's own command word, the same way {@link findSurvey}
 * does: lower-cased, with any path prefix stripped.
 *
 * @param {string} statement A single, already-isolated shell statement.
 * @returns {string} The command word, or `""` when the statement is empty.
 */
function commandWordOf(statement) {
  const tokens = splitTokens(statement);
  if (tokens.length === 0) return "";
  return bareArgument(tokens[0]).replace(/^.*[/\\]/, "").toLowerCase();
}

/**
 * Checks whether the statement(s) immediately following a survey-shaped
 * statement bound its output before it can reach the context.
 *
 * `splitStatements` returns a pipeline's stages as separate, flat entries in
 * the order they appear — `grep -rn Pattern dir | head -30` comes back as
 * two entries, `"grep -rn Pattern dir"` and `"head -30"`, never as one
 * string still carrying the pipe. A bounding stage is therefore found by
 * looking at what follows a survey statement in that flat list, not by
 * searching the survey statement's own text for a pipe character, which
 * would never be there to find. This cannot tell a genuine pipe apart from
 * an unrelated statement that merely happens to follow on `;`/`&&`/`||` —
 * the same flattening loses that distinction either way — so this errs
 * toward treating the coincidence as bounded, consistent with the rest of
 * this rule favouring silence over a false positive.
 *
 * @param {string[]} statements The full flat statement list.
 * @param {number} index The index of the survey-shaped statement.
 * @returns {boolean} `true` when the next statement — or the one after an
 * intervening bare `sort` — is a {@link BOUNDING_COMMANDS} command.
 */
function isBoundedByFollowing(statements, index) {
  let i = index + 1;
  if (i < statements.length && commandWordOf(statements[i]) === SORT_COMMAND) i += 1;
  return i < statements.length && BOUNDING_COMMANDS.has(commandWordOf(statements[i]));
}

/**
 * Finds the first statement in a command line that reads like a survey.
 *
 * @param {string} commandLine The full command line.
 * @returns {{kind: "search" | "files", command: string, count: number} | null}
 * What was recognised, or `null` when nothing was.
 */
function findSurvey(commandLine) {
  const statements = splitStatements(commandLine);

  for (let i = 0; i < statements.length; i += 1) {
    const tokens = splitTokens(statements[i]);
    if (tokens.length === 0) continue;

    const command = bareArgument(tokens[0]).replace(/^.*[/\\]/, "").toLowerCase();

    if (SEARCH_COMMANDS.has(command) && isTreeSearch(command, tokens)) {
      if (isBoundedByFollowing(statements, i)) continue;
      return { kind: "search", command, count: 0 };
    }

    if (READ_COMMANDS.has(command)) {
      const count = countFileArguments(tokens);
      if (count >= MANY_FILES) {
        if (isBoundedByFollowing(statements, i)) continue;
        return { kind: "files", command, count };
      }
    }
  }
  return null;
}

module.exports = {
  /** kebab-case, unique, equals the filename without .js */
  id: "delegate-bulk-reading",

  /** one line, shown by `softela-ai doctor` */
  title: "Survey the codebase with a subagent rather than in your own context",

  /** which host events this rule can fire on */
  events: ["PreToolUse"],

  /** which tool names it applies to; null means every tool */
  tools: /^(Bash|PowerShell|shell|local_shell|run_command|exec_command|shell_command)$/,

  /** the strongest action this rule may ever return */
  defaultAction: "ask",

  /**
   * Never a decision the developer has to take, and never a reason to stop
   * the work: what it recognises is a shape, and the same shape is produced
   * by reviewing a subagent's output. Surfaced as advice on both hosts; see
   * `core/engine.js`'s step 10.
   */
  advisoryAsk: true,

  /** which catalogue group this rule belongs to */
  group: "agent",

  /** dotted project-config paths this rule needs to be meaningful */
  requiresConfig: [],

  /** only meaningful where delegation is the operating model */
  requiresModule: "agent-orchestration",

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: "ask", reason: string, fix?: string}} The
   * advice, or `null` when the command reads like ordinary work.
   */
  evaluate(ctx) {
    if (ctx.agentId) return pass();

    const commandLine = String(ctx.command || "");
    if (!commandLine) return pass();

    const survey = findSurvey(commandLine);
    if (!survey) return pass();

    if (survey.kind === "search") {
      return ask(
        `DELEGATION: "${survey.command}" is sweeping a whole tree here. A survey of the codebase is the ` +
          "work a subagent exists to do, and reading it in yourself spends the context the rest of the task needs.",
        "Spawn a read-only subagent for the survey and keep its conclusion, not its file dumps — unless this is " +
          "review of a subagent's own output, or the one fact the decision turns on, both of which are yours to read.",
      );
    }

    return ask(
      `DELEGATION: this opens ${survey.count} files in one command. Reading a set of files is delegated by ` +
        "default, and the orchestrator's context is the thing that runs out first.",
      "Spawn a subagent to read them and report back — unless you are reviewing what a subagent already " +
        "produced, which is yours to read.",
    );
  },
};
