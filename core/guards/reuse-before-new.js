"use strict";

/**
 * Nudges a developer to look for an existing helper before writing a new one
 * with a suspiciously similar name.
 *
 * The check is a bounded filename scan, never a full-text index or an export
 * index: it lists files under the project's configured source roots — or,
 * when a project declares none, the whole repository — and compares their
 * basenames against the names a new file exports. It exists to make the
 * developer look, not to be right, so anything that keeps the scan from
 * completing — no resolvable repository root, an unreadable directory, a
 * source tree bigger than the bound — is resolved as silence rather than a
 * guess.
 */

const path = require("path");
const { ask, pass } = require("../lib/decision");
const { listFilesRecursive } = require("../lib/fs-safe");
const { globToRegex } = require("../lib/project-resolver");

/**
 * Default files considered, in total across every source root scanned.
 *
 * Measured against the real repositories under active use: the largest of
 * them held 3557 source files once build output was excluded. 6000 stays
 * comfortably above that while still being a real bound — a project can raise
 * or lower it with `reuseBeforeNew.maxScanFiles`.
 */
const MAX_SCAN_FILES = 6000;

/**
 * Directory names skipped everywhere this rule scans, on top of the walker's
 * own built-in `.git`/`node_modules` skip.
 *
 * Build and tooling output holds thousands of generated files whose
 * basenames were never chosen by a developer and are not helpers anyone
 * would reuse — on a built .NET solution, `bin/` and `obj/` alone are the
 * difference between a repository with 2819 source files and one that looks
 * like it has 9091.
 */
const BUILD_OUTPUT_SKIP_DIRS = [
  "bin",
  "obj",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "packages",
  "TestResults",
  ".vs",
  ".idea",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
  "vendor",
];

/** Extensions that can declare a TypeScript/JavaScript-family export. */
const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue"];

/** Extensions that can declare a C#/.NET-family type. */
const CSHARP_EXTENSIONS = [".cs", ".razor", ".cshtml"];

/** Every source extension this rule ever compares, across both families. */
const ALL_SOURCE_EXTENSIONS = TYPESCRIPT_EXTENSIONS.concat(CSHARP_EXTENSIONS);

/**
 * Resolves which file extensions are worth scanning for a project.
 *
 * A `.csproj`, `.json` or `.sql` basename is not a helper, so only
 * extensions that could plausibly declare a reusable symbol are ever
 * compared. `conventions.language`, when a project declares it, narrows the
 * scan to that language's own family; a monorepo or a project that declares
 * no language compares against both, since either kind of file could be the
 * near-duplicate.
 *
 * @param {string | undefined} language `ctx.project.conventions.language`.
 * @returns {string[]} The extensions to scan for, lower-cased with a leading
 * dot.
 */
function sourceExtensionsFor(language) {
  if (language === "typescript" || language === "javascript") return TYPESCRIPT_EXTENSIONS;
  if (language === "csharp" || language === "dotnet") return CSHARP_EXTENSIONS;
  return ALL_SOURCE_EXTENSIONS;
}

/**
 * Reads `reuseBeforeNew.maxScanFiles` from the project config, falling back
 * to {@link MAX_SCAN_FILES} when the project sets nothing — the same
 * requiresConfig-free pattern `doc-comment-style`'s `configuredThreshold`
 * uses: a fact this rule needs to size itself, not to run at all.
 *
 * @param {object} project The resolved (preset-merged) project config.
 * @returns {number} The effective file-count bound.
 */
function configuredMaxScanFiles(project) {
  const value = project && project.reuseBeforeNew && project.reuseBeforeNew.maxScanFiles;
  return typeof value === "number" && value > 0 ? value : MAX_SCAN_FILES;
}

/** Basenames excluded from comparison: structural, not helper/hook/type names. */
const GENERIC_BASENAMES = new Set(["index"]);

/**
 * Shortest normalised name length considered for the one-edit-apart check.
 * Below this, near-total overlap is coincidence rather than a real
 * near-duplicate — `Id` and `If` are one edit apart and mean nothing alike.
 */
const MIN_COMPARABLE_LENGTH = 4;

/**
 * Per-process cache of completed scans, keyed by the resolved, sorted list of
 * source-root paths together with the extension filter and file-count bound
 * that produced the result. A guard is a pure function of its context, but
 * nothing in the contract forbids memoising an expensive, side-effect-free
 * scan across calls that share the same roots — as long as the key covers
 * everything the scan's outcome actually depends on, so two callers that
 * differ only in `conventions.language` or `reuseBeforeNew.maxScanFiles`
 * never read each other's result.
 *
 * @type {Map<string, {complete: boolean, files: {basename: string, relPath: string}[]}>}
 */
const scanCache = new Map();

/**
 * Scans a project's source roots for candidate files, bounded and cached.
 * Each result keeps the file's basename alongside its path relative to the
 * repository root, so a candidate can later be tested against
 * `conventions.componentFolders` without a second filesystem pass.
 *
 * Each root is walked with an early bail-out sized to the budget still
 * remaining after the roots scanned before it, so a pathological tree is
 * never walked to completion just to discover the combined scan is over
 * `maxScanFiles` — {@link listFilesRecursive}'s own `limit` option is what
 * makes that possible.
 *
 * @param {{absRoot: string, prefix: string}[]} roots Absolute source-root
 * directories, each paired with its own path relative to the repository
 * root (POSIX-separated).
 * @param {string[]} extensions Extensions to scan for, as resolved by
 * {@link sourceExtensionsFor}.
 * @param {number} maxScanFiles The file-count bound, as resolved by
 * {@link configuredMaxScanFiles}.
 * @returns {{complete: boolean, files: {basename: string, relPath: string}[]}}
 * `complete` is `false` when the roots together hold more than
 * `maxScanFiles` matching files, in which case `files` is empty and must not
 * be trusted.
 */
function scanFiles(roots, extensions, maxScanFiles) {
  const key = [
    roots
      .map((r) => `${r.absRoot}=>${r.prefix}`)
      .sort()
      .join("|"),
    extensions.slice().sort().join(","),
    maxScanFiles,
  ].join("::");
  const cached = scanCache.get(key);
  if (cached) return cached;

  let all = [];
  let complete = true;
  for (const root of roots) {
    const remaining = maxScanFiles - all.length;
    const walked = listFilesRecursive(root.absRoot, { skipDirs: BUILD_OUTPUT_SKIP_DIRS, extensions, limit: remaining });
    if (!walked.complete) {
      complete = false;
      break;
    }
    for (const rel of walked.files) {
      all.push({ rel, relPath: root.prefix ? `${root.prefix}/${rel}` : rel });
    }
  }

  let result;
  if (!complete) {
    result = { complete: false, files: [] };
  } else {
    const files = [];
    for (const f of all) {
      const base = path.basename(f.rel, path.extname(f.rel));
      if (base && !GENERIC_BASENAMES.has(base.toLowerCase())) files.push({ basename: base, relPath: f.relPath });
    }
    result = { complete: true, files };
  }

  scanCache.set(key, result);
  return result;
}

/** A leading `use`/`get`/`is` prefix sitting on a real word boundary. */
const HOOK_PREFIX = /^(use|get|is)(?=[A-Z0-9]|$)/;

/**
 * Strips a leading `use`/`get`/`is` prefix when it sits on a real word
 * boundary, then lowercases the remainder for comparison.
 *
 * @param {string} name An exported identifier or a file basename.
 * @returns {string} The normalised, comparable form.
 */
function normalizeName(name) {
  const stripped = name.replace(HOOK_PREFIX, "");
  return (stripped || name).toLowerCase();
}

/**
 * Checks whether a name reads as a component: `PascalCase`, and not itself a
 * `use`/`get`/`is`-prefixed hook, getter or predicate. A component file and a
 * hook that happen to share a root word — `Loading` and `useLoading`,
 * `Empty` and `isEmpty` — legitimately coexist, so a candidate that lives in
 * a component folder is only compared against an export that is
 * component-shaped too.
 *
 * @param {string} name An exported identifier.
 * @returns {boolean} `true` when the name is PascalCase and unprefixed.
 */
function looksComponentShaped(name) {
  return /^[A-Z]/.test(name) && !HOOK_PREFIX.test(name);
}

/**
 * Computes whether two strings are identical or one edit apart, without
 * paying for a full edit-distance table on names that already differ wildly
 * in length.
 *
 * @param {string} a The first string.
 * @param {string} b The second string.
 * @returns {boolean} `true` when the Levenshtein distance is 0 or 1.
 */
function withinOneEdit(a, b) {
  if (a === b) return true;
  const lenDiff = Math.abs(a.length - b.length);
  if (lenDiff > 1) return false;

  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    edits++;
    if (edits > 1) return false;
    if (a.length === b.length) {
      i++;
      j++;
    } else if (a.length > b.length) {
      i++;
    } else {
      j++;
    }
  }
  edits += a.length - i + (b.length - j);
  return edits <= 1;
}

/**
 * Basename shapes a component-folder move creates beside the component it
 * relocates: the component's own file, its barrel, and a colocated hook.
 *
 * @param {string} fileBase A new file's basename with its extension
 * stripped.
 * @param {string} folderBase The basename of the folder `fileBase` lives
 * directly inside.
 * @returns {boolean} `true` when `fileBase` is one of the three shapes,
 * `false` when `folderBase` is empty or `fileBase` matches none of them.
 */
function isFolderMoveMember(fileBase, folderBase) {
  if (!folderBase) return false;
  if (fileBase === folderBase) return true;
  if (fileBase.toLowerCase() === "index") return true;
  return fileBase === `use${folderBase}`;
}

/**
 * Resolves the one pre-move location a component-folder move's new write
 * would otherwise report as a near-duplicate.
 *
 * A move from `<dir>/<Base><ext>` to `<dir>/<Base>/<Base><ext>` — or to its
 * barrel `<dir>/<Base>/index<ext>`, or to its colocated hook
 * `<dir>/<Base>/use<Base><ext>` — is not a duplicate of the flat file it
 * replaces; it IS that file, relocated. This resolves the flat file's
 * directory and basename so the near-match scan can exclude exactly that one
 * candidate, and only when the write is actually shaped like such a move.
 *
 * @param {string} filePathRel The new file's path, POSIX-separated and
 * relative to the repository root.
 * @returns {{dir: string, base: string} | null} The pre-move flat file's
 * directory (relative to the repository root, `""` at the root) and
 * basename, compared case-sensitively and without an extension — or `null`
 * when the write is not shaped like a folder move.
 */
function moveExclusion(filePathRel) {
  const dir = path.posix.dirname(filePathRel);
  if (dir === ".") return null;

  const folderBase = path.posix.basename(dir);
  const fileBase = path.posix.basename(filePathRel, path.posix.extname(filePathRel));
  if (!isFolderMoveMember(fileBase, folderBase)) return null;

  const grandDir = path.posix.dirname(dir);
  return { dir: grandDir === "." ? "" : grandDir, base: folderBase };
}

/**
 * Checks whether a candidate file is exactly the pre-move flat file a
 * folder-move write is excluded against.
 *
 * @param {string} candidateRelPath A scanned candidate's path, relative to
 * the repository root.
 * @param {{dir: string, base: string} | null} exclusion The result of
 * {@link moveExclusion} for the file currently being written.
 * @returns {boolean} `true` when `candidateRelPath` is the one file the move
 * excludes.
 */
function isMoveExcludedCandidate(candidateRelPath, exclusion) {
  if (!exclusion) return false;
  const dir = path.posix.dirname(candidateRelPath);
  if ((dir === "." ? "" : dir) !== exclusion.dir) return false;
  return path.posix.basename(candidateRelPath, path.posix.extname(candidateRelPath)) === exclusion.base;
}

/**
 * Extracts the public names declared by `export { a, b as c, default };`
 * lists, which name a symbol declared elsewhere in the file (or re-exported
 * from another module) rather than declaring one inline. The alias, when
 * present, is the name that is actually visible to an importer, so it is
 * what a reuse comparison must use; a bare `default` entry names nothing a
 * developer chose, so it is skipped.
 *
 * @param {string} content The written content.
 * @returns {string[]} The exported names found, in appearance order.
 */
function extractExportListNames(content) {
  const names = [];
  const listRe = /\bexport\s*\{([^}]*)\}/g;
  let list;
  while ((list = listRe.exec(content))) {
    for (const entry of list[1].split(",")) {
      const m = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(entry);
      if (!m) continue;
      const name = m[2] || m[1];
      if (name !== "default") names.push(name);
    }
  }
  return names;
}

/**
 * Extracts exported helper, hook, class and type names from newly written
 * TypeScript/JavaScript or C# source text.
 *
 * @param {string} content The written content.
 * @returns {string[]} The exported names found, in appearance order.
 */
function extractExportedNames(content) {
  const names = [];
  const patterns = [
    /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+interface\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+type\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+const\s+([A-Za-z_$][\w$]*)/g,
    /\bpublic\s+(?:static\s+)?(?:class|interface|struct|record)\s+([A-Za-z_][\w]*)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(content))) names.push(m[1]);
  }
  return names.concat(extractExportListNames(content));
}

module.exports = {
  /** kebab-case, unique, equals the filename without .js */
  id: "reuse-before-new",

  /** one line, shown by `softela-ai doctor` */
  title: "Look for an existing helper before adding a near-duplicate",

  /** which host events this rule can fire on */
  events: ["PreToolUse"],

  /** which tool names it applies to; null means every tool */
  tools: /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file)$/,

  /** the strongest action this rule may ever return */
  defaultAction: "ask",

  /**
   * A backstop for a search the agent was supposed to do itself, not a
   * decision only the developer can take: the rulebook says so in as many
   * words. On a host with no interactive ask it is surfaced rather than
   * blocking; see `core/engine.js`'s step 10.
   */
  advisoryAsk: true,

  /** which catalogue group this rule belongs to */
  group: "code",

  /** dotted project-config paths this rule needs to be meaningful */
  requiresConfig: [],

  /** optional: only active when this module is enabled */
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: "ask", reason: string, fix?: string}} The
   * decision, or `null` when nothing close enough was found — including
   * every case where the scan itself could not be trusted.
   */
  evaluate(ctx) {
    const conventions = ctx.project && ctx.project.conventions;
    const configuredRoots =
      conventions && Array.isArray(conventions.sourceRoots) && conventions.sourceRoots.length > 0
        ? conventions.sourceRoots
        : null;

    const filePath = String(ctx.filePath || "");
    if (!filePath) return pass();

    /** An existing file is an edit, not a new helper being introduced. */
    if (ctx.readFile(filePath) !== null) return pass();

    // R3 decision: kept on ctx.content, not resultingContent — the
    // `ctx.readFile(filePath) !== null` check right above already returns
    // for any existing file, so this only ever reaches a brand-new file (a
    // Write, or an apply_patch add), where content === resultingContent
    // always (write-decode.js only sets `insertedText` for a decoded Edit/
    // MultiEdit, both of which target an EXISTING file by construction).
    const exported = extractExportedNames(String(ctx.content || ""));
    if (exported.length === 0) return pass();

    const base = (ctx.git && ctx.git.repoRoot) || ctx.cwd || "";
    if (!base) return pass();

    /**
     * An explicitly configured project keeps its own, narrower scan
     * unchanged. A project that declares nothing falls back to the whole
     * repository root — `"."`, resolved the same way a configured entry
     * would be — which is what makes the rule live on every repository
     * instead of only the ones someone has hand-configured.
     */
    const roots = configuredRoots || ["."];
    const absoluteRoots = roots.map((r) => {
      const absRoot = path.resolve(base, r);
      const prefix = path.relative(base, absRoot).split(path.sep).join("/");
      return { absRoot, prefix };
    });

    const extensions = sourceExtensionsFor(conventions && conventions.language);
    const maxScanFiles = configuredMaxScanFiles(ctx.project);

    const scan = scanFiles(absoluteRoots, extensions, maxScanFiles);
    if (!scan.complete) return pass();

    const componentFolders = ctx.project && ctx.project.conventions ? ctx.project.conventions.componentFolders : null;
    const componentFolderRe = componentFolders ? globToRegex(componentFolders) : null;

    /**
     * The one pre-move flat file this write is excluded against, when the
     * write is itself shaped like a component moving into its own folder
     * (see {@link moveExclusion}) — `null` for an ordinary new file, which
     * excludes nothing.
     */
    const filePathRel = path.relative(base, filePath).split(path.sep).join("/");
    const exclusion = moveExclusion(filePathRel);

    /**
     * One entry per distinct basename, remembering whether any file sharing
     * that basename lives under the project's component folders — the
     * signal that keeps a component name from colliding with an unrelated
     * hook or util that merely shares a root word — alongside every path
     * that basename was found at, so a match can be told apart from the one
     * specific file this write's own folder move excludes.
     */
    const candidates = new Map();
    for (const file of scan.files) {
      const inComponentFolder = Boolean(componentFolderRe && componentFolderRe.test(file.relPath));
      const entry = candidates.get(file.basename);
      if (entry) {
        entry.isComponent = entry.isComponent || inComponentFolder;
        entry.paths.push(file.relPath);
      } else {
        candidates.set(file.basename, { isComponent: inComponentFolder, paths: [file.relPath] });
      }
    }

    const seen = new Set();
    for (const name of exported) {
      const normalized = normalizeName(name);
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      for (const [candidate, info] of candidates) {
        /**
         * A candidate that only exists as a component must not collide with
         * an export that is not itself component-shaped — `useLoading` and
         * `Loading`, or `isEmpty` and `Empty`, name different kinds of thing
         * and legitimately coexist.
         */
        if (info.isComponent && !looksComponentShaped(name)) continue;

        const candidateNormalized = normalizeName(candidate);
        const exact = normalized === candidateNormalized;
        const closeEnough = exact || (normalized.length >= MIN_COMPARABLE_LENGTH && candidateNormalized.length >= MIN_COMPARABLE_LENGTH && withinOneEdit(normalized, candidateNormalized));
        if (!closeEnough) continue;

        /**
         * A folder move excludes only the one flat file it relocates; a
         * second file sharing the same basename somewhere else in the
         * repository is a genuine, unrelated near-duplicate and must still
         * be reported.
         */
        const realMatches = info.paths.filter((p) => !isMoveExcludedCandidate(p, exclusion));
        if (realMatches.length > 0) {
          return ask(
            `REUSE RULE: "${name}" is very close to the existing "${candidate}". A near-duplicate ` +
              "name usually means the helper already exists under a slightly different spelling.",
            `Search the source roots for "${candidate}" before adding "${name}"; extend or import it instead if it already does this.`,
          );
        }
      }
    }

    return pass();
  },
};
