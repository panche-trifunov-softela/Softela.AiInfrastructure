"use strict";

/**
 * Execution-level regression coverage for the host split in
 * `core/installer/plan.js#pathToken`.
 *
 * A string-shape assertion cannot catch a command line that is
 * syntactically fine yet never runs — that is exactly how the regression
 * this guards against slipped through `tests/installer/command-shape.test.js`:
 * the produced command was well-formed text, it just could not be launched.
 * This suite instead builds the real plan for both hosts, against a scratch
 * agent home, and actually LAUNCHES every produced hook `command` the way
 * that host launches it:
 *
 * - Claude Code hands the whole command string to a POSIX shell — `git
 *   bash` on Windows — run here the same way, through a real POSIX shell
 *   resolved off this machine's own `git` install, never a hardcoded path.
 * - Codex splits the command string on whitespace and spawns the first
 *   token directly, with no shell involved at all — run here the same way,
 *   via `core/lib/shell-parse.js#splitTokens`.
 *
 * Only whether the process actually STARTED is asserted — never the
 * decision a hook script returns. The scratch install root this suite plans
 * against never contains a real `dispatch.js` or module hook script, so a
 * command that starts fine typically still exits non-zero once Node itself
 * reports the script missing; that is a distinct, later-stage outcome and
 * never mistaken here for a start failure.
 */

const fs = require("fs");
const path = require("path");
const { execSync, spawnSync } = require("child_process");
const { suite } = require("../harness");
const { buildPlan } = require("../../core/installer/plan");
const shortPath = require("../../core/lib/short-path");
const { splitTokens } = require("../../core/lib/shell-parse");

const REPO_ROOT = path.join(__dirname, "..", "..");
const MODULES_DIR = path.join(REPO_ROOT, "modules");

/**
 * Bounds every spawned probe process. Real work here finishes in well under
 * a second — a launched hook fails fast on a missing script under the
 * scratch install root this suite uses — so this only guards a genuine
 * hang rather than a slow but legitimate run.
 */
const RUN_TIMEOUT_MS = 5000;

/**
 * Minimal, valid JSON a hook script can read off stdin without blocking or
 * throwing while parsing it. Its field values are never inspected by this
 * suite — only whether the process launched at all is asserted.
 */
const STDIN_PAYLOAD = JSON.stringify({
  hook_event_name: "SessionStart",
  session_id: "command-runs-test",
  cwd: REPO_ROOT,
  source: "startup",
});

/**
 * Loads every real module this repository ships, in the shape
 * `plan.js#planModuleHooks` expects an entry of `ctx.enabledModules` in.
 *
 * @returns {{id: string, dir: string, json: object, promptText: null}[]}
 */
function loadRealModules() {
  const ids = fs.readdirSync(MODULES_DIR).filter((id) => fs.existsSync(path.join(MODULES_DIR, id, "module.json")));
  return ids.map((id) => ({
    id,
    dir: path.join(MODULES_DIR, id),
    json: JSON.parse(fs.readFileSync(path.join(MODULES_DIR, id, "module.json"), "utf8")),
    promptText: null,
  }));
}

/**
 * Loads one adapter's own dispatcher fragment, exactly as
 * `detect.js#gather` locates it.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @returns {object} The parsed fragment.
 */
function loadFragment(agent) {
  const name = agent === "codex" ? "hooks.fragment.json" : "settings.fragment.json";
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "adapters", agent, name), "utf8"));
}

const REAL_MODULES = loadRealModules();

/**
 * Builds a `ctx` for `buildPlan`, real modules and real fragment included,
 * for one host and one `shortPathOptions` shape — nothing here is ever
 * written to disk, so the scratch `home` need not exist.
 *
 * @param {object} params
 * @param {string} params.agent `"claude"` or `"codex"`.
 * @param {string} params.home The agent home to plan against.
 * @param {string} params.nodeExe The `NODE` token's source path.
 * @param {object} [params.shortPathOptions] Threaded straight through to
 * `resolvePathToken` via `plan.js#pathToken` — read only on the Codex path;
 * Claude Code's own tokens never consult it (`plan.js#pathToken` always
 * quotes for that host, unconditionally).
 * @returns {object} A context `buildPlan` accepts.
 */
function buildCtx({ agent, home, nodeExe, shortPathOptions }) {
  const installedRoot = path.join(home, "softela-ai");
  return {
    agent,
    home,
    installedRoot,
    settingsFile: agent === "codex" ? path.join(home, "hooks.json") : path.join(home, "settings.json"),
    manifest: null,
    state: { modules: REAL_MODULES.map((m) => m.id), adapterOptions: {}, options: {} },
    allModules: REAL_MODULES,
    enabledModules: REAL_MODULES,
    files: [],
    settings: { content: {}, parseOk: true, existed: false },
    configToml: null,
    agentsMdTargetPath: path.join(home, agent === "codex" ? "AGENTS.md" : "CLAUDE.md"),
    agentsMdCurrent: null,
    dispatchNeedle: path.join(installedRoot, "adapters", agent, "dispatch.js"),
    nodeExe,
    fragment: loadFragment(agent),
    version: "0.0.0-test",
    now: 1000,
    shortPathOptions,
  };
}

/**
 * Collects every hook `command` string a plan actually produces — the
 * dispatcher's own registration plus every enabled module's.
 *
 * @param {object[]} actions A built plan, as {@link buildPlan} returns.
 * @returns {string[]} Every substituted `command` string.
 */
function collectCommands(actions) {
  const commands = [];
  for (const a of actions) {
    if (a.kind !== "settings" || !a.value || !Array.isArray(a.value.hooks)) continue;
    for (const h of a.value.hooks) {
      if (typeof h.command === "string") commands.push(h.command);
    }
  }
  return commands;
}

/**
 * Resolves a real POSIX shell to run a Claude Code hook `command` through,
 * the same way the host does on Windows — Git for Windows's own
 * `bin\bash.exe`, located off wherever `git` itself resolves on `PATH`,
 * never a hardcoded install path. `git.exe` can sit in any of several
 * layouts inside a Git for Windows install (`mingw64\bin`, `cmd`, …), so
 * every ancestor up to a bounded depth is checked for a sibling
 * `bin\bash.exe`.
 *
 * @returns {string | null} The shell's absolute path, or `null` when none
 * could be resolved on this machine.
 */
function resolvePosixShell() {
  if (process.platform !== "win32") {
    for (const candidate of ["/bin/bash", "/bin/sh", "/usr/bin/bash", "/usr/bin/sh"]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  let listing;
  try {
    listing = execSync("where git", { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return null;
  }

  for (const gitExe of listing.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    let dir = path.dirname(gitExe);
    for (let up = 0; up < 5; up += 1) {
      const bash = path.join(dir, "bin", "bash.exe");
      if (fs.existsSync(bash)) return bash;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/**
 * Resolves a real, space-free Node executable for the Codex-host cases.
 * Codex tokenises its executable position with a plain whitespace split, so
 * a spaced path can never be launched that way no matter what quoting
 * `pathToken` gives it — this suite's Codex commands need a genuinely
 * launchable `NODE` token to prove anything. Falls through the same
 * `queryShortPath` mechanism `resolvePathToken` itself uses, only when
 * `process.execPath` itself carries a space.
 *
 * @returns {string | null} A space-free, real, launchable Node executable
 * path, or `null` when this machine cannot produce one.
 */
function resolveSpaceFreeNodeExe() {
  const execPath = process.execPath;
  if (!/\s/.test(execPath)) return execPath;
  const short = shortPath.queryShortPath(execPath);
  return short && !/\s/.test(short) && fs.existsSync(short) ? short : null;
}

/**
 * Runs one Claude Code hook `command` through a real POSIX shell, exactly
 * as the host does.
 *
 * @param {string} shell The shell's absolute path, from
 * {@link resolvePosixShell}.
 * @param {string} command The substituted hook `command` string.
 * @returns {import("child_process").SpawnSyncReturns<string>} The raw
 * `spawnSync` result.
 */
function runViaShell(shell, command) {
  return spawnSync(shell, ["-c", command], {
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    windowsHide: true,
    input: STDIN_PAYLOAD,
  });
}

/**
 * Runs one Codex hook `command` by splitting it into tokens and spawning
 * the first one directly — no shell at all, exactly as the host does.
 *
 * @param {string} command The substituted hook `command` string.
 * @returns {import("child_process").SpawnSyncReturns<string>} The raw
 * `spawnSync` result.
 */
function runDirect(command) {
  const tokens = splitTokens(command);
  return spawnSync(tokens[0], tokens.slice(1), {
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    windowsHide: true,
    input: STDIN_PAYLOAD,
  });
}

/**
 * Judges whether a spawned process actually started — the only thing this
 * suite asserts on. A hook script that started and then failed on its own
 * logic (a missing dispatch file under a scratch install root, an
 * unhandled exception) is a real, distinct process outcome and never
 * treated as a start failure here.
 *
 * @param {import("child_process").SpawnSyncReturns<string>} result A
 * `spawnSync` result.
 * @returns {{started: boolean, reason: string}} `started` is `false` only
 * for a `spawnSync`-level `error` (the executable itself could not be
 * found or launched — `ENOENT`, most notably) or a POSIX shell's own `127`
 * "command not found" exit; `reason` explains a `false` verdict.
 */
function judgeStarted(result) {
  if (result.error) return { started: false, reason: `spawn error: ${result.error.message}` };
  if (result.status === 127) {
    return { started: false, reason: `shell exit 127 (command not found) — stderr: ${result.stderr}` };
  }
  if (/command not found/i.test(result.stderr || "")) {
    return { started: false, reason: `shell reported "command not found" — stderr: ${result.stderr}` };
  }
  return { started: true, reason: "" };
}

suite("installer/command-runs", ({ test, skip, ok }) => {
  const shell = resolvePosixShell();
  const nodeExe = resolveSpaceFreeNodeExe();

  // Mirrors `command-shape.test.js`'s own two scenarios: a plain, entirely
  // fabricated space-free path (never touches disk), and a spaced path
  // rooted at this file's own directory — guaranteed to exist, unlike a
  // fabricated `C:\...` root — with fake, never-created spaced segments
  // beneath it, paired with an injected `shortPathResolver` so
  // `verifyShortPath` (`core/lib/short-path.js`) checks out against real,
  // on-disk ancestors without depending on this machine's own 8.3 support.
  const scenarios = [
    {
      label: "space-free agent home",
      home: path.join("C:", "Users", "fakehome", ".claude-home"),
      shortPathOptions: { platform: "win32" },
    },
    {
      label: "spaced agent home, short-path resolution succeeds",
      home: path.join(__dirname, "fake home", ".claude-home"),
      shortPathOptions: {
        platform: "win32",
        shortPathResolver: (absPath) => absPath.replace("fake home", "FAKEHO~1"),
      },
    },
  ];

  for (const scenario of scenarios) {
    if (shell) {
      const ctx = buildCtx({
        agent: "claude",
        home: scenario.home,
        nodeExe: process.execPath,
        shortPathOptions: scenario.shortPathOptions,
      });
      const commands = collectCommands(buildPlan(ctx));

      test(`claude, ${scenario.label}: at least one hook command is produced`, () => {
        ok(commands.length > 0, "expected at least one hook command");
      });

      for (const command of commands) {
        test(`claude, ${scenario.label}: "${command}" actually starts under a POSIX shell`, () => {
          const verdict = judgeStarted(runViaShell(shell, command));
          ok(verdict.started, `${verdict.reason} — command: ${command}`);
        });
      }
    } else {
      skip(`claude, ${scenario.label}: hook commands actually start`, "no POSIX shell (git bash) could be resolved on this machine");
    }

    if (nodeExe) {
      const ctx = buildCtx({
        agent: "codex",
        home: scenario.home,
        nodeExe,
        shortPathOptions: scenario.shortPathOptions,
      });
      const commands = collectCommands(buildPlan(ctx));

      test(`codex, ${scenario.label}: at least one hook command is produced`, () => {
        ok(commands.length > 0, "expected at least one hook command");
      });

      for (const command of commands) {
        test(`codex, ${scenario.label}: "${command}" actually starts spawned directly`, () => {
          const verdict = judgeStarted(runDirect(command));
          ok(verdict.started, `${verdict.reason} — command: ${command}`);
        });
      }
    } else {
      skip(
        `codex, ${scenario.label}: hook commands actually start`,
        "this machine's Node executable carries a space in its path and no verified 8.3 short form could be produced for it",
      );
    }
  }
});
