"use strict";

/**
 * Manages the delimited text block the installer owns inside a file it does
 * not otherwise control (CONTRACTS §9 "Managed text blocks", INSTALLER.md
 * §6 for the per-repository pointer, and the global `AGENTS.md` a host
 * template installs).
 *
 * Content outside the markers is preserved verbatim, always. When the
 * markers are absent the block is appended rather than the file being
 * replaced — this module never assumes it owns a file just because it is
 * about to write into it. The same caution applies once markers ARE
 * present: the text between them is arbitrary developer-authored prose that
 * may itself quote either marker verbatim — documenting this very tool is
 * the obvious way that happens — so every marker occurrence in the file is
 * counted before any is trusted. Only a file carrying exactly one `BEGIN`
 * and one `END`, in that order, is ever read from or written to; anything
 * else throws {@link AmbiguousBlockError} rather than guessing which
 * occurrence is the region this installer actually wrote.
 */

/** Opens the region this installer owns inside a shared file. */
const BEGIN = "<!-- BEGIN softela-ai (managed — edits here are overwritten on update) -->";

/** Closes the region this installer owns inside a shared file. */
const END = "<!-- END softela-ai -->";

/**
 * Raised when a file's marker occurrences cannot be unambiguously attributed
 * to a single region this installer owns — more or less than one literal
 * `BEGIN`, more or less than one literal `END`, or an `END` appearing before
 * its `BEGIN`. Every one of those shapes means guessing which occurrence is
 * real would risk destroying or stranding content a developer wrote, so the
 * operation is refused instead (`managed-block.js`'s own module doc).
 */
class AmbiguousBlockError extends Error {
  /**
   * @param {{index: number, line: number}[]} beginHits Every literal `BEGIN`
   * occurrence found, in file order.
   * @param {{index: number, line: number}[]} endHits Every literal `END`
   * occurrence found, in file order.
   */
  constructor(beginHits, endHits) {
    const describe = (label, hits) =>
      hits.length ? `${label} at line ${hits.map((h) => h.line).join(", ")}` : `no ${label}`;
    super(
      `cannot safely locate the softela-ai managed block: found ${describe("BEGIN", beginHits)} and ${describe("END", endHits)} — ` +
        "refusing to update rather than guess which one is this installer's own; " +
        "resolve the extra marker text by hand (e.g. quote it differently if it is a developer note, " +
        "not a literal copy of the delimiter) and re-run",
    );
    this.name = "AmbiguousBlockError";
    /** 1-based line numbers of every `BEGIN` occurrence found. */
    this.beginLines = beginHits.map((h) => h.line);
    /** 1-based line numbers of every `END` occurrence found. */
    this.endLines = endHits.map((h) => h.line);
  }
}

/**
 * Finds every occurrence of a literal marker string in `content`.
 *
 * @param {string} content The text to search.
 * @param {string} marker The literal marker text (`BEGIN` or `END`).
 * @returns {{index: number, line: number}[]} One entry per occurrence, in
 * file order — `index` is the byte offset, `line` the 1-based line number.
 */
function markerHits(content, marker) {
  const hits = [];
  let from = 0;
  for (;;) {
    const index = content.indexOf(marker, from);
    if (index === -1) break;
    const line = content.slice(0, index).split("\n").length;
    hits.push({ index, line });
    from = index + marker.length;
  }
  return hits;
}

/**
 * Locates the single managed block this installer owns inside a text
 * buffer — matched only when it can be unambiguously attributed: exactly
 * one literal `BEGIN`, exactly one literal `END`, with `BEGIN` before `END`.
 * A greedy "first `BEGIN` to last `END`" scan (an earlier version of this
 * function) treats the delimiters as a reliable frame even though the text
 * between them is developer-authored and may quote either marker anywhere
 * in the file — the exact shape that let a developer's own prose destroy or
 * strand content this installer never touched.
 *
 * @param {string} content The text to search.
 * @returns {{start: number, end: number} | null} The block's start offset
 * and its end offset (exclusive, just past `END`); `null` when neither
 * marker appears anywhere in `content`.
 * @throws {AmbiguousBlockError} When the markers cannot be attributed to a
 * single region — see the class doc.
 */
function locateBlock(content) {
  const beginHits = markerHits(content, BEGIN);
  const endHits = markerHits(content, END);
  if (beginHits.length === 0 && endHits.length === 0) return null;

  if (beginHits.length === 1 && endHits.length === 1 && beginHits[0].index < endHits[0].index) {
    return { start: beginHits[0].index, end: endHits[0].index + END.length };
  }

  throw new AmbiguousBlockError(beginHits, endHits);
}

/**
 * Extracts the text between a template's own markers.
 *
 * @param {string} templateContent A shipped template's substituted content.
 * @returns {string} The text between `BEGIN` and `END`, trimmed; the whole
 * template, trimmed, when it carries no markers of its own.
 * @throws {AmbiguousBlockError} When `templateContent` carries more than one
 * `BEGIN` or `END` — a bug in the shipped template itself, never expected
 * in practice, since a template's markers are entirely under this
 * repository's own control.
 */
function extractBody(templateContent) {
  const span = locateBlock(templateContent);
  if (!span) return templateContent.trim();
  return templateContent.slice(span.start + BEGIN.length, span.end - END.length).trim();
}

/**
 * Checks whether a file's content already carries a managed block.
 *
 * @param {string} content The file's current content.
 * @returns {boolean} `true` when exactly one `BEGIN`/`END` pair is present;
 * `false` when neither marker appears at all.
 * @throws {AmbiguousBlockError} When the markers are present but cannot be
 * attributed to a single region — answering `true` or `false` would itself
 * be a guess at that point, so this is refused the same way {@link
 * upsertBlock} and {@link removeBlock} refuse to operate on the same input.
 */
function hasBlock(content) {
  if (typeof content !== "string") return false;
  return locateBlock(content) !== null;
}

/**
 * Inserts or replaces the managed block inside a file's content.
 *
 * @param {string} existingContent The file's current content; `""` when the
 * file does not yet exist.
 * @param {string} blockBody The text to place between the markers, without
 * the markers themselves.
 * @returns {{content: string, changed: boolean}} The new content, and
 * whether it differs from `existingContent`. When markers are present the
 * block between them is replaced; otherwise the block is appended, on its
 * own blank line, and the file is never otherwise altered.
 * @throws {AmbiguousBlockError} When `existingContent`'s markers cannot be
 * attributed to a single region this installer owns (see {@link
 * locateBlock}), or when the content this call is about to write would
 * itself become ambiguous — checked by parsing the write's own result back
 * out before returning it, so a corrupted write is never handed to a caller.
 */
function upsertBlock(existingContent, blockBody) {
  const body = String(blockBody).trim();
  const full = `${BEGIN}\n\n${body}\n\n${END}`;
  const current = typeof existingContent === "string" ? existingContent : "";

  const span = locateBlock(current);
  let content;
  if (span) {
    content = current.slice(0, span.start) + full + current.slice(span.end);
  } else if (!current.trim()) {
    content = `${full}\n`;
  } else {
    const sep = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    content = `${current}${sep}${full}\n`;
  }

  // Round-trip guard: parse the content back out before handing it to the
  // caller. `locateBlock` above already throws if the result is ambiguous;
  // this additionally catches the (should-be-impossible, but never assumed)
  // case where it parses cleanly yet does not yield back the exact block
  // this call just wrote.
  const written = locateBlock(content);
  if (!written || content.slice(written.start, written.end) !== full) {
    throw new AmbiguousBlockError(markerHits(content, BEGIN), markerHits(content, END));
  }

  return { content, changed: content !== current };
}

/**
 * Applies a shipped template to a file: writes it verbatim when the file
 * does not exist yet, otherwise upserts only the template's own managed
 * block into the file's existing content.
 *
 * @param {string | null} existingContent The file's current content, or
 * `null` when the file does not exist.
 * @param {string} templateContent The shipped template's substituted
 * content.
 * @returns {{content: string, changed: boolean}} The new content, and
 * whether it differs from what is on disk today.
 * @throws {AmbiguousBlockError} See {@link upsertBlock}.
 */
function applyTemplate(existingContent, templateContent) {
  if (existingContent === null || existingContent === undefined || existingContent.trim() === "") {
    const fresh = templateContent.endsWith("\n") ? templateContent : `${templateContent}\n`;
    return { content: fresh, changed: existingContent !== fresh };
  }
  return upsertBlock(existingContent, extractBody(templateContent));
}

/**
 * Removes the managed block, and up to one surrounding blank line on each
 * side, from a file's content.
 *
 * The trimming is done with index arithmetic over `locateBlock`'s offsets
 * rather than a regular expression built from the block's own text. A
 * verbatim-standards block can run past a hundred kilobytes, and compiling
 * that much literal text into a pattern — solely to trim one optional
 * newline and a run of spaces or tabs around it — exceeds the regex
 * engine's own size limit and throws. Offsets and `slice` have no such
 * limit, so the same trimming is done directly on the string instead.
 *
 * @param {string} content The file's current content.
 * @returns {{content: string, changed: boolean}} The content with the block
 * removed, collapsing any run of three or more resulting blank lines down
 * to one; `changed: false` and the original content when no block is
 * present.
 * @throws {AmbiguousBlockError} When `content`'s markers cannot be
 * attributed to a single region this installer owns (see {@link
 * locateBlock}), or — as a round-trip guard — when the text left behind
 * after removal still parses as carrying a block.
 */
function removeBlock(content) {
  const current = typeof content === "string" ? content : "";
  const span = locateBlock(current);
  if (!span) return { content: current, changed: false };

  let leadStart = span.start;
  while (leadStart > 0 && (current[leadStart - 1] === " " || current[leadStart - 1] === "\t")) {
    leadStart--;
  }
  if (leadStart > 0 && current[leadStart - 1] === "\n") {
    leadStart--;
  }

  let trailEnd = span.end;
  if (current[trailEnd] === "\n") {
    trailEnd++;
  }

  const withoutBlock = current.slice(0, leadStart) + "\n" + current.slice(trailEnd);
  const collapsed = withoutBlock.replace(/\n{3,}/g, "\n\n");

  if (locateBlock(collapsed) !== null) {
    throw new AmbiguousBlockError(markerHits(collapsed, BEGIN), markerHits(collapsed, END));
  }

  return { content: collapsed, changed: true };
}

module.exports = { BEGIN, END, AmbiguousBlockError, hasBlock, extractBody, upsertBlock, applyTemplate, removeBlock };
