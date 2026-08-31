"use strict";

/**
 * Parses a raw agent transcript into the developer's own turns, and renders
 * the checkpoint file `compact-checkpoint.js` writes from them.
 *
 * Deliberately self-contained, matching `memory-location.js`: copied
 * alongside its sibling scripts into one flat installed directory and
 * required only as `./transcript`, never reaching into `core/lib`.
 *
 * A transcript line comes in one of two shapes, and the shape — never the
 * file path, never which agent invoked the hook — is what decides how a
 * line is read:
 *
 * - Claude Code: one JSON object per line; a genuine developer turn has
 *   `type === "user"`, `isSidechain !== true`, `isMeta !== true`, and a
 *   `message.content` that is either a string or an array of parts (only
 *   `type === "text"` parts count — `tool_result` parts are not something
 *   the developer typed).
 * - Codex ("rollout") files: one JSON object per line; a genuine developer
 *   turn is `type === "response_item"` with `payload.type === "message"`,
 *   `payload.role === "user"`, reading the `text` of every `input_text`
 *   entry in `payload.content`. `role: "developer"` is the system preamble,
 *   never the developer's own words, and is always excluded.
 *
 * Both shapes are further filtered through two exclusion lists:
 *
 * - {@link ENVELOPE_MARKERS} — text that *opens with* one of these markers is
 *   machine traffic (a slash-command envelope, a bash capture, an injected
 *   reminder, an environment preamble) rather than something the developer
 *   actually typed, even though the host logged it as a `user` turn.
 * - {@link INTERRUPTION_NOTICES} — text that *is, in full,* one of these
 *   host-emitted interruption notices (e.g. after the developer cancels a
 *   tool call mid-flight) is the same kind of machine traffic, but shaped as
 *   a bracketed sentence rather than a tag, so it is matched by whole-message
 *   equality instead of by prefix — a developer quoting the same text inside
 *   a longer real message is still kept.
 */

const path = require("path");

/**
 * Prefixes that mark a `user`-typed transcript line as machine traffic
 * rather than the developer's own words — a slash-command envelope, a
 * captured shell I/O block, an injected reminder, or a host-authored
 * preamble. Shared by both transcript shapes so the same filter applies
 * regardless of which host produced the line.
 *
 * @type {string[]}
 */
const ENVELOPE_MARKERS = [
  "<task-notification>",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-stdout>",
  "<local-command-caveat>",
  "<system-reminder>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<environment_context>",
  "<user_instructions>",
];

/**
 * Host-emitted interruption notices, logged verbatim under the developer's
 * own role when a tool call is cancelled mid-flight. Matched by whole-message
 * equality against the trimmed text, never as a substring or a prefix — a
 * developer quoting one of these strings inside a longer real message is not
 * the notice itself and must still be kept.
 *
 * @type {string[]}
 */
const INTERRUPTION_NOTICES = ["[Request interrupted by user for tool use]", "[Request interrupted by user]"];

/** The opening of Claude Code's own post-compaction continuation block, never a developer turn. */
const COMPACTION_CONTINUATION_PREFIX = "This session is being continued from a previous conversation";

/** The subdirectory, inside a memory directory, that checkpoint files live in. */
const CHECKPOINTS_DIRNAME = "checkpoints";

/** Matches the machine-readable turn count this module writes near the top of every checkpoint file. */
const TURN_COUNT_COMMENT_RE = /<!--\s*softela-ai-checkpoint\s+turns=(\d+)[^>]*-->/;

/**
 * Decides whether text logged as a developer-authored turn is genuinely
 * something the developer typed, as opposed to machine traffic the host
 * happened to log under the same role.
 *
 * @param {string} text Candidate turn text.
 * @returns {boolean} `true` when `text` is non-empty, opens with no
 * {@link ENVELOPE_MARKERS} entry or the compaction continuation prefix, and
 * is not, in its entirety, one of {@link INTERRUPTION_NOTICES}.
 */
function isGenuineDeveloperText(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (ENVELOPE_MARKERS.some((marker) => trimmed.startsWith(marker))) return false;
  if (trimmed.startsWith(COMPACTION_CONTINUATION_PREFIX)) return false;
  if (INTERRUPTION_NOTICES.includes(trimmed)) return false;
  return true;
}

/**
 * Joins the text of every content-array part matching a predicate.
 *
 * @param {*} content A message's `content` field, of unknown shape.
 * @param {(part: object) => boolean} matches Which parts to keep.
 * @returns {string | null} The kept parts' `text`, joined with a blank
 * line, or `null` when none matched.
 */
function joinParts(content, matches) {
  if (!Array.isArray(content)) return null;
  const parts = content.filter((p) => p && typeof p === "object" && matches(p) && typeof p.text === "string").map((p) => p.text);
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Reads one Claude Code transcript line as a developer turn, when it is one.
 *
 * @param {object} obj A parsed JSON line.
 * @returns {{text: string, timestamp: string|null, uuid: string|null, cwd: string|null, gitBranch: string|null} | null}
 * The turn, or `null` when this line is not a genuine developer turn.
 */
function readClaudeTurn(obj) {
  if (obj.type !== "user" || obj.isSidechain === true || obj.isMeta === true) return null;

  const message = obj.message;
  if (!message || typeof message !== "object") return null;

  let text = null;
  if (typeof message.content === "string") {
    text = message.content;
  } else if (Array.isArray(message.content)) {
    text = joinParts(message.content, (p) => p.type === "text");
  }
  if (!isGenuineDeveloperText(text)) return null;

  return {
    text,
    timestamp: typeof obj.timestamp === "string" ? obj.timestamp : null,
    uuid: typeof obj.uuid === "string" ? obj.uuid : null,
    cwd: typeof obj.cwd === "string" ? obj.cwd : null,
    gitBranch: typeof obj.gitBranch === "string" ? obj.gitBranch : null,
  };
}

/**
 * Reads one Codex rollout line as a developer turn, when it is one.
 *
 * @param {object} obj A parsed JSON line.
 * @returns {{text: string, timestamp: string|null, uuid: string|null, cwd: string|null, gitBranch: string|null} | null}
 * The turn, or `null` when this line is not a genuine developer turn.
 */
function readCodexTurn(obj) {
  if (obj.type !== "response_item") return null;

  const p = obj.payload;
  if (!p || typeof p !== "object" || p.type !== "message" || p.role !== "user") return null;

  const text = joinParts(p.content, (part) => part.type === "input_text");
  if (!isGenuineDeveloperText(text)) return null;

  return { text, timestamp: null, uuid: null, cwd: null, gitBranch: null };
}

/**
 * Appends a turn, collapsing it into the previously kept one when the
 * previous turn's text is a **strict prefix** of this one (`String.prototype.startsWith`,
 * character for character from offset zero — nothing fuzzy, no containment
 * check).
 *
 * Both hosts have been observed to log the same developer message twice in
 * a row — a short first copy, then a re-logged copy that is a strict
 * superset (attachments expanded). Keeping only the longer copy, in place,
 * preserves ordering without ever holding two entries for one message.
 *
 * Deliberately not loosened to a substring or fuzzy-similarity check. A real
 * transcript pair has been observed where a message was re-sent with extra
 * sentences inserted in the *middle* rather than appended at the end — the
 * first copy is then not a prefix of the second, and both are correctly kept
 * as distinct turns. That is the intended failure direction: an occasional
 * redundant turn surviving in the checkpoint costs nothing, while a fuzzy
 * match that drops a genuinely distinct instruction cannot be recovered.
 *
 * @param {object[]} turns The turns kept so far; mutated in place.
 * @param {object} turn The newly read turn.
 * @returns {void}
 */
function appendTurn(turns, turn) {
  const previous = turns[turns.length - 1];
  if (previous && turn.text.startsWith(previous.text)) {
    turns[turns.length - 1] = turn;
    return;
  }
  turns.push(turn);
}

/**
 * Extracts every genuine developer turn from a raw transcript file's
 * content, in order.
 *
 * Flow:
 * - Split into lines and parse each as JSON, skipping anything that fails
 *   to parse or is not a plain object — a malformed or truncated line is
 *   dropped, never fatal.
 * - Read it as a Claude Code turn, then, failing that, as a Codex turn.
 * - Drop machine traffic logged under the developer's own role via
 *   {@link ENVELOPE_MARKERS}.
 * - Collapse an immediately-repeated, longer copy of the same message into
 *   one entry (see {@link appendTurn}).
 *
 * @param {string} text The raw transcript file content.
 * @returns {Array<{text: string, timestamp: string|null, uuid: string|null, cwd: string|null, gitBranch: string|null}>}
 * The developer's own turns, in transcript order. Always an array, even for
 * unreadable or empty input.
 */
function extractDeveloperTurns(text) {
  const turns = [];
  if (typeof text !== "string" || !text) return turns;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;

    let turn = null;
    try {
      turn = readClaudeTurn(obj) || readCodexTurn(obj);
    } catch {
      turn = null;
    }
    if (turn) appendTurn(turns, turn);
  }

  return turns;
}

/**
 * Renders one developer turn's markdown entry.
 *
 * @param {object} turn A turn from {@link extractDeveloperTurns}.
 * @param {number} index The turn's zero-based position.
 * @returns {string} The rendered heading and body, without a trailing blank line.
 */
function renderTurn(turn, index) {
  const headingBits = [`### ${index + 1}.`];
  if (turn.timestamp) headingBits.push(turn.timestamp);
  if (turn.gitBranch) headingBits.push(`(${turn.gitBranch})`);
  return `${headingBits.join(" ")}\n\n${turn.text}`;
}

/**
 * Renders the markdown body of a compaction checkpoint file.
 *
 * The opening HTML comment carries the turn count in a machine-readable
 * form (`turns=<N>`), read back by {@link parseCheckpointTurnCount} so a
 * later run can decide whether a fresh extraction is at least as complete
 * as what is already on disk — never a wall-clock value, so rendering the
 * same turns twice produces byte-identical output.
 *
 * @param {object} options
 * @param {Array<{text: string, timestamp: string|null, gitBranch: string|null}>} options.turns
 * The developer's own turns, in order.
 * @param {string} options.sessionId The host session id this checkpoint belongs to.
 * @param {string} options.agent `"claude"` or `"codex"`.
 * @param {string} options.trigger The compaction trigger (`"manual"`, `"auto"`, or a host-specific reason).
 * @param {{cwd: string, gitBranch: string|null, gitHeadShort: string|null, dirtyCount: number|null}} options.state
 * The mechanical state snapshot gathered at write time.
 * @returns {string} The full markdown file content, ending in a single trailing newline.
 */
function renderCheckpoint({ turns, sessionId, agent, trigger, state }) {
  const safeTurns = Array.isArray(turns) ? turns : [];
  const lastTurnTimestamp = safeTurns.length > 0 ? safeTurns[safeTurns.length - 1].timestamp : null;

  const commentBits = [`turns=${safeTurns.length}`, `agent=${agent || "unknown"}`, `trigger=${trigger || "unknown"}`];
  if (lastTurnTimestamp) commentBits.push(`last-turn=${lastTurnTimestamp}`);

  const lines = [
    `<!-- softela-ai-checkpoint ${commentBits.join(" ")} -->`,
    "",
    `# Compaction checkpoint — ${sessionId || "unknown-session"}`,
    "",
    "This file preserves the developer's own messages, verbatim and in order, " +
      "captured immediately before a compaction. Nothing here is summarised or " +
      "inferred — it is the raw record a summary can get wrong. It outranks any " +
      "AI-generated summary of the same conversation.",
    "",
    "## State snapshot",
    "",
    `- cwd: ${(state && state.cwd) || "unknown"}`,
    `- git branch: ${(state && state.gitBranch) || "unknown"}`,
    `- HEAD: ${(state && state.gitHeadShort) || "unknown"}`,
    `- dirty paths: ${state && typeof state.dirtyCount === "number" ? state.dirtyCount : "unknown"}`,
    "",
    `## Developer turns (${safeTurns.length})`,
    "",
  ];

  safeTurns.forEach((turn, index) => {
    lines.push(renderTurn(turn, index), "");
  });

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Reads back the machine-readable turn count a checkpoint file was written
 * with.
 *
 * @param {string} content A checkpoint file's full text.
 * @returns {number | null} The recorded turn count, or `null` when `content`
 * carries none (missing, unparseable, or not a checkpoint file at all).
 */
function parseCheckpointTurnCount(content) {
  if (typeof content !== "string") return null;
  const match = TURN_COUNT_COMMENT_RE.exec(content);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Builds the path a session's checkpoint file would live at.
 *
 * @param {string} memoryDir The resolved memory directory.
 * @param {string} fileStem The sanitised file stem (typically the session id).
 * @returns {string} `<memoryDir>/checkpoints/<fileStem>.md`.
 */
function checkpointPath(memoryDir, fileStem) {
  return path.join(memoryDir, CHECKPOINTS_DIRNAME, `${fileStem}.md`);
}

module.exports = {
  ENVELOPE_MARKERS,
  INTERRUPTION_NOTICES,
  CHECKPOINTS_DIRNAME,
  extractDeveloperTurns,
  renderCheckpoint,
  parseCheckpointTurnCount,
  checkpointPath,
};
