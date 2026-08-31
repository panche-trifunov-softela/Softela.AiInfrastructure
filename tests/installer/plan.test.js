"use strict";

/**
 * `core/installer/plan.js` — `buildPlan`/`buildUninstallPlan` are pure
 * functions of an already-gathered context (CONTRACTS §9, INSTALLER.md §3),
 * so every case here is asserted against a hand-built `ctx`, with no
 * filesystem involved at all.
 */

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");
const { buildPlan, buildUninstallPlan, HOOK_TIMEOUT_SECONDS } = require("../../core/installer/plan");
const mb = require("../../core/installer/managed-block");

// Built with `path.join`, exactly as `plan.js#baseVars` and `detect.js#gather`
// build the same paths, so a needle computed here still matches a command
// string `plan.js` substitutes internally, on every platform.
const HOME = path.join("fake-home", ".claude");
const INSTALLED = path.join(HOME, "softela-ai");
const NEEDLE = path.join(INSTALLED, "adapters", "claude", "dispatch.js");

/**
 * Builds a minimal, valid `ctx` for `buildPlan`, with every field
 * `plan.js` reads defaulted to its emptiest shape.
 *
 * @param {object} [overrides] Fields to override on the base context.
 * @returns {object} A context matching `detect.js#gather`'s shape.
 */
function baseCtx(overrides = {}) {
  return {
    agent: "claude",
    home: HOME,
    installedRoot: INSTALLED,
    settingsFile: `${HOME}/settings.json`,
    manifest: null,
    state: { modules: [], adapterOptions: {}, options: {} },
    allModules: [],
    enabledModules: [],
    files: [],
    settings: { content: {}, parseOk: true, existed: false },
    configToml: null,
    agentsMdTargetPath: `${HOME}/CLAUDE.md`,
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
 * Finds the single `kind: "copy" | "remove" | "skip"` action for one file.
 *
 * @param {object[]} actions A built plan.
 * @param {string} relPath The file's manifest-relative path.
 * @returns {object | undefined} The matching action.
 */
function fileAction(actions, relPath) {
  return actions.find((a) => a.relPath === relPath);
}

suite("installer/plan", ({ test, eq, ok }) => {
  test("a brand-new shipped file is planned as a fresh write", () => {
    const ctx = baseCtx({
      files: [{ relPath: "softela-ai/core/engine.js", sourceAbsPath: "/repo/core/engine.js", shippedHash: "H1", onDiskHash: null, manifestHash: undefined }],
    });
    const a = fileAction(buildPlan(ctx), "softela-ai/core/engine.js");
    eq(a.state, "new");
    eq(a.action, "write");
  });

  test("a manifest-tracked file missing from disk is reinstalled as absent", () => {
    const ctx = baseCtx({
      files: [{ relPath: "softela-ai/core/engine.js", sourceAbsPath: "/repo/core/engine.js", shippedHash: "H1", onDiskHash: null, manifestHash: "H1" }],
    });
    const a = fileAction(buildPlan(ctx), "softela-ai/core/engine.js");
    eq(a.state, "absent");
    eq(a.action, "write");
  });

  test("an untouched, unchanged file produces no action", () => {
    const ctx = baseCtx({
      files: [{ relPath: "softela-ai/core/engine.js", sourceAbsPath: "/repo/core/engine.js", shippedHash: "H1", onDiskHash: "H1", manifestHash: "H1" }],
    });
    const a = fileAction(buildPlan(ctx), "softela-ai/core/engine.js");
    eq(a.action, "none");
    eq(a.state, "current");
  });

  test("an untouched file whose shipped content changed is overwritten in place", () => {
    const ctx = baseCtx({
      files: [{ relPath: "softela-ai/core/engine.js", sourceAbsPath: "/repo/core/engine.js", shippedHash: "H2", onDiskHash: "H1", manifestHash: "H1" }],
    });
    const a = fileAction(buildPlan(ctx), "softela-ai/core/engine.js");
    eq(a.action, "write");
    eq(a.state, "current");
  });

  test("a locally modified tracked file is kept, writing .new instead of overwriting it", () => {
    const ctx = baseCtx({
      files: [{ relPath: "softela-ai/core/engine.js", sourceAbsPath: "/repo/core/engine.js", shippedHash: "H2", onDiskHash: "DEV", manifestHash: "H1" }],
    });
    const a = fileAction(buildPlan(ctx), "softela-ai/core/engine.js");
    eq(a.action, "write-new");
    eq(a.state, "modified");
  });

  test("a present but never-tracked file is kept, writing .new rather than claiming it", () => {
    const ctx = baseCtx({
      files: [{ relPath: "softela-ai/core/engine.js", sourceAbsPath: "/repo/core/engine.js", shippedHash: "H1", onDiskHash: "DEV", manifestHash: undefined }],
    });
    const a = fileAction(buildPlan(ctx), "softela-ai/core/engine.js");
    eq(a.action, "write-new");
    eq(a.state, "modified");
  });

  test("a file whose content matches the shipped hash, found with no manifest at all on record, is kept as-is rather than silently adopted", () => {
    // Superseded scenario: an earlier round's fix auto-recovered ownership
    // here on the reasoning that "a developer file could never coincide with
    // the shipped hash" — but a developer who copied or vendored this exact
    // file out of the repository hits exactly that coincidence, and nothing
    // corroborates a prior install when there is no manifest object at all
    // (`ctx.manifest` itself is `null` — not merely missing this one entry).
    // Content alone cannot tell a fully lost manifest.json apart from a
    // genuine developer file, so this weakest-evidence case is now treated
    // with the same caution as any other untracked file: kept exactly as it
    // is, with the shipped bytes offered as a `.new` sibling instead of
    // overwritten in place.
    const ctx = baseCtx({
      manifest: null,
      files: [{ relPath: "softela-ai/core/engine.js", sourceAbsPath: "/repo/core/engine.js", shippedHash: "H1", onDiskHash: "H1", manifestHash: undefined }],
    });
    const a = fileAction(buildPlan(ctx), "softela-ai/core/engine.js");
    eq(a.kind, "copy");
    eq(a.action, "write-new");
    eq(a.state, "modified");
    eq(a.recoveredOwnership, "unseen");
    ok(a.reason.includes(".new"), `expected the .new-sibling caution to be named in the reason, got: ${a.reason}`);
  });

  test("a single manifest entry lost within an otherwise-intact manifest still recovers ownership in place, unlike a fully absent manifest", () => {
    // The write-then-checkpoint race this guards: the file itself landed on
    // disk, but its manifest entry never made it into a checkpoint before a
    // crash. The manifest object itself is real and present — just missing
    // this one key — which is real corroborating evidence a prior softela-ai
    // install actually wrote this file, unlike the fully-absent-manifest
    // case above. This must keep self-healing without a `.new` sibling, or
    // every install would grow a permanent stray file after any such race.
    const ctx = baseCtx({
      manifest: { version: "1.2.3", installedAt: null, agent: "claude", files: { "softela-ai/core/other.js": "H9" }, settings: [], blocks: [], modules: [] },
      files: [{ relPath: "softela-ai/core/engine.js", sourceAbsPath: "/repo/core/engine.js", shippedHash: "H1", onDiskHash: "H1", manifestHash: undefined }],
    });
    const a = fileAction(buildPlan(ctx), "softela-ai/core/engine.js");
    eq(a.kind, "copy");
    eq(a.action, "write");
    eq(a.state, "current");
    eq(a.recoveredOwnership, "lost-entry");
    ok(!a.reason.includes(".new"), `expected no .new-sibling reason for a race-recovered file, got: ${a.reason}`);
  });

  test("a file the manifest has never seen at all is treated more cautiously than one the manifest merely disagrees about, even though both coincide byte-for-byte with the shipped file", () => {
    // The two situations `f.manifestHash` distinguishes must not collapse
    // into the same outcome: a manifest entry that is merely wrong is real
    // evidence this installer wrote the file before, so that case still
    // recovers ownership in place — only the no-manifest-at-all case is
    // downgraded to write-new.
    const neverSeen = fileAction(
      buildPlan(baseCtx({ manifest: null, files: [{ relPath: "softela-ai/core/engine.js", sourceAbsPath: "/repo/core/engine.js", shippedHash: "H1", onDiskHash: "H1", manifestHash: undefined }] })),
      "softela-ai/core/engine.js",
    );
    const staleEntry = fileAction(
      buildPlan(baseCtx({ files: [{ relPath: "softela-ai/core/engine.js", sourceAbsPath: "/repo/core/engine.js", shippedHash: "H1", onDiskHash: "H1", manifestHash: "WRONG" }] })),
      "softela-ai/core/engine.js",
    );
    eq(neverSeen.action, "write-new");
    eq(staleEntry.action, "write");
    ok(neverSeen.action !== staleEntry.action, "expected the no-manifest-at-all case to be handled more cautiously than the stale-manifest-entry case");
  });

  test("an untouched file whose manifest entry carries the wrong hash recovers ownership instead of getting a .new sibling", () => {
    // The manifest's recorded hash is present but simply wrong — e.g. a
    // hand-edit, or a stale value left over from a bug — while the file
    // itself was never touched: its bytes are exactly what this version
    // ships. Ownership must be recovered from content the same way it is
    // when the manifest entry is missing entirely, not only in that one case.
    const ctx = baseCtx({
      files: [{ relPath: "softela-ai/core/engine.js", sourceAbsPath: "/repo/core/engine.js", shippedHash: "H1", onDiskHash: "H1", manifestHash: "WRONG" }],
    });
    const a = fileAction(buildPlan(ctx), "softela-ai/core/engine.js");
    eq(a.kind, "copy");
    eq(a.action, "write");
    eq(a.state, "current");
    ok(!a.reason.includes(".new"), `expected no .new-sibling reason for a recovered file, got: ${a.reason}`);
  });

  test("an edited shipped file is still recognised as edited, even though its manifest hash is also stale — recovery must never overwrite a real edit", () => {
    // Guards against matching too eagerly: onDiskHash differs from BOTH the
    // shipped hash and the manifest's recorded hash, which is exactly what a
    // genuine local edit combined with a merely-stale manifest looks like.
    // Only an exact match against the shipped hash proves ownership; this
    // file's content proves nothing of the sort.
    const ctx = baseCtx({
      files: [{ relPath: "softela-ai/core/engine.js", sourceAbsPath: "/repo/core/engine.js", shippedHash: "H1", onDiskHash: "DEV", manifestHash: "WRONG" }],
    });
    const a = fileAction(buildPlan(ctx), "softela-ai/core/engine.js");
    eq(a.action, "write-new");
    eq(a.state, "modified");
  });

  test("an untouched file no longer shipped is removed", () => {
    const ctx = baseCtx({
      files: [{ relPath: "softela-ai/core/guards/old.js", sourceAbsPath: null, shippedHash: null, onDiskHash: "H1", manifestHash: "H1" }],
    });
    const a = fileAction(buildPlan(ctx), "softela-ai/core/guards/old.js");
    eq(a.kind, "remove");
    eq(a.action, "remove");
  });

  test("a locally modified file no longer shipped is left in place, not destroyed", () => {
    const ctx = baseCtx({
      files: [{ relPath: "softela-ai/core/guards/old.js", sourceAbsPath: null, shippedHash: null, onDiskHash: "DEV", manifestHash: "H1" }],
    });
    const a = fileAction(buildPlan(ctx), "softela-ai/core/guards/old.js");
    eq(a.kind, "skip");
    eq(a.action, "none");
    eq(a.locallyModified, true);
  });

  test("a new dispatcher registration is planned as an enforce write at the next free index", () => {
    const ctx = baseCtx({ fragment: { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "{{NODE}} \"{{DISPATCH}}\"" }] }] } } });
    const actions = buildPlan(ctx);
    const hookAction = actions.find((a) => a.kind === "settings" && a.event === "PreToolUse");
    eq(hookAction.mode, "enforce");
    eq(hookAction.action, "write");
    eq(hookAction.pointer, "/hooks/PreToolUse/0");
  });

  /* ---------------------------------------------------------- hook timeout */

  test("the hook timeout leaves room for a loaded machine, not just an idle one", () => {
    // Pinned deliberately. A dispatch that runs in ~330 ms idle was measured
    // at 2.8 s while every core was busy — a full test run plus a build plus
    // subagents is the normal state of a working session, and at five
    // seconds those dispatches timed out. A timed-out hook on Codex is
    // fail-open: the call proceeds unreviewed, so a tight budget does not
    // slow the guards down, it switches them off exactly when the machine is
    // busiest. Lowering this number again needs that trade-off re-argued.
    eq(HOOK_TIMEOUT_SECONDS, 30);
  });

  test("[claude] the core dispatcher registration built from the fragment carries an explicit timeout", () => {
    const ctx = baseCtx({ fragment: { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "{{NODE}} \"{{DISPATCH}}\"" }] }] } } });
    const hookAction = buildPlan(ctx).find((a) => a.kind === "settings" && a.event === "PreToolUse");
    eq(hookAction.value.hooks[0].timeout, HOOK_TIMEOUT_SECONDS);
  });

  test("[codex] the core dispatcher registration built from the fragment carries an explicit timeout", () => {
    const ctx = baseCtx({
      agent: "codex",
      settingsFile: "/fake/home/.codex/hooks.json",
      fragment: { hooks: { PreToolUse: [{ matcher: null, hooks: [{ type: "command", command: "{{NODE}} \"{{DISPATCH}}\"" }] }] } },
    });
    const hookAction = buildPlan(ctx).find((a) => a.kind === "settings" && a.event === "PreToolUse");
    eq(hookAction.value.hooks[0].timeout, HOOK_TIMEOUT_SECONDS);
  });

  test("[claude] a module's own hook registration carries an explicit timeout", () => {
    const mod = {
      id: "fake-mod",
      dir: "/repo/modules/fake-mod",
      json: { hooks: [{ agent: "claude", event: "SessionStart", matcher: null, command: '{{NODE}} "{{INSTALLED}}/hooks/x.js"' }], settings: [], options: {} },
      promptText: null,
    };
    const a = buildPlan(baseCtx({ enabledModules: [mod] })).find((x) => x.kind === "settings" && x.module === "fake-mod");
    eq(a.value.hooks[0].timeout, HOOK_TIMEOUT_SECONDS);
  });

  test("[codex] a module's own hook registration carries an explicit timeout", () => {
    const mod = {
      id: "fake-mod",
      dir: "/repo/modules/fake-mod",
      json: { hooks: [{ agent: "codex", event: "SessionStart", matcher: null, command: '{{NODE}} "{{INSTALLED}}/hooks/x.js"' }], settings: [], options: {} },
      promptText: null,
    };
    const ctx = baseCtx({ agent: "codex", settingsFile: "/fake/home/.codex/hooks.json", enabledModules: [mod] });
    const a = buildPlan(ctx).find((x) => x.kind === "settings" && x.module === "fake-mod");
    eq(a.value.hooks[0].timeout, HOOK_TIMEOUT_SECONDS);
  });

  test("every real module's hook entries carry an explicit timeout, for both hosts", () => {
    const modulesDir = path.join(__dirname, "..", "..", "modules");
    const moduleIds = fs.readdirSync(modulesDir).filter((id) => fs.existsSync(path.join(modulesDir, id, "module.json")));
    const mods = moduleIds.map((id) => ({
      id,
      dir: path.join(modulesDir, id),
      json: JSON.parse(fs.readFileSync(path.join(modulesDir, id, "module.json"), "utf8")),
      promptText: null,
    }));

    for (const agent of ["claude", "codex"]) {
      const ctx = baseCtx({
        agent,
        settingsFile: agent === "codex" ? "/fake/home/.codex/hooks.json" : `${HOME}/settings.json`,
        enabledModules: mods,
      });
      const hookActions = buildPlan(ctx).filter((a) => a.kind === "settings" && a.mode === "enforce" && a.module);
      ok(hookActions.length > 0, `expected at least one real module hook action to check for ${agent}`);
      for (const a of hookActions) {
        for (const h of a.value.hooks) {
          eq(h.timeout, HOOK_TIMEOUT_SECONDS, `module "${a.module}"'s ${agent} ${a.event} hook must carry the explicit timeout`);
        }
      }
    }
  });

  test("[claude] an already-registered, unchanged dispatcher entry is kept, not rewritten", () => {
    // Mirrors exactly what `baseVars` + `substituteDeep` compute from the
    // shipped fragment shape (`adapters/*/*.fragment.json`): `plan.js#pathToken`
    // always quotes a path token for Claude Code, via `quotePath`, regardless
    // of whether it carries a space — Claude Code hands the whole command
    // string to a POSIX shell, where an unquoted backslash would otherwise
    // destroy a Windows path — so both `node` and the joined `NEEDLE` path
    // come back quoted.
    const desiredEntry = { matcher: "Bash", hooks: [{ type: "command", command: `"node" "${NEEDLE}"`, timeout: HOOK_TIMEOUT_SECONDS }] };
    const ctx = baseCtx({
      fragment: { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "{{NODE}} {{DISPATCH}}" }] }] } },
      nodeExe: "node",
      settings: { content: { hooks: { PreToolUse: [desiredEntry] } }, parseOk: true, existed: true },
    });
    const hookAction = buildPlan(ctx).find((a) => a.kind === "settings" && a.event === "PreToolUse");
    eq(hookAction.action, "keep");
  });

  test("[codex] an already-registered, unchanged dispatcher entry is kept, not rewritten", () => {
    // Codex spawns argv[0] directly, with no shell, so `plan.js#pathToken`
    // routes through `resolvePathToken`, which returns a path bare and
    // unquoted whenever it carries no space — exactly what `node` and the
    // joined dispatch path are here, so no quotes appear anywhere in the
    // desired command (`shortPathOptions` pins the platform so this holds
    // regardless of the machine actually running the suite). `DISPATCH` is
    // built from `ctx.agent`, so the needle used to both compute and find
    // this entry must point at the codex adapter, not the claude one `NEEDLE`
    // names.
    const codexNeedle = path.join(INSTALLED, "adapters", "codex", "dispatch.js");
    const desiredEntry = { matcher: "Bash", hooks: [{ type: "command", command: `node ${codexNeedle}`, timeout: HOOK_TIMEOUT_SECONDS }] };
    const ctx = baseCtx({
      agent: "codex",
      settingsFile: "/fake/home/.codex/hooks.json",
      dispatchNeedle: codexNeedle,
      fragment: { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "{{NODE}} {{DISPATCH}}" }] }] } },
      nodeExe: "node",
      shortPathOptions: { platform: "win32" },
      settings: { content: { hooks: { PreToolUse: [desiredEntry] } }, parseOk: true, existed: true },
    });
    const hookAction = buildPlan(ctx).find((a) => a.kind === "settings" && a.event === "PreToolUse");
    eq(hookAction.action, "keep");
  });

  test("a seed setting already present is kept; absent, it is written", () => {
    const mod = { id: "agent-orchestration", dir: "/repo/modules/agent-orchestration", json: { settings: [{ agent: "claude", mode: "seed", pointer: "/model", value: "opus" }], hooks: [], options: {} }, promptText: null };

    const present = buildPlan(baseCtx({ enabledModules: [mod], settings: { content: { model: "opus-4-custom" }, parseOk: true, existed: true } }));
    const presentAction = present.find((a) => a.kind === "settings" && a.pointer === "/model");
    eq(presentAction.action, "keep");
    eq(presentAction.state, "current");

    const absent = buildPlan(baseCtx({ enabledModules: [mod] }));
    const absentAction = absent.find((a) => a.kind === "settings" && a.pointer === "/model");
    eq(absentAction.action, "write");
    eq(absentAction.state, "new");
  });

  test("a codex seed setting is written into config.toml only when the pointer is confidently absent", () => {
    const mod = { id: "agent-orchestration", dir: "/repo/modules/agent-orchestration", json: { settings: [{ agent: "codex", mode: "seed", pointer: "/agents/default_subagent_model", value: "gpt-5.6-luna" }], hooks: [], options: {} }, promptText: null };
    const ctx = baseCtx({
      agent: "codex",
      settingsFile: "/fake/home/.codex/hooks.json",
      configToml: { path: "/fake/home/.codex/config.toml", content: '[agents]\ndefault_subagent_model = "gpt-6-titan"\n' },
      enabledModules: [mod],
    });
    const a = buildPlan(ctx).find((x) => x.kind === "settings" && x.pointer === "/agents/default_subagent_model");
    eq(a.action, "keep");
    eq(a.state, "current");
  });

  test("a codex seed setting plans as a creation when config.toml does not exist yet", () => {
    const mod = { id: "agent-orchestration", dir: "/repo/modules/agent-orchestration", json: { settings: [{ agent: "codex", mode: "seed", pointer: "/agents/default_subagent_model", value: "gpt-5.6-luna" }], hooks: [], options: {} }, promptText: null };
    const ctx = baseCtx({
      agent: "codex",
      settingsFile: "/fake/home/.codex/hooks.json",
      configToml: { path: "/fake/home/.codex/config.toml", exists: false, content: null },
      enabledModules: [mod],
    });
    const a = buildPlan(ctx).find((x) => x.kind === "settings" && x.pointer === "/agents/default_subagent_model");
    ok(a, "an absent config.toml must still plan a write, not a skip");
    eq(a.action, "write");
    // `state: "absent"`, not `"new"`, is what makes the rendered plan line
    // read as a creation rather than an edit of something that already
    // exists (`index.js#symbolFor` treats both the same for its own `+`
    // symbol, but only `"absent"` is accurate here).
    eq(a.state, "absent");
    eq(a.value, "gpt-5.6-luna");
  });

  test("a config.toml that exists but cannot be read is skipped, never treated as absent", () => {
    const mod = { id: "agent-orchestration", dir: "/repo/modules/agent-orchestration", json: { settings: [{ agent: "codex", mode: "seed", pointer: "/model", value: "gpt-5.6-sol" }], hooks: [], options: {} }, promptText: null };
    const ctx = baseCtx({
      agent: "codex",
      settingsFile: "/fake/home/.codex/hooks.json",
      configToml: { path: "/fake/home/.codex/config.toml", exists: true, content: null },
      enabledModules: [mod],
    });
    const a = buildPlan(ctx).find((x) => x.pointer === "/model");
    ok(a, "expected an action for /model");
    eq(a.kind, "skip");
    eq(a.action, "none");
    ok(a.reason.includes("could not be read"), a.reason);
    ok(!a.reason.includes("does not exist"), "the reason must reflect that the file is present, just unreadable");
  });

  test("an unparseable config.toml is skipped, never guessed at", () => {
    const mod = { id: "agent-orchestration", dir: "/repo/modules/agent-orchestration", json: { settings: [{ agent: "codex", mode: "seed", pointer: "/model", value: "gpt-5.6-sol" }], hooks: [], options: {} }, promptText: null };
    const ctx = baseCtx({
      agent: "codex",
      settingsFile: "/fake/home/.codex/hooks.json",
      configToml: { path: "/fake/home/.codex/config.toml", content: 'notes = """\nmultiline\n"""\n' },
      enabledModules: [mod],
    });
    const a = buildPlan(ctx).find((x) => x.pointer === "/model");
    eq(a.kind, "skip");
    eq(a.action, "none");
    ok(a.reason.includes("could not be parsed confidently"));
  });

  test("an unparseable settings.json is skipped entirely, never guessed at", () => {
    const ctx = baseCtx({ settings: { content: {}, parseOk: false, existed: true } });
    const actions = buildPlan(ctx);
    const skip = actions.find((a) => a.kind === "skip" && a.target === ctx.settingsFile);
    ok(skip);
    eq(skip.action, "none");
  });

  test("no global instructions block is planned when nothing is shipped for this agent", () => {
    const actions = buildPlan(baseCtx());
    eq(actions.some((a) => a.kind === "block"), false);
  });

  test("an enabled module's prompt is folded into a single managed global-instructions block", () => {
    const mod = { id: "analyze-first", dir: "/repo/modules/analyze-first", json: { settings: [], hooks: [], options: {} }, promptText: "Read before writing." };
    const actions = buildPlan(baseCtx({ enabledModules: [mod] }));
    const block = actions.find((a) => a.kind === "block");
    ok(block);
    ok(block.content.includes("Read before writing."));
    eq(block.action, "write");
  });

  test("buildUninstallPlan removes only enforce hook registrations, never seed settings", () => {
    const ctx = baseCtx({
      manifest: {
        version: "1.2.3",
        installedAt: "2026-01-01T00:00:00.000Z",
        agent: "claude",
        files: {},
        settings: [
          { file: "settings.json", pointer: "/hooks/PreToolUse/0", mode: "enforce" },
          { file: "settings.json", pointer: "/model", mode: "seed" },
        ],
        blocks: [],
        modules: [],
      },
    });
    const actions = buildUninstallPlan(ctx);
    const removals = actions.filter((a) => a.kind === "settings");
    eq(removals.length, 1);
    eq(removals[0].event, "PreToolUse");
    eq(removals[0].action, "remove");
    eq(actions.some((a) => a.pointer === "/model"), false);
  });

  test("buildUninstallPlan removes the managed block wherever the manifest recorded one", () => {
    const ctx = baseCtx({
      agentsMdCurrent: null,
      manifest: { version: "1.2.3", installedAt: null, agent: "claude", files: {}, settings: [], blocks: [{ file: "CLAUDE.md", marker: "softela-ai" }], modules: [] },
    });
    // buildUninstallPlan reads the block's current content straight off disk via
    // `readText`, which a purely in-memory ctx cannot supply — absent content
    // (`readText` returning null on a nonexistent path) is itself the case this
    // asserts: no crash, and nothing is planned for a file that is not there.
    const actions = buildUninstallPlan(ctx);
    eq(actions.some((a) => a.kind === "block"), false);
  });

  test("buildUninstallPlan still applies the ordinary file three-cases to every manifest-tracked file", () => {
    const ctx = baseCtx({
      files: [{ relPath: "softela-ai/core/engine.js", sourceAbsPath: null, shippedHash: null, onDiskHash: "H1", manifestHash: "H1" }],
      manifest: { version: "1.2.3", installedAt: null, agent: "claude", files: { "softela-ai/core/engine.js": "H1" }, settings: [], blocks: [], modules: [] },
    });
    const a = fileAction(buildUninstallPlan(ctx), "softela-ai/core/engine.js");
    eq(a.kind, "remove");
    eq(a.action, "remove");
  });

  /* ------------------------------------------------- option-value safety */

  test("a stored enum option value outside its declared set falls back to the default rather than reaching the command line", () => {
    const mod = {
      id: "fake-enum",
      dir: "/repo/modules/fake-enum",
      json: {
        hooks: [
          {
            agent: "claude",
            event: "SessionStart",
            matcher: null,
            command: '{{NODE}} "{{INSTALLED}}/hooks/x.js" --location={{OPT_LOCATION}}',
          },
        ],
        settings: [],
        options: { location: { type: "enum", values: ["repo", "infrastructure", "global"], default: "infrastructure" } },
      },
      promptText: null,
    };
    const ctx = baseCtx({
      enabledModules: [mod],
      state: { modules: [], adapterOptions: {}, options: { "fake-enum": { location: "infrastructure & calc.exe & echo pwned" } } },
    });
    const a = buildPlan(ctx).find((x) => x.kind === "settings" && x.module === "fake-enum");
    const command = a.value.hooks[0].command;
    ok(!command.includes("calc.exe"), `expected the out-of-enum value to be rejected, got:\n${command}`);
    ok(command.endsWith("--location=infrastructure"), `expected the declared default to be substituted, got:\n${command}`);
  });

  /**
   * Builds a minimal `{id, dir, json, promptText}` module whose single
   * hook substitutes a free-text `note` option into a double-quoted
   * command-line argument, matching the shape every shipped free-text
   * option (e.g. `reply-language`'s `languages`) actually uses.
   *
   * @returns {{id: string, dir: string, json: object, promptText: null}}
   */
  function freeTextNoteMod() {
    return {
      id: "fake-free-text",
      dir: "/repo/modules/fake-free-text",
      json: {
        hooks: [
          {
            agent: "claude",
            event: "SessionStart",
            matcher: null,
            command: '{{NODE}} "{{INSTALLED}}/hooks/x.js" --note="{{OPT_NOTE}}"',
          },
        ],
        settings: [],
        options: { note: { type: "stringList", default: ["safe"] } },
      },
      promptText: null,
    };
  }

  /**
   * Asserts that a `note` value rejected by {@link findUnsafeOptionValue}
   * never reaches a hook command, and that a `config-error` action naming
   * the offending character is planned instead.
   *
   * @param {string} value The unsafe option value under test.
   * @param {string} expectedChar The character {@link findUnsafeOptionValue}
   * is expected to name as the reason for rejection.
   * @returns {void}
   */
  function expectRejected(value, expectedChar) {
    const ctx = baseCtx({
      enabledModules: [freeTextNoteMod()],
      state: { modules: [], adapterOptions: {}, options: { "fake-free-text": { note: [value] } } },
    });
    const actions = buildPlan(ctx);
    const settingsAction = actions.find((x) => x.kind === "settings" && x.module === "fake-free-text");
    eq(settingsAction, undefined, `expected no hook command to be planned for the unsafe value ${JSON.stringify(value)}`);
    const error = actions.find((x) => x.kind === "config-error" && x.module === "fake-free-text");
    ok(error, `expected a config-error action rejecting ${JSON.stringify(value)}`);
    ok(
      error.reason.includes(expectedChar),
      `expected the rejection reason to name "${expectedChar}", got:\n${error.reason}`,
    );
  }

  test("a free-text option value containing a shell metacharacter is rejected rather than reaching the command line", () => {
    expectRejected('a" & calc.exe & echo "pwned', '"');
  });

  test("POSIX command substitution in a free-text option value is rejected, not executed", () => {
    expectRejected("English$(touch MARKER)", "$");
  });

  test("a backtick command substitution in a free-text option value is rejected, not executed", () => {
    expectRejected("English`touch MARKER`", "`");
  });

  test("a percent-delimited cmd.exe variable reference in a free-text option value is rejected, not expanded", () => {
    expectRejected("English %USERNAME%", "%");
  });

  test("a trailing backslash in a free-text option value is rejected, so it can never escape the template's closing quote", () => {
    expectRejected("English\\", "\\");
  });

  test("a free-text option value using only letters, spaces, commas, periods, apostrophes and hyphens reaches the command line unchanged", () => {
    const value = "German, French, Luba-Katanga, O'Brien";
    const ctx = baseCtx({
      enabledModules: [freeTextNoteMod()],
      state: { modules: [], adapterOptions: {}, options: { "fake-free-text": { note: [value] } } },
    });
    const actions = buildPlan(ctx);
    ok(!actions.some((x) => x.kind === "config-error"), "a safe value must never be rejected");
    const a = actions.find((x) => x.kind === "settings" && x.module === "fake-free-text");
    ok(a, "expected the hook command to be planned for a safe value");
    const match = /--note="([^]*)"$/.exec(a.value.hooks[0].command);
    ok(match, `expected a single quoted --note argument, got:\n${a.value.hooks[0].command}`);
    eq(match[1], value);
  });

  test("an option value containing the managed-block delimiter is rejected outright, never silently fragmenting the block", () => {
    // Superseded assertion: an earlier round of this fix expected the
    // malicious value to be *sanitized* into a single clean marker pair.
    // The current design rejects the whole module instead — the same
    // outright-rejection behaviour `expectRejected` already exercises for a
    // command-line-unsafe value, rather than silently rewriting what the
    // developer typed.
    const mod = {
      id: "fake-lang",
      dir: "/repo/modules/fake-lang",
      json: { hooks: [], settings: [], options: { languages: { type: "stringList", default: ["English"] } } },
      promptText: "Reply in {{OPT_LANGUAGES}}.",
    };
    const malicious = `English${mb.END} INJECTED ${mb.BEGIN}`;
    const ctx = baseCtx({
      enabledModules: [mod],
      state: { modules: [], adapterOptions: {}, options: { "fake-lang": { languages: [malicious] } } },
    });
    const actions = buildPlan(ctx);
    ok(
      actions.some((a) => a.kind === "config-error" && a.module === "fake-lang"),
      "expected the delimiter-carrying value to be rejected as a config-error",
    );
    eq(
      actions.some((a) => a.kind === "block"),
      false,
      "expected no managed-block action — the module's only contribution is unsafe",
    );
  });

  test("a value crafted to fool a two-pass BEGIN/END strip (BEGIN's first half, then END, then BEGIN's second half) never reconstructs a stray marker in the block", () => {
    // Regression for a defect in an earlier round's `sanitizeForBlockBody`:
    // stripping BEGIN occurrences and then, separately, END occurrences (one
    // pass each, rather than to a fixed point) let this exact construction
    // reconstruct a full BEGIN out of two fragments that individually
    // contain neither marker.
    const k = 30;
    const evil = mb.BEGIN.slice(0, k) + mb.END + mb.BEGIN.slice(k);
    ok(!evil.includes(mb.BEGIN), "sanity: the crafted value must not literally contain BEGIN");
    ok(evil.includes(mb.END), "sanity: the crafted value must literally contain END");

    const mod = {
      id: "fake-lang",
      dir: "/repo/modules/fake-lang",
      json: { hooks: [], settings: [], options: { languages: { type: "stringList", default: ["English"] } } },
      promptText: "Reply in {{OPT_LANGUAGES}}.",
    };
    const ctx = baseCtx({
      enabledModules: [mod],
      state: { modules: [], adapterOptions: {}, options: { "fake-lang": { languages: [evil] } } },
    });
    const actions = buildPlan(ctx);
    const block = actions.find((a) => a.kind === "block");
    if (block) {
      const beginCount = block.content.split(mb.BEGIN).length - 1;
      const endCount = block.content.split(mb.END).length - 1;
      eq(beginCount, 1, `expected exactly one real BEGIN marker, got ${beginCount} in:\n${block.content}`);
      eq(endCount, 1, `expected exactly one real END marker, got ${endCount} in:\n${block.content}`);
    }
    ok(
      actions.some((a) => a.kind === "config-error" && a.module === "fake-lang"),
      "expected the crafted value to be rejected as a config-error",
    );
  });

  test("an unsafe option value is rejected before it ever reaches the managed block, not only the hook command line", () => {
    // A module with no hooks at all still has its option values checked —
    // an earlier round's gate lived only on the hook-command path, so a
    // module that contributes nothing but prompt text could still leak an
    // unsafe value straight into CLAUDE.md/AGENTS.md.
    const mod = {
      id: "fake-note",
      dir: "/repo/modules/fake-note",
      json: { hooks: [], settings: [], options: { note: { type: "stringList", default: ["safe"] } } },
      promptText: "Note: {{OPT_NOTE}}.",
    };
    const unsafe = "<script>alert(1)</script>";
    const ctx = baseCtx({
      enabledModules: [mod],
      state: { modules: [], adapterOptions: {}, options: { "fake-note": { note: [unsafe] } } },
    });
    const actions = buildPlan(ctx);
    ok(
      actions.some((a) => a.kind === "config-error" && a.module === "fake-note"),
      "expected the unsafe value to be rejected",
    );
    const block = actions.find((a) => a.kind === "block");
    eq(block, undefined, "expected no managed-block action — the module's only contribution is unsafe");
  });

  test("a config-error rejecting an unsafe option value is reported even when settings.json is unparseable", () => {
    // `planModuleHooks` never runs in this case (buildPlan skips straight to
    // the "left untouched" skip action for settings.json) — the option-value
    // gate must not depend on that path running to fire.
    const mod = {
      id: "fake-note",
      dir: "/repo/modules/fake-note",
      json: { hooks: [], settings: [], options: { note: { type: "stringList", default: ["safe"] } } },
      promptText: "Note: {{OPT_NOTE}}.",
    };
    const ctx = baseCtx({
      enabledModules: [mod],
      state: { modules: [], adapterOptions: {}, options: { "fake-note": { note: ["<unsafe>"] } } },
      settings: { content: {}, parseOk: false, existed: true },
    });
    const actions = buildPlan(ctx);
    ok(
      actions.some((a) => a.kind === "config-error" && a.module === "fake-note"),
      "expected the unsafe value to still be rejected",
    );
    eq(actions.some((a) => a.kind === "block"), false);
  });

  test("an option value merely resembling the managed-block delimiter — the bare word BEGIN, not the full marker — reaches the block unchanged", () => {
    const mod = {
      id: "fake-note",
      dir: "/repo/modules/fake-note",
      json: { hooks: [], settings: [], options: { note: { type: "stringList", default: ["safe"] } } },
      promptText: "Note: {{OPT_NOTE}}.",
    };
    const value = "Say BEGIN and END, but only as plain English words.";
    const ctx = baseCtx({
      enabledModules: [mod],
      state: { modules: [], adapterOptions: {}, options: { "fake-note": { note: [value] } } },
    });
    const actions = buildPlan(ctx);
    ok(!actions.some((a) => a.kind === "config-error"), "a value that merely resembles a delimiter must never be rejected");
    const block = actions.find((a) => a.kind === "block");
    ok(block, "expected a managed-block action");
    ok(block.content.includes(value), `expected the legitimate value to survive verbatim, got:\n${block.content}`);
  });

  /* ------------------------------------------------------------- matcher */

  test("a module hook's null matcher becomes an empty string for Claude Code, which requires a string matcher", () => {
    const mod = {
      id: "fake-mod",
      dir: "/repo/modules/fake-mod",
      json: {
        hooks: [{ agent: "claude", event: "SessionStart", matcher: null, command: '{{NODE}} "{{INSTALLED}}/hooks/x.js"' }],
        settings: [],
        options: {},
      },
      promptText: null,
    };
    const ctx = baseCtx({ enabledModules: [mod] });
    const a = buildPlan(ctx).find((x) => x.kind === "settings" && x.module === "fake-mod");
    eq(a.value.matcher, "");
  });

  test("a module hook's null matcher stays null for Codex — this installer deliberately does not translate it into a tool_name pattern", () => {
    const mod = {
      id: "fake-mod",
      dir: "/repo/modules/fake-mod",
      json: {
        hooks: [{ agent: "codex", event: "SessionStart", matcher: null, command: '{{NODE}} "{{INSTALLED}}/hooks/x.js"' }],
        settings: [],
        options: {},
      },
      promptText: null,
    };
    const ctx = baseCtx({ agent: "codex", settingsFile: "/fake/home/.codex/hooks.json", enabledModules: [mod] });
    const a = buildPlan(ctx).find((x) => x.kind === "settings" && x.module === "fake-mod");
    eq(a.value.matcher, null);
  });

  test("every real module's Claude hook entries substitute to a string matcher, never null — Claude Code's settings schema rejects a non-string matcher", () => {
    const modulesDir = path.join(__dirname, "..", "..", "modules");
    const moduleIds = fs.readdirSync(modulesDir).filter((id) => fs.existsSync(path.join(modulesDir, id, "module.json")));
    const mods = moduleIds.map((id) => ({
      id,
      dir: path.join(modulesDir, id),
      json: JSON.parse(fs.readFileSync(path.join(modulesDir, id, "module.json"), "utf8")),
      promptText: null,
    }));
    const actions = buildPlan(baseCtx({ enabledModules: mods }));
    const claudeHookActions = actions.filter((a) => a.kind === "settings" && a.mode === "enforce" && a.module);
    ok(claudeHookActions.length > 0, "expected at least one real module hook action to check");
    for (const a of claudeHookActions) {
      ok(
        typeof a.value.matcher === "string",
        `module "${a.module}"'s ${a.event} matcher must be a string for Claude Code, got ${JSON.stringify(a.value.matcher)}`,
      );
      for (const h of a.value.hooks) {
        ok(typeof h.type === "string" && h.type.length > 0, `module "${a.module}"'s hook entry needs a string type`);
        ok(typeof h.command === "string" && h.command.length > 0, `module "${a.module}"'s hook entry needs a string command`);
      }
    }
  });
});
