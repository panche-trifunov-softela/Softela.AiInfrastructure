"use strict";

/**
 * Drives `core/installer/prompt.js` directly, against fake `input`/`output`
 * streams — never the real CLI — so every branch of both interaction modes
 * is exercised without a real terminal.
 *
 * Rich mode needs a stream that looks enough like a TTY for
 * `readline.emitKeypressEvents` to attach to (`isTTY`, `setRawMode`, and an
 * `EventEmitter`'s `on`/`removeListener`/`emit`); {@link FakeTTYInput}
 * provides that and records every `setRawMode` call so a test can assert
 * raw mode was restored on every exit path. {@link fakeOutput} matches it on
 * the output side — `isTTY` (settable, defaulted `true` so a bare
 * `fakeOutput()` still activates rich mode the way a real terminal pair
 * would) plus settable `columns`/`rows`, since `core/installer/tty.js`
 * resolves width and viewport size from exactly those two stream
 * properties. Line mode instead needs a real `Readable`, since
 * `selectOneCallback`/`selectManyCallback` open their own
 * `readline.Interface` on it when no `rl` is supplied; a `stream.PassThrough`
 * covers that.
 *
 * Every rich-mode assertion in this file drives its prompt through the
 * plain, synchronous `selectOneCallback`/`selectManyCallback` API and reads
 * the outcome from a variable the callback closes over, never through
 * `await`-ing `selectOne`/`selectMany`'s `Promise`. That is not a style
 * preference: `tests/harness.js`'s `test()` calls `testFn()` and records
 * `pass: true` the instant that call *returns* — and calling an `async`
 * function always returns immediately (a pending `Promise`), regardless of
 * where inside it a `throw` or an `await` sits, so nothing after the first
 * `await` in an `async` test body is ever actually checked by this harness.
 * A raw `FakeTTYInput` delivers every keypress synchronously (it is a plain
 * `EventEmitter`, not real stream I/O), so driving a prompt with the
 * callback API and asserting on the closed-over result immediately
 * afterwards runs for real, inside `test()`'s own `try`/`catch`. The one
 * exception is a bare Escape key: Node's own `readline` keypress parser
 * cannot tell a standalone Escape from the start of a longer escape sequence
 * without waiting out its own internal disambiguation timer, which needs a
 * real `setTimeout`, which this harness cannot usefully await either — those
 * few cases keep the pre-existing `async`/`waitForEscapeTimeout()` shape
 * used elsewhere in this file, matching its own prior art, with the
 * caveat that (like every other `await`-based assertion here) they do not
 * currently fail the suite if the code regresses.
 *
 * The catalogue-loading test at the bottom drives `index.js`'s own
 * `loadReplyLanguageCatalogue` directly instead — a plain, exported pure
 * function, not a prompting concern, but the degrade-to-free-text guarantee
 * it backs belongs next to the rest of this reconfigured `languages`
 * question's coverage.
 */

const fs = require("fs");
const path = require("path");
const { PassThrough } = require("stream");
const { EventEmitter } = require("events");
const { suite } = require("../harness");
const promptModule = require("../../core/installer/prompt");
const { selectOne, selectMany, selectOneCallback, selectManyCallback, CANCELLED, ABORTED } = promptModule;
const tty = require("../../core/installer/tty");
const { loadReplyLanguageCatalogue } = require("../../core/installer/index.js");

/**
 * A minimal fake TTY input stream: an `EventEmitter` `readline.emitKeypressEvents`
 * can attach `'data'`/`'keypress'` listeners to, with `isTTY` and
 * `setRawMode` so rich mode activates.
 */
class FakeTTYInput extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.rawModeCalls = [];
  }

  /**
   * Records a raw-mode toggle, matching the real `tty.ReadStream` API
   * `prompt.js` calls at the start and end of every rich-mode prompt.
   *
   * @param {boolean} enabled The requested raw-mode state.
   * @returns {FakeTTYInput} `this`, matching the real API's chaining.
   */
  setRawMode(enabled) {
    this.rawModeCalls.push(enabled);
    return this;
  }
}

/**
 * Builds a fake output stream that records every written chunk and mimics
 * the handful of `tty.WriteStream` properties `core/installer/tty.js`
 * reads: `isTTY` (defaulted `true`), and settable `columns`/`rows` a test
 * assigns before starting a prompt to drive width/viewport behaviour.
 *
 * @returns {{chunks: string[], isTTY: boolean, columns: (number|undefined),
 * rows: (number|undefined), write: (s: string) => boolean, text: () => string}}
 * `text()` joins every chunk written so far, for a substring assertion.
 */
function fakeOutput() {
  const chunks = [];
  return {
    chunks,
    isTTY: true,
    columns: undefined,
    rows: undefined,
    write(s) {
      chunks.push(String(s));
      return true;
    },
    text() {
      return chunks.join("");
    },
  };
}

/**
 * Sends one keypress to a {@link FakeTTYInput} as raw bytes, exactly the way
 * a real terminal delivers a keystroke, so `readline.emitKeypressEvents`'s
 * own parsing (not a hand-built key object) is what every rich-mode test
 * exercises.
 *
 * @param {FakeTTYInput} input The fake input.
 * @param {string} bytes The raw byte sequence (e.g. `"\x1b[B"` for Down).
 * @returns {void}
 */
function sendKey(input, bytes) {
  input.emit("data", Buffer.from(bytes, "binary"));
}

const KEY = {
  UP: "\x1b[A",
  DOWN: "\x1b[B",
  HOME: "\x1b[H",
  END: "\x1b[F",
  PAGE_UP: "\x1b[5~",
  PAGE_DOWN: "\x1b[6~",
  ENTER: "\r",
  SPACE: " ",
  BACKSPACE: "\x7f",
  ESCAPE: "\x1b",
  CTRL_C: "\x03",
};

/** Waits for Node's own escape-sequence disambiguation timeout to elapse, so a bare Escape is recognised rather than held pending a possible continuation. */
function waitForEscapeTimeout() {
  return new Promise((resolve) => setTimeout(resolve, 700));
}

/**
 * The chunks {@link fakeOutput} recorded that carry real frame content, as
 * opposed to the raw ANSI plumbing (cursor hide/show, `eraseLines`'s own
 * move/clear sequences) `draw()`'s single `output.write(lines.join("\n"))`
 * call never shares a chunk with — every one of *those* chunks begins with
 * an escape byte, every content chunk begins with real text.
 *
 * @param {{chunks: string[]}} output A {@link fakeOutput}.
 * @returns {string[]} The content-only chunks, in write order.
 */
function contentChunks(output) {
  return output.chunks.filter((c) => !c.startsWith("\x1b"));
}

/**
 * The most recently written frame's content, for asserting on the state a
 * developer would currently see on screen.
 *
 * @param {{chunks: string[]}} output A {@link fakeOutput}.
 * @returns {string} The last content chunk, or `""` if none was written yet.
 */
function lastFrame(output) {
  const chunks = contentChunks(output);
  return chunks.length ? chunks[chunks.length - 1] : "";
}

/**
 * Asserts that no line in any content chunk an {@link fakeOutput} recorded
 * exceeds a column width — the width invariant the whole rich-mode rewrite
 * exists to guarantee.
 *
 * @param {{chunks: string[]}} output A {@link fakeOutput} a prompt already
 * ran against.
 * @param {number} width The width every line must fit within.
 * @param {(ctx: object) => void} ok The harness's own assertion helper.
 * @param {string} context A label prefixed to any failure message.
 * @returns {void}
 */
function assertNoLineExceedsWidth(output, width, ok, context) {
  for (const chunk of contentChunks(output)) {
    for (const line of chunk.split("\n")) {
      const measured = tty.displayWidth(line);
      ok(measured <= width, `${context}: a line is ${measured} columns wide, over the ${width}-column limit: "${line}"`);
    }
  }
}

/**
 * Loads the real module catalogue's `{value, label, hint}` choices exactly
 * as `core/installer/index.js` builds them for the module-selection prompt
 * — the actual data that measured 138 to 151 characters per rendered line
 * under the old renderer.
 *
 * @returns {{value: string, label: string, hint: string}[]} One entry per
 * `modules/*` directory carrying a `module.json`.
 */
function loadRealModuleChoices() {
  const modulesDir = path.join(__dirname, "..", "..", "modules");
  return fs
    .readdirSync(modulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(modulesDir, entry.name, "module.json")))
    .map((entry) => {
      const json = JSON.parse(fs.readFileSync(path.join(modulesDir, entry.name, "module.json"), "utf8"));
      return { value: json.id, label: json.title, hint: json.summary };
    });
}

const LOCATION_CHOICES = [
  { value: "repo", label: "repo", hint: "inside the product repository" },
  { value: "infrastructure", label: "infrastructure", hint: "a per-project folder" },
  { value: "global", label: "global", hint: "the agent's own memory directory" },
];

const LANGUAGE_CHOICES = [
  { value: "en", label: "English" },
  { value: "de", label: "German" },
  { value: "fr", label: "French" },
  { value: "es", label: "Spanish" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "nl", label: "Dutch" },
  { value: "pl", label: "Polish" },
  { value: "sv", label: "Swedish" },
];

/** A 12-entry list, longer than any viewport this file forces, for scrolling/digit-jump/Home-End-PageUp-PageDown coverage. */
const ITEM_CHOICES = Array.from({ length: 12 }, (_, i) => ({ value: `i${i + 1}`, label: `Item ${i + 1}` }));

/** A 20-entry list, well above {@link FILTER_THRESHOLD}, for legend-fitting coverage of a filterable multi-select. */
const WIDE_CHOICES = Array.from({ length: 20 }, (_, i) => ({ value: `w${i + 1}`, label: `Language ${i + 1}` }));

/**
 * Reads the key legend — always a frame's last line — out of the most
 * recently written content chunk.
 *
 * @param {{chunks: string[]}} output A {@link fakeOutput} a prompt already
 * drew at least one frame to.
 * @returns {string} The legend line, with no trailing newline.
 */
function lastLegend(output) {
  const frame = lastFrame(output).replace(/\n+$/, "");
  const lines = frame.split("\n");
  return lines[lines.length - 1];
}

/**
 * Builds a title of an exact character count out of short, space-separated
 * words, so a wrap test can assert on a known, reproducible length instead
 * of an approximate one.
 *
 * @param {number} wordCount How many words to generate.
 * @param {number} wordLength Each word's own character count.
 * @returns {string} The words joined with single spaces; its total length is
 * `wordCount * wordLength + (wordCount - 1)`.
 */
function makeWordTitle(wordCount, wordLength) {
  const words = [];
  for (let i = 0; i < wordCount; i += 1) words.push(String(i % 10).repeat(wordLength));
  return words.join(" ");
}

/** A 300-character title (43 six-character words, single-space separated) for the title-wrapping coverage below. */
const LONG_TITLE = makeWordTitle(43, 6);

/**
 * Splits a rendered rich-mode frame into its choice-row lines only, dropping
 * the title, the multi-select summary, the filter line, the scroll
 * indicators and the trailing legend — the lines a per-entry grouping (see
 * {@link groupEntryLines}) has to reason about.
 *
 * A row's first line is told apart from one of its own continuation lines by
 * the number cell alone: `marker(1) + sep(2)` puts the number cell at
 * `[3, 5)`, and only a first line carries a real `"N)"` there — a
 * continuation line's number cell is blank, padded to two spaces — a
 * distinction that holds regardless of the marker glyph (which is a space on
 * every non-highlighted row, first line or not) or the label column's
 * width.
 *
 * @param {string} frame A frame as {@link lastFrame} returns it.
 * @param {(ctx: object) => void} ok The harness's own assertion helper, used
 * to fail loudly if no choice row can be found at all.
 * @returns {string[]} The choice-row lines, in on-screen order.
 */
function extractEntryBlockLines(frame, ok) {
  const lines = frame.replace(/\n+$/, "").split("\n");
  const body = lines.slice(0, -1); // drop the trailing legend line
  const isFirstLine = (line) => /^[0-9]\)$/.test(line.slice(3, 5));
  const start = body.findIndex(isFirstLine);
  ok(start >= 0, `expected at least one choice row, found none in:\n${frame}`);
  return body.slice(start).filter((line) => !/^ {2}[↑↓] \d+ more$/.test(line));
}

/**
 * Groups a choice block's lines (see {@link extractEntryBlockLines}) back
 * into one array per rendered entry — a first line starts a new group, every
 * line after it until the next first line belongs to the same entry's
 * wrapped hint.
 *
 * @param {string[]} entryBlockLines The lines {@link extractEntryBlockLines}
 * returned.
 * @returns {string[][]} One entry per visible choice, in on-screen order.
 */
function groupEntryLines(entryBlockLines) {
  const groups = [];
  for (const line of entryBlockLines) {
    if (/^[0-9]\)$/.test(line.slice(3, 5))) groups.push([line]);
    else groups[groups.length - 1].push(line);
  }
  return groups;
}

/**
 * Asserts that a wrapped choice's continuation lines start their own hint
 * text at exactly the same column its first line did — the "aligned under
 * the hint column" requirement — locating that column empirically from the
 * hint's own first word rather than by recomputing the label column's width.
 *
 * @param {string[]} entryLines One entry's own rendered lines, from {@link
 * groupEntryLines}.
 * @param {string} hint The choice's own hint text, unwrapped.
 * @param {(ctx: object) => void} ok The harness's own assertion helper.
 * @param {string} context A label prefixed to any failure message.
 * @returns {void}
 */
function assertHintColumnAligned(entryLines, hint, ok, context) {
  if (entryLines.length < 2) return; // nothing wrapped, nothing to check
  const firstWord = hint.trim().split(/\s+/)[0];
  const hintStart = entryLines[0].indexOf(firstWord);
  ok(hintStart >= 0, `${context}: could not locate the hint's own first word "${firstWord}" on its first line: "${entryLines[0]}"`);
  for (let i = 1; i < entryLines.length; i += 1) {
    const line = entryLines[i];
    const prefix = line.slice(0, hintStart);
    ok(
      prefix === " ".repeat(hintStart) && line.length > hintStart,
      `${context}: continuation line is not aligned under the hint column (expected ${hintStart} leading spaces before non-blank hint text), got: "${line}"`,
    );
  }
}

suite("installer/prompt", ({ test, eq, deepEq, ok, tmpdir, fixture }) => {
  test("rich selectOne: Down, Down, Enter selects the third entry", () => {
    const input = new FakeTTYInput();
    const output = fakeOutput();
    let reported = null;
    selectOneCallback({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "repo", input, output }, (r) => {
      reported = r;
    });
    sendKey(input, KEY.DOWN);
    sendKey(input, KEY.DOWN);
    sendKey(input, KEY.ENTER);
    ok(reported, "expected the callback to have fired synchronously");
    eq(reported.value, "global");
  });

  test("rich selectOne: Up from the first entry wraps to the last", () => {
    const input = new FakeTTYInput();
    const output = fakeOutput();
    let reported = null;
    selectOneCallback({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "repo", input, output }, (r) => {
      reported = r;
    });
    sendKey(input, KEY.UP);
    sendKey(input, KEY.ENTER);
    eq(reported.value, "global");
  });

  test("rich selectOne: a digit key jumps straight to that entry", () => {
    const input = new FakeTTYInput();
    const output = fakeOutput();
    let reported = null;
    selectOneCallback({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "repo", input, output }, (r) => {
      reported = r;
    });
    sendKey(input, "2");
    sendKey(input, KEY.ENTER);
    eq(reported.value, "infrastructure");
  });

  test("rich selectOne: Enter with no movement takes the default", () => {
    const input = new FakeTTYInput();
    const output = fakeOutput();
    let reported = null;
    selectOneCallback({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "infrastructure", input, output }, (r) => {
      reported = r;
    });
    sendKey(input, KEY.ENTER);
    eq(reported.value, "infrastructure");
  });

  test("rich selectOne: the default entry renders labelled (default), single-select only", () => {
    const input = new FakeTTYInput();
    const output = fakeOutput();
    let reported = null;
    selectOneCallback({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "global", input, output }, (r) => {
      reported = r;
    });
    ok(output.text().includes("global"), `expected the choice list to render, got:\n${output.text()}`);
    ok(/global.*\(default\)/.test(output.text()), `expected "global" to carry a "(default)" marker, got:\n${output.text()}`);
    sendKey(input, KEY.ENTER);
    ok(reported && reported.cancelled === false);
  });

  test("rich selectMany: multi-select never renders a (default) suffix — the checkbox already carries that state", () => {
    const input = new FakeTTYInput();
    const output = fakeOutput();
    selectManyCallback({ title: "Languages?", choices: LANGUAGE_CHOICES.slice(0, 3), defaultValues: ["de"], input, output }, () => {});
    ok(!output.text().includes("(default)"), `multi-select must not render "(default)", got:\n${output.text()}`);
  });

  test("rich selectMany: Space toggles, Enter confirms, result is in selection order", () => {
    const input = new FakeTTYInput();
    const output = fakeOutput();
    const choices = LANGUAGE_CHOICES.slice(0, 3); // en, de, fr
    let reported = null;
    selectManyCallback({ title: "Languages?", choices, defaultValues: [], input, output }, (r) => {
      reported = r;
    });
    sendKey(input, KEY.DOWN); // highlight German
    sendKey(input, KEY.SPACE); // pick German first
    sendKey(input, KEY.DOWN); // highlight French
    sendKey(input, KEY.SPACE); // pick French second
    sendKey(input, KEY.UP);
    sendKey(input, KEY.UP); // highlight English
    sendKey(input, KEY.SPACE); // pick English third
    sendKey(input, KEY.ENTER);
    deepEq(reported.values, ["de", "fr", "en"], "selection order must be preserved, not catalogue order");
  });

  test("rich selectMany: 'a' selects every entry currently in view, 'n' clears them, both in catalogue order", () => {
    const input = new FakeTTYInput();
    const output = fakeOutput();
    const choices = LANGUAGE_CHOICES.slice(0, 4); // en, de, fr, es
    let reported = null;
    selectManyCallback({ title: "Languages?", choices, defaultValues: [], input, output }, (r) => {
      reported = r;
    });
    sendKey(input, "a");
    sendKey(input, KEY.ENTER);
    deepEq(reported.values, ["en", "de", "fr", "es"]);

    const input2 = new FakeTTYInput();
    const output2 = fakeOutput();
    let reported2 = null;
    selectManyCallback({ title: "Languages?", choices, defaultValues: ["en", "de", "fr", "es"], input: input2, output: output2 }, (r) => {
      reported2 = r;
    });
    sendKey(input2, "n");
    sendKey(input2, KEY.ENTER);
    deepEq(reported2.values, []);
  });

  test("rich selectMany: pressing / enters filter mode; typing narrows the list; Backspace widens it", () => {
    const input = new FakeTTYInput();
    const output = fakeOutput();
    let reported = null;
    selectManyCallback({ title: "Languages?", choices: LANGUAGE_CHOICES, defaultValues: [], input, output }, (r) => {
      reported = r;
    });

    sendKey(input, "/"); // enter filter mode
    ok(lastFrame(output).includes("Filter:"), `expected a Filter line once filter mode is entered, got:\n${lastFrame(output)}`);

    sendKey(input, "g"); // narrows to English and German (both contain "g")
    let frame = lastFrame(output);
    ok(frame.includes("German"), `expected "German" to remain visible after filtering to "g", got:\n${frame}`);
    ok(frame.includes("English"), `expected "English" to also match "g" (it contains the letter), got:\n${frame}`);
    ok(!frame.includes("French"), `expected "French" to be filtered out once narrowed to "g", got:\n${frame}`);

    sendKey(input, KEY.BACKSPACE); // widen the filter back out to everything
    frame = lastFrame(output);
    ok(frame.includes("French"), `expected the list to widen again after Backspace, got:\n${frame}`);

    sendKey(input, "g"); // narrow to English/German again
    ok(!reported, "the prompt must still be pending while filtering, not resolved by a filter keystroke");
  });

  // A bare Escape cannot be recognised without Node's own readline waiting
  // out its escape-sequence disambiguation timer first — see this file's own
  // module doc for why that forces the `async`/`waitForEscapeTimeout()` shape
  // here (and why the assertion after it is not currently enforced by this
  // harness either way).
  test("rich selectMany: Escape leaves filter mode without cancelling the prompt, preserving the highlighted value so Space still toggles the right entry", async () => {
    const input = new FakeTTYInput();
    const output = fakeOutput();
    let reported = null;
    selectManyCallback({ title: "Languages?", choices: LANGUAGE_CHOICES, defaultValues: [], input, output }, (r) => {
      reported = r;
    });

    sendKey(input, "/");
    sendKey(input, "g"); // narrows to English/German; highlight starts on English (the first match)
    sendKey(input, KEY.DOWN); // move the highlight onto German within the filtered list
    sendKey(input, KEY.ESCAPE); // leave filter mode without cancelling
    await waitForEscapeTimeout();

    ok(!reported, "Escape inside filter mode must leave filter mode, not cancel the whole prompt");
    const frame = lastFrame(output);
    ok(!frame.includes("Filter:"), `expected filter mode to have ended, got:\n${frame}`);
    ok(frame.includes("Portuguese"), `expected the full, unfiltered list back after leaving filter mode, got:\n${frame}`);

    sendKey(input, KEY.SPACE); // now outside filter mode: toggles the highlighted entry, which must still be German
    sendKey(input, KEY.ENTER);
    deepEq(reported.values, ["de"], "the highlighted value must survive leaving filter mode, not reset to the first entry");
  });

  test("rich selectMany: a digit typed inside filter mode filters instead of jumping", () => {
    const input = new FakeTTYInput();
    const output = fakeOutput();
    // 12 entries so the list is filterable; label text carries digits so a
    // typed "1" is a meaningful, deterministic filter.
    let reported = null;
    selectManyCallback({ title: "Pick", choices: ITEM_CHOICES, defaultValues: [], input, output }, (r) => {
      reported = r;
    });

    sendKey(input, "/");
    sendKey(input, "1"); // must filter to "Item 1", "Item 10", "Item 11", "Item 12" — never jump to visible row 1
    ok(!reported, "a digit inside filter mode must not confirm or jump, only filter");
    const frame = lastFrame(output);
    ok(frame.includes("Filter: 1"), `expected the typed digit to appear as filter text, got:\n${frame}`);
    ok(!frame.includes("Item 2"), `expected "Item 2" to be filtered out by "1", got:\n${frame}`);
  });

  test("rich selectOne: digit jump addresses the entry visible at that on-screen position, not an absolute catalogue index — even once the list has scrolled", () => {
    const input = new FakeTTYInput();
    const output = fakeOutput();
    output.rows = 10; // terminalRows() floors at 10, giving a 6-entry viewport here (10 - 4 reserved rows)
    let reported = null;
    selectOneCallback({ title: "Pick", choices: ITEM_CHOICES, defaultValue: "i1", input, output }, (r) => {
      reported = r;
    });

    for (let i = 0; i < 7; i += 1) sendKey(input, KEY.DOWN); // highlight on "i8"; viewport scrolled to show i3..i8
    ok(lastFrame(output).includes("Item 3") && lastFrame(output).includes("Item 8"), `expected the viewport to have scrolled to show items 3-8, got:\n${lastFrame(output)}`);

    sendKey(input, "1"); // the first VISIBLE row right now is "Item 3", not "Item 1"
    sendKey(input, KEY.ENTER);
    eq(reported.value, "i3", "digit 1 must select whatever is rendered as row 1 right now, not catalogue entry 1");
  });

  test("rich selectOne: Home/End/PageUp/PageDown navigate as expected", () => {
    const run = (keys) => {
      const input = new FakeTTYInput();
      const output = fakeOutput();
      output.rows = 10; // same 6-entry viewport as above, so PageUp/PageDown move by 6
      let reported = null;
      selectOneCallback({ title: "Pick", choices: ITEM_CHOICES, defaultValue: "i1", input, output }, (r) => {
        reported = r;
      });
      for (const k of keys) sendKey(input, k);
      sendKey(input, KEY.ENTER);
      return reported.value;
    };

    eq(run([KEY.END]), "i12", "End must jump to the last entry");
    eq(run([KEY.END, KEY.HOME]), "i1", "Home must jump back to the first entry");
    eq(run([KEY.PAGE_DOWN]), "i7", "PageDown must move by one viewport (6 entries here)");
    eq(run([KEY.PAGE_DOWN, KEY.PAGE_UP]), "i1", "PageUp must move back by one viewport");
  });

  test("rich mode: the scrolling viewport shows '↓ N more' and '↑ N more' as the highlight moves off-screen in either direction, and following it wraps cleanly", () => {
    const input = new FakeTTYInput();
    const output = fakeOutput();
    output.rows = 10; // 6-entry viewport out of 12 entries
    selectOneCallback({ title: "Pick", choices: ITEM_CHOICES, defaultValue: "i1", input, output }, () => {});

    let frame = lastFrame(output);
    ok(!/↑ \d+ more/.test(frame), `expected no "more above" indicator at the top of the list, got:\n${frame}`);
    ok(frame.includes("↓ 6 more"), `expected "6 more" below (12 - 6 visible), got:\n${frame}`);

    for (let i = 0; i < 6; i += 1) sendKey(input, KEY.DOWN); // highlight at i7, scrolled down by one row
    frame = lastFrame(output);
    ok(/↑ \d+ more/.test(frame), `expected a "more above" indicator once scrolled down, got:\n${frame}`);

    for (let i = 0; i < 6; i += 1) sendKey(input, KEY.DOWN); // 12 downs total wraps exactly back to the first entry
    frame = lastFrame(output);
    ok(!/↑ \d+ more/.test(frame), `expected the viewport to follow the wrap back to the top, got:\n${frame}`);
    ok(frame.includes("↓ 6 more"), `expected the "more below" count to reset after wrapping, got:\n${frame}`);
  });

  test("rich mode: the key legend names the keys that actually work in the current mode", () => {
    const singleInput = new FakeTTYInput();
    const singleOutput = fakeOutput();
    selectOneCallback({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "repo", input: singleInput, output: singleOutput }, () => {});
    const singleFrame = lastFrame(singleOutput);
    ok(singleFrame.includes("↑↓ move"), singleFrame);
    ok(singleFrame.includes("1-9 jump"), singleFrame);
    ok(singleFrame.includes("enter select"), singleFrame);
    ok(singleFrame.includes("ctrl-c quit"), singleFrame);
    ok(!singleFrame.includes("space toggle"), "single-select must not advertise Space");
    ok(!singleFrame.includes("/ filter"), "a 3-entry list is below the filter threshold");

    const multiInput = new FakeTTYInput();
    const multiOutput = fakeOutput();
    // Wide enough that nothing is dropped for width, so this case asserts what
    // the legend NAMES rather than what survives a squeeze — the drop order
    // itself has its own test below.
    multiOutput.columns = 120;
    selectManyCallback({ title: "Languages?", choices: LANGUAGE_CHOICES, defaultValues: [], input: multiInput, output: multiOutput }, () => {});
    const multiFrame = lastFrame(multiOutput);
    ok(multiFrame.includes("space toggle"), multiFrame);
    ok(multiFrame.includes("a all"), multiFrame);
    ok(multiFrame.includes("n none"), multiFrame);
    ok(multiFrame.includes("/ filter"), "a 9-entry list is above the filter threshold");
    ok(multiFrame.includes("enter ok"), multiFrame);

    sendKey(multiInput, "/");
    const filterFrame = lastFrame(multiOutput);
    ok(filterFrame.includes("type to filter"), filterFrame);
    ok(filterFrame.includes("esc clear filter"), filterFrame);
    // Space keeps working inside filter mode on a multi-select, so the legend
    // has to keep saying so: narrowing a list is only useful if something can
    // then be picked out of it.
    ok(filterFrame.includes("space toggle"), `filter mode must still advertise Space on a multi-select:\n${filterFrame}`);

    // ...and must not, on a single-select filterable prompt, where Space does
    // nothing in either mode.
    const singleFilterInput = new FakeTTYInput();
    const singleFilterOutput = fakeOutput();
    singleFilterOutput.columns = 120;
    selectOneCallback(
      { title: "Which?", choices: LANGUAGE_CHOICES, defaultValue: LANGUAGE_CHOICES[0].value, input: singleFilterInput, output: singleFilterOutput },
      () => {},
    );
    sendKey(singleFilterInput, "/");
    const singleFilterFrame = lastFrame(singleFilterOutput);
    ok(singleFilterFrame.includes("type to filter"), singleFilterFrame);
    ok(!singleFilterFrame.includes("space toggle"), `single-select filter mode must not advertise Space:\n${singleFilterFrame}`);
  });

  test("rich mode: Space toggles inside filter mode instead of extending the filter text", () => {
    const input = new FakeTTYInput();
    const output = fakeOutput();
    output.columns = 120;
    let result = null;
    selectManyCallback({ title: "Languages?", choices: LANGUAGE_CHOICES, defaultValues: [], input, output }, (r) => {
      result = r;
    });

    sendKey(input, "/");
    for (const ch of "ger") sendKey(input, ch);

    const narrowed = lastFrame(output);
    ok(narrowed.includes("Filter: ger"), `expected the filter to have narrowed, got:\n${narrowed}`);
    ok(narrowed.includes("German"), narrowed);
    ok(!narrowed.includes("English"), `expected the filter to have excluded non-matches, got:\n${narrowed}`);

    // The key the legend promises, pressed where a developer actually needs
    // it: on the narrowed list, not after scrolling the whole unfiltered one.
    sendKey(input, " ");

    const toggled = lastFrame(output);
    ok(toggled.includes("[x]"), `expected Space to have checked the highlighted entry, got:\n${toggled}`);
    ok(toggled.includes("Filter: ger"), `Space must not have been appended to the filter text, got:\n${toggled}`);

    sendKey(input, KEY.ENTER);
    ok(result && !result.cancelled, `expected a confirmed selection, got: ${JSON.stringify(result)}`);
    deepEq(result.values, ["de"], "the entry toggled inside filter mode is the selected one");
  });

  test("rich mode: the key legend always fits the terminal width and never ends mid-word, across single-select, multi-select and a filterable multi-select", () => {
    const widths = [120, 100, 80, 60, 40];
    const cases = [
      { name: "single-select", multi: false, choices: LOCATION_CHOICES },
      { name: "multi-select", multi: true, choices: LANGUAGE_CHOICES.slice(0, 3) },
      { name: "filterable multi-select", multi: true, choices: WIDE_CHOICES },
    ];

    for (const width of widths) {
      for (const c of cases) {
        const input = new FakeTTYInput();
        const output = fakeOutput();
        output.columns = width;
        if (c.multi) {
          selectManyCallback({ title: "Pick", choices: c.choices, defaultValues: [], input, output }, () => {});
        } else {
          selectOneCallback({ title: "Pick", choices: c.choices, defaultValue: c.choices[0].value, input, output }, () => {});
        }
        const legend = lastLegend(output);
        const context = `${c.name} at width ${width}`;
        ok(tty.displayWidth(legend) <= width, `${context}: legend is ${tty.displayWidth(legend)} columns wide, over the ${width}-column budget: "${legend}"`);
        ok(legend.includes("ctrl-c"), `${context}: legend must always name the quit key, got: "${legend}"`);
        ok(!legend.includes("…") || legend.endsWith(" · …"), `${context}: legend must never end mid-word, got: "${legend}"`);
      }
    }
  });

  test("rich mode: the legend drops the lowest-priority item first, not the last item positionally", () => {
    const input = new FakeTTYInput();
    const output = fakeOutput();
    // The full filterable multi-select legend needs 86 columns; one column
    // short forces exactly one drop.
    output.columns = 85;
    selectManyCallback({ title: "Pick", choices: WIDE_CHOICES, defaultValues: [], input, output }, () => {});
    const legend = lastLegend(output);

    ok(!legend.includes("1-9 jump"), `expected the lowest-priority item "1-9 jump" to be the one dropped, got: "${legend}"`);
    ok(legend.includes("ctrl-c quit"), `expected the last positional item to survive untouched, got: "${legend}"`);
    for (const survivor of ["↑↓ move", "space toggle", "a all", "n none", "/ filter", "enter ok"]) {
      ok(legend.includes(survivor), `expected "${survivor}" to survive a single-item drop, got: "${legend}"`);
    }
    ok(legend.endsWith(" · …"), `expected the dropped-items marker once an item was dropped, got: "${legend}"`);
  });

  test("rich mode: the legend's dropped-items marker appears only when something was actually dropped", () => {
    const wideInput = new FakeTTYInput();
    const wideOutput = fakeOutput();
    wideOutput.columns = 100; // fits the full 86-column filterable multi-select legend
    selectManyCallback({ title: "Pick", choices: WIDE_CHOICES, defaultValues: [], input: wideInput, output: wideOutput }, () => {});
    ok(!lastLegend(wideOutput).includes("…"), `expected no marker when the full legend already fits, got: "${lastLegend(wideOutput)}"`);

    const narrowInput = new FakeTTYInput();
    const narrowOutput = fakeOutput();
    narrowOutput.columns = 60; // forces several drops
    selectManyCallback({ title: "Pick", choices: WIDE_CHOICES, defaultValues: [], input: narrowInput, output: narrowOutput }, () => {});
    ok(lastLegend(narrowOutput).endsWith(" · …"), `expected the marker once items were dropped, got: "${lastLegend(narrowOutput)}"`);
  });

  test("rich mode: no emitted line carries trailing whitespace, across the width matrix the width-invariant coverage already uses", () => {
    const choices = loadRealModuleChoices();
    for (const width of [40, 80, 100, 120]) {
      const input = new FakeTTYInput();
      const output = fakeOutput();
      output.columns = width;
      selectManyCallback(
        { title: "\nWhich modules should be enabled?", choices, defaultValues: [choices[0].value], input, output },
        () => {},
      );
      for (let i = 0; i < choices.length; i += 1) {
        sendKey(input, KEY.DOWN);
        sendKey(input, KEY.SPACE);
      }
      for (const chunk of contentChunks(output)) {
        for (const line of chunk.split("\n")) {
          ok(line === line.replace(/[ \t]+$/, ""), `width ${width}: line carries trailing whitespace: "${line}"`);
        }
      }
    }
  });

  test("rich mode: entry numbers are rendered beside the choices they select", () => {
    const input = new FakeTTYInput();
    const output = fakeOutput();
    selectOneCallback({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "repo", input, output }, () => {});
    const frame = lastFrame(output);
    ok(/\b1\)/.test(frame) && /\b2\)/.test(frame) && /\b3\)/.test(frame), `expected numbered rows 1)-3), got:\n${frame}`);
  });

  test("rich mode: setRawMode(false) is called after a normal selection", () => {
    const input = new FakeTTYInput();
    const output = fakeOutput();
    selectOneCallback({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "repo", input, output }, () => {});
    sendKey(input, KEY.ENTER);
    deepEq(input.rawModeCalls, [true, false], "raw mode must be enabled once and restored once on a normal selection");
  });

  test("rich mode: the cursor is hidden for the life of the prompt and restored on a normal confirm", () => {
    const input = new FakeTTYInput();
    const output = fakeOutput();
    selectOneCallback({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "repo", input, output }, () => {});
    eq(output.chunks[0], "\x1b[?25l", "the cursor must be hidden before the first frame is drawn");
    sendKey(input, KEY.ENTER);
    eq(output.chunks[output.chunks.length - 1], "\x1b[?25h", "the cursor must be restored as the very last write on confirm");
  });

  test("rich mode: Ctrl-C aborts distinctly from cancelling, restores raw mode and the cursor, and is reported through the ABORTED sentinel via selectOne", async () => {
    const input = new FakeTTYInput();
    const output = fakeOutput();
    let reported = null;
    selectOneCallback({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "repo", input, output }, (r) => {
      reported = r;
    });
    sendKey(input, KEY.CTRL_C);
    ok(reported && reported.cancelled === false && reported.aborted === true, `expected an aborted, not cancelled, outcome, got: ${JSON.stringify(reported)}`);
    deepEq(input.rawModeCalls, [true, false], "raw mode must be restored on an abort too");
    eq(output.chunks[output.chunks.length - 1], "\x1b[?25h", "the cursor must be restored on an abort too");

    // Also exercised through the Promise-returning wrapper, since ABORTED is
    // the shape a standalone caller actually checks against.
    const input2 = new FakeTTYInput();
    const output2 = fakeOutput();
    const resultPromise = selectOne({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "repo", input: input2, output: output2 });
    sendKey(input2, KEY.CTRL_C);
    eq(await resultPromise, ABORTED);
  });

  test("rich mode: Escape cancels (reported through CANCELLED, distinct from an abort) and setRawMode(false) is still called", async () => {
    const input = new FakeTTYInput();
    const output = fakeOutput();
    const resultPromise = selectOne({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "repo", input, output });
    sendKey(input, KEY.ESCAPE);
    await waitForEscapeTimeout();
    eq(await resultPromise, CANCELLED);
    deepEq(input.rawModeCalls, [true, false], "raw mode must be restored on a cancelled prompt too");
  });

  test("rich mode: setRawMode(false) and the cursor are restored even when a keypress handler throws, without masking the original error", () => {
    const input = new FakeTTYInput();
    // Succeeds writing the hide-cursor sequence, then throws on the first
    // frame render, so the throw path is exercised while still leaving the
    // hide-cursor write inspectable.
    const chunks = [];
    const output = {
      isTTY: true,
      write(s) {
        chunks.push(String(s));
        if (chunks.length === 2) throw new Error("boom — a broken output stream");
        return true;
      },
    };
    let threw = false;
    try {
      selectOneCallback({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "repo", input, output }, () => {});
    } catch {
      threw = true;
    }
    ok(threw, "the broken output stream's own throw during the first render must propagate, not be swallowed");
    deepEq(input.rawModeCalls, [true, false], "raw mode must be restored even when rendering throws");
    eq(chunks[0], "\x1b[?25l", "the cursor-hide write must have happened before the throw");
    eq(chunks[chunks.length - 1], "\x1b[?25h", "cleanup must still attempt to restore the cursor after the throw");
  });

  test("rich mode: no rendered line ever exceeds the terminal width, driving the real module catalogue's own titles and summaries through every entry at several widths", () => {
    const choices = loadRealModuleChoices();
    ok(choices.length >= 5, `expected the real module catalogue to load, got ${choices.length} entries`);
    ok(
      choices.some((c) => c.label.length + c.hint.length > tty.FALLBACK_WIDTH),
      "expected at least one real module's label + summary long enough to have wrapped a typical-width line under the old renderer",
    );

    for (const width of [40, 80, 100, 120]) {
      const input = new FakeTTYInput();
      const output = fakeOutput();
      output.columns = width;
      let reported = null;
      selectManyCallback(
        {
          title: "\nWhich modules should be enabled?",
          choices,
          defaultValues: [choices[0].value],
          input,
          output,
        },
        (r) => {
          reported = r;
        },
      );

      // Press through every entry, toggling each one, then confirm.
      for (let i = 0; i < choices.length; i += 1) {
        sendKey(input, KEY.DOWN);
        sendKey(input, KEY.SPACE);
      }
      sendKey(input, KEY.ENTER);

      ok(reported && reported.cancelled === false, `expected a confirmed result at width ${width}`);
      assertNoLineExceedsWidth(output, width, ok, `width ${width}`);
    }
  });

  test("rich mode: isInteractive gates rich mode on the output stream too — a TTY stdin with a piped stdout uses line mode and writes no escape sequence", () => {
    const input = new PassThrough();
    input.isTTY = true;
    input.setRawMode = () => {}; // looks fully rich-mode-capable on the input side alone
    const output = fakeOutput();
    output.isTTY = false; // ...but stdout is a pipe, exactly the scenario the old `input.isTTY` check got wrong

    let reported = null;
    selectOneCallback({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "repo", input, output }, (r) => {
      reported = r;
    });
    input.end("3\n");
    ok(reported && reported.value === "global", `expected line mode's numbered-answer flow to have run, got: ${JSON.stringify(reported)}`);
    ok(!output.text().includes("\x1b"), `expected no escape sequence to have been written into the piped stdout, got:\n${output.text()}`);
  });

  test("line selectOne: empty input takes the default", async () => {
    const input = new PassThrough();
    const output = fakeOutput();
    const resultPromise = selectOne({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "infrastructure", input, output });
    input.end("\n");
    eq(await resultPromise, "infrastructure");
  });

  test("line selectOne: a number picks that entry", async () => {
    const input = new PassThrough();
    const output = fakeOutput();
    const resultPromise = selectOne({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "repo", input, output });
    input.end("3\n");
    eq(await resultPromise, "global");
  });

  test("line selectOne: the literal value text still picks the entry, exactly as free text always has", async () => {
    const input = new PassThrough();
    const output = fakeOutput();
    const resultPromise = selectOne({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "repo", input, output });
    input.end("global\n");
    eq(await resultPromise, "global");
  });

  test("line selectOne: an unrecognised answer re-asks, then falls back to the default after the attempt limit", async () => {
    const input = new PassThrough();
    const output = fakeOutput();
    const resultPromise = selectOne({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "repo", input, output });
    input.end("mars\nvenus\npluto\n");
    eq(await resultPromise, "repo");
    ok(output.text().includes("is not one of"), `expected a re-ask message, got:\n${output.text()}`);
    ok(output.text().includes("using the default"), `expected a fallback message, got:\n${output.text()}`);
  });

  test("line selectMany: \"2,1\" yields those two entries in that order", async () => {
    const input = new PassThrough();
    const output = fakeOutput();
    const resultPromise = selectMany({ title: "Where?", choices: LOCATION_CHOICES, defaultValues: [], input, output });
    input.end("2,1\n");
    deepEq(await resultPromise, ["infrastructure", "repo"]);
  });

  test("line selectMany: empty input takes the defaults", async () => {
    const input = new PassThrough();
    const output = fakeOutput();
    const resultPromise = selectMany({ title: "Where?", choices: LOCATION_CHOICES, defaultValues: ["repo", "global"], input, output });
    input.end("\n");
    deepEq(await resultPromise, ["repo", "global"]);
  });

  test("selectOneCallback/selectManyCallback report through a plain synchronous callback, not a Promise", () => {
    const input = new PassThrough();
    const output = fakeOutput();
    let reported = null;
    selectOneCallback({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "repo", input, output }, (result) => {
      reported = result;
    });
    input.end("global\n");
    // `input.end` delivers its buffered line synchronously to a freshly
    // created `readline.Interface` in the same turn, so the callback has
    // already fired by the time this assertion runs.
    ok(reported && reported.cancelled === false && reported.value === "global", `expected a synchronous callback result, got: ${JSON.stringify(reported)}`);
  });

  test("a missing or malformed languages.json degrades to null (free text) without throwing", () => {
    const missing = loadReplyLanguageCatalogue(path.join(tmpdir(), "does-not-exist.json"));
    eq(missing, null, "a missing catalogue file must report null, not throw");

    const malformedPath = fixture("bad-languages.json", "{ this is not json");
    eq(loadReplyLanguageCatalogue(malformedPath), null, "invalid JSON must report null, not throw");

    const wrongShapePath = fixture("wrong-shape-languages.json", { note: "no languages array here" });
    eq(loadReplyLanguageCatalogue(wrongShapePath), null, "a JSON file with no languages array must report null, not throw");

    const validPath = fixture("good-languages.json", { languages: [{ code: "de", name: "German" }] });
    deepEq(loadReplyLanguageCatalogue(validPath), [{ code: "de", name: "German" }], "a well-formed catalogue must round-trip through unchanged");
  });

  test("rich mode: a long title wraps across as many lines as it needs, in full, at a matrix of widths", () => {
    eq(LONG_TITLE.length, 300, "test fixture must be exactly 300 characters");

    for (const width of [40, 60, 80, 100, 120]) {
      const input = new FakeTTYInput();
      const output = fakeOutput();
      output.columns = width;
      selectOneCallback({ title: LONG_TITLE, choices: LOCATION_CHOICES, defaultValue: "repo", input, output }, () => {});

      const frame = lastFrame(output).replace(/\n+$/, "");
      const lines = frame.split("\n");
      const firstChoiceRow = lines.findIndex((l) => /^[0-9]\)$/.test(l.slice(3, 5)));
      ok(firstChoiceRow > 1, `width ${width}: expected the 300-character title to wrap onto more than one line, got ${firstChoiceRow}:\n${frame}`);

      const titleLines = lines.slice(0, firstChoiceRow);
      for (const line of titleLines) {
        const measured = tty.displayWidth(line);
        ok(measured <= width, `width ${width}: a title line is ${measured} columns wide, over the ${width}-column limit: "${line}"`);
        ok(line === line.replace(/[ \t]+$/, ""), `width ${width}: a title line carries trailing whitespace: "${line}"`);
      }
      eq(titleLines.join(" "), LONG_TITLE, `width ${width}: the whole title must survive, unabridged, once its wrapped lines are rejoined`);
    }
  });

  test("rich mode: a choice's hint wraps onto continuation lines aligned under the hint column, with the whole summary surviving and the number/marker/checkbox appearing only on the first line, for the real module catalogue at a matrix of widths", () => {
    const choices = loadRealModuleChoices();

    for (const width of [40, 80, 100, 120]) {
      const input = new FakeTTYInput();
      const output = fakeOutput();
      output.columns = width;
      selectManyCallback({ title: "Pick", choices, defaultValues: [], input, output }, () => {});

      const frame = lastFrame(output);
      const collapsed = frame.replace(/\s+/g, " ");
      const entryBlock = extractEntryBlockLines(frame, ok);
      const groups = groupEntryLines(entryBlock);
      ok(groups.length > 0, `width ${width}: expected at least one visible choice`);

      groups.forEach((entryLines, i) => {
        const choice = choices[i];
        const context = `width ${width}, choice "${choice.value}"`;

        // The whole summary survives: every hint, whitespace-normalised,
        // appears intact in the frame, wherever it ended up wrapping.
        const collapsedHint = choice.hint.trim().replace(/\s+/g, " ");
        ok(collapsed.includes(collapsedHint), `${context}: expected the full summary to survive wrapping, got:\n${frame}`);

        // The checkbox cell — set together with the number and the label,
        // gated on the very same "first line only" condition in the
        // renderer — carries a real value on the first line and is blank on
        // every continuation line, proof that whole group of cells was
        // never repeated there.
        ok(/^\[[ x]\]$/.test(entryLines[0].slice(7, 10)), `${context}: expected the first line's own checkbox cell to carry a real value, got: "${entryLines[0]}"`);
        for (let li = 1; li < entryLines.length; li += 1) {
          eq(entryLines[li].slice(7, 10), "   ", `${context}: expected a blank checkbox cell on continuation line ${li}, got: "${entryLines[li]}"`);
        }

        assertHintColumnAligned(entryLines, choice.hint, ok, context);
      });
    }
  });

  test("rich mode: the marker glyph itself never appears on a wrapped choice's continuation line", () => {
    const choices = loadRealModuleChoices();
    const input = new FakeTTYInput();
    const output = fakeOutput();
    output.columns = 40; // narrow enough that every real summary wraps
    selectManyCallback({ title: "Pick", choices, defaultValues: [], input, output }, () => {});

    const groups = groupEntryLines(extractEntryBlockLines(lastFrame(output), ok));
    const highlighted = groups[0]; // highlightIndex defaults to the first entry
    ok(highlighted[0].startsWith(">"), `expected the highlighted entry's first line to carry the marker, got: "${highlighted[0]}"`);
    for (let li = 1; li < highlighted.length; li += 1) {
      ok(!highlighted[li].startsWith(">"), `expected no marker glyph on a continuation line, got: "${highlighted[li]}"`);
    }
  });

  test("rich mode: the frame never exceeds terminalRows, across a matrix of row counts including a short terminal, with entries whose hints wrap", () => {
    const choices = loadRealModuleChoices();
    for (const rows of [10, 12, 16, 24, 40, 60]) {
      const input = new FakeTTYInput();
      const output = fakeOutput();
      output.columns = 80;
      output.rows = rows;
      selectManyCallback({ title: "Which modules should be enabled?", choices, defaultValues: [], input, output }, () => {});

      const frameLineCount = lastFrame(output).replace(/\n+$/, "").split("\n").length;
      const budget = tty.terminalRows(output);
      ok(frameLineCount <= budget, `rows ${rows}: frame is ${frameLineCount} lines, over the ${budget}-row terminal`);
    }
  });

  test("rich mode: a 200-entry catalogue with short hints renders no taller than an unwrapped list did", () => {
    const choices = Array.from({ length: 200 }, (_, i) => ({ value: `l${i}`, label: `Language ${i}`, hint: "uk · Українська" }));
    const input = new FakeTTYInput();
    const output = fakeOutput();
    selectManyCallback({ title: "Which languages?", choices, defaultValues: [], input, output }, () => {});

    const frameLines = lastFrame(output).replace(/\n+$/, "").split("\n");
    // title(1) + "Selected:"(1) + a full MAX_VIEWPORT-row window of 1-row
    // entries (10, since none of these short hints ever wrap) + "↓ N more"(1)
    // + legend(1) — the exact height an unwrapped renderer already produced.
    eq(frameLines.length, 14, `expected the unwrapped-equivalent 14-line frame, got ${frameLines.length}:\n${frameLines.join("\n")}`);
  });

  test("rich mode: canGoBack:true reports BACK on Escape outside filter mode; canGoBack:false (the default) keeps Escape as CANCELLED; Escape inside filter mode only ever clears the filter, in either case", () => {
    // Escape is delivered as a direct 'keypress' event, bypassing raw-byte
    // parsing entirely, so this assertion runs synchronously: a lone Escape
    // byte cannot be told apart from the start of a longer escape sequence
    // without Node's own readline waiting out a real disambiguation timer
    // (see this file's own module doc), which a synchronous test cannot
    // wait on.
    const escape = (input) => input.emit("keypress", undefined, { name: "escape" });

    {
      const input = new FakeTTYInput();
      const output = fakeOutput();
      let reported = null;
      selectOneCallback({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "repo", canGoBack: true, input, output }, (r) => {
        reported = r;
      });
      escape(input);
      ok(reported && reported.cancelled === false && reported.back === true, `expected a back outcome, got: ${JSON.stringify(reported)}`);
    }

    {
      const input = new FakeTTYInput();
      const output = fakeOutput();
      let reported = null;
      selectOneCallback({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "repo", input, output }, (r) => {
        reported = r;
      });
      escape(input);
      ok(reported && reported.cancelled === true && !reported.back, `expected today's cancel outcome unchanged when canGoBack is unset, got: ${JSON.stringify(reported)}`);
    }

    for (const canGoBack of [false, true]) {
      const input = new FakeTTYInput();
      const output = fakeOutput();
      let reported = null;
      selectManyCallback({ title: "Languages?", choices: LANGUAGE_CHOICES, defaultValues: [], canGoBack, input, output }, (r) => {
        reported = r;
      });
      sendKey(input, "/");
      sendKey(input, "g");
      ok(lastFrame(output).includes("Filter:"), `canGoBack=${canGoBack}: expected filter mode to be active before Escape`);
      escape(input);
      ok(!reported, `canGoBack=${canGoBack}: Escape inside filter mode must not resolve the prompt`);
      ok(!lastFrame(output).includes("Filter:"), `canGoBack=${canGoBack}: expected Escape to have cleared the filter instead, got:\n${lastFrame(output)}`);
      ok(!reported || !reported.back, `canGoBack=${canGoBack}: Escape inside filter mode must never report BACK`);
    }

    for (const canGoBack of [false, true]) {
      const input = new FakeTTYInput();
      const output = fakeOutput();
      let reported = null;
      selectOneCallback({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "repo", canGoBack, input, output }, (r) => {
        reported = r;
      });
      sendKey(input, KEY.CTRL_C);
      ok(reported && reported.aborted === true && !reported.back, `canGoBack=${canGoBack}: Ctrl-C must still abort, unaffected by canGoBack, got: ${JSON.stringify(reported)}`);
    }
  });

  test("rich mode: the legend advertises 'esc back' only when canGoBack is true, and the quit key survives at every width down to 40 regardless", () => {
    for (const canGoBack of [false, true]) {
      for (const width of [120, 100, 80, 60, 40]) {
        const input = new FakeTTYInput();
        const output = fakeOutput();
        output.columns = width;
        selectOneCallback({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "repo", canGoBack, input, output }, () => {});
        const legend = lastLegend(output);
        ok(legend.includes("ctrl-c"), `canGoBack=${canGoBack} width ${width}: legend must always name the quit key, got: "${legend}"`);
        if (!canGoBack) ok(!legend.includes("esc back"), `canGoBack=false width ${width}: legend must never advertise "esc back", got: "${legend}"`);
      }
    }

    const input = new FakeTTYInput();
    const output = fakeOutput();
    output.columns = 80;
    selectOneCallback({ title: "Where?", choices: LOCATION_CHOICES, defaultValue: "repo", canGoBack: true, input, output }, () => {});
    ok(lastLegend(output).includes("esc back"), `expected "esc back" to be advertised at width 80, got: "${lastLegend(output)}"`);
  });
});
