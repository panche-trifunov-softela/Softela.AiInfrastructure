"use strict";

/**
 * Recognises a tool call that spawns a subagent, across every route this
 * project knows about.
 *
 * More than one rule needs to answer the same underlying question — "is this
 * tool call a subagent spawn" — from a different angle: `subagent-model`
 * judges the model tier the spawn requests, `no-nested-delegation` judges
 * whether the caller itself is already a delegated agent. Keeping the
 * detection here means a future spawn mechanism only has to be taught to
 * recognise it once, in one place, instead of drifting between rules that
 * each grew their own copy.
 */

/**
 * Tools that are unambiguously a subagent spawn by name alone.
 *
 * `collaboration.spawn_agent` is Codex's own, and the separator is optional
 * because the name reaches a hook with its namespace punctuation stripped:
 * measured on Codex 0.149.1, a live `PreToolUse` payload carries
 * `tool_name: "collaborationspawn_agent"` for the tool the model sees as
 * `collaboration.spawn_agent`. Both spellings are matched rather than only
 * the observed one, so a future build that stops stripping the dot does not
 * silently take detection out of service on that host.
 */
const DIRECT_SPAWN_TOOLS = /^(agent|task|spawn_agent|collaboration[._]?spawn_agent)$/i;

/**
 * The workflow-script tool. It is a spawn mechanism of its own: every
 * `agent()` call inside its script text spawns a subagent, even though the
 * tool call itself carries no single `model` field the way a direct spawn
 * does.
 */
const WORKFLOW_TOOL = /^workflow$/i;

/** A tool name that reads as a spawn mechanism this project has not been told about by name. */
const SPAWN_LIKE_TOOL = /agent|subagent|spawn|delegate/i;

/**
 * Checks whether a tool name is one of the direct, by-name-recognised spawn
 * tools.
 *
 * @param {string} toolName The host's own tool name.
 * @returns {boolean} `true` when the name matches {@link DIRECT_SPAWN_TOOLS}.
 */
function isDirectSpawnTool(toolName) {
  return DIRECT_SPAWN_TOOLS.test(String(toolName || ""));
}

/**
 * Checks whether a tool name is the workflow-script tool.
 *
 * @param {string} toolName The host's own tool name.
 * @returns {boolean} `true` when the name matches {@link WORKFLOW_TOOL}.
 */
function isWorkflowTool(toolName) {
  return WORKFLOW_TOOL.test(String(toolName || ""));
}

/**
 * Checks whether a tool name reads as an unrecognised spawn mechanism — a
 * name matching {@link SPAWN_LIKE_TOOL} whose input actually carries a
 * `model` key, the one piece of evidence available that the call really is a
 * spawn rather than an unrelated tool that merely happens to have "agent" in
 * its name.
 *
 * @param {string} toolName The host's own tool name.
 * @param {object} input The tool input.
 * @returns {boolean} `true` when the name is spawn-like, is not already a
 * {@link isDirectSpawnTool} match, and the input carries a `model` key.
 */
function isUnknownSpawnLikeTool(toolName, input) {
  const name = String(toolName || "");
  if (isDirectSpawnTool(name)) return false;
  if (!SPAWN_LIKE_TOOL.test(name)) return false;
  const obj = input && typeof input === "object" ? input : {};
  return Object.prototype.hasOwnProperty.call(obj, "model");
}

/**
 * Checks whether a tool call is a subagent spawn by any route this project
 * recognises: a direct spawn tool, the workflow-script tool, or an unknown
 * spawn-like tool whose input carries a `model` key.
 *
 * @param {string} toolName The host's own tool name.
 * @param {object} [input] The tool input; only consulted for the unknown
 * spawn-like case.
 * @returns {boolean} `true` when the call is a subagent spawn.
 */
function isSpawnTool(toolName, input) {
  return isDirectSpawnTool(toolName) || isWorkflowTool(toolName) || isUnknownSpawnLikeTool(toolName, input);
}

module.exports = {
  DIRECT_SPAWN_TOOLS,
  WORKFLOW_TOOL,
  SPAWN_LIKE_TOOL,
  isDirectSpawnTool,
  isWorkflowTool,
  isUnknownSpawnLikeTool,
  isSpawnTool,
};
