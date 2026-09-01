"use strict";

/**
 * A module specifier that climbs several folders out reaches for the
 * project's path alias instead.
 *
 * `../../../../utils/storage` says nothing about where it lands. It is
 * unreadable at the point of use, it silently retargets the moment either
 * file moves, and it is the most common reason a component folder cannot be
 * relocated or extracted without a search-and-replace across the tree — the
 * exact property `component-structure.md` builds the folder to protect. The
 * aliased form, `@/utils/storage`, names the destination, survives a move of
 * the importing file, and reads the same from anywhere.
 *
 * ## When it fires
 *
 * Only when all four hold, which is what keeps it quiet on ordinary work:
 *
 * 1. **The project declares `conventions.pathAliases`.** Without a
 *    configured alias there is no better form to point at, and a rule whose
 *    fix is "first go and set up an alias" is a rule that gets switched off.
 *    A project that has not adopted aliases never hears from this rule.
 * 2. **The specifier climbs at least `limits.relativeImportDepth` levels**
 *    (default {@link DEFAULT_MAX_DEPTH}). One or two levels is ordinary
 *    composition inside a feature — a child reaching its parent's `utils/`,
 *    a view reaching the folder above it. Three is where the specifier has
 *    left the feature and stopped describing anything.
 * 3. **The resolved target lands under one of the declared alias roots**, so
 *    the fix names the exact replacement rather than gesturing at one. A
 *    specifier climbing clear of every configured root is left alone.
 * 4. **The file is new.** Rewriting the import graph of a file that already
 *    exists is a refactor, not a condition of touching it.
 */

const path = require("path");
const { deny, pass } = require("../lib/decision");
const { relativeToRepo } = require("../lib/repo-path");

/** Tool names this rule inspects: file-write calls on both hosts. */
const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file)$/;

/**
 * How many `../` segments a specifier may carry before this rule speaks,
 * when the project sets no `limits.relativeImportDepth` of its own.
 *
 * Three, because two is still a shape a reader can hold: a child component
 * reaching its parent folder's shared code. At three the specifier has left
 * the feature it was written in, and from there the count only grows.
 */
const DEFAULT_MAX_DEPTH = 3;

/** Module extensions whose imports this rule reads. */
const MODULE_EXTENSION = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/i;

/** A test file by its own naming convention, independent of any config. */
const TEST_FILE_SUFFIX = /\.(test|spec)\.[a-z0-9]+$/i;

/**
 * Import, re-export, `require` and dynamic-`import` forms carrying a module
 * specifier as a quoted string, each with the specifier captured in group 1.
 *
 * Type-only forms are deliberately included, unlike in `api-import-boundary`
 * where the question is runtime coupling. Here the question is whether the
 * specifier can be read and whether it survives a move, and a type-only
 * import fails both the same way a value import does.
 */
const SPECIFIER_PATTERNS = [
  /\bimport\s+["']([^"']+)["']/g,
  /\bimport\s+[^;'"()]*?\bfrom\s+["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s+from\s+["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/**
 * Replaces line and block comments with spaces, so a specifier written only
 * in prose or in a commented-out line is never read as a real import.
 *
 * @param {string} src The raw file content.
 * @returns {string} The content with comment bodies blanked out, its
 * newlines and overall length preserved.
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (two === "/*") {
      out += "  ";
      i += 2;
      while (i < n && src.slice(i, i + 2) !== "*/") {
        out += src[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

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
 * Counts the leading parent-directory segments a relative specifier opens
 * with.
 *
 * Only the leading run is counted: `../../a/../b` climbs two levels, and the
 * inner `..` is a normalisation artefact rather than a reader's problem.
 *
 * @param {string} specifier The raw specifier text.
 * @returns {number} The number of leading parent-directory segments; `0` for
 * any specifier that is not relative or does not start by climbing.
 */
function leadingClimbs(specifier) {
  if (!specifier.startsWith(".")) return 0;
  let count = 0;
  for (const segment of specifier.split("/")) {
    if (segment === "..") count += 1;
    else break;
  }
  return count;
}

/**
 * Extracts every module specifier the content imports, re-exports or
 * requires.
 *
 * @param {string} src Content already passed through {@link stripComments}.
 * @returns {string[]} The specifier strings, in source order, duplicates
 * included.
 */
function extractSpecifiers(src) {
  const found = [];
  for (const re of SPECIFIER_PATTERNS) {
    re.lastIndex = 0;
    let m = re.exec(src);
    while (m !== null) {
      found.push(m[1]);
      m = re.exec(src);
    }
  }
  return found;
}

/**
 * Rewrites a resolved project-relative target as an aliased specifier, when
 * it lands inside one of the declared alias roots.
 *
 * The longest matching root wins, so a project declaring both `"@": "src"`
 * and `"@components": "src/components"` gets the more specific of the two
 * rather than whichever the object happened to list first.
 *
 * @param {string} targetRel The import target, project-relative and
 * forward-slash separated.
 * @param {Object.<string, string>} aliases Map of alias prefix to the
 * project-relative directory it stands for.
 * @returns {string|null} The aliased specifier, or `null` when the target
 * sits under no declared root.
 */
function toAliasedSpecifier(targetRel, aliases) {
  let best = null;
  for (const prefix of Object.keys(aliases)) {
    const root = String(aliases[prefix] || "").replace(/\/+$/, "");
    if (!root) continue;
    if (targetRel !== root && !targetRel.startsWith(`${root}/`)) continue;
    if (best && best.root.length >= root.length) continue;
    const rest = targetRel.slice(root.length).replace(/^\/+/, "");
    best = { root, specifier: rest ? `${prefix}/${rest}` : prefix };
  }
  return best ? best.specifier : null;
}

/**
 * Reads the project's configured climb threshold.
 *
 * @param {object} ctx The evaluation context.
 * @returns {number} The threshold, or {@link DEFAULT_MAX_DEPTH} when the
 * project declares none, or declares one that is not a usable positive
 * integer.
 */
function maxDepth(ctx) {
  const limits = ctx.project && ctx.project.limits;
  const configured = limits && limits.relativeImportDepth;
  if (typeof configured !== "number" || !Number.isFinite(configured) || configured < 1) {
    return DEFAULT_MAX_DEPTH;
  }
  return Math.floor(configured);
}

module.exports = {
  /** kebab-case, unique, equals the filename without .js */
  id: "import-depth",

  /** one line, shown by `softela-ai doctor` */
  title: "A deep relative import uses the project's path alias instead",

  /** which host events this rule can fire on */
  events: ["PreToolUse"],

  /** which tool names it applies to; null means every tool */
  tools: WRITE_TOOLS,

  /** the strongest action this rule may ever return */
  defaultAction: "deny",

  /** which catalogue group this rule belongs to */
  group: "code",

  /** frontend-only: path aliases are a frontend module-graph concern */
  stacks: ["frontend"],

  /** an existing file's import graph predates this rule; rewriting it is a refactor */
  newCodeOnly: true,

  /** dotted project-config paths this rule needs to be meaningful */
  requiresConfig: ["conventions.pathAliases"],

  /** optional: only active when this module is enabled */
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: string, reason: string, fix?: string}} A deny
   * decision naming the first over-deep specifier and its aliased form,
   * `null` otherwise.
   */
  evaluate(ctx) {
    const conventions = ctx.project && ctx.project.conventions;
    const aliases = conventions && conventions.pathAliases;
    if (!aliases || typeof aliases !== "object" || Object.keys(aliases).length === 0) return pass();

    const rel = relativePath(ctx);
    if (!rel) return pass();

    const fileName = rel.split("/").pop() || "";
    if (!MODULE_EXTENSION.test(fileName)) return pass();
    if (TEST_FILE_SUFFIX.test(fileName)) return pass();

    // New files only, the same line every other structural rule draws: an
    // import graph that already exists is a refactor to fix, not a condition
    // of editing the file it lives in.
    if (ctx.readFile(ctx.filePath) !== null) return pass();

    const content = String(ctx.content || "");
    if (!content.trim()) return pass();

    const threshold = maxDepth(ctx);
    const fromDir = path.posix.dirname(rel);

    for (const specifier of extractSpecifiers(stripComments(content))) {
      const climbs = leadingClimbs(specifier);
      if (climbs < threshold) continue;

      const targetRel = path.posix.normalize(path.posix.join(fromDir, specifier));
      // A specifier climbing clear of every configured root has no aliased
      // form to be rewritten into, so there is nothing to ask for.
      if (targetRel.startsWith("..")) continue;

      const aliased = toAliasedSpecifier(targetRel, aliases);
      if (!aliased) continue;

      return deny(
        `"${specifier}" climbs ${climbs} folders out of "${rel}". A specifier that long names nothing a reader can ` +
          "place, and it silently retargets the moment either file moves — which is what stops a component folder " +
          "being relocated or extracted without a search-and-replace across the tree.",
        `Import it as "${aliased}" instead.`,
      );
    }

    return pass();
  },
};
