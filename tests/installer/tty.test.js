"use strict";

/**
 * Drives `core/installer/tty.js` directly — pure functions over plain
 * numbers and strings, so no fake stream or event loop is needed beyond a
 * couple of plain objects standing in for `NodeJS.ReadStream`/`WritableStream`
 * for {@link isInteractive}'s own checks.
 */

const { suite } = require("../harness");
const tty = require("../../core/installer/tty");
const { MIN_WIDTH, MAX_WIDTH, FALLBACK_WIDTH, terminalWidth, terminalRows, displayWidth, truncate, padTo, wrap, fitRow, isInteractive } = tty;

/** An ANSI red-on/off pair, standing in for a colour sequence surrounding visible text. */
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

suite("installer/tty", ({ test, eq, deepEq, ok }) => {
  test("terminalWidth: a real, in-range number passes through unchanged", () => {
    eq(terminalWidth({ columns: 100 }), 100);
  });

  test("terminalWidth: a missing columns property falls back", () => {
    eq(terminalWidth({}), FALLBACK_WIDTH);
  });

  test("terminalWidth: zero falls back rather than clamping to MIN_WIDTH", () => {
    eq(terminalWidth({ columns: 0 }), FALLBACK_WIDTH);
  });

  test("terminalWidth: NaN falls back", () => {
    eq(terminalWidth({ columns: NaN }), FALLBACK_WIDTH);
  });

  test("terminalWidth: Infinity falls back rather than clamping to MAX_WIDTH", () => {
    eq(terminalWidth({ columns: Infinity }), FALLBACK_WIDTH);
  });

  test("terminalWidth: a huge value clamps down to MAX_WIDTH", () => {
    eq(terminalWidth({ columns: 500 }), MAX_WIDTH);
  });

  test("terminalWidth: a tiny value clamps up to MIN_WIDTH", () => {
    eq(terminalWidth({ columns: 5 }), MIN_WIDTH);
  });

  test("terminalWidth: null and undefined streams never throw and fall back", () => {
    eq(terminalWidth(null), FALLBACK_WIDTH);
    eq(terminalWidth(undefined), FALLBACK_WIDTH);
  });

  test("terminalRows: a real number passes through, missing falls back to 24, and out-of-range values clamp to [10, 60]", () => {
    eq(terminalRows({ rows: 30 }), 30);
    eq(terminalRows({}), 24);
    eq(terminalRows({ rows: 1 }), 10);
    eq(terminalRows({ rows: 999 }), 60);
    eq(terminalRows(null), 24);
  });

  test("displayWidth: plain text counts one column per character", () => {
    eq(displayWidth("hello"), 5);
  });

  test("displayWidth: an ANSI colour sequence contributes no columns", () => {
    eq(displayWidth(`${RED}hello${RESET}`), 5);
  });

  test("displayWidth: a surrogate-pair emoji counts as a single column", () => {
    const emoji = "\u{1F600}"; // grinning face, a surrogate pair in UTF-16
    eq(emoji.length, 2, "sanity check: the emoji is two UTF-16 code units");
    eq(displayWidth(emoji), 1);
    eq(displayWidth(`ab${emoji}cd`), 5);
  });

  test("truncate: exactly at the boundary is returned unchanged", () => {
    eq(truncate("hello", 5), "hello");
  });

  test("truncate: one over the boundary cuts to width - 1 columns plus the ellipsis", () => {
    eq(truncate("hello!", 5), "hell…");
    eq(displayWidth(truncate("hello!", 5)), 5);
  });

  test("truncate: width 0 returns an empty string", () => {
    eq(truncate("hello", 0), "");
  });

  test("truncate: width 1 returns a lone ellipsis", () => {
    eq(truncate("hello", 1), "…");
  });

  test("truncate: a surrogate pair right at the cut point is kept whole, never split", () => {
    const emoji = "\u{1F600}";
    const text = `abc${emoji}def`; // "abc" + emoji + "def", 7 display columns
    const result = truncate(text, 4);
    const points = Array.from(result);
    // The emoji code point must appear whole, or not at all — never as one
    // half of its surrogate pair leaking through as an unpaired code unit.
    ok(
      points.every((cp) => cp !== emoji[0] && cp !== emoji[1]),
      `expected no lone surrogate half in ${JSON.stringify(result)}`,
    );
    eq(displayWidth(result), 4);
    ok(result.endsWith("…"), `expected a truncated result to end in an ellipsis, got ${JSON.stringify(result)}`);
  });

  test("padTo: pads a short string with trailing spaces to exactly the requested width", () => {
    eq(padTo("hi", 5), "hi   ");
    eq(displayWidth(padTo("hi", 5)), 5);
  });

  test("padTo: truncates a long string down to exactly the requested width", () => {
    eq(padTo("hello world", 5), "hell…");
    eq(displayWidth(padTo("hello world", 5)), 5);
  });

  test("padTo: the result is always exactly the requested width, both directions", () => {
    for (const [text, width] of [["", 6], ["exact", 5], ["way too long for this", 8], ["x", 1]]) {
      eq(displayWidth(padTo(text, width)), width, `padTo(${JSON.stringify(text)}, ${width})`);
    }
  });

  test("wrap: a paragraph packs words greedily within the width", () => {
    const lines = wrap("the quick brown fox jumps over the lazy dog", 12);
    ok(lines.every((l) => displayWidth(l) <= 12), `every line must fit within 12 columns, got: ${JSON.stringify(lines)}`);
    eq(lines.join(" ").replace(/\s+/g, " "), "the quick brown fox jumps over the lazy dog");
  });

  test("wrap: indent applies only from the second line on, and its width counts against the budget", () => {
    const lines = wrap("alpha beta gamma delta epsilon", 12, { indent: "  " });
    eq(lines[0].startsWith("  "), false, "the first line must not carry the indent");
    for (let i = 1; i < lines.length; i += 1) {
      ok(lines[i].startsWith("  "), `line ${i} must carry the indent, got ${JSON.stringify(lines[i])}`);
      ok(displayWidth(lines[i]) <= 12, `line ${i} must still fit within width including its indent, got ${JSON.stringify(lines[i])}`);
    }
  });

  test("wrap: a single word longer than the width is hard-broken with truncate rather than left to overflow", () => {
    const lines = wrap("supercalifragilisticexpialidocious", 10);
    ok(lines.every((l) => displayWidth(l) <= 10), `every line must fit within 10 columns, got: ${JSON.stringify(lines)}`);
    ok(lines[0].endsWith("…"), `the overlong word must be truncated with an ellipsis, got ${JSON.stringify(lines)}`);
  });

  test("wrap: an empty or whitespace-only string returns a single empty line", () => {
    deepEq(wrap("", 10), [""]);
    deepEq(wrap("   ", 10), [""]);
  });

  test("fitRow: fixed cells only, joined with the default two-space separator", () => {
    const row = fitRow([{ text: "a", width: 3 }, { text: "b", width: 3 }], 20);
    eq(row, "a    b  ");
  });

  test("fitRow: one growing cell absorbs the remaining width after fixed cells and separators", () => {
    const row = fitRow([{ text: "left", width: 6 }, { text: "fill", grow: true }], 20);
    // 6 (fixed) + 2 (separator) + grow width = 20 -> grow width = 12.
    eq(displayWidth(row), 20);
    ok(row.startsWith(padTo("left", 6)), `expected the fixed cell to render at its own width, got ${JSON.stringify(row)}`);
  });

  test("fitRow: fixed cells that already overflow the row collapse the growing cell to zero and truncate the whole row", () => {
    const row = fitRow([{ text: "way too wide for this row", width: 30 }, { text: "grows", grow: true }], 10);
    eq(displayWidth(row), 10);
    ok(row.endsWith("…"), `expected the overflowing row to be truncated, got ${JSON.stringify(row)}`);
  });

  test("fitRow: the returned row is never wider than the requested width, across many random-ish inputs", () => {
    const words = ["a", "bb", "ccc", "dddd", "eeeeeeeeeeee", "f", "gg-gg-gg-gg-gg-gg", "", "h"];
    let seed = 7;
    /** A small deterministic PRNG so the sweep is reproducible without pulling in a real one. */
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 200; i += 1) {
      const width = 1 + (next() % 40);
      const cellCount = 1 + (next() % 4);
      const growAt = next() % (cellCount + 1); // cellCount means "no growing cell"
      const cells = [];
      for (let c = 0; c < cellCount; c += 1) {
        const text = words[next() % words.length];
        if (c === growAt) cells.push({ text, grow: true });
        else cells.push({ text, width: next() % 10 });
      }
      const row = fitRow(cells, width);
      ok(displayWidth(row) <= width, `fitRow overflowed: width=${width} cells=${JSON.stringify(cells)} row=${JSON.stringify(row)}`);
    }
  });

  test("isInteractive: true only when both streams are TTYs and setRawMode is a function", () => {
    const tty1 = { isTTY: true, setRawMode: () => {} };
    const tty2 = { isTTY: true };
    const notTty = { isTTY: false, setRawMode: () => {} };
    ok(isInteractive(tty1, tty1), "both TTY with setRawMode must be interactive");
    ok(!isInteractive(tty1, notTty), "a non-TTY output must not be interactive");
    ok(!isInteractive(notTty, tty1), "a non-TTY input must not be interactive");
    ok(!isInteractive(tty2, tty1), "a missing setRawMode on the input must not be interactive");
    ok(!isInteractive(notTty, notTty), "neither TTY must not be interactive");
  });

  test("isInteractive: never throws for null or undefined streams", () => {
    eq(isInteractive(null, null), false);
    eq(isInteractive(undefined, undefined), false);
    eq(isInteractive(null, { isTTY: true, setRawMode: () => {} }), false);
    eq(isInteractive({ isTTY: true, setRawMode: () => {} }, null), false);
  });
});
