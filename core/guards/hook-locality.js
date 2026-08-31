"use strict";

/**
 * A hook with exactly one component consumer lives beside that component,
 * not in the global shared-hooks root.
 *
 * The global shared-hooks root (`conventions.sharedHooks`) is for a hook
 * reused by more than one component; a component's own hook belongs inside
 * the component's own folder instead (`OrderPanel/useOrderPanel.ts`). This
 * rule cannot count how many callers a hook will ever have — that would mean
 * guessing — so it fires on the one case the file itself proves: a brand-new
 * hook file, written into the shared root, whose name corresponds exactly to
 * a component that already exists somewhere in the tree. Anything less
 * certain is left alone.
 *
 * The correspondence check is a real-filesystem scan under the project's
 * configured source roots, the same technique `reuse-before-new.js` uses to
 * look at the tree — bounded, and resolved as "nothing found" rather than a
 * guess whenever the scan cannot be trusted.
 */

const path = require("path");
const { deny, pass } = require("../lib/decision");
const { globToRegex } = require("../lib/project-resolver");
const { relativeToRepo } = require("../lib/repo-path");
const { listFilesRecursive } = require("../lib/fs-safe");

/** Tool names this rule inspects: file-write calls on both hosts. */
const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file)$/;

/**
 * Files considered by the correspondence scan, in total across every
 * configured source root. Sized the same as `reuse-before-new.js`'s own
 * bound: comfortably above the largest real repository under active use,
 * while still being a real bound rather than an unbounded walk.
 */
const MAX_SCAN_FILES = 6000;

/**
 * Directory names skipped on top of `listFilesRecursive`'s own built-in
 * `.git`/`node_modules` skip — build and tooling output holds thousands of
 * generated files that were never a component or a hook anyone wrote.
 */
const SKIP_DIRS = ["dist", "build", "coverage", ".next", ".turbo", "out"];

/** Extensions the correspondence scan reads, across both hook and component files. */
const SCAN_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

/** Extensions that can hold a component's own file directly (no folder). */
const COMPONENT_FILE_EXTENSIONS = new Set([".tsx", ".jsx"]);

/** A new hook file's own extension: hooks are `.ts`, or `.tsx` when they return JSX. */
const HOOK_FILE_EXTENSION = /\.tsx?$/i;

/**
 * A leading `use` sitting on a real word boundary — `useFooBar`, never
 * `user` or `used`.
 */
const HOOK_PREFIX = /^use(?=[A-Z0-9])/;

/** A dotted `.test`/`.spec` qualifier on a hook's own base name. */
const TEST_QUALIFIER = /\.(test|spec)$/i;

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
 * Scans a project's source roots for candidate files, bounded across the
 * roots combined.
 *
 * @param {{absRoot: string, prefix: string}[]} roots Absolute source-root
 * directories, each paired with its own path relative to the repository
 * root (POSIX-separated).
 * @returns {{complete: boolean, relPaths: string[]}} `complete` is `false`
 * when the roots together hold more than {@link MAX_SCAN_FILES} matching
 * files, in which case `relPaths` is empty and must not be trusted.
 */
function scanRelPaths(roots) {
  const relPaths = [];
  for (const root of roots) {
    const remaining = MAX_SCAN_FILES - relPaths.length;
    const walked = listFilesRecursive(root.absRoot, {
      skipDirs: SKIP_DIRS,
      extensions: SCAN_EXTENSIONS,
      limit: remaining,
    });
    if (!walked.complete) return { complete: false, relPaths: [] };
    for (const rel of walked.files) relPaths.push(root.prefix ? `${root.prefix}/${rel}` : rel);
  }
  return { complete: true, relPaths };
}

/**
 * Finds the folder of a component matching `componentName`, among files
 * already known to sit under the project's `conventions.componentFolders`.
 *
 * A match is either a directory segment equal to `componentName` (the
 * component's own folder) or a file `<componentName>.tsx`/`.jsx` sitting
 * directly in `conventions.componentFolders` with no folder of its own.
 *
 * @param {string[]} componentRelPaths Scanned paths already filtered to
 * `conventions.componentFolders`.
 * @param {string} componentName The exact, case-sensitive component name to
 * look for.
 * @returns {string | null} The matching component's directory, relative to
 * the repository root (`""` at the root), or `null` when nothing matches.
 */
function findComponentDir(componentRelPaths, componentName) {
  for (const relPath of componentRelPaths) {
    const segments = relPath.split("/");
    const dirSegments = segments.slice(0, -1);

    const folderIndex = dirSegments.indexOf(componentName);
    if (folderIndex !== -1) return dirSegments.slice(0, folderIndex + 1).join("/");

    const fileName = segments[segments.length - 1];
    const ext = path.extname(fileName).toLowerCase();
    const base = fileName.slice(0, fileName.length - ext.length);
    if (base === componentName && COMPONENT_FILE_EXTENSIONS.has(ext)) return dirSegments.join("/");
  }
  return null;
}

module.exports = {
  /** kebab-case, unique, equals the filename without .js */
  id: "hook-locality",

  /** one line, shown by `softela-ai doctor` */
  title: "A hook with one component consumer lives beside that component",

  /** which host events this rule can fire on */
  events: ["PreToolUse"],

  /** which tool names it applies to; null means every tool */
  tools: WRITE_TOOLS,

  /** the strongest action this rule may ever return */
  defaultAction: "deny",

  /** which catalogue group this rule belongs to */
  group: "code",

  /** frontend-only: the shared-hooks-root convention is a frontend concern */
  stacks: ["frontend"],

  /** an already-committed misplacement predates this rule; relocating it is a refactor, not a requirement for touching it */
  newCodeOnly: true,

  /** dotted project-config paths this rule needs to be meaningful */
  requiresConfig: ["conventions.sharedHooks", "conventions.componentFolders"],

  /** optional: only active when this module is enabled */
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: string, reason: string, fix?: string}} A deny
   * decision when a new hook file's name corresponds exactly to a component
   * that already exists in the tree, `null` otherwise — including every case
   * where the correspondence cannot be established confidently.
   */
  evaluate(ctx) {
    const conventions = ctx.project && ctx.project.conventions;
    const sharedHooksGlob = conventions && conventions.sharedHooks;
    const componentFoldersGlob = conventions && conventions.componentFolders;
    if (!sharedHooksGlob || !componentFoldersGlob) return pass();

    const rel = relativePath(ctx);
    if (!rel) return pass();

    const sharedHooksRe = globToRegex(sharedHooksGlob);
    if (!sharedHooksRe || !sharedHooksRe.test(rel)) return pass();

    const componentFolderRe = globToRegex(componentFoldersGlob);
    if (!componentFolderRe) return pass();

    const segments = rel.split("/");
    const fileName = segments[segments.length - 1] || "";
    if (!HOOK_FILE_EXTENSION.test(fileName)) return pass();

    const ext = path.extname(fileName);
    const baseName = fileName.slice(0, fileName.length - ext.length);
    if (!baseName || baseName.toLowerCase() === "index") return pass();
    if (TEST_QUALIFIER.test(baseName)) return pass();

    const testFolder = conventions.testFolder;
    if (testFolder && segments.includes(testFolder)) return pass();

    if (!HOOK_PREFIX.test(baseName)) return pass();
    const componentName = baseName.slice(3);
    if (!/^[A-Z]/.test(componentName)) return pass();

    // Fires only for a file that does not yet exist; an already-misplaced
    // hook that predates this rule is left to the newCodeOnly softening.
    if (ctx.readFile(ctx.filePath) !== null) return pass();

    const base = (ctx.git && ctx.git.repoRoot) || ctx.cwd || "";
    if (!base) return pass();

    const configuredRoots =
      Array.isArray(conventions.sourceRoots) && conventions.sourceRoots.length > 0 ? conventions.sourceRoots : null;
    const roots = (configuredRoots || ["."]).map((r) => {
      const absRoot = path.resolve(base, r);
      const prefix = path.relative(base, absRoot).split(path.sep).join("/");
      return { absRoot, prefix };
    });

    const scan = scanRelPaths(roots);
    if (!scan.complete) return pass();

    const componentRelPaths = scan.relPaths.filter((p) => componentFolderRe.test(p));
    const componentDir = findComponentDir(componentRelPaths, componentName);
    if (componentDir === null) return pass();

    const destination = componentDir ? `${componentDir}/${fileName}` : fileName;
    return deny(
      `"${fileName}" is a hook for exactly one component, "${componentName}", so it does not belong in the shared hooks root — that root is for a hook reused by more than one component.`,
      `Move it beside the component it belongs to: "${destination}".`,
    );
  },
};
