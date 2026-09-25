"use strict";

/**
 * Covers the defect where a module shipped with `defaultEnabled: true` after
 * an agent's own first install never reached that agent: `update` used to
 * keep exactly the module set already stored in `state.json`, with no way to
 * tell "this module did not exist yet" apart from "the developer turned it
 * off". `resolveModuleSelection` (`core/installer/index.js`) now closes that
 * gap by consulting the manifest's own `disabledModules` record
 * (`core/installer/manifest.js`).
 *
 * Upstream's own version of this suite also exercises the real CLI's
 * manifest/state bookkeeping and printed output, using two upstream-only
 * modules (`code-graph`, `delegation-envelope` — one of them declaring a
 * `requires` dependency on the other) as the concrete "shipped later"
 * example. Neither module, nor any shipped module declaring `requires`, is
 * part of this repository (see the port report), so those CLI-level cases
 * are not reproducible here without inventing a fixture module upstream
 * never shipped; only the pure `resolveModuleSelection` unit coverage below
 * is ported.
 */

const { suite } = require("../harness");
const { resolveModuleSelection } = require("../../core/installer/index.js");

suite("installer/module-defaults-on-update", ({ test, deepEq }) => {
  test("resolveModuleSelection enables a synthetic defaultEnabled module missing from prior state, and reports it", () => {
    const allModules = [
      { id: "a", json: { defaultEnabled: true, requires: [] } },
      { id: "b", json: { defaultEnabled: false, requires: [] } },
    ];
    const result = resolveModuleSelection(allModules, {}, { modules: [] }, "update", undefined, []);
    deepEq(result.ids, ["a"], "the defaultEnabled module must be turned on; the non-default one must not");
    deepEq(result.newlyEnabled, ["a"]);
    deepEq(result.blocked, []);
  });

  test("resolveModuleSelection leaves an explicitly disabled defaultEnabled module off, and does not report it as newly enabled", () => {
    const allModules = [{ id: "a", json: { defaultEnabled: true, requires: [] } }];
    const result = resolveModuleSelection(allModules, {}, { modules: [] }, "update", undefined, ["a"]);
    deepEq(result.ids, [], "an explicitly disabled module must never be turned back on automatically");
    deepEq(result.newlyEnabled, []);
    deepEq(result.blocked, []);
  });

  test("resolveModuleSelection blocks a defaultEnabled module whose requires is disabled, reports it, and does not fail", () => {
    const allModules = [
      { id: "a", json: { defaultEnabled: true, requires: ["b"] } },
      { id: "b", json: { defaultEnabled: true, requires: [] } },
    ];
    const result = resolveModuleSelection(allModules, {}, { modules: [] }, "update", undefined, ["b"]);
    deepEq(result.ids, [], "a is not enabled: its dependency b is disabled");
    deepEq(result.newlyEnabled, []);
    deepEq(result.blocked, [{ id: "a", missing: ["b"] }]);
  });

  test("resolveModuleSelection blocks a defaultEnabled module whose requires was simply never enabled (absent, not disabled)", () => {
    const allModules = [
      { id: "a", json: { defaultEnabled: true, requires: ["b"] } },
      { id: "b", json: { defaultEnabled: false, requires: [] } },
    ];
    const result = resolveModuleSelection(allModules, {}, { modules: [] }, "update", undefined, []);
    deepEq(result.ids, []);
    deepEq(result.blocked, [{ id: "a", missing: ["b"] }]);
  });

  test("resolveModuleSelection resolves a chain of newly-enabled default modules in one pass, regardless of scan order", () => {
    const allModules = [
      { id: "a", json: { defaultEnabled: true, requires: ["b"] } },
      { id: "b", json: { defaultEnabled: true, requires: ["c"] } },
      { id: "c", json: { defaultEnabled: true, requires: [] } },
    ];
    const result = resolveModuleSelection(allModules, {}, { modules: [] }, "update", undefined, []);
    deepEq(result.ids.slice().sort(), ["a", "b", "c"]);
    deepEq(result.newlyEnabled.slice().sort(), ["a", "b", "c"]);
    deepEq(result.blocked, []);
  });

  test("resolveModuleSelection treats a missing disabledIds argument the same as an empty list", () => {
    const allModules = [{ id: "a", json: { defaultEnabled: true, requires: [] } }];
    const result = resolveModuleSelection(allModules, {}, { modules: [] }, "update", undefined, undefined);
    deepEq(result.ids, ["a"], "an old manifest with no disabledModules key must behave exactly like an empty one");
  });

  test("resolveModuleSelection never touches an explicit CLI/interactive selection, even when it omits a defaultEnabled module", () => {
    const allModules = [
      { id: "a", json: { defaultEnabled: true, requires: [] } },
      { id: "b", json: { defaultEnabled: true, requires: [] } },
    ];
    const byFlag = resolveModuleSelection(allModules, { modules: "a" }, { modules: [] }, "update", undefined, []);
    deepEq(byFlag.ids, ["a"], "--modules is a complete, explicit override — b must not be silently added");
    deepEq(byFlag.newlyEnabled, []);

    const byModuleOp = resolveModuleSelection(allModules, { __moduleOp: { action: "enable", id: "a" } }, { modules: [] }, "update", undefined, []);
    deepEq(byModuleOp.ids, ["a"], "module enable must add exactly the requested id, not also sweep in other defaults");
    deepEq(byModuleOp.newlyEnabled, []);
    deepEq(byModuleOp.implicitlyDisabled, [], "module enable/disable targets exactly one id and never implicitly disables anything else");
  });

  test("resolveModuleSelection records a defaultEnabled module an explicit --modules list or interactive pick left out as implicitly disabled", () => {
    const allModules = [
      { id: "a", json: { defaultEnabled: true, requires: [] } },
      { id: "b", json: { defaultEnabled: true, requires: [] } },
      { id: "c", json: { defaultEnabled: false, requires: [] } },
    ];
    const byFlag = resolveModuleSelection(allModules, { modules: "a" }, { modules: [] }, "update", undefined, []);
    deepEq(byFlag.ids, ["a"]);
    deepEq(byFlag.implicitlyDisabled, ["b"], "b is defaultEnabled and was left out of an explicit --modules list; c is not defaultEnabled and is never recorded");

    const byPick = resolveModuleSelection(allModules, {}, { modules: [] }, "update", ["a"], []);
    deepEq(byPick.implicitlyDisabled, ["b"], "a confirmed interactive pick is exactly as explicit as --modules");

    const byFullPick = resolveModuleSelection(allModules, { modules: "a,b" }, { modules: [] }, "update", undefined, []);
    deepEq(byFullPick.implicitlyDisabled, [], "nothing defaultEnabled was left out, so nothing is recorded");
  });
});
