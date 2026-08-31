"use strict";

/**
 * A component's view renders; its logic lives in the component's own hook.
 *
 * This is the single load-bearing rule of the frontend component standard —
 * `docs/standards/component-structure.md` puts it first ("The view renders.
 * That is all.") and names `use<Component>` as the file that holds "state,
 * effects, data access, validation, event handling and everything else the
 * component does as opposed to shows". Everything else the standard asks for
 * (the folder, `types.ts`, the barrel) is scaffolding around that split.
 *
 * It was also the one thing nothing checked. `component-folder-shape` sees
 * where a file sits, `component-types-file` sees an inline type, and both
 * fired correctly on a component that then went on to put two `useState`
 * calls, a `useEffect` registering a `window` keydown listener, an async
 * dispatch and the whole click state machine inside the view file — 235
 * lines, of which roughly 130 were logic. The folder was right and the
 * contents were exactly what the folder exists to prevent.
 *
 * ## What counts as logic here, and what deliberately does not
 *
 * Only markers that cannot be read as rendering:
 *
 * - `useState` / `useReducer` — state, by definition.
 * - `useEffect` / `useLayoutEffect` — effects, by definition.
 * - `addEventListener` — imperative wiring to something outside this tree.
 * - `await` / `.then(` — data access.
 *
 * `useMemo` and `useCallback` are NOT markers. The standard explicitly allows
 * the view "rendering-only logic — a conditional class, a mapped list, a
 * small piece of formatting", and both are routinely how that is expressed
 * without re-rendering the world. A rule that fired on them would be wrong
 * often enough to be argued with, and a rule that gets argued with gets
 * switched off.
 *
 * A custom hook the view merely CALLS (`useDrillDown(...)`, `useTranslation()`)
 * is not a marker either: calling the hook that holds the logic is exactly
 * what a view is supposed to do.
 *
 * ## Scope
 *
 * New files only, like its two siblings: the split is a refactor on an
 * existing component, not something to relitigate on every edit. Governs the
 * view file alone — never the folder's own `use*` hook (that is where these
 * markers belong), never `types.ts`, `constants.ts`, the barrel, or a test.
 */

const { deny, pass } = require("../lib/decision");
const { globToRegex } = require("../lib/project-resolver");
const { relativeToRepo } = require("../lib/repo-path");
const { maskCommentsAndStrings } = require("../lib/source-mask");

/** Tool names this rule inspects: file-write calls on both hosts. */
const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file)$/;

/** A test file by its own naming convention, independent of any config. */
const TEST_FILE_SUFFIX = /\.(test|spec)\.[a-z0-9]+$/i;

/** The barrel file a component folder publishes. */
const INDEX_FILE = /^index\.(ts|tsx)$/i;

/** A component-folder hook — where every marker below legitimately belongs. */
const HOOK_FILE = /^use[A-Za-z0-9_].*\.tsx?$/;

/** A component's own view file. */
const VIEW_EXTENSION = /\.(tsx|jsx)$/i;

/**
 * The markers, each with the name used when reporting it.
 *
 * Every pattern requires the call's own opening parenthesis, so a marker
 * named in an import list, a type position or a comment is not a match — the
 * content is masked first, but an `import { useState } from "react"` line is
 * not a comment and would otherwise count.
 */
const LOGIC_MARKERS = [
  { name: "useState", re: /\buseState\s*[(<]/ },
  { name: "useReducer", re: /\buseReducer\s*[(<]/ },
  { name: "useEffect", re: /\buseEffect\s*\(/ },
  { name: "useLayoutEffect", re: /\buseLayoutEffect\s*\(/ },
  { name: "addEventListener", re: /\baddEventListener\s*\(/ },
  { name: "await", re: /\bawait\s+/ },
  { name: "a .then() chain", re: /\.\s*then\s*\(/ },
];

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
 * Lists every logic marker present in a piece of source text.
 *
 * @param {string} content The file content to scan.
 * @returns {string[]} The names of the markers found, in the order
 * {@link LOGIC_MARKERS} declares them; empty when the file is view-only.
 */
function findLogicMarkers(content) {
  const masked = maskCommentsAndStrings(content);
  return LOGIC_MARKERS.filter((m) => m.re.test(masked)).map((m) => m.name);
}

/**
 * Names the hook file a component's logic belongs in, derived from the view
 * file's own name.
 *
 * @param {string} fileName The view file's basename, e.g. `"BTNViewer.tsx"`.
 * @returns {string} The hook's basename, e.g. `"useBTNViewer.ts"`.
 */
function hookFileNameFor(fileName) {
  const base = fileName.replace(VIEW_EXTENSION, "");
  return `use${base.charAt(0).toUpperCase()}${base.slice(1)}.ts`;
}

module.exports = {
  /** kebab-case, unique, equals the filename without .js */
  id: "component-view-logic",

  /** one line, shown by `softela-ai doctor` */
  title: "A component's view renders; its logic belongs in the component's hook",

  /** which host events this rule can fire on */
  events: ["PreToolUse"],

  /** which tool names it applies to; null means every tool */
  tools: WRITE_TOOLS,

  /** the strongest action this rule may ever return */
  defaultAction: "deny",

  /** which catalogue group this rule belongs to */
  group: "code",

  /** frontend-only: the view/logic split is a frontend architecture concern */
  stacks: ["frontend"],

  /** logic already living in an existing view predates this rule; extracting it is a refactor */
  newCodeOnly: true,

  /** dotted project-config paths this rule needs to be meaningful */
  requiresConfig: ["conventions.componentFolders"],

  /** optional: only active when this module is enabled */
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: string, reason: string, fix?: string}} A deny
   * decision when a new component view carries state, effects, imperative
   * event wiring or data access; `null` otherwise.
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

    if (!VIEW_EXTENSION.test(fileName)) return pass();
    if (INDEX_FILE.test(fileName)) return pass();
    if (TEST_FILE_SUFFIX.test(fileName)) return pass();
    // A `use*.tsx` file is the hook, even though it carries a view extension
    // — it takes `.tsx` only when it genuinely returns JSX. Its whole job is
    // to hold what this rule is looking for.
    if (HOOK_FILE.test(fileName)) return pass();

    const testFolder = conventions.testFolder;
    if (testFolder && segments.includes(testFolder)) return pass();

    // New files only. `ctx.readFile` returning content means the view already
    // exists, and pulling its logic out is a refactor rather than a condition
    // of touching it — the same line `component-folder-shape` and
    // `component-types-file` draw.
    if (ctx.readFile(ctx.filePath) !== null) return pass();

    const content = String(ctx.content || "");
    if (!content.trim()) return pass();

    const markers = findLogicMarkers(content);
    if (markers.length === 0) return pass();

    const dir = segments.slice(0, -1).join("/");
    const hookName = hookFileNameFor(fileName);
    const hookPath = dir ? `${dir}/${hookName}` : hookName;

    return deny(
      `"${fileName}" is a component view but carries ${markers.join(", ")}. ` +
        "A view renders: it reads values and handlers from its own hook and its props and turns them into JSX. " +
        "State, effects, event wiring and data access belong in the component's hook, so the view stays readable, " +
        "the logic stays testable without rendering anything, and neither can be changed by accident while editing " +
        "the other.",
      `Move it into "${hookPath}", have it return the values and handlers the view needs, and call it from "${fileName}". ` +
        "Rendering-only work — a conditional class, a mapped list, a piece of display formatting — stays in the view.",
    );
  },
};
