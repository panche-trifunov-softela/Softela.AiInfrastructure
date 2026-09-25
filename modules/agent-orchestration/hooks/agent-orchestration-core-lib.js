"use strict";

/**
 * Resolves this module's `core/lib` dependencies (`hook-stdin`, `paths`,
 * `fs-safe`) across its two on-disk layouts, so `inject-delegation-mode.js`
 * never reaches into `core/lib` directly.
 *
 * A hook script in this module lives at
 * `modules/agent-orchestration/hooks/x.js` in the repository, three
 * directory levels above `core/lib/`, but is copied flat to
 * `<agentHome>/softela-ai/hooks/x.js` when installed (`core/installer/detect.js`'s
 * `mod.json.files` loop), one level above the `core/` payload installed
 * alongside it at `<agentHome>/softela-ai/core/`. Both paths are tried in turn
 * for each dependency; resolving neither is a hard failure rather than a
 * silent fallback, matching `modules/memory-as-context/hooks/stdin.js`, the
 * precedent this shim follows.
 *
 * Named after this module rather than `core-lib.js` because every module's
 * `hooks/` files land flat in the same installed directory: a generic name
 * shared with another module's own shim would silently overwrite it there.
 */

/**
 * Loads one `core/lib/<name>.js` module from whichever of this module's two
 * layouts is actually on disk.
 *
 * Flow:
 * - Tries the installed layout first. A failure to resolve the module falls
 *   through to the repository layout; any other error (a genuine bug inside
 *   the target module) is rethrown immediately rather than masked.
 * - Tries the repository layout next, under the same rule.
 * - Throws a single error naming both attempted paths when neither resolves.
 *
 * @param {string} name The `core/lib` module's base name, e.g. `"paths"`.
 * @returns {object} The resolved module's exports.
 * @throws {Error} When neither layout's path resolves to a module.
 */
function resolveCoreLib(name) {
  const installedPath = `../core/lib/${name}`;
  const repoPath = `../../../core/lib/${name}`;

  try {
    return require(installedPath);
  } catch (err) {
    if (!err || err.code !== "MODULE_NOT_FOUND") throw err;
  }

  try {
    return require(repoPath);
  } catch (err) {
    if (!err || err.code !== "MODULE_NOT_FOUND") throw err;
    throw new Error(
      `agent-orchestration-core-lib.js: could not resolve core/lib/${name} from either the ` +
        `installed layout (${installedPath}) or the repository layout (${repoPath})`,
    );
  }
}

module.exports = {
  hookStdin: resolveCoreLib("hook-stdin"),
  paths: resolveCoreLib("paths"),
  fsSafe: resolveCoreLib("fs-safe"),
};
