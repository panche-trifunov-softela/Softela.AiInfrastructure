#!/usr/bin/env node
"use strict";

/**
 * A `UserPromptSubmit` reminder that keeps the plan-first rule live for the
 * whole session, not only for the first few turns.
 *
 * ## Why this exists
 *
 * The generated rulebook is injected once, at session start. In a long
 * session that block ends up at the top of a growing context and stops
 * binding by the time it matters most — deep into the session, on the
 * change that is actually large or destructive. A rule an agent read once
 * an hour ago is not a rule it is still weighing against the request in
 * front of it right now.
 *
 * This hook re-states the "analyse first, then wait" gate next to every
 * developer message instead, so the reminder is always as close to the
 * request as the request itself.
 *
 * ## What it must never do
 *
 * The developer must see nothing at all: this is context for the agent, not
 * a message for the person typing. Unlike `approve-from-prompt.js`, which
 * intentionally shows the same text to both, this hook prints only
 * `hookSpecificOutput.additionalContext` — a `systemMessage` shown on every
 * single prompt would be intolerable.
 *
 * It also never blocks a prompt, never rewrites one, and never fails a
 * turn. Unparseable stdin, a non-object payload, or a subagent's own event —
 * every one of them exits silently. A hook that can break the developer's
 * ability to type a message is worse than no hook at all.
 */

const { hookStdin } = require("./analyze-first-core-lib");
const { readStdin } = hookStdin;

/**
 * The reminder text, printed verbatim on every main-session prompt.
 */
const PLAN_GATE_REMINDER =
  "Before you edit: read the relevant memory, the surrounding code and the applicable standard — never assert a " +
  "fact about the codebase you have not read this session. Then propose a concrete plan — what changes, where, " +
  "and why — and wait for the developer's explicit go-ahead; silence is not a yes. Build the approved plan, not " +
  "a variation decided along the way, and when two readings of the request would produce materially different " +
  "work, ask which one is meant.";

/**
 * Reports the reminder as agent-only context.
 *
 * Carries no `systemMessage` — a reminder shown to the developer on every
 * message would be intolerable, unlike `approve-from-prompt.js`'s own
 * `report`, which deliberately shows both.
 *
 * @param {string} event The host's own event name, echoed back.
 * @returns {void}
 */
function report(event) {
  try {
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: { hookEventName: event || "UserPromptSubmit", additionalContext: PLAN_GATE_REMINDER },
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
 * A subagent has nobody to propose a plan to, so it gets no reminder — the
 * same check `approve-from-prompt.js#isMainSession` uses, repeated here
 * rather than shared, since each hook script is invoked standalone by its
 * own host command.
 *
 * @param {object} payload The parsed hook payload.
 * @returns {boolean} `true` when nothing in the payload marks it as a
 * subagent's.
 */
function isMainSession(payload) {
  return !payload.agent_id && !payload.agent_type;
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

  report(payload.hook_event_name);
}

main();
