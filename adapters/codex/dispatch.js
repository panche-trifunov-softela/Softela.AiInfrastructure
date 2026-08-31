#!/usr/bin/env node
"use strict";

/**
 * Codex's `PreToolUse` dispatcher.
 *
 * Three jobs only, per CONTRACTS §7 — no rule logic lives here:
 * 1. normalise the payload (delegated to `dispatch-core`);
 * 2. run the engine (also delegated);
 * 3. serialise the decision into Codex's wire format, including the one
 *    thing Codex itself cannot express: an `ask` decision, mapped per
 *    `askMode` (CONTRACTS §7, "There is no native ask on Codex").
 */

const { runDispatch, loadState } = require("../shared/dispatch-core");

/**
 * Reads this installation's `askMode` from local state.
 *
 * @returns {"block" | "advise"} `"advise"` only when the installed state
 * explicitly asks for it; `"block"` otherwise, which is the default because
 * an advisory note is bypassable and a rule must not be bypassable except
 * with the developer's explicit approval.
 */
function resolveAskMode() {
  const { adapterOptions } = loadState("codex");
  return adapterOptions && adapterOptions.askMode === "advise" ? "advise" : "block";
}

/**
 * Composes the reason text for a decision Codex can express natively —
 * a straight `deny` returned by a rule.
 *
 * @param {{reason: string, fix?: string, ruleId: string}} decision The
 * engine's decision.
 * @returns {string} The rule's own reason, then a blank line and
 * `Fix: <fix>` when the decision carries one, then a line naming the rule
 * id — so an override can be written without hunting for which rule spoke.
 */
function composeDenyReason(decision) {
  const parts = [decision.reason];
  if (decision.fix) parts.push(`Fix: ${decision.fix}`);
  parts.push(`Rule: ${decision.ruleId}`);
  return parts.join("\n\n");
}

/**
 * Composes the reason text for an `ask` decision mapped onto a Codex `deny`,
 * in `askMode: "block"`.
 *
 * Codex has no native `ask` — measured against the real binary, `PreToolUse`
 * accepts `deny` and nothing else, and every other spelling is rejected
 * FAIL-OPEN (the hook run is marked failed and the tool call proceeds
 * unreviewed), so mapping onto `deny` is the only shape that actually holds.
 *
 * What changed is how the developer says yes. This used to name
 * `softela-ai approve <ruleId>`, run in a SECOND terminal — the only channel that
 * existed, and a context switch every single time. It now names the
 * in-session channel instead: the developer types one line as their next
 * message, `adapters/shared/approve-from-prompt.js` sees it on
 * `UserPromptSubmit`, and the retry goes through. The guarantee that an
 * approval means a person is unchanged — the host raises that event from the
 * developer's own keystrokes and no tool call can author one.
 *
 * The instruction is addressed to the developer, not to the agent, and says
 * so: an agent that reads this must not type the line itself, and could not
 * make it count if it tried.
 *
 * @param {{reason: string, fix?: string, ruleId: string}} decision The
 * engine's decision.
 * @returns {string} The rule's own reason, its fix when it has one, the line
 * the developer types to approve it, then the rule id.
 */
function composeAskAsDenyReason(decision) {
  const parts = [decision.reason];
  if (decision.fix) parts.push(`Fix: ${decision.fix}`);
  parts.push(
    "This needs the developer's approval before it can proceed. " +
      `If they want it, THEY type \`softela approve ${decision.ruleId}\` as their next message in this session, ` +
      "and this call can then be retried. Ask them — never type it on their behalf, and never route this call " +
      "through a subagent or a shell to get past it.",
  );
  parts.push(`Rule: ${decision.ruleId}`);
  return parts.join("\n\n");
}

/**
 * Composes the advisory text for an `ask` decision the call proceeds
 * through, and the agent is told to act on rather than ignore.
 *
 * Two different things land here, and the closing line says which:
 *
 * - **A nudge** (`decision.advisory`, `core/engine.js` step 10) — a rule
 *   whose `ask` was never a request for the developer's decision: a size
 *   backstop, a reuse reminder, or a structural rule softened to advice
 *   because the file it names already existed. Claude Code shows these as a
 *   one-keystroke prompt; Codex has no interactive ask, so blocking on them
 *   turned every nudge into a typed approval, several times an hour. That
 *   asymmetry — not the number of rules — is what made this host feel like
 *   something to fight rather than something to work with.
 * - **`askMode: "advise"`** — the developer's own global choice to let every
 *   `ask` through, including the ones that genuinely wanted their decision.
 *
 * Neither weakens a `deny`, and neither touches an `ask` that IS a request
 * for a decision — a protected path, a destructive git command — unless the
 * developer asked for exactly that with `askMode`.
 *
 * @param {{reason: string, fix?: string, ruleId: string, advisory?: boolean}} decision
 * The engine's decision.
 * @returns {string} The rule's own reason, its fix when it has one, and a
 * closing line naming why the call was not blocked.
 */
function composeAdviseContext(decision) {
  const parts = [`softela-ai advisory (${decision.ruleId}): ${decision.reason}`];
  if (decision.fix) parts.push(`Fix: ${decision.fix}`);
  parts.push(
    decision.advisory === true
      ? "This is advice, not a block: the call proceeded. Act on it now if it applies — it will not be raised again."
      : 'This call proceeded because askMode is "advise". Raise it with the developer before continuing.',
  );
  return parts.join("\n\n");
}

/**
 * Writes a `deny` decision to stdout in Codex's `PreToolUse` wire format.
 * `permissionDecision: "ask"` and `"allow"` are rejected by name on this
 * host, so `deny` is the only decision this dispatcher ever emits.
 *
 * @param {string} event The host event the decision governs.
 * @param {string} reason The composed, non-empty reason text — Codex
 * rejects a `deny` without one.
 * @returns {void}
 */
function writeDeny(event, reason) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event || "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
}

/**
 * Writes an advisory to stdout in Codex's `PreToolUse` wire format, with no
 * `permissionDecision` — the call proceeds and the agent sees the note.
 *
 * `systemMessage` sits beside `hookSpecificOutput`, not inside it: it is the
 * developer-visible half, where `additionalContext` is the agent-visible one.
 * An advisory only the model can read is not a report. Emitted in exactly the
 * shape `adapters/claude/dispatch.js#writeAdvise` emits, so the same
 * situation reads the same way whichever host the developer is sitting in
 * front of.
 *
 * @param {string} event The host event the decision governs.
 * @param {string} context The composed advisory text.
 * @returns {void}
 */
function writeAdvise(event, context) {
  process.stdout.write(
    `${JSON.stringify({
      systemMessage: context,
      hookSpecificOutput: {
        hookEventName: event || "PreToolUse",
        additionalContext: context,
      },
    })}\n`,
  );
}

/**
 * Runs the dispatcher: silent exit 0 on pass; otherwise a `deny` — direct
 * for a rule's own `deny`, or an `ask` mapped per `askMode` — or an
 * `additionalContext` note that blocks nothing, either because `askMode` is
 * `"advise"`, or because `runDispatch` unwrapped an `exec` call and found a
 * nested operation it could not inspect while nothing else denied. Honours
 * `SOFTELA_AI_EXIT2=1` by additionally exiting 2 with the reason on stderr for an
 * actual denial, never for an advisory that must not block the call it
 * describes (CONTRACTS §7).
 *
 * @returns {Promise<void>}
 */
async function main() {
  const { decision, ctx, advisory } = await runDispatch({ agent: "codex" });
  if (!decision) {
    if (advisory) writeAdvise(ctx.event, advisory);
    return;
  }

  if (decision.action === "ask" && (decision.advisory === true || resolveAskMode() === "advise")) {
    writeAdvise(ctx.event, composeAdviseContext(decision));
    return;
  }

  const reason = decision.action === "ask" ? composeAskAsDenyReason(decision) : composeDenyReason(decision);
  writeDeny(ctx.event, reason);

  if (process.env.SOFTELA_AI_EXIT2 === "1") {
    process.stderr.write(`${reason}\n`);
    process.exitCode = 2;
  }
}

main();
