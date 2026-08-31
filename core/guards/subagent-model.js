"use strict";

/**
 * Blocks a subagent spawn from silently escalating past the session's own
 * model.
 *
 * The comparison is relative to the session, never an allowlist: a spawn at
 * the same tier or cheaper passes; a more expensive tier asks; a frontier
 * tier always asks, even from a frontier session, because one strong session
 * is a deliberate choice and a fan-out of them is not; and no model at all
 * is denied outright, because that is exactly how a spawn silently inherits
 * the session's own model.
 *
 * Three routes reach the same spawn:
 * - a direct spawn tool (`Agent`, `Task`, `spawn_agent`, …);
 * - every `agent()` call inside a `Workflow` script, parsed out of the
 *   script text with string literals and comments stripped first, so a
 *   prompt string that merely *discusses* a model choice is never judged;
 * - any other tool whose name matches `/agent|subagent|spawn|delegate/i` and
 *   whose input carries a `model` key, so a future spawn mechanism is not
 *   silently ignored.
 */

const { deny, ask, pass } = require("../lib/decision");
const { tierOf, TIERS } = require("../lib/model-tiers");
const { FALLBACK_MODEL_IDS } = require("../lib/codex-models");
const { DIRECT_SPAWN_TOOLS, WORKFLOW_TOOL, SPAWN_LIKE_TOOL } = require("../lib/spawn-tools");

/** Session tier assumed when the session's own model is unrecognised or unset. */
const DEFAULT_SESSION_TIER = TIERS.BALANCED;

/**
 * Finds a direct alias of the bare `agent` spawn function — `const spawn =
 * agent` — without also matching a call, `const a = agent(...)`, which
 * {@link countAgentCalls} already counts as a plain `agent(` invocation.
 * Assigning the spawn function to another name before calling it must not
 * make the call invisible.
 */
const AGENT_ALIAS = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*agent\b(?!\s*\()/g;

/**
 * Matches a `model` key inside an object literal — anchored to `{` or `,` so
 * a key mentioned in ordinary prose, without the surrounding literal, does
 * not count. Captures the quoted string value when the key is set to one;
 * leaves the capture undefined for shorthand (`{model}`) or any other
 * expression (`{model: config.defaultModel}`), which still counts as an
 * explicit assignment but cannot be resolved to a tier statically.
 */
const MODEL_KEY = /[{,]\s*model\b(?:\s*:\s*["'`]\s*([A-Za-z0-9_.-]+))?/gi;

/** A spread can carry `model` in from a shared options constant, out of view. */
const HAS_SPREAD = /\.\.\.[A-Za-z_$]/;

/**
 * Counts non-overlapping matches of a global regex in a string.
 *
 * @param {string} text The text to search.
 * @param {RegExp} globalRe A regex with the `g` flag.
 * @returns {number} How many times it matched.
 */
function countMatches(text, globalRe) {
  const m = text.match(globalRe);
  return m ? m.length : 0;
}

/**
 * Counts every spawn call site in a workflow script — a call to `agent(`
 * itself, or to any local identifier assigned directly from the bare
 * `agent` reference. `const spawn = agent; spawn(...)` reaches the same
 * spawn a literal `agent(` search would miss.
 *
 * @param {string} strippedSrc The script with string literals and comments
 * already blanked.
 * @returns {number} How many spawn call sites the script contains.
 */
function countAgentCalls(strippedSrc) {
  const aliases = new Set();
  let m;
  AGENT_ALIAS.lastIndex = 0;
  while ((m = AGENT_ALIAS.exec(strippedSrc))) aliases.add(m[1]);

  const names = ["agent", ...aliases].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const callRe = new RegExp(`\\b(?:${names.join("|")})\\s*\\(`, "g");
  return countMatches(strippedSrc, callRe);
}

/**
 * Blanks out string literals and comments, keeping every other character in
 * place, so a workflow script's own prompt text can never be mistaken for
 * the code that calls `agent()`.
 *
 * @param {string} src The script source.
 * @returns {string} The source with string and comment contents replaced by
 * a single space each.
 */
function stripStringsAndComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Reads a workflow tool call's script text, inline or from a path.
 *
 * @param {object} ctx The evaluation context.
 * @param {object} input The tool input.
 * @returns {{script: string, unreadable: boolean}} `script` is `""` when
 * none was found; `unreadable` is `true` only when a path was given but
 * `ctx.readFile` could not produce its content.
 */
function readWorkflowScript(ctx, input) {
  if (typeof input.script === "string" && input.script) {
    return { script: input.script, unreadable: false };
  }
  const scriptPath = typeof input.scriptPath === "string" ? input.scriptPath : "";
  if (scriptPath) {
    const content = ctx.readFile(scriptPath);
    if (typeof content === "string") return { script: content, unreadable: false };
    return { script: "", unreadable: true };
  }
  return { script: "", unreadable: false };
}

/**
 * Decides the tier comparison for a single resolved spawn model.
 *
 * @param {object} ctx The evaluation context.
 * @param {string} model The trimmed, non-empty model name a spawn requested.
 * @returns {null | {action: string, reason: string, fix?: string}} The
 * decision for this spawn.
 */
function decideModel(ctx, model) {
  const spawnTier = tierOf(model);

  if (spawnTier === null) {
    return ask(
      `SUBAGENT MODEL: "${model}" is not a recognised model tier, so it cannot be compared against the session's own.`,
      "Confirm the model choice, or spawn with a recognised tier name.",
    );
  }

  if (spawnTier === TIERS.FRONTIER) {
    return ask(
      `SUBAGENT MODEL: "${model}" is a frontier-tier model. A single frontier session is a deliberate choice; a fan-out of frontier subagents is how a routine task quietly becomes an expensive one.`,
      "Approve if the task genuinely warrants it, or spawn at a cheaper tier.",
    );
  }

  const sessionTier = tierOf(ctx.session && ctx.session.model) || DEFAULT_SESSION_TIER;
  if (spawnTier <= sessionTier) return pass();

  return ask(
    `SUBAGENT MODEL: "${model}" is a more expensive tier than the session's own model.`,
    "Spawn at the session's tier or cheaper, or get approval for the stronger one.",
  );
}

/**
 * Evaluates a direct spawn tool call, where the model is a single field on
 * the tool input.
 *
 * @param {object} ctx The evaluation context.
 * @param {*} rawModel The tool input's `model` field, of whatever type the
 * host sent.
 * @returns {null | {action: string, reason: string, fix?: string}} The
 * decision for this spawn.
 */
function evaluateDirectSpawn(ctx, rawModel) {
  const model = typeof rawModel === "string" ? rawModel.trim() : "";
  if (!model) {
    return deny(
      "SUBAGENT MODEL: a subagent spawn with no explicit model inherits the session's own model — the exact escalation " +
        "this rule exists to prevent. Which tier fits is a judgement for this session to make from the task's own size " +
        "and difficulty, not a default to fall back on.",
      missingModelFix(ctx),
    );
  }
  return decideModel(ctx, model);
}

/**
 * Composes the fix for a spawn that named no model, in the terms of the host
 * the spawn is actually happening on.
 *
 * Codex needs an extra sentence the other host does not: its spawn tool only
 * ACCEPTS a `model` parameter when
 * `multi_agent_v2.expose_spawn_agent_model_overrides` is on. Measured on
 * 0.149.1 — with the flag off, the spawn payload carries
 * `task_name, fork_turns, message` and no model at all, and the subagent runs
 * on the session's own model (both threads' rollout records show the session
 * model); with it on, the payload carries `model` and the subagent's rollout
 * records the requested one. Telling a Codex agent to "set an explicit model"
 * without that is telling it to do something the host will not let it do, and
 * a rule that cannot be complied with is just a wall.
 *
 * @param {object} ctx The evaluation context.
 * @returns {string} The fix text.
 */
function missingModelFix(ctx) {
  const tiers = ctx.agent === "codex" ? CODEX_TIER_HINT : CLAUDE_TIER_HINT;
  const base =
    `Set an explicit model on the spawn: ${tiers} — the balanced tier when the task still needs judgement or ` +
    "careful correctness, the cheap tier when it is mechanical and fully specified.";
  if (ctx.agent !== "codex") return base;
  return (
    `${base} If the spawn tool exposes no model parameter at all, this install's Codex config is missing ` +
    "`multi_agent_v2.expose_spawn_agent_model_overrides = true`; without it every subagent silently runs on the " +
    "session's own model."
  );
}

/** Balanced/cheap tier names named in a fix, per host. */
const CLAUDE_TIER_HINT = '"sonnet" for the balanced tier, "haiku" for the cheap one';

/** As {@link CLAUDE_TIER_HINT}, in Codex's own concrete ids. */
const CODEX_TIER_HINT = `"${FALLBACK_MODEL_IDS.balanced}" for the balanced tier, "${FALLBACK_MODEL_IDS.cheap}" for the cheap one`;

/**
 * Evaluates a `Workflow` tool call by parsing every `agent()` call out of
 * its script and checking the model each one requests.
 *
 * @param {object} ctx The evaluation context.
 * @param {object} input The tool input.
 * @returns {null | {action: string, reason: string, fix?: string}} The
 * decision for this workflow.
 */
function evaluateWorkflow(ctx, input) {
  const { script, unreadable } = readWorkflowScript(ctx, input);

  if (unreadable) {
    return ask(
      "SUBAGENT MODEL: could not read the workflow script to check the models its agent() calls use.",
      "Approve manually, or pass the script inline.",
    );
  }
  if (!script) {
    return ask(
      "SUBAGENT MODEL: this workflow has no inline script, so there is no way to check which models its agents use.",
      "Approve manually, or pass the script inline.",
    );
  }

  const agentCalls = countAgentCalls(stripStringsAndComments(script));
  if (agentCalls === 0) return pass();

  const modelMentions = Array.from(script.matchAll(MODEL_KEY));

  if (modelMentions.length < agentCalls && !HAS_SPREAD.test(script)) {
    return deny(
      `SUBAGENT MODEL: the workflow has ${agentCalls} agent() call(s) but only ${modelMentions.length} explicit model assignment(s). A call without a model inherits the session's own.`,
      'Set `model` explicitly on every agent() call.',
    );
  }

  const unresolved = modelMentions.filter((m) => m[1] === undefined);
  if (unresolved.length > 0) {
    return ask(
      "SUBAGENT MODEL: this workflow sets `model` through a variable, shorthand, or property reference rather than a literal string, so the tier cannot be checked statically.",
      'Use a literal model string, e.g. model: "sonnet", or confirm the value manually.',
    );
  }

  const models = modelMentions.map((m) => m[1]);
  const tiers = models.map(tierOf);
  if (tiers.some((t) => t === TIERS.FRONTIER)) {
    return ask(
      "SUBAGENT MODEL: this workflow assigns a frontier-tier model to an agent() call. A single frontier session is a deliberate choice; a fan-out of frontier subagents is not.",
      "Approve if the task genuinely warrants it, or lower the tier.",
    );
  }
  if (tiers.some((t) => t === null)) {
    return ask(
      "SUBAGENT MODEL: this workflow assigns a model name that is not a recognised tier.",
      "Confirm the model choice, or use a recognised tier name.",
    );
  }

  const sessionTier = tierOf(ctx.session && ctx.session.model) || DEFAULT_SESSION_TIER;
  if (tiers.some((t) => t > sessionTier)) {
    return ask(
      "SUBAGENT MODEL: this workflow assigns a subagent a more expensive tier than the session's own model.",
      "Spawn at the session's tier or cheaper, or get approval for the stronger one.",
    );
  }

  return pass();
}

module.exports = {
  id: "subagent-model",
  title: "A subagent spawn may not be more expensive than the session, without approval",
  events: ["PreToolUse"],
  tools: null,
  defaultAction: "deny",
  group: "agent",
  requiresConfig: [],
  requiresModule: "agent-orchestration",

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: string, reason: string, fix?: string}} `deny`
   * on a spawn with no model at all; `ask` on a spawn more expensive than
   * the session, on a frontier-tier spawn regardless of the session, or on
   * an unrecognised model name; `pass` otherwise, including when the call is
   * not a spawn at all.
   */
  evaluate(ctx) {
    const toolName = String(ctx.toolName || "");
    const input = ctx.input && typeof ctx.input === "object" ? ctx.input : {};

    if (WORKFLOW_TOOL.test(toolName)) return evaluateWorkflow(ctx, input);

    const isKnownSpawn = DIRECT_SPAWN_TOOLS.test(toolName);
    const isUnknownSpawnLike =
      !isKnownSpawn &&
      SPAWN_LIKE_TOOL.test(toolName) &&
      Object.prototype.hasOwnProperty.call(input, "model");

    if (isKnownSpawn || isUnknownSpawnLike) return evaluateDirectSpawn(ctx, input.model);

    return pass();
  },
};
