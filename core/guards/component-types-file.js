"use strict";

/**
 * A component's types belong in its folder's `types.ts`, not inline.
 *
 * `docs/standards/component-structure.md` names `types.ts` as the file that
 * holds "every type the component and its internals need" — the whole point
 * being that a caller or a test can import a type without importing the
 * component, or the component's own hook, that happens to declare it. A
 * fresh `interface` or `type` sitting at the top of a component's `.tsx` or
 * of a component-folder hook (`use*.ts`/`use*.tsx`) defeats that: the type
 * is now reachable only by pulling in the view or the hook body around it.
 *
 * Fires only for a brand-new file, exactly like `component-folder-shape`:
 * `ctx.readFile` returning content for the same path means an inline type
 * already predates this rule, and moving it out is a refactor, not
 * something to relitigate on every further edit.
 */

const { deny, pass } = require("../lib/decision");
const { globToRegex } = require("../lib/project-resolver");
const { relativeToRepo } = require("../lib/repo-path");
const { maskCommentsAndStrings, buildDepthBeforeEachIndex } = require("../lib/source-mask");

/** Tool names this rule inspects: file-write calls on both hosts. */
const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file)$/;

/** A test file by its own naming convention, independent of any config. */
const TEST_FILE_SUFFIX = /\.(test|spec)\.[a-z0-9]+$/i;

/** The barrel file a component folder publishes; re-exports only, never a target here. */
const INDEX_FILE = /^index\.(ts|tsx)$/i;

/** The folder's own dedicated types file, in either its single-file or split-folder form. */
const TYPES_FILE = /^types\.tsx?$/i;

/** The folder's own dedicated constants file. */
const CONSTANTS_FILE = /^constants\.tsx?$/i;

/** A component's own view file. */
const COMPONENT_EXTENSION = /\.tsx$/i;

/** A component-folder hook: `use`-prefixed, `.ts` or `.tsx`. */
const HOOK_FILE = /^use[A-Za-z0-9_].*\.tsx?$/;

/**
 * Matches a top-level `interface Name` declaration.
 *
 * Deliberately does not require a following `{` or `extends` — both always
 * follow in real syntax, and requiring either only adds a way to miss one
 * without ruling out anything a real declaration would not already satisfy.
 */
const INTERFACE_DECL = /\binterface\s+([A-Za-z_$][\w$]*)/g;

/**
 * Matches a top-level `type Name = ...` declaration, generic parameters
 * included. Requiring the trailing `=` (not `==`) is what tells a real
 * declaration apart from `import type Name from "..."` and
 * `import type { Name } from "..."`, neither of which is followed by one.
 */
const TYPE_DECL = /\btype\s+([A-Za-z_$][\w$]*)\s*(?:<[^;{}]*>)?\s*=(?!=)/g;

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

/**
 * Finds the first top-level `interface` or `type` declaration in a piece of
 * source text.
 *
 * @param {string} content The file content to scan.
 * @returns {string|null} The declared name, or `null` when none sits at
 * brace depth zero.
 */
function firstTopLevelDeclaration(content) {
  const masked = maskCommentsAndStrings(content);
  const depths = buildDepthBeforeEachIndex(masked);

  let best = null;
  for (const re of [INTERFACE_DECL, TYPE_DECL]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(masked))) {
      if (depths[m.index] === 0 && (best === null || m.index < best.index)) {
        best = { index: m.index, name: m[1] };
      }
    }
  }
  return best ? best.name : null;
}

/**
 * Decides whether a file is one this rule governs: a component's own view
 * file, or a component-folder hook — never the folder's own `types.ts`,
 * `constants.ts`, its barrel, or a test file.
 *
 * @param {string} fileName The file's own basename.
 * @returns {boolean} `true` when the file is in scope.
 */
function isGovernedFile(fileName) {
  if (INDEX_FILE.test(fileName)) return false;
  if (TYPES_FILE.test(fileName)) return false;
  if (CONSTANTS_FILE.test(fileName)) return false;
  if (TEST_FILE_SUFFIX.test(fileName)) return false;
  return COMPONENT_EXTENSION.test(fileName) || HOOK_FILE.test(fileName);
}

module.exports = {
  /** kebab-case, unique, equals the filename without .js */
  id: "component-types-file",

  /** one line, shown by `softela-ai doctor` */
  title: "A component's types belong in its folder's types.ts",

  /** which host events this rule can fire on */
  events: ["PreToolUse"],

  /** which tool names it applies to; null means every tool */
  tools: WRITE_TOOLS,

  /** the strongest action this rule may ever return */
  defaultAction: "deny",

  /** which catalogue group this rule belongs to */
  group: "code",

  /** frontend-only: the types.ts convention is a frontend architecture concern */
  stacks: ["frontend"],

  /** an inline type in an existing file predates this convention; moving it out is a refactor, not a requirement for touching it */
  newCodeOnly: true,

  /** dotted project-config paths this rule needs to be meaningful */
  requiresConfig: ["conventions.componentFolders"],

  /** optional: only active when this module is enabled */
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: string, reason: string, fix?: string}} A deny
   * decision when a new component or hook file declares its own top-level
   * `interface`/`type`, `null` otherwise.
   */
  evaluate(ctx) {
    const conventions = ctx.project && ctx.project.conventions;
    const pattern = conventions && conventions.componentFolders;
    if (!pattern) return pass();

    const rel = relativePath(ctx);
    if (!rel) return pass();

    const patternRe = globToRegex(pattern);
    if (!patternRe || !patternRe.test(rel)) return pass();

    const segments = rel.split("/");
    const fileName = segments[segments.length - 1];
    if (!isGovernedFile(fileName)) return pass();

    const testFolder = conventions.testFolder;
    if (testFolder && segments.includes(testFolder)) return pass();

    // Fires only for a file that does not yet exist; an inline type on an
    // existing file is not relitigated on every further edit.
    if (ctx.readFile(ctx.filePath) !== null) return pass();

    // R3 decision: kept on ctx.content, not resultingContent — this rule
    // already returned above for any file `ctx.readFile` can read, so it
    // only ever reaches here for a brand-new file (a Write, or an
    // apply_patch add). On that path content === resultingContent always
    // (write-decode.js only sets `insertedText` for a decoded Edit/
    // MultiEdit, both of which target an EXISTING file by construction), so
    // there is nothing for the two to disagree about here.
    const content = String(ctx.content || "");
    if (!content.trim()) return pass();

    const declaredName = firstTopLevelDeclaration(content);
    if (!declaredName) return pass();

    const dir = segments.slice(0, -1).join("/");
    const typesPath = dir ? `${dir}/types.ts` : "types.ts";

    return deny(
      `"${declaredName}" is declared inline in "${fileName}"; a component's types belong in its folder's types.ts, not in the component or hook file.`,
      `Move "${declaredName}" into "${typesPath}" and import it from there.`,
    );
  },
};
