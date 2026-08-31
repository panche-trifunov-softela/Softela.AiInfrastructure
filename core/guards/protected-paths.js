"use strict";

/**
 * Guards `ctx.project.protectedPaths` from two directions: a direct write to
 * one of them, and a blanket staging command that would sweep any of them
 * into a commit unnoticed.
 *
 * "Blanket" covers three shapes, all recognised the same way `git`'s own
 * pathspec semantics would:
 *
 * - `git add -A`/`--all`/`.`/`./`/`./.` — {@link isBlanketAdd} — stages the
 *   whole working tree, so every protected entry is swept in.
 * - `git commit -a`/`-am`/a bundled `-a…`/`--all` — {@link isBlanketCommit} —
 *   stages every already-tracked modified file at commit time, which is
 *   exactly as blanket as `git add -A`; the flag-recognition regex mirrors
 *   `local-config-isolation.js`'s own `isCommitAllFlag` deliberately, so the
 *   two rules never grow a second, drifting spelling of the same shape.
 * - `git add <directory>` where the directory is an ancestor of one or more
 *   configured entries — {@link directoryCoveredEntries} — sweeps only the
 *   entries nested under it, never the full list, since a directory add is
 *   blanket only for the subtree it actually covers.
 *
 * Naming a protected file explicitly (`git add docs/internal/CONTRACTS.md`)
 * is deliberate, not silent, and stays a pass in every one of the three
 * routes above.
 *
 * Silent in a repository that declares no protected path at all — that is
 * what keeps this rule safe to install where nobody has configured it yet.
 */

const { splitStatements, splitTokens } = require("../lib/shell-parse");
const { deny, ask, severity } = require("../lib/decision");
const { globToRegex } = require("../lib/project-resolver");

/** Tool names this rule treats as a file write. */
const FILE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file)$/;

/** Tool names this rule treats as a shell invocation. */
const SHELL_TOOLS = /^(Bash|PowerShell|shell|local_shell|exec_command|shell_command)$/;

/** Every pathspec git treats as "stage the whole working tree". */
const BLANKET_TARGETS = new Set(["-A", "--all", ".", "./", "./."]);

/**
 * Checks whether a token is a `-c`/`-C` global git flag — unlike every other
 * flag this rule tolerates, its value is a separate following token rather
 * than folded into the flag token itself (`git -c x=y add -A`).
 *
 * @param {string} token A dequoted statement token.
 * @returns {boolean} `true` for `-c` or `-C`.
 */
function isValueFlag(token) {
  return /^-[cC]$/.test(token);
}

/**
 * Checks whether a token is an ordinary single-dash or double-dash flag —
 * everything from a global git flag (`--no-pager`) to an `add` flag
 * (`-v`, `--all`) that folds any value into the same token.
 *
 * @param {string} token A dequoted statement token.
 * @returns {boolean} `true` when the token opens with a single `-`.
 */
function isBareFlag(token) {
  return /^-[^\s]+(?:=\S*)?$/.test(token);
}

/**
 * Walks a statement's tokens past `git` and any global flags, to the
 * subcommand token that follows.
 *
 * Mirrors `local-config-isolation.js`'s own `gitSubcommand` by design — both
 * rules need the identical walk, and a second, drifting spelling of it is
 * exactly the risk this shared shape avoids.
 *
 * @param {string[]} tokens The statement's dequoted tokens, from
 * {@link splitTokens}.
 * @returns {{verb: string, argsStart: number} | null} The subcommand and the
 * index its own arguments start at, or `null` when the statement is not a
 * `git` invocation.
 */
function gitSubcommand(tokens) {
  if (!tokens.length || !/^git$/i.test(tokens[0])) return null;
  let idx = 1;
  for (;;) {
    const token = tokens[idx];
    if (token === undefined) return null;
    if (isValueFlag(token)) {
      idx += 2;
      continue;
    }
    if (isBareFlag(token)) {
      idx += 1;
      continue;
    }
    break;
  }
  return { verb: tokens[idx], argsStart: idx + 1 };
}

/**
 * Checks whether a statement is a blanket `git add` — every pathspec in
 * {@link BLANKET_TARGETS}, in any of the shell forms a developer might type
 * one (bare, quoted, ANSI-C quoted, an IFS-joined or backslash-continued
 * command word, a trailing slash).
 *
 * Walks {@link splitTokens}'s fully dequoted token list by value, rather
 * than matching a regex against character positions in a masked copy of the
 * statement — the approach {@link module:shell-parse.hasCommand} and
 * {@link module:shell-parse.gitVerb} use for a plain yes/no check. This rule
 * also needs to read the actual target pathspec back out, and a quoted or
 * IFS-joined leading word does not occupy the same number of characters as
 * its unquoted meaning, so a target position computed against a
 * differently-shaped masked string cannot be trusted against the original
 * one. Comparing dequoted token values sidesteps that mismatch entirely.
 *
 * @param {string} statement A single, already-isolated shell statement.
 * @returns {boolean} `true` when the statement stages the whole working
 * tree.
 */
function isBlanketAdd(statement) {
  const tokens = splitTokens(statement);
  const sub = gitSubcommand(tokens);
  if (!sub || !/^add$/i.test(sub.verb || "")) return false;

  // A flag is only skipped when a token remains after it — the statement's
  // very last token must stay available as the candidate target, exactly
  // as `git add -A` requires `-A` itself to be read as the target rather
  // than consumed as a flag with nothing left to stage.
  let idx = sub.argsStart;
  while (idx < tokens.length - 1 && isBareFlag(tokens[idx])) idx += 1;

  const target = tokens[idx];
  return target !== undefined && BLANKET_TARGETS.has(target);
}

/**
 * Checks whether a bare flag turns on `git commit`'s "stage everything at
 * commit time" behaviour — `-a`, `--all`, or a combined short form such as
 * `-am`/`-amv`/`-avm`.
 *
 * The same regex `local-config-isolation.js` uses for its own
 * `isCommitAllFlag` — kept byte-for-byte identical rather than reinvented, so
 * `git commit -a`/`-am`/`--all` reads as blanket the same way in both rules.
 * Anchored so `--amend` never matches: past the leading `-`, a second literal
 * `-` is excluded from both character classes, so `--amend`'s own second
 * dash blocks the match before the pattern ever gets a chance to find the
 * `a` inside "amend".
 *
 * @param {string} token A dequoted statement token.
 * @returns {boolean} `true` when the token is a commit-time stage-all flag.
 */
function isCommitAllFlag(token) {
  if (/^--all$/i.test(token)) return true;
  return /^-[^\s-]*a[^\s-]*$/i.test(token);
}

/**
 * Checks whether a statement is a blanket `git commit` — `-a`, `--all`, or a
 * bundled short flag containing `a` (`-am`, `-amv`, …) anywhere among its
 * flags. Exactly as blanket as `git add -A`: every already-tracked modified
 * file is staged and committed in the same step, with nothing left to review
 * first.
 *
 * @param {string} statement A single, already-isolated shell statement.
 * @returns {boolean} `true` when the statement is a stage-everything commit.
 */
function isBlanketCommit(statement) {
  const tokens = splitTokens(statement);
  const sub = gitSubcommand(tokens);
  if (!sub || !/^commit$/i.test(sub.verb || "")) return false;
  return tokens.slice(sub.argsStart).some(isCommitAllFlag);
}

/**
 * Collects every non-flag pathspec token a `git add` statement carries, in
 * order. Unlike {@link isBlanketAdd}, which only reads the final token back
 * (the one whole-tree pathspecs like `-A` always occupy), this reads every
 * pathspec, since a directory add can sit anywhere among several arguments.
 *
 * @param {string[]} tokens The statement's dequoted tokens.
 * @param {number} argsStart The index `add`'s own arguments start at.
 * @returns {string[]} The candidate pathspec tokens, flags excluded.
 */
function addPathspecs(tokens, argsStart) {
  const out = [];
  for (let idx = argsStart; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    if (!isBareFlag(token)) out.push(token);
  }
  return out;
}

/**
 * Normalises a `git add` pathspec to the same forward-slash, no-leading-
 * `./`, no-trailing-slash form a protected-path entry is compared against —
 * so `docs/`, `./docs`, and `docs` all resolve to the identical `docs`
 * before the prefix check in {@link directoryCoveredEntries} runs.
 *
 * @param {string} pathspec A dequoted `git add` argument.
 * @returns {string} The normalised form, or `""` when nothing is left after
 * normalising (a bare `.`/`./`, already handled by {@link isBlanketAdd}).
 */
function normalizeDirSpec(pathspec) {
  return toPosix(pathspec)
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * Finds every protected-path entry that sits underneath one of a `git add`
 * statement's pathspecs — a directory add sweeps in a whole subtree blindly,
 * exactly the way `-A` sweeps in the whole working tree, except scoped only
 * to the entries actually nested under the directory named.
 *
 * A pathspec naming a protected file itself (`git add
 * docs/internal/CONTRACTS.md`) never matches here: the prefix check requires
 * a `/` right after the pathspec, so an entry equal to the pathspec —
 * rather than nested under it — is correctly left uncovered. That is also
 * what keeps this from ever needing to ask the filesystem whether a pathspec
 * "is a directory": a plain file and a same-named directory can never both
 * exist at one path in the same repository, so a pathspec that is a real
 * prefix of a configured entry's path can only be a directory.
 *
 * @param {string} statement A single, already-isolated shell statement.
 * @param {object[]} protectedPaths The project's protected-path entries.
 * @returns {object[]} The entries covered, deduplicated, in configured
 * order.
 */
function directoryCoveredEntries(statement, protectedPaths) {
  const tokens = splitTokens(statement);
  const sub = gitSubcommand(tokens);
  if (!sub || !/^add$/i.test(sub.verb || "")) return [];

  const covered = [];
  for (const raw of addPathspecs(tokens, sub.argsStart)) {
    if (BLANKET_TARGETS.has(raw)) continue; // already handled by isBlanketAdd
    const dir = normalizeDirSpec(raw);
    if (!dir) continue;
    const prefix = `${dir.toLowerCase()}/`;

    for (const entry of protectedPaths) {
      if (!entry || !entry.path || covered.includes(entry)) continue;
      const entryPath = toPosix(entry.path).replace(/^\.?\/+/, "").toLowerCase();
      if (entryPath.startsWith(prefix)) covered.push(entry);
    }
  }
  return covered;
}

/**
 * Converts a path to forward-slash form.
 *
 * @param {string} p The path to convert.
 * @returns {string} The path with every backslash replaced by a slash.
 */
function toPosix(p) {
  return String(p || "").replace(/\\/g, "/");
}

/**
 * Resolves a path relative to a repository root when possible.
 *
 * @param {string} filePath The path to resolve, as given by the tool call.
 * @param {string | null} repoRoot The repository root, or `null` when it
 * could not be resolved.
 * @returns {string} The path relative to `repoRoot` when `filePath` sits
 * under it; `filePath` itself (forward-slash form, no leading slash)
 * otherwise.
 */
function relativeToRepo(filePath, repoRoot) {
  const f = toPosix(filePath);
  if (repoRoot) {
    const root = toPosix(repoRoot).replace(/\/+$/, "");
    if (f.toLowerCase() === root.toLowerCase()) return "";
    if (f.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return f.slice(root.length + 1);
  }
  return f.replace(/^\/+/, "");
}

/**
 * Checks whether a resolved path matches a protected-path entry.
 *
 * An entry is most often a literal file (`docs/internal/CONTRACTS.md`),
 * matched exactly, but may also be a glob (`projects/**.json`) when a project
 * needs to protect a family of files rather than restating each one; a glob
 * is only tested once the repository root is known, since matching one
 * against an unresolved, merely-approximate `rel` would be meaningless.
 *
 * A suffix match (`r` ending in `/target`) is leniency reserved for the case
 * where the repository root could not be resolved at all, so `rel` is only
 * ever an approximation. Once the root IS known, `rel` is a true
 * root-relative path and only an exact (or, for a glob entry, matching)
 * comparison counts — otherwise a file that merely happens to share a tail,
 * such as another package's own `docs/internal/CONTRACTS.md` in a workspace
 * layout, would be treated as the one protected file at the repository root.
 *
 * @param {string} rel The path resolved by {@link relativeToRepo}.
 * @param {string} entryPath The entry's configured path or glob.
 * @param {boolean} repoRootKnown Whether `rel` was resolved against a known
 * repository root.
 * @returns {boolean} `true` when they refer to the same file, or `rel`
 * matches the entry's glob.
 */
function matchesEntry(rel, entryPath, repoRootKnown) {
  const target = toPosix(entryPath).replace(/^\.?\/+/, "");
  const targetLower = target.toLowerCase();
  const r = rel.toLowerCase();

  if (r === targetLower) return true;
  if (!repoRootKnown) return r.endsWith(`/${targetLower}`);
  if (target.includes("*")) {
    const re = globToRegex(target);
    return Boolean(re && re.test(rel));
  }
  return false;
}

/**
 * Resolves a protected-path entry's configured action to a decision.
 *
 * @param {object} entry The protected-path entry.
 * @returns {object | null} The decision, or `null` for an `"off"` entry.
 */
function decisionForEntry(entry) {
  const reason = entry.reason || `${entry.path} is a protected path in this repository.`;
  const fix = "Confirm this is a deliberate, reviewed change before proceeding.";
  if (entry.action === "deny") return deny(reason, fix);
  if (entry.action === "off") return null;
  return ask(reason, fix);
}

/**
 * Builds the decision for a blanket staging command, from the most severe
 * action among every declared protected path.
 *
 * @param {object[]} protectedPaths The project's protected-path entries.
 * @returns {object | null} The decision, or `null` when every entry is
 * `"off"`.
 */
function blanketDecision(protectedPaths) {
  const names = [];
  let best = null;

  for (const entry of protectedPaths) {
    if (!entry || !entry.path) continue;
    names.push(entry.path);
    const candidate = decisionForEntry(entry);
    if (candidate && (!best || severity(candidate.action) > severity(best.action))) best = candidate;
  }
  if (!best || !names.length) return null;

  const reason = `A blanket stage sweeps in ${names.join(", ")}, which ${
    names.length === 1 ? "is protected" : "are protected"
  } in this repository.`;
  best.reason = reason;
  best.fix = "Stage explicit paths instead of a blanket add or commit -a.";
  return best;
}

module.exports = {
  id: "protected-paths",
  title: "Protected paths are never written or swept in unnoticed",
  events: ["PreToolUse"],
  tools: null,
  defaultAction: "deny",
  group: "git",
  requiresConfig: ["protectedPaths"],
  requiresModule: null,

  evaluate(ctx) {
    const protectedPaths = Array.isArray(ctx.project && ctx.project.protectedPaths) ? ctx.project.protectedPaths : [];
    if (!protectedPaths.length) return null;

    if (FILE_TOOLS.test(ctx.toolName)) {
      if (!ctx.filePath) return null;
      const repoRoot = ctx.git && ctx.git.repoRoot;
      const rel = relativeToRepo(ctx.filePath, repoRoot);
      for (const entry of protectedPaths) {
        if (entry && entry.path && matchesEntry(rel, entry.path, Boolean(repoRoot))) return decisionForEntry(entry);
      }
      return null;
    }

    if (SHELL_TOOLS.test(ctx.toolName)) {
      const statements = splitStatements(ctx.command);

      const blanket = statements.some((s) => isBlanketAdd(s) || isBlanketCommit(s));
      if (blanket) return blanketDecision(protectedPaths);

      const covered = [];
      for (const statement of statements) {
        for (const entry of directoryCoveredEntries(statement, protectedPaths)) {
          if (!covered.includes(entry)) covered.push(entry);
        }
      }
      if (!covered.length) return null;
      return blanketDecision(covered);
    }

    return null;
  },
};
