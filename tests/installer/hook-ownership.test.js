"use strict";

/**
 * Regression coverage for the needle a registered hook `command` is matched
 * on, when deciding whether it belongs to this tool
 * (`core/installer/plan.js#extractHookScriptNeedle`, `conflicts.js#ownedNeedles`)
 * — the needle must be built from the already-resolved path token
 * (`baseVars(ctx)`'s own `INSTALLED`/`DISPATCH`), never from the raw
 * `ctx.installedRoot`/`ctx.dispatchNeedle`, because the two hosts this
 * installer targets substitute a path into a `command` string in opposite
 * shapes (`plan.js#pathToken`'s own doc comment): Claude Code's is always
 * quoted, Codex's is bare and space-free when it can be, and quoted on its
 * own rarer fallback. A needle built from the raw path never appears
 * verbatim inside what was actually substituted, so a registration this tool
 * itself wrote reads as a foreign, pre-existing one — `update`/`doctor`
 * report it as an unresolved conflict, and `uninstall` leaves it behind.
 *
 * Every scenario below drives `buildPlan`'s own `ctx.shortPathOptions`
 * injection point (`plan.js#pathToken`, exercised the same way
 * `tests/installer/command-shape.test.js` already does) so the three shapes
 * are covered deterministically, without depending on this machine's own
 * volume settings:
 *
 * - Claude Code: always quoted, regardless of whether the root carries a
 *   space.
 * - Codex, a space-free root: bare, no subprocess involved.
 * - Codex, a space-containing root whose short-path resolution fails (the
 *   resolver itself returns `null`): falls back to quoted, exactly the way
 *   `core/lib/short-path.js#resolvePathToken` does for a real, unresolvable
 *   volume.
 */

const path = require("path");
const { suite } = require("../harness");
const { buildPlan, buildUninstallPlan, baseVars } = require("../../core/installer/plan");
const conflicts = require("../../core/installer/conflicts");

const EVENT = "SessionStart";
const MODULE_ID = "fake-mod";
const HOOK_SCRIPT = "hooks/inject-memory.js";

/**
 * Builds one module carrying a single hook registration for one agent, in
 * the shape `plan.js`/`conflicts.js` expect an entry of `ctx.enabledModules`
 * / `ctx.allModules` to have — the same shipped shape a real
 * `{{INSTALLED}}/hooks/<file>.js` template follows.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @returns {{id: string, dir: string, json: object, promptText: null}} The
 * module.
 */
function fakeModule(agent) {
  return {
    id: MODULE_ID,
    dir: "/repo/modules/fake-mod",
    json: {
      hooks: [
        {
          agent,
          event: EVENT,
          matcher: null,
          command: `{{NODE}} "{{INSTALLED}}/${HOOK_SCRIPT}" --agent-home="{{AGENT_HOME}}"`,
        },
      ],
      settings: [],
      options: {},
    },
    promptText: null,
  };
}

/**
 * Builds a minimal, valid `ctx` for `buildPlan`/`buildUninstallPlan`/
 * `conflicts.detectConflicts`, with every field these three read defaulted
 * to its emptiest shape (mirrors `tests/installer/plan.test.js#baseCtx` and
 * `tests/installer/command-shape.test.js#buildCtx`).
 *
 * @param {object} params
 * @param {string} params.agent `"claude"` or `"codex"`.
 * @param {string} params.home The agent home — never touched on disk.
 * @param {object} [params.shortPathOptions] Threaded straight through to
 * `resolvePathToken` via `plan.js#pathToken`.
 * @param {object} [params.overrides] Further fields to override.
 * @returns {object} A context every function under test accepts.
 */
function buildCtx({ agent, home, shortPathOptions, overrides }) {
  const installedRoot = path.join(home, "softela-ai");
  const mod = fakeModule(agent);
  return {
    agent,
    home,
    installedRoot,
    settingsFile: agent === "codex" ? path.join(home, "hooks.json") : path.join(home, "settings.json"),
    manifest: null,
    state: { modules: [mod.id], adapterOptions: {}, options: {} },
    allModules: [mod],
    enabledModules: [mod],
    files: [],
    settings: { content: {}, parseOk: true, existed: false },
    configToml: null,
    agentsMdTargetPath: path.join(home, agent === "codex" ? "AGENTS.md" : "CLAUDE.md"),
    agentsMdCurrent: null,
    // Deliberately wrong — a raw, unresolved path with no relation to any
    // token `pathToken` would ever produce for this ctx. Every scenario below
    // must pass without this value ever being consulted, proving `plan.js`
    // and `conflicts.js` no longer fall back to it for either the core
    // dispatcher or a module's own hook.
    dispatchNeedle: path.join("Z:", "never-consulted", "dispatch.js"),
    nodeExe: path.join(home, "node.exe"),
    fragment: { hooks: {} },
    version: "0.0.0-test",
    now: 1000,
    shortPathOptions,
    ...overrides,
  };
}

/**
 * Finds the one module hook `kind: "settings"` action a built plan produced.
 *
 * @param {object[]} actions A built plan.
 * @returns {object | undefined} The matching action.
 */
function moduleHookAction(actions) {
  return actions.find((a) => a.kind === "settings" && a.module === MODULE_ID);
}

const SCENARIOS = [
  {
    label: "Claude, quoted root (always, regardless of spaces)",
    agent: "claude",
    home: path.join("fake-home", ".claude-home"),
    shortPathOptions: { platform: "win32" },
  },
  {
    label: "Codex, space-free root (bare)",
    agent: "codex",
    home: path.join("fake-home", ".codex-home"),
    shortPathOptions: { platform: "win32" },
  },
  {
    label: "Codex, spaced root, short-path resolution fails (falls back to quoted)",
    agent: "codex",
    home: path.join("fake home", "with space", ".codex-home"),
    shortPathOptions: { platform: "win32", shortPathResolver: () => null },
  },
];

suite("installer/hook-ownership", ({ test, eq, ok }) => {
  for (const scenario of SCENARIOS) {
    const { label, agent, home, shortPathOptions } = scenario;

    test(`${label}: a freshly-planned module hook command actually embeds the token pathToken produced`, () => {
      // Sanity check on the scenario itself: proves the fixture actually
      // exercises the quoting shape its label claims, independent of the
      // needle logic under test. The expected suffix is built by
      // concatenation, exactly as `extractHookScriptNeedle` builds it and as
      // the real `command` template does (`"{{INSTALLED}}/hooks/<file>.js"`,
      // a literal forward slash immediately after the substituted token) —
      // never `path.join`, which would silently normalise the mixed
      // separators (a Windows `INSTALLED` token, a POSIX-style suffix) into a
      // string the real command never actually contains.
      const ctx = buildCtx({ agent, home, shortPathOptions });
      const vars = baseVars(ctx);
      const action = moduleHookAction(buildPlan(ctx));
      ok(action, `expected a ${MODULE_ID} hook action`);
      const command = action.value.hooks[0].command;
      const expectedSuffix = `${vars.INSTALLED}/${HOOK_SCRIPT}`;
      ok(command.includes(expectedSuffix), `expected the resolved INSTALLED token immediately followed by "/${HOOK_SCRIPT}" in: ${command}`);

      const isQuoted = vars.INSTALLED.startsWith('"') && vars.INSTALLED.endsWith('"');
      if (agent === "claude" || label.includes("falls back to quoted")) {
        ok(isQuoted, `expected pathToken to have quoted INSTALLED for this scenario, got: ${vars.INSTALLED}`);
      } else {
        ok(!isQuoted, `expected pathToken to have produced a bare INSTALLED for this scenario, got: ${vars.INSTALLED}`);
      }
    });

    test(`${label}: a hook this tool just registered is recognised as its own on the very next plan, not re-registered`, () => {
      const first = buildCtx({ agent, home, shortPathOptions });
      const firstAction = moduleHookAction(buildPlan(first));
      ok(firstAction, `expected a ${MODULE_ID} hook action on the first plan`);
      eq(firstAction.action, "write");
      eq(firstAction.state, "new");

      // Simulates exactly what `apply.js` would have put on disk: the same
      // substituted entry, sitting under the event this action targets.
      const second = buildCtx({
        agent,
        home,
        shortPathOptions,
        overrides: { settings: { content: { hooks: { [EVENT]: [firstAction.value] } }, parseOk: true, existed: true } },
      });
      const secondAction = moduleHookAction(buildPlan(second));
      ok(secondAction, `expected a ${MODULE_ID} hook action on the second plan`);
      eq(secondAction.action, "keep", "a hook already registered under the correct needle must be kept, not rewritten");
      eq(secondAction.state, "current");
    });

    test(`${label}: a freshly-installed hook registration is recognised as this tool's own, not reported as a conflict`, () => {
      const planCtx = buildCtx({ agent, home, shortPathOptions });
      const installedAction = moduleHookAction(buildPlan(planCtx));
      ok(installedAction, `expected a ${MODULE_ID} hook action`);

      const conflictCtx = buildCtx({
        agent,
        home,
        shortPathOptions,
        overrides: { settings: { content: { hooks: { [EVENT]: [installedAction.value] } }, parseOk: true, existed: true } },
      });
      const found = conflicts.detectConflicts(conflictCtx);
      ok(!conflicts.hasConflicts(found), `this tool's own registration must never read as a conflict against itself; hookGroups: ${JSON.stringify(found.hookGroups)}`);
    });

    test(`${label}: buildUninstallPlan removes a module hook registration it recognises as its own`, () => {
      const planCtx = buildCtx({ agent, home, shortPathOptions });
      const installedAction = moduleHookAction(buildPlan(planCtx));
      ok(installedAction, `expected a ${MODULE_ID} hook action`);

      const uninstallCtx = buildCtx({
        agent,
        home,
        shortPathOptions,
        overrides: {
          enabledModules: [],
          manifest: {
            version: "0.0.0-test",
            installedAt: null,
            agent,
            files: {},
            settings: [{ file: path.basename(planCtx.settingsFile), pointer: `/hooks/${EVENT}/0`, mode: "enforce", module: MODULE_ID, event: EVENT }],
            blocks: [],
            modules: [],
          },
        },
      });
      const removal = buildUninstallPlan(uninstallCtx).find((a) => a.kind === "settings" && a.module === MODULE_ID);
      ok(removal, "expected buildUninstallPlan to plan removal of the module's own hook registration");
      eq(removal.action, "remove");
      eq(removal.needle, installedAction.needle, "the uninstall removal must resolve to the exact same needle the install-time registration carried");
    });

    test(`${label}: a genuinely foreign registration under the agent home is still reported as a conflict`, () => {
      const foreignScriptPath = path.join(home, "my-own-hooks", "custom.js");
      const foreignCommand = `node "${foreignScriptPath}"`;
      const conflictCtx = buildCtx({
        agent,
        home,
        shortPathOptions,
        overrides: { settings: { content: { hooks: { [EVENT]: [{ matcher: null, hooks: [{ type: "command", command: foreignCommand }] }] } }, parseOk: true, existed: true } },
      });
      const found = conflicts.detectConflicts(conflictCtx);
      ok(conflicts.hasConflicts(found), "a genuinely foreign, under-home registration must still be reported as a conflict");
      eq(found.hookGroups.length, 1);
      eq(found.hookGroups[0].hooks[0].command, foreignCommand);
    });
  }

  test("Claude, quoted root: the core dispatcher's own registration (from the fragment, not a module) is likewise recognised as this tool's own", () => {
    // The bug this suite guards against extends to the dispatcher's own
    // needle too — `detect.js#gather`'s `ctx.dispatchNeedle` is built from
    // the same raw, unresolved `installedRoot`, and is never consulted by
    // `plan.js`/`conflicts.js` any more (see `buildCtx`'s deliberately-wrong
    // `dispatchNeedle` value above).
    const agent = "claude";
    const home = path.join("fake-home", ".claude-home");
    const fragment = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: '{{NODE}} "{{DISPATCH}}"' }] }] } };

    const first = buildCtx({ agent, home, shortPathOptions: { platform: "win32" }, overrides: { enabledModules: [], allModules: [], fragment } });
    const dispatcherAction = buildPlan(first).find((a) => a.kind === "settings" && a.event === "PreToolUse" && a.mode === "enforce");
    ok(dispatcherAction, "expected the core dispatcher's own hook action");
    eq(dispatcherAction.action, "write");

    const second = buildCtx({
      agent,
      home,
      shortPathOptions: { platform: "win32" },
      overrides: {
        enabledModules: [],
        allModules: [],
        fragment,
        settings: { content: { hooks: { PreToolUse: [dispatcherAction.value] } }, parseOk: true, existed: true },
      },
    });
    const kept = buildPlan(second).find((a) => a.kind === "settings" && a.event === "PreToolUse" && a.mode === "enforce");
    ok(kept, "expected the core dispatcher's own hook action on the second plan");
    eq(kept.action, "keep", "the dispatcher's own registration must be recognised as already present, not rewritten");

    const conflictCtx = buildCtx({
      agent,
      home,
      shortPathOptions: { platform: "win32" },
      overrides: { enabledModules: [], allModules: [], fragment, settings: { content: { hooks: { PreToolUse: [dispatcherAction.value] } }, parseOk: true, existed: true } },
    });
    const found = conflicts.detectConflicts(conflictCtx);
    ok(!conflicts.hasConflicts(found), "the core dispatcher's own registration must never read as a conflict against itself");
  });
});
