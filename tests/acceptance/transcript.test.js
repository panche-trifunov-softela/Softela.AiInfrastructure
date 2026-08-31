"use strict";

/**
 * Unit tests of `tools/acceptance/transcript.js` — the normaliser that makes
 * host parity real for the acceptance scorer. Every fixture line here is
 * hand-authored in the exact shape read off real transcripts on this
 * machine (see `transcript.js`'s own doc comment for where), never copied
 * from a real session.
 */

const { suite } = require("../harness");
const { normalizeTranscript, normalizeClaudeTranscript, normalizeCodexTranscript, isCodexSubagentRollout } = require("../../tools/acceptance/transcript");

/**
 * Joins plain objects into `.jsonl` text, the shape both normalisers read.
 *
 * @param {object[]} lines The lines to join.
 * @returns {string} The joined text.
 */
function jsonl(lines) {
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

suite("acceptance/transcript claude", ({ test, eq, ok }) => {
  test("a plain user text turn normalises to a text event", () => {
    const text = jsonl([{ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } }]);
    const events = normalizeClaudeTranscript(text);
    eq(events.length, 1);
    eq(events[0].kind, "text");
    eq(events[0].role, "user");
    eq(events[0].text, "hello");
  });

  test("a plain string message content also normalises to a text event", () => {
    const text = jsonl([{ type: "user", message: { role: "user", content: "hello" } }]);
    const events = normalizeClaudeTranscript(text);
    eq(events.length, 1);
    eq(events[0].kind, "text");
    eq(events[0].text, "hello");
  });

  test("a tool_use content item normalises to a tool_call event, filePath picked from file_path", () => {
    const text = jsonl([
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "C:\\repo\\a.ts", content: "x" } }] } },
    ]);
    const events = normalizeClaudeTranscript(text);
    eq(events.length, 1);
    eq(events[0].kind, "tool_call");
    eq(events[0].toolName, "Write");
    eq(events[0].filePath, "C:\\repo\\a.ts");
    eq(events[0].input.content, "x");
  });

  test("a thinking content item is dropped — it carries nothing an assertion reads", () => {
    const text = jsonl([{ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } }]);
    eq(normalizeClaudeTranscript(text).length, 0);
  });

  test("a tool_result content item normalises to a tool_result event", () => {
    const text = jsonl([{ type: "user", message: { role: "user", content: [{ tool_use_id: "t1", type: "tool_result", content: "ok" }] } }]);
    const events = normalizeClaudeTranscript(text);
    eq(events.length, 1);
    eq(events[0].kind, "tool_result");
    eq(events[0].toolUseId, "t1");
    eq(events[0].text, "ok");
    eq(events[0].isError, false);
  });

  test("an error tool_result carries isError true", () => {
    const text = jsonl([{ type: "user", message: { role: "user", content: [{ tool_use_id: "t1", type: "tool_result", content: "boom", is_error: true }] } }]);
    eq(normalizeClaudeTranscript(text)[0].isError, true);
  });

  test("a PreToolUse hook_success attachment with a deny decision normalises to a hook_decision event naming the rule", () => {
    const stdout = `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "some reason\n\nRule: no-push-to-base" },
    })}\n`;
    const text = jsonl([{ type: "attachment", attachment: { type: "hook_success", hookEvent: "PreToolUse", toolUseID: "t1", stdout } }]);
    const events = normalizeClaudeTranscript(text);
    eq(events.length, 1);
    eq(events[0].kind, "hook_decision");
    eq(events[0].action, "deny");
    eq(events[0].ruleId, "no-push-to-base");
    eq(events[0].toolUseId, "t1");
  });

  test("an ask decision is normalised the same way, with its own action", () => {
    const stdout = `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "check this\n\nRule: commit-message" },
    })}\n`;
    const text = jsonl([{ type: "attachment", attachment: { type: "hook_success", hookEvent: "PreToolUse", toolUseID: "t2", stdout } }]);
    eq(normalizeClaudeTranscript(text)[0].action, "ask");
  });

  test("a PreToolUse hook_success attachment with EMPTY stdout (a pass) produces no event", () => {
    const text = jsonl([{ type: "attachment", attachment: { type: "hook_success", hookEvent: "PreToolUse", toolUseID: "t1", stdout: "" } }]);
    eq(normalizeClaudeTranscript(text).length, 0);
  });

  test("a SessionStart hook attachment (a different hookEvent) produces no event", () => {
    const stdout = `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "x" } })}\n`;
    const text = jsonl([{ type: "attachment", attachment: { type: "hook_success", hookEvent: "SessionStart", stdout } }]);
    eq(normalizeClaudeTranscript(text).length, 0);
  });

  test("line types carrying nothing an assertion reads (mode, permission-mode, system, file-history-snapshot) are ignored", () => {
    const text = jsonl([
      { type: "mode", mode: "default" },
      { type: "permission-mode", permissionMode: "default" },
      { type: "system", subtype: "turn_duration" },
      { type: "file-history-snapshot", messageId: "x" },
    ]);
    eq(normalizeClaudeTranscript(text).length, 0);
  });

  test("a malformed JSON line is skipped rather than throwing", () => {
    const text = ["{not json", jsonl([{ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } }])].join("\n");
    const events = normalizeClaudeTranscript(text);
    eq(events.length, 1);
    eq(events[0].text, "hi");
  });

  test("normalizeTranscript('claude', ...) dispatches to the Claude normaliser", () => {
    const text = jsonl([{ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } }]);
    eq(normalizeTranscript("claude", text).length, 1);
  });

  test("H1: a line's own top-level cwd is attached to every event it produces", () => {
    const text = jsonl([
      { type: "assistant", cwd: "C:\\repo", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "cat src/a.ts" } }] } },
    ]);
    eq(normalizeClaudeTranscript(text)[0].cwd, "C:\\repo");
  });

  test("H1: a line carrying no cwd field normalises to an empty string, never undefined", () => {
    const text = jsonl([{ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } }]);
    eq(normalizeClaudeTranscript(text)[0].cwd, "");
  });
});

suite("acceptance/transcript codex", ({ test, eq, ok }) => {
  test("a message response_item normalises to a text event, joining every input_text part", () => {
    const text = jsonl([{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } }]);
    const events = normalizeCodexTranscript(text);
    eq(events.length, 1);
    eq(events[0].kind, "text");
    eq(events[0].role, "user");
    eq(events[0].text, "hello");
  });

  test("a function_call response_item normalises to a tool_call event with parsed arguments", () => {
    const text = jsonl([{ type: "response_item", payload: { type: "function_call", name: "spawn_agent", call_id: "c1", arguments: JSON.stringify({ model: "gpt-5.6-terra" }) } }]);
    const events = normalizeCodexTranscript(text);
    eq(events.length, 1);
    eq(events[0].kind, "tool_call");
    eq(events[0].toolName, "spawn_agent");
    eq(events[0].input.model, "gpt-5.6-terra");
    eq(events[0].toolUseId, "c1");
  });

  test("a function_call_output response_item normalises to a tool_result event", () => {
    const text = jsonl([{ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "done" } }]);
    const events = normalizeCodexTranscript(text);
    eq(events.length, 1);
    eq(events[0].kind, "tool_result");
    eq(events[0].text, "done");
  });

  test("an exec custom_tool_call wrapping a shell command unwraps to a tool_call event via core/lib/codex-exec.js", () => {
    const script = 'const r = await tools.exec_command({command: "rg -l Widget src"}); text(r.output);';
    const text = jsonl([{ type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c1", input: script } }]);
    const events = normalizeCodexTranscript(text);
    eq(events.length, 1);
    eq(events[0].kind, "tool_call");
    eq(events[0].toolName, "exec_command");
    eq(events[0].input.command, "rg -l Widget src");
  });

  test("an exec custom_tool_call wrapping an Add File patch unwraps to a write-shaped tool_call event", () => {
    const patch = ["*** Begin Patch", "*** Add File: src/components/Widget/Widget.tsx", "+export function Widget() { return null; }", "*** End Patch"].join("\n");
    const script = "const r = await tools.apply_patch({patch: `" + patch + "`}); text(r);";
    const text = jsonl([{ type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c1", input: script } }]);
    const events = normalizeCodexTranscript(text);
    eq(events.length, 1);
    eq(events[0].toolName, "apply_patch");
    eq(events[0].filePath, "src/components/Widget/Widget.tsx");
    ok(events[0].input.content.includes("export function Widget"), "reconstructed content should carry the added line");
  });

  test("an exec custom_tool_call invoking multiple nested tools unwraps to multiple events, in extraction order", () => {
    const script = 'const a = await tools.exec_command({command: "rg foo"}); const b = await tools.spawn_agent({model: "gpt-5.6-luna"});';
    const text = jsonl([{ type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c1", input: script } }]);
    const events = normalizeCodexTranscript(text);
    eq(events.length, 2);
    eq(events[0].toolName, "exec_command");
    eq(events[1].toolName, "spawn_agent");
    eq(events[1].input.model, "gpt-5.6-luna");
  });

  test("a custom_tool_call_output whose text names a real denial normalises to a hook_decision event naming the rule", () => {
    const output = [{ type: "input_text", text: "Script failed\n" }, { type: "input_text", text: "Script error:\nCommand blocked by PreToolUse hook: NO PUSH TO BASE.\n\nRule: no-push-to-base" }];
    const text = jsonl([{ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c1", output } }]);
    const events = normalizeCodexTranscript(text);
    eq(events.length, 1);
    eq(events[0].kind, "hook_decision");
    eq(events[0].action, "deny");
    eq(events[0].ruleId, "no-push-to-base");
  });

  test("a custom_tool_call_output with no denial wrapper normalises to an ordinary tool_result event", () => {
    const output = [{ type: "input_text", text: "Script completed\n" }, { type: "input_text", text: "applied" }];
    const text = jsonl([{ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c1", output } }]);
    const events = normalizeCodexTranscript(text);
    eq(events.length, 1);
    eq(events[0].kind, "tool_result");
  });

  test("reasoning and other response_item payload types carry nothing an assertion reads", () => {
    const text = jsonl([{ type: "response_item", payload: { type: "reasoning", summary: [] } }]);
    eq(normalizeCodexTranscript(text).length, 0);
  });

  test("session-level line types that carry no cwd/subagent state (event_msg, world_state) produce no event of their own; session_meta/turn_context produce none either but are still read for state (H1/H2, below)", () => {
    const text = jsonl([
      { type: "session_meta", payload: {} },
      { type: "event_msg", payload: { type: "token_count" } },
      { type: "world_state", payload: {} },
      { type: "turn_context", payload: {} },
    ]);
    eq(normalizeCodexTranscript(text).length, 0);
  });

  test("normalizeTranscript('codex', ...) dispatches to the Codex normaliser", () => {
    const text = jsonl([{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } }]);
    eq(normalizeTranscript("codex", text).length, 1);
  });

  /* ===================================================================== */
  /* H1 — session_meta/turn_context cwd is tracked and attached to events. */
  /* ===================================================================== */

  test("H1: session_meta's own cwd is attached to every later event", () => {
    const text = jsonl([
      { type: "session_meta", payload: { cwd: "C:\\repo" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } },
    ]);
    eq(normalizeCodexTranscript(text)[0].cwd, "C:\\repo");
  });

  test("H1: a later turn_context's own cwd overrides session_meta's for every event after it", () => {
    const text = jsonl([
      { type: "session_meta", payload: { cwd: "C:\\repo" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "before" }] } },
      { type: "turn_context", payload: { cwd: "C:\\repo\\nested" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "after" }] } },
    ]);
    const events = normalizeCodexTranscript(text);
    eq(events[0].cwd, "C:\\repo");
    eq(events[1].cwd, "C:\\repo\\nested");
  });

  test("H1: with no session_meta/turn_context at all (an older recorded fixture), cwd normalises to an empty string", () => {
    const text = jsonl([{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } }]);
    eq(normalizeCodexTranscript(text)[0].cwd, "");
  });

  /* ===================================================================== */
  /* H2 — a subagent's own rollout is a per-ROLLOUT signal, from session_meta. */
  /* ===================================================================== */

  test("H2: isCodexSubagentRollout recognises the thread_spawn shape a directly nested spawn produces (verified against a real captured rollout)", () => {
    eq(isCodexSubagentRollout({ thread_source: "subagent", source: { subagent: { thread_spawn: { parent_thread_id: "p1", depth: 1 } } } }), true);
  });

  test("H2: isCodexSubagentRollout recognises the looser {other: ...} shape another spawn route produces (verified against a real captured rollout)", () => {
    eq(isCodexSubagentRollout({ thread_source: "subagent", source: { subagent: { other: "guardian" } } }), true);
  });

  test("H2: isCodexSubagentRollout falls back to a bare source.subagent object even without thread_source set", () => {
    eq(isCodexSubagentRollout({ source: { subagent: { other: "x" } } }), true);
  });

  test("H2: isCodexSubagentRollout is false for a genuine top-level session", () => {
    eq(isCodexSubagentRollout({ thread_source: "user", source: "cli" }), false);
    eq(isCodexSubagentRollout({}), false);
    eq(isCodexSubagentRollout(null), false);
  });

  test("H2: every event kind in a rollout session_meta marks as a subagent's own is stamped isSidechain true — text AND tool_call alike", () => {
    const patch = ["*** Begin Patch", "*** Add File: src/a.ts", "+export const a = 1;", "*** End Patch"].join("\n");
    const text = jsonl([
      { type: "session_meta", payload: { thread_source: "subagent", source: { subagent: { thread_spawn: { parent_thread_id: "p1" } } } } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "go ahead" }] } },
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c1", input: "const r = await tools.apply_patch({patch: `" + patch + "`}); text(r);" } },
    ]);
    const events = normalizeCodexTranscript(text);
    eq(events.length, 2);
    ok(events.every((ev) => ev.isSidechain === true), JSON.stringify(events.map((ev) => ev.isSidechain)));
  });

  test("H2: a genuine top-level rollout's events are stamped isSidechain false, never undefined", () => {
    const text = jsonl([
      { type: "session_meta", payload: { thread_source: "user", source: "cli" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } },
    ]);
    eq(normalizeCodexTranscript(text)[0].isSidechain, false);
  });

  test("H2: with no session_meta at all (an older recorded fixture), isSidechain still normalises to false, never undefined", () => {
    const text = jsonl([{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } }]);
    eq(normalizeCodexTranscript(text)[0].isSidechain, false);
  });
});
