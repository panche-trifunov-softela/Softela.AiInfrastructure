#!/usr/bin/env node
"use strict";

/**
 * A `UserPromptSubmit` reminder that keeps the delegation rule live for the
 * whole session, not only for the first few turns.
 *
 * ## Why this exists
 *
 * The generated rulebook is injected once, at session start, and in a long
 * session it ends up buried under everything that followed. By the time a
 * task genuinely calls for bulk reading or a fan-out, the rule that would
 * have said so is no longer near the top of the agent's own context. This
 * hook re-states the "you are the orchestrator" rule next to every
 * developer message instead, so it is always as close to the request as the
 * request itself — see `modules/analyze-first/hooks/inject-plan-gate.js` for
 * the sibling hook doing the same thing for the plan-first rule.
 *
 * ## What it must never do
 *
 * The developer must see nothing at all: this is context for the agent, not
 * a message for the person typing. Unlike `approve-from-prompt.js`, which
 * intentionally shows the same text to both, this hook prints only
 * `hookSpecificOutput.additionalContext`.
 *
 * It never blocks a prompt, never rewrites one, and never fails a turn.
 * Unparseable stdin, a non-object payload, a subagent's own event, or a
 * failed log append — every one of them is silent, and none of them stop
 * the reminder itself from printing when the payload is otherwise valid.
 *
 * ## The task-boundary marker
 *
 * `core/lib/task-tally.js#readTaskTally` reads the guard-activity log back to
 * count how many distinct files the CURRENT task has touched, so a guard can
 * tell "the agent did this itself" apart from "the agent delegated it". That
 * count is only meaningful from the start of the task in front of the agent
 * right now — a tally that also included every file the previous task
 * touched would flag delegation for work that already finished.
 *
 * A prompt is the only honest boundary between one task and the next: the
 * developer's own message is what starts a new piece of work, and nothing
 * else in either host's event stream marks that moment as reliably. So this
 * hook appends one marker line per prompt to the same guard-activity log
 * `adapters/shared/dispatch-core.js#logGuardActivity` already writes to,
 * carrying only what a counter needs to find its own starting point:
 * `ts`, `agent`, `event: "UserPromptSubmit"` and `sessionId`.
 * `core/lib/task-tally.js#findLastBoundaryIndex` is what reads it back.
 */

const { hookStdin, paths, fsSafe } = require("./agent-orchestration-core-lib");
const { readStdin } = hookStdin;
const { guardLogPath, formatLogDate } = paths;
const { appendLineSafe } = fsSafe;

/**
 * The reminder text, printed verbatim on every main-session prompt.
 */
const DELEGATION_MODE_REMINDER =
  "Before you read or edit several files yourself: you are the orchestrator — analyse, decide and verify, and " +
  "delegate the reading and the typing. Reading a set of files, writing code already designed, running a known " +
  "command, gathering information from the web: spawn a subagent with an explicit model tier and a prompt that " +
  "carries the task's own context. Keep for yourself reviewing what it produced and establishing the one fact a " +
  "decision turns on. One level only — a subagent never spawns another.";

/**
 * Reports the reminder as agent-only context.
 *
 * Carries no `systemMessage` — a reminder shown to the developer on every
 * message would be intolerable.
 *
 * @param {string} event The host's own event name, echoed back.
 * @returns {void}
 */
function report(event) {
  try {
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: event || "UserPromptSubmit",
          additionalContext: DELEGATION_MODE_REMINDER,
        },
      })}\n`,
    );
  } catch {
    // A broken stdout must not fail the developer's turn.
  }
}

/**
 * Reports whether a payload belongs to the main session rather than to a
 * subagent.
 *
 * A subagent has nobody to delegate to on its own behalf, so it gets no
 * reminder and writes no marker — the same check
 * `approve-from-prompt.js#isMainSession` uses, repeated here rather than
 * shared, since each hook script is invoked standalone by its own host
 * command.
 *
 * @param {object} payload The parsed hook payload.
 * @returns {boolean} `true` when nothing in the payload marks it as a
 * subagent's.
 */
function isMainSession(payload) {
  return !payload.agent_id && !payload.agent_type;
}

/**
 * Reads the session id off a payload, tolerating either naming a host might
 * use.
 *
 * @param {object} payload The parsed hook payload.
 * @returns {string | null} The session id, or `null` when neither field is a
 * non-empty string.
 */
function readSessionId(payload) {
  if (typeof payload.session_id === "string" && payload.session_id) return payload.session_id;
  if (typeof payload.sessionId === "string" && payload.sessionId) return payload.sessionId;
  return null;
}

/**
 * Appends one task-boundary marker to today's guard-activity log.
 *
 * Never throws and never reports failure to its caller — `appendLineSafe`
 * already fails closed on its own, and this wraps the path-resolution calls
 * around it too, so a problem resolving the log's own path can no more stop
 * the reminder from printing than a failed write can.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @param {string | null} sessionId The session the marker belongs to.
 * @returns {void}
 */
function appendTaskBoundaryMarker(agent, sessionId) {
  try {
    const now = new Date();
    const logPath = guardLogPath(agent, formatLogDate(now));
    const record = { ts: now.toISOString(), agent, event: "UserPromptSubmit", sessionId };
    appendLineSafe(logPath, JSON.stringify(record));
  } catch {
    // A logging failure must never be audible — the reminder still prints.
  }
}

/**
 * Runs the hook.
 *
 * @returns {Promise<void>}
 */
async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object" || !isMainSession(payload)) return;

  const agent = process.argv.some((a) => a === "--agent=codex") ? "codex" : "claude";
  appendTaskBoundaryMarker(agent, readSessionId(payload));

  report(payload.hook_event_name);
}

main();
