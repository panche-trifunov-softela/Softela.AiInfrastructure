"use strict";

/**
 * Denies or asks about commit-message hygiene: AI attribution, bypassed
 * hooks, conventional-commit prefixes, ticket ids in the subject, and
 * committing while a protected path is staged.
 *
 * Only ever looks at a `git commit` statement; every other statement on the
 * same command line is ignored. Every check is scoped to that one statement,
 * so a compound line like `cd sub && git commit -m "x"` never reads the `cd`
 * half as part of the commit.
 */

const { splitStatements, splitTokens, gitVerb, hasFlag } = require("../lib/shell-parse");
const { deny, ask, severity } = require("../lib/decision");

/**
 * A co-author / AI-attribution trailer. Anchored to the start of a line (Git
 * trailer convention: `Key: value`, alone on its own line) rather than
 * matched anywhere in the message, so a sentence that merely discusses the
 * phrase in prose — with other words before it on the same line — never
 * reads as a real trailer.
 */
const TRAILER_RE = /^\s*co-authored-by\s*:/im;

/** A generated-by signature line, anchored the same way as {@link TRAILER_RE}. */
const SIGNATURE_RE = /^\s*generated\s+(?:with|by)\s+\[/im;

/** The robot emoji some tools append to a generated commit message. */
const ROBOT_EMOJI = "\u{1F916}";

/** A conventional-commit subject prefix, e.g. `feat:`, `fix(scope)!:`. */
const CONVENTIONAL_PREFIX_RE = /^(feat|fix|chore|refactor|docs|test|style|perf|build|ci|revert)(\([^)]*\))?!?:/i;

/** A ticket id: `#` followed by three or more digits. */
const TICKET_ID_RE = /#\d{3,}/;

/**
 * A short-flag cluster ending in `m` (`-m`, `-am`, `-qm`, …) — every letter
 * before the `m` folded into the same token, the way git itself groups
 * short flags.
 */
const MESSAGE_FLAG_RE = /^-[a-zA-Z]*m$/;

/**
 * Extracts every `-m`/`-am`/`--message` paragraph from a commit statement,
 * in order, git-style multi-paragraph messages read as separate `-m` flags.
 *
 * Walks {@link splitTokens}'s fully dequoted token list by value, rather
 * than matching a regex against character positions in a masked copy of the
 * statement. That is what lets a paragraph joined onto its flag with
 * `${IFS}` in place of whitespace, or written in an ANSI-C `$'…'` quote,
 * read identically to a plain `"…"` argument — `splitTokens` already
 * normalises every one of those shapes down to the same token values, so
 * the value is simply whichever token immediately follows the flag token.
 *
 * @param {string} commitStatement A single, already-isolated `git commit`
 * statement.
 * @returns {string[]} Each extracted paragraph, in the order it appears.
 */
function extractMessageParagraphs(commitStatement) {
  const tokens = splitTokens(commitStatement);
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const attached = token.match(/^--message=(.*)$/);
    if (attached) {
      out.push(attached[1]);
      continue;
    }
    if (token === "--message" || MESSAGE_FLAG_RE.test(token)) {
      if (i + 1 < tokens.length) {
        out.push(tokens[i + 1]);
        i += 1;
      }
    }
  }
  return out;
}

/**
 * Extracts the path given to `-F <path>` or `--file=<path>` / `--file
 * <path>`, the same way {@link extractMessageParagraphs} extracts a `-m`
 * paragraph: walking {@link splitTokens}'s dequoted token list by value.
 *
 * @param {string} commitStatement A single, already-isolated `git commit`
 * statement.
 * @returns {string | null} The path, or `null` when neither flag is present.
 */
function extractFilePath(commitStatement) {
  const tokens = splitTokens(commitStatement);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const attached = token.match(/^--file=(.*)$/);
    if (attached) return attached[1];
    if (token === "-F" || token === "--file") {
      return i + 1 < tokens.length ? tokens[i + 1] : null;
    }
  }
  return null;
}

/**
 * A heredoc redirection opening a statement's tail: `<<DELIM`, `<<-DELIM`,
 * or either spelling with the delimiter word quoted. Captures the delimiter
 * so {@link extractHeredocBody} knows which line ends the body.
 */
const HEREDOC_RE = /<<-?\s*(['"]?)([A-Za-z_][\w]*)\1\s*$/;

/**
 * Extracts a heredoc body written for `-F -` directly out of the raw command
 * text: `git commit -F - <<'EOF' ... EOF` carries its own message inline,
 * even though there is no file for `ctx.readFile` to read.
 *
 * `commitStatement` is one entry from `splitStatements`, which splits on
 * newlines and therefore ends exactly at the heredoc opener — the body lives
 * later in `rawCommand`, outside the statement text. This walks forward from
 * where the statement ends, collecting lines until one that (trimmed) is
 * exactly the delimiter.
 *
 * @param {string} rawCommand The full, unsplit command text.
 * @param {string} commitStatement The isolated `git commit` statement,
 * ending in a heredoc opener.
 * @returns {string | null} The heredoc body, or `null` when the statement
 * does not open a heredoc, the statement cannot be located in `rawCommand`,
 * or no closing delimiter line follows.
 */
function extractHeredocBody(rawCommand, commitStatement) {
  const opener = HEREDOC_RE.exec(commitStatement);
  if (!opener) return null;

  const idx = rawCommand.indexOf(commitStatement);
  if (idx === -1) return null;

  const delimiter = opener[2];
  const lines = rawCommand.slice(idx + commitStatement.length).split("\n");
  const start = lines[0].trim() === "" ? 1 : 0;

  const body = [];
  for (let i = start; i < lines.length; i += 1) {
    if (lines[i].trim() === delimiter) return body.join("\n");
    body.push(lines[i]);
  }
  return null;
}

/**
 * Resolves the full commit message text a statement will produce: the
 * `-F`/`--file` target's content when present — read through `ctx.readFile`,
 * or pulled out of an inline heredoc body for `-F -` when one is present in
 * the command text — so the same checks a `-m` subject gets cannot be
 * bypassed by moving the text into a file or piping it over stdin; otherwise
 * every `-m`/`-am`/`--message` paragraph joined the way git joins them.
 *
 * @param {string} commitStatement A single, already-isolated `git commit`
 * statement.
 * @param {(p: string) => string | null} readFile `ctx.readFile`.
 * @param {string} rawCommand The full, unsplit command text `commitStatement`
 * was taken from — needed to recover a heredoc body for `-F -`.
 * @returns {{message: string | null, unreadable: boolean}} `message` is the
 * resolved text, or `null` when there is genuinely nothing to check (no
 * `-m`/`-F` at all — an editor-driven commit). `unreadable` is `true` only
 * when the statement names a message source (a `-F` target, including `-`)
 * whose actual text could not be recovered — an unreadable file, a path
 * outside the repo, or `-F -` with no heredoc to read it back from — which
 * must never be treated the same as "no message to check".
 */
function resolveMessage(commitStatement, readFile, rawCommand) {
  const filePath = extractFilePath(commitStatement);
  if (filePath !== null) {
    if (filePath === "-") {
      const heredoc = extractHeredocBody(rawCommand, commitStatement);
      return heredoc === null ? { message: null, unreadable: true } : { message: heredoc, unreadable: false };
    }
    const content = readFile(filePath);
    return content === null
      ? { message: null, unreadable: true }
      : { message: content.replace(/\r\n/g, "\n"), unreadable: false };
  }
  const paragraphs = extractMessageParagraphs(commitStatement);
  return { message: paragraphs.length ? paragraphs.join("\n\n") : null, unreadable: false };
}

/**
 * Normalises a path for comparison: backslashes to forward slashes, no
 * leading `./`.
 *
 * @param {string} p The path to normalise.
 * @returns {string} The normalised path.
 */
function normalisePath(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

/**
 * Resolves a configured action string to a decision.
 *
 * @param {string | undefined} action `"deny"`, `"ask"`, `"off"`, or absent.
 * @param {string} fallback The action to use when `action` is absent or
 * unrecognised.
 * @param {string} reason The decision's reason.
 * @param {string} [fix] The decision's fix.
 * @returns {object | null} The decision, or `null` for `"off"`.
 */
function decisionFor(action, fallback, reason, fix) {
  const resolved = action === "deny" || action === "ask" || action === "off" ? action : fallback;
  if (resolved === "deny") return deny(reason, fix);
  if (resolved === "ask") return ask(reason, fix);
  return null;
}

/**
 * Picks the most severe of a list of candidate decisions.
 *
 * @param {Array<object | null>} candidates The candidate decisions.
 * @returns {object | null} The most severe non-null candidate, or `null`
 * when every candidate is `null`.
 */
function mostSevere(candidates) {
  let best = null;
  for (const candidate of candidates) {
    if (candidate && (!best || severity(candidate.action) > severity(best.action))) best = candidate;
  }
  return best;
}

module.exports = {
  id: "commit-message",
  title: "Commit messages stay clean of attribution, bypasses and stray ids",
  events: ["PreToolUse"],
  tools: /^(Bash|PowerShell|shell|local_shell|exec_command|shell_command)$/,
  defaultAction: "deny",
  group: "git",
  // Only the conventional-prefix check inside this rule is configurable
  // (via commitMessage.conventionalPrefix); every other check stays
  // universal on purpose, so this rule never requires config wholesale.
  requiresConfig: [],
  requiresModule: null,

  evaluate(ctx) {
    const commitStatement = splitStatements(ctx.command).find((s) => gitVerb(s, "commit"));
    if (!commitStatement) return null;

    const candidates = [];
    const { message, unreadable } = resolveMessage(commitStatement, ctx.readFile, ctx.command);

    if (unreadable) {
      candidates.push(
        ask(
          "The commit message text could not be read back, so it could not be checked for an AI attribution trailer, a conventional-commit prefix, or a ticket id.",
          "Approve manually after checking the message yourself, or write it with -m so it can be checked.",
        ),
      );
    }

    if (message !== null && (TRAILER_RE.test(message) || SIGNATURE_RE.test(message) || message.includes(ROBOT_EMOJI))) {
      candidates.push(
        deny(
          "Commits never carry an AI co-author trailer or a generated-by signature.",
          "Drop the trailer or signature and keep the message a plain description of the change.",
        ),
      );
    }

    if (hasFlag(commitStatement, "--no-verify|--no-gpg-sign")) {
      candidates.push(
        deny(
          "Git hooks are not bypassed on a commit. Fix the underlying failure instead.",
          "Remove --no-verify/--no-gpg-sign and address whatever the hook is catching.",
        ),
      );
    }

    const subject = message !== null ? message.split("\n")[0].trim() : null;
    if (subject !== null) {
      if (CONVENTIONAL_PREFIX_RE.test(subject)) {
        const configured = ctx.project && ctx.project.commitMessage && ctx.project.commitMessage.conventionalPrefix;
        const d = decisionFor(
          configured,
          "deny",
          `The subject "${subject}" uses a conventional-commit prefix; this project's commits are a plain imperative phrase.`,
          "Drop the prefix and restate the subject as a plain sentence.",
        );
        if (d) candidates.push(d);
      }

      if (TICKET_ID_RE.test(subject)) {
        candidates.push(
          deny(
            "The commit subject names a ticket id. Ticket ids live in the tracker and the pull request, not in repository history.",
            "Describe the change itself and drop the ticket id.",
          ),
        );
      }
    }

    const staged = (ctx.git && typeof ctx.git.staged === "function" ? ctx.git.staged() : []) || [];
    const protectedPaths = Array.isArray(ctx.project && ctx.project.protectedPaths) ? ctx.project.protectedPaths : [];
    if (staged.length && protectedPaths.length) {
      const stagedSet = new Set(staged.map(normalisePath));
      for (const entry of protectedPaths) {
        if (!entry || !entry.path || !stagedSet.has(normalisePath(entry.path))) continue;
        const d = decisionFor(
          entry.action,
          "ask",
          entry.reason || `${entry.path} is staged for this commit and is a protected path.`,
          "Unstage it unless this is a deliberate, reviewed change.",
        );
        if (d) candidates.push(d);
      }
    }

    return mostSevere(candidates);
  },
};
