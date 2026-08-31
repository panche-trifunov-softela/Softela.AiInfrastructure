"use strict";

/**
 * Denies rewriting a versioned migration script that already exists in the
 * repository.
 *
 * A versioned migration is applied once per database and then recorded, by
 * version and by checksum, in the migration tool's own history table. Once
 * it has run anywhere, its text is no longer a source file that can be
 * corrected — it is a description of a change that has already happened.
 * Editing it leaves the file and the recorded checksum disagreeing, and the
 * next run fails against every database that had already applied it while
 * passing cleanly against a fresh one. The developer who wrote the edit sees
 * a green local run; the failure surfaces on somebody else's machine, or in
 * an environment nobody can reset.
 *
 * WHY THIS IS NOT `protected-paths`
 *
 * `protected-paths` is deliberately blind to whether a file already exists —
 * it protects a named file whatever is happening to it, which is exactly
 * right for a manifest or a credential. A migration directory cannot be
 * protected that way: adding the NEXT versioned script is the ordinary,
 * expected route for every schema change, and it writes a file whose path
 * matches the same glob as every script already applied. A `deny` there
 * would block routine work, and a rule that fires on routine work gets
 * switched off. So this rule asks the one question `protected-paths` never
 * does — did this file already exist? — through `ctx.changeScope`
 * (`lib/change-scope.js`, reached by declaring `readsChangeScope`).
 *
 * The direction matters, and it is the mirror image of `newCodeOnly`: a
 * `newCodeOnly` rule holds new code to a standard and softens for code that
 * predates it, while this rule permits new code outright and fires only on
 * what already exists. A file whose scope cannot be established resolves to
 * `"new"` or `"unknown"`, and both are treated as new — passing, not
 * denying. That is the fail-open direction: never having proved a migration
 * pre-exists must not block a developer from writing the next one.
 *
 * REPEATABLE SCRIPTS ARE NOT THIS RULE'S BUSINESS
 *
 * Migration tools in this family also carry repeatable scripts, re-applied
 * whenever their content changes, which are meant to be edited in place.
 * Nothing here knows the difference — telling the two apart is a naming
 * convention belonging to one repository's own scripts directory, so it is
 * spelled out in that repository's `immutableMigrations` globs and never
 * here. A repository that declares nothing has nothing protected, which is
 * what keeps this rule safe to install where nobody has configured it.
 */

const path = require("path");
const { deny, ask, pass } = require("../lib/decision");
const { globToRegex } = require("../lib/project-resolver");

/** Tool names this rule treats as a file write. */
const FILE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file)$/;

/**
 * Normalises a path to forward slashes, the separator every configured glob
 * is written in.
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
 * @param {string | null} repoRoot The repository root, or `null` when it
 * could not be resolved.
 * @returns {string} The root-relative path when `filePath` sits inside
 * `repoRoot`, otherwise the path unchanged — both forward-slash normalised.
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
 * Finds the first configured entry whose glob matches a path.
 *
 * @param {object[]} entries The project's `immutableMigrations` list.
 * @param {string} rel The root-relative path being written.
 * @returns {object | null} The matching entry, or `null`.
 */
function matchingEntry(entries, rel) {
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string") continue;
    const re = globToRegex(toPosix(entry.path).replace(/^\.?\/+/, ""));
    if (re && re.test(rel)) return entry;
  }
  return null;
}

module.exports = {
  id: "immutable-migrations",
  title: "An already-applied migration script is never rewritten",
  events: ["PreToolUse"],
  tools: FILE_TOOLS,
  defaultAction: "deny",
  group: "code",

  /**
   * Reads `ctx.changeScope` directly, rather than opting into the
   * `newCodeOnly` softening — see the "WHY THIS IS NOT `protected-paths`"
   * note above for why the two point in opposite directions.
   */
  readsChangeScope: true,

  /**
   * Stack-agnostic on purpose. A migration script is `.sql`, which no
   * stack's extension list claims, so declaring `stacks: ["backend"]` here
   * would resolve to no stack and silence the rule on the only files it
   * exists to protect.
   */
  requiresConfig: ["immutableMigrations"],
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: "deny"|"ask", reason: string, fix: string}}
   * The decision, or `null` when the path is not a configured migration,
   * its entry is `"off"`, or the file did not already exist.
   */
  evaluate(ctx) {
    const entries = ctx.project && ctx.project.immutableMigrations;
    if (!Array.isArray(entries) || entries.length === 0) return pass();
    if (!ctx.filePath) return pass();

    const repoRoot = (ctx.git && ctx.git.repoRoot) || null;
    const entry = matchingEntry(entries, relativeToRepo(ctx.filePath, repoRoot));
    if (!entry || entry.action === "off") return pass();

    // "new" and "unknown" both mean "not proved to pre-exist", and writing
    // the next migration is the ordinary way to change a schema.
    if (ctx.changeScope !== "existing") return pass();

    const reason =
      entry.reason ||
      "This migration script already exists, so it may already have been applied and checksummed; editing it breaks the next run against every database that has it.";
    const fix = "Add a new versioned migration script that corrects the earlier one, rather than editing it.";

    return entry.action === "ask" ? ask(reason, fix) : deny(reason, fix);
  },
};
