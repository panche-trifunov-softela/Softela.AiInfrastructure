"use strict";

/**
 * Denies a subagent spawn whose reasoning effort is set below `medium`.
 *
 * Cheap work still has to come out correct, and the tokens saved by a low
 * effort setting are rarely worth what a second attempt costs. The ladder is
 * recognised in full so an unfamiliar value is never guessed at: an
 * unrecognised effort passes rather than being treated as a violation.
 *
 * Detection follows the same three routes as `subagent-model` — a direct
 * spawn tool, every `agent()` call inside a `Workflow` script, and any other
 * tool that reads as a spawn mechanism and carries an effort key (in any
 * spelling) or a `model` key — so effort cannot be dodged by a route this
 * rule was never told about. Claude Code spells the field `effort`; Codex
 * spells it `reasoning_effort` or `model_reasoning_effort` (see
 * `core/lib/codex-exec.js`'s nested-spawn extraction and
 * `core/lib/context.js`'s session-effort reader, which already tolerate the
 * same spellings) — every one of them is read here too, alongside their
 * camelCase forms, so a Codex-side spawn is judged the same as a Claude
 * Code one. A workflow script's `effort:`/`reasoning_effort:`/
 * `model_reasoning_effort:` values are read with the key anchored to `{` or
 * `,`, the same guard `subagent-model` and `guard-delegation.js` use, which
 * is what keeps a prompt string that merely *discusses* effort levels from
 * being mistaken for a real setting.
 */

const { deny, pass } = require("../lib/decision");

/**
 * Tools that are unambiguously a subagent spawn by name alone. Kept
 * deliberately identical to `subagent-model`'s own list, including Codex's
 * `collaboration.spawn_agent` in both the dotted spelling and the
 * punctuation-stripped one a live `PreToolUse` payload actually carries — a
 * spawn route one of the two rules knows about and the other does not is a
 * gap by construction.
 */
const DIRECT_SPAWN_TOOLS = /^(agent|task|spawn_agent|collaboration[._]?spawn_agent)$/i;

/** The workflow-script tool; its `agent()` calls are parsed out of the text. */
const WORKFLOW_TOOL = /^workflow$/i;

/** A tool name that reads as a spawn mechanism this rule has not been told about. */
const SPAWN_LIKE_TOOL = /agent|subagent|spawn|delegate/i;

/**
 * The recognised effort ladder, low to high. A value absent from this map is
 * treated as unrecognised, never as a violation.
 */
const LADDER = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5, ultra: 6 };

/** The lowest step a spawn's effort may sit at without asking for trouble. */
const FLOOR = LADDER.medium;

/**
 * Matches an `effort:`, `reasoning_effort:` or `model_reasoning_effort:` key
 * inside an object literal — anchored to `{` or `,` so a key mentioned in
 * ordinary prose does not count — and captures the quoted value that
 * follows. The anchor is what stops a prompt string that merely discusses
 * effort levels from being mistaken for a real setting, so it is kept
 * exactly as-is; only the key-name alternation grows to cover Codex's
 * spellings alongside Claude Code's own `effort`.
 */
const EFFORT_ASSIGNMENT = /[{,]\s*(?:model_reasoning_effort|reasoning_effort|effort)\s*:\s*["'`]\s*([A-Za-z]+)/gi;

/**
 * Every key a spawn tool's input may carry its reasoning-effort value
 * under: Claude Code's own `effort`, and every spelling Codex actually
 * sends — `reasoning_effort` and `model_reasoning_effort`
 * (`core/lib/codex-exec.js`'s nested-spawn extraction and
 * `core/lib/context.js`'s session-effort reader already tolerate the same
 * set) — plus their camelCase forms, for a host that sends the field that
 * way instead.
 */
const EFFORT_KEYS = Object.freeze([
  "effort",
  "reasoning_effort",
  "model_reasoning_effort",
  "reasoningEffort",
  "modelReasoningEffort",
]);

/**
 * Resolves a spawn's requested reasoning effort from whichever spelling the
 * host actually sent, so a Codex spawn is judged the same as a Claude Code
 * one regardless of which of {@link EFFORT_KEYS} it used.
 *
 * @param {object} input The tool input.
 * @returns {string} The first non-empty string value found among
 * {@link EFFORT_KEYS}, trimmed and lower-cased; `""` when none of the keys
 * carried a non-empty string.
 */
function resolveSpawnEffort(input) {
  for (const key of EFFORT_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }
  return "";
}

/**
 * Decides on a single resolved effort value.
 *
 * @param {string} effort The trimmed, lower-cased effort value.
 * @param {string} where A short description of where it was found, for the
 * denial reason.
 * @returns {null | {action: "deny", reason: string, fix: string}} `deny`
 * when the value is on the ladder and below {@link FLOOR}; `pass` for an
 * unrecognised value or one at or above the floor.
 */
function decideEffort(effort, where) {
  const step = LADDER[effort];
  if (step === undefined) return pass();
  if (step >= FLOOR) return pass();
  return deny(
    `REASONING EFFORT FLOOR: ${where} sets effort "${effort}", below the "medium" floor. Cheap work still has to come out correct, and a second attempt costs more than the effort saved.`,
    'Set effort to "medium" or higher.',
  );
}

/**
 * Reads a workflow tool call's script text, inline or from a path.
 *
 * @param {object} ctx The evaluation context.
 * @param {object} input The tool input.
 * @returns {string} The script text, or `""` when none could be found or
 * read.
 */
function readWorkflowScript(ctx, input) {
  if (typeof input.script === "string" && input.script) return input.script;
  const scriptPath = typeof input.scriptPath === "string" ? input.scriptPath : "";
  if (scriptPath) {
    const content = ctx.readFile(scriptPath);
    if (typeof content === "string") return content;
  }
  return "";
}

module.exports = {
  id: "reasoning-effort-floor",
  title: "A subagent spawn may not set reasoning effort below medium",
  events: ["PreToolUse"],
  tools: null,
  defaultAction: "deny",
  group: "agent",
  requiresConfig: [],
  requiresModule: "agent-orchestration",

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: "deny", reason: string, fix: string}} `deny`
   * when a spawn's effort resolves below the floor; `pass` otherwise,
   * including when no effort was set, the value is unrecognised, or the
   * call is not a spawn at all.
   */
  evaluate(ctx) {
    const toolName = String(ctx.toolName || "");
    const input = ctx.input && typeof ctx.input === "object" ? ctx.input : {};

    if (WORKFLOW_TOOL.test(toolName)) {
      const script = readWorkflowScript(ctx, input);
      if (!script) return pass();
      // The effort value lives inside the quotes the KEY anchor consumes, so
      // matching runs on the raw script rather than the stripped copy —
      // stripping would blank the very value being read.
      const efforts = Array.from(script.matchAll(EFFORT_ASSIGNMENT)).map((m) => m[1].toLowerCase());
      for (const effort of efforts) {
        const decision = decideEffort(effort, "the workflow's agent() call");
        if (decision) return decision;
      }
      return pass();
    }

    const isKnownSpawn = DIRECT_SPAWN_TOOLS.test(toolName);
    const isUnknownSpawnLike =
      !isKnownSpawn &&
      SPAWN_LIKE_TOOL.test(toolName) &&
      (EFFORT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(input, key)) ||
        Object.prototype.hasOwnProperty.call(input, "model"));

    if (!isKnownSpawn && !isUnknownSpawnLike) return pass();

    const effort = resolveSpawnEffort(input);
    if (!effort) return pass();

    return decideEffort(effort, "the spawn");
  },
};
