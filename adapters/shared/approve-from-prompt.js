#!/usr/bin/env node
"use strict";

/**
 * The in-session approval channel: a `UserPromptSubmit` hook that grants a
 * time-boxed approval when the DEVELOPER types one, in the session they are
 * already sitting in.
 *
 * ## Why this exists
 *
 * `ask` is only usable if there is a way to say yes. Claude Code renders a
 * native prompt and the developer answers it with a keystroke. Codex cannot:
 * measured against the real binary (0.149.1), a `PreToolUse` hook may return
 * exactly one decision, `deny`. Every other spelling — `ask`, `allow`,
 * `escalate`, `confirm`, `prompt`, `approve`, `review`, `elicit` — is
 * rejected, and rejected FAIL-OPEN: the hook run is marked failed and the
 * tool call proceeds unreviewed. So an `ask` on Codex had to become a denial,
 * and the only documented way out was `softela-ai approve <ruleId>` typed into a
 * SECOND terminal. That turned a rule that merely wanted a second look into a
 * context switch, several times a day, and it is the reason the mechanism was
 * rejected in practice.
 *
 * This hook removes the second terminal. The denial now says: type
 * `softela approve <ruleId>` as your next message. The developer does, in the
 * same session; this hook sees that message and writes the approval; the
 * agent retries and the rule is satisfied.
 *
 * ## Why the agent cannot use it to approve itself
 *
 * `infra-self-protection` exists because "approval" has to mean a person.
 * That guarantee survives here, and it is structural rather than a matter of
 * wording:
 *
 * - `UserPromptSubmit` is raised by the HOST from what the developer typed.
 *   A tool call cannot emit one. The agent has no way to author the event.
 * - A subagent does not raise it either. Measured on Codex 0.149.1 with
 *   `multi_agent_v2` enabled: spawning a subagent and running it to
 *   completion produced exactly one `UserPromptSubmit` — the developer's own
 *   message — and none for the spawn or for anything the subagent did.
 *   Belt and braces, a payload carrying `agent_id`/`agent_type` (how both
 *   hosts mark a subagent's own events) is ignored here anyway.
 * - The grant is time-boxed by `core/lib/approvals.js`, exactly like the CLI
 *   grant, and is written to the same file `softela-ai approve --list` and
 *   `doctor` already report. Nothing new becomes approvable; only the way the
 *   developer says yes changes.
 *
 * ## What it does not do
 *
 * It never blocks a prompt, never rewrites one, and never fails a turn. An
 * unparseable payload, an unreadable state directory, a malformed rule id —
 * every one of them exits silently and lets the prompt through untouched, the
 * same fail-open direction CONTRACTS §7a requires of the dispatcher. A hook
 * that can break the developer's ability to type a message is worse than no
 * hook at all.
 */

const { readStdin, parsePayload } = require("../../core/lib/hook-stdin");
const approvals = require("../../core/lib/approvals");

/**
 * Writes a note the agent reads as context and the developer reads as a
 * system message, in the shape both hosts accept, then returns.
 *
 * Never carries a decision: `UserPromptSubmit` is not a gate here, and this
 * hook must never be able to swallow or alter what the developer typed.
 *
 * @param {string} event The host's own event name, echoed back.
 * @param {string} context The note.
 * @returns {void}
 */
function report(event, context) {
  try {
    process.stdout.write(
      `${JSON.stringify({
        systemMessage: context,
        hookSpecificOutput: { hookEventName: event || "UserPromptSubmit", additionalContext: context },
      })}\n`,
    );
  } catch {
    // A broken stdout must not fail the developer's turn.
  }
}

/**
 * Recognises an approval the developer typed, and nothing else.
 *
 * Deliberately strict about its own shape and deliberately generous about
 * what may surround it, because these are different risks. The command must
 * appear at the very start of the message — an approval buried mid-sentence
 * is far more likely to be the developer DISCUSSING a rule ("softela approve
 * branch-naming is what it told me to run") than issuing one — but anything
 * after the rule id is ignored, so a trailing comment costs nothing.
 *
 * `/` and `$` prefixes are accepted because that is how each host spells a
 * command in its own composer, and a developer who has just been told to type
 * this will reasonably reach for the prefix their tool uses.
 *
 * A rule id is matched against the shape every rule in this repository
 * actually uses — lowercase, kebab-case — rather than against the live
 * registry, so this file has no reason to load it. An id that matches the
 * shape but names no rule simply writes an approval nothing ever reads, which
 * is inert; an id that does not match the shape is not treated as a command
 * at all.
 *
 * The id must run to whitespace or to the end of the message. Without that,
 * a mistyped id silently matched its own longest valid PREFIX — `softela approve
 * Not_Valid` granting `not` — which is worse than refusing: the developer
 * believes they approved something, and something else entirely was written.
 */
const APPROVE_RE = /^\s*[/$]?softela(?:-ai)?\s+approve\s+([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?=\s|$)/i;

/**
 * How long an in-session grant lasts, in minutes.
 *
 * Deliberately shorter than `approvals.DEFAULT_MINUTES` (the CLI's own hour).
 * The two are not the same act: a developer who leaves their terminal to run
 * a CLI command has visibly decided something, while this is one line typed
 * mid-flow to let the work in front of them continue. A grant meant to unblock
 * the next retry should not still be live an hour later, after the
 * conversation has moved on to something the developer never looked at.
 */
const IN_SESSION_MINUTES = 10;

/**
 * Reports whether a payload belongs to the main session rather than to a
 * subagent.
 *
 * Both hosts mark a subagent's own events with `agent_id`/`agent_type` and
 * leave them absent on the main session's — measured on Codex 0.149.1, where
 * a subagent's tool calls carry `agent_id` and `agent_type: "default"` and
 * the session's own carry neither. No `UserPromptSubmit` has ever been
 * observed carrying them, so this is a second lock on a door that is already
 * shut, not the only one.
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
    payload = parsePayload(await readStdin());
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object" || !isMainSession(payload)) return;

  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  const match = prompt.match(APPROVE_RE);
  if (!match) return;

  const ruleId = match[1].toLowerCase();
  const agent = process.argv.some((a) => a === "--agent=codex") ? "codex" : "claude";

  // `grant` reports rather than throws, so an unwritable state directory is a
  // `false` here, never an exception that would take the turn down with it.
  const granted = approvals.grant(ruleId, IN_SESSION_MINUTES, { agent });

  if (!granted) {
    report(
      payload.hook_event_name,
      `softela-ai: could not record an approval for "${ruleId}" — its state file could not be written. ` +
        "Nothing was approved and the rule is still in force.",
    );
    return;
  }

  report(
    payload.hook_event_name,
    `softela-ai: the developer approved "${ruleId}" for the next ${IN_SESSION_MINUTES} minutes. ` +
      "Retry the call that was blocked. This covers that one rule and nothing else — every other rule still " +
      "applies, and it is not a reason to retry anything that was blocked for a different reason.",
  );
}

main();
