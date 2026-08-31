#!/usr/bin/env node
"use strict";

/**
 * Claude Code's `PreToolUse` dispatcher.
 *
 * Three jobs only, per CONTRACTS §7 — no rule logic lives here:
 * 1. normalise the payload (delegated to `dispatch-core`);
 * 2. run the engine (also delegated);
 * 3. serialise the decision into Claude Code's wire format.
 */

const { runDispatch } = require("../shared/dispatch-core");

/**
 * Composes the reason text shown to the developer.
 *
 * @param {{reason: string, fix?: string, ruleId: string}} decision The
 * engine's decision.
 * @returns {string} The rule's own reason, then a blank line and
 * `Fix: <fix>` when the decision carries one, then a line naming the rule
 * id — so an override can be written without hunting for which rule spoke.
 */
function composeReason(decision) {
  const parts = [decision.reason];
  if (decision.fix) parts.push(`Fix: ${decision.fix}`);
  parts.push(`Rule: ${decision.ruleId}`);
  return parts.join("\n\n");
}

/**
 * Writes a decision to stdout in Claude Code's `PreToolUse` wire format.
 *
 * @param {string} event The host event the decision governs.
 * @param {"deny" | "ask"} permissionDecision The action Claude Code should
 * take.
 * @param {string} reason The composed reason text.
 * @returns {void}
 */
function writeDecision(event, permissionDecision, reason) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event || "PreToolUse",
        permissionDecision,
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
}

/**
 * Writes an advisory to stdout in Claude Code's `PreToolUse` wire format,
 * with no `permissionDecision` — the call proceeds, the agent reads the note
 * as context, and the developer sees it as a system message.
 *
 * Deliberately byte-for-byte the same shape
 * `adapters/codex/dispatch.js#writeAdvise` emits, because it reports the same
 * thing for the same reason. Until this existed, `runDispatch`'s advisory
 * channel was simply dropped on this host: a nested operation that could not
 * be inspected was reported to a Codex developer and silently to a Claude
 * Code one, which is exactly the kind of per-host divergence the shared core
 * exists to prevent.
 *
 * `systemMessage` sits beside `hookSpecificOutput`, not inside it — it is the
 * developer-visible half, where `additionalContext` is the agent-visible one.
 * An advisory nobody but the model can read is not a report.
 *
 * @param {string} event The host event the advisory relates to.
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
 * Runs the dispatcher: silent exit 0 on pass; an `additionalContext` note
 * that blocks nothing when nothing decided but a write or a nested operation
 * could not be inspected; the composed decision on `deny` or `ask`
 * otherwise — except an `ask` marked `advisory: true` (`core/engine.js` step
 * 10: a nudge rather than a request for the developer's decision), which is
 * routed through the same advisory channel instead of a permission prompt,
 * so the call proceeds and the agent reads the note as context. Honours
 * `SOFTELA_AI_EXIT2=1` by additionally exiting 2 with the reason on stderr for a
 * `deny`, for a host or version that does not honour the JSON path
 * (CONTRACTS §7). Never for an `ask` — a plain one is a genuine request for
 * the developer's decision and Claude Code already honours
 * `permissionDecision: "ask"` natively, and an advisory one must never block
 * at all — exiting 2 in either case would turn a prompt the developer is
 * meant to see, or a note the developer is not meant to be blocked by, into
 * a hard stop.
 *
 * `additionalContext` on `PreToolUse` is a comparatively recent Claude Code
 * capability. On an older build that does not honour it, the note is
 * silently dropped — but the tool call still proceeds, so the worst outcome
 * is advice the agent never sees, never a block the developer has to clear.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const { decision, ctx, advisory } = await runDispatch({ agent: "claude" });
  if (!decision) {
    if (advisory) writeAdvise(ctx.event, advisory);
    return;
  }

  const reason = composeReason(decision);

  if (decision.action === "ask" && decision.advisory === true) {
    writeAdvise(ctx.event, reason);
    return;
  }

  writeDecision(ctx.event, decision.action, reason);

  if (decision.action === "deny" && process.env.SOFTELA_AI_EXIT2 === "1") {
    process.stderr.write(`${reason}\n`);
    process.exitCode = 2;
  }
}

main();
