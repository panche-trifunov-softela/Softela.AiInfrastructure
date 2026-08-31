"use strict";

/**
 * Denies a source-file write attempted through a shell command instead of a
 * write tool.
 *
 * Every file rule in `core/guards/` — `doc-comment-style`, `no-explicit-any`,
 * `naming-standards`, `barrel-exports-only`, `component-folder-shape`,
 * `api-import-boundary`, `file-size-limit`, `colocated-tests`,
 * `reuse-before-new`, `test-structure`, `patch-manifest`, `protected-paths` —
 * fires only on a write tool (`Write`, `Edit`, `apply_patch`, …).
 * `core/lib/shell-write.js` finds every path a shell command line actually
 * writes — a redirect, a heredoc, a `sed -i`, an inline `node -e` script, a
 * PowerShell cmdlet, and the rest of the mechanisms it documents — and this
 * rule denies the ones landing on a source extension the standards catalogue
 * governs, so the catalogue keeps applying regardless of which tool the
 * bytes travel through.
 *
 * `group: "agent"`, deliberately, not `"code"`. This repository turns the
 * `code` group off for itself (`projects/Softela.AiInfrastructure.json`)
 * because it is developer infrastructure with no application code for those
 * rules to examine. But an agent routing a source write around the write
 * tools entirely is an agent-behaviour problem, not a code-standard one —
 * exactly the gap this rule exists to close — and it must still be caught
 * even in a repository that has switched `code` off.
 */

const path = require("path");
const os = require("os");
const { deny, ask, pass, severity } = require("../lib/decision");
const { shellWriteTargets } = require("../lib/shell-write");

/** Tool names this rule evaluates — shell invocations on either host. */
const SHELL_TOOLS = /^(Bash|PowerShell|shell|local_shell|exec_command|shell_command)$/;

/**
 * Extensions this rule treats as source a shell write must not bypass.
 *
 * Two groups:
 *
 * - **Source** — `.ts .tsx .mts .cts .js .jsx .mjs .cjs .cs .vb .razor
 *   .cshtml .vue .svelte .scss .css`: exactly what `doc-comment-style`,
 *   `naming-standards` and the rest of the write-tool catalogue this rule's
 *   own file header names already govern.
 * - **Configuration and knowledge** — `.md .json`: not source, but still a
 *   format an agent routing around the write tools would target on purpose.
 *   `.md` is how this project's own durable knowledge is stored (memory
 *   files, `docs/standards/`), and `.json` is how a project configuration
 *   (`projects/*.json`, a module's own `module.json`) is written — both are
 *   exactly the shape of file this rule exists to stop a shell write from
 *   silently reaching.
 *
 * Deliberately left out: `.yml`/`.yaml` (CI and pipeline files an agent
 * legitimately edits by shell as ordinary DevOps work far more often than it
 * bypasses a write tool with them), `.xml` (`patch-manifest`'s own
 * `patch.manifest.xml` is matched by a configured filename pattern, not by
 * extension, and the extension alone is shared by too much routine backend
 * project-file churn to govern wholesale), and `.txt`/`.log` (never a format
 * any rule in the catalogue reads).
 */
const GOVERNED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".cs",
  ".vb",
  ".razor",
  ".cshtml",
  ".vue",
  ".svelte",
  ".scss",
  ".css",
  ".md",
  ".json",
]);

/** Directory segments that are never source, wherever they sit in a path. */
const EXCLUDED_DIR_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  "bin",
  "obj",
  ".git",
  "__pycache__",
]);

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
 * Normalises a path for comparison: `.`/`..` segments resolved, forward
 * slashes, lower case, no trailing slash. Uses `path.win32` regardless of the
 * host platform, since the input is text a shell command supplied — possibly
 * with either separator style — not a path this process constructed itself.
 *
 * @param {string} p The path to normalise.
 * @returns {string} The normalised path, or `""` for anything falsy.
 */
function normalizePath(p) {
  const raw = String(p || "");
  if (!raw) return "";
  return path.win32.normalize(raw).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}

/**
 * Checks whether a path sits at or under a directory.
 *
 * @param {string} filePath The path to check.
 * @param {string} dir The candidate ancestor directory.
 * @returns {boolean} `true` when `filePath` equals `dir` or is nested under it.
 */
function isUnderDir(filePath, dir) {
  const f = normalizePath(filePath);
  const d = normalizePath(dir);
  if (!f || !d) return false;
  return f === d || f.startsWith(`${d}/`);
}

/**
 * Checks whether a path is absolute, by either a POSIX leading slash, a
 * drive letter, or a UNC prefix — deterministic regardless of the host
 * platform this process happens to run on.
 *
 * @param {string} p The path to check.
 * @returns {boolean} `true` when the path is absolute in any of those forms.
 */
function isAbsolutePath(p) {
  return /^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)/.test(String(p || ""));
}

/**
 * Checks whether a path carries one of {@link EXCLUDED_DIR_SEGMENTS} as a
 * whole path segment, wherever it sits.
 *
 * @param {string} p The path to check.
 * @returns {boolean} `true` when an excluded segment is present.
 */
function isUnderExcludedDir(p) {
  const segments = toPosix(p).toLowerCase().split("/").filter(Boolean);
  return segments.some((segment) => EXCLUDED_DIR_SEGMENTS.has(segment));
}

/**
 * Checks whether a path sits under this process's own OS temp directory.
 *
 * @param {string} p The path to check.
 * @returns {boolean} `true` when the path is at or under the temp directory.
 */
function isUnderOsTempDir(p) {
  const tmp = os.tmpdir();
  return Boolean(tmp) && isUnderDir(p, tmp);
}

/**
 * Checks whether a path is absolute and sits outside the resolved repository
 * root. A relative path, or an unknown repository root, is never excluded by
 * this check alone.
 *
 * @param {string} p The path to check.
 * @param {string | null | undefined} repoRoot The repository root, when known.
 * @returns {boolean} `true` when `p` is absolute and outside `repoRoot`.
 */
function isOutsideRepoRoot(p, repoRoot) {
  if (!isAbsolutePath(p)) return false;
  if (!repoRoot) return false;
  return !isUnderDir(p, repoRoot);
}

/**
 * Checks whether a write target is clearly not source at all — a build or
 * dependency directory, this process's own temp directory, or an absolute
 * path outside the repository — so it never needs a mechanism-by-mechanism
 * judgement call.
 *
 * @param {string} targetPath The extracted write target.
 * @param {string | null | undefined} repoRoot The repository root, when known.
 * @returns {boolean} `true` when the target is excluded outright.
 */
function isClearlyNotSource(targetPath, repoRoot) {
  return isUnderExcludedDir(targetPath) || isUnderOsTempDir(targetPath) || isOutsideRepoRoot(targetPath, repoRoot);
}

/**
 * Reads a path's lower-cased extension.
 *
 * @param {string} p The path to inspect.
 * @returns {string} The extension, including its leading dot, or `""`.
 */
function extensionOf(p) {
  return path.posix.extname(toPosix(p)).toLowerCase();
}

/**
 * Builds the decision for a single write target.
 *
 * @param {{path: string, mechanism: string, certain: boolean}} target One
 * target `shellWriteTargets` found. `path` may be `""` for an uncertain
 * inline-interpreter target whose write call carried a computed argument
 * rather than a literal — there was never a path to extract.
 * @returns {null | {action: string, reason: string, fix: string}} `deny` for
 * a certain target on a governed extension; `ask` for an uncertain one,
 * whether or not it carries a path; `null` for a certain target on an
 * ungoverned extension.
 */
function decisionForTarget(target) {
  if (target.certain) {
    if (!GOVERNED_EXTENSIONS.has(extensionOf(target.path))) return null;
    return deny(
      `SHELL FILE WRITE: this command writes to "${target.path}" via ${target.mechanism}, bypassing every file-write rule the write tools enforce.`,
      "Use the write tool instead (Write/Edit on Claude Code, apply_patch on Codex) so the code standards actually run.",
    );
  }

  // A redirect or a PowerShell cmdlet argument that failed to extract still
  // carries the raw text (a variable name, say); an inline-interpreter write
  // call with a computed path argument carries no path at all — there was
  // never a literal to fail to extract. Both name the mechanism regardless.
  const pathClause = target.path ? ` to "${target.path}"` : "";
  return ask(
    `SHELL FILE WRITE: this command writes${pathClause} via ${target.mechanism}, but the concrete path could not be extracted, so whether it lands on a governed source file cannot be ruled out.`,
    "Confirm the exact target path, or use the write tool instead so the code standards apply automatically.",
  );
}

module.exports = {
  id: "shell-file-write",
  title: "A shell command may not write a source file the write-tool rules would otherwise govern",
  events: ["PreToolUse"],
  tools: SHELL_TOOLS,
  defaultAction: "deny",
  group: "agent",
  requiresConfig: [],
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: string, reason: string, fix: string}} The most
   * severe decision among every write target found, ties broken by command
   * order; `pass` when nothing was found or every target is excluded.
   */
  evaluate(ctx) {
    const toolName = String(ctx.toolName || "");
    if (!SHELL_TOOLS.test(toolName)) return pass();

    const command = ctx.command || "";
    if (!command) return pass();

    const targets = shellWriteTargets(command, { powershell: /^PowerShell$/i.test(toolName) });
    if (!targets.length) return pass();

    const repoRoot = ctx.git && ctx.git.repoRoot;
    let best = null;

    for (const target of targets) {
      if (!target) continue;
      // An uncertain inline-interpreter target can carry no path at all (a
      // computed argument, never a literal) — there is nothing to test
      // against the exclusion checks below, and nothing to exclude, so it
      // always reaches the `ask` branch on its own merits.
      if (target.path && isClearlyNotSource(target.path, repoRoot)) continue;

      const candidate = decisionForTarget(target);
      if (candidate && (!best || severity(candidate.action) > severity(best.action))) best = candidate;
    }

    return best || pass();
  },
};
