"use strict";

/**
 * Layers the shipped default configuration underneath a matched project's
 * own, so naming a repository adds rules to it and never removes any.
 *
 * Project resolution is either/or: a repository whose remote or path matches
 * a project file runs under that file alone. Without a layer beneath it, the
 * protections `projects/_default.json` declares — the credential-bearing
 * paths every repository needs guarded — stop applying the moment somebody
 * writes a project file, which is the opposite of what writing one is meant
 * to do.
 *
 * The merge is therefore directional. A project's own configuration wins for
 * anything it declares, exactly as before, with one deliberate exception:
 * the keys listed in {@link ADDITIVE_KEYS} are a **union** of every layer,
 * and where two layers protect the same target the stronger action is kept.
 * A project file can add a protection and it can tighten one; it cannot
 * quietly drop or soften one it inherited. Weakening is a separate,
 * deliberate act — `softela-ai override`, which records who asked and why.
 */

/**
 * Ranks the actions a configured protection may carry, so a union can keep
 * the stronger of two entries for the same target.
 *
 * `off` and `pass` share rank 0: both mean "this does not fire", and neither
 * may be reached by inheriting a layer that said otherwise.
 */
const ACTION_STRENGTH = Object.freeze({ off: 0, pass: 0, advise: 1, ask: 2, deny: 3 });

/**
 * Keys that identify a project rather than configure it. A base layer never
 * contributes these: inheriting `id` would rename the project to `_default`
 * and take its overrides with it, and inheriting `match` would make every
 * repository match every project file.
 *
 * `stack` and `stacks` are here for a subtler reason. They answer "what kind
 * of repository is this", not "what is protected in it", and `stacks` takes
 * precedence over `stack` in `lib/stack-resolver.js`: a project declaring
 * `stack: "backend"` that inherited the default's per-extension `stacks`
 * list would have its own declaration silently outranked, and would resolve
 * to no stack at all for any path the inherited globs did not match. What
 * this merge exists to inherit is protection, never identity.
 */
const IDENTITY_KEYS = Object.freeze(["$schema", "id", "match", "stack", "stacks"]);

/**
 * The keys merged as a union of protections instead of being replaced
 * wholesale, each with the field identifying one entry — or `null` where the
 * entries are plain strings and are their own identity.
 *
 * Every key here names a list whose entries only ever restrict what may
 * happen. A key absent from this table keeps the original behaviour, where
 * the project's own value replaces the layer beneath it: `branchNaming` is
 * one pattern and not a set, `commands.typecheck` describes one repository's
 * build and cannot be unioned with another's, and `limits` is a threshold
 * whose stack preset is the more specific answer.
 */
const ADDITIVE_KEYS = Object.freeze({
  protectedPaths: "path",
  immutableMigrations: "path",
  localConfig: "tracked",
  baseBranches: null,
  notOurs: null,
});

/**
 * The nested `commands` keys merged as a union, by the same rule as
 * {@link ADDITIVE_KEYS}. `forbidden` is a list of commands a repository must
 * never run; `typecheck` and `install` describe one repository's own build
 * and stay replaced wholesale.
 */
const ADDITIVE_COMMAND_KEYS = Object.freeze({ forbidden: "pattern" });

/**
 * Returns the stronger of two configured actions.
 *
 * An unrecognised action ranks 0 rather than throwing, the fail-open
 * contract every other config read in this repository follows: a typo in a
 * project file must not take the whole merge out of service.
 *
 * @param {string} a One action.
 * @param {string} b The other.
 * @returns {string} Whichever of `a` and `b` restricts more.
 */
function strongerAction(a, b) {
  const rankA = ACTION_STRENGTH[a] === undefined ? 0 : ACTION_STRENGTH[a];
  const rankB = ACTION_STRENGTH[b] === undefined ? 0 : ACTION_STRENGTH[b];
  return rankB > rankA ? b : a;
}

/**
 * Unions two lists of plain strings, preserving the top layer's order and
 * appending whatever only the base declared.
 *
 * @param {string[]} base The weaker layer's entries.
 * @param {string[]} top The stronger layer's entries.
 * @returns {string[]} The union.
 */
function unionStrings(base, top) {
  const seen = new Set(top);
  return top.concat(base.filter((entry) => !seen.has(entry)));
}

/**
 * Unions two lists of protection objects, identified by one field.
 *
 * The top layer's entry wins on shape — its `reason`, and any extra fields
 * it carries, are what a developer actually reads in a denial — but where
 * both layers name an action, the stronger one is kept, so a project file
 * restating an inherited protection cannot soften it by accident.
 *
 * An entry that names no action at all is left without one. That absence is
 * meaningful: it defers to the rule's own default severity, which is often
 * stricter than anything a config would spell out, and filling it in from
 * the layer below would quietly replace a `deny` default with an inherited
 * `ask`.
 *
 * An entry set to `off` is also left alone, and is the one way a project may
 * end up weaker than the layer beneath it. That is deliberate: `off` is a
 * decision somebody wrote down in the project file, reviewed in the pull
 * request that added it, and printed back in the generated rulebook, which
 * is a different thing entirely from a protection lost because a config
 * happened to replace the list containing it.
 *
 * @param {object[]} base The weaker layer's entries.
 * @param {object[]} top The stronger layer's entries.
 * @param {string} keyField The field identifying one entry.
 * @returns {object[]} The union, top layer first.
 */
function unionByKey(base, top, keyField) {
  const byKey = new Map();
  for (const entry of base) {
    if (entry && typeof entry === "object") byKey.set(entry[keyField], entry);
  }

  const merged = top.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    if (entry.action === undefined || entry.action === "off") return entry;

    const inherited = byKey.get(entry[keyField]);
    if (!inherited || inherited.action === undefined) return entry;

    const action = strongerAction(entry.action, inherited.action);
    return action === entry.action ? entry : { ...entry, action };
  });

  const taken = new Set(top.filter((entry) => entry && typeof entry === "object").map((entry) => entry[keyField]));
  for (const entry of base) {
    if (entry && typeof entry === "object" && !taken.has(entry[keyField])) merged.push(entry);
  }
  return merged;
}

/**
 * Merges one key according to whether it is additive.
 *
 * @param {string} key The key being merged.
 * @param {*} baseValue The weaker layer's value.
 * @param {*} topValue The stronger layer's value.
 * @param {object} additiveKeys The additive table to consult.
 * @returns {*} The merged value.
 */
function mergeKey(key, baseValue, topValue, additiveKeys) {
  if (!Object.prototype.hasOwnProperty.call(additiveKeys, key)) return topValue;
  if (!Array.isArray(baseValue) || !Array.isArray(topValue)) return topValue;

  const keyField = additiveKeys[key];
  return keyField === null ? unionStrings(baseValue, topValue) : unionByKey(baseValue, topValue, keyField);
}

/**
 * Merges the nested `commands` object, so a project declaring only its own
 * `typecheck` still inherits the base layer's `forbidden` list.
 *
 * @param {object} base The weaker layer's `commands`, or absent.
 * @param {object} top The stronger layer's `commands`, or absent.
 * @returns {object|undefined} The merged object, or whichever side exists.
 */
function mergeCommands(base, top) {
  if (!base || typeof base !== "object") return top;
  if (!top || typeof top !== "object") return base;

  const merged = { ...base, ...top };
  for (const key of Object.keys(ADDITIVE_COMMAND_KEYS)) {
    if (!Object.prototype.hasOwnProperty.call(base, key)) continue;
    merged[key] = mergeKey(key, base[key], top[key] || [], ADDITIVE_COMMAND_KEYS);
  }
  return merged;
}

/**
 * Layers one configuration underneath another.
 *
 * Never throws and never returns `null`: a malformed layer contributes
 * nothing rather than taking the caller's configuration away.
 *
 * @param {object|null} base The weaker layer — the shipped defaults.
 * @param {object|null} top The stronger layer — the matched project.
 * @returns {object} The effective configuration.
 */
function mergeConfigLayer(base, top) {
  if (!top || typeof top !== "object") return base && typeof base === "object" ? base : {};
  if (!base || typeof base !== "object") return top;

  const merged = { ...top };
  for (const key of Object.keys(base)) {
    if (IDENTITY_KEYS.includes(key)) continue;

    if (key === "commands") {
      merged.commands = mergeCommands(base.commands, top.commands);
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(top, key)) {
      merged[key] = base[key];
      continue;
    }

    merged[key] = mergeKey(key, base[key], top[key], ADDITIVE_KEYS);
  }
  return merged;
}

module.exports = { mergeConfigLayer, strongerAction, ACTION_STRENGTH, ADDITIVE_KEYS, IDENTITY_KEYS };
