"use strict";

/**
 * Decodes a host tool-call payload into the individual file writes it
 * performs, so a content-inspecting rule sees the same evidence regardless of
 * which envelope the host happened to wrap it in.
 *
 * `core/lib/context.js#buildContext` only ever reads `file_path`/`content` off
 * the top-level tool input. That is exactly right for `Write` and `Edit`, and
 * exactly wrong for `MultiEdit` (whose text lives inside an `edits[]` array)
 * and for `apply_patch` (whose Codex envelope carries a patch string under
 * `input`, `patch` or `changes` rather than a `file_path`/`content` pair at
 * all) — on those shapes `ctx.filePath`/`ctx.content` come back empty and
 * every content-based rule goes silently inert. This module is the fix:
 * `decodeWrites` reconstructs `{path, content, kind}` for every file a call
 * actually touches, so the caller (`adapters/shared/dispatch-core.js`) can
 * judge each one the same way it already judges a plain `Write` call.
 *
 * A wrong reconstruction is worse than a missing one — it would make a
 * content rule judge text that was never written. Every reconstruction path
 * here fails to `content: null` rather than guess: an unmatched `old_string`,
 * a hunk whose context cannot be located in the current file, a read that
 * comes back `null`, or a sub-shape this module does not recognise all take
 * that path. `null` is safe because the engine's rules key off `ctx.content`
 * as an ordinary string default — a write with unreconstructable content
 * still fires a path-only rule (folder shape, test location) while a
 * content-only rule simply has nothing to look at, exactly as it would for
 * any other empty-content call.
 *
 * Every entry this module returns also carries `pathBase`, naming which
 * directory `path` is relative to when it is not already absolute:
 * `"cwd"` for a path taken straight off a tool's own payload (`Write`,
 * `Edit`, `MultiEdit`, `NotebookEdit`, and `apply_patch`'s already-working
 * `{file_path, content}` shape — every one of these is exactly the path a
 * host would have sent a direct `Write` call, cwd-relative by the same
 * convention `core/lib/context.js#buildContext` already resolves against);
 * `"repoRoot"` for a path parsed out of a patch envelope's own text (a
 * `*** Update File:` header, a `changes` entry) — conventionally relative to
 * the repository root regardless of which directory the agent process
 * happens to be running in. The caller (`adapters/shared/dispatch-core.js#buildWriteContext`)
 * is the one that actually resolves against the named base; this module only
 * tags which base is correct.
 *
 * The RECONSTRUCTION reader passed into {@link decodeWrites} follows the
 * same split: `options.readFile` for a `"cwd"`-tagged path, and a SEPARATE
 * `options.readFileRepoRoot` for a `"repoRoot"`-tagged one. A single reader
 * anchored on `cwd` used for both would read a `"repoRoot"`-tagged path's
 * OWN existing content from the wrong directory the moment `cwd` is a
 * subdirectory of the repository — resolving the same relative string
 * against a different base than the one it was actually written against,
 * silently reconstructing from an unrelated file instead of failing to
 * `null`. See `adapters/shared/dispatch-core.js#evaluateDecodedWrites` for
 * how the two readers are built.
 *
 * A STAT capability follows the same `"cwd"`/`"repoRoot"` split, one level
 * up: `options.statFileRepoRoot` (defaulting to `options.statFile` when
 * omitted, exactly like `readFileRepoRoot` defaults to `readFile`) answers a
 * path's own byte size without reading it, so `applyHunksToFile` can charge
 * an UPDATE section's existing file against the reconstruction budget before
 * ever reading it — see that function's own doc comment for why this matters
 * (a single existing tracked file bigger than the whole budget used to be
 * read into memory in full regardless of its own size) and for exactly what
 * happens when no stat capability is supplied at all.
 *
 * Also, an edit-shaped entry (`Edit`, `MultiEdit`) carries `insertedText`:
 * the text the write actually inserts, as opposed to `content`, which this
 * module always reconstructs as the whole resulting file. The caller keeps
 * both apart on `ctx` too — see `core/lib/context.js`'s own doc block on
 * `ctx.content` vs `ctx.resultingContent`.
 */

/** Tool names, on either host, whose payload names at least one file write. */
const WRITE_TOOL_NAME_RE = /^(write|edit|multiedit|notebookedit|apply_patch|write_file|edit_file)$/i;

/** Opens a patch envelope; the file sections in between are parsed by {@link parsePatchSections}. */
const PATCH_BLOCK_RE = /\*\*\* Begin Patch([\s\S]*?)\*\*\* End Patch/g;

/** Names the target of one file section inside a patch envelope. */
const PATCH_FILE_HEADER_RE = /^\*\*\* (Add File|Update File|Delete File): (.+)$/;

/**
 * Names a section's rename destination — Codex's own spelling for a move
 * inside an `Update File` section, appearing on its own line right after the
 * header and before any hunk.
 */
const PATCH_MOVE_TO_RE = /^\*\*\* Move to: (.+)$/;

/**
 * The complete set of `*** `-prefixed structural markers the V4A patch
 * grammar defines — verified directly against the real Codex binary
 * (`codex.exe`, scanned for patch-grammar string constants), not inferred
 * from any generated sample. This is the single list that decides what
 * {@link parsePatchSections} tolerates inside a hunk versus what it treats
 * as genuinely unknown grammar: every marker named here is either matched by
 * one of the dedicated regexes above (`PATCH_BLOCK_RE`, `PATCH_FILE_HEADER_RE`,
 * `PATCH_MOVE_TO_RE`) or by {@link PATCH_END_OF_FILE_RE} below. A future
 * Codex version growing a new marker is added HERE, in this one place —
 * `tests/lib/write-decode.test.js`'s own pin test fails the moment this
 * array's content changes without a matching update to that test, so the
 * addition is always a deliberate, reviewed one, never an accidental gap
 * that quietly widens what "ambiguous" catches.
 */
const KNOWN_PATCH_MARKERS = Object.freeze([
  "*** Begin Patch",
  "*** End Patch",
  "*** Add File:",
  "*** Update File:",
  "*** Delete File:",
  "*** Move to:",
  "*** End of File",
]);

/**
 * Marks the end of a hunk's own trailing context when it runs to the end of
 * the file being patched — real V4A grammar punctuation (see
 * {@link KNOWN_PATCH_MARKERS}), not a header and not hunk content. Written on
 * its own line directly after a hunk's last line; carries no path or other
 * payload, so it is matched by exact equality rather than a prefix.
 */
const PATCH_END_OF_FILE_RE = /^\*\*\* End of File$/;

/**
 * Strips a single trailing `\r` off one already-`"\n"`-split line.
 *
 * The patch grammar's own protocol lines — `*** Begin/End Patch`, a file
 * header, `*** Move to:`, a `@@` hunk marker — are matched with `^…$`
 * patterns whose `.` never matches `\r` (CONTRACTS-adjacent JS regex
 * behaviour), so a single stray `\r\n` line ending anywhere in the envelope
 * — the whole thing CRLF-joined, or just one header line carrying a `\r`
 * because it originated from a CRLF source — used to make that one line
 * invisible to every classification below, silently dropping its whole
 * section. Called on every split line before any classification, so a `\r`
 * is treated purely as line-terminator noise, never as part of a line's own
 * value — matching how this module already treats the one artifact `\n`
 * `PATCH_BLOCK_RE` captures right before `*** End Patch` (see
 * `parsePatchSections`'s own `trimmedBody` comment).
 *
 * @param {string} line One line, already split on `"\n"`.
 * @returns {string} `line` with its own trailing `\r` removed, if it had one.
 */
function stripTrailingCR(line) {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * The most files a single decode pass will spend actually reconstructing
 * content for (applying hunks, or copying a direct `content` field), before
 * every remaining file falls back to path-only decoding (`content: null`).
 * A path-only entry still fires a path rule (folder shape, protected paths);
 * only a content rule goes quiet for the files past this ceiling — and a
 * content rule going quiet is not a partial answer, it is the rule returning
 * `pass` on a write it never actually looked at. 800 was tight enough that a
 * large, entirely legitimate multi-file patch (a rename sweep, a generated
 * barrel update touching every folder) could run past it and go unreviewed
 * by every content-based rule for no reason connected to any real cost.
 *
 * Raised further, to 5000, against a real measurement rather than another
 * guess: 5000 files (an `add`-file patch, and separately 5000 `update`
 * sections each reconstructed against 10 KB of realistic existing content)
 * decode in 24-25 ms on this machine — indistinguishable from noise next to
 * the real `HOOK_TIMEOUT_SECONDS` budget both hosts actually enforce on
 * every hook registration (`core/installer/plan.js`, 30 seconds). A hook
 * that runs past its timeout is simply treated as having enforced nothing,
 * exactly the failure this whole module exists to end — so headroom this
 * cheap is free to take.
 */
const MAX_RECONSTRUCT_FILES = 5000;

/**
 * The most combined bytes of hunk/content text a single decode pass will
 * reconstruct across every file, protecting against a small number of very
 * large files that {@link MAX_RECONSTRUCT_FILES} alone would not catch —
 * the same `HOOK_TIMEOUT_SECONDS` hook budget, guarded from the other
 * direction. Once this ceiling is crossed, every remaining file in the pass
 * degrades to path-only decoding: not a smaller answer, but a content rule
 * silently returning `pass` on a write it never actually inspected. 8 MB let
 * an ordinary large-but-legitimate tracked file (a generated lockfile, a
 * bundled asset, a sizeable data fixture) exhaust the budget on its own and
 * blind every content rule to whatever else the same call touched.
 *
 * Raised to 64 MB against a real measurement: the expensive path this
 * ceiling actually guards — {@link applyHunksToFile}'s UPDATE reconstruction,
 * reading, splitting and searching an already-large existing file — cost
 * 419 ms at 64 MB on this machine, next to nothing against the real
 * `HOOK_TIMEOUT_SECONDS` budget both hosts actually enforce on every hook
 * registration (`core/installer/plan.js`, 30 seconds). A hook that runs
 * past its timeout is simply treated as having enforced nothing, exactly the
 * failure this whole module exists to end — so this class of file no longer
 * starves the rest of the pass for a fraction of the budget it can safely
 * spend.
 *
 * Charged on the REAL bytes a reconstruction step actually works with, not
 * on the hunk's own added/removed line text: for {@link applyHunksToFile}
 * that is the size of the file `readFile` loads, splits and searches — a
 * patch carrying a two-line diff against an already-huge tracked file is
 * exactly as expensive as reconstructing that whole file from scratch, and a
 * budget measured from the tiny diff text alone would never catch it. The
 * `add`/`changes` paths already reconstruct from text whose own size IS the
 * real cost (there is no existing file to read), so they keep charging their
 * own content length directly.
 */
const MAX_RECONSTRUCT_BYTES = 64_000_000;

/**
 * Builds a per-decode-call budget that gates how much reconstruction work
 * {@link decodePatchText} and {@link decodeChanges} are willing to do, so a
 * pathological patch degrades to path-only decoding instead of spending
 * unbounded time on `readFile` calls and hunk searches.
 *
 * @returns {{
 *   take: (estimatedBytes: number) => boolean,
 *   reserve: () => boolean,
 *   chargeBytes: (n: number) => boolean,
 * }} `take` records one more file's worth of reconstruction work, in one
 * step, when its size is already known up front (an `add` section's own
 * added text, a `changes` entry's own direct content) and reports whether it
 * still fits inside the budget. `reserve`/`chargeBytes` split that into two
 * steps for a reconstruction that must read an existing file to learn its
 * size: `reserve` claims a file slot and checks the budget BEFORE any bytes
 * of this file are read — so a file past an already-exhausted budget is
 * skipped before its own `readFile` call, not after — and `chargeBytes`
 * records the file's real size once it is known, so the NEXT file's
 * `reserve` call sees the true cumulative cost. `chargeBytes` ALSO reports
 * whether the pass is still within budget immediately after recording this
 * file's own bytes — the caller ({@link applyHunksToFile}) uses that return
 * value to stop working on THIS SAME file the moment its own size alone (or
 * combined with what came before it) is already too much, rather than only
 * ever finding out via the next file's `reserve` call. Every method keeps
 * returning `false` once the ceiling is crossed, for the rest of this decode
 * pass.
 */
function createReconstructBudget() {
  let files = 0;
  let bytes = 0;
  const overBudget = () => files >= MAX_RECONSTRUCT_FILES || bytes >= MAX_RECONSTRUCT_BYTES;
  return {
    take(estimatedBytes) {
      if (overBudget()) return false;
      files += 1;
      bytes += estimatedBytes;
      return true;
    },
    reserve() {
      if (overBudget()) return false;
      files += 1;
      return true;
    },
    chargeBytes(n) {
      bytes += Math.max(0, n || 0);
      return !overBudget();
    },
  };
}

/**
 * Tests whether a tool name is one whose payload names at least one file
 * write, on either host's own naming.
 *
 * @param {string} toolName The tool name from `ctx.toolName`.
 * @returns {boolean} `true` when the name matches a known write-shaped tool.
 */
function isWriteToolName(toolName) {
  return WRITE_TOOL_NAME_RE.test(String(toolName || ""));
}

/**
 * Picks the first non-empty string among candidates. Mirrors
 * `core/lib/context.js#firstString` so a field alias resolves the same way
 * in both places.
 *
 * @param {...*} vals Candidate values.
 * @returns {string} The first non-empty string, or `""` when none qualify.
 */
function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.length) return v;
  }
  return "";
}

/**
 * Picks the first candidate that is a string at all, including `""` — unlike
 * {@link firstString}, an empty string is a legitimate answer here (a write
 * whose new content genuinely is an empty file), so it must be told apart
 * from "no candidate was a string".
 *
 * @param {...*} vals Candidate values.
 * @returns {string | null} The first string candidate, or `null` when none of
 * them is a string.
 */
function firstDefinedString(...vals) {
  for (const v of vals) {
    if (typeof v === "string") return v;
  }
  return null;
}

/**
 * Reads the target path a write payload names, tolerating every alias this
 * repository's own `context.js` already tolerates, plus `notebook_path` for
 * `NotebookEdit`.
 *
 * @param {object} inp The tool input.
 * @returns {string} The path, or `""` when none of the aliases is present.
 */
function pickPath(inp) {
  return firstString(inp.file_path, inp.filePath, inp.path, inp.target_file, inp.notebook_path);
}

/**
 * Reads the patch text out of an `apply_patch` payload's own `command` field.
 *
 * This is the field the real Codex binary actually uses. Measured on Codex
 * 0.149.1 (Windows) by capturing a live `PreToolUse` payload off the real
 * host, not inferred:
 *
 * ```json
 * {"tool_name":"apply_patch",
 *  "tool_input":{"command":"*** Begin Patch\n*** Update File: foo.txt\n@@\n-hello\n+world\n*** End Patch"}}
 * ```
 *
 * Until this was measured, {@link decodeApplyPatch} looked only at `input`,
 * `patch`, `changes` and the direct `{file_path, content}` pair, so EVERY
 * patch Codex wrote decoded to `[]` and came back as the unrecognised-shape
 * decision — which on Codex is a hard denial. That is not a rule catching a
 * mistake; it is this decoder being one field name behind the host, and it
 * blocked the agent outright.
 *
 * Both spellings are accepted. The binary also documents an argv form
 * (`Rerun as ["apply_patch", "<patch>"]`), so an array is joined the same way
 * `core/lib/context.js#pickCommand` joins one — the last element carrying the
 * envelope is what matters, and joining keeps a payload that splits the
 * envelope across elements readable rather than dropping it.
 *
 * @param {object} inp The tool input.
 * @returns {string | null} The patch text, or `null` when `command` is
 * absent or is neither a string nor an array of them.
 */
function pickPatchCommand(inp) {
  const c = inp.command;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts = c.filter((x) => typeof x === "string");
    return parts.length ? parts.join("\n") : null;
  }
  return null;
}

/**
 * Replaces `oldStr` inside `text` with `newStr`, honouring a `replace_all`
 * flag the same way the real `Edit`/`MultiEdit` tools do: the first
 * occurrence only when `all` is falsy, every occurrence when it is truthy.
 *
 * `all` uses a plain `split`/`join` rather than a regular expression, so an
 * `oldStr` containing regex metacharacters is matched literally, exactly as
 * the real tool matches it.
 *
 * @param {string} text The text to search and replace within.
 * @param {string} oldStr The text to find.
 * @param {string} newStr The text to substitute in its place.
 * @param {boolean} all `true` to replace every occurrence, `false` for the
 * first only.
 * @returns {string | null} The resulting text, or `null` when `oldStr` does
 * not occur in `text` at all.
 */
function applyReplacement(text, oldStr, newStr, all) {
  const idx = text.indexOf(oldStr);
  if (idx === -1) return null;
  if (!all) return text.slice(0, idx) + newStr + text.slice(idx + oldStr.length);
  return text.split(oldStr).join(newStr);
}

/**
 * Decodes a `Write`/`write_file`-shaped payload: a target path and the full
 * replacement content.
 *
 * @param {object} inp The tool input.
 * @param {(p: string) => string | null} readFile Reads a file's current
 * content, `null` when it cannot be read.
 * @returns {Array<{path: string, content: string, kind: "add"|"update", pathBase: "cwd"}>}
 * One entry, or `[]` when the payload names no path or no content field at
 * all.
 */
function decodeFullReplace(inp, readFile) {
  const path = pickPath(inp);
  if (!path) return [];

  const content = firstDefinedString(inp.content, inp.new_string, inp.newString, inp.new_str);
  if (content === null) return [];

  const existing = readFile(path);
  return [{ path, content, kind: existing === null ? "add" : "update", pathBase: "cwd" }];
}

/**
 * Decodes an `Edit`/`edit_file`-shaped payload: a target path and one
 * old/new string pair, applied against the file's current content. Honours
 * a `replace_all` flag, replacing every occurrence of `old_string` rather
 * than only the first when the payload sets it.
 *
 * @param {object} inp The tool input.
 * @param {(p: string) => string | null} readFile Reads a file's current
 * content, `null` when it cannot be read.
 * @returns {Array<{path: string, content: string | null, insertedText: string, kind: "update", pathBase: "cwd"}>}
 * One entry, or `[]` when the payload names no path, or no old/new string
 * pair at all. `content` is `null` when the file cannot be read or
 * `old_string` is not found in it — never a guessed reconstruction.
 * `insertedText` is always the payload's own `new_string`, independent of
 * whether the full-file reconstruction succeeded.
 */
function decodeEdit(inp, readFile) {
  const path = pickPath(inp);
  const oldStr = firstDefinedString(inp.old_string, inp.oldString, inp.old_str);
  const newStr = firstDefinedString(inp.new_string, inp.newString, inp.new_str);
  if (!path || oldStr === null || newStr === null) return [];
  const replaceAll = inp.replace_all === true || inp.replaceAll === true;

  const existing = readFile(path);
  if (existing === null) {
    return [{ path, content: null, insertedText: newStr, kind: "update", pathBase: "cwd" }];
  }

  const content = applyReplacement(existing, oldStr, newStr, replaceAll);
  return [{ path, content, insertedText: newStr, kind: "update", pathBase: "cwd" }];
}

/**
 * Decodes a `MultiEdit`-shaped payload: a target path and an ordered list of
 * old/new string pairs, applied against the file's current content in
 * sequence — each edit sees the previous edit's own result, exactly as the
 * real tool applies them. Each edit's own `replace_all` flag is honoured
 * independently, exactly as `decodeEdit` honours it for a single edit.
 *
 * @param {object} inp The tool input.
 * @param {(p: string) => string | null} readFile Reads a file's current
 * content, `null` when it cannot be read.
 * @returns {Array<{path: string, content: string | null, insertedText: string, kind: "update", pathBase: "cwd"}>}
 * One entry, or `[]` when the payload names no path or no `edits` array at
 * all. `content` is `null` the moment any edit in the sequence cannot be
 * applied — a partially-applied reconstruction is exactly the wrong guess
 * this module exists to avoid. `insertedText` is every edit's own
 * `new_string`, joined in encounter order, independent of whether the
 * full-file reconstruction succeeded.
 */
function decodeMultiEdit(inp, readFile) {
  const path = pickPath(inp);
  const edits = Array.isArray(inp.edits) ? inp.edits : null;
  if (!path || !edits || edits.length === 0) return [];

  const insertedParts = [];
  for (const raw of edits) {
    const edit = raw && typeof raw === "object" ? raw : {};
    const newStr = firstDefinedString(edit.new_string, edit.newString, edit.new_str);
    if (newStr !== null) insertedParts.push(newStr);
  }
  const insertedText = insertedParts.join("\n");

  const existing = readFile(path);
  if (existing === null) {
    return [{ path, content: null, insertedText, kind: "update", pathBase: "cwd" }];
  }

  let content = existing;
  for (const raw of edits) {
    const edit = raw && typeof raw === "object" ? raw : {};
    const oldStr = firstDefinedString(edit.old_string, edit.oldString, edit.old_str);
    const newStr = firstDefinedString(edit.new_string, edit.newString, edit.new_str);
    if (oldStr === null || newStr === null) {
      return [{ path, content: null, insertedText, kind: "update", pathBase: "cwd" }];
    }

    const replaceAll = edit.replace_all === true || edit.replaceAll === true;
    const next = applyReplacement(content, oldStr, newStr, replaceAll);
    if (next === null) {
      return [{ path, content: null, insertedText, kind: "update", pathBase: "cwd" }];
    }
    content = next;
  }

  return [{ path, content, insertedText, kind: "update", pathBase: "cwd" }];
}

/**
 * Decodes a `NotebookEdit`-shaped payload. Only the target path is decoded —
 * reconstructing a notebook's resulting JSON would mean simulating cell
 * surgery on the underlying `.ipynb` structure, which is exactly the kind of
 * guess this module refuses to make, so `content` is always `null` here. A
 * path-only rule (folder shape, test location) still sees the write; only a
 * content rule stays silent, same as any other unreconstructable write.
 *
 * @param {object} inp The tool input.
 * @returns {Array<{path: string, content: null, kind: "add"|"update"|"delete", pathBase: "cwd"}>}
 * One entry, or `[]` when the payload names no path at all.
 */
function decodeNotebookEdit(inp) {
  const path = pickPath(inp);
  if (!path) return [];

  const editMode = typeof inp.edit_mode === "string" ? inp.edit_mode : "";
  const kind = editMode === "delete" ? "delete" : editMode === "insert" ? "add" : "update";
  return [{ path, content: null, kind, pathBase: "cwd" }];
}

/**
 * Splits one patch envelope's body into its file sections, each carrying its
 * hunks as ordered `{type, value}` lines, and — when present — the section's
 * own rename destination.
 *
 * Flow:
 * 1. A `*** Add File:` / `*** Update File:` / `*** Delete File:` header line
 *    starts a new section and flushes whatever section came before it —
 *    UNLESS it is itself ambiguous (points 4 and 5 below), in which case
 *    parsing stops immediately instead.
 * 2. A `*** Move to:` line, seen before any hunk of the current section has
 *    started, names that section's rename destination rather than being
 *    treated as hunk content — Codex's own spelling for "this file is being
 *    moved", always written directly under the section's own header.
 * 3. A `@@` line starts a new hunk within the current section and flushes
 *    whatever hunk came before it — the hunk's own trailing context text (a
 *    function signature, a class name) is a locator for a human reader only
 *    and carries no line to reconstruct.
 * 4. `PATCH_FILE_HEADER_RE` is tested against every line before anything
 *    else — including one that has already lost its own leading space and
 *    merely happens to read like `*** Update File: …` (this very file's own
 *    doc comments and test fixtures are full of that exact text, so a real
 *    edit near them can produce exactly this shape). A matched `Update File:`
 *    or `Delete File:` header must additionally name a path that exists on
 *    disk, checked through `pathExists` — a genuine update or delete always
 *    targets a file that is already there; a phantom section conjured out of
 *    a mangled context line almost never names one that is. When it does not
 *    (an `Add File:` header is exempt — a new file legitimately need not
 *    exist yet), the parse is genuinely undecidable and stops rather than
 *    guessing — see `decodePatchText`'s own handling of `ambiguous`. A
 *    header whose path does exist is accepted unconditionally, regardless of
 *    what the hunk currently open (if any) has or has not proved about
 *    itself — a real `+`/`-` line can never itself match
 *    `PATCH_FILE_HEADER_RE` in the first place, since the regex requires the
 *    literal `***` at column zero, which a `+`/`-`-prefixed line structurally
 *    cannot carry.
 * 5. Every other line is classified by its leading character: `+` added, `-`
 *    removed, ` ` context. An EMPTY unprefixed line is tolerated as context
 *    too — a patch generator that omits the leading space on a blank context
 *    line is common, and dropping the line would corrupt the reconstruction
 *    more than keeping it. A line matching {@link PATCH_END_OF_FILE_RE} —
 *    real V4A grammar punctuation, verified against the real Codex binary,
 *    see {@link KNOWN_PATCH_MARKERS} — is tolerated too, consumed without
 *    being added to the hunk: it marks that the hunk's own trailing context
 *    runs to the end of the file, carrying no line of its own to
 *    reconstruct. That tolerance stops there: a NON-empty unprefixed line
 *    that is not a recognised grammar marker always kept its leading space
 *    if it were genuinely meant as context (trailing-whitespace stripping
 *    can erase a lone trailing space, never a leading one), so one that
 *    reaches here — having already failed the header test in point 4 above
 *    and the marker check just described — has no legitimate reading left,
 *    and the whole parse is ambiguous.
 *
 * @param {string} body The text between one envelope's `*** Begin Patch` and
 * `*** End Patch` markers.
 * @param {(p: string) => boolean} pathExists Point 4's own existence check
 * for an `Update File:`/`Delete File:` header's path, repo-root-anchored.
 * @param {(p: string) => boolean} [withinReach] Point 4's precondition: was
 * the path one this dispatcher could have looked at in the first place.
 * Defaults to answering `true` for everything, which reproduces the
 * behaviour of the callers that pass nothing.
 * @returns {{
 *   sections: Array<{action: "add"|"update"|"delete", path: string, moveTo?: string, hunks: Array<Array<{type: "context"|"add"|"remove", value: string}>>}>,
 *   ambiguous: boolean,
 * }} `sections` holds one entry per file section parsed before the point
 * parsing stopped, in the order it appears in the envelope. `ambiguous` is
 * `true` when point 4's header-existence check or point 5's grammar check
 * failed — in that case `sections` is a strict prefix of the envelope's real
 * sections and must not be trusted on its own; the caller decides what to do
 * with an ambiguous parse.
 */
function parsePatchSections(body, pathExists, withinReach = () => true) {
  const sections = [];
  let current = null;
  let hunks = null;
  let hunkLines = null;
  let ambiguous = false;

  const flushHunk = () => {
    if (hunkLines && hunkLines.length) hunks.push(hunkLines);
    hunkLines = null;
  };
  const flushSection = () => {
    flushHunk();
    if (current) sections.push({ ...current, hunks });
    current = null;
    hunks = null;
  };

  // `PATCH_BLOCK_RE` always captures the newline that sits right before the
  // literal "*** End Patch" marker as part of `body` — that newline is a
  // formatting artifact of the envelope, not a line of patch content. Left
  // in, splitting on "\n" produces a phantom trailing "" element that the
  // loop below would classify as a context line with an empty value and
  // append to whichever hunk is still open — demanding a genuinely blank
  // line right after the hunk's own last line in the CURRENT file, which has
  // nothing to do with the actual patch. Stripping exactly one trailing
  // newline removes only that artifact: a hunk whose own real last line
  // genuinely is a blank context line still ends in an empty split element,
  // since only ONE newline is ever removed here.
  const trimmedBody = body.endsWith("\n") ? body.slice(0, -1) : body;

  for (const rawLine of trimmedBody.split("\n")) {
    // Every classification below — header, move-to, hunk marker, and the
    // +/-/space prefix — reads a protocol line that never legitimately
    // carries a trailing \r of its own; stripping it once, up front, is what
    // makes a CRLF-joined envelope (or one \r\n-terminated line inside an
    // otherwise LF envelope) parse exactly like its LF-only equivalent
    // instead of silently losing whichever line carried the \r.
    const line = stripTrailingCR(rawLine);

    const header = line.match(PATCH_FILE_HEADER_RE);
    if (header) {
      const action = header[1] === "Add File" ? "add" : header[1] === "Delete File" ? "delete" : "update";
      const headerPath = header[2].trim();
      if (action !== "add" && withinReach(headerPath) && !pathExists(headerPath)) {
        // Point 4 of this function's own doc comment: an Update/Delete
        // header naming a path that is not actually there is genuinely
        // undecidable — a phantom section conjured out of a mangled context
        // line, or the patch itself is simply wrong. Stop parsing rather
        // than pick a reading — see `decodePatchText`.
        //
        // `withinReach` is the precondition, not a second existence test:
        // absence is only evidence when the file could have been seen. A
        // header naming a path outside this dispatcher's own boundary — the
        // memory directory, from an agent whose cwd is elsewhere — reads as
        // absent to `pathExists` no matter what is actually on disk, and
        // treating that as undecidable took a legitimate, everyday write out
        // of rule evaluation entirely. It stays in: the section parses, and
        // reconstruction returns `null` content it could not read, so
        // path-based rules still see the write and content-based ones
        // correctly see nothing to judge.
        ambiguous = true;
        break;
      }
      flushSection();
      current = { action, path: headerPath };
      hunks = [];
      continue;
    }
    if (!current) continue;

    if (!hunkLines) {
      const moveMatch = line.match(PATCH_MOVE_TO_RE);
      if (moveMatch) {
        current.moveTo = moveMatch[1].trim();
        continue;
      }
    }

    if (line.startsWith("@@")) {
      flushHunk();
      hunkLines = [];
      continue;
    }
    if (!hunkLines) hunkLines = [];

    if (line.startsWith("+")) hunkLines.push({ type: "add", value: line.slice(1) });
    else if (line.startsWith("-")) hunkLines.push({ type: "remove", value: line.slice(1) });
    else if (line.startsWith(" ")) hunkLines.push({ type: "context", value: line.slice(1) });
    else if (line === "") hunkLines.push({ type: "context", value: line });
    else if (PATCH_END_OF_FILE_RE.test(line)) {
      // Point 5 of this function's own doc comment: real grammar punctuation
      // signalling the hunk's own trailing context runs to end of file —
      // consumed, not appended, since it names no line of the file itself.
      continue;
    } else {
      // Point 5 of this function's own doc comment: a non-empty unprefixed
      // line that is also not header-shaped (point 4 already ran, above) and
      // not a recognised grammar marker has no legitimate reading left.
      ambiguous = true;
      break;
    }
  }
  if (!ambiguous) flushSection();

  return { sections, ambiguous };
}

/**
 * Finds a contiguous, exact-match run of `search` inside `lines`, starting no
 * earlier than `fromIndex` — the same forward-only anchoring a real `patch`
 * apply uses, so a later hunk is never matched against text a hunk before it
 * already consumed.
 *
 * Implemented as a single joined-string `indexOf` rather than a nested
 * per-line comparison loop: a naive line-by-line scan is O(lines × search
 * length) in the worst case, which is exactly what let a large file or patch
 * blow through the `PreToolUse` hook timeout (`HOOK_TIMEOUT_SECONDS` in
 * `core/installer/plan.js`, 30 seconds) before this fix. Every
 * line is wrapped in its own leading/trailing `"\n"` in both the haystack and
 * the needle, so a match can only land on a real line boundary — a partial
 * match straddling two lines' worth of text is impossible by construction,
 * not merely unlikely.
 *
 * @param {string[]} lines The current file content, split into lines.
 * @param {string[]} search The line values a hunk expects to find, in order.
 * @param {number} fromIndex The first index the search may start at.
 * @returns {number} The starting index of the match, or `-1` when no
 * contiguous match exists at or after `fromIndex`.
 */
function findSubsequence(lines, search, fromIndex) {
  if (search.length === 0 || fromIndex > lines.length) return -1;

  const haystack = `\n${lines.slice(fromIndex).join("\n")}\n`;
  const needle = `\n${search.join("\n")}\n`;
  const charIndex = haystack.indexOf(needle);
  if (charIndex === -1) return -1;

  let newlinesBefore = 0;
  for (let i = 0; i < charIndex; i += 1) {
    if (haystack[i] === "\n") newlinesBefore += 1;
  }
  return fromIndex + newlinesBefore;
}

/**
 * Applies every hunk of a section to a file's current content, in order,
 * reading the starting content from `sourcePath` — for an ordinary update
 * section this is the section's own path; for a rename section
 * ({@link decodePatchText}) it is deliberately the OLD path, since a
 * rename's hunks describe changes relative to the file being moved, not the
 * not-yet-existing destination.
 *
 * @param {Array<Array<{type: string, value: string}>>} hunks The section's
 * hunks, each an ordered list of context/add/remove lines.
 * @param {string} sourcePath The path to read the current content from.
 * @param {(p: string) => string | null} readFile Reads a file's current
 * content, `null` when it cannot be read.
 * @param {{reserve: () => boolean, chargeBytes: (n: number) => boolean}} budget
 * The shared reconstruction budget for this decode pass — see
 * {@link createReconstructBudget}. Charged on the size of `existing`, not on
 * the hunk's own diff text, since splitting and searching a file costs
 * proportional to the FILE's size regardless of how small the diff against
 * it is — charged from `statFile` up front when it can answer, from the read
 * itself otherwise (see below).
 * @param {(p: string) => number | null} [statFile] Answers `sourcePath`'s own
 * byte size WITHOUT reading its content, `null` when it cannot (no capability
 * supplied at all, the file is missing, unreadable, a directory, or outside
 * the caller's own sandboxed boundary) — see
 * `core/lib/context.js#makeStatFile`. Optional so an older caller supplying
 * only `readFile` keeps working exactly as before this parameter existed.
 * @returns {string | null} The resulting content, or `null` when the budget
 * was already spent, this file's OWN size alone was already too much for
 * whatever remained of the budget, the file could not be read, or a hunk
 * could not be located or carries no context/removed lines to anchor it at
 * all.
 */
function applyHunksToFile(hunks, sourcePath, readFile, budget, statFile) {
  // Checked BEFORE reading anything: once prior files in this same decode
  // pass have already charged the budget past its ceiling, this file's own
  // `readFile` call — and the split/search work that would follow it — is
  // skipped entirely, rather than paying for a read whose result the budget
  // is only going to discard afterwards.
  if (!budget.reserve()) return null;

  // THE GAP THIS CLOSES: `reserve()` above can only ever judge bytes charged
  // by files reconstructed SO FAR — on its own it has no way to know THIS
  // file's own size, so a single existing tracked file bigger than the
  // entire byte budget (a generated lockfile, a bundled asset, a large data
  // fixture — exactly the class MAX_RECONSTRUCT_BYTES's own doc comment
  // names) used to sail past `reserve()` regardless of its own size, get read
  // into memory in full by `readFile` below, and then be split, mapped,
  // joined and searched in full with nothing left to stop it — only the NEXT
  // file's own `reserve()` call ever saw the damage. Measured: a lone 200 MB
  // existing file touched by a trivial two-line patch cost 1.28 seconds
  // entirely outside the budget.
  //
  // `statFile` answers this without paying for a read at all: when it can
  // (`knownSize` is a number), that size is charged against the budget RIGHT
  // HERE, before `readFile` is ever called for this file — an oversized file
  // now degrades to path-only decoding before its own read even starts,
  // rather than after paying for it.
  const knownSize = typeof statFile === "function" ? statFile(sourcePath) : null;
  if (typeof knownSize === "number" && !budget.chargeBytes(knownSize)) return null;

  const existing = readFile(sourcePath);
  if (typeof existing !== "string") return null;

  // Charged again here ONLY when the size was not already known up front —
  // charging twice for the same file would double-count its bytes. This is
  // exactly the post-read check this function had before `statFile` existed,
  // kept as the fallback for a caller that supplies no stat capability at
  // all, or for a file `statFile` itself could not answer for (gone by the
  // time this runs, a permission failure, a symlink escaping the sandbox):
  // the file has already been read in full by this point, same as it always
  // was, so this is the last chance to stop the expensive per-line work below
  // from running on a result the budget is only going to discard anyway.
  if (knownSize === null && !budget.chargeBytes(existing.length)) return null;

  // Stripped the same way the patch's own lines are (`parsePatchSections`'s
  // own `stripTrailingCR`), so a hunk's context/removed lines compare fairly
  // against the file's real lines regardless of which side's line-ending
  // convention a stray \r came from — a CRLF file's hunk (whose own content
  // lines legitimately carry \r too) still matches, and a CRLF-artifact \r on
  // one context line (this module's own F1 fix) no longer blocks the match
  // just because the on-disk file itself has none.
  let lines = existing.split("\n").map(stripTrailingCR);
  let cursor = 0;

  for (const hunk of hunks) {
    const search = [];
    const replace = [];
    for (const line of hunk) {
      if (line.type === "context") {
        search.push(line.value);
        replace.push(line.value);
      } else if (line.type === "remove") {
        search.push(line.value);
      } else if (line.type === "add") {
        replace.push(line.value);
      }
    }
    if (search.length === 0) return null;

    const idx = findSubsequence(lines, search, cursor);
    if (idx === -1) return null;

    lines = [...lines.slice(0, idx), ...replace, ...lines.slice(idx + search.length)];
    cursor = idx + replace.length;
  }

  return lines.join("\n");
}

/**
 * Reconstructs one non-renamed patch section's resulting file content — a
 * rename section is handled separately by {@link decodePatchText}, since it
 * yields two entries rather than one.
 *
 * - `delete` never has resulting content — `content` is always `null`.
 * - `add` concatenates every added (and any stray context) line across every
 *   hunk; a brand-new file has no existing content to anchor against, so
 *   there is nothing to search for. Still counted against `budget`: a very
 *   large brand-new file is exactly as expensive to carry through the rest
 *   of the pipeline as a large reconstructed update.
 * - `update` applies every hunk against the file's current content via
 *   {@link applyHunksToFile}.
 *
 * @param {{action: "add"|"update"|"delete", path: string, hunks: Array<Array<{type: string, value: string}>>}} section
 * One non-renamed section from {@link parsePatchSections}.
 * @param {(p: string) => string | null} readFile Reads a file's current
 * content, `null` when it cannot be read.
 * @param {{take: (n: number) => boolean}} budget The shared reconstruction
 * budget for this decode pass.
 * @param {(p: string) => number | null} [statFile] Forwarded to
 * {@link applyHunksToFile} for an `"update"` section — see its own doc
 * comment.
 * @returns {{path: string, content: string | null, kind: "add"|"update"|"delete", pathBase: "repoRoot"}}
 * The reconstructed write.
 */
function reconstructSection(section, readFile, budget, statFile) {
  if (section.action === "delete") {
    return { path: section.path, content: null, kind: "delete", pathBase: "repoRoot" };
  }

  if (section.action === "add") {
    let estimatedBytes = 0;
    for (const hunk of section.hunks) {
      for (const line of hunk) estimatedBytes += line.value.length;
    }
    if (!budget.take(estimatedBytes)) {
      return { path: section.path, content: null, kind: "add", pathBase: "repoRoot" };
    }

    const lines = [];
    for (const hunk of section.hunks) {
      for (const line of hunk) {
        if (line.type === "add" || line.type === "context") lines.push(line.value);
      }
    }
    return { path: section.path, content: lines.join("\n"), kind: "add", pathBase: "repoRoot" };
  }

  const content = applyHunksToFile(section.hunks, section.path, readFile, budget, statFile);
  return { path: section.path, content, kind: "update", pathBase: "repoRoot" };
}

/**
 * Decodes one already-isolated patch envelope BODY — the text between one
 * `*** Begin Patch`/`*** End Patch` pair, already stripped of both markers —
 * into the file writes its sections perform.
 *
 * Factored out of {@link decodePatchText} so a second caller that locates and
 * isolates envelope bodies its own way can share every rule this module
 * enforces on the grammar (`parsePatchSections`'s header/hunk classification,
 * its `Update File:`/`Delete File:` existence invariant, CRLF normalisation,
 * ambiguity detection) and every rule it enforces on reconstruction
 * ({@link reconstructSection}, {@link applyHunksToFile}, the shared
 * {@link createReconstructBudget} budget, the rename-section dual-entry
 * expansion below) — WITHOUT carrying a second, independently-drifting copy
 * of any of it. `core/lib/codex-exec.js#extractPatchOperations` is exactly
 * that second caller: it locates its own envelope bodies inside a Codex
 * `exec` call's JavaScript source (a span between two plain-ASCII marker
 * lines, unescaped from the JS string literal that carries it) and calls
 * this function once per body it finds, precisely mirroring what
 * {@link decodePatchText}'s own loop below does for a bare patch string.
 *
 * @param {string} body One envelope's body text, already isolated from its
 * own `*** Begin Patch`/`*** End Patch` markers.
 * @param {(p: string) => string | null} readFile Reads a file's current
 * content, `null` when it cannot be read.
 * @param {(p: string) => boolean} pathExists Checks whether a path exists on
 * disk, repo-root-anchored — forwarded to {@link parsePatchSections} for its
 * header-existence invariant.
 * @param {{take: (n: number) => boolean, reserve: () => boolean, chargeBytes: (n: number) => boolean}} budget
 * The shared reconstruction budget — see {@link createReconstructBudget}.
 * @param {(p: string) => boolean} [withinReach] Forwarded to
 * {@link parsePatchSections} — see its own doc comment.
 * @param {(p: string) => number | null} [statFile] Answers a path's own byte
 * size without reading it, repo-root-anchored the same way `readFile` is
 * here — forwarded to every `"update"` section's own {@link applyHunksToFile}
 * call (directly, and via {@link reconstructSection}) so an oversized
 * existing file degrades to path-only decoding before it is ever read.
 * Optional; `undefined` falls back to exactly today's read-then-check
 * behaviour — see {@link applyHunksToFile}'s own doc comment.
 * @returns {{ambiguous: boolean, entries: Array<{path: string, content: string | null, kind: "add"|"update"|"delete", pathBase: "repoRoot"}>}}
 * `entries` holds one entry per file section in this body, two for a renamed
 * section (the old path as a `"delete"`, the new path as an `"add"` whose
 * content is the old path's content with every hunk applied) — a rename
 * slipping past no rule at all otherwise. `ambiguous` is `true` when this
 * body's own `parsePatchSections` call came back ambiguous, in which case
 * `entries` is always `[]` — the caller decides what an ambiguous body means
 * for the rest of whatever it is decoding.
 */
function decodePatchBody(body, readFile, pathExists, budget, withinReach, statFile) {
  const parsed = parsePatchSections(body, pathExists, withinReach);
  if (parsed.ambiguous) return { ambiguous: true, entries: [] };

  const entries = [];
  for (const section of parsed.sections) {
    if (section.moveTo) {
      entries.push({ path: section.path, content: null, kind: "delete", pathBase: "repoRoot" });
      const content = applyHunksToFile(section.hunks, section.path, readFile, budget, statFile);
      entries.push({ path: section.moveTo, content, kind: "add", pathBase: "repoRoot" });
      continue;
    }
    entries.push(reconstructSection(section, readFile, budget, statFile));
  }
  return { ambiguous: false, entries };
}

/**
 * Decodes every file section out of one or more `*** Begin Patch` … `***
 * End Patch` envelopes found in a patch string — a single string can carry
 * several envelopes in principle, and a single envelope routinely carries
 * several files, so this always returns one entry per file, not per
 * envelope. Each envelope body is decoded by {@link decodePatchBody}; the
 * whole pass shares one {@link createReconstructBudget} budget across every
 * body, so a many-file or many-byte patch degrades to path-only decoding
 * past the ceiling instead of spending unbounded time reconstructing every
 * file.
 *
 * A block whose own parse comes back ambiguous ({@link decodePatchBody}'s own
 * `parsePatchSections` call — a non-empty unprefixed line with no legitimate
 * reading, or an `Update File:`/`Delete File:` header naming a path that is
 * not actually there) escalates the WHOLE call to `[]` — the same "abort
 * rather than drop one entry" precedent {@link decodeChanges} already sets
 * for a `changes` entry naming no path — rather than trusting the sections
 * parsed before the ambiguity, which are only ever a strict,
 * silently-truncated prefix of the real envelope. `decodeApplyPatch`/
 * `decodeWrites` turn that `[]` into the documented unrecognised-write-shape
 * `ask`, never a silent pass.
 *
 * @param {string} patchText The raw patch text.
 * @param {(p: string) => string | null} readFile Reads a file's current
 * content, `null` when it cannot be read.
 * @param {(p: string) => boolean} pathExists Checks whether a path exists on
 * disk, repo-root-anchored — forwarded to every block's own
 * {@link parsePatchSections} call for its header-existence invariant.
 * @param {(p: string) => boolean} [withinReach] Forwarded to
 * {@link decodePatchBody}.
 * @param {(p: string) => number | null} [statFile] Forwarded to
 * {@link decodePatchBody} — see {@link applyHunksToFile}'s own doc comment.
 * @returns {Array<{path: string, content: string | null, kind: "add"|"update"|"delete", pathBase: "repoRoot"}>}
 * One entry per file section found, two for a renamed section; `[]` when any
 * block's own parse came back ambiguous.
 */
function decodePatchText(patchText, readFile, pathExists, withinReach, statFile) {
  return decodePatchTextDetailed(patchText, readFile, pathExists, withinReach, statFile).entries;
}

/**
 * {@link decodePatchText}, keeping the reason an envelope decoded to nothing
 * rather than collapsing it into a bare `[]`.
 *
 * The two reasons are not the same defect and do not have the same fix. A
 * payload whose SHAPE this module does not recognise means the decoder is
 * behind the host and needs a new field name (exactly what happened when
 * Codex turned out to send its patch under `command`). An envelope that
 * parsed but came back AMBIGUOUS means the patch itself did not add up
 * against the files on disk — a header naming a file that is not there, or a
 * hunk line with no legitimate reading. Reporting both as "shape not
 * recognised" sent the developer looking in the wrong place, so the caller is
 * given enough to tell them apart.
 *
 * @param {string} patchText The raw patch text.
 * @param {(p: string) => string | null} readFile Reads a file's current
 * content, `null` when it cannot be read.
 * @param {(p: string) => boolean} pathExists Checks whether a path exists on
 * disk, repo-root-anchored.
 * @param {(p: string) => boolean} [withinReach] Forwarded to
 * {@link decodePatchBody}.
 * @param {(p: string) => number | null} [statFile] Forwarded to every block's
 * own {@link decodePatchBody} call, sharing the one `budget` across the whole
 * pass exactly as `readFile` already does.
 * @returns {{entries: Array<{path: string, content: string | null, kind: "add"|"update"|"delete", pathBase: "repoRoot"}>, ambiguous: boolean}}
 * `entries` is empty whenever `ambiguous` is `true`; an envelope carrying no
 * file section at all returns empty entries with `ambiguous: false`.
 */
function decodePatchTextDetailed(patchText, readFile, pathExists, withinReach, statFile) {
  const results = [];
  const budget = createReconstructBudget();
  PATCH_BLOCK_RE.lastIndex = 0;
  let match;
  while ((match = PATCH_BLOCK_RE.exec(patchText))) {
    const { ambiguous, entries } = decodePatchBody(match[1], readFile, pathExists, budget, withinReach, statFile);
    if (ambiguous) return { entries: [], ambiguous: true };
    results.push(...entries);
  }
  return { entries: results, ambiguous: false };
}

/**
 * Normalises the `changes` envelope's two observed shapes — an array of
 * change entries, or an object keyed by path — into one flat entry list.
 *
 * @param {*} changes The raw `changes` value.
 * @returns {object[]} One plain object per change, whatever fields the
 * source shape gave it; entries that are not objects at all are dropped.
 */
function normalizeChangeEntries(changes) {
  if (Array.isArray(changes)) return changes.filter((c) => c && typeof c === "object");
  if (changes && typeof changes === "object") {
    return Object.entries(changes).map(([key, value]) => {
      if (value && typeof value === "object") return { path: key, ...value };
      return { path: key, content: typeof value === "string" ? value : undefined };
    });
  }
  return [];
}

/**
 * Reads a change entry's own action, tolerating a handful of synonyms rather
 * than one fixed vocabulary — this sub-shape is not documented anywhere, so
 * matching by intent is more robust than matching one exact literal.
 *
 * @param {object} entry One normalised change entry.
 * @returns {"add"|"update"|"delete"|""} The resolved action, or `""` when
 * the entry names none of the recognised synonyms.
 */
function normalizeChangeAction(entry) {
  const raw = firstString(entry.type, entry.action, entry.kind);
  if (/delete|remove/i.test(raw)) return "delete";
  if (/add|create|new/i.test(raw)) return "add";
  if (/update|modify|edit/i.test(raw)) return "update";
  return "";
}

/**
 * Decodes an `apply_patch` `{changes: ...}` envelope.
 *
 * Every entry that names a path yields that path, even when its own change
 * is expressed as a diff with no full replacement content given — content
 * simply stays `null` rather than being guessed at, so a path-only rule
 * (folder shape, protected paths) still sees it instead of the entry
 * vanishing without a trace. An entry naming no path at all cannot be
 * resolved to anything a rule could judge, so it aborts the whole envelope —
 * `[]` — rather than silently dropping just that one entry: the caller
 * (`adapters/shared/dispatch-core.js#evaluateDecodedWrites`) treats an empty
 * decode of a recognised write tool as "ask", which is the only honest
 * answer when part of the call could not even be identified by path.
 *
 * @param {*} changes The raw `changes` value, array or object form.
 * @param {(p: string) => string | null} readFile Reads a file's current
 * content, `null` when it cannot be read.
 * @param {{take: (n: number) => boolean}} budget The shared reconstruction
 * budget for this decode pass — see {@link createReconstructBudget}.
 * @returns {Array<{path: string, content: string | null, kind: "add"|"update"|"delete", pathBase: "repoRoot"}>}
 * One entry per change entry, in order; `[]` when any entry names no path at
 * all.
 */
function decodeChanges(changes, readFile, budget) {
  const results = [];
  for (const entry of normalizeChangeEntries(changes)) {
    const path = firstString(entry.path, entry.file_path, entry.filePath, entry.target_file);
    if (!path) return [];

    const action = normalizeChangeAction(entry);
    if (action === "delete") {
      results.push({ path, content: null, kind: "delete", pathBase: "repoRoot" });
      continue;
    }

    const directContent = firstDefinedString(entry.content, entry.new_content, entry.newContent);
    if (directContent === null) {
      results.push({ path, content: null, kind: action || "update", pathBase: "repoRoot" });
      continue;
    }

    if (!budget.take(directContent.length)) {
      results.push({ path, content: null, kind: action || "update", pathBase: "repoRoot" });
      continue;
    }

    const existing = readFile(path);
    results.push({
      path,
      content: directContent,
      kind: action || (existing === null ? "add" : "update"),
      pathBase: "repoRoot",
    });
  }
  return results;
}

/**
 * Decodes an `apply_patch` call, across every envelope shape this repository
 * has observed:
 *
 * - the already-working `{file_path, content}` direct shape — handled by
 *   {@link decodeFullReplace}, tried first since it needs no patch parsing;
 * - `{command: "*** Begin Patch..."}` — the shape the real Codex binary
 *   sends, measured off a live payload; see {@link pickPatchCommand};
 * - `{input: "*** Begin Patch..."}` or `{patch: "..."}` — a real patch
 *   string, parsed by {@link decodePatchText};
 * - `{changes: ...}` — decoded by {@link decodeChanges}.
 *
 * `readFile` reads a `"cwd"`-tagged path (the direct shape's own
 * `file_path`); `readFileRepoRoot` reads a `"repoRoot"`-tagged path (every
 * path parsed out of the patch envelope's own text) — the two must be kept
 * apart because they are anchored on different base directories the moment
 * the agent's own `cwd` is a subdirectory of the repository, see this
 * module's own top-of-file doc block on `pathBase`.
 *
 * @param {object} inp The tool input.
 * @param {(p: string) => string | null} readFile Reads a `"cwd"`-relative
 * path's current content, `null` when it cannot be read.
 * @param {(p: string) => string | null} readFileRepoRoot Reads a
 * `"repoRoot"`-relative path's current content, `null` when it cannot be
 * read.
 * @param {(p: string) => boolean} pathExistsRepoRoot Checks whether a
 * `"repoRoot"`-relative path exists on disk at all — forwarded to
 * {@link decodePatchText} for `parsePatchSections`'s own header-existence
 * invariant; irrelevant to the other two shapes.
 * @param {(p: string) => boolean} [withinReachRepoRoot] Forwarded to
 * {@link decodePatchText}.
 * @param {(p: string) => number | null} [statFileRepoRoot] Answers a
 * `"repoRoot"`-relative path's own byte size without reading it — forwarded
 * to {@link decodePatchText} for an `"update"` section's own
 * {@link applyHunksToFile} call; irrelevant to the other two shapes, neither
 * of which reads an existing file to reconstruct one it does not already
 * have the full content for.
 * @returns {Array<{path: string, content: string | null, kind: "add"|"update"|"delete"}>}
 * One entry per file the call touches; `[]` when none of the three shapes
 * matches at all.
 */
function decodeApplyPatch(inp, readFile, readFileRepoRoot, pathExistsRepoRoot, withinReachRepoRoot, statFileRepoRoot) {
  return decodeApplyPatchDetailed(inp, readFile, readFileRepoRoot, pathExistsRepoRoot, withinReachRepoRoot, statFileRepoRoot)
    .entries;
}

/**
 * {@link decodeApplyPatch}, keeping the ambiguity flag — see
 * {@link decodePatchTextDetailed} for why the caller needs it.
 *
 * @param {object} inp The tool input.
 * @param {(p: string) => string | null} readFile Reads a `"cwd"`-relative
 * path's current content.
 * @param {(p: string) => string | null} readFileRepoRoot Reads a
 * `"repoRoot"`-relative path's current content.
 * @param {(p: string) => boolean} pathExistsRepoRoot Existence check for a
 * `"repoRoot"`-relative path.
 * @param {(p: string) => boolean} [withinReachRepoRoot] Forwarded to
 * {@link decodePatchTextDetailed}.
 * @param {(p: string) => number | null} [statFileRepoRoot] Forwarded to
 * {@link decodePatchTextDetailed}.
 * @returns {{entries: Array<{path: string, content: string | null, kind: "add"|"update"|"delete"}>, ambiguous: boolean}}
 * `ambiguous` is only ever `true` for the patch-envelope shape; the direct
 * and `changes` shapes have no ambiguous state of their own.
 */
function decodeApplyPatchDetailed(inp, readFile, readFileRepoRoot, pathExistsRepoRoot, withinReachRepoRoot, statFileRepoRoot) {
  const direct = decodeFullReplace(inp, readFile);
  if (direct.length) return { entries: direct, ambiguous: false };

  const patchText = firstDefinedString(inp.input, inp.patch, pickPatchCommand(inp));
  if (patchText !== null && patchText.indexOf("*** Begin Patch") !== -1) {
    return decodePatchTextDetailed(patchText, readFileRepoRoot, pathExistsRepoRoot, withinReachRepoRoot, statFileRepoRoot);
  }

  if (inp.changes !== undefined) {
    return { entries: decodeChanges(inp.changes, readFileRepoRoot, createReconstructBudget()), ambiguous: false };
  }

  return { entries: [], ambiguous: false };
}

/**
 * Decodes a host tool-call payload into the file writes it performs.
 *
 * @param {string} toolName The tool name from `ctx.toolName`.
 * @param {object} input The tool input from `ctx.input`.
 * @param {{
 *   readFile?: (p: string) => string | null,
 *   readFileRepoRoot?: (p: string) => string | null,
 *   pathExistsRepoRoot?: (p: string) => boolean,
 *   statFile?: (p: string) => number | null,
 *   statFileRepoRoot?: (p: string) => number | null,
 * }} [options] `readFile` reads a `"cwd"`-tagged path's current content —
 * every shape except a patch-envelope-parsed path (`Write`, `Edit`,
 * `MultiEdit`, `NotebookEdit`, `apply_patch`'s direct `{file_path, content}`
 * shape). `readFileRepoRoot` reads a `"repoRoot"`-tagged path's current
 * content — a path parsed out of a patch envelope's own text (a
 * `*** Update File:` header, a `changes` entry); defaults to `readFile`
 * itself when omitted, so a caller that has only one reader (every existing
 * test fixture, and any caller for which `cwd` already IS the repository
 * root) keeps working unchanged. Both default to a reader that always
 * answers `null` when `readFile` itself is not supplied, so an update's
 * `content` degrades to `null` rather than throwing when no reader is
 * supplied at all. `pathExistsRepoRoot` answers `parsePatchSections`'s own
 * header-existence invariant for a `*** Update File:`/`*** Delete File:`
 * header; when omitted, it degrades to `(p) => readFileRepoRoot(p) !== null`
 * — a caller that never opts into a genuine, stat-based existence check
 * (every pre-existing test fixture) keeps working exactly as before this
 * invariant existed, at the cost this module's own top-of-file doc block on
 * `pathExists` warns about: such a caller cannot tell a header naming a file
 * that truly does not exist apart from one naming a file its own reader
 * merely could not read. The real dispatcher
 * (`adapters/shared/dispatch-core.js#evaluateDecodedWrites`) always supplies
 * a real one instead, built from `core/lib/context.js#makeFileExists`, which
 * does not have that blind spot. `statFile`/`statFileRepoRoot` mirror
 * `readFile`/`readFileRepoRoot`'s own `"cwd"`/`"repoRoot"` split — answering a
 * path's own byte size without reading it, for an `"update"` patch section's
 * own `applyHunksToFile` call to charge against the reconstruction budget
 * before it ever reads the file — `statFileRepoRoot` defaults to `statFile`
 * itself when omitted, the same fallback `readFileRepoRoot` gets. Neither is
 * required: a caller that supplies no stat capability at all (every
 * pre-existing test fixture, and `core/lib/codex-exec.js`'s own nested
 * `apply_patch` path) falls back to exactly the read-then-check behaviour
 * this module always had — see `applyHunksToFile`'s own doc comment. Neither
 * reader, existence check, nor stat is ever called by this module for a path
 * it was not built to resolve — see this module's own top-of-file doc block
 * on `pathBase` for which shape uses which.
 * @returns {Array<{path: string, content: string | null, kind: "add"|"update"|"delete", pathBase: "cwd"|"repoRoot", insertedText?: string}>}
 * One entry per file the call writes. `[]` when `toolName` matches none of
 * the shapes this module decodes, or the payload's own shape inside a
 * matched tool name is not one of the sub-shapes recognised for it.
 */
function decodeWrites(toolName, input, options) {
  return decodeWritesDetailed(toolName, input, options).writes;
}

/**
 * {@link decodeWrites}, additionally reporting whether an empty result came
 * from a patch envelope whose parse was AMBIGUOUS rather than from a payload
 * shape this module does not recognise at all.
 *
 * The dispatcher needs the difference because it reports the two to the
 * developer differently — one says "check your patch", the other says "this
 * decoder is behind the host" — see
 * `adapters/shared/dispatch-core.js#WRITE_VISIBILITY`. Every caller that only
 * wants the files keeps using {@link decodeWrites}, which is now a thin
 * wrapper over this, so the two can never drift apart.
 *
 * @param {string} toolName The tool name from `ctx.toolName`.
 * @param {object} input The tool input from `ctx.input`.
 * @param {{
 *   readFile?: (p: string) => string | null,
 *   readFileRepoRoot?: (p: string) => string | null,
 *   pathExistsRepoRoot?: (p: string) => boolean,
 *   statFile?: (p: string) => number | null,
 *   statFileRepoRoot?: (p: string) => number | null,
 * }} [options] Exactly as {@link decodeWrites} documents them.
 * @returns {{writes: Array<{path: string, content: string | null, kind: "add"|"update"|"delete", pathBase: "cwd"|"repoRoot", insertedText?: string}>, ambiguous: boolean}}
 * `ambiguous` is only ever `true` for an `apply_patch` envelope; every other
 * shape reports `false`, including a tool name this module does not decode at
 * all.
 */
function decodeWritesDetailed(toolName, input, options) {
  const opts = options && typeof options === "object" ? options : {};
  const readFile = typeof opts.readFile === "function" ? opts.readFile : () => null;
  const readFileRepoRoot = typeof opts.readFileRepoRoot === "function" ? opts.readFileRepoRoot : readFile;
  const pathExistsRepoRoot =
    typeof opts.pathExistsRepoRoot === "function" ? opts.pathExistsRepoRoot : (p) => readFileRepoRoot(p) !== null;
  const withinReachRepoRoot = typeof opts.withinReachRepoRoot === "function" ? opts.withinReachRepoRoot : () => true;
  const statFile = typeof opts.statFile === "function" ? opts.statFile : undefined;
  const statFileRepoRoot = typeof opts.statFileRepoRoot === "function" ? opts.statFileRepoRoot : statFile;
  const inp = input && typeof input === "object" ? input : {};
  const name = String(toolName || "").toLowerCase();

  if (name === "write" || name === "write_file") return { writes: decodeFullReplace(inp, readFile), ambiguous: false };
  if (name === "edit" || name === "edit_file") return { writes: decodeEdit(inp, readFile), ambiguous: false };
  if (name === "multiedit") return { writes: decodeMultiEdit(inp, readFile), ambiguous: false };
  if (name === "notebookedit") return { writes: decodeNotebookEdit(inp), ambiguous: false };
  if (name === "apply_patch") {
    const { entries, ambiguous } = decodeApplyPatchDetailed(
      inp,
      readFile,
      readFileRepoRoot,
      pathExistsRepoRoot,
      withinReachRepoRoot,
      statFileRepoRoot,
    );
    return { writes: entries, ambiguous };
  }
  return { writes: [], ambiguous: false };
}

// `PATCH_BLOCK_RE`, `decodePatchBody` and `createReconstructBudget` are
// exported alongside this module's own public surface so
// `core/lib/codex-exec.js#extractPatchOperations` — the Codex `exec`
// indirection path's OWN way of locating and unescaping a patch envelope's
// body — can decode each body it isolates through the exact same grammar and
// reconstruction rules this module enforces for a direct `apply_patch` call,
// rather than carrying a second, independently-drifting patch parser. See
// `decodePatchBody`'s own doc comment for the full reasoning.
module.exports = {
  decodeWrites,
  decodeWritesDetailed,
  isWriteToolName,
  PATCH_BLOCK_RE,
  decodePatchBody,
  createReconstructBudget,
  KNOWN_PATCH_MARKERS,
  MAX_RECONSTRUCT_BYTES,
};
