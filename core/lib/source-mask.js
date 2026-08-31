"use strict";

/**
 * Neutralises comments and string/template literals in JavaScript-family
 * source, so a rule scanning for a keyword, a declaration or a brace never
 * matches one that only appears inside a comment or a quoted string.
 *
 * This existed three times over before it lived here — in
 * `core/guards/component-types-file.js`, `core/guards/barrel-exports-only.js`
 * and, in a narrower form, `core/guards/no-explicit-any.js` — and the first
 * two differed in exactly one respect: which character they left behind in
 * place of a masked string's contents, and whether the quote characters
 * themselves survived. That is a parameter, not a reason for a second copy,
 * and a fourth copy is what a new rule needed before this module existed.
 *
 * Two invariants every caller depends on, and neither is optional:
 *
 * - **The result is the same length as the input**, character for character.
 *   A caller matches against the masked text and then indexes back into the
 *   original by the same offset (`component-types-file`'s brace-depth scan
 *   does exactly this); a mask that shortened anything would silently
 *   misreport every position after the first string.
 * - **Newlines survive as newlines**, inside comments and multi-line
 *   template literals included, so a line number computed from the masked
 *   text is the line number in the real file.
 */

/**
 * Masks comments and string/template literals.
 *
 * Regex literals are deliberately NOT masked. Telling one apart from a
 * division operator needs surrounding-token heuristics
 * (`core/guards/no-explicit-any.js` carries them for its own purpose), and a
 * regex literal that happens to spell out a keyword as one of its own tokens
 * is not a realistic case to guard against — where it matters, a caller that
 * needs regex handling keeps its own scanner rather than making this one
 * guess.
 *
 * @param {string} src The raw source text.
 * @param {{filler?: string, keepQuotes?: boolean}} [options] `filler` is the
 * single character substituted for each masked character, defaulting to a
 * space — pass `"#"` when the caller needs masked regions to remain visibly
 * non-empty (a rule asserting that a string was *present* but not reading
 * its contents). `keepQuotes` leaves the opening and closing quote
 * characters themselves in place, defaulting to `false`; a caller that
 * detects string literals by their delimiters needs them, one that only
 * scans for keywords does not.
 * @returns {string} The masked text, exactly as long as `src`, with every
 * newline preserved in place.
 */
function maskCommentsAndStrings(src, options) {
  const opts = options || {};
  const filler = typeof opts.filler === "string" && opts.filler.length === 1 ? opts.filler : " ";
  const keepQuotes = opts.keepQuotes === true;

  const text = String(src === undefined || src === null ? "" : src);
  let out = "";
  let i = 0;
  const n = text.length;

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
    if (ch === "'" || ch === '"' || ch === "`") {
      out += keepQuotes ? ch : " ";
      i += 1;
      while (i < n && text[i] !== ch) {
        // An escape consumes two characters and must contribute two, or the
        // length invariant breaks for every position after it.
        if (text[i] === "\\" && i + 1 < n) {
          out += filler + filler;
          i += 2;
          continue;
        }
        out += text[i] === "\n" ? "\n" : filler;
        i += 1;
      }
      if (i < n) {
        out += keepQuotes ? ch : " ";
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
 * Computes the brace-nesting depth in effect immediately before each index
 * of an already-masked text, so a keyword's own index can be checked against
 * it directly to tell a top-level declaration from a nested one.
 *
 * Must be given text that has already been through
 * {@link maskCommentsAndStrings}: a brace inside a comment or a template
 * literal would otherwise shift every depth after it.
 *
 * @param {string} masked Text already passed through
 * {@link maskCommentsAndStrings}.
 * @returns {Int32Array} The depth in effect before the character at each
 * index; never negative, so an unbalanced `}` cannot drive it below zero and
 * make later top-level code read as nested.
 */
function buildDepthBeforeEachIndex(masked) {
  const text = String(masked || "");
  const depths = new Int32Array(text.length);
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    depths[i] = depth;
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") depth = Math.max(0, depth - 1);
  }
  return depths;
}

module.exports = { maskCommentsAndStrings, buildDepthBeforeEachIndex };
