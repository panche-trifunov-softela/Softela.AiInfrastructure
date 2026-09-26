#!/usr/bin/env node
"use strict";

/**
 * `PreCompact` hook: right before a compaction — manual or automatic — drops
 * conversation history, extracts every message the developer themselves
 * typed, verbatim and in order, plus a small mechanical state snapshot, and
 * writes it to `<memoryDir>/checkpoints/<session-id>.md`.
 *
 * A hook cannot judge which of the *agent's* own conclusions matter — that
 * stays `ACTIVE-WORK.md`'s job, kept current by the agent itself. What a
 * hook can do losslessly is preserve the one thing summarisation damages
 * most and needs no interpretation to preserve: the developer's own words.
 * The two are complementary, not competing.
 *
 * `PreCompact`'s schema allows only the universal output keys
 * (`systemMessage`, `suppressOutput`, `decision`, `reason`, `continue`,
 * `stopReason`) — the event type does not support any hook-specific output.
 * This script respects that constraint and never attempts to emit
 * `hookSpecificOutput`.
 *
 * The safety rule that matters more than any feature here: a bad run must
 * never make the checkpoint worse than what is already on disk. An
 * unreadable transcript, or an extraction yielding fewer developer turns
 * than the existing checkpoint records, leaves the existing file untouched.
 * Every other successful run rewrites the file in full — the transcript is
 * cumulative, so a full rewrite is idempotent and cannot drift.
 *
 * Never blocks or delays compaction, never sets `decision`/`continue`, and
 * fails open unconditionally: a bug in this script degrades to doing
 * nothing, never to breaking compaction.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { parseArgs, resolveMemoryDir, ensureSelfIgnored, findGitRoot, sanitize, UNSPECIFIED_LOCATION } = require("./memory-location");
const { extractDeveloperTurns, renderCheckpoint, parseCheckpointTurnCount, checkpointPath } = require("./transcript");
const { readStdin } = require("./stdin");

/**
 * How many most-recently-modified checkpoint files survive a pruning pass in
 * {@link pruneCheckpoints}. Each file is one session's worth of the
 * developer's own verbatim pre-compaction turns, so this bounds how many past
 * sessions' checkpoints stay recoverable on disk at once, not how much
 * content injection reads for the current session (only the single most
 * relevant file is read, by {@link resolveCheckpointFile} in
 * `inject-memory.js`). {@link pruneCheckpoints}'s own cost is one directory
 * listing plus one `stat` per file — trivial even at this size.
 *
 * A checkpoint file is the developer's only verbatim record of what they
 * typed before a compaction — once the transcript itself is gone, nothing
 * else preserves it. This cap is a backstop against an unbounded directory,
 * not a budget to spend down: 1000 keeps a long developer history of
 * sessions recoverable on disk while still pruning anything genuinely stale.
 */
const MAX_CHECKPOINTS = 1000;

/** Timeout for each `git` call, so an unresponsive repository can never hang compaction. */
const GIT_TIMEOUT_MS = 3000;

/**
 * Exits the process, optionally emitting a hook payload first.
 *
 * @param {object | null} payload The JSON payload to write to stdout, or
 * `null` for a silent pass.
 * @returns {void}
 */
function finish(payload) {
  try {
    if (payload) process.stdout.write(JSON.stringify(payload));
  } catch {
    // Never let output serialisation keep the hook from exiting.
  }
  process.exit(0);
}

/**
 * Runs a single `git` command in a fixed working directory, never throwing.
 *
 * @param {string[]} gitArgs Arguments passed after `git`.
 * @param {string} cwd The directory to run it in.
 * @returns {string | null} Trimmed stdout, or `null` on any failure.
 */
function safeGit(gitArgs, cwd) {
  try {
    const out = execFileSync("git", gitArgs, { cwd, timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
    return out.toString("utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Gathers a small mechanical snapshot of where the developer stood right
 * before compaction — never anything a model had to interpret.
 *
 * @param {string} cwd The working directory the current tool call ran against.
 * @returns {{cwd: string, gitBranch: string|null, gitHeadShort: string|null, dirtyCount: number|null}}
 * The snapshot; every git-derived field is `null` when `cwd` is not inside a
 * readable git repository.
 */
function gatherState(cwd) {
  const repoRoot = findGitRoot(cwd);
  if (!repoRoot) return { cwd, gitBranch: null, gitHeadShort: null, dirtyCount: null };

  const gitBranch = safeGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  const gitHeadShort = safeGit(["rev-parse", "--short", "HEAD"], repoRoot);
  const statusOut = safeGit(["status", "--porcelain"], repoRoot);
  const dirtyCount = statusOut !== null ? statusOut.split(/\r?\n/).filter((line) => line.trim()).length : null;

  return { cwd, gitBranch, gitHeadShort, dirtyCount };
}

/**
 * Prunes a checkpoints directory down to its {@link MAX_CHECKPOINTS} most
 * recently modified files.
 *
 * @param {string} checkpointsDir The directory holding `*.md` checkpoints.
 * @returns {void}
 */
function pruneCheckpoints(checkpointsDir) {
  try {
    const entries = fs
      .readdirSync(checkpointsDir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => {
        const full = path.join(checkpointsDir, name);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const entry of entries.slice(MAX_CHECKPOINTS)) {
      try {
        fs.unlinkSync(entry.full);
      } catch {
        // Best-effort retention only — a stray extra file is not a correctness bug.
      }
    }
  } catch {
    // Retention must never affect the write that already happened.
  }
}

/**
 * Runs the whole hook body. Isolated from the top-level fail-open wrapper so
 * every exit path — including an unexpected throw partway through — is
 * guaranteed to fall back to a silent pass.
 *
 * Only the stdin acquisition changed from this function's previous, fully
 * synchronous form: a blocking `fs.readFileSync(0)` became the non-blocking
 * {@link readStdin}. Every other line is unchanged.
 *
 * @returns {Promise<void>}
 */
async function run() {
  let payload = {};
  try {
    payload = JSON.parse((await readStdin()) || "{}") || {};
  } catch {
    finish(null);
  }

  const args = parseArgs(process.argv.slice(2));
  if (args.checkpoint === "off") finish(null);

  const agentHome = args["agent-home"] || "";
  const location = args.location || UNSPECIFIED_LOCATION;
  const agent = args.agent === "codex" ? "codex" : "claude";
  if (!agentHome) finish(null);

  const cwd = payload.cwd || payload.workspace || payload.working_directory || process.cwd();
  const memoryDir = resolveMemoryDir({ agentHome, cwd, location });
  ensureSelfIgnored(memoryDir, agentHome);

  const sessionId = typeof payload.session_id === "string" && payload.session_id ? payload.session_id : "unknown";
  const trigger = payload.trigger || payload.reason || "unknown";
  const transcriptPathValue = payload.transcript_path || payload.transcriptPath || "";

  let transcriptText = null;
  try {
    transcriptText = transcriptPathValue ? fs.readFileSync(transcriptPathValue, "utf8") : null;
  } catch {
    transcriptText = null;
  }

  let transcriptReadable = transcriptText !== null;
  let turns = [];
  if (transcriptReadable) {
    try {
      turns = extractDeveloperTurns(transcriptText);
    } catch {
      transcriptReadable = false;
      turns = [];
    }
  }

  const file = checkpointPath(memoryDir, sanitize(sessionId));

  let existingContent = null;
  try {
    existingContent = fs.readFileSync(file, "utf8");
  } catch {
    existingContent = null;
  }
  const existingCount = existingContent !== null ? parseCheckpointTurnCount(existingContent) : null;
  const worseThanExisting = existingCount !== null && turns.length < existingCount;

  if (!transcriptReadable || worseThanExisting) {
    const reason = !transcriptReadable
      ? existingContent !== null
        ? "the transcript could not be read; the existing checkpoint was left intact"
        : "the transcript could not be read; there was no existing checkpoint to preserve"
      : `this pass found ${turns.length} developer turn(s), fewer than the ${existingCount} the existing checkpoint already records; it was left intact`;
    finish({ systemMessage: `Compaction checkpoint: ${reason} (${file}).` });
  }

  if (turns.length === 0) {
    // A genuinely empty transcript — nothing to preserve and nothing worth reporting.
    finish({ suppressOutput: true });
  }

  const state = gatherState(cwd);
  const body = renderCheckpoint({ turns, sessionId, agent, trigger, state });

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, "utf8");
    pruneCheckpoints(path.dirname(file));
  } catch {
    finish(null);
  }

  finish({
    systemMessage: `Compaction checkpoint: ${turns.length} developer turn${turns.length === 1 ? "" : "s"} preserved verbatim at ${file}.`,
  });
}

// `run()` is async, so a throw anywhere inside it — before or after its own
// `await` — surfaces as a rejection of the promise it returns rather than a
// synchronous throw here; `.catch()` is this wrapper's async equivalent of
// the synchronous `try`/`catch` it replaces, with the same fail-open result.
run().catch(() => finish(null));
