"use strict";

/**
 * Resolves which "stack" (`"frontend"` | `"backend"`) a tool call belongs
 * to, so the engine can silence a stack-scoped rule outside its own stack.
 *
 * Resolution never invents an answer for a case it cannot determine: a shell
 * command with no file path, and a monorepo path matching no declared stack
 * entry, both resolve to `null` ("no stack") rather than falling back to a
 * guess. A rule that declares no `stacks` field is never affected by this —
 * the caller only consults `resolveStack` for a rule that actually scoped
 * itself to one or more stacks.
 */

const path = require("path");
const { globToRegex } = require("./project-resolver");

/**
 * Rewrites a file path to a POSIX-separated path relative to a boundary
 * directory, for glob comparison.
 *
 * @param {string} filePath The path to relativise.
 * @param {string} boundary The directory paths are compared against —
 * typically the git repository root, falling back to the working directory.
 * @returns {string} The relativised, POSIX-separated path, or the original
 * path (still POSIX-separated) when it cannot be made relative to
 * `boundary`.
 */
function relativize(filePath, boundary) {
  let rel = filePath;
  if (boundary) {
    try {
      const candidate = path.relative(boundary, filePath);
      if (candidate && !candidate.startsWith("..") && !path.isAbsolute(candidate)) rel = candidate;
    } catch {
      // Fall back to the raw path.
    }
  }
  return rel.replace(/\\/g, "/");
}

/**
 * Resolves the stack a context's file path belongs to, per the project's
 * `stack` or `stacks` configuration (CONTRACTS.md §8a).
 *
 * - A context with no `filePath` — a shell command — always resolves to
 *   `null`. There is no path to test a stack's globs against, so no stack is
 *   invented for it; a stack-scoped rule must simply not fire, and a
 *   stack-agnostic rule is unaffected because it never calls this function.
 * - The monorepo `stacks` list (an ordered array of `{paths, stack}`) is
 *   evaluated in declaration order; the first entry whose `paths` glob
 *   matches the relativised file path wins. A path matching no entry
 *   resolves to `null`, exactly like the no-file case — order matters, and
 *   a broad glob listed before a narrow one silently swallows it.
 * - The single-stack `stack` shorthand applies to every file in the
 *   repository once a `filePath` is present; it does not itself glob-match
 *   anything, since a non-monorepo project has only the one stack to give.
 * - `stacks` takes precedence over `stack` when a project config declares
 *   both; a project is expected to declare only one.
 *
 * @param {{project: object, filePath: string, git?: {repoRoot?: string}, cwd?: string}} ctx
 * The evaluation context, or anything shaped enough like one.
 * @returns {"frontend" | "backend" | null} The resolved stack, or `null`
 * when none can be determined.
 */
function resolveStack(ctx) {
  const project = ctx && ctx.project;
  if (!project || typeof project !== "object") return null;

  const filePath = ctx.filePath;
  if (typeof filePath !== "string" || !filePath) return null;

  if (Array.isArray(project.stacks)) {
    const boundary = (ctx.git && ctx.git.repoRoot) || ctx.cwd || "";
    const rel = relativize(filePath, boundary);
    for (const entry of project.stacks) {
      if (!entry || typeof entry !== "object") continue;
      const globs = Array.isArray(entry.paths) ? entry.paths : [];
      for (const glob of globs) {
        const re = globToRegex(glob);
        if (re && re.test(rel)) return typeof entry.stack === "string" ? entry.stack : null;
      }
    }
    return null;
  }

  if (typeof project.stack === "string" && project.stack) return project.stack;

  return null;
}

module.exports = { resolveStack };
