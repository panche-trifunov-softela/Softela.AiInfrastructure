"use strict";

/**
 * Nudges toward the organisation's naming wiki: PascalCase for React
 * components and their files, camelCase with a `use` prefix for hooks,
 * snake_case for API URL segments, `I`-prefixed .NET interfaces, and
 * PascalCase for .NET types.
 *
 * Applies per `ctx.project.conventions.language` and is silent for any
 * project that does not declare one it recognises. Every check here is a
 * deterministic pattern match against the file's own name or a declaration
 * in its own content — there is no fuzzy judgement call to soften, so a
 * genuine mismatch denies.
 */

const path = require("path");
const { deny, pass } = require("../lib/decision");
const { HOOK_NAME, PASCAL_CASE } = require("../lib/naming-patterns");
const { globToRegex } = require("../lib/project-resolver");

/** Tool names this rule inspects, shared with every other file-content rule. */
const FILE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file)$/;

const I_PREFIXED_INTERFACE = /^I[A-Z][A-Za-z0-9]*$/;
const CAMEL_SEGMENT = /^[a-z0-9]+[A-Z][A-Za-z0-9]*$/;

/** A path segment that marks hook modules, independent of any project config. */
const HOOKS_PATH_SEGMENT = /(^|\/)hooks(\/|$)/i;

/**
 * Extensions a hook module can carry. A JavaScript project writes
 * `useOrderPanel.js`; the convention it is judged against is the same one.
 */
const HOOK_FILE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

/** A secondary suffix sitting between a colocated file's real name and its extension. */
const SECONDARY_SUFFIX = /\.(test|spec|stories|d)$/i;

/**
 * Splits a file path into its POSIX-separated relative form, its base name
 * without extension, and its lower-cased extension.
 *
 * @param {object} ctx The evaluation context.
 * @returns {{rel: string, stem: string, ext: string}} The decomposed path;
 * every field is `""` when `ctx.filePath` is empty.
 */
function splitPath(ctx) {
  const filePath = ctx.filePath || "";
  if (!filePath) return { rel: "", stem: "", ext: "" };

  const boundary = (ctx.git && ctx.git.repoRoot) || ctx.cwd || "";
  let rel = filePath;
  if (boundary) {
    try {
      const candidate = path.relative(boundary, filePath);
      if (candidate && !candidate.startsWith("..") && !path.isAbsolute(candidate)) rel = candidate;
    } catch {
      // Fall back to the raw path.
    }
  }
  rel = rel.replace(/\\/g, "/");

  const base = rel.split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return { rel, stem: base, ext: "" };
  return { rel, stem: base.slice(0, dot), ext: base.slice(dot).toLowerCase() };
}

/**
 * Splits a file stem into the name it shares with the thing it colocates
 * with and any trailing secondary suffix (`.test`, `.spec`, `.stories`,
 * `.d`), so `Widget.test` is judged on `Widget`, not on the whole stem.
 *
 * @param {string} stem The file's base name without its final extension.
 * @returns {{name: string, suffix: string}} The significant name and the
 * suffix stripped from it, `""` when there was none.
 */
function splitSecondarySuffix(stem) {
  const m = stem.match(SECONDARY_SUFFIX);
  if (!m) return { name: stem, suffix: "" };
  return { name: stem.slice(0, m.index), suffix: m[0] };
}

/**
 * Checks a React component file's base name against PascalCase, scoped to
 * the project's declared component folders.
 *
 * A `use`-prefixed name is a hook by convention, whatever extension it
 * carries: a hook legitimately takes `.tsx`/`.jsx` when it genuinely returns
 * JSX (a render prop, a column renderer), and PascalCase is not its
 * convention. Judging one here denied it with a fix — "rename
 * `useColumnRenderer` to `UseColumnRenderer`" — that is wrong in both
 * directions, so hooks are left to {@link checkHookName}.
 *
 * @param {object} ctx The evaluation context.
 * @param {{rel: string, stem: string, ext: string}} file The decomposed
 * path.
 * @returns {{action: "deny", reason: string, fix: string} | null} The
 * decision, or `null` when the check does not apply or the name is fine.
 */
function checkComponentName(ctx, file) {
  if (file.ext !== ".tsx" && file.ext !== ".jsx") return null;
  if (file.stem.toLowerCase() === "index") return null;

  const pattern = ctx.project.conventions && ctx.project.conventions.componentFolders;
  if (!pattern) return null;
  const re = globToRegex(pattern);
  if (!re || !re.test(file.rel)) return null;

  const { name, suffix } = splitSecondarySuffix(file.stem);
  if (HOOK_NAME.test(name)) return null;
  if (PASCAL_CASE.test(name)) return null;

  return deny(
    `React components and their files use PascalCase; "${file.stem}" does not.`,
    `Rename to "${name.charAt(0).toUpperCase()}${name.slice(1)}${suffix}".`,
  );
}

/**
 * Checks a hook file's base name for the camelCase `use` prefix, scoped to
 * a `hooks` path segment so an ordinary "use"-prefixed domain noun
 * elsewhere in the project is never judged as a hook.
 *
 * @param {{rel: string, stem: string, ext: string}} file The decomposed
 * path.
 * @returns {{action: "deny", reason: string, fix: string} | null} The
 * decision, or `null` when the check does not apply or the name is fine.
 */
function checkHookName(file) {
  if (!HOOK_FILE_EXTENSIONS.has(file.ext)) return null;
  if (!HOOKS_PATH_SEGMENT.test(file.rel)) return null;

  const { name } = splitSecondarySuffix(file.stem);
  if (!/^use/i.test(name)) return null;
  if (HOOK_NAME.test(name)) return null;

  return deny(
    `Hooks use camelCase with a "use" prefix; "${file.stem}" does not.`,
    'Rename to the "useThing" shape, e.g. "useFetchInterval".',
  );
}

/**
 * Checks quoted `/api/...` literals for a camelCase segment, scoped to the
 * project's declared API layer.
 *
 * @param {object} ctx The evaluation context.
 * @param {{rel: string}} file The decomposed path.
 * @returns {{action: "deny", reason: string, fix: string} | null} The
 * decision, or `null` when the check does not apply or nothing is wrong.
 */
function checkApiUrlSegments(ctx, file) {
  const pattern = ctx.project.conventions && ctx.project.conventions.apiLayer;
  if (!pattern) return null;
  const re = globToRegex(pattern);
  if (!re || !re.test(file.rel)) return null;

  // R3 decision: kept on ctx.content, not resultingContent — this checks
  // URL literals this WRITE introduces; an existing literal untouched by
  // this write was already judged when it was itself written.
  const urlLiteral = /["'`](\/api\/[a-zA-Z0-9/_-]+)["'`]/g;
  const content = ctx.content || "";
  let m;
  while ((m = urlLiteral.exec(content))) {
    const segments = m[1].split("/").filter(Boolean);
    for (const segment of segments) {
      if (segment === "api") continue;
      if (CAMEL_SEGMENT.test(segment)) {
        const snake = segment.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
        return deny(
          `API URL segments use snake_case; "${segment}" in "${m[1]}" does not.`,
          `Rename to "${snake}".`,
        );
      }
    }
  }
  return null;
}

/**
 * Runs every TypeScript-side check in a fixed order.
 *
 * @param {object} ctx The evaluation context.
 * @returns {{action: "deny", reason: string, fix: string} | null} The first
 * violation found, or `null`.
 */
function evaluateTypeScript(ctx) {
  const file = splitPath(ctx);
  return checkComponentName(ctx, file) || checkHookName(file) || checkApiUrlSegments(ctx, file) || null;
}

/**
 * Blanks out `//` and `/* *\/` comments and quoted string/char literals in
 * C# source text, so a name mentioned only in prose or a literal is never
 * read as a real declaration.
 *
 * @param {string} text The C# source text to mask.
 * @returns {string} The same text with comment and literal bodies replaced
 * by spaces, every newline preserved.
 */
function maskCSharpCommentsAndStrings(text) {
  const s = String(text || "");
  let out = "";
  let i = 0;

  while (i < s.length) {
    const two = s.slice(i, i + 2);

    if (two === "//") {
      while (i < s.length && s[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }

    if (two === "/*") {
      out += "  ";
      i += 2;
      while (i < s.length && s.slice(i, i + 2) !== "*/") {
        out += s[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < s.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }

    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += " ";
      i += 1;
      while (i < s.length && s[i] !== quote) {
        if (s[i] === "\\" && i + 1 < s.length) {
          out += "  ";
          i += 2;
          continue;
        }
        out += s[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < s.length) {
        out += " ";
        i += 1;
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * Checks .NET interface and type declarations found in the content being
 * written.
 *
 * @param {object} ctx The evaluation context.
 * @param {{rel: string, ext: string}} file The decomposed path.
 * @returns {{action: "deny", reason: string, fix: string} | null} The first
 * violation found, in declaration order, or `null`.
 */
function checkCSharpDeclarations(ctx, file) {
  if (file.ext !== ".cs") return null;
  // R3 decision: kept on ctx.content, not resultingContent — this checks
  // declarations this WRITE introduces or renames; a declaration untouched
  // by this write was already judged when it was itself written.
  const content = maskCSharpCommentsAndStrings(ctx.content || "");

  const interfaceDecl = /\binterface\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = interfaceDecl.exec(content))) {
    if (!I_PREFIXED_INTERFACE.test(m[1])) {
      return deny(`.NET interfaces are "I"-prefixed; "${m[1]}" is not.`, `Rename to "I${m[1]}".`);
    }
  }

  const typeDecl = /\b(?:class|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  while ((m = typeDecl.exec(content))) {
    if (!PASCAL_CASE.test(m[1])) {
      return deny(
        `.NET types use PascalCase; "${m[1]}" does not.`,
        `Rename to "${m[1].charAt(0).toUpperCase()}${m[1].slice(1)}".`,
      );
    }
  }

  return null;
}

/**
 * Runs every .NET-side check in a fixed order.
 *
 * @param {object} ctx The evaluation context.
 * @returns {{action: "deny", reason: string, fix: string} | null} The first
 * violation found, or `null`.
 */
function evaluateCSharp(ctx) {
  const file = splitPath(ctx);
  return checkCSharpDeclarations(ctx, file) || checkApiUrlSegments(ctx, file) || null;
}

module.exports = {
  id: "naming-standards",
  title: "Follow the organisation's naming conventions",
  events: ["PreToolUse"],
  tools: FILE_TOOLS,
  defaultAction: "deny",
  group: "code",

  /** an existing name predates the naming convention; renaming it is a refactor suggestion, not a requirement for touching the file */
  newCodeOnly: true,

  requiresConfig: ["conventions.language"],

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: "deny", reason: string, fix: string}} The first
   * naming violation found for the project's declared language, or `null`
   * when the language is absent, unrecognised, or nothing is wrong.
   */
  evaluate(ctx) {
    const language = ctx.project && ctx.project.conventions && ctx.project.conventions.language;
    let result = null;
    if (language === "typescript" || language === "javascript") result = evaluateTypeScript(ctx);
    else if (language === "csharp" || language === "dotnet") result = evaluateCSharp(ctx);
    return result || pass();
  },
};
