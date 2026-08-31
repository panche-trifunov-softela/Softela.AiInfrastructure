"use strict";

/**
 * Guards `ctx.project.localConfig` against a machine-specific host reaching a
 * file git tracks.
 *
 * Some frontend repositories here keep runtime configuration in a tracked
 * file that names the DEPLOYED hosts. The cure this rule enforces is a
 * second, gitignored, per-machine file the dev server prefers when it
 * exists: a developer's own local retarget belongs there, never in the
 * tracked file, because a tracked file reaches everyone the moment it lands
 * on a base branch.
 *
 * Two routes, mirroring `protected-paths.js`:
 *
 * - Route A stops a write from INTRODUCING the value into the tracked file —
 *   it compares the new content against what is already on disk, so it never
 *   nags on an unrelated edit to a file that already happens to sit in local
 *   mode.
 *
 * - Route B stops a shell command from SHIPPING a value that is already
 *   there. Two adversarial review rounds went through this route trying to
 *   resolve a shell command's working directory and pathspecs well enough to
 *   tell exactly which files a `git add` covers — a `cd ..` from a
 *   one-segment repo root, a `cd` wrapped in a subshell purely to keep it
 *   from touching the outer shell, `cd -`/`pushd`, and so on. Each round
 *   fixed the reported idiom and the next round found another one, because
 *   resolving arbitrary shell working-directory semantics from static
 *   command text is an unbounded surface: every wrong guess about the cwd is
 *   either a bypass or a false alarm.
 *
 *   Route B is rebuilt on a different, unspoofable signal instead: whether
 *   the tracked file currently offends is a FACT, read straight off disk,
 *   never a guess about what a shell string will do. It never resolves a
 *   `cd`, a pathspec, or a working directory at all — see `evaluateShell`.
 *   The trade this makes deliberately: a bare `git add` that stages the
 *   tracked file, with no `git commit` anywhere in the same command, now
 *   produces nothing, because nothing has shipped yet. The next `git commit`
 *   sees the file in `ctx.git.staged()` and fires there instead — the file
 *   never leaves the working tree unnoticed, it is only ever caught one
 *   command later than before.
 *
 * Silent in a repository that declares no `localConfig` entry at all — that
 * is what keeps this rule safe to install where nobody has configured it
 * yet, and it fails open on every I/O or parsing problem along the way: an
 * unreadable file, a missing repository root, a malformed entry, or a
 * pattern that will not compile all produce a pass, never a throw.
 */

const { splitStatements, splitTokens } = require("../lib/shell-parse");
const { deny, ask, severity } = require("../lib/decision");
const { compileAll } = require("../lib/safe-regexp");
const { toPosix, relativeToRepo, joinRepoPath } = require("../lib/repo-path");

/** Tool names this rule treats as a file write. */
const FILE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|edit_file|write_file)$/;

/** Tool names this rule treats as a shell invocation. */
const SHELL_TOOLS = /^(Bash|PowerShell|shell|local_shell|exec_command|shell_command)$/;

/** Every pathspec git treats as "stage the whole working tree". */
const BLANKET_TARGETS = new Set(["-A", "--all", ".", "./", "./."]);

/**
 * A universal local-host marker, fixed in code rather than configured: any
 * line naming `localhost`, an address in `127.0.0.0/8`, `0.0.0.0`, or the
 * IPv6 loopback (bare or bracketed, the form a URL uses —
 * `https://[::1]:7237`) is naming a machine that is never the same machine
 * twice, so it can never be a legitimate deployed host.
 */
const LOCAL_HOST_MARKER_RE = new RegExp(
  [
    "\\blocalhost\\b",
    "\\b127(?:\\.(?:25[0-5]|2[0-4]\\d|1?\\d{1,2})){3}\\b",
    "\\b0\\.0\\.0\\.0\\b",
    "\\[::1\\]",
    "(?<![0-9a-fA-F:])::1(?![0-9a-fA-F:])",
  ].join("|"),
  "i",
);

/**
 * Checks whether a token is a `-c`/`-C` global git flag, whose value is a
 * separate following token rather than folded into the flag token itself
 * (`git -c x=y add -A`).
 *
 * @param {string} token A dequoted statement token.
 * @returns {boolean} `true` for `-c` or `-C`.
 */
function isValueFlag(token) {
  return /^-[cC]$/.test(token);
}

/**
 * Checks whether a token is an ordinary single-dash or double-dash flag.
 *
 * @param {string} token A dequoted statement token.
 * @returns {boolean} `true` when the token opens with a single `-`.
 */
function isBareFlag(token) {
  return /^-[^\s]+(?:=\S*)?$/.test(token);
}

/**
 * Checks whether a bare flag turns on `git commit`'s "stage everything at
 * commit time" behaviour — `-a`, `--all`, or a combined short form such as
 * `-am`.
 *
 * @param {string} token A dequoted statement token.
 * @returns {boolean} `true` when the token is a commit-time stage-all flag.
 */
function isCommitAllFlag(token) {
  if (/^--all$/i.test(token)) return true;
  return /^-[^\s-]*a[^\s-]*$/i.test(token);
}

/**
 * Walks a statement's tokens past `git` and any global flags, to the
 * subcommand token that follows.
 *
 * @param {string[]} tokens The statement's dequoted tokens.
 * @returns {{verb: string, argsStart: number} | null} The subcommand and the
 * index its own arguments start at, or `null` when the statement is not a
 * `git` invocation.
 */
function gitSubcommand(tokens) {
  if (!tokens.length || !/^git$/i.test(tokens[0])) return null;
  let idx = 1;
  for (;;) {
    const token = tokens[idx];
    if (token === undefined) return null;
    if (isValueFlag(token)) {
      idx += 2;
      continue;
    }
    if (isBareFlag(token)) {
      idx += 1;
      continue;
    }
    break;
  }
  return { verb: tokens[idx], argsStart: idx + 1 };
}

/**
 * Checks whether a statement invokes `git add`, in any form at all.
 *
 * Deliberately does not look at what it adds — see this module's doc block
 * and {@link evaluateShell} for why presence alone, next to a `git commit`
 * for an already-offending tracked file, is treated as enough.
 *
 * @param {string} statement A single, already-isolated shell statement.
 * @returns {boolean} `true` when the statement is a `git add` invocation.
 */
function isGitAdd(statement) {
  const sub = gitSubcommand(splitTokens(statement));
  return Boolean(sub && /^add$/i.test(sub.verb || ""));
}

/**
 * Checks whether a statement is a `git add` that sweeps the whole working
 * tree — one of {@link BLANKET_TARGETS} present anywhere among its
 * pathspecs. Unambiguous no matter where the shell happens to be sitting,
 * which is what makes it safe to recognise without resolving a working
 * directory at all.
 *
 * @param {string} statement A single, already-isolated shell statement.
 * @returns {boolean} `true` when the statement is a whole-tree `git add`.
 */
function isBlanketAdd(statement) {
  const tokens = splitTokens(statement);
  const sub = gitSubcommand(tokens);
  if (!sub || !/^add$/i.test(sub.verb || "")) return false;
  return tokens.slice(sub.argsStart).some((token) => BLANKET_TARGETS.has(token));
}

/**
 * Reads a `git commit` statement's own flags, to tell whether it stages
 * everything at commit time.
 *
 * @param {string} statement A single, already-isolated shell statement.
 * @returns {{isAll: boolean} | null} The parsed form, or `null` when the
 * statement is not `git commit`.
 */
function gitCommitInfo(statement) {
  const tokens = splitTokens(statement);
  const sub = gitSubcommand(tokens);
  if (!sub || !/^commit$/i.test(sub.verb || "")) return null;

  let isAll = false;
  for (let idx = sub.argsStart; idx < tokens.length; idx += 1) {
    if (isCommitAllFlag(tokens[idx])) isAll = true;
  }
  return { isAll };
}

/**
 * Checks whether a repository-relative path git reports as staged names a
 * configured tracked file. A plain, case-insensitive equality is enough
 * here — unlike a `git add` pathspec, `ctx.git.staged()` always reports a
 * concrete file, never a directory, so there is no ancestor case to fold in.
 *
 * @param {string} stagedPath A path from `ctx.git.staged()`.
 * @param {string} trackedPath The entry's configured `tracked` path.
 * @returns {boolean} `true` when they name the same file.
 */
function isTrackedPath(stagedPath, trackedPath) {
  const s = toPosix(stagedPath).replace(/^\.\/+/, "").toLowerCase();
  const t = toPosix(trackedPath).replace(/^\.\/+/, "").toLowerCase();
  return s === t;
}

/**
 * Compiles a `localConfig` entry's optional pattern list, dropping anything
 * that fails to compile rather than letting a malformed project file take
 * the rule down.
 *
 * @param {string[] | undefined} patterns The regular expression sources.
 * @returns {RegExp[]} The successfully compiled patterns.
 */
function compilePatternList(patterns) {
  return compileAll(patterns).regexps;
}

/**
 * Checks whether a single line offends: it does not match an `allowedLines`
 * pattern, and it either carries a {@link LOCAL_HOST_MARKER_RE} marker or
 * matches a `switches` pattern.
 *
 * @param {string} line One line of the file's content.
 * @param {RegExp[]} allowedRes The entry's compiled `allowedLines` patterns.
 * @param {RegExp[]} switchRes The entry's compiled `switches` patterns.
 * @returns {boolean} `true` when the line is an offence.
 */
function lineOffends(line, allowedRes, switchRes) {
  if (allowedRes.some((re) => re.test(line))) return false;
  return LOCAL_HOST_MARKER_RE.test(line) || switchRes.some((re) => re.test(line));
}

/**
 * Checks whether a whole block of content, read as it currently stands,
 * offends — used by route B, which cares only about what a command would
 * actually commit, not about what is new since the last read.
 *
 * @param {string | null} content The file's current content.
 * @param {object} entry The `localConfig` entry to check against.
 * @returns {boolean} `true` when some line offends.
 */
function contentOffends(content, entry) {
  if (content === null || content === undefined) return false;
  const allowedRes = compilePatternList(entry.allowedLines);
  const switchRes = compilePatternList(entry.switches);
  return String(content)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .some((line) => lineOffends(line, allowedRes, switchRes));
}

/**
 * Checks whether a Write/Edit's new content introduces an offending line
 * that was not already present, verbatim, on disk — the suppression that
 * keeps route A from firing on every unrelated edit to a file that already
 * happens to sit in local mode. When the current content cannot be read,
 * every offending line counts as newly introduced.
 *
 * @param {object} ctx The evaluation context.
 * @param {object} entry The `localConfig` entry to check against.
 * @returns {boolean} `true` when the new content introduces an offence.
 */
function newContentOffends(ctx, entry) {
  const allowedRes = compilePatternList(entry.allowedLines);
  const switchRes = compilePatternList(entry.switches);

  const existingRaw = ctx.readFile(ctx.filePath);
  const existingLines =
    existingRaw === null || existingRaw === undefined
      ? null
      : new Set(String(existingRaw).replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()));

  // R3 decision: kept on ctx.content, not resultingContent — this function's
  // own doc comment already states the intent ("introduces ... not already
  // present, verbatim, on disk"); the existingLines suppression right above
  // is what makes scoping to only what this write inserts correct, rather
  // than an oversight.
  const lines = String(ctx.content || "").replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    if (!lineOffends(line, allowedRes, switchRes)) continue;
    if (existingLines !== null && existingLines.has(line.trim())) continue;
    return true;
  }
  return false;
}

/**
 * Resolves a `localConfig` entry's configured `action` to a decision, or
 * `null` for an `"off"` entry.
 *
 * @param {object} entry The `localConfig` entry.
 * @param {string} reason The reason to report, already resolved against the
 * entry's own `reason` override.
 * @param {string} fix The fix to report.
 * @returns {object | null} The decision.
 */
function buildDecision(entry, reason, fix) {
  const action = entry.action || "deny";
  if (action === "off") return null;
  return action === "deny" ? deny(reason, fix) : ask(reason, fix);
}

/**
 * Builds route A's reason and fix for one entry.
 *
 * @param {object} entry The `localConfig` entry.
 * @returns {{reason: string, fix: string}} The pair to hand to
 * {@link buildDecision}.
 */
function routeAMessage(entry) {
  return {
    reason:
      entry.reason ||
      `${entry.tracked} is tracked by git, so a machine-specific host committed here reaches everyone who pulls it.`,
    fix: `Put the local value in ${entry.perMachine} instead — it is per-machine and never shipped.`,
  };
}

/**
 * Builds route B's reason and fix for one entry.
 *
 * @param {object} entry The `localConfig` entry.
 * @returns {{reason: string, fix: string}} The pair to hand to
 * {@link buildDecision}.
 */
function routeBMessage(entry) {
  return {
    reason: entry.reason || `${entry.tracked} currently points at a local machine, and this command would commit it.`,
    fix: `Restore the deployed value in ${entry.tracked} and keep the local one in ${entry.perMachine}.`,
  };
}

/**
 * Evaluates a file-write tool call: pass on the per-machine file always,
 * inspect the tracked file's new content for an introduced offence, pass on
 * every other path.
 *
 * @param {object} ctx The evaluation context.
 * @param {object[]} entries The project's `localConfig` entries.
 * @returns {object | null} The most severe decision, or `null`.
 */
function evaluateFileWrite(ctx, entries) {
  if (!ctx.filePath) return null;
  const repoRoot = ctx.git && ctx.git.repoRoot;
  const rel = relativeToRepo(ctx.filePath, repoRoot).toLowerCase();

  for (const entry of entries) {
    const perMachineRel = toPosix(entry.perMachine).replace(/^\.\/+/, "").toLowerCase();
    if (rel === perMachineRel) return null;
  }

  let best = null;
  for (const entry of entries) {
    if ((entry.action || "deny") === "off") continue;
    const trackedRel = toPosix(entry.tracked).replace(/^\.\/+/, "").toLowerCase();
    if (rel !== trackedRel) continue;
    if (!newContentOffends(ctx, entry)) continue;

    const { reason, fix } = routeAMessage(entry);
    const decision = buildDecision(entry, reason, fix);
    if (decision && (!best || severity(decision.action) > severity(best.action))) best = decision;
  }
  return best;
}

/**
 * Evaluates a shell tool call against the tracked file's actual, current
 * content — never against a resolved working directory or pathspec. See
 * this module's doc block for why.
 *
 * Step 1: an entry whose tracked file does not currently offend is dropped
 * before `ctx.command` is parsed at all — the property that makes this rule
 * safe to leave switched on, since it can never misfire on ordinary shell
 * syntax when the file itself is clean.
 *
 * Step 2: for whichever entries remain, a `git commit` anywhere in the
 * command line ships the offence when the tracked file is already in
 * `ctx.git.staged()`, OR the command line also contains a `git add`
 * statement in any form, OR the commit stages everything itself
 * (`-a`/`--all`/a bundled `-a…`, excluding long options so `--message` never
 * false-positives).
 *
 * Step 3: with no `git commit` anywhere in the line, a whole-tree `git add`
 * (`-A`, `--all`, `.`, `./`, `./.`) still produces an `ask` — a warning that
 * the next commit will ship the offending file, never stronger than that,
 * and never louder than the entry's own configured action.
 *
 * @param {object} ctx The evaluation context.
 * @param {object[]} entries The project's `localConfig` entries.
 * @returns {object | null} The most severe decision, or `null`.
 */
function evaluateShell(ctx, entries) {
  const repoRoot = ctx.git && ctx.git.repoRoot ? toPosix(ctx.git.repoRoot).replace(/\/+$/, "") : null;

  const offending = entries.filter((entry) => {
    if ((entry.action || "deny") === "off") return false;
    const trackedFilePath = repoRoot ? joinRepoPath(repoRoot, entry.tracked) : toPosix(entry.tracked);
    return contentOffends(ctx.readFile(trackedFilePath), entry);
  });
  if (!offending.length) return null;

  const statements = splitStatements(ctx.command);
  const commitInfos = statements.map(gitCommitInfo).filter(Boolean);

  if (!commitInfos.length) {
    if (!statements.some(isBlanketAdd)) return null;
    let best = null;
    for (const entry of offending) {
      const { reason, fix } = routeBMessage(entry);
      const decision = ask(reason, fix);
      if (!best || severity(decision.action) > severity(best.action)) best = decision;
    }
    return best;
  }

  const staged = ctx.git && typeof ctx.git.staged === "function" ? ctx.git.staged() : [];
  const commandShipsEverything = statements.some(isGitAdd) || commitInfos.some((info) => info.isAll);

  let best = null;
  for (const entry of offending) {
    const shipped = commandShipsEverything || staged.some((p) => isTrackedPath(p, entry.tracked));
    if (!shipped) continue;

    const { reason, fix } = routeBMessage(entry);
    const decision = buildDecision(entry, reason, fix);
    if (decision && (!best || severity(decision.action) > severity(best.action))) best = decision;
  }
  return best;
}

module.exports = {
  id: "local-config-isolation",
  title: "Machine-specific configuration never lands in a tracked file",
  events: ["PreToolUse"],
  tools: null,
  defaultAction: "deny",
  group: "git",
  requiresConfig: ["localConfig"],
  requiresModule: null,

  evaluate(ctx) {
    try {
      const raw = ctx.project && ctx.project.localConfig;
      const entries = (Array.isArray(raw) ? raw : []).filter(
        (e) => e && typeof e.tracked === "string" && e.tracked && typeof e.perMachine === "string" && e.perMachine,
      );
      if (!entries.length) return null;

      const toolName = String(ctx.toolName || "");
      if (FILE_TOOLS.test(toolName)) return evaluateFileWrite(ctx, entries);
      if (SHELL_TOOLS.test(toolName)) return evaluateShell(ctx, entries);
      return null;
    } catch {
      return null;
    }
  },
};
