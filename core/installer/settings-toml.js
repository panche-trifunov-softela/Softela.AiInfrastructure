"use strict";

/**
 * A minimal, confidence-checked TOML editor for Codex's `config.toml`
 * (CONTRACTS §9, INSTALLER.md §5).
 *
 * A real `config.toml` is extensive and hand-maintained, so this never
 * parses it into a full document model and rewrites it — it only locates
 * `[section]` boundaries and top-level `key = value` lines by scanning
 * text, and inserts a missing `seed` key as one new line inside the right
 * section, leaving every other byte untouched. Anything the scan cannot
 * follow confidently — a multi-line string, an array-of-tables — makes it
 * refuse rather than guess, per CONTRACTS §9: "if the file cannot be parsed
 * confidently, skip it and say so."
 */

/**
 * The character `analyze` joins a section path and a key name with, to form
 * each entry in `keys`. A literal U+0000 rather than something printable, so
 * it can never collide with a real section or key name. Exported so any
 * other module that needs to test membership in `analyze(...).keys` —
 * `doctor.js`'s seed-drift detection, currently — builds the exact same
 * string through {@link sectionKeyId} instead of reconstructing it by hand
 * (IMPORTANT I3: doctor.js used to rebuild this with an ordinary space,
 * which never matched anything `analyze` produced and made the drift check
 * permanently dead code).
 */
const KEY_SEP = String.fromCharCode(0);

/**
 * Joins a section path and a key name the same way `analyze` does internally,
 * so a caller can test membership in `analyze(...).keys` without knowing —
 * or risking getting wrong — the join character.
 *
 * @param {string} section The dot-joined section path; `""` for a root key.
 * @param {string} key The key name.
 * @returns {string} The joined membership key.
 */
function sectionKeyId(section, key) {
  return `${section}${KEY_SEP}${key}`;
}

/**
 * Scans a TOML document's lines for section boundaries and the keys
 * already present in each, without interpreting any value.
 *
 * @param {string} content The file's current content; `""` when the file
 * does not exist yet.
 * @returns {
 *   {ok: true, lines: string[], sections: {path: string, start: number, end: number}[], keys: Set<string>}
 *   | {ok: false, reason: string}
 * } On success, `sections` covers the whole file with no gaps — the root
 * section has `path: ""` — and `keys` holds one {@link sectionKeyId} entry
 * for every top-level assignment found. On failure, a one-line reason this
 * installer will not guess past.
 */
function analyze(content) {
  const lines = String(content).split("\n");
  const sections = [];
  let current = { path: "", start: 0 };
  const keys = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.includes("'''") || line.includes('"""')) {
      return { ok: false, reason: "a multi-line string literal makes this file unsafe to edit blindly" };
    }
    if (/^\s*\[\[/.test(line)) {
      return { ok: false, reason: "an array-of-tables ([[...]]) section is not supported" };
    }

    const header = line.match(/^\s*\[([^[\]]+)\]\s*(#.*)?$/);
    if (header) {
      current.end = i;
      sections.push(current);
      current = { path: header[1].trim(), start: i + 1 };
      continue;
    }

    const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*\S.*$/);
    if (assignment) keys.add(sectionKeyId(current.path, assignment[1]));
  }

  current.end = lines.length;
  sections.push(current);
  return { ok: true, lines, sections, keys };
}

/**
 * Splits a settings JSON pointer into the TOML section path and key it
 * names.
 *
 * @param {string} pointer A pointer such as `/agents/default_subagent_model`.
 * @returns {{section: string, key: string}} `section` is the dot-joined
 * path (`""` for a root key); `key` is the final segment.
 */
function pointerToSectionKey(pointer) {
  const segs = String(pointer)
    .split("/")
    .filter((s) => s.length > 0);
  return { section: segs.slice(0, -1).join("."), key: segs[segs.length - 1] };
}

/**
 * Formats a value as a TOML literal.
 *
 * @param {string | number | boolean | Array} value The value to format.
 * @returns {string} A TOML-literal rendering: a quoted, escaped string; a
 * bare number or boolean; or a single-line array of the same.
 */
function formatValue(value) {
  if (typeof value === "string") return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(formatValue).join(", ")}]`;
  return JSON.stringify(value);
}

/**
 * Computes, without mutating anything, whether a `seed` key is already
 * present.
 *
 * @param {string} content The file's current content.
 * @param {string} pointer The settings pointer the key belongs at.
 * @returns {{confident: true, present: boolean, action: "keep" | "write"} | {confident: false, reason: string}}
 * `confident: false` when {@link analyze} could not follow the file; a
 * developer's own key is never reported as absent by guesswork.
 */
function planSeedKey(content, pointer) {
  const parsed = analyze(content);
  if (!parsed.ok) return { confident: false, reason: parsed.reason };
  const { section, key } = pointerToSectionKey(pointer);
  const present = parsed.keys.has(sectionKeyId(section, key));
  return { confident: true, present, action: present ? "keep" : "write" };
}

/**
 * Reads a top-level key's current raw value, confidence-checked the same way
 * {@link planSeedKey} is — never a full TOML value parser (this editor
 * deliberately has none, per the module doc comment), just enough to hand a
 * caller the exact right-hand-side text of a single-line assignment.
 *
 * @param {string} content The file's current content.
 * @param {string} pointer The settings pointer the key belongs at.
 * @returns {
 *   {confident: true, present: boolean, raw: string | null}
 *   | {confident: false, reason: string}
 * } `raw` is the unescaped inner text for a simple double-quoted TOML
 * string, or the exact trimmed right-hand-side text otherwise (a bare
 * number, boolean, array, or anything else this reader does not further
 * interpret); `null` when the key is absent. `confident: false` mirrors
 * {@link analyze} — a value this function cannot read carefully is never
 * guessed at.
 */
function readKeyValue(content, pointer) {
  const parsed = analyze(content);
  if (!parsed.ok) return { confident: false, reason: parsed.reason };
  const { section, key } = pointerToSectionKey(pointer);
  const target = parsed.sections.find((s) => s.path === section);
  if (!target) return { confident: true, present: false, raw: null };

  for (let i = target.start; i < target.end; i++) {
    const match = parsed.lines[i].match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*(#.*)?$/);
    if (!match || match[1] !== key) continue;
    const rhs = match[2].trim();
    const quoted = rhs.match(/^"((?:[^"\\]|\\.)*)"$/);
    const raw = quoted ? quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\") : rhs;
    return { confident: true, present: true, raw };
  }
  return { confident: true, present: false, raw: null };
}

/**
 * Inserts one missing key into its section, appending a new `[section]`
 * block at end of file when the section itself does not exist yet.
 *
 * @param {string} content The file's current content.
 * @param {string} section The dot-joined section path; `""` for a root key.
 * @param {string} key The key name.
 * @param {*} value The value to write.
 * @returns {{ok: true, content: string, written: boolean} | {ok: false, reason: string}}
 * `written: false` when the key was already present and nothing changed.
 */
function insertKey(content, section, key, value) {
  const parsed = analyze(content);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (parsed.keys.has(sectionKeyId(section, key))) return { ok: true, content, written: false };

  const lines = parsed.lines.slice();
  const line = `${key} = ${formatValue(value)}`;
  const target = parsed.sections.find((s) => s.path === section);

  if (target) {
    let insertAt = target.end;
    while (insertAt > target.start && lines[insertAt - 1].trim() === "") insertAt--;
    lines.splice(insertAt, 0, line);
  } else {
    // A genuinely empty file (`content === ""`) still splits into one blank
    // line (`"".split("\n")` is `[""]`, not `[]`) — with nothing above it to
    // separate a brand-new section from, keeping that line would leave a
    // stray leading blank at the top of a file this call is creating fresh.
    const isEmptyFile = lines.length === 1 && lines[0] === "";
    if (isEmptyFile) lines.length = 0;
    else if (lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(`[${section}]`, line);
  }

  return { ok: true, content: lines.join("\n"), written: true };
}

/**
 * Writes every still-absent `seed` key from a list, in order, preserving
 * everything else in the file byte-for-byte.
 *
 * @param {string} content The file's current content; `""` when the file
 * does not exist yet.
 * @param {{pointer: string, value: *}[]} entries The seed settings to
 * apply.
 * @returns {
 *   {ok: true, content: string, written: string[], skipped: string[]}
 *   | {ok: false, reason: string, written: string[], skipped: string[]}
 * } `written` and `skipped` list pointers, in the order given; `ok: false`
 * stops at the first entry {@link analyze} could not follow confidently,
 * carrying whatever succeeded before it.
 */
function writeSeedKeys(content, entries) {
  let current = typeof content === "string" ? content : "";
  const written = [];
  const skipped = [];

  for (const entry of Array.isArray(entries) ? entries : []) {
    const { section, key } = pointerToSectionKey(entry.pointer);
    const result = insertKey(current, section, key, entry.value);
    if (!result.ok) return { ok: false, reason: result.reason, written, skipped };
    current = result.content;
    if (result.written) written.push(entry.pointer);
    else skipped.push(entry.pointer);
  }

  return { ok: true, content: current, written, skipped };
}

module.exports = { KEY_SEP, sectionKeyId, analyze, pointerToSectionKey, formatValue, planSeedKey, readKeyValue, insertKey, writeSeedKeys };
