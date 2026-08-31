"use strict";

/**
 * Terminal geometry primitives shared by every screen the interactive
 * installer draws: resolving a usable width/height from a stream that may
 * not report either, measuring and truncating text in display columns
 * rather than string length, and laying out aligned rows that never
 * overflow the resolved width.
 *
 * Nothing here talks to `readline` or drives a prompt — {@link
 * module:core/installer/prompt} and the plan/overview renderers are the
 * callers. This module only answers "how wide is this", "how wide is that
 * stream", and "how do I fit text into that width".
 */

/** Narrowest terminal width {@link terminalWidth} will resolve to. */
const MIN_WIDTH = 40;

/** Widest terminal width {@link terminalWidth} will resolve to. */
const MAX_WIDTH = 120;

/** Width assumed when a stream reports no usable `columns`. */
const FALLBACK_WIDTH = 80;

/** Shortest terminal height {@link terminalRows} will resolve to. */
const MIN_ROWS = 10;

/** Tallest terminal height {@link terminalRows} will resolve to. */
const MAX_ROWS = 60;

/** Height assumed when a stream reports no usable `rows`. */
const FALLBACK_ROWS = 24;

/** Matches an ANSI/VT escape sequence, so {@link displayWidth} can strip it before counting columns. */
const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]/g;

/**
 * Clamps a number into a closed range.
 *
 * @param {number} value The value to clamp.
 * @param {number} min The lower bound.
 * @param {number} max The upper bound.
 * @returns {number} `value`, pulled into `[min, max]`.
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Resolves a stream-reported dimension to a usable, finite, positive
 * integer, falling back and clamping as needed.
 *
 * @param {*} rawValue The stream's own property (`columns` or `rows`),
 * which may be missing, zero, `NaN`, non-finite, or of any other type.
 * @param {number} fallback The value to use when `rawValue` is not a
 * finite, positive number.
 * @param {number} min The lower clamp bound.
 * @param {number} max The upper clamp bound.
 * @returns {number} A finite integer in `[min, max]`.
 */
function resolveDimension(rawValue, fallback, min, max) {
  const n = Number(rawValue);
  const base = Number.isFinite(n) && n > 0 ? n : fallback;
  return clamp(Math.floor(base), min, max);
}

/**
 * Resolves the usable column count for an output stream.
 *
 * @param {NodeJS.WritableStream|null|undefined} stream The candidate
 * stream; never dereferenced beyond reading its own `columns` property.
 * @returns {number} `stream.columns` when it is a finite positive number,
 * otherwise {@link FALLBACK_WIDTH}, clamped into `[MIN_WIDTH, MAX_WIDTH]`.
 */
function terminalWidth(stream) {
  return resolveDimension(stream && stream.columns, FALLBACK_WIDTH, MIN_WIDTH, MAX_WIDTH);
}

/**
 * Resolves the usable row count for an output stream.
 *
 * @param {NodeJS.WritableStream|null|undefined} stream The candidate
 * stream; never dereferenced beyond reading its own `rows` property.
 * @returns {number} `stream.rows` when it is a finite positive number,
 * otherwise {@link FALLBACK_ROWS}, clamped into `[MIN_ROWS, MAX_ROWS]`.
 */
function terminalRows(stream) {
  return resolveDimension(stream && stream.rows, FALLBACK_ROWS, MIN_ROWS, MAX_ROWS);
}

/**
 * Measures how many terminal columns a string occupies.
 *
 * ANSI escape sequences are stripped first, since they consume no column of
 * their own. What remains is counted one Unicode code point at a time
 * rather than one UTF-16 code unit at a time, so a surrogate pair (an
 * emoji, most astral characters) counts as a single column instead of two
 * — the property {@link truncate} relies on to never cut a pair in half.
 *
 * @param {string} text The text to measure.
 * @returns {number} The column count.
 */
function displayWidth(text) {
  const stripped = String(text).replace(ANSI_PATTERN, "");
  return Array.from(stripped).length;
}

/**
 * Cuts a string to a fixed number of display columns, appending a single
 * `"…"` when it had to be shortened.
 *
 * Operates on Unicode code points, not UTF-16 code units, so a surrogate
 * pair is always kept or dropped whole — the cut point falls between code
 * points, never inside one.
 *
 * @param {string} text The text to truncate.
 * @param {number} width The target column width.
 * @returns {string} `text` unchanged when it already fits; otherwise the
 * longest prefix that leaves room for the `"…"` marker, followed by it, so
 * the result occupies exactly `width` columns. `""` when `width <= 0`.
 */
function truncate(text, width) {
  if (width <= 0) return "";
  const str = String(text);
  if (displayWidth(str) <= width) return str;
  if (width === 1) return "…";
  const chars = Array.from(str);
  return `${chars.slice(0, width - 1).join("")}…`;
}

/**
 * Pads or truncates a string to an exact display width.
 *
 * @param {string} text The text to fit.
 * @param {number} width The target column width.
 * @returns {string} `text` truncated (see {@link truncate}) when too wide,
 * or right-padded with spaces when too narrow, so the result always
 * occupies exactly `width` columns (`""` when `width <= 0`).
 */
function padTo(text, width) {
  if (width <= 0) return "";
  const truncated = truncate(text, width);
  const gap = width - displayWidth(truncated);
  return gap > 0 ? truncated + " ".repeat(gap) : truncated;
}

/**
 * Word-wraps text to a fixed column width.
 *
 * Words are packed greedily, breaking to a new line before the word that
 * would overflow. A single word wider than the available width is never
 * left to overflow the line — it is hard-cut with {@link truncate} instead,
 * landing alone on its own line.
 *
 * @param {string} text The text to wrap. Internal whitespace runs collapse
 * to single spaces, matching how the words are re-joined line by line.
 * @param {number} width The column width, including any `options.indent`.
 * @param {{indent?: string}} [options] `indent`, when given, is prefixed to
 * every line after the first; its own display width is subtracted from the
 * budget for those lines, so the indented text still fits within `width`.
 * @returns {string[]} One entry per wrapped line. `[""]` for empty or
 * whitespace-only `text`.
 */
function wrap(text, width, options) {
  const indent = (options && options.indent) || "";
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];

  const indentWidth = displayWidth(indent);
  const lines = [];
  let current = "";

  const budgetFor = (lineIndex) => Math.max(1, width - (lineIndex > 0 ? indentWidth : 0));

  for (const word of words) {
    const lineIndex = lines.length;
    const budget = budgetFor(lineIndex);
    const candidate = current ? `${current} ${word}` : word;

    if (displayWidth(candidate) <= budget) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
      current = "";
    }

    // Re-evaluate the budget: starting a fresh line may have moved us past
    // the first line, which changes whether `indent` now applies.
    const freshBudget = budgetFor(lines.length);
    if (displayWidth(word) <= freshBudget) {
      current = word;
    } else {
      // The word alone is wider than even an empty line can hold — hard-break
      // it rather than let it overflow.
      lines.push(truncate(word, freshBudget));
    }
  }
  if (current) lines.push(current);

  return lines.map((line, i) => (i === 0 ? line : `${indent}${line}`));
}

/**
 * Lays out one row of aligned, fixed-width cells within a total column
 * budget, so the joined result is never wider than `width`.
 *
 * @param {{text: string, width?: number, grow?: boolean}[]} cells The row's
 * cells, left to right. `width` fixes a cell's column count; `grow: true`
 * marks the one cell (at most — a second `grow` cell falls back to its own
 * `width`, or `0`) that absorbs whatever width remains after every fixed
 * cell and every separator has been accounted for.
 * @param {number} width The total column budget for the joined row.
 * @param {{separator?: string}} [options] `separator` is written between
 * consecutive cells; defaults to two spaces.
 * @returns {string} The joined row, each cell padded or truncated to its
 * resolved width, truncated as a whole to `width` as a final safeguard.
 */
function fitRow(cells, width, options) {
  const separator = (options && options.separator) !== undefined ? options.separator : "  ";
  const separatorWidth = displayWidth(separator);
  const list = Array.isArray(cells) ? cells : [];

  const separatorsTotal = list.length > 1 ? separatorWidth * (list.length - 1) : 0;
  const fixedTotal = list.reduce((sum, cell) => (cell.grow ? sum : sum + Math.max(0, Number(cell.width) || 0)), 0);
  const remaining = width - separatorsTotal - fixedTotal;

  let growAssigned = false;
  const resolvedWidths = list.map((cell) => {
    if (cell.grow && !growAssigned) {
      growAssigned = true;
      return Math.max(0, remaining);
    }
    return Math.max(0, Number(cell.width) || 0);
  });

  const rendered = list.map((cell, i) => padTo(cell.text, resolvedWidths[i]));
  return truncate(rendered.join(separator), width);
}

/**
 * Decides whether both ends of a prompt support raw-mode, escape-sequence
 * driven rendering.
 *
 * Deliberately stricter than checking `input` alone: rich mode writes
 * cursor-movement and clear sequences to `output`, which are only safe when
 * `output` is itself a real terminal — with stdout redirected to a pipe or
 * file, those sequences would be written into it as literal bytes.
 *
 * @param {NodeJS.ReadStream|null|undefined} input The candidate input
 * stream.
 * @param {NodeJS.WritableStream|null|undefined} output The candidate output
 * stream.
 * @returns {boolean} `true` only when `input.isTTY`, `output.isTTY`, and
 * `input.setRawMode` is a function.
 */
function isInteractive(input, output) {
  return !!(input && output && input.isTTY && output.isTTY && typeof input.setRawMode === "function");
}

module.exports = {
  MIN_WIDTH,
  MAX_WIDTH,
  FALLBACK_WIDTH,
  terminalWidth,
  terminalRows,
  displayWidth,
  truncate,
  padTo,
  wrap,
  fitRow,
  isInteractive,
};
