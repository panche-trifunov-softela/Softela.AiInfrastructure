"use strict";

/**
 * Test files must sit beside the code they cover.
 *
 * A test named `<Subject>.test.tsx` (or `.spec.`) must live directly inside
 * a `__tests__` folder, never beside the file it covers with no test folder
 * at all.
 *
 * Which `__tests__` folder that has to be depends on what the subject is,
 * because a component folder owns two different kinds of thing — see
 * `docs/standards/testing.md`:
 *
 * - **A component** is tested from its own folder's `__tests__`. A nested
 *   child is itself a component folder, so testing it from an ancestor's
 *   `__tests__` is the misplacement this rule exists to catch.
 * - **Everything else that folder owns** — its hook, its context, its
 *   utilities — is tested from the owning component's `__tests__`, which is
 *   where the standard's own `OrderPanel` example puts `useOrderPanel.test.ts`
 *   and `canEditOrder.test.ts`. None of them has a folder of its own to sit
 *   beside.
 *
 * The two are told apart by the shapes `docs/standards/naming.md` defines,
 * read from `core/lib/naming-patterns.js` so this rule and `naming-standards`
 * share one definition: PascalCase is a component and camelCase is not, with
 * the context as the exception in between. `naming.md` spells a context
 * `PascalCase` + `Context`, and `component-structure.md` gives it no folder
 * — one context sits in the component folder beside the view, several sit
 * together in `contexts/` — so it is a module the folder owns, not a folder.
 *
 * That a component has a folder of its own is a component-folder convention,
 * so it is asked only of paths under `conventions.componentFolders`:
 * PascalCase is equally how a type, an enum and a class are spelled, and
 * outside the component tree that is what a PascalCase subject is.
 *
 * The check is lexical by default: a PascalCase, non-Context subject under
 * `conventions.componentFolders` is assumed to own a folder. For that one
 * case, before trusting the guess, the rule performs a small, bounded
 * filesystem probe through `ctx.statFile`:
 *
 * - it derives a candidate directory for the subject, first from the spec's
 *   own relative import of it (the reliable source, since the spec's own
 *   content says exactly where it looked) — preferring, when more than one
 *   import resolves to the subject's name, whichever one resolves inside
 *   `conventions.componentFolders`, so a same-named mock or fixture import
 *   cannot point the probe at the wrong directory — falling back to the
 *   literal, glob-free prefix of `conventions.componentFolders` when no
 *   usable import is found;
 * - it checks, at that directory, for the folder-shaped main file
 *   (`<dir>/<Subject>/<Subject>.<ext>`) and for a flat file
 *   (`<dir>/<Subject>.<ext>`), across a short, fixed list of extensions;
 *   `<dir>` is repo-relative, but `ctx.statFile` resolves a relative path
 *   against `ctx.cwd`, which is not guaranteed to be the repository root — so
 *   every path actually handed to `ctx.statFile` is built as an absolute
 *   path anchored on `(ctx.git && ctx.git.repoRoot) || ctx.cwd`, the same
 *   anchor `relativePath` uses to derive `rel` itself;
 * - a found folder-shaped file confirms the lexical guess; a found flat file
 *   with no folder-shaped file overrides it — the subject is still in legacy
 *   flat form, so a spec for it is not required to sit in a folder of its
 *   own; and when neither can be established, the rule falls back to the
 *   unmodified lexical guess.
 *
 * The probe can only ever loosen the decision, never tighten it, and it is
 * bounded to a small, fixed number of `statFile` calls against one candidate
 * directory — it never walks a directory listing.
 *
 * This closes the false positive the lexical guess used to produce for a
 * component still in flat-file form tested from a shared, central
 * `__tests__` folder. It leaves one gap exactly where it was: a spec sitting
 * in the `__tests__` of a component that does not actually own it is still
 * accepted lexically, and the nested-child-component misplacement the rule
 * exists for is unaffected by any of this.
 */

const path = require("path");
const { deny, pass } = require("../lib/decision");
const { isComponentName, isContextName } = require("../lib/naming-patterns");
const { globToRegex } = require("../lib/project-resolver");
const { relativeToRepo, joinRepoPath } = require("../lib/repo-path");

/** Tool names this rule inspects: file-write calls on both hosts. */
const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file)$/;

/**
 * Matches a test file's name, capturing the subject it claims to cover.
 *
 * The subject is the leading, dot-free segment of the filename: any dotted
 * qualifier between it and `.test.`/`.spec.` (`.integration`, `.a11y`,
 * `.snapshot`, ...) is skipped rather than swallowed into the capture, so a
 * qualified test name still resolves to its real subject.
 */
const TEST_FILE = /^([^.]+)(?:\.[^.]+)*\.(test|spec)\.[jt]sx?$/i;

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
 * Reports whether a spec's subject is something that has a folder of its own.
 *
 * A component is the only thing a component folder holds that is itself a
 * folder. A context is PascalCase too, but `component-structure.md` gives it
 * no folder — it is a module the folder owns, exactly like the folder's hook
 * and its utilities, and is tested from a `__tests__` the same way they are.
 *
 * @param {string} subject The subject named by the test file.
 * @returns {boolean} Whether the subject has a folder of its own to sit beside.
 */
function hasOwnFolder(subject) {
  return isComponentName(subject) && !isContextName(subject);
}

/**
 * Reports whether a path sits inside the project's declared component folders.
 *
 * `conventions.componentFolders` is read here but never gates the rule, the
 * same way `api-import-boundary` reads `conventions.pathAliases`: a project
 * that declares no component folders gets the component check everywhere,
 * which is the behaviour that stood before the convention was consulted.
 *
 * @param {object} ctx The evaluation context.
 * @param {string} rel The project-relative path of the test file.
 * @returns {boolean} Whether the path is under `conventions.componentFolders`.
 */
function inComponentTree(ctx, rel) {
  const pattern = ctx.project.conventions && ctx.project.conventions.componentFolders;
  if (!pattern) return true;
  const re = globToRegex(pattern);
  return re ? re.test(rel) : true;
}

/** Extensions worth probing for a subject's own module file. */
const MODULE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];

/**
 * Import, re-export and `require` forms that carry a module specifier as a
 * quoted string, with the specifier captured in group 1.
 *
 * A lightweight pass, not a parser — it is only ever used to guess a
 * directory to probe, never to decide an outcome on its own, so a specifier
 * missed inside an unusual construct just means the probe falls back to the
 * `conventions.componentFolders` prefix or to the unmodified lexical guess.
 */
const SPECIFIER_PATTERNS = [
  /\bimport\s+["']([^"']+)["']/g,
  /\bimport\s+[^;'"()]*?\bfrom\s+["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s+from\s+["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/**
 * Extracts every module specifier a spec's own import, re-export or
 * `require` statement references.
 *
 * @param {string} content The spec file's own content.
 * @returns {string[]} The specifier strings, in the order they appear.
 */
function extractSpecifiers(content) {
  const found = [];
  for (const re of SPECIFIER_PATTERNS) {
    re.lastIndex = 0;
    let m = re.exec(content);
    while (m !== null) {
      found.push(m[1]);
      m = re.exec(content);
    }
  }
  return found;
}

/**
 * Resolves one relative module specifier against the spec's own directory
 * and reports the directory that would contain the subject's own folder or
 * flat file, when the specifier actually names the subject.
 *
 * A specifier ending in `.../<Subject>/<Subject>` already names the
 * folder-shaped main file explicitly, so the directory that would contain a
 * sibling flat file or component folder sits one level higher than an
 * ordinary `.../<Subject>` specifier resolves to.
 *
 * @param {string} specDir The spec file's own directory, posix-separated.
 * @param {string} specifier The raw, quoted specifier text.
 * @param {string} subject The subject name the spec claims to cover.
 * @returns {string|null} The candidate directory, or `null` when the
 * specifier is not relative or does not name the subject.
 */
function resolveSpecifierDir(specDir, specifier, subject) {
  if (!specifier.startsWith(".")) return null;
  const resolved = path.posix.join(specDir, specifier);
  const segments = resolved.split("/").filter(Boolean);
  if (!segments.length || segments[segments.length - 1] !== subject) return null;
  if (segments.length >= 2 && segments[segments.length - 2] === subject) {
    return segments.slice(0, -2).join("/") || ".";
  }
  return segments.slice(0, -1).join("/") || ".";
}

/** Characters that mark a glob segment as non-literal. */
const GLOB_META = /[*?{}[\]!]/;

/**
 * Reports the longest literal, glob-free prefix of a glob pattern.
 *
 * @param {string|undefined} glob The glob pattern, or `undefined`.
 * @returns {string|null} The prefix, or `null` when the pattern has no
 * literal leading segment at all.
 */
function literalGlobPrefix(glob) {
  if (typeof glob !== "string" || !glob) return null;
  const literal = [];
  for (const segment of glob.split("/")) {
    if (GLOB_META.test(segment)) break;
    literal.push(segment);
  }
  return literal.length ? literal.join("/") : null;
}

/**
 * Derives a single candidate directory to probe for a subject's own module
 * file.
 *
 * The spec's own content is the reliable source: a relative import of the
 * subject names, unambiguously, where the spec itself believes the subject
 * lives. More than one specifier can resolve to the subject's name — a mock
 * or a fixture imported under the same name as the real subject — so, among
 * every specifier that matches, one that resolves inside
 * `conventions.componentFolders` is preferred over the first match found;
 * only when none does does the first match stand. The literal prefix of
 * `conventions.componentFolders` itself is a fallback for when no specifier
 * yields a usable directory at all, not a replacement for one.
 *
 * @param {object} ctx The evaluation context.
 * @param {string} rel The spec file's own repo-relative path.
 * @param {string} subject The subject name the spec claims to cover.
 * @returns {string|null} A repo-relative directory, or `null` when neither
 * source yields one.
 */
function deriveCandidateDir(ctx, rel, subject) {
  const conventions = ctx.project && ctx.project.conventions;
  const componentPrefix = literalGlobPrefix(conventions && conventions.componentFolders);
  const content = String(ctx.content || "");

  if (content) {
    const segments = rel.split("/");
    const specDir = segments.slice(0, -1).join("/") || ".";
    let firstMatch = null;

    for (const specifier of extractSpecifiers(content)) {
      const dir = resolveSpecifierDir(specDir, specifier, subject);
      if (dir === null) continue;

      const insideComponentFolders =
        componentPrefix !== null && (dir === componentPrefix || dir.startsWith(`${componentPrefix}/`));
      if (insideComponentFolders) return dir;

      if (firstMatch === null) firstMatch = dir;
    }

    if (firstMatch !== null) return firstMatch;
  }

  return componentPrefix;
}

/**
 * Establishes, from the filesystem, whether a lexically component-shaped
 * subject actually owns a folder.
 *
 * `deriveCandidateDir` yields a repo-relative directory, but `ctx.statFile`
 * resolves a relative path against `ctx.cwd`, and `ctx.cwd` is not
 * guaranteed to be the repository root — a write's own nearest existing
 * ancestor directory can win instead (`core/lib/workdir.js#resolveWorkdir`).
 * Every path is therefore built as an absolute, forward-slash path anchored
 * on `(ctx.git && ctx.git.repoRoot) || ctx.cwd` before it reaches
 * `ctx.statFile` — the same anchor `relativePath` uses to derive `rel`
 * itself, so the probe reasons about the same repository the rest of the
 * rule does regardless of where `ctx.cwd` happens to point. `ctx.statFile`
 * sandboxes an absolute path to that same boundary, so this changes nothing
 * about what the probe is allowed to read.
 *
 * Bounded to a small, fixed number of `statFile` calls — one folder-shaped
 * main file and one flat file, across a short, fixed extension list, against
 * a single candidate directory. Never a directory listing.
 *
 * @param {object} ctx The evaluation context.
 * @param {string} rel The spec file's own repo-relative path.
 * @param {string} subject The subject name the spec claims to cover.
 * @returns {boolean|null} `true` when a folder-shaped main file was found,
 * `false` when only a flat file was found, `null` when neither could be
 * established.
 */
function probeOwnsFolder(ctx, rel, subject) {
  if (typeof ctx.statFile !== "function") return null;
  const dir = deriveCandidateDir(ctx, rel, subject);
  if (!dir) return null;

  const repoRoot = (ctx.git && ctx.git.repoRoot) || ctx.cwd;
  if (!repoRoot) return null;

  for (const ext of MODULE_EXTENSIONS) {
    const folderShaped = joinRepoPath(repoRoot, path.posix.join(dir, subject, `${subject}${ext}`));
    if (ctx.statFile(folderShaped) !== null) return true;
  }
  for (const ext of MODULE_EXTENSIONS) {
    const flat = joinRepoPath(repoRoot, path.posix.join(dir, `${subject}${ext}`));
    if (ctx.statFile(flat) !== null) return false;
  }
  return null;
}

module.exports = {
  /** kebab-case, unique, equals the filename without .js */
  id: "colocated-tests",

  /** one line, shown by `softela-ai doctor` */
  title: "Test files sit in a __tests__ folder beside their component",

  /** which host events this rule can fire on */
  events: ["PreToolUse"],

  /** which tool names it applies to; null means every tool */
  tools: WRITE_TOOLS,

  /** the strongest action this rule may ever return */
  defaultAction: "deny",

  /** which catalogue group this rule belongs to */
  group: "code",

  /** frontend-only: the __tests__-beside-component layout is a frontend convention */
  stacks: ["frontend"],

  /** an existing test's location predates the __tests__ convention; relocating it is a refactor suggestion, not a gate on editing it */
  newCodeOnly: true,

  /** dotted project-config paths this rule needs to be meaningful */
  requiresConfig: ["conventions.testFolder"],

  /** optional: only active when this module is enabled */
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: string, reason: string, fix?: string}} A deny
   * decision when a test file is not directly inside a matching `__tests__`
   * folder beside the component it names, `null` otherwise.
   */
  evaluate(ctx) {
    const conventions = ctx.project && ctx.project.conventions;
    const testFolder = conventions && conventions.testFolder;
    if (!testFolder) return pass();

    const rel = relativePath(ctx);
    if (!rel) return pass();

    const notOurs = Array.isArray(ctx.project.notOurs) ? ctx.project.notOurs : [];
    for (const glob of notOurs) {
      const re = globToRegex(glob);
      if (re && re.test(rel)) return pass();
    }

    const segments = rel.split("/");
    const fileName = segments[segments.length - 1] || "";
    const match = fileName.match(TEST_FILE);
    if (!match) return pass();

    const subject = match[1];
    const parent = segments.length >= 2 ? segments[segments.length - 2] : "";
    const grandparent = segments.length >= 3 ? segments[segments.length - 3] : "";
    const containingDir = segments.slice(0, -1).join("/") || ".";
    const lexicalOwnsFolder = hasOwnFolder(subject) && inComponentTree(ctx, rel);
    // The probe only ever runs, and only ever loosens, when the lexical
    // guess is already "yes" — see `probeOwnsFolder`'s own doc comment for
    // what a `false` versus `null` result means here.
    const probed = lexicalOwnsFolder ? probeOwnsFolder(ctx, rel, subject) : null;
    const ownsFolder = probed === false ? false : lexicalOwnsFolder;

    if (parent !== testFolder) {
      return deny(
        `A test file must sit in a "${testFolder}" folder, not directly in "${containingDir}".`,
        ownsFolder
          ? `Move it to a path ending in "${subject}/${testFolder}/${fileName}".`
          : `Move it to the "${testFolder}" folder of the folder that owns "${subject}".`,
      );
    }

    // A hook, a context or a utility has no folder of its own: the folder
    // whose `__tests__` this is owns it, and that is where it belongs.
    if (!ownsFolder) return pass();

    // Folder casing and file casing legitimately differ on a component that
    // predates the PascalCase folder convention — `dtEditor/DtEditor.tsx` —
    // and refusing that component a test is not this rule's job.
    if (grandparent.toLowerCase() === subject.toLowerCase()) return pass();

    return deny(
      `A component's test must sit in the "${testFolder}" folder of its own folder, not in "${containingDir}".`,
      `Move it to a path ending in "${subject}/${testFolder}/${fileName}".`,
    );
  },
};
