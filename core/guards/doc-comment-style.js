"use strict";

/**
 * Enforces the house documentation style on newly written comment text.
 *
 * Judges written documentation by a fixed rule: a block that is a list
 * (bullets, numbered steps, or `@`-tags) passes at any length, and only a
 * prose-only block past the line threshold asks. The judgement runs through
 * the shared rule contract instead of being embedded in a single tool, and
 * accepts the same context for both `Write` (the full new file) and `Edit`
 * (only the replacement text), so nothing here needs to know which tool
 * produced the written content.
 */

const { deny, ask, pass } = require("../lib/decision");

/**
 * Backstop for a prose-only block, deliberately far above any legitimate
 * single-explanation comment. Whether prose should have been a list is a
 * judgement call — a block enumerating members or rules must be a list, one
 * continuous explanation may stay prose — and no line count decides that
 * without flagging correct code too, so this only catches the extreme case.
 *
 * Default only: a project config (typically through its stack preset, see
 * `docCommentStyle` below) may raise this per stack. A stack whose team wants
 * more headroom states it once in its preset rather than every project file
 * repeating it.
 */
const MAX_BLOCK_LINES = 18;

/**
 * Consecutive `//` lines that should have been a doc block instead.
 *
 * Default only, same as `MAX_BLOCK_LINES` — overridable through
 * `docCommentStyle.maxLineCommentRun`.
 */
const MAX_LINE_COMMENT_RUN = 6;

/** File extensions documented with JSDoc `/** ... *\/`. */
const FRONTEND = /\.(ts|tsx|js|jsx)$/i;

/** File extensions documented with XML `/// <summary>`, never JSDoc. */
const BACKEND = /\.cs$/i;

/** A run of one or more `///` lines. */
const XML_DOC_LINE = /^\s*\/\/\//;

/** A line containing only a C# attribute, skipped when looking for the member a doc block documents. */
const ATTRIBUTE_LINE = /^\s*\[.*\]\s*$/;

/**
 * A leading keyword that means the line after a stray `///` is a statement,
 * not a member declaration — guards the param/returns check from firing on
 * an ordinary comment sitting above a control-flow line.
 */
const STATEMENT_KEYWORD_START = /^\s*(?:if|for|foreach|while|switch|catch|using|lock|return|throw|else|do|try)\b/;

/**
 * Type-declaration keywords that can land in the "return type" position of
 * `MEMBER_SIGNATURE` when the actual construct is a type (most commonly a
 * `record` with a primary constructor) rather than a method — excluded so the
 * check never asks a type declaration for a `<returns>` it was never meant to
 * carry.
 */
const TYPE_DECLARATION_KEYWORDS = new Set(["class", "struct", "interface", "enum", "record", "delegate"]);

/**
 * C# modifier keywords that can land in `MEMBER_SIGNATURE`'s return-type
 * capture group. That group's modifier prefix is quantified `*`, so it may
 * consume zero modifiers — against a constructor like `public Thing()`, the
 * prefix backtracks to matching nothing and `public` itself gets captured as
 * the "return type" instead. A modifier sitting in that position means there
 * was never a real return type at all, i.e. the construct is a constructor,
 * so it must fall through to `CONSTRUCTOR_SIGNATURE` rather than be judged
 * for a `<returns>` tag it was never meant to carry.
 */
const MODIFIER_KEYWORDS = new Set([
  "public",
  "private",
  "protected",
  "internal",
  "static",
  "virtual",
  "override",
  "async",
  "sealed",
  "abstract",
  "readonly",
  "new",
  "extern",
  "unsafe",
  "partial",
]);

/**
 * Matches a method-shaped signature: optional modifiers, a return-type token,
 * a member name, then a parenthesised parameter list. A constructor (return
 * type and name collapse into a single identifier) can still match here,
 * because the modifier prefix is optional and may backtrack to consuming
 * nothing — the caller checks the captured token against
 * `MODIFIER_KEYWORDS` to tell the two apart and hand a constructor to
 * `CONSTRUCTOR_SIGNATURE` instead.
 */
const MEMBER_SIGNATURE =
  /(?:(?:public|private|protected|internal|static|virtual|override|async|sealed|abstract|readonly|new|extern|unsafe|partial)\s+)*([\w.]+(?:<[^<>()]*>)?(?:\[\])?)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/;

/**
 * Matches a constructor signature: one or more access/static modifiers, a
 * single identifier, then a parenthesised parameter list — no separate
 * return-type token, which is exactly what distinguishes it from
 * `MEMBER_SIGNATURE`.
 */
const CONSTRUCTOR_SIGNATURE = /(?:(?:public|private|protected|internal|static)\s+)+([A-Za-z_]\w*)\s*\(([^)]*)\)/;

/**
 * A ticket-id `#` is anchored to where a real reference actually sits: the
 * start of the text, whitespace, or an opening bracket. Without that anchor
 * the digits inside a URL fragment (`Section#1990s`) read as a ticket too.
 */
const TICKET_ANCHOR_SOURCE = "(^|[\\s(])#(\\d{3,})\\b";

/**
 * Matches the branch-name spelling of the same reference — `task_12345`,
 * `TASK-12345` — which carries a ticket id just as surely as `#12345` does,
 * and goes just as dead when the tracker changes.
 */
const TICKET_WORD = /\btask[_-]\d{3,}\b/i;

/**
 * Checks whether the text contains a ticket id, in either the `#12345` or
 * the `task_12345` spelling, excluding a `#` run that is exactly 3, 4, 6 or
 * 8 hex characters long — the standard CSS hex-color lengths — since that
 * shape reads as a color literal, not a reference.
 *
 * @param {string} text The written content.
 * @returns {boolean} `true` when a genuine ticket id is present.
 */
function hasTicketId(text) {
  if (TICKET_WORD.test(text)) return true;
  const re = new RegExp(TICKET_ANCHOR_SOURCE, "gm");
  let m;
  while ((m = re.exec(text))) {
    const hashIndex = m.index + m[1].length;
    const hexRun = /^[0-9a-fA-F]*/.exec(text.slice(hashIndex + 1))[0];
    const isHexColor = hexRun.length === 3 || hexRun.length === 4 || hexRun.length === 6 || hexRun.length === 8;
    if (!isHexColor) return true;
  }
  return false;
}

/**
 * Checks whether a line carries real list structure once its JSDoc ` * `
 * prefix is stripped. Matching a bullet class against the raw line makes
 * every continuation line look like a bullet, which silently disables this
 * check, so the prefix is removed first.
 *
 * @param {string} line One line of a comment block.
 * @returns {boolean} `true` when the line is a bullet, a numbered step, or an
 * `@`-tag.
 */
function isStructuredLine(line) {
  return /^(?:@\w+|[-•]\s|\d+[.)]\s)/.test(line.replace(/^\s*\*?\s*/, ""));
}

/**
 * Finds the first `/** ... *\/` block whose content is prose-only and longer
 * than the line backstop.
 *
 * @param {string[]} lines The written text, split into lines.
 * @param {number} maxBlockLines The line count past which a prose-only block
 * asks; the caller resolves this from project config or the module default.
 * @returns {number} The offending block's line count, or `0` when every block
 * is short enough or carries list structure.
 */
function firstOversizedProseBlock(lines, maxBlockLines) {
  let blockStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (blockStart === -1 && /\/\*/.test(lines[i])) blockStart = i;
    if (blockStart !== -1 && /\*\//.test(lines[i])) {
      const block = lines.slice(blockStart, i + 1);
      if (block.length > maxBlockLines && !block.some(isStructuredLine)) return block.length;
      blockStart = -1;
    }
  }
  return 0;
}

/**
 * Finds the longest run of consecutive `//` comment lines.
 *
 * A `///` line is not one of them. It opens with `//` and so matches the
 * naive test, but it is an XML doc line — precisely the structured doc block
 * this check exists to push people towards, so counting it turned the rule
 * against the very style it asks for: a C# member documented with a summary
 * and four tags clears any sane threshold on its own and was denied on
 * Codex, where an `ask` is a hard stop. {@link XML_DOC_LINE} is checked
 * first, and ends the run rather than extending it: a doc block genuinely
 * terminates whatever stretch of ordinary `//` comments preceded it.
 *
 * @param {string[]} lines The written text, split into lines.
 * @returns {number} The longest run found, `0` when there are none.
 */
function longestLineCommentRun(lines) {
  let run = 0;
  let longest = 0;
  for (const line of lines) {
    if (XML_DOC_LINE.test(line)) {
      run = 0;
      continue;
    }
    run = /^\s*\/\//.test(line) ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

/**
 * Reads a configurable length backstop from the project config (typically
 * arriving through a stack preset, CONTRACTS.md §8a), falling back to this
 * rule's own default when the project sets nothing — the same
 * requiresConfig-free pattern `commit-message` uses for its
 * conventional-prefix check: a fact this rule needs to soften, not to run at
 * all, so `requiresConfig` (which would silence the whole rule) does not
 * apply here.
 *
 * @param {object} project The resolved (preset-merged) project config.
 * @param {"maxBlockLines"|"maxLineCommentRun"} key Which backstop to read.
 * @param {number} fallback The value used when the project declares nothing.
 * @returns {number} The effective threshold.
 */
function configuredThreshold(project, key, fallback) {
  const value = project && project.docCommentStyle && project.docCommentStyle[key];
  return typeof value === "number" && value > 0 ? value : fallback;
}

/**
 * Collects the line(s) that make up the signature following a doc block:
 * the next non-blank line, skipping attribute lines (`[Obsolete]` and
 * similar), extended across a small number of additional lines when a
 * parameter list wraps.
 *
 * @param {string[]} lines The written text, split into lines.
 * @param {number} fromIndex The index right after the doc block.
 * @returns {string} The joined candidate signature text, `""` when nothing
 * follows.
 */
function nextSignatureLine(lines, fromIndex) {
  const collected = [];
  for (let i = fromIndex; i < lines.length && collected.length < 6; i++) {
    const line = lines[i];
    if (!line.trim()) {
      if (collected.length) break;
      continue;
    }
    if (ATTRIBUTE_LINE.test(line)) continue;
    collected.push(line);
    if (/[{;]/.test(line)) break;
  }
  return collected.join(" ").trim();
}

/**
 * Finds the first XML doc block documenting a member that is missing a
 * required tag: `<param>` when the member takes parameters, `<returns>` when
 * it returns a value.
 *
 * `<typeparam>` and `<exception>` were deliberately left unchecked: reliably
 * telling a generic method's own type parameter from an unrelated generic
 * return type (`Task<T> Foo(T value)`), or attributing a `throw` statement in
 * a method body to the correct preceding doc block, both need more than
 * pattern-matching over written text can honestly promise — a check that
 * misfires on ordinary code is worse than no check, so both are left out
 * rather than guessed at.
 *
 * @param {string[]} lines The written text, split into lines.
 * @returns {"param"|"returns"|null} The first issue found, or `null` when
 * every documented member carries what it needs.
 */
function firstMissingXmlTag(lines) {
  let i = 0;
  while (i < lines.length) {
    if (!XML_DOC_LINE.test(lines[i])) {
      i++;
      continue;
    }
    const blockStart = i;
    while (i < lines.length && XML_DOC_LINE.test(lines[i])) i++;
    const block = lines.slice(blockStart, i).join("\n");

    const signature = nextSignatureLine(lines, i);
    if (!signature || STATEMENT_KEYWORD_START.test(signature)) continue;

    const memberMatch = MEMBER_SIGNATURE.exec(signature);
    if (memberMatch && !MODIFIER_KEYWORDS.has(memberMatch[1])) {
      const returnType = memberMatch[1];
      if (TYPE_DECLARATION_KEYWORDS.has(returnType)) continue;
      const params = memberMatch[3].trim();
      if (params && !/<param[\s>]/i.test(block)) return "param";
      if (returnType !== "void" && !/<returns[\s>]/i.test(block)) return "returns";
      continue;
    }

    const ctorMatch = CONSTRUCTOR_SIGNATURE.exec(signature);
    if (ctorMatch) {
      const params = ctorMatch[2].trim();
      if (params && !/<param[\s>]/i.test(block)) return "param";
    }
  }
  return null;
}

module.exports = {
  /** kebab-case, unique, equals the filename without .js */
  id: "doc-comment-style",

  /** one line, shown by `softela-ai doctor` */
  title: "House documentation style on newly written text",

  /** which host events this rule can fire on */
  events: ["PreToolUse"],

  /** which tool names it applies to; null means every tool */
  tools: /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file)$/,

  /** the strongest action this rule may ever return */
  defaultAction: "deny",

  /** which catalogue group this rule belongs to */
  group: "code",

  /** dotted project-config paths this rule needs to be meaningful */
  requiresConfig: [],

  /** optional: only active when this module is enabled */
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: "deny"|"ask", reason: string, fix?: string}}
   * The decision, or `null` when the written text needs no correction.
   */
  evaluate(ctx) {
    const file = String(ctx.filePath || "");
    const isFrontend = FRONTEND.test(file);
    const isBackend = BACKEND.test(file);
    if (!isFrontend && !isBackend) return pass();

    // R3 decision: kept on ctx.content, not resultingContent — deliberate,
    // per this module's own top-of-file doc block: only newly authored text
    // is judged, so a decoded Edit/MultiEdit's own inserted text is exactly
    // right and a Write/apply_patch add's content already equals the whole
    // file either way.
    const added = String(ctx.content || "");
    if (!added.trim()) return pass();

    if (hasTicketId(added)) {
      return deny(
        "DOC RULE: a ticket id appears in written content. It reads as context " +
          "but turns into a dead reference the moment the tracker changes.",
        "Describe the actual behavior or defect instead; keep the ticket id in the PR and the tracker.",
      );
    }

    if (/^\s*\*?\s*@example\b/m.test(added)) {
      return deny(
        "DOC RULE: `@example` is never used in this project's docs.",
        "State the behavior in the summary and the @-tags instead.",
      );
    }

    if (isBackend && /\/\*\*(?!\*)/m.test(added)) {
      return deny(
        "DOC RULE: C# uses XML doc comments, not JSDoc.",
        "Use `/// <summary>` with <param>, <returns>, <typeparam>, <exception>.",
      );
    }

    const lines = added.split(/\r?\n/);

    const lineRunLimit = configuredThreshold(ctx.project, "maxLineCommentRun", MAX_LINE_COMMENT_RUN);
    const run = longestLineCommentRun(lines);
    if (run > lineRunLimit) {
      return ask(
        `DOC RULE: ${run} consecutive // lines. Documentation belongs in a doc block ` +
          "with structured tags; an inline comment explains why in two or three lines.",
        "Move this into a JSDoc/XML doc block, or confirm this genuinely is neither.",
      );
    }

    const blockLimit = configuredThreshold(ctx.project, "maxBlockLines", MAX_BLOCK_LINES);
    const blockLines = firstOversizedProseBlock(lines, blockLimit);
    if (blockLines > 0) {
      return ask(
        `DOC RULE: a ${blockLines}-line comment block with no @-tags and no list. ` +
          "Length is fine when it is structured; narrative that is really an enumeration is not.",
        "Restructure it into bullets, numbered steps or @-tags, or confirm this is one continuous explanation.",
      );
    }

    if (isBackend) {
      const missingTag = firstMissingXmlTag(lines);
      if (missingTag === "param") {
        return ask(
          "DOC RULE: this member takes parameters but its XML doc block has no <param>.",
          'Add a <param name="...">…</param> for the parameters.',
        );
      }
      if (missingTag === "returns") {
        return ask(
          "DOC RULE: this member returns a value but its XML doc block has no <returns>.",
          "Add a <returns>…</returns> describing the value.",
        );
      }
    }

    return pass();
  },
};
