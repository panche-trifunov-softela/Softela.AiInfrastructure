"use strict";

/**
 * `core/installer/state.js` — the developer's own local choices (enabled
 * modules, adapter options, option values), independent of any full install.
 */

const { suite } = require("../harness");
const state = require("../../core/installer/state");
const { statePath } = state;
const { writeJsonAtomic, writeTextAtomic } = require("../../core/lib/fs-safe");

suite("installer/state", ({ test, eq, deepEq, fakeHome }) => {
  test("readState defaults when no state file exists", () => {
    fakeHome();
    deepEq(state.readState("claude"), { modules: [], adapterOptions: {}, options: {} });
  });

  test("defaultState matches readState's own default", () => {
    deepEq(state.defaultState(), { modules: [], adapterOptions: {}, options: {} });
  });

  test("write then read round-trips exactly", () => {
    fakeHome();
    const written = {
      modules: ["analyze-first", "memory-as-context"],
      adapterOptions: { askMode: "advise" },
      options: { "memory-as-context": { location: "global" } },
    };
    state.writeState("codex", written);
    deepEq(state.readState("codex"), written);
  });

  test("readState defaults every field for a malformed file", () => {
    fakeHome();
    writeJsonAtomic(statePath("claude"), { modules: "nope", adapterOptions: 5, options: null });
    deepEq(state.readState("claude"), { modules: [], adapterOptions: {}, options: {} });
  });

  test("readState defaults for a file that is not valid JSON", () => {
    fakeHome();
    writeTextAtomic(statePath("claude"), "{ not json");
    deepEq(state.readState("claude"), { modules: [], adapterOptions: {}, options: {} });
  });

  test("claude and codex state are stored independently", () => {
    fakeHome();
    state.writeState("claude", { modules: ["reply-language"], adapterOptions: {}, options: {} });
    deepEq(state.readState("codex"), { modules: [], adapterOptions: {}, options: {} });
    eq(state.readState("claude").modules[0], "reply-language");
  });
});
