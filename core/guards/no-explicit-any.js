"use strict";

/**
 * Ratchets the count of `any` escapes inside a project's contract types.
 *
 * Absolute would be unshippable against a codebase that already has hundreds
 * of these; ratcheted only stops the count from growing, which is a rule a
 * team can actually turn on. A brand-new file starts from a baseline of
 * zero, so the very first line of a new contract file is held to the same
 * standard as an old one.
 */

const path = require("path");
const { deny, pass } = require("../lib/decision");
const { globToRegex } = require("../lib/project-resolver");

/** Tool names this rule inspects, shared with every other file-content rule. */
const FILE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file)$/;

/** The four `any` escapes the naming wiki calls out. */
const ANY_ESCAPE = /:\s*any\b|<\s*any\s*>|\bas\s+any\b|\bany\s*\[\s*\]/g;

/**
 * Tokens after which a `/` starts a regex literal rather than a division
 * operator. Mirrors the small set of positions a real parser would treat as
 * "expression expected next".
 */
const REGEX_PRECEDING = /(^|[=(,:;!&|?{}[]|\breturn\b|\btypeof\b|\bcase\b|\bin\b|\bof\b|\bnew\b|\bdelete\b|\bvoid\b|\bthrow\b|\byield\b)\s*$/;

/**
 * Decides whether a `/` at the current scan position opens a regex literal,
 * judged from the code already emitted for the current expression.
 *
 * @param {string} outSoFar The masked output produced so far for the
 * current scan span.
 * @returns {boolean} `true` when the preceding token is one after which a
 * regex literal, not division, is expected.
 */
function isRegexPosition(outSoFar) {
  return REGEX_PRECEDING.test(outSoFar);
}

/**
 * Finds the end of a regex literal opened at `s[start]`, honouring
 * backslash escapes and bracket character classes, then consuming any
 * trailing flag letters.
 *
 * @param {string} s The full source text.
 * @param {number} start The index of the opening `/`.
 * @param {number} end The exclusive index to stop scanning at.
 * @returns {number} The index immediately after the literal, or `-1` when
 * no closing `/` is found before a newline or `end`.
 */
function findRegexEnd(s, start, end) {
  let j = start + 1;
  let inClass = false;
  while (j < end) {
    const c = s[j];
    if (c === "\n") return -1;
    if (c === "\\" && j + 1 < end) {
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
      while (j < end && /[a-zA-Z]/.test(s[j])) j += 1;
      return j;
    }
    j += 1;
  }
  return -1;
}

/**
 * Blanks out comments, string/template literals and regex literals, keeping
 * every other character and every newline in place, so an occurrence of
 * `any` inside prose, a string or a regex body never counts as an escape.
 * A template literal's `${...}` interpolations are re-scanned as real code
 * rather than masked, so a cast written inside one is still seen.
 *
 * @param {string} text The source text to mask.
 * @returns {string} The same text with comment, literal and regex bodies
 * replaced by spaces.
 */
function maskCommentsAndStrings(text) {
  return scanMasking(String(text || ""), 0, String(text || "").length, false).out;
}

/**
 * Scans one span of source text, masking comment, string and regex bodies
 * while re-scanning `${...}` template interpolations as code.
 *
 * @param {string} s The full source text.
 * @param {number} start The index to start scanning from.
 * @param {number} end The exclusive index to stop scanning at.
 * @param {boolean} stopAtBrace `true` when this span is a template
 * interpolation that must stop at its own closing `}`.
 * @returns {{out: string, i: number}} The masked text for the scanned span
 * and the index immediately after where scanning stopped.
 */
function scanMasking(s, start, end, stopAtBrace) {
  let out = "";
  let i = start;
  let braceDepth = 0;

  while (i < end) {
    if (stopAtBrace && s[i] === "}" && braceDepth === 0) return { out, i };

    const two = s.slice(i, i + 2);

    if (two === "//") {
      while (i < end && s[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }

    if (two === "/*") {
      out += "  ";
      i += 2;
      while (i < end && s.slice(i, i + 2) !== "*/") {
        out += s[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < end) {
        out += "  ";
        i += 2;
      }
      continue;
    }

    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += " ";
      i += 1;
      while (i < end && s[i] !== quote) {
        if (s[i] === "\\" && i + 1 < end) {
          out += "  ";
          i += 2;
          continue;
        }
        out += s[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < end) {
        out += " ";
        i += 1;
      }
      continue;
    }

    if (ch === "`") {
      out += " ";
      i += 1;
      while (i < end && s[i] !== "`") {
        if (s[i] === "\\" && i + 1 < end) {
          out += "  ";
          i += 2;
          continue;
        }
        if (s[i] === "$" && s[i + 1] === "{") {
          out += "  ";
          i += 2;
          const inner = scanMasking(s, i, end, true);
          out += inner.out;
          i = inner.i;
          if (i < end && s[i] === "}") {
            out += " ";
            i += 1;
          }
          continue;
        }
        out += s[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < end) {
        out += " ";
        i += 1;
      }
      continue;
    }

    if (ch === "/" && two !== "//" && two !== "/*" && isRegexPosition(out)) {
      const regexEnd = findRegexEnd(s, i, end);
      if (regexEnd !== -1) {
        for (let k = i; k < regexEnd; k += 1) out += s[k] === "\n" ? "\n" : " ";
        i = regexEnd;
        continue;
      }
    }

    if (ch === "{") {
      braceDepth += 1;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "}") {
      braceDepth -= 1;
      out += ch;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return { out, i };
}

/**
 * Counts the `any` escapes in a piece of source text, ignoring comments and
 * string literals.
 *
 * @param {string} text The source text to scan.
 * @returns {number} The number of matches.
 */
function countAnyEscapes(text) {
  const masked = maskCommentsAndStrings(text);
  const matches = masked.match(ANY_ESCAPE);
  return matches ? matches.length : 0;
}

module.exports = {
  id: "no-explicit-any",
  title: "Hold the line on `any` inside contract types",
  events: ["PreToolUse"],
  tools: FILE_TOOLS,
  defaultAction: "deny",
  group: "code",

  /** frontend-only: `any` ratcheting targets TypeScript contract types */
  stacks: ["frontend"],

  requiresConfig: ["conventions.contractTypes"],

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: "deny", reason: string, fix?: string}} `deny`
   * when the write raises the file's `any` count above what is already on
   * disk, `null` otherwise.
   */
  evaluate(ctx) {
    const pattern = ctx.project && ctx.project.conventions && ctx.project.conventions.contractTypes;
    if (!pattern) return pass();
    if (!ctx.filePath) return pass();

    const re = globToRegex(pattern);
    if (!re) return pass();

    const boundary = (ctx.git && ctx.git.repoRoot) || ctx.cwd || "";
    let rel = ctx.filePath.replace(/\\/g, "/");
    if (boundary) {
      try {
        const candidate = path.relative(boundary, ctx.filePath);
        if (candidate && !candidate.startsWith("..") && !path.isAbsolute(candidate)) {
          rel = candidate.replace(/\\/g, "/");
        }
      } catch {
        // Fall back to the raw, already-normalised path.
      }
    }
    if (!re.test(rel)) return pass();

    // R3: a ratchet compares the FILE's total `any` count before and after,
    // not "how many `any`s did this write insert" — with only ctx.content
    // (a decoded Edit/MultiEdit's own inserted text), 3 fresh `any` escapes
    // into an 80-`any` legacy file computed 3 <= 80 and passed, exactly the
    // population this rule exists to hold the line on. Falls back to
    // ctx.content when reconstruction failed: a Write/apply_patch add
    // already has content === resultingContent, and undercounting an
    // unreconstructable update is the same fail-open direction every other
    // null-content case in this codebase already takes.
    const newContent = typeof ctx.resultingContent === "string" ? ctx.resultingContent : ctx.content || "";
    const newCount = countAnyEscapes(newContent);
    const onDisk = ctx.readFile(ctx.filePath);
    const oldCount = onDisk === null ? 0 : countAnyEscapes(onDisk);

    if (newCount <= oldCount) return pass();

    return deny(
      `This file is under the contract-types boundary, where "any" is ratcheted: ${oldCount} on disk, ${newCount} in this write.`,
      "Replace the new `any` with a concrete type, `unknown`, or a generic parameter.",
    );
  },
};
