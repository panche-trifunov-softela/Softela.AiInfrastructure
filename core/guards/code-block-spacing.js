"use strict";

/**
 * Requires a blank line between adjacent statements when either one spans
 * more than one line, and between adjacent type/interface/class/enum
 * members when the later one carries its own doc comment.
 *
 * A run of single-line declarations of the same kind — several `useState`
 * calls in a row — reads fine with no separation at all. What is hard to
 * read is a multi-line construct sitting flush against its neighbor: a
 * multi-line `useMemo` directly above a `useRef`, directly above a
 * multi-line `useEffect`, with no visual break between any of them. This
 * rule targets exactly that shape, and only that shape — it never asks for
 * a blank line between two single-line statements, however many of them run
 * together.
 *
 * ## How adjacency is judged
 *
 * The written content is masked (`maskSource`, this file's own — see its
 * doc comment for why it is not the shared `maskCommentsAndStrings`) and
 * walked once, character by character, tracking a single combined depth
 * over `(`, `[`
 * and `{`. Two kinds of `{` are told apart from an ordinary object literal
 * by what immediately precedes them:
 *
 * - preceded by `)`, `=>`, `else`, `try`, `do`, `finally`, or a bare
 *   `catch` with no binding (which ends in the keyword itself rather than
 *   a `)`) — a statement block. Its contents are split into their own
 *   top-level statements and checked the same way, recursively.
 * - preceded by `class`, `interface`, `enum` or `type` (with its name, and
 *   an optional `extends`/`implements` clause, in between) — a type body.
 *   Its contents are split into members and checked by the second rule
 *   below, never by the statement rule.
 * - preceded by `switch (...)` — a case list. Not scanned at all; case
 *   labels are not statements this rule has an opinion about.
 * - anything else — an object literal, a destructuring pattern, a JSX
 *   expression container. Skipped over (matched to its closing brace) and
 *   never treated as a statement boundary itself; unlike an argument list
 *   or an array literal (below), its own interior is not searched further,
 *   so a callback sitting inside an object property is not found this way.
 *
 * A `(...)` argument list and a `[...]` array literal are skipped the same
 * way as far as ending a statement goes — neither one is itself a
 * statement boundary. Their interior is not opaque the way an object
 * literal's is, though: an argument or an element can itself be an arrow
 * function or a function expression carrying a real statement block
 * (`items.forEach((item) => { ... })`), so the span is searched for one, at
 * whatever nesting depth is reached through further argument lists or
 * array literals inside it, and each one found is recursed into and
 * checked exactly like a top-level block.
 *
 * A statement ends at a `;` reached at this level's own base depth, at a
 * newline whose next line unambiguously opens a new statement (see "Known
 * scope limits" below for exactly which keywords qualify), or right after
 * a recursed block/type body closes, unless what follows is `else`,
 * `catch`, `finally` or `while` — which means the compound statement
 * (`if`/`try`/`do`) is still continuing.
 *
 * Two statements need a blank line between them when either one's own code
 * spans more than one line — an attached leading comment does not itself
 * make a single-line statement "multi-line", but a blank line for the pair
 * is required immediately above that comment, not between the comment and
 * the code it documents. Two adjacent `import` statements are always
 * exempt, whatever their own line count — and so are two adjacent
 * re-export statements (`export { ... } from "..."`, `export * from
 * "..."`), the mirror image of the same thing: a declaration of what the
 * module surfaces, not a sequence of logical steps. The exemption is
 * scoped to a re-export specifically — a `from "..."` clause is what
 * separates it from an ordinary local `export { Foo, Bar };`, and neither a
 * multi-line `export const` nor a multi-line `export function` is a
 * re-export at all; both remain statements like any other.
 *
 * ## The second check
 *
 * Inside a type, interface, class or enum body, a member is split from its
 * siblings the same way. A member preceded by its own `/** ... *\/` doc
 * comment, with no blank line directly above that comment, is a violation —
 * `docs/standards/code-documentation.md` already requires the blank line;
 * nothing checked for it until this rule.
 *
 * ## Known scope limits
 *
 * This is a heuristic scanner, not a parser. A statement or a `type`/
 * `interface` member relying on a bare newline instead of a trailing `;` or
 * `,` is recognized as ending there only when the text right after the
 * newline begins with one of a small set of keywords that can only open a
 * new statement — `const`, `let`, `var`, `function`, `class`, `export`,
 * `import`, `if`, `for`, `while`, `do`, `switch`, `return`, `throw`,
 * `break`, `continue`, `try`, `interface` or `enum`. Anything else starting
 * the next line — a bare identifier, a chained call, a binary or ternary
 * operator continuing the expression above it — is left merged with what
 * precedes it rather than guessed at: a wrong guess here reports a wrong
 * line number, while a missed one only under-reports. Giving every
 * statement and every member its own terminator avoids the gap entirely. A
 * function type whose return position is itself an object type (`(x:
 * number) => { count: number }`) is misread as a statement block; this
 * shape is rare enough in practice that handling it was not worth the
 * added complexity.
 *
 * ## Severity
 *
 * This rule ships as `ask` — an advisory nudge, never a block. The severity
 * was decided by measurement against real production code, on a criterion
 * stated before the number was known: near zero false positives means
 * deny, anything else means advise. After the parsing defects that
 * measurement exposed were fixed, a hand audit of the residual hits found
 * every one genuine — the rule is accurate. But the convention it checks is
 * not yet followed widely enough in the existing codebase for a block to be
 * proportionate. It advises, and can be raised once new code has been
 * complying for a while.
 */

const { deny, ask, pass } = require("../lib/decision");

/** Tool names this rule inspects: file-write calls on both hosts. */
const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file)$/;

/** This rule judges TypeScript, TSX, JavaScript and JSX source. */
const SOURCE_FILE = /\.[jt]sx?$/i;

/**
 * The severity this rule reports at, isolated in one place — see the module
 * doc comment's own "Severity" section for why it currently reads `"ask"`.
 * Flipping it also flips {@link ADVISORY} below, since that flag is derived
 * from it — the two-field change `defaultAction`/`advisoryAsk` in the
 * exported rule below then becomes a single-line edit here instead.
 */
const SEVERITY = "ask";

/** Derived from {@link SEVERITY}; `true` once it reads `"ask"`. */
const ADVISORY = SEVERITY === "ask";

/**
 * Matches the text immediately before a `{` that opens a `switch` body —
 * checked first, since a `switch (...)` header ends in `)` the same way a
 * function or control-flow header does.
 */
const SWITCH_HEADER = /\bswitch\s*\([^{}]*\)\s*$/;

/**
 * Matches the text immediately before a `{` that opens a statement block.
 * `catch` needs its own alternative alongside `)`: a `catch` that binds its
 * error still ends in `)` and is already covered, but a parameterless
 * `catch {` ends in the bare keyword instead.
 */
const BLOCK_BRACE_PRECEDER = /(?:\)|=>|\belse\b|\btry\b|\bdo\b|\bfinally\b|\bcatch\b)\s*$/;

/**
 * Matches the text immediately before a `{` that opens a type, interface,
 * class or enum body — the declaration keyword, its name, an optional
 * generic parameter list, an optional `extends`/`implements` clause, and
 * for a `type` alias the trailing `=`.
 */
const TYPE_BODY_OPENER =
  /\b(?:class|interface|enum|type)\s+[A-Za-z_$][\w$]*(?:<[^{};]*>)?(?:\s+(?:extends|implements)\s+[^{};=]+)?\s*=?\s*$/;

/** An `import` statement's own leading line. */
const IMPORT_LINE = /^\s*import\b/;

/**
 * A re-export statement's own leading line: a named list (`export {`, typed
 * or not) or a star re-export (`export *`). Matched on its own — a plain
 * local `export { Foo, Bar };` matches this too — and paired with
 * {@link RE_EXPORT_CLOSING_LINE} below to tell a genuine re-export apart
 * from that.
 */
const RE_EXPORT_OPENING_LINE = /^\s*export\s+(?:\*|(?:type\s*)?\{)/;

/**
 * A re-export statement's own trailing line: a `from "..."` clause, which is
 * what actually makes it a re-export rather than a local named export list —
 * `export { Foo, Bar };` has no such clause and is an ordinary statement.
 */
const RE_EXPORT_CLOSING_LINE = /\bfrom\s*["'][^"']*["']\s*;?\s*$/;

/** A line that is entirely a `//` comment, or a line inside/closing a `/* ... *\/` block. */
const COMMENT_ONLY_LINE = /^\s*(?:\/\/.*|\/\*.*|\*.*|.*\*\/)\s*$/;

/** How far back a brace-preceding lookback window reaches; declarations never run longer than this. */
const LOOKBACK_WINDOW = 400;

/**
 * Keywords that can only open a new statement, never continue an expression
 * left incomplete on the line above — see {@link startsNewStatement}. Each
 * one is a reserved word with no use as an infix or postfix continuation, so
 * finding one right after a newline is safe evidence that whatever precedes
 * it already ended, even with no `;` in sight. Deliberately excluded:
 * `else`, `catch`, `finally` and `while`, which extend a compound statement
 * rather than start a new one, and every contextual or ambiguous keyword
 * (`type`, `async`, `as`, `in`, `of`, `instanceof`, and the rest) that a
 * real continuation could plausibly still use.
 */
const NEW_STATEMENT_KEYWORD =
  /^(?:const|let|var|function|class|export|import|if|for|while|do|switch|return|throw|break|continue|try|interface|enum)\b/;

/**
 * Tokens after which a `/` opens a regex literal rather than acting as a
 * division operator — the same small set of "an expression is expected
 * next" positions a real parser would recognize.
 */
const REGEX_PRECEDING =
  /(^|[=(,:;!&|?{}[]|\breturn\b|\btypeof\b|\bcase\b|\bin\b|\bof\b|\bnew\b|\bdelete\b|\bvoid\b|\bthrow\b|\byield\b)\s*$/;

/**
 * Decides whether a `/` at the current scan position opens a regex literal,
 * judged from the masked output already produced for everything before it.
 *
 * @param {string} outSoFar The masked output produced so far.
 * @returns {boolean} `true` when the preceding token is one after which a
 * regex literal, not division, is expected.
 */
function isRegexPosition(outSoFar) {
  return REGEX_PRECEDING.test(outSoFar);
}

/**
 * Finds the end of a regex literal opened at `text[start]`, honoring
 * backslash escapes and bracket character classes, then consuming any
 * trailing flag letters.
 *
 * @param {string} text The text to scan.
 * @param {number} start Index of the opening `/`.
 * @returns {number} Index immediately after the literal, or `-1` when no
 * closing `/` is found before a newline or the text's own end.
 */
function findRegexEnd(text, start) {
  let j = start + 1;
  let inClass = false;
  while (j < text.length) {
    const c = text[j];
    if (c === "\n") return -1;
    if (c === "\\" && j + 1 < text.length) {
      j += 2;
      continue;
    }
    if (c === "[") {
      inClass = true;
      j += 1;
      continue;
    }
    if (c === "]") {
      inClass = false;
      j += 1;
      continue;
    }
    if (c === "/" && !inClass) {
      j += 1;
      while (j < text.length && /[a-zA-Z]/.test(text[j])) j += 1;
      return j;
    }
    j += 1;
  }
  return -1;
}

/**
 * Masks comments, string/template literals and regex literals in one pass —
 * the same masking `../lib/source-mask.js#maskCommentsAndStrings` does,
 * plus regex-literal awareness that shared module deliberately does not
 * carry (its own doc comment states so; it has other callers with no need
 * for it). The two cannot be layered as separate passes: a regex containing
 * a character class with both quote characters (`(?:['"])`, an ordinary way
 * to match either quote style) hands `maskCommentsAndStrings` a lone `"`
 * with no regex context around it, which it reads as opening a real string
 * and then does not close until some unrelated quote later in the file —
 * silently corrupting everything in between before a later, separate regex
 * pass ever gets a chance to blank the regex body it belongs to. Checking
 * for a regex at each `/` before ever treating a bare quote as a string, in
 * the same scan, is what keeps the two from corrupting each other.
 *
 * @param {string} content The raw source text.
 * @returns {string} The masked text, the same length as `content`, with
 * every newline preserved in place — the same invariants
 * {@link maskCommentsAndStrings} guarantees.
 */
function maskSource(content) {
  const text = String(content || "");
  const n = text.length;
  let out = "";
  let i = 0;

  while (i < n) {
    const two = text.slice(i, i + 2);

    if (two === "//") {
      while (i < n && text[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }

    if (two === "/*") {
      out += "  ";
      i += 2;
      while (i < n && text.slice(i, i + 2) !== "*/") {
        out += text[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }

    const ch = text[i];

    if (ch === "/" && isRegexPosition(out)) {
      const regexEnd = findRegexEnd(text, i);
      if (regexEnd !== -1) {
        for (let k = i; k < regexEnd; k += 1) out += text[k] === "\n" ? "\n" : " ";
        i = regexEnd;
        continue;
      }
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      out += " ";
      i += 1;
      while (i < n && text[i] !== ch) {
        // An escape consumes two characters and must contribute two, or the
        // length invariant breaks for every position after it.
        if (text[i] === "\\" && i + 1 < n) {
          out += "  ";
          i += 2;
          continue;
        }
        out += text[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < n) {
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
 * Finds the index of the bracket matching an opener at `openIndex`,
 * treating `(`, `[` and `{` as one combined counter — correct for
 * syntactically valid source, which is the only source this rule has
 * anything useful to say about.
 *
 * @param {string} masked Source already run through
 * {@link maskSource}.
 * @param {number} openIndex Index of the opening bracket.
 * @returns {number} Index of the matching closer, or `masked.length` when
 * the source never closes it.
 */
function findMatchingClose(masked, openIndex) {
  let depth = 1;
  for (let i = openIndex + 1; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return masked.length;
}

/**
 * Classifies a `{` found at `index` by what precedes it.
 *
 * @param {string} masked Source already run through
 * {@link maskSource}.
 * @param {number} index Index of the `{`.
 * @returns {"switch"|"type"|"block"|"opaque"} What this brace opens.
 */
function classifyBrace(masked, index) {
  const lookback = masked.slice(Math.max(0, index - LOOKBACK_WINDOW), index);
  if (SWITCH_HEADER.test(lookback)) return "switch";
  if (TYPE_BODY_OPENER.test(lookback)) return "type";
  if (BLOCK_BRACE_PRECEDER.test(lookback)) return "block";
  return "opaque";
}

/**
 * Decides whether the text starting at `from`, after skipping further
 * whitespace, opens a new statement — see {@link NEW_STATEMENT_KEYWORD} for
 * exactly which keywords qualify and why the set is kept narrow.
 *
 * @param {string} masked Source already run through {@link maskSource}.
 * @param {number} from Offset to start looking from, typically right after
 * a newline reached while a statement is still being accumulated.
 * @returns {boolean} `true` when a safe new-statement keyword follows.
 */
function startsNewStatement(masked, from) {
  let j = from;
  while (j < masked.length && /\s/.test(masked[j])) j += 1;
  return NEW_STATEMENT_KEYWORD.test(masked.slice(j, j + 16));
}

/**
 * Characters a line cannot end on and still be a finished statement: an
 * operator, a separator or an opening delimiter all say the expression
 * continues onto the next line.
 */
const INCOMPLETE_EXPRESSION_TAIL = /[=+\-*/%&|^!~<>,([{?:.]/;

/**
 * Decides whether the text before a newline leaves an expression visibly
 * unfinished.
 *
 * {@link NEW_STATEMENT_KEYWORD} reads only what follows the newline, and
 * three of its keywords — `function`, `class` and `import` — are equally
 * legal in expression position, so a value assigned across two lines
 * (`const handler =` then `function () {`) looks exactly like two
 * statements from that side alone. Reading the line that precedes the
 * newline settles it: a line ending on an operator, a separator or an
 * opening delimiter has not finished a statement, whatever begins the line
 * below it.
 *
 * @param {string} masked Source already run through {@link maskSource}.
 * @param {number} newlineIndex Offset of the newline being considered.
 * @returns {boolean} `true` when the preceding line leaves an expression
 * open, so the newline is not a statement boundary.
 */
function endsIncompleteExpression(masked, newlineIndex) {
  let j = newlineIndex - 1;
  while (j >= 0 && /\s/.test(masked[j])) j -= 1;
  if (j < 0) return false;

  return INCOMPLETE_EXPRESSION_TAIL.test(masked[j]);
}

/**
 * Computes the character offset each line begins at.
 *
 * @param {string} text The text to index.
 * @returns {number[]} Offsets, one per line, in source order.
 */
function computeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/**
 * Resolves the zero-based line number a character offset falls on.
 *
 * @param {number[]} lineStarts Offsets from {@link computeLineStarts}.
 * @param {number} index The character offset to resolve.
 * @returns {number} The line number `index` falls on.
 */
function lineAt(lineStarts, index) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Classifies a `{` found at `index` and acts on what it opens: a statement
 * block is recursed into immediately and checked for its own spacing
 * violations, a type body is recorded for the caller to check once its own
 * level is fully walked, and a switch body or an opaque brace (an object
 * literal, a destructuring pattern, a JSX expression container) is left
 * alone beyond finding its matching closer. Shared by
 * {@link splitTopLevelSegments}'s own top-level scan and by
 * {@link scanArgumentSpanForBlocks}, since both need to do exactly this
 * once they find a `{`.
 *
 * @param {string} masked Source already run through {@link maskSource}.
 * @param {number} index Index of the `{`.
 * @param {{blockViolations: object[], typeBodies: {start: number, end: number}[]}} collector
 * Accumulates spacing findings and nested type-body ranges, the same way
 * {@link splitTopLevelSegments} does.
 * @param {number[]} lineStarts Offsets from {@link computeLineStarts}.
 * @param {string[]} originalLines The unmasked source, split on `"\n"`.
 * @returns {{kind: "switch"|"type"|"block"|"opaque", closeIndex: number}}
 * What the brace opens, and the index of its matching closer.
 */
function handleBrace(masked, index, collector, lineStarts, originalLines) {
  const kind = classifyBrace(masked, index);
  const closeIndex = findMatchingClose(masked, index);

  if (kind === "block") {
    const inner = splitTopLevelSegments(masked, index + 1, closeIndex, collector, lineStarts, originalLines);
    checkStatementSpacing(inner, lineStarts, originalLines, collector.blockViolations);
  } else if (kind === "type") {
    collector.typeBodies.push({ start: index + 1, end: closeIndex });
  }

  return { kind, closeIndex };
}

/**
 * Scans a skipped `(...)` or `[...]` span — an argument list or an array
 * literal, neither of which is itself a statement boundary — for a
 * callback's own statement block nested inside it: an arrow function or a
 * function expression passed as an argument or held as an element. Found at
 * whatever depth is reached through further argument lists or array
 * literals inside the span, each one is recursed into and checked exactly
 * like a top-level block, rather than the whole span being treated as an
 * opaque unit with nothing worth looking at inside it.
 *
 * An opaque brace encountered along the way (an object literal or a
 * destructuring pattern inside the span) is left alone the same way
 * {@link splitTopLevelSegments} leaves one alone at its own level — this
 * only follows argument lists and array literals, not into an object
 * literal's own properties.
 *
 * @param {string} masked Source already run through {@link maskSource}.
 * @param {number} start Offset where the span's content begins, just after
 * its opening `(` or `[`.
 * @param {number} end Offset where the span's content ends — its matching
 * closer's own index.
 * @param {{blockViolations: object[], typeBodies: {start: number, end: number}[]}} collector
 * Accumulates findings the same way {@link splitTopLevelSegments} does.
 * @param {number[]} lineStarts Offsets from {@link computeLineStarts}.
 * @param {string[]} originalLines The unmasked source, split on `"\n"`.
 * @returns {void}
 */
function scanArgumentSpanForBlocks(masked, start, end, collector, lineStarts, originalLines) {
  let i = start;

  while (i < end) {
    const ch = masked[i];

    if (ch === "(" || ch === "[") {
      const closeIndex = findMatchingClose(masked, i);
      scanArgumentSpanForBlocks(masked, i + 1, closeIndex, collector, lineStarts, originalLines);
      i = closeIndex + 1;
      continue;
    }

    if (ch === "{") {
      const { closeIndex } = handleBrace(masked, i, collector, lineStarts, originalLines);
      i = closeIndex + 1;
      continue;
    }

    i += 1;
  }
}

/**
 * Splits one nesting level into its own top-level segments — statements in
 * a module or a statement block, members in a type/interface/class/enum
 * body — skipping over nested argument lists, array literals and object
 * literals (though a callback's own statement block nested inside an
 * argument list or an array literal is still found and checked, see
 * {@link scanArgumentSpanForBlocks}), and recursing into a nested statement
 * block to check its own statements immediately, or recording a nested type
 * body for the caller to check once this level is fully walked.
 *
 * @param {string} masked Source already run through
 * {@link maskSource}.
 * @param {number} start Offset where this level's content begins.
 * @param {number} end Offset where this level's content ends (exclusive).
 * @param {{blockViolations: object[], typeBodies: {start: number, end: number}[]}} collector
 * Accumulates spacing findings from every recursed statement block
 * (`blockViolations`) and the range of every nested type body found
 * (`typeBodies`), for the caller to check once this call returns.
 * @param {number[]} lineStarts Offsets from {@link computeLineStarts}.
 * @param {string[]} originalLines The unmasked source, split on `"\n"`.
 * @returns {{startIndex: number, endIndex: number}[]} This level's own
 * segments, in source order.
 */
function splitTopLevelSegments(masked, start, end, collector, lineStarts, originalLines) {
  const segments = [];
  let segStart = -1;
  let i = start;

  // Tracks nesting through a generic type argument list (`Record<string,
  // string>`, `Foo<Bar<Baz>>`, a generic function's own `<T, U>` clause) so a
  // comma inside one is not misread as a top-level statement separator — `<`
  // and `>` are not otherwise depth-tracked at all, and neither is a generic
  // clause skipped wholesale the way a paren, bracket or brace argument list
  // is. Only a `<` glued directly onto a preceding identifier, with no
  // whitespace between them, opens a level: real generic syntax is written
  // that way, while a comparison (`a < b`) and a JSX tag (always preceded by
  // whitespace, a keyword, or punctuation, never by a bare identifier) are
  // not — so this never mistakes either of those for one.
  let angleDepth = 0;

  while (i < end) {
    const ch = masked[i];

    if (/\s/.test(ch)) {
      // A newline reached while a statement is still being accumulated
      // (no `;` has closed it yet) is a boundary in its own right when
      // what follows unambiguously opens a new statement AND what precedes
      // it is not an expression still waiting to be finished — see
      // {@link startsNewStatement} and {@link endsIncompleteExpression}.
      // Anything else found there is left merged with what precedes it;
      // the newline itself carries no signal beyond that one safe case.
      if (
        ch === "\n" &&
        segStart !== -1 &&
        angleDepth === 0 &&
        startsNewStatement(masked, i + 1) &&
        !endsIncompleteExpression(masked, i)
      ) {
        segments.push({ startIndex: segStart, endIndex: i });
        segStart = -1;
      }
      i += 1;
      continue;
    }
    if (segStart === -1) segStart = i;

    if (ch === "<" && /[A-Za-z0-9_$]/.test(masked[i - 1] || "")) {
      angleDepth += 1;
      i += 1;
      continue;
    }

    if (ch === ">" && angleDepth > 0 && masked[i - 1] !== "=") {
      angleDepth -= 1;
      i += 1;
      continue;
    }

    if (ch === "(" || ch === "[") {
      const closeIndex = findMatchingClose(masked, i);
      scanArgumentSpanForBlocks(masked, i + 1, closeIndex, collector, lineStarts, originalLines);
      i = closeIndex + 1;
      continue;
    }

    if (ch === "{") {
      const { kind, closeIndex } = handleBrace(masked, i, collector, lineStarts, originalLines);

      i = closeIndex + 1;
      if (kind === "opaque") continue;

      let j = i;
      while (j < end && /\s/.test(masked[j])) j += 1;
      const continues = /^(?:else|catch|finally|while)\b/.test(masked.slice(j, j + 8));
      if (continues) continue;

      // The brace just closed is not always the statement's own end: an
      // arrow-function or function-expression assignment (`const x = () =>
      // {...};`) and a `type` alias with a braced body (`type X = {...};`)
      // both continue past their closing brace to the `;` that actually
      // terminates them. That `;` belongs to this same statement — treating
      // it as a fresh segment starting at its own position previously read
      // as "the statement's opening line and its own closing line run
      // together", which is not two statements at all. A trailing `,`
      // (a comma-separated multi-declarator statement) is deliberately not
      // absorbed the same way: the declarator after it is still a separate
      // segment either way, so doing this only for `;` is what actually
      // resolves the shape above without half-fixing a rarer one.
      if (j < end && masked[j] === ";") i = j + 1;

      segments.push({ startIndex: segStart, endIndex: i });
      segStart = -1;
      continue;
    }

    if ((ch === ";" || ch === ",") && angleDepth === 0) {
      segments.push({ startIndex: segStart, endIndex: i + 1 });
      segStart = -1;
      i += 1;
      continue;
    }

    i += 1;
  }

  if (segStart !== -1) segments.push({ startIndex: segStart, endIndex: end });
  return segments;
}

/**
 * Extends a segment's own start line upward over an attached leading
 * comment — a run of comment-only lines directly above it, with no blank
 * line breaking the run.
 *
 * @param {string[]} originalLines The unmasked source, split on `"\n"`.
 * @param {number} startLine The segment's own first line.
 * @returns {number} The first line of the attached comment, or `startLine`
 * itself when nothing precedes it.
 */
function effectiveStartLine(originalLines, startLine) {
  let i = startLine - 1;
  while (i >= 0 && originalLines[i].trim() !== "" && COMMENT_ONLY_LINE.test(originalLines[i])) {
    i -= 1;
  }
  return i + 1;
}

/**
 * Builds a short, readable label for a segment, for use in a reported
 * reason — its own first line, trimmed and capped.
 *
 * @param {string[]} originalLines The unmasked source, split on `"\n"`.
 * @param {number} line The segment's own first code line.
 * @returns {string} The label text.
 */
function labelFor(originalLines, line) {
  const text = (originalLines[line] || "").trim();
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/**
 * Decides whether a statement is a genuine re-export — a named list or a
 * star form, with a `from "..."` clause — by checking its own first and
 * last line, since a multi-line named list carries the clause that actually
 * makes it one on its last line, not its first.
 *
 * @param {string[]} originalLines The unmasked source, split on `"\n"`.
 * @param {number} startLine The statement's own first line.
 * @param {number} endLine The statement's own last line.
 * @returns {boolean} `true` when both ends match a re-export's shape.
 */
function isReExportStatement(originalLines, startLine, endLine) {
  return (
    RE_EXPORT_OPENING_LINE.test(originalLines[startLine] || "") &&
    RE_EXPORT_CLOSING_LINE.test(originalLines[endLine] || "")
  );
}

/**
 * Checks a level's own statements for the required blank line: two
 * statements need one between them when either spans more than one line,
 * except a pair of `import` statements, or a pair of re-export statements,
 * neither of which ever does.
 *
 * @param {{startIndex: number, endIndex: number}[]} segments One level's
 * own statements, from {@link splitTopLevelSegments}.
 * @param {number[]} lineStarts Offsets from {@link computeLineStarts}.
 * @param {string[]} originalLines The unmasked source, split on `"\n"`.
 * @param {object[]} violations Findings are appended here, in source
 * order, as `{line, reason, fix}`.
 * @returns {void}
 */
function checkStatementSpacing(segments, lineStarts, originalLines, violations) {
  for (let idx = 1; idx < segments.length; idx += 1) {
    const prev = segments[idx - 1];
    const next = segments[idx];

    const prevStartLine = lineAt(lineStarts, prev.startIndex);
    const prevEndLine = lastNonBlankLine(originalLines, lineStarts, prev);
    const nextStartLine = lineAt(lineStarts, next.startIndex);
    const nextEndLine = lastNonBlankLine(originalLines, lineStarts, next);

    const prevMultiLine = prevEndLine > prevStartLine;
    const nextMultiLine = nextEndLine > nextStartLine;
    if (!prevMultiLine && !nextMultiLine) continue;

    const prevIsImport = IMPORT_LINE.test(originalLines[prevStartLine] || "");
    const nextIsImport = IMPORT_LINE.test(originalLines[nextStartLine] || "");
    if (prevIsImport && nextIsImport) continue;

    const prevIsReExport = isReExportStatement(originalLines, prevStartLine, prevEndLine);
    const nextIsReExport = isReExportStatement(originalLines, nextStartLine, nextEndLine);
    if (prevIsReExport && nextIsReExport) continue;

    const nextEffectiveLine = effectiveStartLine(originalLines, nextStartLine);
    const gapLines = originalLines.slice(prevEndLine + 1, nextEffectiveLine);
    const hasBlankLine = gapLines.some((line) => line.trim() === "");
    if (hasBlankLine) continue;

    violations.push({
      line: nextEffectiveLine,
      reason:
        `"${labelFor(originalLines, prevStartLine)}" and "${labelFor(originalLines, nextStartLine)}" run together ` +
        "with no blank line between them, and at least one of the two spans more than one line.",
      fix: `Insert a blank line before line ${nextEffectiveLine + 1}.`,
    });
  }
}

/**
 * Resolves the last line a segment's own code occupies.
 *
 * @param {string[]} originalLines The unmasked source, split on `"\n"`.
 * @param {number[]} lineStarts Offsets from {@link computeLineStarts}.
 * @param {{startIndex: number, endIndex: number}} segment The segment.
 * @returns {number} The zero-based line its last non-whitespace character
 * falls on.
 */
function lastNonBlankLine(originalLines, lineStarts, segment) {
  // `masked` is not in scope here; the caller already trimmed trailing
  // whitespace out of `endIndex` is not guaranteed, so walk back over
  // `originalLines` directly using the line the raw end offset falls on,
  // then step up past any blank lines a trailing separator left behind.
  let line = lineAt(lineStarts, Math.max(segment.startIndex, segment.endIndex - 1));
  while (line > lineAt(lineStarts, segment.startIndex) && (originalLines[line] || "").trim() === "") {
    line -= 1;
  }
  return line;
}

/**
 * Checks a type/interface/class/enum body's own members: a member carrying
 * its own leading doc comment must be separated by a blank line from the
 * member before it.
 *
 * @param {{startIndex: number, endIndex: number}[]} segments One type
 * body's own members, from {@link splitTopLevelSegments}.
 * @param {number[]} lineStarts Offsets from {@link computeLineStarts}.
 * @param {string[]} originalLines The unmasked source, split on `"\n"`.
 * @param {object[]} violations Findings are appended here, in source
 * order, as `{line, reason, fix}`.
 * @returns {void}
 */
function checkMemberSpacing(segments, lineStarts, originalLines, violations) {
  for (let idx = 1; idx < segments.length; idx += 1) {
    const prev = segments[idx - 1];
    const next = segments[idx];

    const prevEndLine = lastNonBlankLine(originalLines, lineStarts, prev);
    const nextStartLine = lineAt(lineStarts, next.startIndex);
    const nextEffectiveLine = effectiveStartLine(originalLines, nextStartLine);
    if (nextEffectiveLine === nextStartLine) continue; // no doc comment attached, nothing to check

    if (!/^\s*\/\*\*/.test(originalLines[nextEffectiveLine] || "")) continue; // attached comment is not a doc comment

    const gapLines = originalLines.slice(prevEndLine + 1, nextEffectiveLine);
    const hasBlankLine = gapLines.some((line) => line.trim() === "");
    if (hasBlankLine) continue;

    violations.push({
      line: nextEffectiveLine,
      reason: `"${labelFor(originalLines, nextStartLine)}" carries its own doc comment but sits flush against the member before it.`,
      fix: `Insert a blank line before line ${nextEffectiveLine + 1}.`,
    });
  }
}

/**
 * Finds every spacing violation in a piece of JavaScript, TypeScript, JSX or
 * TSX source: the statement-spacing rule, applied recursively through every
 * statement block, and the member-spacing rule, applied to every type,
 * interface, class and enum body found along the way.
 *
 * @param {string} content The source text to check.
 * @returns {object[]} Every violation found, ordered by line number.
 */
function findViolations(content) {
  const masked = maskSource(content);
  const lineStarts = computeLineStarts(masked);
  const originalLines = content.split("\n");

  const collector = { blockViolations: [], typeBodies: [] };
  const topSegments = splitTopLevelSegments(masked, 0, masked.length, collector, lineStarts, originalLines);
  checkStatementSpacing(topSegments, lineStarts, originalLines, collector.blockViolations);

  const memberViolations = [];
  let cursor = 0;
  while (cursor < collector.typeBodies.length) {
    const body = collector.typeBodies[cursor];
    cursor += 1;
    const members = splitTopLevelSegments(masked, body.start, body.end, collector, lineStarts, originalLines);
    checkMemberSpacing(members, lineStarts, originalLines, memberViolations);
  }

  return collector.blockViolations.concat(memberViolations).sort((a, b) => a.line - b.line);
}

module.exports = {
  /** kebab-case, unique, equals the filename without .js */
  id: "code-block-spacing",

  /** one line, shown by `softela-ai doctor` */
  title: "Separate multi-line statements and doc-commented members with a blank line",

  /** which host events this rule can fire on */
  events: ["PreToolUse"],

  /** which tool names it applies to; null means every tool */
  tools: WRITE_TOOLS,

  /** the strongest action this rule may ever return */
  defaultAction: SEVERITY,

  /** which catalogue group this rule belongs to */
  group: "code",

  /** frontend-only: JS/TS statement layout is a frontend concern here */
  stacks: ["frontend"],

  /** flush spacing in an existing file predates this rule; tightening it is a refactor suggestion, not a requirement for touching it */
  newCodeOnly: true,

  /** a size/style nudge exactly when SEVERITY reads "ask"; see the module-level comment on that constant */
  advisoryAsk: ADVISORY,

  /** no threshold to configure — this rule counts nothing */
  requiresConfig: [],

  /** optional: only active when this module is enabled */
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: string, reason: string, fix?: string}} A
   * decision for the first spacing violation found, in source order;
   * `null` when the written content needs no correction.
   */
  evaluate(ctx) {
    const filePath = String(ctx.filePath || "");
    if (!SOURCE_FILE.test(filePath)) return pass();

    // This rule judges adjacency between a statement and its neighbor, which
    // an Edit/MultiEdit's own inserted text cannot show once the neighbor
    // lies outside the edited region — the exact shape a new multi-line hook
    // call inserted next to existing code takes. `resultingContent` is the
    // whole reconstructed file for every real write; falling back to
    // `content` only matters when reconstruction failed, or for a Write/
    // apply_patch add, where the two already hold the same text.
    const content = typeof ctx.resultingContent === "string" ? ctx.resultingContent : String(ctx.content || "");
    if (!content.trim()) return pass();

    const violations = findViolations(content);
    if (violations.length === 0) return pass();

    const first = violations[0];
    const build = SEVERITY === "ask" ? ask : deny;
    return build(first.reason, first.fix);
  },
};
