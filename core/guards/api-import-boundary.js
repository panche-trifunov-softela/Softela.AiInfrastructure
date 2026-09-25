"use strict";

/**
 * Views stay behind hooks and services, never the API layer directly.
 *
 * A file under `conventions.componentFolders` importing anything under
 * `conventions.apiLayer` collapses the layering the rest of the codebase
 * depends on, so it is denied. A relative specifier is resolved against the
 * importing file's own path; a specifier matching a prefix declared in
 * `conventions.pathAliases` is resolved against the directory that prefix
 * stands for; anything else — a project-rooted path, a bare package, or an
 * alias this rule has no configuration to resolve — is matched as written.
 * A type-only form (`import type ...`, `export type { ... } from ...`)
 * carries no runtime coupling and is never flagged.
 *
 * A component's own hook is the exception, because it is the point of the
 * layering rather than a way around it: `layer-boundaries.md` puts the call
 * to the API layer in the hook, and `component-structure.md` puts the hook
 * inside the component folder. Denying it there would deny the shape the
 * standard asks for, leaving nowhere inside a component folder that may
 * legitimately reach the backend.
 *
 * The exemption covers *consuming* the API layer, never republishing it. A
 * `use*.ts` file whose body is `export * from ".../services/api/orders"` is
 * a proxy rather than a hook: it would hand a view the whole API layer under
 * a hook's name, and the view's own import — pointing at the hook rather
 * than at the API layer — would not match `conventions.apiLayer` on the way
 * back. That defeats the rule at both hops, so a re-export of the API layer
 * is denied whatever the file is called.
 */

const path = require("path");
const { deny, pass } = require("../lib/decision");
const { isHookFileName } = require("../lib/naming-patterns");
const { globToRegex } = require("../lib/project-resolver");
const { relativeToRepo } = require("../lib/repo-path");

/** Tool names this rule inspects: file-write calls on both hosts. */
const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file)$/;

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
 * Replaces `//` and `/* *\/` comments with spaces, so a specifier mentioned
 * only in prose is never mistaken for a real import.
 *
 * @param {string} src The raw file content.
 * @returns {string} The content with comments blanked out.
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
 * Checks whether a matched `import ... from "..."` statement is type-only —
 * `import type X from "..."` or `import type { X } from "..."` — as opposed
 * to `import type from "..."`, where `type` is itself the imported binding's
 * name rather than the type-only keyword.
 *
 * @param {string} statement The full matched import statement text.
 * @returns {boolean} `true` when the statement carries no runtime binding.
 */
function isTypeOnlyImport(statement) {
  return /^import\s+type\s+(?!from\b)/i.test(statement.trim());
}

/**
 * Checks whether a matched re-export statement is type-only — `export type
 * { X } from "..."` or `export type * from "..."`.
 *
 * @param {string} statement The full matched export statement text.
 * @returns {boolean} `true` when the statement carries no runtime binding.
 */
function isTypeOnlyExport(statement) {
  return /^export\s+type\s+(?:\{|\*)/i.test(statement.trim());
}

/** Never type-only: side-effect import, `require`, dynamic `import()`. */
const neverTypeOnly = () => false;

/**
 * Import, re-export, `require` and dynamic-`import` forms that carry a
 * module specifier as a quoted string, each with the specifier captured in
 * group 1, paired with a check for whether that particular form is
 * type-only and therefore carries no runtime coupling.
 *
 * `reexport` marks the one form that republishes what it names instead of
 * consuming it. A hook may consume the API layer; nothing may hand it on
 * under another name, so the two are tracked apart.
 */
const SPECIFIER_PATTERNS = [
  { re: /\bimport\s+["']([^"']+)["']/g, typeOnly: neverTypeOnly, reexport: false },
  { re: /\bimport\s+[^;'"()]*?\bfrom\s+["']([^"']+)["']/g, typeOnly: isTypeOnlyImport, reexport: false },
  {
    re: /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s+from\s+["']([^"']+)["']/g,
    typeOnly: isTypeOnlyExport,
    reexport: true,
  },
  { re: /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, typeOnly: neverTypeOnly, reexport: false },
  { re: /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, typeOnly: neverTypeOnly, reexport: false },
];

/**
 * Extracts every module specifier referenced by an import, re-export,
 * `require`, or dynamic `import()`, skipping specifiers that arrive only
 * through a type-only form — they are erased before runtime and carry no
 * layering violation.
 *
 * @param {string} src Content already passed through `stripComments`.
 * @returns {Array<{specifier: string, reexport: boolean}>} Each specifier in
 * order, duplicates included, carrying whether the form that named it
 * republishes the module rather than consuming it.
 */
function extractSpecifiers(src) {
  const found = [];
  for (const { re, typeOnly, reexport } of SPECIFIER_PATTERNS) {
    re.lastIndex = 0;
    let m = re.exec(src);
    while (m !== null) {
      if (!typeOnly(m[0])) found.push({ specifier: m[1], reexport });
      m = re.exec(src);
    }
  }
  return found;
}

/**
 * Resolves a module specifier written inside a file to a project-relative
 * path, when it is relative or matches a configured path alias.
 *
 * @param {string} fromRel The importing file's project-relative path.
 * @param {string} specifier The raw specifier text.
 * @param {Object.<string, string>|null} aliases Map of alias prefix (e.g.
 * `"@"`) to the project-relative directory it stands for, as declared by
 * `conventions.pathAliases`. `null` when the project declares none.
 * @returns {string} The resolved, forward-slash path, or `specifier` itself
 * when it is neither relative nor a declared alias.
 */
function resolveSpecifier(fromRel, specifier, aliases) {
  if (specifier.startsWith(".")) {
    const dir = path.posix.dirname(fromRel);
    return path.posix.normalize(path.posix.join(dir, specifier));
  }
  if (aliases) {
    for (const prefix of Object.keys(aliases)) {
      if (specifier === prefix || specifier.startsWith(`${prefix}/`)) {
        const rest = specifier.slice(prefix.length).replace(/^\/+/, "");
        const mapped = String(aliases[prefix] || "");
        return path.posix.normalize(rest ? `${mapped}/${rest}` : mapped);
      }
    }
  }
  return specifier;
}

module.exports = {
  /** kebab-case, unique, equals the filename without .js */
  id: "api-import-boundary",

  /** one line, shown by `softela-ai doctor` */
  title: "A view may not import the API layer; a component's hook may",

  /** which host events this rule can fire on */
  events: ["PreToolUse"],

  /** which tool names it applies to; null means every tool */
  tools: WRITE_TOOLS,

  /** the strongest action this rule may ever return */
  defaultAction: "deny",

  /** which catalogue group this rule belongs to */
  group: "code",

  /** frontend-only: the component/API-layer boundary is a frontend architecture concern */
  stacks: ["frontend"],

  /** an existing component's direct API import predates the layering convention; routing it through a hook is a refactor, not a requirement for touching the file */
  newCodeOnly: true,

  /** dotted project-config paths this rule needs to be meaningful */
  requiresConfig: ["conventions.componentFolders", "conventions.apiLayer"],

  /** optional: only active when this module is enabled */
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: string, reason: string, fix?: string}} A deny
   * decision when a component-folder file imports the API layer directly,
   * `null` otherwise.
   */
  evaluate(ctx) {
    const conventions = ctx.project && ctx.project.conventions;
    const componentFolders = conventions && conventions.componentFolders;
    const apiLayer = conventions && conventions.apiLayer;
    if (!componentFolders || !apiLayer) return pass();

    const rel = relativePath(ctx);
    if (!rel) return pass();

    const componentsRe = globToRegex(componentFolders);
    if (!componentsRe || !componentsRe.test(rel)) return pass();

    // R3 decision: "does this WRITE introduce an api-layer import" — kept on
    // ctx.content (a decoded Edit/MultiEdit's own inserted text), not
    // resultingContent. An import statement untouched by this write was
    // already judged the write that introduced it; re-scanning the whole
    // file on every further edit would relitigate lines nobody just wrote.
    const content = String(ctx.content || "");
    if (!content) return pass();

    const apiRe = globToRegex(apiLayer);
    if (!apiRe) return pass();

    const pathAliases =
      conventions.pathAliases && typeof conventions.pathAliases === "object" ? conventions.pathAliases : null;

    const isHook = isHookFileName(path.posix.basename(rel));

    const specifiers = extractSpecifiers(stripComments(content));
    for (const { specifier, reexport } of specifiers) {
      const target = resolveSpecifier(rel, specifier, pathAliases);
      if (!apiRe.test(target)) continue;

      // The hook is where the call to the API layer belongs, so consuming it
      // there is the standard being followed rather than broken.
      if (isHook && !reexport) continue;

      if (reexport) {
        return deny(
          "Re-exporting the API layer from inside a component folder hands it on under another name, which puts it back within reach of the view.",
          `Call "${specifier}" from a hook and export what the view actually needs, rather than re-exporting the module itself.`,
        );
      }

      return deny(
        "A view may not import the API layer directly; it should go through a hook or service that sits between them.",
        `Move the call to "${specifier}" into this component's own hook, and have the view use that hook.`,
      );
    }
    return pass();
  },
};
