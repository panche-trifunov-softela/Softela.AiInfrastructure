"use strict";

/**
 * Resolves the on-disk memory directory and reads the tiny fixed set of
 * command-line arguments every `memory-as-context` hook script accepts.
 *
 * Deliberately self-contained: it is copied alongside its three callers into
 * a single installed directory and required only as a sibling (`./memory-location`),
 * never reaching into `core/lib`. The installed layout that would make a
 * cross-boundary require safe is not settled yet (see the module's README),
 * so every module hook script stays independent of it, exactly like the
 * scripts this module generalises.
 */

const fs = require("fs");
const path = require("path");

/**
 * Parses `--key=value` arguments, ignoring anything that does not match.
 *
 * @param {string[]} argv The raw argument list, typically `process.argv.slice(2)`.
 * @returns {Record<string, string>} Parsed key/value pairs.
 */
function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([a-zA-Z0-9-]+)=([\s\S]*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Walks upward from a directory to find the nearest git repository root.
 *
 * A host payload's `cwd`/`workspace`/`working_directory` field is untrusted
 * wire data — nothing about the hook protocol guarantees it is a string —
 * and `path.resolve` throws a `TypeError` on any other type, so an adversarial
 * or malformed value degrades to "no repository found" here rather than
 * propagating an uncaught exception to every caller.
 *
 * @param {string} startDir The directory to start searching from.
 * @returns {string | null} The first ancestor (inclusive) containing a
 * `.git` entry, or `null` when none is found before reaching the filesystem
 * root, or when `startDir` cannot be resolved to a path at all.
 */
function findGitRoot(startDir) {
  let dir;
  try {
    dir = path.resolve(startDir);
  } catch {
    return null;
  }
  for (;;) {
    try {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
    } catch {
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Sanitises a name for safe use as a single path segment.
 *
 * @param {string} name The raw name, typically a repository's basename.
 * @returns {string} The name with every character outside
 * `[a-zA-Z0-9_.-]` replaced by `-`, lower-cased.
 */
function sanitize(name) {
  return String(name || "")
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .toLowerCase();
}

/** The directory name a "repo"-located memory lives in, inside the product repository. */
const REPO_LOCATION_DIRNAME = ".softela-ai-memory";

/**
 * The subdirectory of the agent home this tool already owns for its own
 * installed files (`core/lib/paths.js`'s `installedRoot`) — never a
 * directory a developer manages by hand. Only the `"infrastructure"`
 * location's per-project layout nests under this. `"global"` deliberately
 * targets `<agentHome>/memory` directly, outside this directory: it is the
 * agent's own memory directory, the one each agent already loads by
 * convention, and this tool contributes files to it rather than maintaining
 * a parallel store nobody reads. That directory may already exist, already
 * hold a developer's own hand-maintained content, and already be its own
 * git repository — this tool shares it, it does not own it. See
 * {@link isSharedMemoryDir}.
 */
const TOOL_OWNED_DIRNAME = "softela-ai";

/** The directory name every host-home-located memory lives under, directly (`"global"`) or per project (`"infrastructure"`, inside {@link TOOL_OWNED_DIRNAME}). */
const HOME_LOCATION_DIRNAME = "memory";

/**
 * The directory name Codex's own native memory feature uses under its agent
 * home — plural, one character away from {@link HOME_LOCATION_DIRNAME}.
 * `resolveMemoryDir` must never produce this path for any location; this
 * constant exists so that guarantee has a single, named, greppable value to
 * check it against, instead of the collision being implicit in two string
 * literals that happen not to match today.
 */
const CODEX_NATIVE_MEMORIES_DIRNAME = "memories";

/**
 * The location a hook assumes when it was invoked with no `--location=`
 * flag at all.
 *
 * Deliberately NOT `module.json`'s declared default (`"global"`), and the
 * asymmetry is the whole point:
 *
 * - A real installation always bakes the flag into every registered hook
 *   command, so this value only ever applies to a hand-run invocation or a
 *   registration that lost its flag.
 *
 * - In that state nobody has actually said where memory lives, and the safe
 *   answer is the directory this tool owns outright — never the one it
 *   merely shares with whatever a developer already keeps in
 *   `<agentHome>/memory`. Guessing `"global"` here would point a write, or a
 *   guard, at a populated knowledge base on the strength of a missing
 *   argument.
 */
const UNSPECIFIED_LOCATION = "infrastructure";

/**
 * Resolves the memory directory for the current invocation.
 *
 * Flow:
 * - `"global"` — the agent's own global memory directory, shared with
 *   whatever a developer already keeps there: `<agentHome>/memory`.
 * - `"repo"` — inside the product repository itself, so it travels with the
 *   repo and never needs the agent home at all:
 *   `<repoRoot>/.softela-ai-memory`. Falls back to `"global"` when `cwd` is not
 *   inside a git repository, since there is no repository to put it in.
 * - anything else (including `"infrastructure"`) — a per-project folder
 *   inside the tool's own directory, never the developer's:
 *   `<agentHome>/softela-ai/memory/<sanitized repo basename, or "default">`.
 *
 * @param {{agentHome: string, cwd: string, location?: string}} options
 * `agentHome` is the resolved agent home directory, baked in at install
 * time; `cwd` is the working directory the current tool call is running
 * against; `location` is one of `"repo"`, `"infrastructure"`, `"global"`.
 * @returns {string} The absolute memory directory path. Never equal to
 * `<agentHome>/memories` — Codex's own native memory directory, one
 * character away from {@link HOME_LOCATION_DIRNAME} — a guarantee that holds
 * by construction here (this function only ever joins the literal
 * `"memory"`, never derives it), asserted directly in this module's test
 * suite rather than re-checked on every call, matching every other function
 * in this file's fail-open style over a throwing runtime guard.
 */
function resolveMemoryDir({ agentHome, cwd, location }) {
  if (location === "global") return path.join(agentHome, HOME_LOCATION_DIRNAME);

  const repoRoot = findGitRoot(cwd);

  if (location === "repo") {
    return repoRoot ? path.join(repoRoot, REPO_LOCATION_DIRNAME) : path.join(agentHome, HOME_LOCATION_DIRNAME);
  }

  const projectId = repoRoot ? sanitize(path.basename(repoRoot)) : "default";
  return path.join(agentHome, TOOL_OWNED_DIRNAME, HOME_LOCATION_DIRNAME, projectId);
}

/**
 * Answers whether a resolved memory directory is one this tool merely
 * shares with a developer's own hand-maintained content, as opposed to one
 * it owns outright.
 *
 * The `"global"` location (`<agentHome>/memory`) is the one shared case: it
 * may already exist, already hold a developer's own files, and already be
 * its own git repository, none of which this tool put there. `"repo"` and
 * `"infrastructure"` both nest under {@link TOOL_OWNED_DIRNAME}, a directory
 * this tool owns outright and may freely restructure.
 *
 * Every caller about to do something destructive or structural — reinitialise
 * a git repository, touch its config or remote, rewrite an enclosing
 * repository's exclude file — must consult this instead of re-deriving the
 * same `location === "global"` check locally; this function is the single
 * source of truth for that distinction.
 *
 * @param {string} dir The resolved memory directory to classify.
 * @param {string} agentHome The resolved agent home directory.
 * @returns {boolean} `true` when `dir` is exactly the agent's own global
 * memory directory; `false` for a tool-owned location, or when either path
 * cannot be resolved.
 */
function isSharedMemoryDir(dir, agentHome) {
  try {
    const a = path.resolve(String(dir)).replace(/\\/g, "/").toLowerCase();
    const b = path.resolve(String(agentHome), HOME_LOCATION_DIRNAME).replace(/\\/g, "/").toLowerCase();
    return a === b;
  } catch {
    return false;
  }
}

/**
 * Ensures a memory directory that sits inside some enclosing git repository
 * (the product repository for `"repo"` locations, or an unrelated ancestor
 * such as a dotfiles repo rooted at the home directory) is excluded from
 * that repository's tracking, without touching the developer's own
 * `.gitignore`.
 *
 * A plain `.gitignore` written inside the memory directory itself was
 * tried first and rejected: once the directory becomes its own nested git
 * repository (see `memory-autocommit.js`), a `.gitignore` living inside it
 * governs that nested repository's own tracking too, and a blanket `*`
 * pattern silently ignores everything the directory exists to version —
 * `git add -A` inside the nested repo would stage nothing at all. Writing
 * the exclusion into the *enclosing* repository's own
 * `.git/info/exclude` — the standard, git-native way to exclude a path
 * locally without a tracked `.gitignore` entry — avoids that conflict
 * entirely, because it is read only by the enclosing repository, never by
 * the nested one.
 *
 * Never runs for a shared (`isSharedMemoryDir`) directory. Excluding a path
 * from an enclosing repository's tracking is only sensible for a directory
 * this tool owns and may restructure; for the agent's own global memory
 * directory it would mean writing into a repository the tool does not own
 * (a dotfiles repo, say) on behalf of content the tool did not create —
 * pointless when that directory is already its own git repository, and an
 * unwanted structural change to the enclosing repository's tracking when it
 * is not.
 *
 * @param {string} memoryDir The resolved memory directory.
 * @param {string} agentHome The resolved agent home directory, used only to
 * classify `memoryDir` via {@link isSharedMemoryDir}.
 * @returns {void}
 */
function ensureSelfIgnored(memoryDir, agentHome) {
  if (isSharedMemoryDir(memoryDir, agentHome)) return;

  try {
    fs.mkdirSync(memoryDir, { recursive: true });

    // Searched from the parent, not from memoryDir itself, so a nested
    // repository memory-autocommit.js may have already initialised inside
    // memoryDir is never mistaken for the enclosing one.
    const enclosingRoot = findGitRoot(path.dirname(memoryDir));
    if (!enclosingRoot) return;

    const relative = path.relative(enclosingRoot, memoryDir).split(path.sep).join("/");
    if (!relative || relative.startsWith("..")) return;
    const entry = `/${relative}/`;

    const excludeFile = path.join(enclosingRoot, ".git", "info", "exclude");
    let existing = "";
    try {
      existing = fs.readFileSync(excludeFile, "utf8");
    } catch {
      // No exclude file yet — appendFileSync below creates it.
    }
    if (existing.split(/\r?\n/).some((line) => line.trim() === entry)) return;

    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(excludeFile, `${prefix}${entry}\n`, "utf8");
  } catch {
    // Fail open: worst case the directory is not yet excluded, which is no
    // worse than the mechanism not existing at all.
  }
}

module.exports = {
  parseArgs,
  findGitRoot,
  sanitize,
  resolveMemoryDir,
  isSharedMemoryDir,
  ensureSelfIgnored,
  REPO_LOCATION_DIRNAME,
  TOOL_OWNED_DIRNAME,
  HOME_LOCATION_DIRNAME,
  CODEX_NATIVE_MEMORIES_DIRNAME,
  UNSPECIFIED_LOCATION,
};
