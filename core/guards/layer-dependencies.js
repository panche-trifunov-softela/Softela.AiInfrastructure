"use strict";

/**
 * Denies a reference that points outward through the backend's layer
 * ordering — the domain reaching into the application layer, the
 * application layer reaching into infrastructure, and so on.
 *
 * This is the one rule of `docs/standards/backend-architecture.md` that is
 * worth enforcing mechanically, because it is the one that decays silently.
 * A layering violation costs nothing the day it is written and everything
 * later: once the application layer knows about infrastructure, a use case
 * can no longer be read or tested without a database, and it never becomes
 * testable again on its own. The first violation is the expensive one.
 *
 * TWO WAYS TO WRITE THE SAME MISTAKE
 *
 * A reference outward can be spelled as a `using` directive in a `.cs`
 * file or as a `ProjectReference` in a `.csproj`, and both are checked.
 * The `using` is the one that actually happens — an IDE quick-fix adds it
 * while the developer is thinking about something else — while a project
 * reference is a deliberate act somebody notices in review. Catching only
 * the loud one would be catching the wrong one.
 *
 * ORDER IS CONFIGURATION, NOT A CONSTANT
 *
 * `conventions.layers` is an ordered list, innermost first. Each entry
 * names itself, the path globs that place a file in it, and the namespace
 * segment (`token`) that identifies a reference *to* it. A file in layer
 * `i` may reference layers `0..i`; a reference to any layer after it is a
 * denial. No project name, folder name or namespace appears in this file —
 * a service that names its projects differently states its own order once,
 * in its config, exactly as RULES.md requires.
 *
 * WHAT IS READ, AND WHY THAT SCOPES IT
 *
 * Only `ctx.content` — the text this write introduces — is scanned, never
 * the file as it already stands. On an `Edit` that is the replacement text
 * alone, so editing an unrelated method in a file whose imports predate the
 * standard matches nothing and passes. The `newCodeOnly` declaration below
 * covers the remaining case, a whole-file `Write` over a file that already
 * existed, the same way `api-import-boundary` does on the frontend side.
 *
 * Both patterns are anchored at the start of a line, which is also what
 * keeps a commented-out `// using Foo.Bar;` from matching: the line begins
 * with the comment marker, not with `using`.
 */

const path = require("path");
const { deny, pass } = require("../lib/decision");
const { globToRegex } = require("../lib/project-resolver");

/** Tool names this rule treats as a file write. */
const FILE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file)$/;

/**
 * A `using` directive at the start of a line, in every form that names a
 * namespace: plain, `global`, `static`, and the alias form
 * (`using Alias = Some.Namespace;`).
 */
const USING_DIRECTIVE =
  /^[ \t]*(?:global[ \t]+)?using[ \t]+(?:static[ \t]+)?(?:[A-Za-z_]\w*[ \t]*=[ \t]*)?([A-Za-z_][\w.]*)[ \t]*;/gm;

/** A project reference in an MSBuild project file. */
const PROJECT_REFERENCE = /<ProjectReference\s[^>]*Include\s*=\s*"([^"]+)"/gi;

/** Extensions carrying `using` directives. */
const SOURCE_FILE = /\.cs$/i;

/** Extensions carrying project references. */
const PROJECT_FILE = /\.(csproj|vbproj|fsproj)$/i;

/**
 * Normalises a path to forward slashes.
 *
 * @param {string} p The path to normalise.
 * @returns {string} The same path with every backslash replaced.
 */
function toPosix(p) {
  return String(p || "").replace(/\\/g, "/");
}

/**
 * Resolves a write's target to a repository-root-relative path.
 *
 * @param {string} filePath The path being written.
 * @param {string | null} repoRoot The repository root, or `null`.
 * @returns {string} The root-relative path when resolvable, otherwise the
 * path unchanged — both forward-slash normalised.
 */
function relativeToRepo(filePath, repoRoot) {
  const p = toPosix(filePath);
  if (!repoRoot) return p;
  try {
    const rel = path.relative(repoRoot, filePath);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return toPosix(rel);
  } catch {
    // Fall through to the unrelativised path.
  }
  return p;
}

/**
 * Reads and validates the configured layer ordering.
 *
 * @param {object} project The resolved project config.
 * @returns {object[]} The usable entries, in declaration order — innermost
 * first. Empty when the config is absent or malformed, which silences the
 * rule rather than guessing an order.
 */
function layersOf(project) {
  const raw = project && project.conventions && project.conventions.layers;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      typeof entry.name === "string" &&
      typeof entry.token === "string" &&
      entry.token &&
      Array.isArray(entry.paths) &&
      entry.paths.length > 0,
  );
}

/**
 * Resolves which layer a file belongs to, by its path.
 *
 * @param {object[]} layers The configured layers, innermost first.
 * @param {string} rel The root-relative path being written.
 * @returns {number} The layer's index, or `-1` when the path belongs to no
 * configured layer — a hosting or test project, typically, which this rule
 * has no ordering opinion about.
 */
function layerIndexOfPath(layers, rel) {
  for (let i = 0; i < layers.length; i += 1) {
    for (const glob of layers[i].paths) {
      const re = globToRegex(toPosix(glob).replace(/^\.?\/+/, ""));
      if (re && re.test(rel)) return i;
    }
  }
  return -1;
}

/**
 * Resolves which layer a reference points at, by looking for a layer's
 * `token` as a whole delimited segment of the reference text.
 *
 * Segment matching, rather than a substring search, is what stops a project
 * named `ApplicationInsights` from reading as the `Application` layer. The
 * delimiters cover both spellings a reference arrives in: a dotted
 * namespace, and a relative project path.
 *
 * The LAST (outermost) matching layer wins, so a reference naming more than
 * one token is judged by the outermost thing it touches.
 *
 * @param {object[]} layers The configured layers, innermost first.
 * @param {string} reference The namespace or project path being referenced.
 * @returns {number} The layer's index, or `-1` when it names none.
 */
function layerIndexOfReference(layers, reference) {
  const segments = toPosix(reference).split(/[./\\]/).filter(Boolean);
  let found = -1;
  for (let i = 0; i < layers.length; i += 1) {
    if (segments.some((segment) => segment.toLowerCase() === layers[i].token.toLowerCase())) found = i;
  }
  return found;
}

/**
 * Finds the first outward reference in the written content.
 *
 * @param {string} content The text this write introduces.
 * @param {RegExp} pattern The reference pattern to scan with.
 * @param {object[]} layers The configured layers, innermost first.
 * @param {number} ownIndex The writing file's own layer index.
 * @returns {{reference: string, target: object} | null} The first violation
 * in source order, or `null`.
 */
function firstOutwardReference(content, pattern, layers, ownIndex) {
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(content))) {
    const reference = match[1];
    const targetIndex = layerIndexOfReference(layers, reference);
    if (targetIndex > ownIndex) return { reference, target: layers[targetIndex] };
  }
  return null;
}

module.exports = {
  id: "layer-dependencies",
  title: "A layer never references one further out than itself",
  events: ["PreToolUse"],
  tools: FILE_TOOLS,
  defaultAction: "deny",
  group: "code",

  /** backend-only: this layer ordering is the backend project layout's own */
  stacks: ["backend"],

  /** a reference that predates the standard is a refactor, not a reason to block an edit elsewhere in the file */
  newCodeOnly: true,

  requiresConfig: ["conventions.layers"],
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: "deny", reason: string, fix: string}} The
   * first outward reference this write introduces, or `null`.
   */
  evaluate(ctx) {
    const layers = layersOf(ctx.project);
    if (layers.length < 2 || !ctx.filePath) return pass();

    const isSource = SOURCE_FILE.test(ctx.filePath);
    const isProject = PROJECT_FILE.test(ctx.filePath);
    if (!isSource && !isProject) return pass();

    const repoRoot = (ctx.git && ctx.git.repoRoot) || null;
    const rel = relativeToRepo(ctx.filePath, repoRoot);
    const ownIndex = layerIndexOfPath(layers, rel);
    if (ownIndex === -1) return pass();

    const content = ctx.content || "";
    const found = firstOutwardReference(
      content,
      isSource ? USING_DIRECTIVE : PROJECT_REFERENCE,
      layers,
      ownIndex,
    );
    if (!found) return pass();

    const own = layers[ownIndex];
    return deny(
      `${own.name} must not reference ${found.target.name}: "${found.reference}" points outward, and the dependency direction only runs inward.`,
      `Depend on an abstraction ${own.name} owns and let ${found.target.name} implement it, or move what is being reached for into ${own.name}.`,
    );
  },
};
