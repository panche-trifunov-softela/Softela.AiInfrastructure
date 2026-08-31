"use strict";

/**
 * Maps a model name to a cost tier.
 *
 * The subagent rules compare a spawn's tier against the session's own rather
 * than checking either against an allowlist, so this is the one place the
 * Claude and Codex model names are translated into a shared, comparable
 * scale.
 */

/**
 * Named tier numbers, from cheapest to most expensive. Higher is stronger
 * and pricier; the rules that consume this compare tiers with plain integer
 * comparison.
 */
const TIERS = Object.freeze({
  /** Frontier tier: `opus` / `fable` on Claude, `gpt-5.6-sol` on Codex. */
  FRONTIER: 3,

  /** Balanced tier: `sonnet` on Claude, `gpt-5.6-terra` on Codex. */
  BALANCED: 2,

  /** Cheap tier: `haiku` on Claude, `gpt-5.6-luna` on Codex. */
  CHEAP: 1,
});

/**
 * Tier-name patterns, checked in order from most to least expensive so a
 * name that happened to match more than one would resolve to the stronger
 * tier. Each pattern is word-bounded so a tier name embedded in a longer
 * model id (`claude-3-5-sonnet-20241022`, `gpt-5.6-sol-preview`) still
 * matches, while an unrelated word that merely contains the same letters
 * (`console`, `solstice`) does not.
 */
const TIER_PATTERNS = [
  { tier: TIERS.FRONTIER, pattern: /\b(opus|fable|sol)\b/i },
  { tier: TIERS.BALANCED, pattern: /\b(sonnet|terra)\b/i },
  { tier: TIERS.CHEAP, pattern: /\b(haiku|luna)\b/i },
];

/**
 * Resolves the cost tier of a model name.
 *
 * @param {*} model The model name as reported by the session or a spawn's
 * input; anything other than a non-empty string resolves to `null`.
 * @returns {number | null} One of {@link TIERS}, or `null` for a name this
 * table does not recognise — treated as unknown, never assumed frontier.
 */
function tierOf(model) {
  if (typeof model !== "string") return null;
  const name = model.trim();
  if (!name) return null;
  for (const { tier, pattern } of TIER_PATTERNS) {
    if (pattern.test(name)) return tier;
  }
  return null;
}

module.exports = { TIERS, TIER_PATTERNS, tierOf };
