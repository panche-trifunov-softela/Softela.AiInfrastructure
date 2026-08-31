"use strict";

/**
 * Shared git-commit mechanics for this module's own writers
 * (`memory-autocommit.js`, `seed-memory.js`): stages every change in a
 * memory directory and commits it into that directory's own local git
 * repository, initialising the repository lazily — on the first commit that
 * actually has something to version, never before — and never for a shared
 * (`isSharedMemoryDir`) directory that already sits, un-versioned, inside
 * some other enclosing repository.
 *
 * Pulled out as a sibling so neither caller re-derives the same guarded
 * `git init` / `git add -A` / `git commit` sequence. Deliberately
 * self-contained like every other script in this module — see
 * `memory-location.js`'s own module doc for why (siblings only, never
 * `core/lib`).
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { isSharedMemoryDir } = require("./memory-location");

/** Wall-clock bound for every `git` child process this module spawns. */
const CHILD_TIMEOUT_MS = 5000;

/**
 * Normalises a filesystem path for a Windows-safe prefix/equality comparison.
 *
 * @param {string} p The path to normalise.
 * @returns {string} The absolute path, forward slashes, lower-cased.
 */
function normalize(p) {
  return path.resolve(p).replace(/\\/g, "/").toLowerCase();
}

/**
 * Normalises a path for comparison against git's own output, resolving any
 * 8.3 short-name segment (e.g. `RUNNER~1`) to its long form first — `git`
 * reports canonical long-form paths on Windows while `path.resolve` leaves
 * short names untouched.
 *
 * @param {string} p The path to canonicalise; must already exist on disk.
 * @returns {string} The canonical form when resolvable, else the plain
 * normalised path.
 */
function canonical(p) {
  try {
    return normalize(fs.realpathSync.native(p));
  } catch {
    return normalize(p);
  }
}

/**
 * Runs a git command against a memory repository, swallowing all failures.
 *
 * @param {string} memoryDir The directory `git -C` targets.
 * @param {string[]} gitArgs The arguments passed after `-C <memoryDir>`.
 * @returns {{ok: boolean, stdout: string}} Whether the command exited zero,
 * and its stdout.
 */
function runGit(memoryDir, gitArgs) {
  try {
    const stdout = execFileSync("git", ["-C", memoryDir, ...gitArgs], {
      timeout: CHILD_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: stdout.toString("utf8") };
  } catch (err) {
    return { ok: false, stdout: err && err.stdout ? err.stdout.toString("utf8") : "" };
  }
}

/**
 * Stages a set of paths in a memory directory (`git add -A -- <paths>`) and
 * commits whatever actually staged into that directory's own local git
 * repository, initialising the repository lazily on the first commit that
 * has real content to version.
 *
 * Flow:
 * - Already its own repository — stage and commit directly.
 * - Not yet its own repository, but a shared (`isSharedMemoryDir`) directory
 *   that already sits inside some other enclosing one — declines outright,
 *   `{status: "declined"}`, rather than nesting a fresh, historyless
 *   repository into content that enclosing repository already tracks.
 * - Not yet its own repository, and not that shared case — `git init`, then
 *   proceeds; a failed init or a post-init toplevel mismatch also declines.
 * - Nothing actually staged (e.g. a write with identical content) —
 *   `{status: "clean"}`.
 * - Something staged — commits (retrying once with a throwaway identity if
 *   the first attempt fails for lack of a configured `user.name`/`user.email`)
 *   and returns `{status: "attempted", committed, changedFiles}`.
 *
 * @param {object} options
 * @param {string} options.memoryDir The resolved memory directory; must
 * already exist on disk with the change(s) to commit already written.
 * @param {string} options.agentHome The resolved agent home directory, used
 * only to classify `memoryDir` via `isSharedMemoryDir`.
 * @param {(changedFiles: string[]) => string} options.buildSubject Builds
 * the commit subject from the staged file paths, relative to `memoryDir`.
 * Only called when there is something to commit.
 * @param {string[]} [options.paths] The pathspec(s), relative to
 * `memoryDir`, that this call is allowed to stage — every caller must name
 * exactly what it just wrote, never rely on an implicit default, so a
 * caller can never accidentally sweep up content it did not itself
 * produce. `["."]` stages the whole directory, matching this function's own
 * previous unconditional behaviour, and is what `memory-autocommit.js`
 * passes explicitly for its own `Write`/`Edit`-triggered commits, where the
 * developer's own just-written file is genuinely the only thing that
 * changed. `seed-memory.js` instead passes only the paths it actually wrote
 * (`softela/`, `MEMORY.md`, and `ACTIVE-WORK.md` when it created it) — its own
 * `SessionStart` trigger fires before the developer has done anything this
 * session, so a personal scratch note left elsewhere in the memory
 * directory must never be swept into a commit titled for the seed. Falls
 * back to `["."]` when omitted or empty, so an existing caller that has not
 * yet been updated fails open into the old behaviour rather than staging
 * nothing at all.
 * @returns {{status: "declined" | "clean" | "attempted", committed?: boolean, changedFiles?: string[]}}
 * The outcome — see the flow above for what each status means.
 */
function commitAll({ memoryDir, agentHome, buildSubject, paths }) {
  let topLevel = runGit(memoryDir, ["rev-parse", "--show-toplevel"]);
  const alreadyOwnRepo = topLevel.ok && canonical(topLevel.stdout.trim()) === canonical(memoryDir);

  if (!alreadyOwnRepo) {
    if (isSharedMemoryDir(memoryDir, agentHome) && topLevel.ok) return { status: "declined" };

    const initResult = runGit(memoryDir, ["init"]);
    if (!initResult.ok) return { status: "declined" };
    topLevel = runGit(memoryDir, ["rev-parse", "--show-toplevel"]);
    if (!topLevel.ok || canonical(topLevel.stdout.trim()) !== canonical(memoryDir)) return { status: "declined" };
  }

  const pathspecs = Array.isArray(paths) && paths.length > 0 ? paths : ["."];
  const addResult = runGit(memoryDir, ["add", "-A", "--", ...pathspecs]);
  if (!addResult.ok) return { status: "declined" };

  const staged = runGit(memoryDir, ["diff", "--cached", "--name-only"]);
  const changedFiles = staged.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (changedFiles.length === 0) return { status: "clean" };

  const subject = buildSubject(changedFiles);
  let commitResult = runGit(memoryDir, ["commit", "-m", subject]);
  if (!commitResult.ok) {
    // Likely cause: no user.name/user.email configured anywhere. Retry once
    // with a throwaway identity, without writing any config permanently.
    commitResult = runGit(memoryDir, [
      "-c",
      "user.name=softela-ai-memory",
      "-c",
      "user.email=softela-ai-memory@localhost",
      "commit",
      "-m",
      subject,
    ]);
  }

  return { status: "attempted", committed: commitResult.ok, changedFiles };
}

module.exports = { commitAll, canonical, runGit };
