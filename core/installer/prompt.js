"use strict";

/**
 * A self-contained, zero-dependency selection UI for the interactive
 * installer: pick one entry, or several, by arrow keys and digits on a real
 * terminal, or by number or literal text when stdin is piped.
 *
 * Two interaction modes are chosen at runtime, never configured by a caller:
 *
 * - **Rich mode**, when both `input` and `output` pass {@link
 *   module:core/installer/tty.isInteractive} — `readline.emitKeypressEvents`
 *   plus raw mode, redrawing the choice list in place on every keystroke.
 *   Every line a frame writes is resolved against {@link
 *   module:core/installer/tty.terminalWidth} and truncated to it, so a
 *   frame's logical line count always equals the physical rows it occupies —
 *   the property the redraw's cursor arithmetic depends on.
 * - **Line mode** otherwise (a piped stdin, a dumb terminal, CI) — the
 *   choice list is printed once, then one line is read and parsed.
 *
 * `selectOne`/`selectMany` return a `Promise`, for direct, standalone use.
 * `selectOneCallback`/`selectManyCallback` report the same outcome through a
 * plain callback invoked synchronously from within the answer's own event —
 * the continuation-passing style a caller chaining several prompts on one
 * shared, already-open `readline.Interface` (a piped burst of buffered
 * answers delivers every line in one synchronous pass; a `Promise`'s `.then`
 * always defers to a microtask that arrives after that pass has already
 * finished, silently losing every line but the first) must keep using
 * instead of `await`-ing between prompts. `selectOne`/`selectMany` are thin
 * `Promise` wrappers around these two.
 */

const readline = require("readline");
const tty = require("./tty");

/**
 * Resolved value when a rich-mode prompt is cancelled with Escape before an
 * answer was confirmed. `selectOne`/`selectMany` resolve to this rather than
 * rejecting, so a caller checks it with a plain `===` instead of a
 * `try`/`catch`; nothing is written before a prompt resolves, so a cancelled
 * prompt is always safe to fall back on a caller's own default for. Line
 * mode never produces this — it has no cancel gesture. When `canGoBack` is
 * `true`, Escape outside filter mode reports {@link BACK} instead — this
 * sentinel is then only reached through some other path a caller adds of
 * its own.
 */
const CANCELLED = Symbol("softela-ai/prompt/cancelled");

/**
 * Resolved value when a rich-mode prompt is aborted with Ctrl-C. Distinct
 * from {@link CANCELLED} on purpose: a developer who hits Ctrl-C means stop
 * the whole run, not "accept the defaults and carry on" — a caller must
 * check for this separately and halt rather than falling back. Line mode
 * never produces this either.
 */
const ABORTED = Symbol("softela-ai/prompt/aborted");

/**
 * Resolved value when a rich-mode prompt with `canGoBack: true` is left with
 * Escape outside filter mode. Distinct from {@link CANCELLED}: a caller that
 * chains several prompts checks for this to step back to the previous
 * question and re-ask it, rather than falling back to a default. Escape
 * still means {@link CANCELLED} when `canGoBack` is unset or `false`, and
 * inside filter mode Escape always clears the filter first regardless of
 * `canGoBack` — see {@link runRich}. Line mode never produces this either.
 */
const BACK = Symbol("softela-ai/prompt/back");

/** Line-mode invalid-answer attempts {@link selectOneCallback} tolerates before falling back to the default. */
const LINE_MODE_MAX_ATTEMPTS = 3;

/** List length above which a rich-mode prompt becomes filterable with `/`. */
const FILTER_THRESHOLD = 8;

/**
 * Narrowest row budget a rich-mode choice list's scrolling viewport will
 * shrink to — rows, not entries, since a choice whose hint wraps can occupy
 * more than one row; an unwrapped list still shows exactly this many
 * entries, the same as before rows became the unit of measure.
 */
const MIN_VIEWPORT = 3;

/** Widest row budget a rich-mode choice list's scrolling viewport will grow to (see {@link MIN_VIEWPORT}). */
const MAX_VIEWPORT = 10;

/** Sequence hiding the terminal cursor, written once a rich-mode frame is about to be drawn. */
const HIDE_CURSOR = "\x1b[?25l";

/** Sequence restoring the terminal cursor, written on every rich-mode exit path. */
const SHOW_CURSOR = "\x1b[?25h";

/**
 * Normalises a caller-supplied choice list into the shape every renderer and
 * matcher below relies on.
 *
 * @param {{value: *, label?: string, hint?: string}[]} choices The raw
 * choices.
 * @returns {{value: *, label: string, hint: string}[]} One entry per input
 * choice, `label` defaulted from `value` and `hint` defaulted to `""`.
 */
function normalizeChoices(choices) {
  return (Array.isArray(choices) ? choices : []).map((c) => ({
    value: c.value,
    label: c.label !== undefined && c.label !== null ? String(c.label) : String(c.value),
    hint: c.hint ? String(c.hint) : "",
  }));
}

/**
 * Narrows a choice list to the entries whose label or value contains a
 * filter string, case-insensitively.
 *
 * @param {{value: *, label: string, hint: string}[]} choices The full list.
 * @param {string} filterText The typed filter; matching is skipped and every
 * choice returned when this is empty.
 * @returns {{value: *, label: string, hint: string}[]} The matching subset,
 * in the same order as `choices`.
 */
function filterChoices(choices, filterText) {
  if (!filterText) return choices;
  const needle = filterText.toLowerCase();
  return choices.filter((c) => c.label.toLowerCase().includes(needle) || String(c.value).toLowerCase().includes(needle));
}

/**
 * Moves the cursor to the start of a previously drawn block and clears
 * everything below it, so a redraw can rewrite it without leaving stray
 * characters from a longer previous line behind.
 *
 * Correct only when every line of that previous render was truncated to the
 * terminal width before being written — a wrapped line occupies more
 * physical rows than it counts as a logical line, which is exactly what
 * used to make this arithmetic wrong.
 *
 * @param {NodeJS.WritableStream} output The stream a prior render's lines
 * were written to.
 * @param {number} lineCount How many lines that render printed.
 * @returns {void}
 */
function eraseLines(output, lineCount) {
  if (lineCount <= 0) return;
  readline.moveCursor(output, 0, -lineCount);
  readline.cursorTo(output, 0);
  readline.clearScreenDown(output);
}

/**
 * Sizes the label column of a rich-mode choice row so the hint keeps a
 * usable share of the row's width instead of being crowded out by a long
 * label.
 *
 * @param {string[]} labelTexts The already-finalised label text of every
 * currently visible entry (including any `(default)` suffix).
 * @param {boolean} multi Whether the row also carries a checkbox cell.
 * @param {number} width The total row width the columns must fit within.
 * @returns {number} The label column's width — the widest visible label,
 * capped so at least a bit under half of what remains after the fixed
 * columns stays available to the hint.
 */
function computeLabelWidth(labelTexts, multi, width) {
  const fixedWidth = 1 /* marker */ + 2 /* number */ + (multi ? 3 : 0) /* checkbox */;
  const totalCells = (multi ? 3 : 2) + 2 /* label + hint */;
  const separatorsWidth = (totalCells - 1) * 2;
  const budget = Math.max(0, width - fixedWidth - separatorsWidth);
  const widest = labelTexts.reduce((max, text) => Math.max(max, tty.displayWidth(text)), 0);
  const cap = Math.max(4, Math.floor(budget * 0.55));
  return Math.max(0, Math.min(widest, cap, budget));
}

/**
 * Clamps a number into a closed range — a private copy of {@link
 * module:core/installer/tty}'s own helper of the same name, which this
 * module has no other reason to import.
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
 * Sizes a rich-mode choice row's hint column — the width left over once the
 * marker, number, an optional checkbox, and a resolved label column have
 * each taken their fixed share of the row.
 *
 * Mirrors {@link fitRow}'s own remaining-width arithmetic for a `grow` cell
 * exactly, so a hint wrapped against this width always occupies precisely
 * the space {@link fitRow} will later give it — never more, never less.
 *
 * @param {number} labelWidth The label column's width, from {@link
 * computeLabelWidth}.
 * @param {boolean} multi Whether the row also carries a checkbox cell.
 * @param {number} width The total row width the columns must fit within.
 * @returns {number} The hint column's width, `0` at the narrowest.
 */
function hintColumnWidth(labelWidth, multi, width) {
  const fixedWidth = 1 /* marker */ + 2 /* number */ + (multi ? 3 : 0) /* checkbox */ + labelWidth;
  const totalCells = (multi ? 3 : 2) + 2 /* label + hint */;
  const separatorsWidth = (totalCells - 1) * 2;
  return Math.max(0, width - fixedWidth - separatorsWidth);
}

/**
 * Word-wraps one choice's hint to its column width, so a caller can treat
 * every hint uniformly — an empty hint still wraps to one empty line, never
 * zero lines, keeping "how many rows does this choice occupy" a simple
 * `.length` read.
 *
 * @param {string} hint The choice's hint text; `""` or falsy is treated as
 * empty.
 * @param {number} hintWidth The hint column's width, from {@link
 * hintColumnWidth}.
 * @returns {string[]} One entry per wrapped line, `[""]` when `hint` is
 * empty.
 */
function hintLinesFor(hint, hintWidth) {
  return tty.wrap(hint || "", Math.max(1, hintWidth));
}

/**
 * Resolves a choice's rendered label text, including the `(default)` suffix
 * single-select carries on the default entry — the same text both the sizing
 * pass and the render pass must measure identically.
 *
 * @param {{value: *, label: string}} choice The choice.
 * @param {boolean} multi Whether this is a multi-select prompt (which never
 * renders a `(default)` suffix — the checkbox already carries that state).
 * @param {*} defaultValue Single-select only: the default value.
 * @returns {string} The label text, with the suffix appended when it
 * applies.
 */
function labelTextFor(choice, multi, defaultValue) {
  return !multi && choice.value === defaultValue ? `${choice.label} (default)` : choice.label;
}

/**
 * Word-wraps a question title to the terminal width, treating each of its
 * own embedded newlines as a separate paragraph so a caller-inserted blank
 * line (a leading `"\n"`, chiefly) survives as its own blank line rather than
 * being swallowed into the wrap.
 *
 * Continuation lines carry no indent: a title has no leading marker of its
 * own the way a choice row does, so the start of the title text already
 * sits at column 0 and continuation lines align under exactly that.
 *
 * @param {string} title The title text; may be empty.
 * @param {number} width The column width to wrap into.
 * @returns {string[]} One entry per wrapped line.
 */
function wrapTitleLines(title, width) {
  return String(title)
    .split("\n")
    .flatMap((line) => tty.wrap(line, width));
}

/**
 * Counts the physical rows a question title will occupy once wrapped — the
 * figure the scrolling viewport's row budget must reserve for it.
 *
 * @param {string} title The title text; `""` reserves no rows.
 * @param {number} width The column width to wrap into.
 * @returns {number} The row count.
 */
function titleLineCount(title, width) {
  return title ? wrapTitleLines(title, width).length : 0;
}

/**
 * Determines how many entries, starting at a given point in the list, fit
 * within a row budget — the row-measuring replacement for what used to be a
 * flat entry count, so a choice whose hint wraps to three lines counts as
 * three rows against the budget instead of one.
 *
 * The label column width used to size every candidate's hint is resolved
 * once, from up to {@link MAX_VIEWPORT} entries starting at `offsetEntries`
 * (a row budget can never fit more than that many one-row-minimum entries
 * anyway) — deliberately not narrowed down to the entries that end up
 * actually visible, since the widest-label set (fewer or equal entries)
 * gives a label column at least as wide, which yields a hint column at most
 * as wide, which yields rows counted here at least as generous as what the
 * final render will actually need. A window sized this way can therefore
 * undershoot the true budget by a little, but never overshoot it.
 *
 * @param {{value: *, label: string, hint: string}[]} offsetEntries The
 * entries starting at the candidate scroll offset — only its first {@link
 * MAX_VIEWPORT} are ever consulted.
 * @param {number} rowBudget The row budget the returned entries' own hint
 * lines must fit within.
 * @param {number} width The total row width the columns must fit within.
 * @param {boolean} multi Whether this is a multi-select prompt.
 * @param {*} defaultValue Single-select only: the default value.
 * @returns {{count: number, labelWidth: number}} `count` is at least `1`
 * whenever `offsetEntries` is non-empty, even if the first entry's own hint
 * alone would overflow `rowBudget` — a window is never emptied out entirely,
 * only ever undersized.
 */
function computeWindowCount(offsetEntries, rowBudget, width, multi, defaultValue) {
  const candidate = offsetEntries.slice(0, MAX_VIEWPORT);
  if (!candidate.length) return { count: 0, labelWidth: 0 };

  const labelTexts = candidate.map((c) => labelTextFor(c, multi, defaultValue));
  const labelWidth = computeLabelWidth(labelTexts, multi, width);
  const hintWidth = hintColumnWidth(labelWidth, multi, width);

  let used = 0;
  let count = 0;
  for (const choice of candidate) {
    const rows = hintLinesFor(choice.hint, hintWidth).length;
    if (count > 0 && used + rows > rowBudget) break;
    used += rows;
    count += 1;
  }
  return { count, labelWidth };
}

/**
 * Legend items ranked at or above this value are the ones {@link buildLegend}
 * always keeps whole — never dropped outright, only shortened via {@link
 * LEGEND_SHORT_FORMS} as a last resort once every lower-ranked item is
 * already gone and the legend still does not fit.
 */
const LEGEND_ESSENTIAL_RANK = 100;

/**
 * Shortened forms {@link fitLegend} substitutes for an essential legend item
 * when even every droppable item has already been removed and the legend
 * still overflows its budget. Applied in ascending rank order, so `ctrl-c
 * quit` — the highest-ranked essential — is the last one ever shortened.
 */
const LEGEND_SHORT_FORMS = {
  "↑↓ move": "↑↓",
  "enter ok": "ok",
  "enter select": "select",
  "ctrl-c quit": "ctrl-c",
};

/**
 * Builds one key legend item.
 *
 * @param {string} text The item's display text.
 * @param {number} rank How long the item survives when the legend has to
 * shrink to fit — lower drops first; {@link LEGEND_ESSENTIAL_RANK} or above
 * is never dropped outright, only shortened.
 * @returns {{text: string, rank: number}} The item.
 */
function legendItem(text, rank) {
  return { text, rank };
}

/**
 * Lists the key legend's items, in display order, for the current frame
 * mode — the keys that actually do something right now, each carrying the
 * priority rank {@link fitLegend} drops or shortens by.
 *
 * @param {{multi: boolean, filterable: boolean, filterMode: boolean, canGoBack: boolean}} state
 * The frame's mode flags. `canGoBack` is only honoured outside filter mode —
 * inside it Escape always clears the filter first, never steps back.
 * @returns {{text: string, rank: number}[]} The legend items, left to right.
 */
function legendItemsFor(state) {
  const enterItem = legendItem(state.multi ? "enter ok" : "enter select", LEGEND_ESSENTIAL_RANK + 1);
  if (state.filterMode) {
    const items = [legendItem("type to filter", 2), legendItem("backspace delete", 1)];
    // Ranked just under the essentials: a developer who has narrowed the list
    // and cannot then find how to pick anything out of it is stuck, so this is
    // the last droppable item to go.
    if (state.multi) items.push(legendItem("space toggle", 7));
    items.push(
      legendItem("↑↓ move", LEGEND_ESSENTIAL_RANK),
      enterItem,
      legendItem("esc clear filter", 3),
      legendItem("ctrl-c quit", LEGEND_ESSENTIAL_RANK + 2),
    );
    return items;
  }
  const items = [legendItem("↑↓ move", LEGEND_ESSENTIAL_RANK), legendItem("1-9 jump", 1)];
  if (state.multi) items.push(legendItem("space toggle", 5), legendItem("a all", 2), legendItem("n none", 3));
  if (state.filterable) items.push(legendItem("/ filter", 4));
  // Ranked above every other droppable item (but still below the three
  // essentials) so a developer who cannot find it is never the one it drops
  // first for — see this module's own doc comment on `BACK`.
  if (state.canGoBack) items.push(legendItem("esc back", 6));
  items.push(enterItem, legendItem("ctrl-c quit", LEGEND_ESSENTIAL_RANK + 2));
  return items;
}

/**
 * Fits ranked legend items into a column budget instead of letting a
 * caller-side truncation cut the last item off mid-word.
 *
 * Flow:
 * - While the `" · "`-joined line overflows `width`, drop the lowest-ranked
 *   item below {@link LEGEND_ESSENTIAL_RANK} — one at a time, lowest rank
 *   first — never the last item positionally unless it happens to also be
 *   lowest-ranked.
 * - The moment anything was actually dropped, append a `" · …"` marker,
 *   counted against the same `width` budget on every check from then on.
 * - If the essential items alone still overflow once nothing droppable is
 *   left, shorten them via {@link LEGEND_SHORT_FORMS} in ascending rank
 *   order — never cutting a word in half.
 *
 * @param {{text: string, rank: number}[]} items The legend items, in display
 * order.
 * @param {number} width The column budget the joined legend must fit.
 * @returns {string} The fitted, `" · "`-joined legend.
 */
function fitLegend(items, width) {
  const kept = items.slice();
  let dropped = false;
  const render = () => {
    const joined = kept.map((item) => item.text).join(" · ");
    return dropped ? `${joined} · …` : joined;
  };

  while (tty.displayWidth(render()) > width) {
    let lowest = -1;
    kept.forEach((item, i) => {
      if (item.rank >= LEGEND_ESSENTIAL_RANK) return;
      if (lowest === -1 || item.rank < kept[lowest].rank) lowest = i;
    });
    if (lowest === -1) break;
    kept.splice(lowest, 1);
    dropped = true;
  }

  if (tty.displayWidth(render()) > width) {
    const shortenOrder = kept.map((_, i) => i).sort((a, b) => kept[a].rank - kept[b].rank);
    for (const i of shortenOrder) {
      const shortText = LEGEND_SHORT_FORMS[kept[i].text];
      if (shortText) kept[i] = { ...kept[i], text: shortText };
      if (tty.displayWidth(render()) <= width) break;
    }
  }

  return render();
}

/**
 * Builds the key legend rich mode prints as the last line of every frame,
 * naming only the keys that actually do something in the current mode and
 * fitting it to `state.width` by dropping, then as a last resort
 * shortening, lower-priority items rather than truncating a word in half.
 *
 * @param {{multi: boolean, filterable: boolean, filterMode: boolean, canGoBack: boolean, width: number}} state
 * The frame's mode flags and column budget.
 * @returns {string} The legend, already fit to `state.width`.
 */
function buildLegend(state) {
  return fitLegend(legendItemsFor(state), state.width);
}

/**
 * Renders one rich-mode frame: an optional title, the current selection
 * (multi-select only), a filter line while filter mode is active, the
 * visible slice of the choice list with scroll indicators above and below
 * it when more entries exist off-screen, and a trailing key legend.
 *
 * The title wraps across as many lines as it needs ({@link wrapTitleLines})
 * rather than being cut, and so does each choice's own hint ({@link
 * hintLinesFor}) — a choice whose hint wraps to three lines contributes
 * three lines here, with the marker, number and checkbox only on the first
 * of them. Every line is truncated to `state.width` as a final step — so the
 * returned array's length always equals the number of physical rows the
 * frame occupies, the invariant the redraw arithmetic in {@link runRich}
 * depends on, and which its own viewport sizing ({@link computeWindowCount})
 * must agree with to stay within the terminal's row budget.
 *
 * @param {object} state Rendering state.
 * @param {string} state.title The question text; omitted when empty. May
 * contain embedded newlines, each wrapped as its own paragraph.
 * @param {{value: *, label: string, hint: string}[]} state.allChoices Every
 * choice, unfiltered — used to resolve labels for the selection summary.
 * @param {{value: *, label: string, hint: string}[]} state.entries The
 * choices addressable by navigation right now — every choice, or the
 * filtered subset while filter mode is active.
 * @param {{value: *, label: string, hint: string}[]} state.visible The
 * slice of `entries` currently in the scrolling viewport.
 * @param {number} state.scrollOffset Index into `entries` of `visible[0]`.
 * @param {number} state.highlightIndex Index into `entries` of the
 * highlighted entry.
 * @param {boolean} state.multi Whether this is a multi-select frame.
 * @param {*[]} state.selectedOrder Multi-select only: selected values, in
 * selection order.
 * @param {*} state.defaultValue Single-select only: the default value.
 * @param {boolean} state.filterable Whether `/` can enter filter mode.
 * @param {boolean} state.filterMode Whether filter mode is currently active.
 * @param {string} state.filterText The current filter text.
 * @param {boolean} state.canGoBack Whether the legend should advertise
 * `esc back`.
 * @param {number} state.width The terminal width every line is fit into.
 * @returns {string[]} The frame's lines, one entry per physical screen row.
 */
function renderRichFrame(state) {
  const lines = [];
  if (state.title) lines.push(...wrapTitleLines(state.title, state.width));

  if (state.multi) {
    const summary = state.selectedOrder.length
      ? state.selectedOrder.map((v) => (state.allChoices.find((c) => c.value === v) || { label: String(v) }).label).join(", ")
      : "(none)";
    lines.push(`Selected: ${summary}`);
  }

  if (state.filterMode) {
    lines.push(`Filter: ${state.filterText || "(type to narrow)"}`);
  }

  if (!state.visible.length) {
    lines.push("  (no matches)");
  } else {
    const aboveCount = state.scrollOffset;
    if (aboveCount > 0) lines.push(`  ↑ ${aboveCount} more`);

    const labelTexts = state.visible.map((choice) => labelTextFor(choice, state.multi, state.defaultValue));
    const labelWidth = computeLabelWidth(labelTexts, state.multi, state.width);
    const hintWidth = hintColumnWidth(labelWidth, state.multi, state.width);

    state.visible.forEach((choice, i) => {
      const globalIndex = state.scrollOffset + i;
      const marker = globalIndex === state.highlightIndex ? ">" : " ";
      const numberLabel = i < 9 ? String(i + 1) : "0";
      const checkbox = state.multi ? (state.selectedOrder.includes(choice.value) ? "[x]" : "[ ]") : null;

      // The number, marker and checkbox identify a row's *entry*, not any
      // one of its rendered lines, so they appear only once, on the first
      // line — a continuation line carries blank cells in their place,
      // which `fitRow`'s own padding turns into the aligned indent that
      // keeps the hint column a clean stripe down the left.
      hintLinesFor(choice.hint, hintWidth).forEach((hintLine, li) => {
        const cells = [
          { text: li === 0 ? marker : "", width: 1 },
          { text: li === 0 ? `${numberLabel})` : "", width: 2 },
        ];
        if (state.multi) cells.push({ text: li === 0 ? checkbox : "", width: 3 });
        cells.push({ text: li === 0 ? labelTexts[i] : "", width: labelWidth });
        cells.push({ text: hintLine, grow: true });
        lines.push(tty.fitRow(cells, state.width));
      });
    });

    const belowCount = state.entries.length - (state.scrollOffset + state.visible.length);
    if (belowCount > 0) lines.push(`  ↓ ${belowCount} more`);
  }

  lines.push(buildLegend(state));

  // Padded cells (a choice row's label/hint columns, chiefly) leave trailing
  // spaces on the rendered line; trimming them keeps a captured frame
  // diffable and costs nothing since nothing downstream depends on a line's
  // *exact* width, only its line count (the redraw's erase arithmetic).
  return lines
    .flatMap((line) => String(line).split("\n"))
    .map((line) => tty.truncate(line, state.width).trimEnd());
}

/**
 * Runs one rich-mode prompt: raw-mode keypress navigation, redrawn in place,
 * resolved through a plain callback.
 *
 * Flow:
 * - Up/Down move the highlight within `entries`, wrapping at both ends, and
 *   work in both navigation and filter mode; Home/End jump to the first/last
 *   entry; PageUp/PageDown move by one viewport.
 * - Outside filter mode: a digit jumps the highlight to the entry bearing
 *   that number in the *currently visible* window (`1`-`9`, then `0` for a
 *   tenth); `j`/`k` are Down/Up; `/` (when the list is filterable) enters
 *   filter mode; Space (multi-select only) toggles the highlighted entry;
 *   `a`/`n` (multi-select only) select or clear every entry in `entries`.
 * - Inside filter mode: every printable character, including a digit, `j`
 *   or `k`, extends the filter text instead; Backspace edits it; Space keeps
 *   its navigation-mode meaning on a multi-select prompt and toggles the
 *   highlighted entry rather than extending the filter, so a narrowed list
 *   can still be selected from — at the cost of a filter never carrying a
 *   space of its own; Escape
 *   leaves filter mode (clearing the filter) without cancelling the prompt
 *   — never reported as `canGoBack`'s back gesture, even when that option is
 *   set, since a developer mid-typing there needs the first Escape to undo
 *   that, not leave the whole prompt.
 * - Enter confirms — the highlighted entry for single-select, the
 *   accumulated `selectedOrder` for multi-select — in either mode.
 * - Escape outside filter mode cancels the whole prompt, or — when
 *   `options.canGoBack` is `true` — reports the {@link BACK} outcome
 *   instead, so a caller chaining several prompts can step back to the
 *   previous one. Ctrl-C aborts it, in either mode, reported distinctly so a
 *   caller never treats it as an ordinary cancel-to-default.
 *
 * The scrolling viewport is sized from the output stream's row count each
 * time it might need to change, minus the rows the title, selection summary,
 * filter line and legend actually occupy once wrapped — not a flat per-item
 * count, since a choice whose hint wraps occupies more than one row (see
 * {@link computeWindowCount}) — clamped to {@link MIN_VIEWPORT}/{@link
 * MAX_VIEWPORT} rows, and always follows the highlight — including its wrap
 * from the last entry back to the first.
 *
 * The cursor is hidden for the life of the prompt and raw mode is restored
 * on every exit — a normal confirm, a cancel, an abort, or an exception
 * thrown while handling a keypress or drawing a frame; the cursor is always
 * restored alongside it, best-effort, so a broken output stream during
 * cleanup can never mask the error that triggered it.
 *
 * @param {{title: string, choices: {value:*,label:string,hint:string}[],
 * defaultValue: *, defaultValues: *[], input: NodeJS.ReadStream,
 * output: NodeJS.WritableStream, filterable: boolean, canGoBack: boolean}} options
 * Prepared, already-normalised options. `canGoBack` defaults to `false` when
 * omitted.
 * @param {boolean} multi Whether this is a multi-select prompt.
 * @param {(result: {cancelled: boolean, aborted?: boolean, back?: boolean, value?: *, values?: *[]}) => void} onDone
 * Called once, synchronously from within the confirming keypress's own
 * event.
 * @returns {void}
 */
function runRich(options, multi, onDone) {
  const { input, output, choices, title, filterable } = options;
  const defaultValue = options.defaultValue;
  const defaultValues = Array.isArray(options.defaultValues) ? options.defaultValues : [];
  const canGoBack = !!options.canGoBack;

  let filterText = "";
  let filterMode = false;
  let entries = choices;
  let highlightIndex = Math.max(
    0,
    choices.findIndex((c) => (multi ? defaultValues.includes(c.value) : c.value === defaultValue)),
  );
  let selectedOrder = multi ? choices.filter((c) => defaultValues.includes(c.value)).map((c) => c.value) : [];
  let scrollOffset = 0;
  let viewportSize = MIN_VIEWPORT;
  let printedLines = 0;
  let settled = false;

  /**
   * Recomputes the scrolling viewport from the output stream's current
   * dimensions: how many rows are left for choice entries once the title,
   * selection summary, filter line and legend have each taken their share,
   * then how many entries starting at `scrollOffset` actually fit that row
   * budget ({@link computeWindowCount}) — before reclamping `scrollOffset`
   * itself so `highlightIndex` stays inside the resulting window, following
   * the highlight forward one entry at a time (each step re-measures the
   * window from the new offset, since a wrapped hint can change how many
   * entries fit) or snapping back in one step when it moved above the
   * window, including the wrap from the last entry back to the first.
   *
   * @returns {void}
   */
  function refreshViewport() {
    if (!entries.length) {
      scrollOffset = 0;
      viewportSize = 0;
      return;
    }

    const width = tty.terminalWidth(output);
    const reserved = titleLineCount(title, width) + (multi ? 1 : 0) + (filterMode ? 1 : 0) + 2 /* scroll indicators, reserved either way */ + 1 /* legend */;
    const rowBudget = clamp(tty.terminalRows(output) - reserved, MIN_VIEWPORT, MAX_VIEWPORT);

    if (highlightIndex < scrollOffset) scrollOffset = highlightIndex;

    let window = computeWindowCount(entries.slice(scrollOffset), rowBudget, width, multi, defaultValue);
    while (highlightIndex >= scrollOffset + window.count && scrollOffset < entries.length - 1) {
      scrollOffset += 1;
      window = computeWindowCount(entries.slice(scrollOffset), rowBudget, width, multi, defaultValue);
    }
    viewportSize = window.count;
  }

  /**
   * Recomputes `entries` from the current filter text, preserving which
   * *value* is highlighted across the change when it still matches —
   * clamping to the nearest valid index only when it no longer does — so
   * narrowing, widening or leaving a filter never silently jumps the
   * highlight to an unrelated entry.
   *
   * @returns {void}
   */
  function recomputeEntries() {
    const highlightedValue = entries.length ? entries[highlightIndex].value : undefined;
    entries = filterable ? filterChoices(choices, filterText) : choices;
    const preserved = entries.findIndex((c) => c.value === highlightedValue);
    highlightIndex = preserved >= 0 ? preserved : Math.min(highlightIndex, Math.max(0, entries.length - 1));
    refreshViewport();
  }

  /**
   * Moves the highlight by a relative offset within `entries`, wrapping at
   * both ends.
   *
   * @param {number} delta `-1` for Up, `1` for Down.
   * @returns {void}
   */
  function moveHighlight(delta) {
    if (!entries.length) return;
    highlightIndex = (highlightIndex + delta + entries.length) % entries.length;
    refreshViewport();
  }

  /**
   * Moves the highlight to an absolute index within `entries`, clamped into
   * range.
   *
   * @param {number} index The target index.
   * @returns {void}
   */
  function setHighlight(index) {
    if (!entries.length) {
      highlightIndex = 0;
      return;
    }
    highlightIndex = Math.max(0, Math.min(entries.length - 1, index));
    refreshViewport();
  }

  /**
   * Jumps the highlight to the entry bearing a digit key's number in the
   * *currently visible* window — `1`-`9` for the first nine rows on screen,
   * `0` for a tenth — never an index into a scrolled-away part of the list.
   *
   * @param {string} digit The digit key's name (`"0"`-`"9"`).
   * @returns {void}
   */
  function jumpToDigit(digit) {
    const position = digit === "0" ? 9 : Number(digit) - 1;
    const visibleCount = Math.min(viewportSize, entries.length - scrollOffset);
    if (position >= 0 && position < visibleCount) setHighlight(scrollOffset + position);
  }

  /** Toggles the highlighted entry into or out of `selectedOrder`, appending when turned on. */
  function toggleHighlighted() {
    if (!entries.length) return;
    const v = entries[highlightIndex].value;
    const at = selectedOrder.indexOf(v);
    if (at >= 0) selectedOrder.splice(at, 1);
    else selectedOrder.push(v);
  }

  /** Adds every entry in the current view (`entries`) to `selectedOrder`, appended in list order. */
  function selectAllVisible() {
    for (const c of entries) if (!selectedOrder.includes(c.value)) selectedOrder.push(c.value);
  }

  /** Removes every entry in the current view (`entries`) from `selectedOrder`, leaving any selection outside it untouched. */
  function clearAllVisible() {
    selectedOrder = selectedOrder.filter((v) => !entries.some((c) => c.value === v));
  }

  /** Enters filter mode with an empty filter text. */
  function enterFilterMode() {
    filterMode = true;
    filterText = "";
    recomputeEntries();
  }

  /** Leaves filter mode, clearing the filter text and restoring the full list. */
  function leaveFilterMode() {
    filterMode = false;
    filterText = "";
    recomputeEntries();
  }

  /** Redraws the current frame in place, erasing the previous one first. */
  function draw() {
    if (printedLines > 0) eraseLines(output, printedLines);
    const width = tty.terminalWidth(output);
    refreshViewport();
    const visible = entries.slice(scrollOffset, scrollOffset + viewportSize);
    const lines = renderRichFrame({
      title,
      allChoices: choices,
      entries,
      visible,
      scrollOffset,
      highlightIndex,
      multi,
      selectedOrder,
      defaultValue,
      filterable,
      filterMode,
      filterText,
      canGoBack,
      width,
    });
    output.write(`${lines.join("\n")}\n`);
    printedLines = lines.length;
  }

  /** Removes the keypress listener and restores cooked mode and the cursor, exactly once. */
  function cleanup() {
    input.removeListener("keypress", onKeypress);
    if (typeof input.setRawMode === "function") input.setRawMode(false);
    try {
      output.write(SHOW_CURSOR);
    } catch {
      // Best-effort restore only — a broken output stream must not mask
      // whatever error is already propagating out of the caller.
    }
  }

  /**
   * Ends the prompt, restoring the terminal before reporting the outcome.
   *
   * @param {{cancelled: boolean, aborted?: boolean, back?: boolean, value?: *, values?: *[]}} result
   * The outcome to report.
   * @returns {void}
   */
  function finish(result) {
    if (settled) return;
    settled = true;
    cleanup();
    onDone(result);
  }

  /**
   * Dispatches one keypress event, redrawing or finishing as needed;
   * restores the terminal before rethrowing anything a handler throws.
   *
   * @param {string} str The typed character, when printable.
   * @param {{name?: string, ctrl?: boolean, meta?: boolean}} key The parsed
   * key.
   * @returns {void}
   */
  function onKeypress(str, key) {
    try {
      if (!key) return;

      if (key.ctrl && key.name === "c") {
        finish({ cancelled: false, aborted: true });
        return;
      }

      if (key.name === "escape") {
        if (filterMode) {
          // A developer is clearly mid-typing here — the first Escape must
          // undo that, never step back out of the whole prompt.
          leaveFilterMode();
          draw();
          return;
        }
        if (canGoBack) finish({ cancelled: false, back: true });
        else finish({ cancelled: true });
        return;
      }

      if (key.name === "return") {
        if (multi) finish({ cancelled: false, values: selectedOrder.slice() });
        else finish({ cancelled: false, value: entries.length ? entries[highlightIndex].value : defaultValue });
        return;
      }

      if (key.name === "up") {
        moveHighlight(-1);
        draw();
        return;
      }
      if (key.name === "down") {
        moveHighlight(1);
        draw();
        return;
      }
      if (key.name === "home") {
        setHighlight(0);
        draw();
        return;
      }
      if (key.name === "end") {
        setHighlight(entries.length - 1);
        draw();
        return;
      }
      if (key.name === "pageup") {
        setHighlight(highlightIndex - viewportSize);
        draw();
        return;
      }
      if (key.name === "pagedown") {
        setHighlight(highlightIndex + viewportSize);
        draw();
        return;
      }

      if (!filterMode) {
        if (filterable && str === "/") {
          enterFilterMode();
          draw();
          return;
        }
        if (multi && key.name === "space") {
          toggleHighlighted();
          draw();
          return;
        }
        if (multi && key.name === "a") {
          selectAllVisible();
          draw();
          return;
        }
        if (multi && key.name === "n") {
          clearAllVisible();
          draw();
          return;
        }
        if (key.name === "k") {
          moveHighlight(-1);
          draw();
          return;
        }
        if (key.name === "j") {
          moveHighlight(1);
          draw();
          return;
        }
        if (typeof key.name === "string" && /^[0-9]$/.test(key.name)) {
          jumpToDigit(key.name);
          draw();
          return;
        }
        return;
      }

      if (key.name === "backspace") {
        filterText = filterText.slice(0, -1);
        recomputeEntries();
        draw();
        return;
      }
      // Space toggles inside filter mode too, and is deliberately never
      // appended to the filter text on a multi-select prompt. Narrowing a long
      // list is only useful if something can then be picked out of it, and the
      // legend has always promised `space toggle`; before this, the one key
      // that promise names silently became a filter character instead, leaving
      // scrolling the whole unfiltered list as the only way to select anything.
      // The cost is that a filter can no longer carry a space, so a multi-word
      // label is matched by one of its own words rather than by the phrase —
      // `filterChoices` matches any substring of the label or the value, so
      // one word is always enough to reach it.
      if (multi && key.name === "space") {
        toggleHighlighted();
        draw();
        return;
      }
      if (typeof str === "string" && str.length === 1 && !key.ctrl && !key.meta && str >= " " && str <= "~") {
        filterText += str;
        recomputeEntries();
        draw();
      }
    } catch (err) {
      cleanup();
      throw err;
    }
  }

  readline.emitKeypressEvents(input);
  if (typeof input.setRawMode === "function") input.setRawMode(true);
  input.on("keypress", onKeypress);

  try {
    output.write(HIDE_CURSOR);
    refreshViewport();
    draw();
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * Builds the line-mode question text: the title, a numbered choice list —
 * each entry the default set would apply marked `(default)`, the same
 * marker rich mode renders — then the default prompt.
 *
 * @param {string} title The question text; omitted when empty.
 * @param {{value: *, label: string, hint: string}[]} choices The choices to
 * number.
 * @param {string} defaultLabel The rendered default, shown so pressing Enter
 * alone is a known-safe answer.
 * @param {(choice: {value: *, label: string, hint: string}) => boolean} isDefault
 * Reports whether one choice is part of the default set.
 * @returns {string} The full question text, ending in a trailing space so
 * the developer's typed answer appears on the same line.
 */
function renderLineQuestion(title, choices, defaultLabel, isDefault) {
  const lines = [];
  if (title) lines.push(`\n${title}`);
  choices.forEach((c, i) => {
    const hint = c.hint ? ` — ${c.hint}` : "";
    lines.push(`  ${i + 1}) ${c.label}${hint}${isDefault(c) ? " (default)" : ""}`);
  });
  lines.push(`  [Enter for default: ${defaultLabel}] `);
  return lines.join("\n");
}

/**
 * Resolves one line-mode answer token against the numbered choice list: a
 * 1-based index resolves to that choice's value; anything else is matched
 * literally, case-sensitively, against each choice's own value.
 *
 * @param {string} token The trimmed answer token.
 * @param {{value: *, label: string, hint: string}[]} choices The choice
 * list the token was numbered against.
 * @returns {{matched: boolean, value?: *}} `matched: false` when the token
 * is neither a valid index nor a literal value.
 */
function resolveLineToken(token, choices) {
  if (/^[0-9]+$/.test(token)) {
    const idx = Number(token) - 1;
    if (idx >= 0 && idx < choices.length) return { matched: true, value: choices[idx].value };
    return { matched: false };
  }
  const found = choices.find((c) => String(c.value) === token);
  return found ? { matched: true, value: found.value } : { matched: false };
}

/**
 * Runs one line-mode single-select prompt: prints the numbered list once,
 * then validates each answer strictly against the closed choice set —
 * exactly the `enum` behaviour this replaces, including its retry-then-fall-
 * back-to-default bound, so a piped invalid answer can never hang a run.
 *
 * @param {{title: string, choices: {value:*,label:string,hint:string}[],
 * defaultValue: *, rl: readline.Interface, output: NodeJS.WritableStream}} options
 * Prepared options, already carrying a readline interface to ask on.
 * @param {(result: {cancelled: boolean, value: *}) => void} onDone Called
 * once, synchronously from within the accepting answer's own `line` event.
 * @returns {void}
 */
function runLineSingle(options, onDone) {
  const { title, choices, defaultValue, rl, output } = options;
  const defaultLabel = String(defaultValue);
  const question = renderLineQuestion(title, choices, defaultLabel, (c) => c.value === defaultValue);

  let attempts = 0;
  const ask = () => {
    rl.question(question, (raw) => {
      const answer = String(raw).trim();
      if (!answer) {
        onDone({ cancelled: false, value: defaultValue });
        return;
      }
      const resolved = resolveLineToken(answer, choices);
      if (resolved.matched) {
        onDone({ cancelled: false, value: resolved.value });
        return;
      }
      attempts += 1;
      if (attempts >= LINE_MODE_MAX_ATTEMPTS) {
        output.write(`  using the default "${defaultLabel}" after ${LINE_MODE_MAX_ATTEMPTS} invalid answers\n`);
        onDone({ cancelled: false, value: defaultValue });
        return;
      }
      output.write(`  "${answer}" is not one of the choices — try again.\n`);
      ask();
    });
  };
  ask();
}

/**
 * Runs one line-mode multi-select prompt: prints the numbered list once,
 * then reads a comma-separated list of indices and/or literal text.
 *
 * Never rejects — a token that resolves against the choice list (by index or
 * by an exact literal value match) is replaced with its canonical value; any
 * other token is kept verbatim, the same permissive behaviour the plain
 * `stringList` free-text question already has, so typing an ISO code the
 * shown catalogue labels by name still works exactly as free text always
 * has.
 *
 * @param {{title: string, choices: {value:*,label:string,hint:string}[],
 * defaultValues: *[], rl: readline.Interface}} options Prepared options.
 * @param {(result: {cancelled: boolean, values: *[]}) => void} onDone
 * Called once, synchronously from within the answer's own `line` event.
 * @returns {void}
 */
function runLineMany(options, onDone) {
  const { title, choices, rl } = options;
  const defaultValues = Array.isArray(options.defaultValues) ? options.defaultValues : [];
  const defaultLabel = defaultValues.join(", ") || "(none)";
  const question = renderLineQuestion(title, choices, defaultLabel, (c) => defaultValues.includes(c.value));

  rl.question(question, (raw) => {
    const answer = String(raw).trim();
    if (!answer) {
      onDone({ cancelled: false, values: defaultValues.slice() });
      return;
    }
    if (answer.toLowerCase() === "none") {
      onDone({ cancelled: false, values: [] });
      return;
    }
    const tokens = answer
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    // A non-blank answer is always respected as given, even when it resolves
    // to zero entries — selecting nothing at all is a legitimate, explicit
    // choice (typing "none", or a lone separator), never silently rewritten
    // back to the defaults an empty *line* already means.
    const values = tokens.map((t) => {
      const resolved = resolveLineToken(t, choices);
      return resolved.matched ? resolved.value : t;
    });
    onDone({ cancelled: false, values });
  });
}

/**
 * Fills in every option {@link runRich}/{@link runLineSingle}/{@link runLineMany}
 * need, defaulting `input`/`output` to the real process streams only here —
 * never reached for directly elsewhere in this module — so a caller's fake
 * streams always win.
 *
 * @param {object} options The caller-supplied options.
 * @returns {object} `options` with `choices` normalised and `input`/`output`
 * defaulted.
 */
function prepareOptions(options) {
  const opts = options || {};
  return {
    ...opts,
    choices: normalizeChoices(opts.choices),
    input: opts.input || process.stdin,
    output: opts.output || process.stdout,
  };
}

/**
 * Runs one single-select prompt, reporting the outcome through a plain
 * callback rather than a `Promise` — the shape a caller chaining several
 * prompts on one shared `readline.Interface` must use; see this module's own
 * doc comment for why.
 *
 * @param {{title: string, choices: {value:*,label?:string,hint?:string}[],
 * defaultValue: *, input?: NodeJS.ReadStream, output?: NodeJS.WritableStream,
 * rl?: readline.Interface, canGoBack?: boolean}} options `rl`, when given, is
 * reused for line mode instead of opening and closing a private
 * `readline.Interface` — required when this call is one of several chained
 * on the same stdin, so a previously-buffered answer to a later question is
 * never silently lost to an interface that attached its listener too late
 * (this module's own doc comment). Ignored in rich mode, which never uses
 * `readline.Interface`. `canGoBack` (default `false`) makes Escape outside
 * filter mode report {@link BACK} instead of cancelling — rich mode only,
 * line mode has no back gesture.
 * @param {(result: {cancelled: boolean, aborted?: boolean, back?: boolean, value?: *}) => void} onDone
 * Called once with the outcome — `{cancelled: true}` on Escape,
 * `{cancelled: false, aborted: true}` on Ctrl-C, `{cancelled: false, back: true}`
 * on Escape with `canGoBack: true` (rich mode only, in every case), otherwise
 * `{cancelled: false, value}`.
 * @returns {void}
 */
function selectOneCallback(options, onDone) {
  const prepared = prepareOptions(options);
  if (tty.isInteractive(prepared.input, prepared.output)) {
    runRich({ ...prepared, filterable: prepared.choices.length > FILTER_THRESHOLD }, false, onDone);
    return;
  }
  const rl = prepared.rl || readline.createInterface({ input: prepared.input, output: prepared.output, terminal: false });
  const ownsRl = !prepared.rl;
  runLineSingle({ ...prepared, rl }, (result) => {
    if (ownsRl) rl.close();
    onDone(result);
  });
}

/**
 * Runs one multi-select prompt, reporting the outcome through a plain
 * callback — see {@link selectOneCallback} for why this is the shape a
 * chained caller must use instead of `await`-ing a `Promise` between
 * prompts.
 *
 * @param {{title: string, choices: {value:*,label?:string,hint?:string}[],
 * defaultValues: *[], input?: NodeJS.ReadStream, output?: NodeJS.WritableStream,
 * rl?: readline.Interface, canGoBack?: boolean}} options As {@link
 * selectOneCallback}, with `defaultValues` in place of `defaultValue`.
 * @param {(result: {cancelled: boolean, aborted?: boolean, back?: boolean, values?: *[]}) => void} onDone
 * Called once with the outcome; `values` is in selection order, not
 * catalogue order.
 * @returns {void}
 */
function selectManyCallback(options, onDone) {
  const prepared = prepareOptions(options);
  if (tty.isInteractive(prepared.input, prepared.output)) {
    runRich({ ...prepared, filterable: prepared.choices.length > FILTER_THRESHOLD }, true, onDone);
    return;
  }
  const rl = prepared.rl || readline.createInterface({ input: prepared.input, output: prepared.output, terminal: false });
  const ownsRl = !prepared.rl;
  runLineMany({ ...prepared, rl }, (result) => {
    if (ownsRl) rl.close();
    onDone(result);
  });
}

/**
 * Promise-returning wrapper around {@link selectOneCallback}, for a
 * standalone caller with no burst-buffered chaining to worry about.
 *
 * @param {object} options As {@link selectOneCallback}.
 * @returns {Promise<*>} The chosen value, {@link CANCELLED} when the prompt
 * was cancelled with Escape, {@link ABORTED} when it was aborted with
 * Ctrl-C, or {@link BACK} when it was left with Escape under `canGoBack: true`.
 */
function selectOne(options) {
  return new Promise((resolve) => {
    selectOneCallback(options, (result) => {
      if (result.aborted) resolve(ABORTED);
      else if (result.back) resolve(BACK);
      else resolve(result.cancelled ? CANCELLED : result.value);
    });
  });
}

/**
 * Promise-returning wrapper around {@link selectManyCallback}, for a
 * standalone caller with no burst-buffered chaining to worry about.
 *
 * @param {object} options As {@link selectManyCallback}.
 * @returns {Promise<*[]>} The chosen values in selection order, {@link
 * CANCELLED} when the prompt was cancelled with Escape, {@link ABORTED} when
 * it was aborted with Ctrl-C, or {@link BACK} when it was left with Escape
 * under `canGoBack: true`.
 */
function selectMany(options) {
  return new Promise((resolve) => {
    selectManyCallback(options, (result) => {
      if (result.aborted) resolve(ABORTED);
      else if (result.back) resolve(BACK);
      else resolve(result.cancelled ? CANCELLED : result.values);
    });
  });
}

module.exports = { selectOne, selectMany, selectOneCallback, selectManyCallback, CANCELLED, ABORTED, BACK };
