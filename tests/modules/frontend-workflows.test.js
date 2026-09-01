"use strict";

/**
 * `frontend-workflows` — three procedures, six documents, no code.
 *
 * The module ships nothing executable, so what is worth testing is not
 * behaviour but the two properties that would silently break it: that every
 * declared command file exists and lands where its host actually looks for
 * it, and that the two hosts' copies of one procedure have not drifted apart
 * into two different workflows.
 */

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");
const { readText } = require("../../core/lib/fs-safe");
const { loadModule, validateModuleJson, runInstall, snapshotAgentHome, paths } = require("./_helpers");

const MODULE_ID = "frontend-workflows";

/** The three workflows, each shipped once per host. */
const WORKFLOWS = ["new-component", "split-component", "new-endpoint"];

/**
 * Reads one shipped asset.
 *
 * @param {{dir: string}} mod The loaded module.
 * @param {string} name The asset's file name under `assets/`.
 * @returns {string | null} The file's content, or `null` when absent.
 */
function asset(mod, name) {
  return readText(path.join(mod.dir, "assets", name));
}

/**
 * Splits a command or skill document into its front matter and its body.
 *
 * @param {string} text The whole document.
 * @returns {{front: string, body: string}} The front matter (without its
 * fences) and everything after it; `front` is `""` when there is none.
 */
function splitFrontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  return m ? { front: m[1], body: m[2] } : { front: "", body: text };
}

/**
 * Reduces a document body to the sequence of its own headings, which is the
 * part of a procedure that has to match across hosts — the prose around them
 * may legitimately differ by a word.
 *
 * @param {string} body The document body.
 * @returns {string[]} Every `##` heading, in order.
 */
function headings(body) {
  return body
    .split("\n")
    .filter((line) => /^##\s/.test(line))
    .map((line) => line.trim());
}

suite("modules/frontend-workflows", ({ test, eq, deepEq, ok, fakeHome }) => {
  const mod = loadModule(MODULE_ID);

  test("module.json validates against the shape MODULES.md documents", () => {
    deepEq(validateModuleJson(mod), []);
  });

  test("it ships documents only — no guard, no hook, no setting, no option, no prompt block", () => {
    eq(mod.json.prompt, undefined);
    eq(mod.json.guards.length, 0);
    eq(mod.json.files.length, 0);
    eq(mod.json.hooks.length, 0);
    eq(mod.json.settings.length, 0);
    deepEq(mod.json.options, {});
  });

  test("defaults on, per its own README", () => {
    eq(mod.json.defaultEnabled, true);
  });

  test("every workflow ships for both hosts, and nothing else does", () => {
    const declared = mod.json.commands.map((c) => `${c.agent}:${c.from}`).sort();
    const expected = WORKFLOWS.flatMap((w) => [
      `claude:assets/${w}.command.md`,
      `codex:assets/${w}.skill.md`,
    ]).sort();
    deepEq(declared, expected);
  });

  test("every declared command file exists on disk", () => {
    for (const c of mod.json.commands) {
      ok(readText(path.join(mod.dir, c.from)) !== null, `${c.from} must be a readable file`);
    }
  });

  // A command placed anywhere else is simply never found by its host — see
  // MODULES.md on `commands` being resolved against the agent home.
  test("each command lands at the fixed location its own host discovers", () => {
    for (const c of mod.json.commands) {
      const workflow = path.basename(c.from).split(".")[0];
      const expected = c.agent === "claude" ? `commands/${workflow}.md` : `skills/${workflow}/SKILL.md`;
      eq(c.to, expected, `${c.agent} command "${workflow}" must install to ${expected}`);
    }
  });

  test("a Claude command carries the front matter that host reads, and takes the developer's own arguments", () => {
    for (const workflow of WORKFLOWS) {
      const text = asset(mod, `${workflow}.command.md`);
      const { front, body } = splitFrontMatter(text);
      ok(/^description:\s*\S/m.test(front), `${workflow}: a Claude command needs a description`);
      ok(/^argument-hint:\s*\S/m.test(front), `${workflow}: a Claude command needs an argument-hint`);
      ok(/^allowed-tools:\s*\S/m.test(front), `${workflow}: a Claude command needs allowed-tools`);
      ok(body.includes("$ARGUMENTS"), `${workflow}: the developer's own detail must reach the procedure`);
    }
  });

  test("a Codex skill's description says when to use it and when not to — that description is what decides whether it loads", () => {
    for (const workflow of WORKFLOWS) {
      const { front, body } = splitFrontMatter(asset(mod, `${workflow}.skill.md`));
      ok(new RegExp(`^name:\\s*"${workflow}"$`, "m").test(front), `${workflow}: name must match the skill directory`);
      const description = /^description:\s*"([\s\S]*?)"\s*$/m.exec(front);
      ok(description, `${workflow}: a Codex skill needs a quoted description`);
      ok(/\bUse when\b/.test(description[1]), `${workflow}: the description must say when to use it`);
      ok(/\bDo not use it\b/.test(description[1]), `${workflow}: the description must say when NOT to use it`);
      ok(!body.includes("$ARGUMENTS"), `${workflow}: $ARGUMENTS is a Claude Code form and means nothing on Codex`);
    }
  });

  // The two hosts get two documents because their front matter differs, not
  // because the procedure does. A workflow that differs by host is a
  // workflow nobody can rely on.
  test("both hosts' copies of a workflow are the same procedure, step for step", () => {
    for (const workflow of WORKFLOWS) {
      const command = splitFrontMatter(asset(mod, `${workflow}.command.md`));
      const skill = splitFrontMatter(asset(mod, `${workflow}.skill.md`));
      deepEq(
        headings(skill.body),
        headings(command.body),
        `${workflow}: the Claude command and the Codex skill must carry the same steps`,
      );
    }
  });

  test("every procedure points at the standard it implements rather than restating it", () => {
    for (const workflow of WORKFLOWS) {
      for (const suffix of ["command", "skill"]) {
        const text = asset(mod, `${workflow}.${suffix}.md`);
        ok(
          /docs\/standards\/[a-z-]+\.md/.test(text),
          `${workflow}.${suffix}: must cite at least one standard document`,
        );
      }
    }
  });

  // The whole reason these are procedures and not prompt text: each one
  // front-loads the judgement call no guard can make.
  test("every procedure ends by asking for a report, including what could not be found", () => {
    for (const workflow of WORKFLOWS) {
      for (const suffix of ["command", "skill"]) {
        const text = asset(mod, `${workflow}.${suffix}.md`);
        ok(/^##\s.*Report\s*$/m.test(text), `${workflow}.${suffix}: must end with a report step`);
      }
    }
  });

  test("enabling then disabling leaves the agent home exactly as it was", () => {
    fakeHome();
    runInstall("claude", []);
    const baseline = snapshotAgentHome("claude");

    runInstall("claude", [MODULE_ID]);
    const enabled = snapshotAgentHome("claude");
    ok(
      Object.keys(enabled.files).some((f) => f.includes(`modules/${MODULE_ID}/`)),
      "the module's own catalogue copy should be installed while it is enabled",
    );

    runInstall("claude", []);
    const after = snapshotAgentHome("claude");
    deepEq(after.files, baseline.files);
    deepEq(after.settingsHooks, baseline.settingsHooks);
    eq(after.globalInstructions, baseline.globalInstructions);
  });

  test("enabling puts each host's commands where that host looks, and disabling takes them away again", () => {
    for (const [agent, relativePath] of [
      ["claude", (w) => path.join("commands", `${w}.md`)],
      ["codex", (w) => path.join("skills", w, "SKILL.md")],
    ]) {
      fakeHome();
      runInstall(agent, [MODULE_ID]);
      for (const workflow of WORKFLOWS) {
        const installed = path.join(paths.agentHome(agent), relativePath(workflow));
        ok(fs.existsSync(installed), `${agent}: ${workflow} should be installed at ${relativePath(workflow)}`);
      }

      runInstall(agent, []);
      for (const workflow of WORKFLOWS) {
        const installed = path.join(paths.agentHome(agent), relativePath(workflow));
        ok(!fs.existsSync(installed), `${agent}: ${workflow} should be gone once the module is disabled`);
      }
    }
  });
});
