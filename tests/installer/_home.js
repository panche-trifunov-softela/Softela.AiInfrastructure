"use strict";

/**
 * Shared fixture for `tests/installer/*`.
 *
 * Every installer test starts from a machine that already has a life of its
 * own — a developer's own hooks, skills, settings and memory — never from an
 * empty directory, because "preserve what we do not own" is only provable
 * against content that was already there. This module builds that starting
 * point and drives the real CLI (`bin/softela-ai`) as a subprocess, exactly as a
 * developer would, so the installer's own `index.js` never needs to be
 * imported or modified to make its commands reachable from a test.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { readText, readJson, writeTextAtomic, writeJsonAtomic, ensureDir, listFilesRecursive, copyFileSafe } = require("../../core/lib/fs-safe");

/** This repository's own root, resolved the same way `paths.js#repoRoot` resolves it. */
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** The CLI entry point under test, run exactly as a developer would run it. */
const CLI_PATH = path.join(REPO_ROOT, "bin", "softela-ai");

/** Content of a hook the developer wrote long before ever installing softela-ai. */
const FOREIGN_HOOK_CONTENT = "#!/usr/bin/env node\n// the developer's own pre-existing hook\nconsole.log(\"team-lint-check\");\n";

/** Content of a skill the developer authored themselves. */
const FOREIGN_SKILL_CONTENT = "# Team skill\n\nA skill this developer wrote before softela-ai ever ran here.\n";

/** Content of a memory file already living on this machine before install. */
const FOREIGN_MEMORY_CONTENT = "## INTENT — pre-existing\n\nThis memory predates softela-ai and must survive every install.\n";

/**
 * Runs the CLI under test as a subprocess, against a fake home.
 *
 * @param {string} home The fake home root (what `SOFTELA_AI_HOME` should point
 * at); usually a value obtained from the test harness's `fakeHome()`.
 * @param {string[]} args The CLI arguments, e.g. `["install", "--yes"]`.
 * @param {{cliPath?: string, env?: object, input?: string}} [options]
 * `cliPath` overrides which `bin/softela-ai` is run — used to drive an installed
 * copy after the source clone has been deleted; `env` adds or overrides
 * environment variables for this one call; `input`, when given, is written
 * to the child's stdin (still a pipe, never a real terminal — see
 * `interactive-options.test.js` for how a test drives the installer's
 * interactive prompting despite that).
 * @returns {{code: number, stdout: string, stderr: string}} The process's
 * exit code and captured output.
 */
function runCli(home, args, options = {}) {
  const result = spawnSync(process.execPath, [options.cliPath || CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, SOFTELA_AI_HOME: home, ...(options.env || {}) },
    input: options.input,
    encoding: "utf8",
    timeout: 30000,
  });
  return { code: result.status === null ? -1 : result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

/**
 * Copies the subset of this repository the installer actually reads —
 * everything `detect.js` walks, plus `bin/softela-ai` and `package.json` — into
 * a fresh location, so a test can install from a clone and then delete it.
 *
 * @param {string} destDir An empty or non-existent directory to copy into.
 * @returns {void}
 */
function copyRepoSubset(destDir) {
  for (const dir of ["core", "adapters", "projects", "docs", "modules", "templates", "bin"]) {
    const srcDir = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(srcDir)) continue;
    for (const rel of listFilesRecursive(srcDir)) {
      copyFileSafe(path.join(srcDir, rel), path.join(destDir, dir, rel));
    }
  }
  copyFileSafe(path.join(REPO_ROOT, "package.json"), path.join(destDir, "package.json"));
}

/**
 * Seeds a fake agent home with content that predates softela-ai: a hook, a
 * skill, a memory file, and the host's own settings file, already carrying
 * entries and preferences of the developer's own.
 *
 * @param {string} home The fake home root.
 * @param {"claude" | "codex"} agent Which host's home to seed.
 * @returns {object} Every path written, and the exact content written at
 * each — so a test can assert byte-for-byte survival later without
 * duplicating the fixture's own literals.
 */
function seedForeign(home, agent) {
  const agentDir = path.join(home, agent === "codex" ? ".codex" : ".claude");
  ensureDir(agentDir);

  const foreignHookPath = path.join(agentDir, "hooks", "team-lint-check.js");
  writeTextAtomic(foreignHookPath, FOREIGN_HOOK_CONTENT);

  const skillPath = path.join(agentDir, "skills", "team-skill", "SKILL.md");
  writeTextAtomic(skillPath, FOREIGN_SKILL_CONTENT);

  const memoryPath = path.join(agentDir, "memory", "MEMORY.md");
  writeTextAtomic(memoryPath, FOREIGN_MEMORY_CONTENT);

  const result = { agentDir, foreignHookPath, foreignHookContent: FOREIGN_HOOK_CONTENT, skillPath, skillContent: FOREIGN_SKILL_CONTENT, memoryPath, memoryContent: FOREIGN_MEMORY_CONTENT };

  if (agent === "codex") {
    result.settingsPath = path.join(agentDir, "hooks.json");
    result.settingsBefore = {
      hooks: {
        SessionStart: [{ matcher: null, hooks: [{ type: "command", command: "node /home/dev/own-session-hook.js" }] }],
      },
    };
    writeJsonAtomic(result.settingsPath, result.settingsBefore);

    result.configPath = path.join(agentDir, "config.toml");
    result.configBefore = [
      "# personal config, hand maintained — must survive verbatim",
      'model_provider = "custom-provider"',
      "",
      "# already running a model of their own, and one that carries none of the",
      "# sol/terra/luna tier tokens — both a value install must leave alone and a",
      "# value doctor's tier check must report as unrecognised.",
      'model = "gpt-6-titan"',
      "",
      "# and a lower reasoning effort than the shipped default",
      'model_reasoning_effort = "low"',
      "",
      "[sandbox]",
      'mode = "workspace-write"',
      "",
    ].join("\n");
    writeTextAtomic(result.configPath, result.configBefore);

    result.agentsMdPath = path.join(agentDir, "AGENTS.md");
    result.agentsMdBefore = "# My own Codex notes\n\nPredates softela-ai.\n";
    writeTextAtomic(result.agentsMdPath, result.agentsMdBefore);
  } else {
    result.settingsPath = path.join(agentDir, "settings.json");
    result.settingsBefore = {
      model: "opus-4-custom",
      hooks: {
        PreToolUse: [{ matcher: "SomeOtherTool", hooks: [{ type: "command", command: "node /home/dev/own-hook.js" }] }],
      },
      permissions: { allow: ["Bash(ls:*)"] },
    };
    writeJsonAtomic(result.settingsPath, result.settingsBefore);

    result.claudeMdPath = path.join(agentDir, "CLAUDE.md");
    result.claudeMdBefore = "# My personal instructions\n\nAlways answer in German.\n";
    writeTextAtomic(result.claudeMdPath, result.claudeMdBefore);
  }

  return result;
}

/**
 * Seeds a fake agent home with a hook registration whose command points at
 * a script living under the agent's own home directory — the shape
 * `core/installer/conflicts.js#detectConflicts` flags as a conflict, unlike
 * {@link seedForeign}'s own hook, which deliberately points outside the
 * agent home and must never be flagged as one.
 *
 * @param {string} home The fake home root.
 * @param {"claude" | "codex"} agent Which host's home to seed.
 * @param {{event?: string, matcher?: *, relScriptPath?: string}} [options]
 * `event` defaults to `"PreToolUse"`; `matcher` defaults to a value that
 * does not collide with softela-ai's own dispatcher matcher (`null` for Codex,
 * a distinct string for Claude); `relScriptPath` defaults to
 * `"hooks/mine.js"`, resolved under the agent home.
 * @returns {{scriptPath: string, command: string, event: string, matcher: *}}
 * What was written, so a test can assert against it without duplicating the
 * fixture's own literals.
 */
function seedForeignHookUnderHome(home, agent, options = {}) {
  const agentDir = agentHomePath(home, agent);
  const event = options.event || "PreToolUse";
  const relScriptPath = options.relScriptPath || "hooks/mine.js";
  const scriptPath = path.join(agentDir, relScriptPath);
  writeTextAtomic(
    scriptPath,
    '#!/usr/bin/env node\n// the developer\'s own local hook, registered under the agent home\nconsole.log("local-hook");\n',
  );

  const settingsPath = agent === "codex" ? path.join(agentDir, "hooks.json") : path.join(agentDir, "settings.json");
  const existing = readJson(settingsPath) || {};
  const matcher = options.matcher !== undefined ? options.matcher : agent === "codex" ? null : "SomeLocalMatcher";
  const command = `node "${scriptPath}"`;
  if (!existing.hooks || typeof existing.hooks !== "object") existing.hooks = {};
  if (!Array.isArray(existing.hooks[event])) existing.hooks[event] = [];
  existing.hooks[event].push({ matcher, hooks: [{ type: "command", command }] });
  writeJsonAtomic(settingsPath, existing);

  return { scriptPath, command, event, matcher };
}

/**
 * Resolves an agent's home directory under a fake home root.
 *
 * @param {string} home The fake home root.
 * @param {"claude" | "codex"} agent The agent.
 * @returns {string} `<home>/.claude` or `<home>/.codex`.
 */
function agentHomePath(home, agent) {
  return path.join(home, agent === "codex" ? ".codex" : ".claude");
}

/**
 * Resolves the installed payload root for an agent under a fake home.
 *
 * @param {string} home The fake home root.
 * @param {"claude" | "codex"} agent The agent.
 * @returns {string} `<agentHome>/softela-ai`.
 */
function installedRootPath(home, agent) {
  return path.join(agentHomePath(home, agent), "softela-ai");
}

/**
 * Reads the installer's own manifest for an agent under a fake home.
 *
 * @param {string} home The fake home root.
 * @param {"claude" | "codex"} agent The agent.
 * @returns {object | null} The parsed manifest, or `null` when absent.
 */
function readManifest(home, agent) {
  return readJson(path.join(agentHomePath(home, agent), ".softela-ai", "manifest.json"));
}

/**
 * Reads the installer's own local state for an agent under a fake home.
 *
 * @param {string} home The fake home root.
 * @param {"claude" | "codex"} agent The agent.
 * @returns {object | null} The parsed state, or `null` when absent.
 */
function readState(home, agent) {
  return readJson(path.join(agentHomePath(home, agent), ".softela-ai", "state.json"));
}

/**
 * Reads an agent's host settings file (`settings.json` for Claude Code,
 * `hooks.json` for Codex) under a fake home.
 *
 * @param {string} home The fake home root.
 * @param {"claude" | "codex"} agent The agent.
 * @returns {object | null} The parsed content, or `null` when absent or
 * unparseable.
 */
function readSettingsJson(home, agent) {
  const file = agent === "codex" ? "hooks.json" : "settings.json";
  return readJson(path.join(agentHomePath(home, agent), file));
}

/**
 * Lists every entry that carries a given needle inside its `command` string,
 * across every event of a settings/hooks object — used to assert a
 * dispatcher registration is, or is no longer, present.
 *
 * @param {object | null} settingsObj A parsed settings/hooks object.
 * @param {string} needle The substring to search each entry's command for.
 * @returns {{event: string, index: number}[]} One entry per match.
 */
function findHookEntries(settingsObj, needle) {
  const out = [];
  const hooks = settingsObj && settingsObj.hooks && typeof settingsObj.hooks === "object" ? settingsObj.hooks : {};
  for (const [event, arr] of Object.entries(hooks)) {
    if (!Array.isArray(arr)) continue;
    arr.forEach((entry, index) => {
      const matches = entry && Array.isArray(entry.hooks) && entry.hooks.some((h) => h && typeof h.command === "string" && h.command.includes(needle));
      if (matches) out.push({ event, index });
    });
  }
  return out;
}

/**
 * Lists every backup timestamp directory recorded for an agent.
 *
 * @param {string} home The fake home root.
 * @param {"claude" | "codex"} agent The agent.
 * @returns {string[]} Absolute paths to each `<timestamp>` directory under
 * `.softela-ai/backups/`; an empty array when none exist.
 */
function listBackupDirs(home, agent) {
  const root = path.join(agentHomePath(home, agent), ".softela-ai", "backups");
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

module.exports = {
  REPO_ROOT,
  CLI_PATH,
  runCli,
  copyRepoSubset,
  seedForeign,
  seedForeignHookUnderHome,
  agentHomePath,
  installedRootPath,
  readManifest,
  readState,
  readSettingsJson,
  findHookEntries,
  listBackupDirs,
  readText,
  readJson,
};
