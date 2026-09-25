"use strict";

/**
 * Nudges a comment line in newly written content past the project's
 * configured width.
 *
 * The width is not a constant this module can hard-code: repositories set
 * their own code width (a Prettier `printWidth` of 80 in one, 100 in the
 * next), so a fixed number would be wrong for some of the code it judges.
 * The rule stays silent until a project states
 * `docCommentStyle.maxLineWidth` for itself.
 *
 * The check is independent of stack: a `//` line comment, a JSDoc block and
 * an XML `///` doc comment are all recognised by the same line-shaped
 * markers, so there is nothing here that only means something on one side of
 * the frontend/backend split — unlike `file-size-limit`'s thresholds, which
 * are agreed for one stack only. `stacks` is therefore left unset; the gate
 * that keeps this rule quiet on an unconfigured project is `requiresConfig`
 * alone.
 *
 * Judges `ctx.content`, the same newly-written text `doc-comment-style`
 * reads — never the reconstructed whole file — so an `Edit`'s own replacement
 * text is judged on its own, and a `Write`'s full content is judged as a
 * whole, without a second convention for deciding what counts as "new".
 */

const { ask, pass } = require("../lib/decision");

/** Tool names this rule inspects, shared with every other file-content rule. */
const FILE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file)$/;

/** A `//` or `///` line comment, anchored to the start of the line. */
const LINE_COMMENT = /^\s*\/\//;

/** The opening of a `/*` or `/**` block comment, anchored to the start of the line. */
const BLOCK_OPEN = /^\s*\/\*/;

/** The closing `*\/` of a block comment, wherever it sits on the line. */
const BLOCK_CLOSE = /\*\//;

/**
 * Strips a comment line down to its written body: leading indentation, then
 * one of `//`, `///`, `/*`, `/**`, `*\/` or a bare `*` gutter, then at most
 * one following space.
 */
const COMMENT_MARKER = /^\s*(?:\/\/\/?|\/\*\*?|\*\/|\*)\s?/;

/** The opening or closing fence of a code block inside a doc comment. */
const CODE_FENCE = /^```/;

/**
 * Reads the configured width backstop from the project config.
 *
 * `requiresConfig` already keeps the rule from running at all when the key
 * is absent; this only guards against a present-but-malformed value, the
 * same conservative direction every other configured threshold in this
 * codebase takes.
 *
 * @param {object} project The resolved project config.
 * @returns {number|null} The configured width, or `null` when it is not a
 * positive integer.
 */
function configuredWidth(project) {
  const value = project && project.docCommentStyle && project.docCommentStyle.maxLineWidth;
  return typeof value === "number" && value > 0 ? value : null;
}

/**
 * Checks whether a comment line's overflow cannot be wrapped at all.
 *
 * Having no whitespace past the limit only shows that the line was not
 * broken there; it says nothing about whether it could have been. An
 * ordinary sentence whose short last word merely straddles the limit column
 * has a perfectly good wrap point right before that word — the word itself
 * would fit on a fresh line with room to spare. The carve-out only applies
 * to the narrower case: the token straddling the limit is long enough, on
 * its own, that no line break placed anywhere would keep it inside the
 * configured width — a URL, a qualified identifier, a file path.
 *
 * @param {string} line The full line, including indentation and marker.
 * @param {number} limit The configured width.
 * @returns {boolean} `true` when the straddling token is too long to fit on
 * a line of its own, so no wrap could fix this overflow.
 */
function isUnbreakableOverflow(line, limit) {
  if (/\s/.test(line.slice(limit))) return false;

  let tokenStart = limit;
  while (tokenStart > 0 && !/\s/.test(line[tokenStart - 1])) tokenStart--;

  return line.length - tokenStart > limit;
}

/**
 * Checks whether a comment's written body is one row of a markdown table.
 *
 * @param {string} body The comment line with its marker and surrounding
 * whitespace already stripped.
 * @returns {boolean} `true` when the body starts and ends with a pipe.
 */
function isTableRow(body) {
  return body.length > 1 && body.startsWith("|") && body.endsWith("|");
}

/**
 * Finds the first newly written comment line whose rendered width exceeds
 * the configured limit and that no carve-out excuses.
 *
 * Walks the text tracking two states: whether the current line sits inside
 * an open `/* ... *\/` block, and — only while inside a contiguous run of
 * comment lines — whether it sits inside a fenced code block written within
 * that run. A `//`/`///` line is judged on its own regardless of block
 * state; a block's opening and closing lines are themselves comment lines,
 * judged like any other.
 *
 * The fence state is scoped to the comment run that opened it: it is reset
 * the moment the scan leaves that run, whether by reaching a line that is
 * not a comment at all or by the block comment carrying it closing. Without
 * that reset, an unmatched fence marker in one comment would silently
 * exempt every unrelated comment line that follows it for the rest of the
 * file.
 *
 * @param {string[]} lines The written text, split into lines.
 * @param {number} limit The configured width.
 * @returns {{lineNumber: number, width: number}|null} The first offending
 * line's 1-based position and actual width, or `null` when none is found.
 */
function findOverwideLine(lines, limit) {
  let inBlock = false;
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    let isCommentLine = false;
    let commentRunEnds = false;

    if (inBlock) {
      isCommentLine = true;
      if (BLOCK_CLOSE.test(line)) {
        inBlock = false;
        commentRunEnds = true;
      }
    } else if (LINE_COMMENT.test(line)) {
      isCommentLine = true;
    } else if (BLOCK_OPEN.test(line)) {
      isCommentLine = true;
      if (BLOCK_CLOSE.test(line)) commentRunEnds = true;
      else inBlock = true;
    } else {
      commentRunEnds = true;
    }

    if (isCommentLine) {
      const body = line.replace(COMMENT_MARKER, "").trim();

      if (CODE_FENCE.test(body)) {
        inFence = !inFence;
      } else if (!inFence) {
        if (
          line.length > limit &&
          !isTableRow(body) &&
          !isUnbreakableOverflow(line, limit)
        ) {
          return { lineNumber: i + 1, width: line.length };
        }
      }
    }

    // Leaving the comment run this fence was opened in — an unmatched
    // marker exempts at most the remainder of its own run, never whatever
    // comment happens to come next.
    if (commentRunEnds) inFence = false;
  }

  return null;
}

module.exports = {
  /** kebab-case, unique, equals the filename without .js */
  id: "comment-line-width",

  /** one line, shown by `softela-ai doctor` */
  title: "Nudge a comment line past the project's configured width",

  /** which host events this rule can fire on */
  events: ["PreToolUse"],

  /** which tool names it applies to; null means every tool */
  tools: FILE_TOOLS,

  /** the strongest action this rule may ever return */
  defaultAction: "ask",

  /** which catalogue group this rule belongs to */
  group: "code",

  /**
   * A comment-width nudge, never a request for the developer's decision — a
   * host with no interactive ask surfaces it instead of blocking.
   */
  advisoryAsk: true,

  /**
   * No invented default: a project that has not agreed a width gets no
   * comment-width check at all, rather than inheriting a number nobody
   * chose for it.
   */
  requiresConfig: ["docCommentStyle.maxLineWidth"],

  /** optional: only active when this module is enabled */
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: "ask", reason: string, fix?: string}} `ask`
   * when a newly written comment line clears the configured width with no
   * carve-out excusing it, `null` otherwise.
   */
  evaluate(ctx) {
    const limit = configuredWidth(ctx.project);
    if (limit === null) return pass();

    const added = String(ctx.content || "");
    if (!added.trim()) return pass();

    const lines = added.split(/\r?\n/);
    const offender = findOverwideLine(lines, limit);
    if (!offender) return pass();

    return ask(
      `COMMENT WIDTH: line ${offender.lineNumber} of the written text is ${offender.width} characters, ` +
        `past this project's ${limit}-character limit.`,
      "Wrap the comment onto additional lines to stay within the configured width.",
    );
  },
};
