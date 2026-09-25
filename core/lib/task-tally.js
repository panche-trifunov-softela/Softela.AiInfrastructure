"use strict";

/**
 * Answers, for one session, how many distinct files the CURRENT task has
 * touched by reading and by writing, so a guard can tell "the main agent did
 * this work itself" apart from "the main agent delegated it".
 *
 * The evidence already exists: `adapters/shared/dispatch-core.js#logGuardActivity`
 * appends one JSON line per dispatch to `core/lib/paths.js#guardLogPath`,
 * carrying exactly `ts`, `agent`, `event`, `tool`, `action`, `ruleId`,
 * `advisory`, `filePath`, `command`, `cwd`, `sessionId`, `agentId`,
 * `agentType`. This module reads that log back and turns it into two counts.
 *
 * A record with a non-null `agentId` was produced inside a subagent's own
 * dispatch process, not the main session's — those are exactly the
 * delegated calls this mechanism must not penalise, so they are excluded
 * from the tally entirely (see {@link readTaskTally}'s own doc comment,
 * rule 2).
 *
 * This whole mechanism is fail-open by contract: nothing here ever throws,
 * and "unknown" is always reported as `null` rather than as a guessed zero,
 * so a caller can tell "nothing was touched" apart from "the tally could not
 * be computed" and must not act on the latter.
 */

const fs = require("fs");
const { guardLogPath, formatLogDate } = require("./paths");
const { isWriteToolName } = require("./write-decode");

// `core/lib/read-tools.js` is developed alongside this module and may not
// exist yet in every checkout. Requiring it defensively means a missing file
// degrades this module to treating every record as an uncounted read, rather
// than making the whole guard pipeline fail to load.
let isReadToolName = null;
try {
  ({ isReadToolName } = require("./read-tools"));
} catch {
  isReadToolName = null;
}

/**
 * How many bytes from the END of a guard-activity log file
 * {@link readTaskTally} ever reads.
 *
 * A log file is append-only and can span many tasks; reading it whole would
 * mean an unbounded read on every guard dispatch, for a mechanism meant to
 * run on the hot path of every tool call. Bounding it to a fixed tail
 * instead means a task whose own activity, since its last `UserPromptSubmit`
 * marker, exceeds this many bytes has its earliest records silently fall
 * outside the window and never get counted. That is the safe direction to
 * fail in: an unusually long task is under-counted rather than over-counted,
 * so a guard reading this tally can only ever be too permissive because of
 * it, never wrongly block a developer's own work.
 */
const TASK_TALLY_READ_BOUND_BYTES = 256 * 1024;

/**
 * Normalises a file path for comparison: backslashes become forward
 * slashes, and the whole path is lower-cased, so the same file logged once
 * with each separator style, or in a different case, still counts once.
 *
 * @param {string} filePath The raw path from a log record.
 * @returns {string} The normalised path.
 */
function normalisePath(filePath) {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

/**
 * Reads at most the last `maxBytes` bytes of a file, then discards a leading
 * partial line — the bytes before the first `\n` in the window, which belong
 * to a line whose start was cut off by the window boundary.
 *
 * @param {string} filePath The file to read.
 * @param {number} maxBytes The maximum number of trailing bytes to read.
 * @returns {string | null} The tail of the file, with any leading partial
 * line removed, or `null` when the file does not exist or cannot be read.
 */
function readBoundedTail(filePath, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return null;
  }

  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return "";

    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    let text = buffer.toString("utf8");

    if (start > 0) {
      // The window's own first byte may land mid-line; that partial line
      // cannot be parsed and its content — whichever line it actually was —
      // is unrecoverable from this window, so it is dropped rather than
      // guessed at.
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }

    return text;
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // The file was already read; a failed close leaks a descriptor but
      // does not change the result.
    }
  }
}

/**
 * Parses a guard-activity log's text into records, skipping any line that is
 * not valid JSON rather than failing the whole read — a log file can be
 * caught mid-append by a concurrent writer, and a half-written last line is
 * expected, not exceptional.
 *
 * @param {string} text The log text, one JSON object per line.
 * @returns {object[]} Every line that parsed as a JSON object, in order.
 */
function parseLogRecords(text) {
  const records = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record && typeof record === "object") records.push(record);
    } catch {
      // A corrupt or half-written line is skipped, not fatal.
    }
  }
  return records;
}

/**
 * Finds the index of the last task-boundary marker for this session within
 * `records`, so counting can start strictly after it.
 *
 * A marker is a record whose `event` is `"UserPromptSubmit"`. Two kinds of
 * marker matter here:
 *
 * - one whose `sessionId` equals `sessionId` — a new prompt arrived for THIS
 *   session, so everything before it belongs to a previous task;
 * - one whose `sessionId` is missing or `null` — the host that wrote it did
 *   not say which session the prompt belonged to, so every session for this
 *   agent is reset conservatively, this one included, rather than letting a
 *   stale count accumulate past a prompt boundary it cannot rule out.
 *
 * @param {object[]} records Parsed log records, in file order.
 * @param {string} sessionId The session the tally is being computed for.
 * @returns {number} The index of the last matching marker, or `-1` when
 * none was found — in which case counting starts from the beginning.
 */
function findLastBoundaryIndex(records, sessionId) {
  let boundary = -1;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.event !== "UserPromptSubmit") continue;
    if (record.sessionId === sessionId || record.sessionId === null || record.sessionId === undefined) {
      boundary = i;
    }
  }
  return boundary;
}

/**
 * Computes, for one session, how many distinct files the current task has
 * touched by reading and by writing.
 *
 * Rules applied, in order:
 *
 * - a record counts only when its `sessionId` equals `sessionId` and its
 *   `agentId` is absent or `null` — a non-null `agentId` marks work done
 *   inside a subagent's own dispatch, which is delegated work and must not
 *   count against the session doing the delegating;
 * - a record with no `filePath` is ignored;
 * - a record counts as a read when `isReadToolName(record.tool)` is `true`,
 *   and as a write when `isWriteToolName(record.tool)` is `true` — the two
 *   are independent checks, not mutually exclusive;
 * - only records AFTER the last task-boundary marker for this session are
 *   counted — see {@link findLastBoundaryIndex};
 * - paths are compared case-insensitively with backslashes normalised to
 *   forward slashes, so the same file is never counted twice under two
 *   spellings.
 *
 * Never throws. Returns `null` — meaning "unknown, the caller must not act
 * on this" — whenever the answer cannot be trusted: a missing or empty
 * `sessionId`, a log file that does not exist or cannot be read, or a read
 * that produced no usable (successfully parsed) record at all.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @param {string} sessionId The session id to compute the tally for.
 * @param {{date?: string}} [options] `date`, an optional `YYYY-MM-DD` string
 * naming which day's log to read; defaults to today, in local time.
 * @returns {{filesRead: number, filesWritten: number} | null} The distinct
 * file counts, or `null` when the tally is unknown.
 */
function readTaskTally(agent, sessionId, options) {
  try {
    if (typeof sessionId !== "string" || sessionId.length === 0) return null;

    const opts = options && typeof options === "object" ? options : {};
    const date = typeof opts.date === "string" && opts.date ? opts.date : formatLogDate(new Date());
    const logPath = guardLogPath(agent, date);

    const text = readBoundedTail(logPath, TASK_TALLY_READ_BOUND_BYTES);
    if (text === null) return null;

    const records = parseLogRecords(text);
    if (records.length === 0) return null;

    const boundary = findLastBoundaryIndex(records, sessionId);

    const readPaths = new Set();
    const writtenPaths = new Set();

    for (let i = boundary + 1; i < records.length; i++) {
      const record = records[i];
      if (record.sessionId !== sessionId) continue;
      if (record.agentId !== null && record.agentId !== undefined) continue;
      if (typeof record.filePath !== "string" || record.filePath.length === 0) continue;

      const normalised = normalisePath(record.filePath);
      if (typeof isReadToolName === "function" && isReadToolName(record.tool)) readPaths.add(normalised);
      if (isWriteToolName(record.tool)) writtenPaths.add(normalised);
    }

    return { filesRead: readPaths.size, filesWritten: writtenPaths.size };
  } catch {
    return null;
  }
}

module.exports = { readTaskTally, TASK_TALLY_READ_BOUND_BYTES };
