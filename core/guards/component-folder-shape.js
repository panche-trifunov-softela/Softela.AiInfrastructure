"use strict";

/**
 * New component files must live inside their own folder.
 *
 * A React component's own `.tsx`/`.jsx` file belongs in a folder named after
 * the component itself, beside its `index` — never dropped straight into the
 * shared components root, and never inside a folder whose name does not
 * match. Fires only for a brand-new file: `ctx.readFile` returning content
 * for the same path means it already exists, and a shape that already broke
 * the convention before this session is not this rule's business to
 * relitigate on every edit.
 */

const { deny, pass } = require("../lib/decision");
const { globToRegex } = require("../lib/project-resolver");
const { relativeToRepo } = require("../lib/repo-path");

/** Tool names this rule inspects: file-write calls on both hosts. */
const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file)$/;

/**
 * Extensions treated as a component's own file. A `.ts`/`.js` sibling (a
 * colocated hook or a small helper) is deliberately out of scope, since only
 * the file carrying the component's JSX is what the folder is named after.
 */
const COMPONENT_EXTENSION = /\.(tsx|jsx)$/i;

/**
 * Resolves a context's file path to a forward-slash path relative to the
 * repository root, falling back to the working directory when the root is
 * unknown.
 *
 * @param {object} ctx The evaluation context.
 * @returns {string} The project-relative path, or `""` when `ctx.filePath`
 * is empty.
 */
function relativePath(ctx) {
  const raw = (ctx && ctx.filePath) || "";
  if (!raw) return "";
  const root = (ctx.git && ctx.git.repoRoot) || ctx.cwd || "";
  return relativeToRepo(raw, root);
}

module.exports = {
  /** kebab-case, unique, equals the filename without .js */
  id: "component-folder-shape",

  /** one line, shown by `softela-ai doctor` */
  title: "New component files live in their own matching folder",

  /** which host events this rule can fire on */
  events: ["PreToolUse"],

  /** which tool names it applies to; null means every tool */
  tools: WRITE_TOOLS,

  /** the strongest action this rule may ever return */
  defaultAction: "deny",

  /** which catalogue group this rule belongs to */
  group: "code",

  /** frontend-only: component-folder shape is a frontend architecture concern */
  stacks: ["frontend"],

  /** an existing component's folder layout predates this convention; moving it is a refactor, not a requirement for touching it */
  newCodeOnly: true,

  /** dotted project-config paths this rule needs to be meaningful */
  requiresConfig: ["conventions.componentFolders"],

  /** optional: only active when this module is enabled */
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: string, reason: string, fix?: string}} A deny
   * decision when a new component file is not inside its own matching
   * folder, `null` otherwise.
   */
  evaluate(ctx) {
    const conventions = ctx.project && ctx.project.conventions;
    const pattern = conventions && conventions.componentFolders;
    if (!pattern) return pass();

    const rel = relativePath(ctx);
    if (!rel) return pass();

    const patternRe = globToRegex(pattern);
    if (!patternRe || !patternRe.test(rel)) return pass();
    if (!COMPONENT_EXTENSION.test(rel)) return pass();

    const testFolder = conventions.testFolder;
    const segments = rel.split("/");
    if (testFolder && segments.includes(testFolder)) return pass();

    const fileName = segments[segments.length - 1];
    const baseName = fileName.split(".")[0];
    if (!baseName || baseName.toLowerCase() === "index") return pass();

    // Fires only for a file that does not yet exist; an already-broken shape
    // on an existing file is not relitigated on every edit.
    if (ctx.readFile(ctx.filePath) !== null) return pass();

    const parent = segments.length >= 2 ? segments[segments.length - 2] : "";
    if (parent === baseName) return pass();

    const ext = fileName.slice(baseName.length);
    const parentPath = segments.slice(0, -1).join("/");
    const correctedDir = parentPath ? `${parentPath}/${baseName}` : baseName;

    return deny(
      `New component files must live in their own folder named after the component; "${fileName}" is not inside a "${baseName}" folder.`,
      `Move it to "${correctedDir}/${fileName}", with an "index${ext}" barrel beside it.`,
    );
  },
};
