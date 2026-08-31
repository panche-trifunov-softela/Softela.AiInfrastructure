"use strict";

/**
 * Resolves and re-exports the canonical `core/lib/hook-stdin.js` module
 * across this module's two on-disk layouts, so every hook script here reads
 * its host payload the same non-blocking way `adapters/shared/dispatch-core.js`
 * does, instead of a bare synchronous `fs.readFileSync(0)` that can hang
 * forever against a pipe the host opens but never writes to or closes.
 *
 * This is a deliberate, narrow exception to the "siblings only, never
 * `core/lib`" rule the rest of this module's scripts follow
 * (`memory-location.js`, `transcript.js`): those scripts are copied whole
 * into one flat installed directory, and reaching into `core/lib` from there
 * needs a layout-aware resolution this shim exists specifically to provide.
 *
 * A hook script in this module lives at
 * `modules/memory-as-context/hooks/x.js` in the repository, three directory
 * levels above `core/lib/`, but is copied flat to `<agentHome>/softela-ai/hooks/x.js`
 * when installed (`core/installer/detect.js`'s `mod.json.files` loop),
 * one level above the `core/` payload installed alongside it at
 * `<agentHome>/softela-ai/core/`. Both paths are tried in turn; resolving to
 * neither is a hard failure rather than a silent fallback to a blocking
 * read, since a silent fallback would reintroduce the exact hang this shim
 * exists to prevent.
 */

/** Where `core/lib/hook-stdin.js` sits relative to this file once installed. */
const INSTALLED_LAYOUT_PATH = "../core/lib/hook-stdin";

/** Where `core/lib/hook-stdin.js` sits relative to this file inside the repository. */
const REPO_LAYOUT_PATH = "../../../core/lib/hook-stdin";

/**
 * Loads `core/lib/hook-stdin.js` from whichever of this module's two layouts
 * is actually on disk.
 *
 * Flow:
 * - Tries the installed layout first. A failure to resolve the module falls
 *   through to the repository layout; any other error (a genuine bug inside
 *   `hook-stdin.js`) is rethrown immediately rather than masked.
 * - Tries the repository layout next, under the same rule.
 * - Throws a single error naming both attempted paths when neither resolves.
 *
 * @returns {{STDIN_TIMEOUT_MS: number, readStdin: () => Promise<string>, parsePayload: (text: string) => object}}
 * The canonical stdin module.
 * @throws {Error} When neither layout's path resolves to a module.
 */
function resolveHookStdin() {
  try {
    return require(INSTALLED_LAYOUT_PATH);
  } catch (err) {
    if (!err || err.code !== "MODULE_NOT_FOUND") throw err;
  }

  try {
    return require(REPO_LAYOUT_PATH);
  } catch (err) {
    if (!err || err.code !== "MODULE_NOT_FOUND") throw err;
    throw new Error(
      "stdin.js: could not resolve core/lib/hook-stdin from either the installed layout " +
        `(${INSTALLED_LAYOUT_PATH}) or the repository layout (${REPO_LAYOUT_PATH})`,
    );
  }
}

module.exports = resolveHookStdin();
