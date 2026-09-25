"use strict";

const path = require("path");
const { execFileSync } = require("child_process");
const { suite } = require("../harness");
const { readText } = require("../../core/lib/fs-safe");
const { loadModule, validateModuleJson, runInstall, snapshotAgentHome, paths } = require("./_helpers");

const MODULE_ID = "analyze-first";
const HOOK_SCRIPT = path.join(paths.repoRoot(), "modules", MODULE_ID, "hooks", "inject-plan-gate.js");

/**
 * Runs `inject-plan-gate.js` as a real subprocess, exactly the way the
 * installed dispatcher command invokes it — through stdin, never by
 * requiring its internals.
 *
 * @param {string} rawInput The exact text written to stdin.
 * @returns {string} The process's stdout, `""` for a silent pass.
 */
function runHookRaw(rawInput) {
  return execFileSync(process.execPath, [HOOK_SCRIPT], { input: rawInput, encoding: "utf8" });
}

/**
 * Runs `inject-plan-gate.js` with a JSON-encoded payload on stdin.
 *
 * @param {object} payload The payload to serialise onto stdin.
 * @returns {string} The process's stdout, `""` for a silent pass.
 */
function runHook(payload) {
  return runHookRaw(JSON.stringify(payload));
}

suite("modules/analyze-first", ({ test, eq, deepEq, ok, fakeHome }) => {
  const mod = loadModule(MODULE_ID);

  test("module.json validates against the shape MODULES.md documents", () => {
    deepEq(validateModuleJson(mod), []);
  });

  test("this module owns no guard, no settings, no options, and no prompt.md — it only gates a section of the base rulebook, plus the plan-gate reminder hook", () => {
    eq(mod.json.prompt, undefined);
    eq(mod.json.guards.length, 0);
    eq(mod.json.settings.length, 0);
    deepEq(mod.json.options, {});
  });

  test("declares the plan-gate reminder hook, and its script is a readable file", () => {
    const hookToPaths = mod.json.files.map((f) => f.to);
    deepEq(hookToPaths, ["hooks/inject-plan-gate.js", "hooks/analyze-first-core-lib.js"]);
  });

  test("registers inject-plan-gate.js on UserPromptSubmit for both agents", () => {
    const events = mod.json.hooks.map((h) => `${h.agent}:${h.event}`).sort();
    deepEq(events, ["claude:UserPromptSubmit", "codex:UserPromptSubmit"]);
    for (const h of mod.json.hooks) {
      eq(h.matcher, null);
      ok(h.command.includes("inject-plan-gate.js"), `command should invoke inject-plan-gate.js, got: ${h.command}`);
    }
  });

  test("defaults on, per MODULES.md", () => {
    eq(mod.json.defaultEnabled, true);
  });

  test("enabling then disabling leaves the agent home exactly as it was", () => {
    fakeHome();
    runInstall("codex", []);
    const baseline = snapshotAgentHome("codex");

    runInstall("codex", [MODULE_ID]);
    const enabled = snapshotAgentHome("codex");
    ok(enabled.globalInstructions.includes("## Analyse first, then wait"), "the rulebook's own section should appear once enabled");
    ok(
      Object.keys(enabled.files).some((f) => f.includes(`modules/${MODULE_ID}/`)),
      "the module's own catalogue copy (module.json/README.md) should be installed",
    );

    runInstall("codex", []);
    const after = snapshotAgentHome("codex");
    deepEq(after.files, baseline.files);
    deepEq(after.settingsHooks, baseline.settingsHooks);
    eq(after.globalInstructions, baseline.globalInstructions);
  });

  /* --------------------------------------------------- inject-plan-gate.js */

  test("inject-plan-gate: a main-session prompt carries additionalContext and no systemMessage key at all", () => {
    const out = runHook({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: process.cwd(), prompt: "do the thing" });
    const parsed = JSON.parse(out);
    ok(
      parsed.hookSpecificOutput.additionalContext.startsWith("Before you edit: read the relevant memory"),
      `expected the plan-gate reminder, got: ${out}`,
    );
    eq(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    ok(!Object.prototype.hasOwnProperty.call(parsed, "systemMessage"), "the developer must see nothing at all");
  });

  test("inject-plan-gate: a subagent's payload (agent_id set) produces no output whatsoever", () => {
    const out = runHook({ hook_event_name: "UserPromptSubmit", session_id: "s1", agent_id: "01a0-abc", agent_type: "default", prompt: "do the thing" });
    eq(out, "");
  });

  test("inject-plan-gate: unparseable stdin produces no output and exits 0", () => {
    const out = runHookRaw("{not json at all");
    eq(out, "");
  });

  test("inject-plan-gate: empty stdin produces no output and exits 0", () => {
    const out = runHookRaw("");
    eq(out, "");
  });

  test("disabling this module removes only its own rulebook section — the rest of the base rulebook, which every install always carries, stays in place", () => {
    fakeHome();
    const claudeMdPath = path.join(paths.agentHome("claude"), "CLAUDE.md");

    runInstall("claude", [MODULE_ID]);
    const enabled = readText(claudeMdPath);
    ok(enabled && enabled.includes("## Analyse first, then wait"), "the section should be written once enabled");
    ok(enabled.includes("BEGIN softela-ai"), "the managed markers should be present while the rulebook contributes text");

    runInstall("claude", []);
    const disabled = readText(claudeMdPath);
    // The base rulebook (`core/installer/rulebook.js`) is generated fresh at
    // plan time on every install, independent of which modules are
    // enabled — its "Authority hierarchy", "Reuse before writing anything
    // new", "What is mechanically enforced" and "Concrete facts" sections
    // always contribute text, so disabling the only module that used to be
    // the sole contributor no longer empties the block.
    ok(disabled && disabled.includes("BEGIN softela-ai"), "the base rulebook still contributes instructions, so the managed block must remain");
    ok(!disabled.includes("Analyse first, then wait"), "the disabled module's own conditional section must not survive in CLAUDE.md");
  });
});
