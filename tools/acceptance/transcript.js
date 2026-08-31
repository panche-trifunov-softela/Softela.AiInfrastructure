"use strict";

/**
 * Normalises a real Claude Code transcript
 * (`~/.claude/projects/<project>/<session>.jsonl`) or a real Codex rollout
 * (`~/.codex/sessions/2026/08/<day>/rollout-<id>.jsonl`) into one ordered
 * event shape, so `tools/acceptance/score.js` never has to know which host
 * produced a transcript.
 *
 * Formats were read from real files on this machine (never copied into this
 * repository — see this project's own file-ownership rules) before writing
 * this module:
 *
 * - Claude Code: one JSON object per line. An assistant turn is
 *   `{type:"assistant", message:{role, content:[{type:"text"|"thinking"|"tool_use", ...}]}}`;
 *   a tool result comes back as `{type:"user", message:{content:[{type:"tool_result", tool_use_id, content}]}}`;
 *   a `PreToolUse` hook decision arrives as
 *   `{type:"attachment", attachment:{type:"hook_success", hookEvent:"PreToolUse", toolUseID, stdout}}`,
 *   whose `stdout` is itself the dispatcher's own JSON wire format
 *   (`{hookSpecificOutput:{permissionDecision, permissionDecisionReason}}`,
 *   `adapters/claude/dispatch.js#writeDecision`) — empty when the call passed.
 *   Every line also carries a top-level `cwd` field (verified against a real
 *   transcript, never copied into this repository) naming the session's own
 *   working directory at that point — attached to every event a line
 *   produces, so a target a shell command spells relative can be resolved
 *   against the same directory the real agent process was actually in.
 * - Codex: also one JSON object per line, `{type:"response_item", payload:{...}}`
 *   among others. A real tool call is `payload.type === "function_call"`
 *   (`spawn_agent`, `wait_agent`, …) with its result in the matching
 *   `"function_call_output"`. Every shell/write/patch action observed in real
 *   transcripts instead arrives wrapped inside a single
 *   `payload.type === "custom_tool_call"` named `"exec"`, whose `input` is a
 *   JavaScript source invoking `tools.<name>(...)` — exactly the shape
 *   `core/lib/codex-exec.js#extractOperations` (this repository's own real
 *   dispatcher unwrapping) already exists to parse, reused here rather than
 *   re-implemented, so the normaliser recognises exactly what the dispatcher
 *   recognises. A denial surfaces inside the matching `"custom_tool_call_output"`
 *   as `Script error:\nCommand blocked by PreToolUse hook: <reason>` (verified
 *   against a real captured denial), where `<reason>` is the same
 *   `composeDenyReason`/`composeAskAsDenyReason` text Claude Code shows,
 *   ending in `Rule: <ruleId>`.
 *
 *   A rollout's own `"session_meta"` line (always the first substantive
 *   line) carries `payload.cwd` — the working directory to resolve a
 *   relative target against, tracked here and updated on every later
 *   `"turn_context"` line's own `payload.cwd` (a session can change working
 *   directory across turns). The SAME `session_meta` line also carries the
 *   whole rollout's subagent identity: a real subagent's own rollout file
 *   (verified directly against real captured rollouts, never copied into
 *   this repository) carries `payload.thread_source === "subagent"`,
 *   alongside `payload.source.subagent` — either a
 *   `{thread_spawn:{parent_thread_id, depth, agent_path, agent_nickname, agent_role}}`
 *   shape for a directly nested spawn, or a looser `{other: "<label>"}` shape
 *   for another spawn route. Unlike Claude Code's inline, per-event
 *   `isSidechain`, Codex has no per-event equivalent at all — a subagent gets
 *   its own, separate rollout file, so the signal is per-ROLLOUT: every event
 *   in a rollout whose `session_meta` carries either field is marked
 *   `isSidechain: true`, since nothing in such a rollout is ever the
 *   developer speaking.
 */

const { extractOperations } = require("../../core/lib/codex-exec");

/** Extracts a rule id from a composed reason ending in `Rule: <ruleId>` (`adapters/claude/dispatch.js#composeReason`, `adapters/codex/dispatch.js#composeDenyReason`/`composeAskAsDenyReason`). */
const RULE_ID_RE = /Rule:\s*([A-Za-z0-9][\w.-]*)/;

/** Matches the Codex denial wrapper a real `custom_tool_call_output` carries around a composed reason. */
const CODEX_BLOCKED_RE = /Command blocked by PreToolUse hook:\s*([\s\S]*)/;

/**
 * Extracts the first rule id named inside a composed reason string.
 *
 * @param {string} reason The reason text, normally ending in `Rule: <id>`.
 * @returns {string | null} The rule id, or `null` when none is found.
 */
function extractRuleId(reason) {
  const m = RULE_ID_RE.exec(String(reason || ""));
  return m ? m[1] : null;
}

/**
 * Parses a JSON string, never throwing.
 *
 * @param {string} text The text to parse.
 * @returns {*} The parsed value, or `null` on any failure or non-string
 * input.
 */
function safeJsonParse(text) {
  if (typeof text !== "string" || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Splits raw transcript text into non-empty lines.
 *
 * @param {string} text The full file content.
 * @returns {string[]} Non-empty lines, trailing newline dropped.
 */
function splitLines(text) {
  return String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Picks the best available file-path-shaped field off a tool input, the same
 * tolerant reading `core/lib/context.js#buildContext` applies to a real host
 * payload.
 *
 * @param {object} input The tool input.
 * @returns {string} The resolved path, or `""` when none of the recognised
 * keys carry one.
 */
function pickFilePath(input) {
  const inp = input && typeof input === "object" ? input : {};
  return inp.file_path || inp.filePath || inp.path || inp.target_file || "";
}

/* ============================================================== Claude Code */

/**
 * Normalises one Claude Code assistant/user turn's `message.content` array
 * into events.
 *
 * @param {object} o One parsed transcript line.
 * @returns {object[]} Zero or more normalised events.
 */
function claudeMessageEvents(o) {
  const message = o.message && typeof o.message === "object" ? o.message : {};
  const role = message.role || (o.type === "user" ? "user" : "assistant");
  const content = message.content;
  // A subagent's own internal turns are logged with `isSidechain: true`,
  // interleaved into the SAME transcript file as the orchestrator's own —
  // this project's own `modules/memory-as-context/hooks/transcript.js#readClaudeTurn`
  // already treats that flag as the line between a genuine top-level turn
  // and a subagent's internal one. Carried onto every event this line
  // produces, so a scoring assertion (`score.js#gateRespected`) can apply
  // the same distinction without re-deriving it.
  const isSidechain = o.isSidechain === true;
  // The session's own working directory at this line — see this module's
  // own doc comment. Attached to every event so a relative target (a shell
  // command's own write target, most notably) can be resolved against the
  // same directory the real agent process was actually in.
  const cwd = typeof o.cwd === "string" ? o.cwd : "";

  if (typeof content === "string") {
    return content ? [{ kind: "text", role, text: content, isSidechain, cwd, raw: o }] : [];
  }
  if (!Array.isArray(content)) return [];

  const events = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text" && typeof item.text === "string") {
      events.push({ kind: "text", role, text: item.text, isSidechain, cwd, raw: o });
    } else if (item.type === "tool_use") {
      const input = item.input && typeof item.input === "object" ? item.input : {};
      events.push({ kind: "tool_call", toolName: item.name || "", input, filePath: pickFilePath(input), toolUseId: item.id || null, isSidechain, cwd, raw: o });
    } else if (item.type === "tool_result") {
      const text = typeof item.content === "string" ? item.content : Array.isArray(item.content) ? JSON.stringify(item.content) : "";
      events.push({ kind: "tool_result", toolUseId: item.tool_use_id || null, text, isError: !!item.is_error, isSidechain, cwd, raw: o });
    }
    // "thinking" and anything else carries no event a scoring assertion reads.
  }
  return events;
}

/**
 * Normalises one Claude Code `PreToolUse` hook attachment into a
 * `hook_decision` event.
 *
 * @param {object} o One parsed transcript line, already known to be a
 * `type: "attachment"` line.
 * @returns {object | null} The event, or `null` when this attachment carries
 * no decision (a pass, or a hook event other than `PreToolUse`).
 */
function claudeHookDecisionEvent(o) {
  const att = o.attachment && typeof o.attachment === "object" ? o.attachment : {};
  if (att.type !== "hook_success" || att.hookEvent !== "PreToolUse") return null;
  const parsed = safeJsonParse(att.stdout);
  const output = parsed && parsed.hookSpecificOutput;
  if (!output || !output.permissionDecision) return null;
  return {
    kind: "hook_decision",
    action: output.permissionDecision,
    ruleId: extractRuleId(output.permissionDecisionReason),
    reason: output.permissionDecisionReason || "",
    toolUseId: att.toolUseID || null,
    raw: o,
  };
}

/**
 * Normalises a Claude Code transcript.
 *
 * @param {string} text The raw `.jsonl` file content.
 * @returns {object[]} The ordered normalised events.
 */
function normalizeClaudeTranscript(text) {
  const events = [];
  for (const line of splitLines(text)) {
    const o = safeJsonParse(line);
    if (!o || typeof o !== "object") continue;

    if (o.type === "assistant" || o.type === "user") {
      events.push(...claudeMessageEvents(o));
    } else if (o.type === "attachment") {
      const decision = claudeHookDecisionEvent(o);
      if (decision) events.push(decision);
    }
    // Every other line type ("mode", "permission-mode", "system",
    // "file-history-snapshot", "last-prompt", …) carries nothing an
    // assertion reads.
  }
  return events;
}

/* ===================================================================== Codex */

/**
 * Checks whether a Codex rollout's own `session_meta` payload marks the
 * WHOLE rollout as a subagent's own transcript — see this module's own doc
 * comment for the exact shape, verified against real captured rollouts.
 * `thread_source` alone already covers every observed shape (both the
 * `thread_spawn`-carrying spawn route and the looser `{other: "<label>"}`
 * one), so it is checked first; `payload.source.subagent` is kept as a
 * fallback for a build that carries the nested object without the flag.
 *
 * @param {object} sessionMetaPayload A `"session_meta"` line's own `payload`.
 * @returns {boolean} `true` when the rollout this payload opens is entirely
 * a subagent's own transcript.
 */
function isCodexSubagentRollout(sessionMetaPayload) {
  const p = sessionMetaPayload && typeof sessionMetaPayload === "object" ? sessionMetaPayload : {};
  if (p.thread_source === "subagent") return true;
  return !!(p.source && typeof p.source === "object" && p.source.subagent);
}

/**
 * Normalises one extracted `core/lib/codex-exec.js#extractOperations`
 * operation into a `tool_call` event, in the same input shape
 * `adapters/shared/dispatch-core.js#buildOperationContext` builds for it —
 * so replaying it later through the real dispatcher (`score.js`'s
 * `standards-obeyed`) sees exactly what the production path would.
 *
 * @param {object} op One operation, as returned by `extractOperations`.
 * @param {object} raw The outer `custom_tool_call` transcript line, kept as
 * evidence.
 * @param {string} cwd The enclosing turn's own working directory (this
 * module's own tracked `session_meta`/`turn_context` `cwd`) — a shell
 * operation's own `op.cwd` (its `workdir`, when Codex reported one) is
 * always more specific and takes priority over this at match time
 * (`score.js#callCwd`), but this is still attached so a call with no
 * `op.cwd` of its own has something to resolve a relative target against.
 * @returns {object} The normalised event.
 */
function codexOperationEvent(op, raw, cwd) {
  if (op.kind === "write") {
    const input = { file_path: op.filePath, content: op.content };
    return { kind: "tool_call", toolName: op.toolName, input, filePath: op.filePath, cwd, raw };
  }
  if (op.kind === "shell") {
    const input = { command: op.command };
    if (op.cwd) input.workdir = op.cwd;
    return { kind: "tool_call", toolName: op.toolName, input, filePath: "", cwd, raw };
  }
  if (op.kind === "spawn") {
    return { kind: "tool_call", toolName: op.toolName, input: op.input || {}, filePath: "", cwd, raw };
  }
  return { kind: "tool_call", toolName: op.toolName, input: { category: op.category }, filePath: "", uninspectable: true, cwd, raw };
}

/**
 * Normalises one Codex `response_item` line into events.
 *
 * @param {object} o One parsed transcript line, `o.type === "response_item"`.
 * @param {string} cwd The enclosing turn's own working directory, tracked by
 * {@link normalizeCodexTranscript} across the rollout's `session_meta`/
 * `turn_context` lines.
 * @returns {object[]} Zero or more normalised events.
 */
function codexResponseItemEvents(o, cwd) {
  const payload = o.payload && typeof o.payload === "object" ? o.payload : {};

  if (payload.type === "message") {
    const role = payload.role || "user";
    const content = Array.isArray(payload.content) ? payload.content : [];
    const text = content
      .filter((c) => c && typeof c === "object" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
    return text ? [{ kind: "text", role, text, cwd, raw: o }] : [];
  }

  if (payload.type === "function_call") {
    const input = safeJsonParse(payload.arguments) || {};
    return [{ kind: "tool_call", toolName: payload.name || "", input, filePath: pickFilePath(input), toolUseId: payload.call_id || null, cwd, raw: o }];
  }

  if (payload.type === "function_call_output") {
    const text = typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output || "");
    return [{ kind: "tool_result", toolUseId: payload.call_id || null, text, isError: false, cwd, raw: o }];
  }

  if (payload.type === "custom_tool_call" && String(payload.name || "").toLowerCase() === "exec") {
    const ops = extractOperations(payload.input, () => null, () => false);
    return ops.map((op) => codexOperationEvent(op, o, cwd));
  }

  if (payload.type === "custom_tool_call_output") {
    const parts = Array.isArray(payload.output) ? payload.output : [];
    const text = parts
      .filter((p) => p && typeof p === "object" && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    const blocked = CODEX_BLOCKED_RE.exec(text);
    if (blocked) {
      const reason = blocked[1];
      return [{ kind: "hook_decision", action: "deny", ruleId: extractRuleId(reason), reason, toolUseId: payload.call_id || null, cwd, raw: o }];
    }
    return [{ kind: "tool_result", toolUseId: payload.call_id || null, text, isError: /Script error/.test(text), cwd, raw: o }];
  }

  // "reasoning" and any other response_item payload type carries nothing an
  // assertion reads.
  return [];
}

/**
 * Normalises a Codex rollout.
 *
 * Tracks two pieces of running state across the rollout's own lines, in
 * order, rather than reading either fresh per line: the working directory
 * (from `"session_meta"`, updated by every later `"turn_context"`), and
 * whether the WHOLE rollout is a subagent's own transcript (decided once,
 * from `"session_meta"` alone — Codex gives a subagent its own separate
 * rollout file, so this can never change partway through one; see this
 * module's own doc comment). Every event a `"response_item"` line produces
 * is stamped with both.
 *
 * @param {string} text The raw `.jsonl` file content.
 * @returns {object[]} The ordered normalised events.
 */
function normalizeCodexTranscript(text) {
  const events = [];
  let cwd = "";
  let isSidechain = false;
  for (const line of splitLines(text)) {
    const o = safeJsonParse(line);
    if (!o || typeof o !== "object") continue;

    if (o.type === "session_meta") {
      const meta = o.payload && typeof o.payload === "object" ? o.payload : {};
      if (typeof meta.cwd === "string" && meta.cwd) cwd = meta.cwd;
      isSidechain = isSidechain || isCodexSubagentRollout(meta);
      continue;
    }
    if (o.type === "turn_context") {
      const tc = o.payload && typeof o.payload === "object" ? o.payload : {};
      if (typeof tc.cwd === "string" && tc.cwd) cwd = tc.cwd;
      continue;
    }
    if (o.type === "response_item") {
      for (const ev of codexResponseItemEvents(o, cwd)) {
        ev.isSidechain = isSidechain;
        events.push(ev);
      }
    }
    // "event_msg", "world_state", "compacted",
    // "inter_agent_communication_metadata" carry nothing an assertion reads.
  }
  return events;
}

/* ==================================================================== shared */

/**
 * Normalises a transcript for either host into one ordered event list.
 *
 * Every event carries at least `kind` (`"text"` | `"tool_call"` |
 * `"tool_result"` | `"hook_decision"`); a `tool_call`/`tool_result` also
 * carries `toolName`/`input` or `text`; a `hook_decision` carries `action`
 * and `ruleId`. Every event also carries `isSidechain` (`true` when it is a
 * subagent's own turn, never the developer speaking) and `cwd` (the working
 * directory a relative target inside it should be resolved against) — the
 * two hosts decide `isSidechain` from different evidence (Claude Code: the
 * line's own inline `isSidechain` flag, per event; Codex: the enclosing
 * rollout's own `session_meta`, per WHOLE rollout — see
 * {@link normalizeCodexTranscript}'s own doc comment), but every event on
 * both hosts carries the field, so a scoring assertion reads one flag
 * regardless of which host produced the transcript. Every event keeps its
 * own source line(s) under `raw`, so a scoring assertion's evidence can
 * point back at the exact transcript content that decided it.
 *
 * @param {"claude" | "codex"} agent Which host produced `text`.
 * @param {string} text The raw `.jsonl` transcript content.
 * @returns {object[]} The ordered normalised events.
 */
function normalizeTranscript(agent, text) {
  return agent === "codex" ? normalizeCodexTranscript(text) : normalizeClaudeTranscript(text);
}

module.exports = {
  normalizeTranscript,
  normalizeClaudeTranscript,
  normalizeCodexTranscript,
  isCodexSubagentRollout,
  extractRuleId,
};
