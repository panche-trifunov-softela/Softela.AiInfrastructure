"use strict";

/**
 * Classifies a file path as newly introduced, already existing, or unknown,
 * relative to a git repository — the signal `core/engine.js` uses to soften
 * a `newCodeOnly` rule's structural expectations from a requirement into
 * advice for code that predates the standard.
 *
 * Nothing here shells out until `classifyChange` is actually called, and
 * every git call is wrapped the same way `core/lib/git-state.js`'s own
 * `runGit` is: a short timeout, stdout only, and a `try`/`catch` that turns
 * any failure into `null` rather than an exception. A private `runGit` is
 * written here, in the same shape, instead of importing `git-state.js`'s —
 * that module keeps its helper unexported by design, and this one needs a
 * different argument list (an explicit `cwd` per call, not one bound at
 * construction) to run several distinct git subcommands against the same
 * repository root.
 */

const path = require("path");
const { execFileSync } = require("child_process");

/**
 * Runs a git subcommand, never throwing.
 *
 * @param {string} cwd The working directory to run git in.
 * @param {string[]} args The git arguments.
 * @returns {string | null} The trimmed stdout, or `null` on any failure —
 * including git itself being absent from `PATH`, `cwd` not being a
 * repository, or the subcommand simply reporting "no match" (a `git
 * ls-files --error-unmatch` miss, for instance).
 */
function runGit(cwd, args) {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    return null;
  }
}

/**
 * Normalises a path to forward slashes — the separator git itself always
 * speaks in its own output, even on Windows.
 *
 * @param {string} p The path to normalise.
 * @returns {string} The same path with every backslash replaced.
 */
function toPosix(p) {
  return String(p || "").replace(/\\/g, "/");
}

/**
 * Strips a single layer of surrounding double quotes git sometimes wraps a
 * path in (e.g. a path containing a space or a non-ASCII character).
 *
 * This does not undo git's own backslash/octal escaping inside such a
 * quoted path — a real escaped byte sequence would still read as literal
 * characters afterward. That is an accepted, narrow gap: every path this
 * module is ever asked to classify comes from `ctx.filePath`, which the host
 * tool already gave as a plain string, so the destination side of a rename
 * git prints back is expected to match without needing full C-style
 * unescaping.
 *
 * @param {string} raw The path text as git printed it.
 * @returns {string} The path with one layer of quoting removed, when present.
 */
function stripQuotes(raw) {
  const s = String(raw || "").trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

/**
 * Resolves a file path to one relative to a repository root, forward-slash
 * normalised.
 *
 * @param {string} repoRoot The repository root, as reported by `ctx.git`.
 * @param {string} filePath The file path to relativise; absolute, or
 * already relative to `repoRoot`.
 * @returns {string | null} The relative path, or `null` when `filePath`
 * resolves outside `repoRoot`, or either input is unusable.
 */
function relativeToRepo(repoRoot, filePath) {
  if (!repoRoot || !filePath) return null;
  try {
    const rel = path.isAbsolute(filePath)
      ? path.relative(repoRoot, filePath)
      : path.relative(repoRoot, path.resolve(repoRoot, filePath));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return toPosix(rel);
  } catch {
    return null;
  }
}

/**
 * Extracts the destination paths of every staged rename or copy entry from
 * `git status --porcelain=v1 -M --untracked-files=all` output. Each such
 * line is `XY ORIG -> DEST`, where `X` or `Y` is `R` or `C`; every other
 * line (a plain modification, an untracked "??" entry, ...) is ignored.
 *
 * @param {string | null} output The command's trimmed stdout.
 * @returns {Set<string>} The destination paths, forward-slash, relative to
 * the repository root.
 */
function parseStatusRenameDestinations(output) {
  const destinations = new Set();
  if (!output) return destinations;
  for (const line of output.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const statusCodes = line.slice(0, 2);
    if (!/[RC]/.test(statusCodes)) continue;
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    if (arrow === -1) continue;
    destinations.add(toPosix(stripQuotes(rest.slice(arrow + 4))));
  }
  return destinations;
}

/**
 * Extracts the destination paths of every rename or copy entry from `git
 * diff -M -C --name-status HEAD` output. Each such line is `R###\tORIG\tDEST`
 * or `C###\tORIG\tDEST`, tab-separated; every other status letter (`A`, `D`,
 * `M`, ...) carries only one path and is ignored.
 *
 * @param {string | null} output The command's trimmed stdout.
 * @returns {Set<string>} The destination paths, forward-slash, relative to
 * the repository root.
 */
function parseNameStatusRenameDestinations(output) {
  const destinations = new Set();
  if (!output) return destinations;
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    if (!/^[RC]/.test(fields[0])) continue;
    destinations.add(toPosix(stripQuotes(fields[2])));
  }
  return destinations;
}

/**
 * Per-repository-root cache of the two whole-repository git calls a miss on
 * the cheap tracked check falls back to, so a hook process classifying
 * several paths against the same repository only ever pays for `git status`
 * and `git diff` once. Never cleared: the processes that build this (a
 * `PreToolUse` hook dispatch) are one-shot and short-lived, so an unbounded
 * map never accumulates enough entries to matter — the same reasoning
 * `core/lib/workdir.js`'s own `repoRootCache` states for itself.
 *
 * @type {Map<string, {staged: Set<string>, committed: Set<string>}>}
 */
const renameDestinationsCache = new Map();

/**
 * Per-repository-root cache of the whole repository's tracked file set, so
 * classifying many paths against the same repository — an N-file
 * `apply_patch`, in particular — pays for one `git ls-files` invocation
 * total instead of one per path. Before this cache, step 1's "tracked" check
 * ran `git ls-files --error-unmatch -- <path>` once per call, which turned
 * evaluating an N-file patch into roughly N synchronous git subprocesses in
 * series (about 40ms each) — comfortably enough to blow through the
 * 5-second `PreToolUse` hook timeout on its own. Never cleared, for the same
 * reason {@link renameDestinationsCache} is not.
 *
 * @type {Map<string, Set<string>>}
 */
const trackedFilesCache = new Map();

/**
 * Resolves, and caches, the full set of paths `git ls-files` reports as
 * tracked in a repository — every path forward-slash normalised, relative to
 * `repoRoot`.
 *
 * @param {string} repoRoot The repository root to run git in.
 * @returns {Set<string>} The tracked paths. Empty when git itself is
 * unavailable or `repoRoot` is not a repository — {@link runGit} degrades to
 * `null` rather than throwing, which resolves here to an empty set, the same
 * "nothing found tracked" answer a failed per-path lookup used to give.
 */
function trackedFilesFor(repoRoot) {
  const cached = trackedFilesCache.get(repoRoot);
  if (cached) return cached;

  const out = runGit(repoRoot, ["ls-files"]);
  const tracked = new Set();
  if (out) {
    for (const line of out.split(/\r?\n/)) {
      if (line) tracked.add(toPosix(stripQuotes(line)));
    }
  }
  trackedFilesCache.set(repoRoot, tracked);
  return tracked;
}

/**
 * Resolves, and caches, the rename/copy destination sets for a repository
 * root: one parsed from a staged `git status`, one parsed from `git diff`
 * against `HEAD`.
 *
 * @param {string} repoRoot The repository root to run git in.
 * @returns {{staged: Set<string>, committed: Set<string>}} The two
 * destination sets.
 */
function renameDestinationsFor(repoRoot) {
  const cached = renameDestinationsCache.get(repoRoot);
  if (cached) return cached;

  const statusOut = runGit(repoRoot, ["status", "--porcelain=v1", "-M", "--untracked-files=all"]);
  const diffOut = runGit(repoRoot, ["diff", "-M", "-C", "--name-status", "HEAD"]);

  const result = {
    staged: parseStatusRenameDestinations(statusOut),
    committed: parseNameStatusRenameDestinations(diffOut),
  };
  renameDestinationsCache.set(repoRoot, result);
  return result;
}

/**
 * Classifies a file path as newly introduced, already existing, or unknown
 * to a git repository.
 *
 * Resolution order, first answer wins:
 * 1. **Tracked** — present in {@link trackedFilesFor}'s cached `git
 *    ls-files` listing → `"existing"`. The common case, and the cheapest:
 *    once a path has ever been staged (a plain new file included) it is
 *    "tracked" by this definition, so a `git mv` destination or a freshly
 *    `git add`ed copy is already caught here without needing the
 *    rename/copy parsing below.
 * 2. **Staged rename or copy** — an `R`/`C` entry in `git status
 *    --porcelain=v1 -M --untracked-files=all` whose destination is this path
 *    → `"existing"`.
 * 3. **Rename or copy against `HEAD`** — an `R`/`C` entry in `git diff -M -C
 *    --name-status HEAD` whose destination is this path → `"existing"`.
 * 4. Repository known, path resolvable, none of the above matched →
 *    `"new"`.
 * 5. No repository root, or the path cannot be made relative to the
 *    repository root → `"unknown"`, decided before any git call runs.
 *
 * Git being entirely unavailable (no binary on `PATH`) is not a separate
 * branch: every call below degrades to `null`/empty through {@link runGit},
 * so resolution simply falls through to step 4, `"new"`, rather than to
 * step 5's `"unknown"`. That is harmless — see the next paragraph — and
 * `"unknown"` is reserved for the narrower cases above where the *input*
 * already makes resolution impossible, before git is ever consulted.
 *
 * `"unknown"` MUST be treated by every caller exactly like `"new"` — never
 * having proved a file pre-exists must never soften a rule. This is the
 * fail-closed direction this function's uncertain answer always takes, and
 * it is why falling through to `"new"` instead of `"unknown"` when git is
 * unavailable changes nothing observable: both values mean the same thing
 * to every caller.
 *
 * @param {string} filePath The file path to classify; absolute, or already
 * relative to `git.repoRoot`.
 * @param {{repoRoot: string | null}} git The lazy git state (`ctx.git`);
 * only its `repoRoot` getter is read.
 * @returns {"new" | "existing" | "unknown"} The classification. Never
 * throws, and never mutates the repository — every git call used here is
 * read-only.
 */
function classifyChange(filePath, git) {
  try {
    const repoRoot = git && git.repoRoot;
    if (!repoRoot) return "unknown";

    const rel = relativeToRepo(repoRoot, filePath);
    if (!rel) return "unknown";

    if (trackedFilesFor(repoRoot).has(rel)) return "existing";

    const { staged, committed } = renameDestinationsFor(repoRoot);
    if (staged.has(rel) || committed.has(rel)) return "existing";

    return "new";
  } catch {
    return "unknown";
  }
}

module.exports = { classifyChange };
