"use strict";

/**
 * Lazy, memoised access to the git state of a working directory.
 *
 * Nothing shells out to `git` until a property is actually read, and every
 * git call is wrapped so a missing binary or a non-repository `cwd` yields a
 * null-ish value rather than an exception.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { findRepoRoot } = require("./workdir");

/**
 * Runs a git subcommand, never throwing.
 *
 * @param {string} cwd The working directory to run git in.
 * @param {string[]} args The git arguments.
 * @returns {string | null} The trimmed stdout, or `null` on any failure.
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
 * Resolves the on-disk git directory for a working directory, so
 * `rebaseInProgress` can find `rebase-merge`/`rebase-apply` regardless of
 * whether `cwd` is the repository root itself or a nested subdirectory, and
 * regardless of `.git` being a directory (an ordinary clone) or a file (a
 * worktree or submodule's `gitdir: <path>` pointer).
 *
 * @param {string} cwd The working directory `gitState` was built for.
 * @param {string | null} repoRoot The resolved repository root, when known.
 * @returns {string} The resolved git directory. Every step is wrapped so
 * nothing throws; on any failure this falls back to `path.join(cwd,
 * ".git")`, matching the pre-existing behaviour.
 */
function resolveGitDir(cwd, repoRoot) {
  const base = repoRoot || cwd;
  try {
    const dotGit = path.join(base, ".git");
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    if (stat.isFile()) {
      const content = fs.readFileSync(dotGit, "utf8");
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (match) {
        const target = match[1].trim();
        return path.isAbsolute(target) ? target : path.resolve(base, target);
      }
    }
  } catch {
    // Fall through to the old behaviour below.
  }
  return path.join(cwd, ".git");
}

/**
 * Builds a lazily-evaluated git state object for a working directory.
 *
 * @param {string} cwd The working directory to inspect.
 * @param {{base?: string | null, repoRoot?: string}} [options] `base` is
 * never discovered from git; it is supplied by the caller from project
 * configuration. `repoRoot`, when a non-empty string, is returned by the
 * `repoRoot` getter directly without shelling out — for a caller that
 * already resolved it itself (`adapters/shared/dispatch-core.js` re-resolving
 * a nested operation's own working directory, or a test).
 * @returns {{
 *   repoRoot: string | null,
 *   branch: string | null,
 *   remote: string | null,
 *   base: string | null,
 *   upstreamBranch: string | null,
 *   rebaseInProgress: boolean,
 *   staged: () => string[]
 * }} The lazy git state, memoised per instance.
 */
function gitState(cwd, options = {}) {
  const base = options.base !== undefined ? options.base : null;
  const injectedRepoRoot = typeof options.repoRoot === "string" && options.repoRoot ? options.repoRoot : null;
  let repoRootCache;
  let branchCache;
  let remoteCache;
  let upstreamCache;
  let rebaseCache;
  let stagedCache;

  return {
    /**
     * The repository root.
     *
     * `git rev-parse --show-toplevel` stays the PRIMARY source — its
     * forward-slash-normalised output is what `core/lib/stack-resolver.js`
     * and the existing tests already expect, and this never changes that.
     * It falls back to `core/lib/workdir.js#findRepoRoot(cwd)` only when
     * git itself returned `null` (no `git` binary on `PATH`, or a `cwd` git
     * refuses for any other reason). That fallback returns a
     * platform-separated path — unlike git's forward slashes even on
     * Windows — but every consumer reaches `repoRoot` only through
     * `path.relative`, which does not care which separator either side
     * used.
     */
    get repoRoot() {
      if (injectedRepoRoot) return injectedRepoRoot;
      if (repoRootCache === undefined) {
        repoRootCache = runGit(cwd, ["rev-parse", "--show-toplevel"]);
        if (repoRootCache === null) repoRootCache = findRepoRoot(cwd);
      }
      return repoRootCache;
    },

    /** The current branch name, from `git rev-parse --abbrev-ref HEAD`. */
    get branch() {
      if (branchCache === undefined) branchCache = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
      return branchCache;
    },

    /** The origin remote URL, from `git config --get remote.origin.url`. */
    get remote() {
      if (remoteCache === undefined) remoteCache = runGit(cwd, ["config", "--get", "remote.origin.url"]);
      return remoteCache;
    },

    /** The base branch injected by the caller; never discovered from git. */
    get base() {
      return base;
    },

    /**
     * The short name of the current branch's configured upstream branch —
     * e.g. `"dev-ng"` for a branch tracking `origin/dev-ng` — or `null` when
     * no upstream is configured.
     *
     * Resolved from `branch.<name>.remote` and `branch.<name>.merge`
     * directly, the same two config keys git itself requires to be set
     * together before `@{upstream}` resolves at all, rather than by parsing
     * `<remote>/<branch>` out of a symbolic ref: a remote name and a branch
     * name can each contain `/`, so splitting that string apart cannot be
     * done reliably, while `branch.<name>.merge` already gives the exact
     * `refs/heads/<branch>` value with no ambiguity. Both keys must resolve
     * for this to return a value — a branch with only one of the two set is
     * not a usable upstream to git either, so it is treated the same as no
     * upstream at all: `null`, never a guess.
     *
     * Deliberately blind to `push.default`: which ref an argument-less `git
     * push` actually lands on depends on that setting, and it varies by
     * machine and by repository. This getter only answers "what does this
     * branch track", the one fact every `push.default` value short of
     * `current`/`matching` bases its resolution on — callers that care about
     * the distinction decide how to use it.
     */
    get upstreamBranch() {
      if (upstreamCache === undefined) {
        upstreamCache = null;
        const branch = this.branch;
        if (branch) {
          const remote = runGit(cwd, ["config", "--get", `branch.${branch}.remote`]);
          const merge = runGit(cwd, ["config", "--get", `branch.${branch}.merge`]);
          if (remote && merge) upstreamCache = merge.replace(/^refs\/heads\//, "");
        }
      }
      return upstreamCache;
    },

    /**
     * Whether a rebase is currently in progress, detected by the presence
     * of `rebase-merge` or `rebase-apply` inside the resolved git directory
     * — checked with `fs.existsSync`, never by shelling out. Resolved
     * through {@link resolveGitDir}, so this works from a nested
     * subdirectory and through a worktree-style `.git` file, not only from
     * the repository root itself.
     */
    get rebaseInProgress() {
      if (rebaseCache === undefined) {
        try {
          const gitDir = resolveGitDir(cwd, this.repoRoot);
          rebaseCache =
            fs.existsSync(path.join(gitDir, "rebase-merge")) || fs.existsSync(path.join(gitDir, "rebase-apply"));
        } catch {
          rebaseCache = false;
        }
      }
      return rebaseCache;
    },

    /**
     * Resolves the staged file paths.
     *
     * @returns {string[]} The staged paths from `git diff --cached
     * --name-only`, or an empty array on any failure.
     */
    staged() {
      if (stagedCache === undefined) {
        const out = runGit(cwd, ["diff", "--cached", "--name-only"]);
        stagedCache = out ? out.split(/\r?\n/).filter(Boolean) : [];
      }
      return stagedCache;
    },
  };
}

module.exports = { gitState };
