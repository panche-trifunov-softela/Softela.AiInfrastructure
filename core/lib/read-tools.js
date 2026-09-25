"use strict";

/**
 * Classifies a host tool name as read-shaped, the read-side counterpart to
 * `core/lib/write-decode.js#isWriteToolName`.
 *
 * Nothing else in the codebase knows that a `Read` call is a file read:
 * `core/lib/context.js#buildContext` reads `file_path`/`content` off a tool's
 * input regardless of what the tool actually does with them, and
 * `write-decode.js` only ever answers the write-shaped half of that question.
 * A rule that needs to tell "this call looked at a file" apart from "this
 * call wrote one" has no existing predicate to reach for, and counting how
 * much of a task an agent read into its own context rather than delegating
 * depends on exactly that distinction. This module is that predicate, kept
 * in its own file rather than folded into
 * `write-decode.js` because a read classifier and a write classifier answer
 * unrelated questions and have no shared logic to justify one file.
 *
 * This is a name-shape heuristic over host tool names, not a guarantee: it
 * recognises the read-shaped tool names both hosts are known to use, and
 * nothing more. A tool name it does not recognise — a third-party or
 * future-host tool this module was never updated for — simply is not counted
 * as a read; callers must treat that as "unknown", not as "confirmed
 * non-read".
 */

/** Tool names, on either host, whose call reads a file rather than writing one. */
const READ_TOOL_NAME_RE = /^(read|notebookread|read_file|view_file|view|open_file|cat_file)$/i;

/**
 * Tests whether a tool name is one whose call reads a file, on either host's
 * own naming.
 *
 * @param {string} toolName The tool name from `ctx.toolName`.
 * @returns {boolean} `true` when the name matches a known read-shaped tool.
 */
function isReadToolName(toolName) {
  return READ_TOOL_NAME_RE.test(String(toolName || ""));
}

module.exports = { isReadToolName };
