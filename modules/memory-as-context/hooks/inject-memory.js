#!/usr/bin/env node
"use strict";

/**
 * `SessionStart` hook: injects the memory index, the live work-state file
 * and, when one exists for this session, the most recent pre-compaction
 * checkpoint, as additional context — so durable project knowledge and the
 * developer's own recent words survive compaction and session loss instead
 * of living only in the conversation.
 *
 * Injection is all this does. It carries no drift check and no sync-script
 * wiring: both belong to whatever a developer sets up around their own
 * memory directory, not to the mechanism that reads one.
 * Silent whenever the memory directory holds none of the three expected
 * inputs after seeding — which, on a fresh install, is only until the first
 * run seeds the shipped knowledge base into it (see below).
 *
 * Also registered on Codex's `PostCompact`, since Claude Code has no
 * equivalent event — its `SessionStart` matcher already covers the
 * post-compaction case (`startup|resume|clear|compact`). `emit()` therefore
 * derives the event name it echoes back from the payload instead of
 * hardcoding `"SessionStart"`.
 *
 * Seeds the memory directory from this module's own shipped knowledge base
 * (`seed-memory.js`) before reading anything — the mechanism that makes a
 * fresh install actually inject real content instead of nothing. The seed
 * call is guarded here in addition to `seed-memory.js`'s own internal fail-open
 * wrapper: a seeding failure must never be able to stop injection, belt and
 * braces. `seed-memory.js` itself returns immediately once its own on-disk
 * marker already names the current seed version, so this call costs a single
 * file read on every run after the first (see its own module doc).
 *
 * When a seeding run gets stuck on an ambiguous `MEMORY.md` (`seed-memory.js`'s
 * own module doc explains the mechanism), `seed()`'s return value drives one
 * additional `additionalContext` section the first time that happens — see
 * `main()`'s own comment on it for why this channel, and why only once.
 */

const fs = require("fs");
const path = require("path");
const { parseArgs, resolveMemoryDir, sanitize, UNSPECIFIED_LOCATION } = require("./memory-location");
const { checkpointPath, CHECKPOINTS_DIRNAME } = require("./transcript");
const { readStdin } = require("./stdin");
const { seed } = require("./seed-memory");

/** The index file, read in full when present. */
const INDEX_FILE = "MEMORY.md";

/** The live work-state file, read in full when present. */
const ACTIVE_FILE = "ACTIVE-WORK.md";

/** Keeps each injected file bounded so it never crowds out the actual conversation. */
const MAX_BYTES = 8000;

/**
 * Reads a text file relative to the memory directory, bounded and never
 * throwing. Truncates from the back, keeping the start of the file — right
 * for `MEMORY.md` and `ACTIVE-WORK.md`, which read top-down.
 *
 * @param {string} memoryDir The resolved memory directory.
 * @param {string} name The file name to read.
 * @returns {string | null} The file's content, truncated with a note past
 * {@link MAX_BYTES}, or `null` when the file cannot be read.
 */
function readBounded(memoryDir, name) {
  try {
    const text = fs.readFileSync(path.join(memoryDir, name), "utf8");
    if (text.length <= MAX_BYTES) return text;
    return `${text.slice(0, MAX_BYTES)}\n\n...(truncated — read ${name} in full)`;
  } catch {
    return null;
  }
}

/**
 * Reads an absolute file path, bounded and never throwing. Truncates from
 * the front, keeping the end of the file — the opposite direction from
 * {@link readBounded}, because a checkpoint's most recent turns sit at the
 * bottom and are the ones that matter after a compaction.
 *
 * @param {string} filePath The absolute file path to read.
 * @returns {string | null} The file's content, truncated with a note before
 * {@link MAX_BYTES}, or `null` when the file cannot be read.
 */
function readBoundedFromEnd(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    if (text.length <= MAX_BYTES) return text;
    return `...(earlier turns truncated — read ${path.basename(filePath)} in full)\n\n${text.slice(text.length - MAX_BYTES)}`;
  } catch {
    return null;
  }
}

/**
 * Resolves which checkpoint file to inject for this session: the one named
 * for the current session id when it exists, otherwise the most recently
 * modified checkpoint on disk.
 *
 * @param {string} memoryDir The resolved memory directory.
 * @param {string} sessionId The host's session id; may be empty when unknown.
 * @returns {string | null} An absolute checkpoint file path, or `null` when
 * none is found.
 */
function resolveCheckpointFile(memoryDir, sessionId) {
  if (sessionId) {
    const candidate = checkpointPath(memoryDir, sanitize(sessionId));
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Falls through to the most-recently-modified fallback below.
    }
  }

  const checkpointsDir = path.join(memoryDir, CHECKPOINTS_DIRNAME);
  try {
    const newest = fs
      .readdirSync(checkpointsDir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => {
        const full = path.join(checkpointsDir, name);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)[0];
    return newest ? newest.full : null;
  } catch {
    return null;
  }
}

/**
 * Writes the hook payload — always a valid JSON document, even when there is
 * nothing to inject.
 *
 * Zero-byte stdout is harmless on Claude Code (an empty stream is simply not
 * parsed), but is not on Codex: `PostCompact` and `SessionStart` there
 * unconditionally parse stdout as JSON, and empty stdout is not valid
 * JSON — the observed failure was a `PostCompact hook (failed)` line firing
 * in exactly the state every fresh install begins in, before any memory
 * content exists to inject. `additionalContext` is therefore omitted
 * entirely rather than sent as an empty string when there is nothing to say:
 * CONTRACTS.md's own documented Codex `hookSpecificOutput` shapes
 * (`writeDeny`/`writeAdvise` in `adapters/codex/dispatch.js`) each include
 * only the field that applies to their own case and omit the other, and
 * nothing in this repository's Codex evidence (`CONTRACTS.md`'s "Verified
 * Codex payload/registration" sections) ever sends `additionalContext` as an
 * empty string — an absent optional field is the shape this codebase already
 * uses elsewhere for "nothing to add here", so it is the one applied here too.
 *
 * @param {string} eventName The host event name to echo back — `"SessionStart"`
 * on Claude Code and on Codex's own `SessionStart`, `"PostCompact"` when this
 * script is registered there instead.
 * @param {string} additionalContext The context block to inject; the
 * `hookSpecificOutput.additionalContext` key is omitted entirely when this
 * is empty, rather than sent as `""`.
 * @returns {void}
 */
function emit(eventName, additionalContext) {
  const hookSpecificOutput = { hookEventName: eventName };
  if (additionalContext) hookSpecificOutput.additionalContext = additionalContext;
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
}

/**
 * Runs the hook body once stdin has been read.
 *
 * Mirrors the script's previous fully-synchronous top-level flow exactly —
 * only the stdin acquisition changed, from a blocking `fs.readFileSync(0)`
 * to the non-blocking {@link readStdin}.
 *
 * @returns {Promise<void>}
 */
async function main() {
  let payload = {};
  try {
    payload = JSON.parse((await readStdin()) || "{}") || {};
  } catch {
    // A malformed or absent payload just falls back to process.cwd() below.
  }

  const args = parseArgs(process.argv.slice(2));
  const agentHome = args["agent-home"] || "";
  const location = args.location || UNSPECIFIED_LOCATION;
  const cwd = payload.cwd || payload.workspace || payload.working_directory || process.cwd();
  const eventName = payload.hook_event_name || payload.hookEventName || "SessionStart";
  const sessionId = payload.session_id || payload.sessionId || "";

  if (!agentHome) process.exit(0);

  const memoryDir = resolveMemoryDir({ agentHome, cwd, location });

  let seedResult = { indexAmbiguous: false, indexAmbiguousReason: null, newlyDetected: false };
  try {
    seedResult = seed({ memoryDir, agentHome }) || seedResult;
  } catch {
    // Belt and braces on top of seed-memory.js's own fail-open wrapper — a
    // seeding failure must never be able to stop injection.
  }

  const checkpointFile = resolveCheckpointFile(memoryDir, sessionId);
  const checkpoint = checkpointFile ? readBoundedFromEnd(checkpointFile) : null;
  const active = readBounded(memoryDir, ACTIVE_FILE);
  const index = readBounded(memoryDir, INDEX_FILE);

  const parts = [];

  // Surfaced here, in additionalContext, rather than on stderr or into a log
  // file: this is the one channel already guaranteed to reach the
  // developer, since it lands directly in the conversation, the same reason
  // every other section on this page uses it. Shown once — only on the run
  // that first detects a given ambiguity (`newlyDetected`) — never repeated
  // every session while the same ambiguity persists; `softela-ai doctor` is
  // where its ongoing "still stuck" status stays checkable without
  // resending the same paragraph into every later conversation.
  if (seedResult.indexAmbiguous && seedResult.newlyDetected) {
    parts.push(
      "## Knowledge-base index needs attention\n\n" +
        `\`seed-memory.js\` could not update ${INDEX_FILE}'s generated index block: ${seedResult.indexAmbiguousReason}. ` +
        "It only ever touches a block it can locate unambiguously — exactly one BEGIN marker, exactly one END marker, " +
        `BEGIN before END — so it left ${INDEX_FILE} untouched rather than guessing. Edit the file by hand so exactly ` +
        "one `softela-ai` managed block remains, and the next session start applies the index automatically — no reinstall " +
        "or version bump needed. This notice is shown once; run `softela-ai doctor` at any time to check whether it is still unresolved.",
    );
  }

  if (checkpoint) {
    parts.push(
      "## Compaction checkpoint — the developer's own words, verbatim\n\n" +
        "Everything below this heading is exactly what the developer typed, in " +
        "order, captured immediately before the most recent compaction — " +
        "nothing summarised, nothing inferred. It outranks any AI-generated " +
        "summary of the same conversation, since a summary is exactly the " +
        "thing that gets this content wrong.\n\n" +
        checkpoint,
    );
  }

  if (active) {
    parts.push(
      `## Active work (from ${ACTIVE_FILE})\n\n` +
        "This state lives on disk, not in the conversation — it survives " +
        "compaction and a lost session. Update the file as soon as the state " +
        "it describes actually changes.\n\n" +
        active,
    );
  }

  if (index) {
    parts.push(
      `## Knowledge-base index (from ${INDEX_FILE})\n\n` +
        "Follow the links relevant to the task from here instead of " +
        "re-deriving what is already known.\n\n" +
        index,
    );
  }

  if (parts.length > 0) {
    parts.push(
      "## The authority model\n\n" +
        "- A section headed `## INTENT — <topic>` records agreed,\n" +
        "  developer-confirmed design. It is the authority; code that\n" +
        "  disagrees with it is evidence of a bug in the code, not of stale\n" +
        "  memory. Never rewrite or delete it because code was observed to\n" +
        "  behave differently.\n" +
        "- A section headed `## AS-OBSERVED <date> @ <ref>` records what the\n" +
        "  code actually does, verified against a named ref. Refresh it\n" +
        "  freely, and re-date and re-ref it every time.\n" +
        "- A section headed `## CONFLICT <date>` records code contradicting\n" +
        "  an INTENT block: state both sides, report it, and leave the\n" +
        "  INTENT standing. A conflict is a finding, not permission to\n" +
        "  overwrite.",
    );
  }

  emit(eventName, parts.join("\n\n---\n\n"));
}

main();
