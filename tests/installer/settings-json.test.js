"use strict";

/**
 * `core/installer/settings-json.js` — JSON-pointer mechanics and the
 * ownership-by-command-substring recognition every `enforce`/`seed` decision
 * in `plan.js` rests on.
 */

const { suite } = require("../harness");
const sj = require("../../core/installer/settings-json");

const NEEDLE = "/home/dev/.claude/softela-ai/adapters/claude/dispatch.js";
const DESIRED = { matcher: "Bash|Write", hooks: [{ type: "command", command: `node "${NEEDLE}"` }] };

suite("installer/settings-json", ({ test, eq, deepEq, ok }) => {
  test("substitute replaces known tokens and leaves unknown ones alone", () => {
    eq(sj.substitute("{{NODE}} {{INSTALLED}}/x {{UNKNOWN}}", { NODE: "node", INSTALLED: "/root" }), "node /root/x {{UNKNOWN}}");
  });

  test("substituteDeep walks arrays and objects, substituting only string leaves", () => {
    const value = { command: "{{NODE}} run", matcher: null, list: ["{{OPT_X}}", 2] };
    deepEq(sj.substituteDeep(value, { NODE: "node", OPT_X: "yes" }), { command: "node run", matcher: null, list: ["yes", 2] });
  });

  test("getPointer/hasPointer read nested values and report absence", () => {
    const obj = { hooks: { PreToolUse: [{ a: 1 }] } };
    eq(sj.getPointer(obj, "/hooks/PreToolUse/0/a"), 1);
    eq(sj.hasPointer(obj, "/hooks/PreToolUse/0/a"), true);
    eq(sj.hasPointer(obj, "/hooks/PreToolUse/9"), false);
    eq(sj.hasPointer(obj, "/nothing/here"), false);
  });

  test("setPointer creates intermediate objects and arrays as needed", () => {
    const obj = {};
    sj.setPointer(obj, "/agents/default_subagent_model", "gpt-5.6-luna");
    eq(obj.agents.default_subagent_model, "gpt-5.6-luna");

    const obj2 = {};
    sj.setPointer(obj2, "/hooks/PreToolUse/0", { x: 1 });
    ok(Array.isArray(obj2.hooks.PreToolUse));
    deepEq(obj2.hooks.PreToolUse[0], { x: 1 });
  });

  test("findHookEntryIndex matches by command substring, not by structural equality", () => {
    const arr = [
      { matcher: "Bash", hooks: [{ type: "command", command: "node /other/dispatch.js" }] },
      { matcher: "Write", hooks: [{ type: "command", command: `node "${NEEDLE}"` }] },
    ];
    eq(sj.findHookEntryIndex(arr, NEEDLE), 1);
    eq(sj.findHookEntryIndex(arr, "/nonexistent"), -1);
    eq(sj.findHookEntryIndex(undefined, NEEDLE), -1);
  });

  test("planHookEvent reports a new registration when nothing owned exists yet", () => {
    const info = sj.planHookEvent({}, "PreToolUse", DESIRED, NEEDLE, 0);
    eq(info.exists, false);
    eq(info.changed, true);
    eq(info.pointer, "/hooks/PreToolUse/0");
  });

  test("planHookEvent accounts for pendingAppends within the same planning pass", () => {
    const info = sj.planHookEvent({}, "PreToolUse", DESIRED, NEEDLE, 2);
    eq(info.pointer, "/hooks/PreToolUse/2");
  });

  test("planHookEvent reports unchanged when the owned entry already matches", () => {
    const settingsObj = { hooks: { PreToolUse: [DESIRED] } };
    const info = sj.planHookEvent(settingsObj, "PreToolUse", DESIRED, NEEDLE);
    eq(info.exists, true);
    eq(info.changed, false);
    eq(info.pointer, "/hooks/PreToolUse/0");
  });

  test("planHookEvent reports changed when the owned entry's content differs", () => {
    const settingsObj = { hooks: { PreToolUse: [{ matcher: "OldMatcher", hooks: [{ type: "command", command: `node "${NEEDLE}"` }] }] } };
    const info = sj.planHookEvent(settingsObj, "PreToolUse", DESIRED, NEEDLE);
    eq(info.exists, true);
    eq(info.changed, true);
  });

  test("upsertHookEvent appends a new entry without disturbing existing ones", () => {
    const settingsObj = { hooks: { PreToolUse: [{ matcher: "Other", hooks: [{ type: "command", command: "node /elsewhere.js" }] }] } };
    const idx = sj.upsertHookEvent(settingsObj, "PreToolUse", DESIRED, NEEDLE);
    eq(idx, 1);
    eq(settingsObj.hooks.PreToolUse.length, 2);
    eq(settingsObj.hooks.PreToolUse[0].matcher, "Other");
  });

  test("upsertHookEvent replaces the owned entry in place when it already exists", () => {
    const settingsObj = { hooks: { PreToolUse: [{ matcher: "Stale", hooks: [{ type: "command", command: `node "${NEEDLE}"` }] }] } };
    const idx = sj.upsertHookEvent(settingsObj, "PreToolUse", DESIRED, NEEDLE);
    eq(idx, 0);
    eq(settingsObj.hooks.PreToolUse.length, 1);
    eq(settingsObj.hooks.PreToolUse[0].matcher, "Bash|Write");
  });

  test("removeHookEvent removes the owned entry and deletes an emptied event key", () => {
    const settingsObj = { hooks: { PreToolUse: [DESIRED] } };
    eq(sj.removeHookEvent(settingsObj, "PreToolUse", NEEDLE), true);
    eq(settingsObj.hooks.PreToolUse, undefined);
  });

  test("removeHookEvent leaves other entries for the same event untouched", () => {
    const other = { matcher: "Other", hooks: [{ type: "command", command: "node /elsewhere.js" }] };
    const settingsObj = { hooks: { PreToolUse: [other, DESIRED] } };
    eq(sj.removeHookEvent(settingsObj, "PreToolUse", NEEDLE), true);
    deepEq(settingsObj.hooks.PreToolUse, [other]);
  });

  test("removeHookEvent is a no-op when nothing owned is registered", () => {
    const settingsObj = { hooks: { PreToolUse: [{ matcher: "Other", hooks: [{ type: "command", command: "node /elsewhere.js" }] }] } };
    eq(sj.removeHookEvent(settingsObj, "PreToolUse", NEEDLE), false);
    eq(settingsObj.hooks.PreToolUse.length, 1);
  });

  test("planSeedKey never overwrites a value already present", () => {
    eq(sj.planSeedKey({ model: "opus-4-custom" }, "/model").action, "keep");
    eq(sj.planSeedKey({}, "/model").action, "write");
    eq(sj.planSeedKey({}, "/model").present, false);
  });
});
