"use strict";

/**
 * Resolves which directory the rest of the infrastructure treats as "the
 * working directory" for a tool call, independent of whichever directory
 * the host process happened to inherit when the hook was launched.
 *
 * A hook payload's own `cwd` field names where the AGENT was started, not
 * necessarily where the edited file or the nested shell command actually
 * lives — a multi-repo checkout under one parent directory makes those two
 * routinely differ. Everything here degrades gracefully instead of
 * throwing: a bad or missing candidate is simply skipped, never propagated
 * as an exception.
 */

const fs = require("fs");
const path = require("path");
const shellParse = require("./shell-parse");

/**
 * Tests whether a value is a usable absolute-path candidate.
 *
 * @param {*} value The candidate to test.
 * @returns {boolean} `true` when `value` is a non-empty string that
 * `path.isAbsolute` accepts.
 */
function isUsableAbsolute(value) {
  return typeof value === "string" && value.length > 0 && path.isAbsolute(value);
}

/**
 * Tests whether a path exists on disk and is a directory, never throwing.
 *
 * @param {string} dir The path to test.
 * @returns {boolean} `true` when `dir` exists and is a directory.
 */
function isExistingDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walks up from a file path's own directory to the nearest ancestor
 * directory that actually exists on disk, stopping at the filesystem root.
 *
 * Starts at `path.dirname(filePath)`, never at `filePath` itself — a file
 * about to be created does not exist yet, so testing the file path would
 * always fail even when its parent directory is perfectly usable.
 *
 * @param {string} filePath An absolute file path.
 * @returns {string | null} The nearest existing ancestor directory, or
 * `null` when nothing up to the filesystem root exists.
 */
function nearestExistingAncestor(filePath) {
  let dir = path.dirname(filePath);
  for (;;) {
    if (isExistingDirectory(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolves the working directory to anchor project and git resolution on,
 * from whichever of a tool call's candidate locations is actually usable.
 *
 * Flow:
 * 1. `filePath`, when a non-empty absolute path — its nearest existing
 *    ancestor directory (the file itself may not exist yet, so its
 *    directory chain is tested instead).
 * 2. `opCwd`, when a non-empty absolute path naming an existing directory —
 *    a nested operation's own working directory (for example, a Codex
 *    `exec` call's inner shell operation).
 * 3. `payloadCwd`, when a non-empty absolute path naming an existing
 *    directory — the host's own top-level `cwd` field.
 * 4. `process.cwd()`, as the last resort.
 *
 * A relative candidate is skipped outright at every step: a relative path
 * cannot anchor anything without already knowing the working directory,
 * which is exactly the question this function answers.
 *
 * @param {{filePath?: *, opCwd?: *, payloadCwd?: *}} candidates The anchor
 * candidates, in priority order. Any shape, including `null`/`undefined`.
 * @returns {string} An absolute directory path. Never throws.
 */
function resolveWorkdir(candidates) {
  try {
    const c = candidates && typeof candidates === "object" ? candidates : {};

    if (isUsableAbsolute(c.filePath)) {
      const ancestor = nearestExistingAncestor(path.resolve(c.filePath));
      if (ancestor) return ancestor;
    }

    if (isUsableAbsolute(c.opCwd)) {
      const resolved = path.resolve(c.opCwd);
      if (isExistingDirectory(resolved)) return resolved;
    }

    if (isUsableAbsolute(c.payloadCwd)) {
      const resolved = path.resolve(c.payloadCwd);
      if (isExistingDirectory(resolved)) return resolved;
    }
  } catch {
    // Fall through to process.cwd() below.
  }
  return process.cwd();
}

/**
 * Memoises {@link findRepoRoot} results, keyed by the resolved input
 * directory. Never cleared: the processes that call this (a `PreToolUse`
 * hook dispatch) are one-shot and short-lived, so an unbounded map never
 * accumulates enough entries to matter.
 */
const repoRootCache = new Map();

/**
 * Finds the nearest ancestor directory containing a `.git` entry, walking
 * up from `dir` and stopping at the filesystem root.
 *
 * Accepts `.git` being either a directory (an ordinary clone) or a file (a
 * git worktree or submodule, whose `.git` holds a `gitdir: <path>` pointer
 * instead) — either is sufficient evidence that the directory is a
 * repository root; this function does not need to read the file's content
 * to answer "is this a repository root", only "does `.git` exist here".
 *
 * @param {string} dir The directory to start walking up from.
 * @returns {string | null} The repository root, or `null` when no ancestor
 * up to the filesystem root has a `.git` entry. Never throws.
 */
function findRepoRoot(dir) {
  try {
    if (typeof dir !== "string" || !dir) return null;
    const start = path.resolve(dir);
    if (repoRootCache.has(start)) return repoRootCache.get(start);

    let current = start;
    let found = null;
    for (;;) {
      if (fs.existsSync(path.join(current, ".git"))) {
        found = current;
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    repoRootCache.set(start, found);
    return found;
  } catch {
    return null;
  }
}

/**
 * Shell verbs {@link collectStatementCandidates} treats as changing the
 * shell's own working directory when they lead a statement.
 *
 * Covers both a POSIX shell's spellings (`cd`, `pushd`) and PowerShell's:
 * `Set-Location` and its built-in aliases `sl` and `chdir`, plus
 * `Push-Location`. Every entry is compared against {@link commandVerb}'s
 * lower-cased, extension-stripped output, so the mixed-case cmdlet spelling
 * a real PowerShell session shows on screen (`Set-Location`) still matches
 * the lower-case entry stored here.
 */
const CWD_VERBS = new Set(["cd", "pushd", "set-location", "sl", "chdir", "push-location"]);

/**
 * Directory-naming flags recognised for specific package-manager verbs,
 * keyed by the command's own normalised verb (see {@link commandVerb}).
 */
const PACKAGE_MANAGER_DIR_FLAGS = {
  npm: ["--prefix", "-C"],
  yarn: ["--cwd"],
  pnpm: ["-C"],
};

/** Extensions {@link collectStatementCandidates} treats as a `dotnet` project or solution target. */
const DOTNET_TARGET_RE = /\.(?:csproj|sln)$/i;

/**
 * Flags recognised on ANY command line, not only a specific tool's own —
 * `--cwd` and `--project` are common enough across unrelated CLIs that
 * requiring a matching verb would miss more real usage than it would guard
 * against.
 */
const GENERIC_DIR_FLAGS = ["--cwd", "--project"];

/**
 * Reduces an argv element naming a command to the verb {@link
 * collectStatementCandidates} matches against — its basename, a Windows
 * executable extension stripped, lower-cased — so `/usr/bin/git`, `git`,
 * `Git.exe` and `npm.cmd` all compare equal to their plain verb.
 *
 * @param {string} token The command's own leading argv element.
 * @returns {string} The normalised verb, or `""` when `token` is not a
 * usable string.
 */
function commandVerb(token) {
  if (typeof token !== "string" || !token) return "";
  return path
    .basename(token)
    .replace(/\.(?:exe|cmd|bat)$/i, "")
    .toLowerCase();
}

/**
 * Reads the value of a `--flag value` or `--flag=value` pair at a given
 * token position.
 *
 * @param {string[]} tokens The statement's dequoted tokens.
 * @param {number} index The index to test — either the flag's own token
 * (the `--flag=value` form) or a token equal to `flagName` (the `--flag
 * value` form, whose value is the following token).
 * @param {string} flagName The flag's own spelling, e.g. `"--cwd"`.
 * @returns {string | null} The flag's value, or `null` when `tokens[index]`
 * does not name `flagName` in either form, or the space form has no
 * following token.
 */
function flagValueAt(tokens, index, flagName) {
  const token = tokens[index];
  if (token === flagName) return index + 1 < tokens.length ? tokens[index + 1] : null;
  if (token.startsWith(`${flagName}=`)) return token.slice(flagName.length + 1) || null;
  return null;
}

/**
 * Collects every raw directory/file candidate a single, already-tokenised
 * statement names, per the forms {@link extractShellWorkdir} recognises.
 *
 * @param {string[]} tokens The statement's dequoted tokens, from {@link
 * module:./shell-parse.splitTokens}.
 * @param {string[]} out The accumulator every raw candidate string is
 * pushed onto, in order.
 * @returns {void}
 */
function collectStatementCandidates(tokens, out) {
  if (!tokens.length) return;
  const verb = commandVerb(tokens[0]);

  if (CWD_VERBS.has(verb) && tokens.length > 1) out.push(tokens[1]);

  if (verb === "git") {
    for (let i = 1; i < tokens.length; i += 1) {
      if (tokens[i] === "-C" && i + 1 < tokens.length) out.push(tokens[i + 1]);
    }
  }

  const packageManagerFlags = PACKAGE_MANAGER_DIR_FLAGS[verb];
  if (packageManagerFlags) {
    for (let i = 0; i < tokens.length; i += 1) {
      for (const flagName of packageManagerFlags) {
        const value = flagValueAt(tokens, i, flagName);
        if (value) out.push(value);
      }
    }
  }

  if (verb === "dotnet") {
    for (let i = 1; i < tokens.length; i += 1) {
      if (DOTNET_TARGET_RE.test(tokens[i])) out.push(tokens[i]);
    }
  }

  for (let i = 0; i < tokens.length; i += 1) {
    for (const flagName of GENERIC_DIR_FLAGS) {
      const value = flagValueAt(tokens, i, flagName);
      if (value) out.push(value);
    }
  }
}

/**
 * Resolves one raw candidate string to an existing directory, anchored
 * against a base directory when the candidate is relative.
 *
 * A candidate naming an existing FILE (a `.csproj`, a `.sln`, or anything
 * else `dotnet` might be pointed at) resolves to that file's own containing
 * directory, not the file path itself — every caller of this function
 * anchors project and git resolution on a directory.
 *
 * @param {string} raw The candidate, exactly as tokenised out of the
 * command line.
 * @param {string} anchor The absolute directory a relative candidate
 * resolves against.
 * @returns {string | null} The resolved absolute directory, or `null` when
 * `raw` is empty, or resolves to a path that does not exist on disk, or
 * exists as neither a directory nor a file.
 */
function resolveCandidateDirectory(raw, anchor) {
  try {
    if (typeof raw !== "string" || !raw.trim()) return null;
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(anchor, raw);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return abs;
    if (stat.isFile()) return path.dirname(abs);
    return null;
  } catch {
    return null;
  }
}

/**
 * Extracts the single working directory a shell command line names, so a
 * rule can resolve `project` and `git` against the repository a command
 * actually targets instead of whichever directory the agent process itself
 * happened to be launched from.
 *
 * Recognised forms:
 *
 * - `cd <dir>` and `pushd <dir>`, at the start of a statement — including
 *   `cd <dir> && <command>`, already split apart by {@link
 *   module:./shell-parse.splitStatements} before this ever runs.
 * - The PowerShell equivalents of the same two verbs: `Set-Location <dir>`
 *   and its aliases `sl <dir>`/`chdir <dir>`, and `Push-Location <dir>`.
 * - `git -C <dir> <verb>`.
 * - `npm --prefix <dir>`, `npm -C <dir>`, `yarn --cwd <dir>`, `pnpm -C
 *   <dir>`.
 * - `dotnet <path-to-csproj-or-sln>` and `dotnet <verb> <path>` — any token
 *   after `dotnet` ending in `.csproj` or `.sln`.
 * - `--cwd <dir>` and `--project <path>`, recognised as a generic flag on
 *   ANY command, not only the ones listed above.
 *
 * Deliberately NOT recognised: a bare relative path with no leading verb or
 * flag at all (too ambiguous to say it names a directory rather than some
 * other argument), a directory named only inside a later pipeline stage or
 * a background job, and any flag spelling beyond the ones listed above —
 * extending the list later is safe, but guessing at an unlisted spelling
 * risks matching a flag some other tool gives an unrelated meaning.
 *
 * A command naming more than one DISTINCT resolved directory, or naming
 * none at all, deliberately resolves to nothing — picking between two
 * repositories would be a guess, and a wrong guess applies every
 * project-scoped rule to the wrong project, which is worse than the
 * current miss this function exists to fix. The same distinct-directory
 * check is what lets naming the SAME directory twice (`cd A && npm
 * --prefix A run build`) resolve cleanly, rather than reading as two
 * candidates.
 *
 * @param {string} command The raw command line.
 * @param {string} cwd The absolute directory a relative candidate resolves
 * against — normally the working directory the shell itself would actually
 * run in.
 * @returns {string | null} The single resolved absolute directory, or
 * `null` when `command` names no directory, names more than one distinct
 * directory, or nothing on disk backs the only candidate found. Never
 * throws.
 */
function extractShellWorkdir(command, cwd) {
  try {
    const str = typeof command === "string" ? command : "";
    if (!str.trim()) return null;
    const anchor = isUsableAbsolute(cwd) ? path.resolve(cwd) : process.cwd();

    const rawCandidates = [];
    for (const statement of shellParse.splitStatements(str)) {
      collectStatementCandidates(shellParse.splitTokens(statement), rawCandidates);
    }
    if (!rawCandidates.length) return null;

    const resolved = new Set();
    for (const raw of rawCandidates) {
      const dir = resolveCandidateDirectory(raw, anchor);
      if (dir) resolved.add(dir);
    }

    return resolved.size === 1 ? resolved.values().next().value : null;
  } catch {
    return null;
  }
}

module.exports = { resolveWorkdir, findRepoRoot, extractShellWorkdir };
