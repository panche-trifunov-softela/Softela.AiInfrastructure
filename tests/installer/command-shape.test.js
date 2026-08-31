"use strict";

/**
 * Regression coverage for the hook `command` shape `plan.js#baseVars`
 * relies on. `plan.js#pathToken` is host-aware, because the two hosts launch
 * a hook command in opposite ways, measured against both real binaries:
 *
 * - Claude Code hands the whole command string to a POSIX shell
 *   (`/usr/bin/bash` on Windows), which treats a bare backslash as an escape
 *   character and destroys an unquoted Windows path — so every path-valued
 *   token is always quoted there, via `core/lib/short-path.js#quotePath`,
 *   regardless of whether it carries a space.
 * - Codex spawns argv[0] directly, with no shell, splitting the command on
 *   whitespace — a quoted executable path is taken completely literally,
 *   quote characters included, and never starts; only a bare, space-free
 *   token works there. `core/lib/short-path.js#resolvePathToken` supplies a
 *   bare token when one can be produced and verified, falling back to a
 *   quoted one otherwise.
 *
 * Either way, no template — an adapter fragment or a module's own
 * `hooks[].command` — may wrap `{{NODE}}`, `{{DISPATCH}}`, `{{INSTALLED}}`
 * or `{{AGENT_HOME}}` in literal quotes of its own; `pathToken` always
 * supplies whatever quoting its own host needs. A template that still does
 * produces a doubled quote for Claude Code, or an executable token broken
 * by an unquoted embedded space for Codex, exactly the drift that forces
 * Codex hook re-approval (docs/internal/INSTALLER.md §5).
 *
 * `buildPlan` is driven for real, against every module this repository
 * ships plus both adapters' own dispatcher fragment, for both hosts, and
 * against two `shortPathOptions` shapes (`plan.js#pathToken`'s injection
 * point, which only affects Codex — Claude Code's own token never consults
 * it) so the space-containing case is exercised without depending on this
 * machine's own volume settings.
 */

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");
const { buildPlan } = require("../../core/installer/plan");

const REPO_ROOT = path.join(__dirname, "..", "..");
const MODULES_DIR = path.join(REPO_ROOT, "modules");

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
const CLAUDE_PATH_VALUED_FLAGS = collectClaudePathValuedFlags(REAL_MODULES);

/**
 * Builds a `ctx` for `buildPlan`, real modules and real fragment included,
 * for one host and one `shortPathOptions` shape.
 *
 * @param {object} params
 * @param {string} params.agent `"claude"` or `"codex"`.
 * @param {string} params.home The agent home to plan against — deliberately
 * fake and never touched on disk, since `buildPlan` is pure.
 * @param {string} params.nodeExe The `NODE` token's source path.
 * @param {object} [params.shortPathOptions] Threaded straight through to
 * `resolvePathToken` via `plan.js#pathToken`.
 * @param {object} [params.moduleOptions] `state.options`, keyed by module id
 * — lets a case drive `reply-language`'s `languages` option to a
 * space-containing, multi-value list.
 * @returns {object} A context `buildPlan` accepts.
 */
function buildCtx({ agent, home, nodeExe, shortPathOptions, moduleOptions }) {
  const installedRoot = path.join(home, "softela-ai");
  return {
    agent,
    home,
    installedRoot,
    settingsFile: agent === "codex" ? path.join(home, "hooks.json") : path.join(home, "settings.json"),
    manifest: null,
    state: { modules: REAL_MODULES.map((m) => m.id), adapterOptions: {}, options: moduleOptions || {} },
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
 * The naive split Codex itself uses to find the executable token: the whole
 * command line, cut at its first run of whitespace.
 *
 * @param {string} command A hook `command` string.
 * @returns {string} The would-be executable token.
 */
function firstToken(command) {
  return command.trim().split(/\s+/, 1)[0];
}

/**
 * Finds the index of the first backslash in `command` that sits outside a
 * double-quoted span, walking the string left to right and flipping an
 * "inside quotes" flag on every `"`. Claude Code hands the whole command to
 * a POSIX shell, where a backslash outside quotes is an escape character
 * that corrupts a Windows path — `plan.js#pathToken` always quotes a
 * path-valued token for Claude Code for exactly this reason, so a genuine
 * backslash should never appear unquoted in a command this suite produces.
 *
 * @param {string} command A hook `command` string.
 * @returns {number} The offending index, or `-1` when every backslash sits
 * inside a quoted span (or the command carries none at all).
 */
function firstUnquotedBackslashIndex(command) {
  let inQuotes = false;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (c === "\\" && !inQuotes) return i;
  }
  return -1;
}

/**
 * Flags whose value may legitimately still carry its own literal quotes —
 * a free-text, developer-supplied option value (`reply-language`'s
 * `languages`) that can contain a space, never resolved through a path
 * token and so quoted only by the template's own literal quotes, on either
 * host. Every other `--flag="..."` shape produced for Codex is the bug this
 * suite guards against; for Claude Code, a flag whose raw template assigns
 * a path-valued token (`{{AGENT_HOME}}` or `{{INSTALLED}}`) directly after
 * `=` is also expected to carry quotes there — `plan.js#pathToken` always
 * quotes those two tokens for that host, so the quotes such a flag carries
 * are the token's own, not a template bug.
 */
const DEVELOPER_TEXT_FLAGS_ALLOWED_A_QUOTED_VALUE = new Set(["--languages"]);

/**
 * Scans every real module's raw (unsubstituted) hook command templates for
 * a flag assigning `{{AGENT_HOME}}` or `{{INSTALLED}}` directly after `=` —
 * computed from the shipped templates rather than hand-listed, so a new
 * module using this shape needs no update here.
 *
 * @param {{json: object}[]} modules Loaded modules, as {@link loadRealModules}
 * returns.
 * @returns {Set<string>} Every such flag, e.g. `"--agent-home"`.
 */
function collectClaudePathValuedFlags(modules) {
  const flags = new Set();
  const re = /--([\w-]+)=\{\{(AGENT_HOME|INSTALLED)\}\}/g;
  for (const mod of modules) {
    for (const rawEntry of Array.isArray(mod.json.hooks) ? mod.json.hooks : []) {
      const cmd = String(rawEntry.command || "");
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(cmd))) flags.add(`--${m[1]}`);
    }
  }
  return flags;
}

suite("installer/command-shape", ({ test, eq, ok }) => {
  const scenarios = [
    {
      label: "space-free agent home",
      home: path.join("C:", "Users", "fakehome", ".claude-home"),
      nodeExe: path.join("C:", "nodejs", "node.exe"),
      shortPathOptions: { platform: "win32" },
    },
    {
      label: "spaced agent home, short-path resolution succeeds",
      // Rooted at this test file's own directory — guaranteed to exist,
      // unlike a fabricated `C:\...` path — with fake, never-created
      // spaced segments beneath it. `verifyShortPath` walks up to the
      // nearest existing ancestor and checks the same ancestor portion of
      // the resolved short form; the resolver below leaves that ancestor
      // prefix untouched, so verification passes without depending on this
      // machine's own volume settings or its 8.3 short-name support.
      home: path.join(__dirname, "fake home", ".claude-home"),
      nodeExe: path.join(__dirname, "fake node dir", "node.exe"),
      shortPathOptions: {
        platform: "win32",
        shortPathResolver: (absPath) =>
          absPath.replace("fake home", "FAKEHO~1").replace("fake node dir", "FAKENO~1"),
      },
    },
  ];

  for (const scenario of scenarios) {
    for (const agent of ["claude", "codex"]) {
      const ctx = buildCtx({ agent, home: scenario.home, nodeExe: scenario.nodeExe, shortPathOptions: scenario.shortPathOptions });
      const actions = buildPlan(ctx);
      const commands = collectCommands(actions);

      test(`${agent}, ${scenario.label}: at least one hook command is produced`, () => {
        ok(commands.length > 0, `expected at least one hook command for ${agent} / ${scenario.label}`);
      });

      for (const command of commands) {
        if (agent === "codex") {
          test(`${agent}, ${scenario.label}: "${command}" starts with a bare, unquoted executable token`, () => {
            const token = firstToken(command);
            ok(!token.includes('"'), `executable token "${token}" carries a quote character — command: ${command}`);
            ok(!/\s/.test(token), `executable token "${token}" carries whitespace — command: ${command}`);
          });
        } else {
          test(`${agent}, ${scenario.label}: "${command}" quotes every path-valued token, so it survives the POSIX shell Claude Code runs it through`, () => {
            ok(command.startsWith('"'), `expected the executable token to be quoted for Claude Code — command: ${command}`);
            const badIndex = firstUnquotedBackslashIndex(command);
            ok(
              badIndex === -1,
              `backslash at index ${badIndex} sits outside a quoted span — a POSIX shell would treat it as an escape and corrupt the path — command: ${command}`,
            );
          });
        }

        test(`${agent}, ${scenario.label}: "${command}" carries no doubled quote sequence`, () => {
          ok(!command.includes('""'), `command carries a doubled quote: ${command}`);
        });

        test(`${agent}, ${scenario.label}: "${command}" quotes a value after "=" only where the value needs it`, () => {
          const re = /(--[\w-]+)="/g;
          let m;
          while ((m = re.exec(command))) {
            const allowed =
              DEVELOPER_TEXT_FLAGS_ALLOWED_A_QUOTED_VALUE.has(m[1]) || (agent === "claude" && CLAUDE_PATH_VALUED_FLAGS.has(m[1]));
            ok(allowed, `flag "${m[1]}" carries a quoted value it does not need — command: ${command}`);
          }
        });
      }
    }
  }

  test("reply-language's --languages flag stays quoted when the option value itself carries a space", () => {
    const ctx = buildCtx({
      agent: "claude",
      home: path.join("C:", "Users", "fakehome", ".claude-home"),
      nodeExe: path.join("C:", "nodejs", "node.exe"),
      shortPathOptions: { platform: "win32" },
      moduleOptions: { "reply-language": { languages: ["English", "French"] } },
    });
    const commands = collectCommands(buildPlan(ctx));
    const languagesCommand = commands.find((c) => c.includes("validate-languages.js"));
    ok(languagesCommand, "expected a validate-languages.js hook command");
    ok(languagesCommand.includes('--languages="English, French"'), `expected the space-containing value to stay quoted: ${languagesCommand}`);
  });

  test("every real module's command template avoids literal quotes around a path-valued token", () => {
    // A direct check on the shipped template source, independent of
    // substitution: `{{INSTALLED}}` and `{{AGENT_HOME}}` are the two
    // path-valued tokens a module template can reference, and neither may
    // ever appear with a literal quote immediately touching it, since
    // `resolvePathToken` supplies its own quoting exactly when needed.
    for (const mod of REAL_MODULES) {
      for (const rawEntry of Array.isArray(mod.json.hooks) ? mod.json.hooks : []) {
        const cmd = String(rawEntry.command || "");
        eq(/"\{\{(INSTALLED|AGENT_HOME)\}\}/.test(cmd), false, `${mod.id}'s "${cmd}" opens a literal quote right before a path token`);
        eq(/\{\{(INSTALLED|AGENT_HOME)\}\}"/.test(cmd), false, `${mod.id}'s "${cmd}" closes a literal quote right after a path token`);
      }
    }
  });
});
