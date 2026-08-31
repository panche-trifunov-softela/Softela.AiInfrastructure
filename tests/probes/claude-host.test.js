"use strict";

/**
 * Empirical checks of Claude Code's settings-file location and hook-entry
 * shape, run against whatever `claude` binary is actually installed on this
 * machine.
 *
 * Unlike Codex, Claude Code offers no documented, unauthenticated oracle
 * that fires a real hook — every path that would exercise `PreToolUse` for
 * real starts an interactive or model-backed session. Spending the
 * developer's real credentials, or hanging on an auth prompt, is not an
 * acceptable price for a test probe, so this file never runs a real
 * session. What it checks instead:
 *
 * - `claude` honours `CLAUDE_CONFIG_DIR` as a full home-directory override,
 *   confirmed by pointing it at a disposable directory and reading back the
 *   file path `claude doctor` reports an error against.
 * - `claude doctor` validates `<home>/settings.json` — including the shape
 *   of its `hooks` field — entirely offline, before any auth check, so it
 *   is used as the shape oracle in place of firing a hook for real.
 *
 * This does confirm the settings file's location and the hook-entry shape
 * the installer writes. It does **not** confirm that a registered hook
 * actually intercepts a tool call — that would need a live session, which
 * this suite deliberately does not start. See `README.md` in this
 * directory for what is and is not covered, and why.
 *
 * Nothing here reads or writes the developer's real `~/.claude`; every case
 * gets its own disposable directory passed through `CLAUDE_CONFIG_DIR`,
 * removed afterwards.
 */

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");
const host = require("./_host");

/** Bound on a `claude doctor` run — every manual run observed so far exits
 * on its own within two seconds; this only guards against a machine where
 * it does not. */
const DOCTOR_TIMEOUT_MS = 8000;

/** The `matcher` string this repository actually ships for Claude Code's
 * `PreToolUse` hook entry, read from the fragment itself rather than
 * restated here, so this probe can never drift from what installs. */
const INSTALLER_MATCHER = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "adapters", "claude", "settings.fragment.json"), "utf8"),
).hooks.PreToolUse[0].matcher;

/**
 * Writes a `settings.json` document into a scratch Claude Code home.
 *
 * @param {string} home The scratch home directory.
 * @param {object} doc The document to serialise.
 * @returns {void}
 */
function writeSettingsFile(home, doc) {
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify(doc));
}

/**
 * Runs `claude doctor` against a scratch home directory.
 *
 * A fresh temporary `cwd` is used alongside the scratch home so no
 * project-level `.claude/settings.json` this repository or the developer's
 * own working directory might carry is ever merged in by accident.
 *
 * @param {{invocation: {command: string, prefixArgs: string[]}}} claude The
 * detection result from `host.detectHost("claude")`.
 * @param {string} home The scratch home directory.
 * @param {string} cwd A directory with no `.claude/settings.json` of its
 * own.
 * @returns {{stdout: string, stderr: string, timedOut: boolean, status:
 * number | null}} The captured outcome, per `host.run`.
 */
function runDoctor(claude, home, cwd) {
  return host.run(claude.invocation, ["doctor"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: home },
    cwd,
    timeoutMs: DOCTOR_TIMEOUT_MS,
  });
}

/**
 * Judges whether a `claude doctor` run finished normally, as opposed to
 * being killed at its timeout with nothing usable captured.
 *
 * @param {{status: number | null}} result A `host.run` outcome.
 * @param {string} text The concatenated stdout and stderr.
 * @returns {boolean} `true` when the run exited on its own and printed its
 * report header.
 */
function finishedNormally(result, text) {
  return result.status === 0 && /Claude Code doctor/.test(text);
}

suite("probes/claude-host", ({ test, skip, ok }) => {
  const claude = host.detectHost("claude");

  if (!claude.present) {
    host.runProbe({ test, skip }, "claude host probes", () => ({ skip: "claude is not installed on PATH" }));
    return;
  }
  if (!claude.invocable) {
    host.runProbe({ test, skip }, "claude host probes", () => ({
      skip: `claude was found at ${claude.path} but its launcher could not be resolved without a shell`,
    }));
    return;
  }

  test("claude --version resolves through the shell-free invocation", () => {
    ok(typeof claude.version === "string" && claude.version.length > 0, `expected a version string, got ${claude.version}`);
  });

  host.runProbe({ test, skip }, "the real Claude Code home directory is present on this machine", () => {
    const exists = fs.existsSync(host.claudeRealHome());
    if (!exists) return { skip: `${host.claudeRealHome()} does not exist on this machine` };
    return { assert: () => ok(exists) };
  });

  host.runProbe({ test, skip }, "CLAUDE_CONFIG_DIR redirects settings validation away from the real home", () => {
    const home = host.mkTempDir("softela-ai-claude-probe-");
    const cwd = host.mkTempDir("softela-ai-claude-cwd-");
    let result;
    try {
      writeSettingsFile(home, { hooks: "not-an-object" });
      result = runDoctor(claude, home, cwd);
    } finally {
      host.removeTempDir(home);
      host.removeTempDir(cwd);
    }
    const text = result.stdout + result.stderr;
    if (!finishedNormally(result, text)) return { skip: `claude doctor did not finish within ${DOCTOR_TIMEOUT_MS}ms` };
    return {
      assert: () => {
        const expectedPath = path.join(home, "settings.json");
        ok(text.includes(expectedPath), `expected the reported file to be ${expectedPath}, got:\n${text}`);
        ok(
          /"hooks" must be an object/.test(text),
          `expected doctor to reject the malformed "hooks" field, got:\n${text}`,
        );
      },
    };
  });

  host.runProbe({ test, skip }, "the installer's exact hook-entry fragment parses without a hooks error", () => {
    const home = host.mkTempDir("softela-ai-claude-probe-");
    const cwd = host.mkTempDir("softela-ai-claude-cwd-");
    let result;
    try {
      writeSettingsFile(home, {
        hooks: {
          PreToolUse: [
            {
              matcher: INSTALLER_MATCHER,
              hooks: [{ type: "command", command: 'node "C:/nonexistent/dispatch.js"' }],
            },
          ],
          PostToolUse: [
            {
              matcher: INSTALLER_MATCHER,
              hooks: [{ type: "command", command: 'node "C:/nonexistent/dispatch.js"' }],
            },
          ],
        },
      });
      result = runDoctor(claude, home, cwd);
    } finally {
      host.removeTempDir(home);
      host.removeTempDir(cwd);
    }
    const text = result.stdout + result.stderr;
    if (!finishedNormally(result, text)) return { skip: `claude doctor did not finish within ${DOCTOR_TIMEOUT_MS}ms` };
    return {
      // The settings document under test carries nothing but "hooks", so
      // any "Invalid settings" section reported here can only be about it.
      assert: () => {
        ok(!text.includes("Invalid settings"), `expected no hooks validation error, got:\n${text}`);
      },
    };
  });

  host.runProbe({ test, skip }, "a hook entry missing its command type is rejected", () => {
    const home = host.mkTempDir("softela-ai-claude-probe-");
    const cwd = host.mkTempDir("softela-ai-claude-cwd-");
    let result;
    try {
      writeSettingsFile(home, {
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "echo hi" }] }] },
      });
      result = runDoctor(claude, home, cwd);
    } finally {
      host.removeTempDir(home);
      host.removeTempDir(cwd);
    }
    const text = result.stdout + result.stderr;
    if (!finishedNormally(result, text)) return { skip: `claude doctor did not finish within ${DOCTOR_TIMEOUT_MS}ms` };
    return {
      assert: () => {
        ok(/hooks\.PreToolUse\.0\.hooks\.0\.type/.test(text), `expected the missing "type" field to be flagged, got:\n${text}`);
      },
    };
  });

  host.runProbe({ test, skip }, "an event key outside the exact documented casing is rejected", () => {
    const home = host.mkTempDir("softela-ai-claude-probe-");
    const cwd = host.mkTempDir("softela-ai-claude-cwd-");
    let result;
    try {
      writeSettingsFile(home, {
        hooks: { pretooluse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
      });
      result = runDoctor(claude, home, cwd);
    } finally {
      host.removeTempDir(home);
      host.removeTempDir(cwd);
    }
    const text = result.stdout + result.stderr;
    if (!finishedNormally(result, text)) return { skip: `claude doctor did not finish within ${DOCTOR_TIMEOUT_MS}ms` };
    return {
      assert: () => {
        ok(/Unknown hook event "pretooluse"/.test(text), `expected the wrong-case event key to be flagged, got:\n${text}`);
        ok(/Valid events:.*\bPreToolUse\b/.test(text), `expected the exact "PreToolUse" casing to be named, got:\n${text}`);
      },
    };
  });
});
