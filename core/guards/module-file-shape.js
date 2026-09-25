"use strict";

/**
 * A nudge when a new non-component module mixes its own declarations with
 * real logic.
 *
 * `docs/standards/shared-code-boundaries.md` ("The same pattern applies
 * beyond components") extends the component-folder split to a store, a
 * context or a root-level hook once one of those outgrows a single file, and
 * `docs/standards/component-structure.md` is where `types.ts` and
 * `constants.ts` are named as the destinations for exactly this content. The
 * component-scoped guards (`component-types-file`, `component-folder-shape`,
 * `component-view-logic`) already cover a component's own folder; this rule
 * covers everything else a frontend project writes outside
 * `conventions.componentFolders` — a store, a hook, a context, a utility
 * module.
 *
 * Firing needs both halves at once: a file that only declares a type or only
 * lists constants is doing one job and must never fire, however many
 * declarations it holds, so this rule requires a separate, deliberately
 * narrow signal that the same file also carries behaviour — a control-flow
 * statement, an `await`, or a state/effect hook call. A file with neither
 * half present is left alone; a file with both is advised, never blocked,
 * because whether a given constant deserves its own file is a judgement call
 * this rule cannot make on its author's behalf.
 *
 * The destination named for a stray type or interface changes with what can
 * actually be verified: `docs/standards/shared-code-boundaries.md` ("Stores
 * and API services keep their types at the root") keeps a store's or an API
 * service's types out of a colocated `types.ts`, but this rule has no
 * `conventions.store` field to detect a store by. Where the file matches
 * `conventions.apiLayer` — the one case this rule can actually verify, read
 * the same way `api-import-boundary.js` reads it — the advice names only the
 * shared types location; everywhere else it defaults to a colocated
 * `types.ts` (or, in a plain-JavaScript file, `types.js`) and calls out the
 * store/API-service exception rather than presenting both as an equally
 * correct "or".
 *
 * An exported `UPPER_SNAKE_CASE` constant is recognised through either of two
 * syntaxes: `export const NAME = ...` directly, or a bare `const NAME = ...`
 * whose name is separately re-listed in a top-level `export { NAME }`
 * clause — `export { NAME as Other }` included, since `NAME` is still the
 * binding this file declares.
 *
 * SOFTELA: Softela.Bugworx is plain JavaScript (`.js`/`.jsx`, shapes written
 * as JSDoc `@typedef`), so the destination this rule names for a `.js`/`.jsx`
 * file is `types.js`/`constants.js`, not `types.ts`/`constants.ts`; a
 * `.ts`/`.tsx` file keeps the `.ts` destinations. The `type`/`interface`/
 * `enum` detection below is unchanged from upstream and is TypeScript-only
 * syntax — in a `.js`/`.jsx` file it is the exported `UPPER_SNAKE_CASE`
 * constant half of this rule that actually applies; this rule does not parse
 * a JSDoc `@typedef` and never fires on one.
 */

const { ask, pass } = require("../lib/decision");
const { globToRegex } = require("../lib/project-resolver");
const { relativeToRepo } = require("../lib/repo-path");
const { maskCommentsAndStrings, buildDepthBeforeEachIndex } = require("../lib/source-mask");

/** Tool names this rule inspects: file-write calls on both hosts. */
const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file)$/;

/** Source extensions this rule reads for a declaration or for logic. */
const SOURCE_EXTENSION = /\.(ts|tsx|js|jsx)$/i;

/** A TypeScript source extension, which decides whether the advice names a .ts or a .js destination. */
const TYPESCRIPT_EXTENSION = /\.tsx?$/i;

/** A test file by its own naming convention, independent of any config. */
const TEST_FILE_SUFFIX = /\.(test|spec)\.[a-z0-9]+$/i;

/** The barrel a folder publishes; re-exports only, never a target here. */
const INDEX_FILE = /^index\.(ts|tsx|js|jsx)$/i;

/** A dedicated types file, in its single-file form. */
const TYPES_FILE = /^types\.(ts|tsx|js|jsx)$/i;

/** A dedicated constants file. */
const CONSTANTS_FILE = /^constants\.(ts|tsx|js|jsx)$/i;

/**
 * Matches a top-level `interface Name` declaration. Deliberately does not
 * require a following `{`/`extends`, the same as `component-types-file.js`'s
 * own copy of this pattern: both always follow in real syntax, and requiring
 * either only adds a way to miss one.
 */
const INTERFACE_DECL = /\binterface\s+([A-Za-z_$][\w$]*)/g;

/**
 * Matches a top-level `type Name = ...` declaration, generic parameters
 * included. The trailing `=` (not `==`) is what tells a real declaration
 * apart from `import type Name from "..."`.
 */
const TYPE_DECL = /\btype\s+([A-Za-z_$][\w$]*)\s*(?:<[^;{}]*>)?\s*=(?!=)/g;

/** Matches a top-level `enum Name` or `const enum Name` declaration. */
const ENUM_DECL = /\b(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/g;

/**
 * Matches an `UPPER_SNAKE_CASE` constant declared and exported in one
 * statement: `export const NAME = ...`. Requiring `export` keeps this to the
 * shared-code question the standard raises — a private, module-internal
 * constant is not a destination question for anyone outside the file.
 */
const UPPER_SNAKE_CONST_DECL = /\bexport\s+const\s+([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)\s*[:=]/g;

/**
 * Matches a bare `UPPER_SNAKE_CASE` constant declaration, independent of
 * whether the statement itself carries `export` — the two-part export form
 * (`const NAME = ...;` elsewhere paired with `export { NAME };`) declares its
 * binding here, at its own `const`, not at the `export {}` clause that later
 * re-lists it. Whether a match found this way is actually exported is
 * decided separately, against the names collected by
 * {@link collectExportedLocalNames}.
 */
const BARE_UPPER_SNAKE_CONST_DECL = /\bconst\s+([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)\s*[:=]/g;

/**
 * Matches a top-level `export { ... }` clause that exports local bindings, as
 * opposed to `export { ... } from "..."`, which re-exports someone else's
 * bindings and says nothing about a local `const` declared in this file.
 */
const EXPORT_LIST_CLAUSE = /\bexport\s*\{([^}]*)\}(?!\s*from\b)/g;

/**
 * The type-declaration searches, in the order ties are broken: whichever
 * match sits earliest in the file wins, regardless of which list found it.
 * A constant declaration is found separately, by
 * {@link findExportedConstants}, and folded into the same tie-break in
 * {@link firstTopLevelDeclaration}.
 */
const DECLARATION_SEARCHES = [
  { re: INTERFACE_DECL, family: "type", label: "interface" },
  { re: TYPE_DECL, family: "type", label: "type alias" },
  { re: ENUM_DECL, family: "type", label: "enum" },
];

/**
 * A control-flow statement — the plainest sign that a file is running steps,
 * not describing a shape. `switch`/`if`/`for`/`while` require an immediately
 * following `(` so an identifier that merely starts with the same letters
 * (`switchValue`) is never mistaken for the keyword.
 */
const CONTROL_FLOW = /\b(?:if|for|while|switch)\s*\(|\btry\s*\{|\bcatch\s*\(/;

/** An asynchronous step, which cannot appear inside a type or an enum body. */
const AWAIT_KEYWORD = /\bawait\b/;

/**
 * A state or effect hook call — `useState(`, `useEffect(`, a custom
 * `useOrderSummary(` — the shape a store, a hook or a context actually takes
 * once it holds real behaviour rather than only a name.
 */
const HOOK_CALL = /\buse[A-Z]\w*\s*\(/;

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
 * Decides whether a path is one of the destinations this rule points a
 * violation toward, so writing directly to one of them is never itself a
 * violation: a dedicated `types.ts`/`types.js`, a file under a `types/`
 * folder, a dedicated `constants.ts`/`constants.js`, a barrel, or a test
 * file.
 *
 * @param {string} fileName The file's own basename.
 * @param {string[]} dirSegments The path segments before the file name.
 * @returns {boolean} `true` when the path is one of these destinations.
 */
function isOwnDestination(fileName, dirSegments) {
  if (INDEX_FILE.test(fileName)) return true;
  if (TYPES_FILE.test(fileName)) return true;
  if (CONSTANTS_FILE.test(fileName)) return true;
  if (TEST_FILE_SUFFIX.test(fileName)) return true;
  return dirSegments.some((segment) => segment.toLowerCase() === "types");
}

/**
 * Collects every local binding name a top-level `export { ... }` clause
 * exports, taking the name before `as` when the clause renames it — the
 * local binding is what a file actually declares, and the alias is only the
 * name a caller sees.
 *
 * @param {string} masked Content already passed through
 * {@link maskCommentsAndStrings}.
 * @param {Int32Array} depths Brace depth before each index of `masked`, from
 * {@link buildDepthBeforeEachIndex}.
 * @returns {Set<string>} The exported local binding names.
 */
function collectExportedLocalNames(masked, depths) {
  const names = new Set();

  EXPORT_LIST_CLAUSE.lastIndex = 0;
  let m;
  while ((m = EXPORT_LIST_CLAUSE.exec(masked))) {
    if (depths[m.index] !== 0) continue;
    for (const entry of m[1].split(",")) {
      const localName = entry.trim().split(/\s+as\s+/i)[0].trim();
      if (localName) names.add(localName);
    }
  }

  return names;
}

/**
 * Finds every `UPPER_SNAKE_CASE` constant this file exports, through either
 * the direct `export const NAME` form or the two-part `const NAME` plus
 * `export { NAME }` form, each paired with the position of its own `const`
 * keyword so the two forms share one tie-break.
 *
 * @param {string} masked Content already passed through
 * {@link maskCommentsAndStrings}.
 * @param {Int32Array} depths Brace depth before each index of `masked`, from
 * {@link buildDepthBeforeEachIndex}.
 * @returns {{index: number, name: string}[]} Every exported constant found,
 * unordered.
 */
function findExportedConstants(masked, depths) {
  const found = [];

  UPPER_SNAKE_CONST_DECL.lastIndex = 0;
  let m;
  while ((m = UPPER_SNAKE_CONST_DECL.exec(masked))) {
    if (depths[m.index] === 0) found.push({ index: m.index, name: m[1] });
  }

  const exportedLocalNames = collectExportedLocalNames(masked, depths);
  BARE_UPPER_SNAKE_CONST_DECL.lastIndex = 0;
  while ((m = BARE_UPPER_SNAKE_CONST_DECL.exec(masked))) {
    if (depths[m.index] === 0 && exportedLocalNames.has(m[1])) {
      found.push({ index: m.index, name: m[1] });
    }
  }

  return found;
}

/**
 * Finds the earliest top-level type, interface, enum or `UPPER_SNAKE_CASE`
 * constant declaration in already-masked source text.
 *
 * @param {string} masked Content already passed through
 * {@link maskCommentsAndStrings}.
 * @returns {{name: string, family: "type"|"constant", label: string} | null}
 * The earliest declaration found, or `null` when none sits at brace depth
 * zero.
 */
function firstTopLevelDeclaration(masked) {
  const depths = buildDepthBeforeEachIndex(masked);

  let best = null;
  for (const { re, family, label } of DECLARATION_SEARCHES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(masked))) {
      if (depths[m.index] === 0 && (best === null || m.index < best.index)) {
        best = { index: m.index, name: m[1], family, label };
      }
    }
  }

  for (const constant of findExportedConstants(masked, depths)) {
    if (best === null || constant.index < best.index) {
      best = { index: constant.index, name: constant.name, family: "constant", label: "constant" };
    }
  }

  return best ? { name: best.name, family: best.family, label: best.label } : null;
}

/**
 * Decides whether already-masked source text carries real behaviour, as
 * opposed to only declaring shapes: a control-flow statement, an `await`, or
 * a state/effect hook call.
 *
 * @param {string} masked Content already passed through
 * {@link maskCommentsAndStrings}.
 * @returns {boolean} `true` when at least one of the three signals is
 * present.
 */
function hasNonTrivialLogic(masked) {
  return CONTROL_FLOW.test(masked) || AWAIT_KEYWORD.test(masked) || HOOK_CALL.test(masked);
}

module.exports = {
  /** kebab-case, unique, equals the filename without .js */
  id: "module-file-shape",

  /** one line, shown by `softela-ai doctor` */
  title: "A new non-component module mixes its jobs",

  /** which host events this rule can fire on */
  events: ["PreToolUse"],

  /** which tool names it applies to; null means every tool */
  tools: WRITE_TOOLS,

  /** the strongest action this rule may ever return */
  defaultAction: "ask",

  /** which catalogue group this rule belongs to */
  group: "code",

  /** frontend-only: the module-shape split this rule reads for is a frontend architecture concern */
  stacks: ["frontend"],

  /** a nudge, not a request for the developer's decision — see core/engine.js's step 9 */
  advisoryAsk: true,

  /** an existing file that already mixes its jobs predates this rule; splitting it is a refactor, not a requirement for touching it */
  newCodeOnly: true,

  /** dotted project-config paths this rule needs to be meaningful */
  requiresConfig: ["conventions.componentFolders"],

  /** optional: only active when this module is enabled */
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: "ask", reason: string, fix?: string}} An
   * advisory `ask` when a new file outside the component tree declares its
   * own type, interface, enum or `UPPER_SNAKE_CASE` constant alongside real
   * logic, `null` otherwise.
   */
  evaluate(ctx) {
    const conventions = ctx.project && ctx.project.conventions;
    const componentPattern = conventions && conventions.componentFolders;
    if (!componentPattern) return pass();

    const rel = relativePath(ctx);
    if (!rel) return pass();

    const segments = rel.split("/");
    const fileName = segments[segments.length - 1] || "";
    if (!SOURCE_EXTENSION.test(fileName)) return pass();
    if (isOwnDestination(fileName, segments.slice(0, -1))) return pass();

    const componentFolderRe = globToRegex(componentPattern);
    if (componentFolderRe && componentFolderRe.test(rel)) return pass();

    // Fires only for a file that does not yet exist; an already-mixed module
    // that predates this rule is left to the newCodeOnly softening.
    if (ctx.readFile(ctx.filePath) !== null) return pass();

    // R3 decision: kept on ctx.content, not resultingContent — the check
    // above already returns for any existing file, so this only ever reaches
    // a brand-new file (a Write, or an apply_patch add), where content ===
    // resultingContent always (write-decode.js only sets `insertedText` for a
    // decoded Edit/MultiEdit, both of which target an EXISTING file).
    const content = String(ctx.content || "");
    if (!content.trim()) return pass();

    const masked = maskCommentsAndStrings(content);
    if (!hasNonTrivialLogic(masked)) return pass();

    const declaration = firstTopLevelDeclaration(masked);
    if (!declaration) return pass();

    const apiLayerPattern = conventions && conventions.apiLayer;
    const apiLayerRe = apiLayerPattern ? globToRegex(apiLayerPattern) : null;
    const isApiLayerFile = Boolean(apiLayerRe && apiLayerRe.test(rel));

    // SOFTELA: Softela.Bugworx is plain JavaScript, so a .js/.jsx file is
    // pointed at types.js/constants.js rather than the TypeScript-only
    // types.ts/constants.ts; a .ts/.tsx file keeps the .ts destinations.
    const destinationExtension = TYPESCRIPT_EXTENSION.test(fileName) ? "ts" : "js";

    const destination =
      declaration.family === "constant"
        ? `a constants.${destinationExtension} beside "${fileName}"`
        : isApiLayerFile
          ? "the project's shared types location"
          : `a types.${destinationExtension} beside "${fileName}". A store and an API service are the exception — their types stay at the project's shared types location`;

    return ask(
      `"${fileName}" declares the ${declaration.label} "${declaration.name}" inline and also carries real logic — docs/standards/shared-code-boundaries.md ("The same pattern applies beyond components") and docs/standards/component-structure.md keep a module's declarations apart from its behaviour.`,
      `Move "${declaration.name}" into ${destination}.`,
    );
  },
};
