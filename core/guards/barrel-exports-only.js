"use strict";

/**
 * A barrel `index` file may only import and re-export.
 *
 * Inside a component folder, `index.ts` / `index.tsx` exists purely to
 * re-export the folder's public surface. Any executable statement or
 * declaration turns an import graph into a load-order problem, so it is
 * denied outright rather than merely asked about.
 *
 * The check is line-oriented, not a parser: comments and the interior of
 * string and template literals are masked first, keeping quote characters,
 * brackets and newlines intact, so a semicolon or brace inside a re-export's
 * path never reads as statement structure.
 */

const { deny, pass } = require("../lib/decision");
const { globToRegex } = require("../lib/project-resolver");
const { relativeToRepo } = require("../lib/repo-path");
const { maskCommentsAndStrings: maskSource } = require("../lib/source-mask");

/**
 * Masks comments and string/template literals, keeping the quote characters
 * themselves and leaving a visibly non-empty filler behind — this rule reads
 * a re-export's structure, so it needs to see THAT a string was there
 * without reading what was inside it.
 *
 * @param {string} src The raw file content.
 * @returns {string} The masked content, the same length as `src`.
 */
function maskCommentsAndStrings(src) {
  return maskSource(src, { filler: "#", keepQuotes: true });
}

/** Tool names this rule inspects: file-write calls on both hosts. */
const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file)$/;

/**
 * Matches a barrel file's name, in every extension a project this rulebook
 * covers actually writes one in. A JavaScript project's `index.js` is the
 * same barrel as a TypeScript project's `index.ts` and has the same
 * load-order problem when logic creeps into it; keying the rule to `.ts`
 * alone left it silently inert on every project that has not adopted
 * TypeScript.
 */
const INDEX_FILE = /^index\.(tsx?|jsx?|mts|cts|mjs|cjs)$/i;

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
 * Groups masked content into logical statement chunks by tracking bracket
 * depth across lines, so a multi-line import's continuation lines stay with
 * the statement they belong to instead of being judged on their own.
 *
 * @param {string} masked Content already passed through
 * `maskCommentsAndStrings`.
 * @returns {string[]} The logical chunks, in order.
 */
function toLogicalChunks(masked) {
  const chunks = [];
  let buf = "";
  let depth = 0;
  for (const line of masked.split("\n")) {
    buf += buf ? `\n${line}` : line;
    for (const ch of line) {
      if (ch === "{" || ch === "(" || ch === "[") depth += 1;
      else if (ch === "}" || ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    }
    if (depth === 0) {
      chunks.push(buf);
      buf = "";
    }
  }
  if (buf.trim()) chunks.push(buf);
  return chunks;
}

/**
 * Checks whether one statement is a form a barrel file is allowed to hold.
 *
 * Allowed: a blank statement, an `import` that binds something (default,
 * named, namespace or type import — always carrying a `from` clause), an
 * `export type` line, a bare `export *` re-export, or an `export { ... }`
 * re-export. Anything else — a value declaration, a call, a control-flow
 * statement, and a bare side-effect-only `import "specifier";` with no
 * binding — is not: a bare import runs its target's module-load-time code
 * the instant anything imports the barrel, the exact load-order problem
 * this rule exists to deny.
 *
 * @param {string} statement A single trimmed statement.
 * @returns {boolean} `true` when the statement is one of the allowed forms.
 */
function isAllowedBarrelStatement(statement) {
  const s = statement.trim();
  if (!s) return true;
  if (/^import\b/.test(s)) return /\bfrom\s*["']/.test(s);
  if (/^export\s+type\b/.test(s)) return true;
  if (/^export\s*\*/.test(s)) return true;
  if (/^export\s*\{/.test(s)) return true;
  return false;
}

module.exports = {
  /** kebab-case, unique, equals the filename without .js */
  id: "barrel-exports-only",

  /** one line, shown by `softela-ai doctor` */
  title: "A barrel index file may only import and re-export",

  /** which host events this rule can fire on */
  events: ["PreToolUse"],

  /** which tool names it applies to; null means every tool */
  tools: WRITE_TOOLS,

  /** the strongest action this rule may ever return */
  defaultAction: "deny",

  /** which catalogue group this rule belongs to */
  group: "code",

  /** frontend-only: barrel-file discipline is a frontend module-graph concern */
  stacks: ["frontend"],

  /** an existing barrel file with logic in it needs a refactor to fix, not a block on every further edit */
  newCodeOnly: true,

  /** dotted project-config paths this rule needs to be meaningful */
  requiresConfig: ["conventions.componentFolders"],

  /** optional: only active when this module is enabled */
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: string, reason: string, fix?: string}} A deny
   * decision when a component-folder barrel file holds anything beyond
   * imports, re-exports and `export type` lines, `null` otherwise.
   */
  evaluate(ctx) {
    const conventions = ctx.project && ctx.project.conventions;
    const pattern = conventions && conventions.componentFolders;
    if (!pattern) return pass();

    const rel = relativePath(ctx);
    if (!rel) return pass();

    const fileName = rel.split("/").pop() || "";
    if (!INDEX_FILE.test(fileName)) return pass();

    const patternRe = globToRegex(pattern);
    if (!patternRe || !patternRe.test(rel)) return pass();

    // R3: "may this file hold ONLY imports/re-exports" is a whole-file
    // question — a decoded MultiEdit inserting one allowed re-export line
    // says nothing about whatever else the file already holds. Falls back
    // to ctx.content when reconstruction failed: a Write/apply_patch add
    // already has content === resultingContent, and checking only what was
    // inserted (rather than staying silent) is the same fail-open direction
    // this rule already took before ctx.resultingContent existed.
    const content = String(typeof ctx.resultingContent === "string" ? ctx.resultingContent : ctx.content || "");
    if (!content.trim()) return pass();

    const masked = maskCommentsAndStrings(content);
    for (const chunk of toLogicalChunks(masked)) {
      for (const statement of chunk.split(";")) {
        if (!isAllowedBarrelStatement(statement)) {
          return deny(
            "A barrel index file may only hold imports, re-exports, export type lines and comments; this line adds executable logic to it.",
            "Move the logic into its own file and re-export it from here instead.",
          );
        }
      }
    }
    return pass();
  },
};
