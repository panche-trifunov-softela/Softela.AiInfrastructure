"use strict";

/**
 * Proves two properties that no other suite in `tests/modules/` checks,
 * because every other suite runs a module's hook straight from its
 * repository path (`HOOK_SCRIPT` built from `paths.repoRoot()`), where a
 * `require("../../../core/lib/x")`-style path resolves whether or not it
 * would also resolve once installed.
 *
 * 1. Every hook a module registers still runs once laid out the way the
 *    real installer lays it out — every module's `files[]` copied flat into
 *    one shared `<agentHome>/softela-ai/hooks/` directory
 *    (`core/installer/detect.js`'s `listShippedFiles`), one level above
 *    `<agentHome>/softela-ai/core/`, not three levels below it as inside this
 *    repository. A hook that requires `core/lib` with a repository-relative
 *    path crashes with `MODULE_NOT_FOUND` on every real invocation while
 *    still passing every other suite.
 * 2. No two modules ship a hook file that installs to the same basename
 *    under that shared flat directory — a collision would silently
 *    overwrite one module's file with another's.
 *
 * Both properties are derived from the modules' own `module.json`
 * declarations rather than a hard-coded list, so a module added later is
 * covered the day it ships.
 */

const path = require("path");
const { execSync } = require("child_process");
const { suite } = require("../harness");
const { readJson } = require("../../core/lib/fs-safe");
const { allModuleIds, loadModule, runInstall, paths } = require("./_helpers");

/** Both hosts this repository installs onto. */
const AGENTS = ["claude", "codex"];

/**
 * Builds a realistic stdin payload for one hook event.
 *
 * Coverage here does not depend on any one hook reading every field below —
 * it only has to survive `require`-time module resolution and, if it does
 * produce output, produce valid JSON. A generic, plausible payload per event
 * keeps a hook added on a known event covered automatically; an event not
 * listed here falls back to the `default` shape.
 */
const PAYLOAD_BY_EVENT = {
  UserPromptSubmit: (cwd) => ({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd, prompt: "test prompt" }),
  SessionStart: (cwd) => ({ hook_event_name: "SessionStart", session_id: "s1", cwd, source: "startup" }),
  PostCompact: (cwd) => ({ hook_event_name: "PostCompact", session_id: "s1", cwd }),
  PreCompact: (cwd) => ({ hook_event_name: "PreCompact", session_id: "s1", cwd, trigger: "manual" }),
  PreToolUse: (cwd) => ({
    hook_event_name: "PreToolUse",
    session_id: "s1",
    cwd,
    tool_name: "Write",
    tool_input: { file_path: path.join(cwd, "file.txt"), content: "hello" },
  }),
  PostToolUse: (cwd) => ({
    hook_event_name: "PostToolUse",
    session_id: "s1",
    cwd,
    tool_name: "Write",
    tool_input: { file_path: path.join(cwd, "file.txt"), content: "hello" },
    tool_response: { success: true },
  }),
  default: (cwd, event) => ({ hook_event_name: event, session_id: "s1", cwd, prompt: "test prompt" }),
};

/**
 * Builds the payload for one event, falling back to a generic shape for an
 * event this file does not special-case.
 *
 * @param {string} event The hook event name.
 * @param {string} cwd The working directory to embed in the payload.
 * @returns {object} The JSON payload to write to the hook's stdin.
 */
function payloadFor(event, cwd) {
  const build = PAYLOAD_BY_EVENT[event] || PAYLOAD_BY_EVENT.default;
  return build(cwd, event);
}

/**
 * Reads back the real, fully-substituted hook registrations an install just
 * wrote, grouped by event — the same shape for both hosts
 * (`{ hooks: { <event>: [{ matcher, hooks: [{ command }] }] } }`).
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @returns {Record<string, string[]>} Every registered command string,
 * keyed by event name.
 */
function readRegisteredCommands(agent) {
  const home = paths.agentHome(agent);
  const settingsFile = path.join(home, agent === "codex" ? "hooks.json" : "settings.json");
  const settings = readJson(settingsFile) || {};
  const byEvent = {};
  for (const [event, matchers] of Object.entries(settings.hooks || {})) {
    byEvent[event] = [];
    for (const matcherEntry of Array.isArray(matchers) ? matchers : []) {
      for (const h of Array.isArray(matcherEntry.hooks) ? matcherEntry.hooks : []) {
        if (typeof h.command === "string") byEvent[event].push(h.command);
      }
    }
  }
  return byEvent;
}

/**
 * Extracts a hook script's installed basename from its `module.json`
 * command template, e.g. `"{{NODE}} {{INSTALLED}}/hooks/foo.js --x"` yields
 * `"foo.js"`.
 *
 * @param {string} command The unsubstituted command template.
 * @returns {string | null} The basename, or `null` when the template does
 * not reference a file under `hooks/`.
 */
function hookBasenameFromTemplate(command) {
  const m = /hooks\/([A-Za-z0-9_.-]+\.js)/.exec(command.split(path.sep).join("/"));
  return m ? m[1] : null;
}

/**
 * Finds the one real, fully-substituted command registered for a given
 * event whose path contains the given hook basename.
 *
 * @param {Record<string, string[]>} registered This agent's registered
 * commands, keyed by event, from {@link readRegisteredCommands}.
 * @param {string} event The event the module declared this hook under.
 * @param {string} basename The hook script's installed basename.
 * @returns {string | undefined} The matching real command, if any.
 */
function findRegisteredCommand(registered, event, basename) {
  const candidates = registered[event] || [];
  return candidates.find((cmd) => cmd.split(path.sep).join("/").includes(`hooks/${basename}`));
}

/**
 * Runs one already-installed hook the way its host actually invokes it: the
 * exact, fully-substituted command string an install wrote into
 * `settings.json`/`hooks.json`, through a real shell, with a JSON payload
 * on stdin.
 *
 * @param {string} command The real, substituted command string.
 * @param {object} payload The JSON payload to write to stdin.
 * @param {string} cwd The working directory to run the command from.
 * @returns {{status: number, stdout: string, stderr: string}} The process's
 * outcome; `status` is `0` on a clean exit, whatever the child reported
 * otherwise.
 */
function runInstalledHook(command, payload, cwd) {
  try {
    const stdout = execSync(command, {
      input: JSON.stringify(payload),
      encoding: "utf8",
      cwd,
      timeout: 15000,
      windowsHide: true,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: typeof err.status === "number" ? err.status : 1,
      stdout: err.stdout || "",
      stderr: err.stderr || err.message || "",
    };
  }
}

suite("modules/installed-layout", ({ test, eq, ok, fakeHome, tmpdir }) => {
  const moduleIds = allModuleIds();
  const modules = moduleIds.map((id) => loadModule(id));

  /* ---------------------------------------------------- property 2: no collision */

  test("no two modules install a hook file to the same basename under the shared flat hooks/ directory", () => {
    const byBasename = new Map();
    for (const mod of modules) {
      for (const f of Array.isArray(mod.json.files) ? mod.json.files : []) {
        const to = String(f.to).split(path.sep).join("/");
        if (!to.startsWith("hooks/")) continue;
        const basename = path.posix.basename(to);
        if (!byBasename.has(basename)) byBasename.set(basename, []);
        byBasename.get(basename).push(mod.id);
      }
    }
    for (const [basename, owners] of byBasename) {
      eq(owners.length, 1, `hooks/${basename} would be installed by more than one module (${owners.join(", ")}) — one would silently overwrite the other`);
    }
    ok(byBasename.size > 0, "sanity check: at least one module must ship a hook file for this check to mean anything");
  });

  /* ---------------------------------------- property 1: runs once installed */

  for (const agent of AGENTS) {
    test(`${agent}: every module-registered hook runs from a real installed layout, exits 0, and (when it writes anything) writes valid JSON`, () => {
      fakeHome();
      runInstall(agent, moduleIds);
      const registered = readRegisteredCommands(agent);

      let casesRun = 0;
      for (const mod of modules) {
        for (const h of Array.isArray(mod.json.hooks) ? mod.json.hooks : []) {
          if (h.agent !== agent) continue;
          const basename = hookBasenameFromTemplate(h.command);
          ok(basename, `${mod.id}: hook command "${h.command}" should reference a hooks/<file>.js script`);

          const command = findRegisteredCommand(registered, h.event, basename);
          ok(command, `${mod.id}: expected a registered ${agent}:${h.event} command invoking ${basename}, found none among: ${JSON.stringify(registered[h.event] || [])}`);

          const cwd = tmpdir();
          const payload = payloadFor(h.event, cwd);
          const result = runInstalledHook(command, payload, cwd);

          eq(
            result.status,
            0,
            `${mod.id}:${basename} (${agent}:${h.event}) exited ${result.status} from the installed layout — stderr: ${result.stderr}`,
          );

          const trimmed = result.stdout.trim();
          if (trimmed) {
            let parsed;
            try {
              parsed = JSON.parse(trimmed);
            } catch (err) {
              throw new Error(`${mod.id}:${basename} (${agent}:${h.event}) wrote non-JSON stdout: ${trimmed} (${err.message})`);
            }
            ok(parsed && typeof parsed === "object", `${mod.id}:${basename} (${agent}:${h.event}) should write a JSON object when it writes anything`);
          }

          casesRun += 1;
        }
      }

      ok(casesRun > 0, `${agent}: at least one module-registered hook should have been exercised`);
    });
  }
});
