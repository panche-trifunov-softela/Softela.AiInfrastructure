"use strict";

/**
 * The `tier`-based Codex seed path (`plan.js#planModuleSettings`): a
 * `module.json` setting declares a cost tier instead of a version-pinned
 * model id, `codex-models.js#resolveModelForTier` turns it into a concrete
 * one only when the pointer is confidently absent, and a malformed
 * declaration (both `value` and `tier`, or neither) is reported as a
 * `kind: "config-error"` action rather than guessed at.
 *
 * Every case here drives `buildPlan` directly against a hand-built `ctx`,
 * the same style `plan.test.js` uses, with `CODEX_BIN` pointed at a path
 * that cannot be read — a fast, deterministic way to force the "fallback"
 * resolution step without needing a real Codex install on the machine
 * running this suite (`codex-models.test.js` already covers the
 * binary-sourced path in isolation).
 */

const path = require("path");
const { suite } = require("../harness");
const { buildPlan } = require("../../core/installer/plan");
const { FALLBACK_MODEL_IDS } = require("../../core/lib/codex-models");

const HOME = path.join("fake-home", ".codex");
const INSTALLED = path.join(HOME, "softela-ai");
const NEEDLE = path.join(INSTALLED, "adapters", "codex", "dispatch.js");
const NO_SUCH_BINARY = path.join("fake-home", "does-not-exist", "codex.exe");

/**
 * Builds a minimal, valid `ctx` for `buildPlan` targeting the `"codex"`
 * agent, mirroring `plan.test.js#baseCtx`.
 *
 * @param {object} [overrides] Fields to override on the base context.
 * @returns {object} A context matching `detect.js#gather`'s shape.
 */
function baseCtx(overrides = {}) {
  return {
    agent: "codex",
    home: HOME,
    installedRoot: INSTALLED,
    settingsFile: path.join(HOME, "hooks.json"),
    manifest: null,
    state: { modules: [], adapterOptions: {}, options: {} },
    allModules: [],
    enabledModules: [],
    files: [],
    settings: { content: {}, parseOk: true, existed: false },
    configToml: { path: path.join(HOME, "config.toml"), content: "" },
    agentsMdTargetPath: path.join(HOME, "AGENTS.md"),
    agentsMdCurrent: null,
    dispatchNeedle: NEEDLE,
    nodeExe: "node",
    fragment: { hooks: {} },
    version: "1.2.3",
    now: 1000,
    ...overrides,
  };
}

/**
 * Runs `fn` with `CODEX_BIN` set to a path that cannot possibly resolve to a
 * real binary, guaranteeing `resolveModelForTier` degrades to its fallback
 * step deterministically — then restores whatever `CODEX_BIN` was before,
 * so this suite never leaks state into another test file sharing the same
 * process.
 *
 * @param {() => void} fn The test body to run under the override.
 * @returns {void}
 */
function withUnresolvableCodexBin(fn) {
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = NO_SUCH_BINARY;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
  }
}

suite("installer/plan — codex tier seed settings", ({ test, eq, ok }) => {
  test("a tier setting resolves via the fallback step and writes when the pointer is absent", () => {
    withUnresolvableCodexBin(() => {
      const mod = {
        id: "agent-orchestration",
        dir: "/repo/modules/agent-orchestration",
        json: { settings: [{ agent: "codex", mode: "seed", pointer: "/model", tier: "frontier" }], hooks: [], options: {} },
        promptText: null,
      };
      const actions = buildPlan(baseCtx({ enabledModules: [mod] }));
      const a = actions.find((x) => x.kind === "settings" && x.pointer === "/model");
      ok(a, "expected a settings action for /model");
      eq(a.state, "new");
      eq(a.action, "write");
      eq(a.tier, "frontier");
      eq(a.value, FALLBACK_MODEL_IDS.frontier);
      eq(a.resolution.source, "fallback");
      ok(a.resolution.reason.length > 0, "a fallback resolution must always report why");
    });
  });

  test("a developer's existing value at that pointer is kept, and resolution is never attempted", () => {
    withUnresolvableCodexBin(() => {
      const mod = {
        id: "agent-orchestration",
        dir: "/repo/modules/agent-orchestration",
        json: { settings: [{ agent: "codex", mode: "seed", pointer: "/model", tier: "frontier" }], hooks: [], options: {} },
        promptText: null,
      };
      const ctx = baseCtx({ enabledModules: [mod], configToml: { path: path.join(HOME, "config.toml"), content: 'model = "gpt-6-titan"\n' } });
      const actions = buildPlan(ctx);
      const a = actions.find((x) => x.kind === "settings" && x.pointer === "/model");
      ok(a, "expected a settings action for /model");
      eq(a.state, "current");
      eq(a.action, "keep");
      // `resolution` stays null — the seed mechanism never even calls
      // `resolveModelForTier` for a pointer it already found present, which
      // is what makes "the developer's own value wins" true without this
      // path needing to implement it a second time.
      eq(a.resolution, null);
    });
  });

  test("a second tier at a different pointer, with the same fallback binary, resolves independently", () => {
    withUnresolvableCodexBin(() => {
      const mod = {
        id: "agent-orchestration",
        dir: "/repo/modules/agent-orchestration",
        json: {
          settings: [
            { agent: "codex", mode: "seed", pointer: "/model", tier: "frontier" },
            { agent: "codex", mode: "seed", pointer: "/review_model", tier: "cheap" },
          ],
          hooks: [],
          options: {},
        },
        promptText: null,
      };
      const actions = buildPlan(baseCtx({ enabledModules: [mod] }));
      const model = actions.find((x) => x.kind === "settings" && x.pointer === "/model");
      const subagent = actions.find((x) => x.kind === "settings" && x.pointer === "/review_model");
      eq(model.value, FALLBACK_MODEL_IDS.frontier);
      eq(subagent.value, FALLBACK_MODEL_IDS.cheap);
    });
  });

  test("declaring both value and tier is a config error, not a guess", () => {
    const mod = {
      id: "agent-orchestration",
      dir: "/repo/modules/agent-orchestration",
      json: { settings: [{ agent: "codex", mode: "seed", pointer: "/model", value: "gpt-5.6-sol", tier: "frontier" }], hooks: [], options: {} },
      promptText: null,
    };
    const actions = buildPlan(baseCtx({ enabledModules: [mod] }));
    const a = actions.find((x) => x.kind === "config-error");
    ok(a, "expected a config-error action");
    eq(a.action, "none");
    ok(a.reason.includes("both") && a.reason.includes("value") && a.reason.includes("tier"), a.reason);
    // Never planned as a settings write — a malformed declaration must not
    // reach config.toml either way.
    ok(!actions.some((x) => x.kind === "settings" && x.pointer === "/model"));
  });

  test("declaring neither value nor tier is a config error, not a guess", () => {
    const mod = {
      id: "agent-orchestration",
      dir: "/repo/modules/agent-orchestration",
      json: { settings: [{ agent: "codex", mode: "seed", pointer: "/model" }], hooks: [], options: {} },
      promptText: null,
    };
    const actions = buildPlan(baseCtx({ enabledModules: [mod] }));
    const a = actions.find((x) => x.kind === "config-error");
    ok(a, "expected a config-error action");
    ok(a.reason.includes("neither"), a.reason);
  });

  test("declaring a tier for an agent other than codex is a config error", () => {
    const mod = {
      id: "agent-orchestration",
      dir: "/repo/modules/agent-orchestration",
      json: { settings: [{ agent: "claude", mode: "seed", pointer: "/model", tier: "frontier" }], hooks: [], options: {} },
      promptText: null,
    };
    const claudeCtx = {
      agent: "claude",
      home: path.join("fake-home", ".claude"),
      installedRoot: path.join("fake-home", ".claude", "softela-ai"),
      settingsFile: path.join("fake-home", ".claude", "settings.json"),
      manifest: null,
      state: { modules: [], adapterOptions: {}, options: {} },
      allModules: [],
      enabledModules: [mod],
      files: [],
      settings: { content: {}, parseOk: true, existed: false },
      configToml: null,
        agentsMdTargetPath: path.join("fake-home", ".claude", "CLAUDE.md"),
      agentsMdCurrent: null,
      dispatchNeedle: path.join("fake-home", ".claude", "softela-ai", "adapters", "claude", "dispatch.js"),
      nodeExe: "node",
      fragment: { hooks: {} },
      version: "1.2.3",
      now: 1000,
    };
    const actions = buildPlan(claudeCtx);
    const a = actions.find((x) => x.kind === "config-error");
    ok(a, "expected a config-error action");
    ok(a.reason.includes("codex"), a.reason);
  });
});
