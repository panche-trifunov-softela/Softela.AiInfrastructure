"use strict";

/**
 * Advises — and, once a task's own tally proves it, denies — reading or
 * editing a bulk of the codebase directly instead of delegating it to a
 * subagent.
 *
 * Reading is the delegable activity that quietly stops being delegated. Two
 * kinds of read are legitimately the orchestrator's own and are never the
 * target here: reviewing what a subagent produced, and establishing the one
 * fact a decision actually turns on. Neither is distinguishable from any
 * other read at the point a hook sees it, so this rule does not try by
 * itself. Two independent signals feed the decision instead:
 *
 * - a shell command's own shape — a sweep across a tree, or a fistful of
 *   files opened in one command — the original, advisory-only heuristic;
 * - the current task's own file tally (`core/lib/task-tally.js`), counting
 *   distinct files this session has actually read or written since its last
 *   prompt. This is the tier that can escalate to a real denial, because it
 *   is evidence of what happened, not a guess about one command's shape.
 *
 * Two thresholds, read from the project config (`delegation.adviseAt` /
 * `delegation.denyAt`, defaulting to 5 and 15): at or above `denyAt` the
 * rule denies; at or above `adviseAt` it advises; below `adviseAt` it falls
 * back to exactly the shell-shape heuristic this rule always had, so nothing
 * that fired before this change stops firing.
 *
 * `deny` requires a trustworthy session key. When `ctx.sessionId` is `null`,
 * or `readTaskTally` returns `null`, this rule MUST NOT deny — it may advise
 * at most. Without a session key the counter cannot separate two concurrent
 * sessions working in one repository and would over-count, and an
 * over-count at the deny tier blocks a developer for no reason at all.
 * Under-counting only costs a missed nudge, which is the safe direction to
 * fail in — so every failure mode here (a missing log, an unreadable one, a
 * null tally, a missing threshold) is fail-open: it falls back to exactly
 * today's behaviour, never to something stricter.
 *
 * Softela departure from upstream: on Codex the tally tier never denies —
 * see {@link tallyBasedDecision} — because a Codex hook payload carries no
 * `agent_id` at all, so a Codex subagent's own bulk reading cannot be told
 * apart from the orchestrator's, and denying it would block exactly the
 * delegated work this rule exists to encourage.
 *
 * Advisory by construction at the `ask` tier: an `ask` from this rule never
 * blocks, on either host, because the shell-shape half of the guess is wrong
 * often enough that stopping the work over it alone would be indefensible.
 * The tally-backed `deny` tier is the one exception, and only once the
 * safety rule above is satisfied.
 *
 * Silent inside a delegated agent (`ctx.agentId` set): the advice is
 * addressed to an orchestrator deciding whether to read a survey itself or
 * spawn a subagent for it. A subagent cannot act on that advice — it has
 * nothing further to delegate to — and telling one to spawn a subagent of
 * its own is exactly the nested delegation `no-nested-delegation` forbids.
 *
 * Out of scope entirely: a command line that only drives version control.
 * Committing, staging, diffing and reading a log are neither reading nor
 * editing the codebase, and handing one to a subagent buys nothing, so they
 * are exempt before the tally is consulted at all — otherwise a task that
 * has legitimately read a lot cannot commit what it produced. `git grep` is
 * the exception, since it sweeps a tree exactly as a plain search does.
 *
 * A bounded search is not a survey: a statement whose output is piped into
 * `head`, `tail`, `wc`, or `sort` piped into one of those, caps what reaches
 * the context the same way the locator flags this rule already honours do,
 * so it reads as ordinary work rather than a sweep.
 */

const { pass, ask, deny } = require("../lib/decision");
const { splitStatements, splitTokens } = require("../lib/shell-parse");
const { readTaskTally } = require("../lib/task-tally");
const { isReadToolName } = require("../lib/read-tools");
const { isWriteToolName } = require("../lib/write-decode");

/** Shell tool names, on either host, whose command line this rule parses for a survey shape. */
const SHELL_TOOLS = /^(Bash|PowerShell|shell|local_shell|run_command|exec_command|shell_command)$/;

/**
 * Matches every tool name this rule's `evaluate` can reach a decision about:
 * a shell tool, whose command line is parsed for a survey shape, or a tool
 * shaped like a plain file read or write, judged purely on the task's own
 * tally with no command line to parse at all.
 */
const TOOLS = {
  /**
   * Tests one host tool name against every shape this rule can decide about.
   *
   * @param {string} toolName The tool name from `ctx.toolName`.
   * @returns {boolean} `true` when the name is a shell tool, or a
   * read/write-shaped tool this rule's tally check can judge.
   */
  test(toolName) {
    return SHELL_TOOLS.test(String(toolName || "")) || isReadToolName(toolName) || isWriteToolName(toolName);
  },
};

/**
 * The count, at or above which this rule advises, when the project config
 * declares nothing under `delegation.adviseAt`.
 */
const DEFAULT_ADVISE_AT = 5;

/**
 * The count, at or above which this rule denies, when the project config
 * declares nothing under `delegation.denyAt`.
 */
const DEFAULT_DENY_AT = 15;

/**
 * Reads one of this rule's two delegation thresholds from the project
 * config, falling back to this module's own default when the project
 * declares nothing — the same `requiresConfig`-free pattern
 * `doc-comment-style.js#configuredThreshold` uses: a fact this rule needs to
 * soften, not to run at all.
 *
 * @param {object} project The resolved (preset-merged) project config.
 * @param {"adviseAt"|"denyAt"} key Which threshold to read.
 * @param {number} fallback The value used when the project declares nothing.
 * @returns {number} The effective threshold.
 */
function configuredThreshold(project, key, fallback) {
  const value = project && project.delegation && project.delegation[key];
  return typeof value === "number" && value > 0 ? value : fallback;
}

/**
 * Decides purely from the current task's own file tally, independent of any
 * shell command shape — the same check applies whether this call is a shell
 * command or a plain file read/write.
 *
 * `deny` is only ever reached once BOTH a trustworthy `sessionId` and a
 * non-null tally are in hand — see this module's own doc comment for why an
 * untrustworthy session key must never be allowed to deny. Every other case
 * — no session id, no tally, a count below `adviseAt` — returns `null`,
 * leaving the caller free to fall back to the shell-shape heuristic.
 *
 * Softela departure from upstream: on Codex, a count that would otherwise
 * deny returns the `ask` tier instead. Codex sends no `agent_id` on any
 * call, so a subagent's own dispatches cannot be excluded from the tally
 * the way `readTaskTally` excludes them on Claude, and a subagent session
 * with no `UserPromptSubmit` marker of its own is counted from the start of
 * the day's log — denying it would block exactly the delegated work this
 * rule asks for.
 *
 * @param {object} ctx The evaluation context.
 * @param {number} adviseAt The count at or above which this rule advises.
 * @param {number} denyAt The count at or above which this rule denies.
 * @returns {null | {action: "deny"|"ask", reason: string, fix: string}} The
 * decision, or `null` when the tally does not warrant one.
 */
function tallyBasedDecision(ctx, adviseAt, denyAt) {
  const sessionId = typeof ctx.sessionId === "string" && ctx.sessionId.length > 0 ? ctx.sessionId : null;
  const tally = sessionId ? readTaskTally(ctx.agent, sessionId) : null;
  if (!tally) return null;

  const count = Math.max(tally.filesRead, tally.filesWritten);
  if (count < adviseAt) return null;

  if (sessionId && count >= denyAt) {
    if (ctx.agent === "codex") {
      return ask(
        `DELEGATION: this task has read or written ${count} files directly, at or past the ${denyAt}-file limit ` +
          "configured for this project. Codex sends no per-call agent id, so a subagent's own reading cannot be " +
          "told apart from the orchestrator's here — this stays advice rather than a denial.",
        "Spawn a subagent to finish the survey or the bulk edit, and keep its conclusion, not its file dumps.",
      );
    }

    return deny(
      `DELEGATION: this task has read or written ${count} files directly, at or past the ${denyAt}-file limit ` +
        "configured for this project. That is exactly the survey or bulk edit a subagent exists to do.",
      "Spawn a subagent to finish the survey or the bulk edit, and keep its conclusion, not its file dumps.",
    );
  }

  return ask(
    `DELEGATION: this task has read or written ${count} files directly, at or past the ${adviseAt}-file advisory ` +
      "threshold configured for this project. Reading or editing this much of the codebase yourself is exactly " +
      "the work a subagent exists to do.",
    "Spawn a subagent for the rest of the survey or the bulk edit and keep its conclusion, not its file dumps — " +
      "unless this is review of a subagent's own output, or the one fact the decision turns on, both of which are " +
      "yours to read.",
  );
}

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

/** The command word whose statements this rule treats as version control rather than as reading. */
const VERSION_CONTROL_COMMAND = "git";

/**
 * Git subcommands that survey file contents rather than manage revisions.
 *
 * `git grep` sweeps a tree exactly as a plain search does, so it stays in
 * scope; everything else git does is bookkeeping over revisions.
 */
const VERSION_CONTROL_SURVEY_SUBCOMMANDS = new Set(["grep"]);

/** Statements that only move the shell, carrying no read or write of their own. */
const NEUTRAL_COMMANDS = new Set(["cd"]);

/**
 * Resolves the subcommand a version-control statement names.
 *
 * @param {string[]} tokens The statement's tokens, command word included.
 * @returns {string} The subcommand, lower-cased, or `""` when none is named.
 */
function subcommandOf(tokens) {
  for (const token of tokens.slice(1)) {
    const arg = bareArgument(token);
    if (!arg || arg.startsWith("-")) continue;
    return arg.toLowerCase();
  }
  return "";
}

/**
 * Decides whether a command line does nothing but drive version control.
 *
 * Committing, staging, diffing and reading a log are not reading or editing
 * a bulk of the codebase, and handing one to a subagent buys nothing at all
 * — so a command line made only of those is outside this rule's scope,
 * whatever the task's tally has reached. A `cd` alongside them is ignored:
 * it moves the shell and reads nothing, and a repository command is almost
 * always written with one in front.
 *
 * A statement that is neither is enough to bring the whole line back into
 * scope, so a survey cannot be smuggled through by prefixing it with a
 * commit.
 *
 * @param {string} commandLine The full command line.
 * @returns {boolean} `true` when every statement is version control or a
 * shell move, and at least one of them is version control.
 */
function isVersionControlOnly(commandLine) {
  const statements = splitStatements(commandLine).filter((statement) => commandWordOf(statement) !== "");
  if (statements.length === 0) return false;

  let sawVersionControl = false;

  for (const statement of statements) {
    const command = commandWordOf(statement);
    if (NEUTRAL_COMMANDS.has(command)) continue;
    if (command !== VERSION_CONTROL_COMMAND) return false;
    if (VERSION_CONTROL_SURVEY_SUBCOMMANDS.has(subcommandOf(splitTokens(statement)))) return false;
    sawVersionControl = true;
  }

  return sawVersionControl;
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
  tools: TOOLS,

  /** the strongest action this rule may ever return */
  defaultAction: "deny",

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
   * @returns {null | {action: "deny"|"ask", reason: string, fix?: string}}
   * The decision, or `null` when neither the task's own tally nor the
   * command's shape (for a shell call) reads like a survey.
   */
  evaluate(ctx) {
    if (ctx.agentId) return pass();

    const isShellCall = SHELL_TOOLS.test(String(ctx.toolName || ""));
    const isFileCall = isReadToolName(ctx.toolName) || isWriteToolName(ctx.toolName);
    if (!isShellCall && !isFileCall) return pass();

    // Version control is neither reading nor editing a bulk of the
    // codebase, so it is out of scope before the tally is even consulted —
    // otherwise a task that has legitimately read a lot cannot commit what
    // it produced without delegating the commit, which buys nothing.
    if (isShellCall && isVersionControlOnly(String(ctx.command || ""))) return pass();

    const adviseAt = configuredThreshold(ctx.project, "adviseAt", DEFAULT_ADVISE_AT);
    const denyAt = configuredThreshold(ctx.project, "denyAt", DEFAULT_DENY_AT);

    const tallyDecision = tallyBasedDecision(ctx, adviseAt, denyAt);
    if (tallyDecision) return tallyDecision;

    // A plain file read/write has no command line to parse — its only
    // signal is the tally checked above. Only a shell call falls through to
    // today's shape-based heuristic.
    if (!isShellCall) return pass();

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
