"use strict";

/**
 * Shared path helpers for a rule that resolves a tool-call path against a
 * repository root.
 *
 * `core/guards/component-folder-shape.js`, `core/guards/barrel-exports-only.js`,
 * `core/guards/api-import-boundary.js` and `core/guards/colocated-tests.js`
 * all call `relativeToRepo` from here rather than carrying their own copy.
 *
 * `core/guards/protected-paths.js`, `core/guards/shell-file-write.js` and
 * `core/lib/change-scope.js` each still carry their own private `toPosix`,
 * and two of them carry their own `relativeToRepo` with opposite argument
 * orders. Those existing copies are left in place deliberately, not
 * converted to call through here: `change-scope.js`'s `relativeToRepo` takes
 * `(repoRoot, filePath)`, the reverse of the order this module and
 * `protected-paths.js` use, so it is not a drop-in replacement. Converting
 * those remaining callers to a shared helper is a separate change with its
 * own risk to review, not a drive-by here.
 */

/**
 * Converts a path to forward-slash form.
 *
 * @param {string} p The path to convert.
 * @returns {string} The path with every backslash replaced by a slash.
 */
function toPosix(p) {
  return String(p || "").replace(/\\/g, "/");
}

/**
 * Resolves a path relative to a repository root when possible.
 *
 * @param {string} filePath The path to resolve, as given by the tool call.
 * @param {string | null} repoRoot The repository root, or `null` when it
 * could not be resolved.
 * @returns {string} The path relative to `repoRoot` when `filePath` sits
 * under it; `filePath` itself (forward-slash form, no leading slash)
 * otherwise. When `repoRoot` is unknown, this is a lenient approximation
 * only — see the callers that compare it against a configured entry.
 */
function relativeToRepo(filePath, repoRoot) {
  const f = toPosix(filePath);
  if (repoRoot) {
    const root = toPosix(repoRoot).replace(/\/+$/, "");
    if (f.toLowerCase() === root.toLowerCase()) return "";
    if (f.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return f.slice(root.length + 1);
  }
  return f.replace(/^\/+/, "");
}

/**
 * Joins a repository root and a repository-relative path into an absolute,
 * forward-slash path.
 *
 * Forward slashes are used unconditionally, never `path.join` — `ctx.git`
 * reports `repoRoot` with forward slashes even on Windows, `fs` accepts
 * forward slashes on both platforms, and joining with `path.join` would make
 * the result depend on the host platform's own separator.
 *
 * @param {string} repoRoot The repository root.
 * @param {string} relativePath The repository-relative path to append.
 * @returns {string} The joined absolute path, forward-slash throughout.
 */
function joinRepoPath(repoRoot, relativePath) {
  const root = toPosix(repoRoot).replace(/\/+$/, "");
  const rel = toPosix(relativePath).replace(/^\/+/, "");
  return `${root}/${rel}`;
}

module.exports = { toPosix, relativeToRepo, joinRepoPath };
