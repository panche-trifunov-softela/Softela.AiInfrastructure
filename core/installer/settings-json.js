"use strict";

/**
 * JSON-pointer mechanics for the two JSON settings files this installer
 * manages — Claude Code's `settings.json` and Codex's `hooks.json`
 * (CONTRACTS §9, INSTALLER.md §5).
 *
 * Every function here is pure: given an already-parsed object it computes
 * or mutates in memory, and never touches the filesystem itself. Reading
 * the file is `detect.js`'s job; deciding whether to act on the result is
 * `plan.js`'s; writing it back is `apply.js`'s.
 *
 * Hook entries carry no id, so an entry this installer owns is recognised
 * by matching its `command` against the installed dispatcher's own path —
 * the one string every entry this installer ever writes is guaranteed to
 * contain.
 */

/**
 * Substitutes `{{TOKEN}}` placeholders in a string.
 *
 * @param {string} template The template text.
 * @param {object} vars A flat map of token name (without braces) to
 * replacement value.
 * @returns {string} `template` with every recognised token replaced; an
 * unrecognised `{{TOKEN}}` is left as-is rather than guessed at.
 */
function substitute(template, vars) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole,
  );
}

/**
 * Substitutes `{{TOKEN}}` placeholders through an arbitrary JSON value.
 *
 * @param {*} value A string, array, plain object, or primitive.
 * @param {object} vars Same meaning as in {@link substitute}.
 * @returns {*} A new value of the same shape, with every string leaf
 * substituted.
 */
function substituteDeep(value, vars) {
  if (typeof value === "string") return substitute(value, vars);
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, vars));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = substituteDeep(value[key], vars);
    return out;
  }
  return value;
}

/**
 * Splits a JSON pointer into its unescaped segments.
 *
 * @param {string} pointer A pointer such as `/hooks/PreToolUse/0`.
 * @returns {string[]} The segments, with `~1` and `~0` unescaped per
 * RFC 6901; an empty array for the root pointer.
 */
function parsePointer(pointer) {
  return String(pointer)
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * Reads the value at a JSON pointer.
 *
 * @param {object} obj The object to read from.
 * @param {string} pointer The JSON pointer.
 * @returns {*} The value at `pointer`, or `undefined` when any segment is
 * missing.
 */
function getPointer(obj, pointer) {
  return parsePointer(pointer).reduce((cur, seg) => (cur === null || cur === undefined ? undefined : cur[seg]), obj);
}

/**
 * Checks whether a JSON pointer resolves to a defined value.
 *
 * @param {object} obj The object to read from.
 * @param {string} pointer The JSON pointer.
 * @returns {boolean} `true` when {@link getPointer} would return something
 * other than `undefined`.
 */
function hasPointer(obj, pointer) {
  return getPointer(obj, pointer) !== undefined;
}

/**
 * Writes a value at a JSON pointer, creating intermediate objects or
 * arrays as needed.
 *
 * @param {object} obj The object to mutate.
 * @param {string} pointer The JSON pointer.
 * @param {*} value The value to write.
 * @returns {object} `obj`, mutated in place.
 */
function setPointer(obj, pointer, value) {
  const segs = parsePointer(pointer);
  if (!segs.length) return obj;
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    const nextIsIndex = /^\d+$/.test(segs[i + 1]);
    if (cur[seg] === null || typeof cur[seg] !== "object") cur[seg] = nextIsIndex ? [] : {};
    cur = cur[seg];
  }
  cur[segs[segs.length - 1]] = value;
  return obj;
}

/**
 * Finds the index of a hook entry this installer owns, inside one event's
 * array of entries.
 *
 * @param {Array} eventEntries The `hooks.<event>` array; tolerated as
 * anything, including `undefined`.
 * @param {string} dispatchNeedle A substring unique to the installed
 * dispatcher's own path.
 * @returns {number} The index of the first entry whose `hooks[].command`
 * contains `dispatchNeedle`, or `-1` when none does.
 */
function findHookEntryIndex(eventEntries, dispatchNeedle) {
  if (!Array.isArray(eventEntries)) return -1;
  return eventEntries.findIndex(
    (entry) =>
      entry &&
      Array.isArray(entry.hooks) &&
      entry.hooks.some((h) => h && typeof h.command === "string" && h.command.includes(dispatchNeedle)),
  );
}

/**
 * Computes, without mutating anything, what would happen to one event's
 * dispatcher registration.
 *
 * @param {object} settingsObj The current settings object, as parsed from
 * disk (`{}` when the file does not exist yet).
 * @param {string} event The host event, e.g. `"PreToolUse"`.
 * @param {object} desiredEntry The substituted fragment entry this
 * installer wants registered for `event`.
 * @param {string} dispatchNeedle Same meaning as in
 * {@link findHookEntryIndex}.
 * @param {number} [pendingAppends] How many other entries this same
 * planning pass has already decided to append to this event, before this
 * call — so a second new registration for the same event reports the
 * index it will actually land at, not the index it would have landed at
 * against the untouched file alone.
 * @returns {{pointer: string, exists: boolean, changed: boolean}} `pointer`
 * names where the entry is, or would be appended; `exists` is whether an
 * owned entry is already there; `changed` is whether writing `desiredEntry`
 * would alter what is on disk.
 */
function planHookEvent(settingsObj, event, desiredEntry, dispatchNeedle, pendingAppends = 0) {
  const arr = settingsObj && settingsObj.hooks && Array.isArray(settingsObj.hooks[event]) ? settingsObj.hooks[event] : [];
  const idx = findHookEntryIndex(arr, dispatchNeedle);
  if (idx === -1) {
    return { pointer: `/hooks/${event}/${arr.length + pendingAppends}`, exists: false, changed: true };
  }
  const changed = JSON.stringify(arr[idx]) !== JSON.stringify(desiredEntry);
  return { pointer: `/hooks/${event}/${idx}`, exists: true, changed };
}

/**
 * Registers, or re-registers, the dispatcher for one host event.
 *
 * @param {object} settingsObj The settings object to mutate.
 * @param {string} event The host event, e.g. `"PreToolUse"`.
 * @param {object} desiredEntry The substituted fragment entry to install.
 * @param {string} dispatchNeedle Same meaning as in
 * {@link findHookEntryIndex}.
 * @returns {number} The index the entry ended up at.
 */
function upsertHookEvent(settingsObj, event, desiredEntry, dispatchNeedle) {
  if (!settingsObj.hooks || typeof settingsObj.hooks !== "object") settingsObj.hooks = {};
  if (!Array.isArray(settingsObj.hooks[event])) settingsObj.hooks[event] = [];
  const arr = settingsObj.hooks[event];
  const idx = findHookEntryIndex(arr, dispatchNeedle);
  if (idx === -1) {
    arr.push(desiredEntry);
    return arr.length - 1;
  }
  arr[idx] = desiredEntry;
  return idx;
}

/**
 * Removes this installer's dispatcher registration for one host event, if
 * present.
 *
 * @param {object} settingsObj The settings object to mutate.
 * @param {string} event The host event, e.g. `"PreToolUse"`.
 * @param {string} dispatchNeedle Same meaning as in
 * {@link findHookEntryIndex}.
 * @returns {boolean} `true` when an entry was found and removed.
 */
function removeHookEvent(settingsObj, event, dispatchNeedle) {
  if (!settingsObj.hooks || !Array.isArray(settingsObj.hooks[event])) return false;
  const arr = settingsObj.hooks[event];
  const idx = findHookEntryIndex(arr, dispatchNeedle);
  if (idx === -1) return false;
  arr.splice(idx, 1);
  if (arr.length === 0) delete settingsObj.hooks[event];
  return true;
}

/**
 * Computes, without mutating anything, what would happen to a `seed`
 * setting: written only when the pointer is currently absent.
 *
 * @param {object} settingsObj The current settings object.
 * @param {string} pointer The JSON pointer the value belongs at.
 * @returns {{present: boolean, action: "keep" | "write"}} `present` is
 * whether the pointer already resolves to a value; `action` is `"keep"`
 * when it does — a developer's own choice is never overwritten — and
 * `"write"` otherwise.
 */
function planSeedKey(settingsObj, pointer) {
  const present = hasPointer(settingsObj, pointer);
  return { present, action: present ? "keep" : "write" };
}

module.exports = {
  substitute,
  substituteDeep,
  parsePointer,
  getPointer,
  hasPointer,
  setPointer,
  findHookEntryIndex,
  planHookEvent,
  upsertHookEvent,
  removeHookEvent,
  planSeedKey,
};
