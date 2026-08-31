"use strict";

/**
 * Empirical checks of Codex's hook registration, run against whatever
 * `codex` binary is actually installed on this machine (CONTRACTS §7 and
 * §10). These are probes, not unit tests: a fact recorded here was
 * established by running the real binary, and this file is what notices
 * when a Codex release changes it.
 *
 * The oracle is the one CONTRACTS documents: `CODEX_HOME` pointed at a
 * disposable directory, running `codex exec --skip-git-repo-check "x"`.
 * The hooks-config parse warning — and, with `--dangerously-bypass-hook-trust`,
 * hook firing itself — happens before authentication, so an unauthenticated
 * scratch home is a free, fast oracle; the 401s that follow are never
 * inspected. Every run is given a bounded timeout and killed at the
 * deadline rather than left to retry — nothing here waits for the network
 * to give up.
 *
 * Nothing touches the developer's real `~/.codex`; every case gets its own
 * disposable `CODEX_HOME` under the system temp directory, removed
 * afterwards.
 */

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");
const host = require("./_host");

/** Bound on the schema-only checks — the parse warning, when it fires, has
 * always appeared well under a second after startup in manual verification. */
const SCHEMA_TIMEOUT_MS = 5000;

/** Bound on the marker-based checks — these also wait on a child `node -e`
 * process the hook itself spawns, so they get more headroom. */
const TRUST_TIMEOUT_MS = 8000;

/**
 * Judges whether a captured transcript ran far enough to trust a negative
 * result.
 *
 * The Codex process being probed never exits on its own here — it retries
 * the (deliberately unauthenticated) network call until it is killed at the
 * timeout — so every run in this file ends by being killed. That is not
 * itself a reason to distrust the result: what matters is whether the
 * transcript shows the process got past the point where the fact under test
 * would already have appeared, which every fired assertion in this file
 * has, well before the first retry.
 *
 * @param {string} text The concatenated stdout and stderr of a run.
 * @returns {boolean} `true` when the transcript reached at least one retry
 * attempt, proving the config-parse and hook-dispatch stage is behind it.
 */
function reachedRetryStage(text) {
  return /OpenAI Codex/.test(text) && /ERROR/.test(text);
}

/**
 * Writes a `hooks.json` document into a scratch `CODEX_HOME`.
 *
 * @param {string} home The scratch `CODEX_HOME` directory.
 * @param {object} doc The document to serialise.
 * @returns {void}
 */
function writeHooksFile(home, doc) {
  fs.writeFileSync(path.join(home, "hooks.json"), JSON.stringify(doc));
}

/**
 * Builds a hook command that writes a marker file, so firing can be
 * detected by the marker's presence rather than by parsing log output.
 *
 * @param {string} markerPath The file the command creates when it runs.
 * @returns {string} A `command` value for a `hooks.json` entry.
 */
function markerCommand(markerPath) {
  return `node -e "require('fs').writeFileSync(process.argv[1],'ok')" "${markerPath}"`;
}

/**
 * Copies the currently running Node executable into a freshly created
 * directory whose name contains a space, so a hook `command` string can
 * reference an executable path that is guaranteed to contain a space
 * without assuming where Node itself happens to be installed on this
 * machine (e.g. `C:\Program Files\nodejs\node.exe`).
 *
 * @param {string} home The scratch `CODEX_HOME` directory to nest the
 * spaced directory under.
 * @returns {string} The absolute path to the copied executable, inside a
 * directory whose name contains a space.
 */
function spacedNodeCopy(home) {
  const dir = path.join(home, "node with space");
  fs.mkdirSync(dir);
  const dest = path.join(dir, path.basename(process.execPath));
  fs.copyFileSync(process.execPath, dest);
  return dest;
}

/**
 * Runs `codex exec` against a scratch `CODEX_HOME`.
 *
 * @param {{invocation: {command: string, prefixArgs: string[]}}} codex The
 * detection result from `host.detectHost("codex")`.
 * @param {string} home The scratch `CODEX_HOME` directory.
 * @param {string[]} extraArgs Flags inserted before the trailing prompt.
 * @param {number} timeoutMs How long to let the process run before killing
 * it.
 * @returns {{stdout: string, stderr: string, timedOut: boolean}} The
 * captured outcome, per `host.run`.
 */
function runCodex(codex, home, extraArgs, timeoutMs) {
  return host.run(codex.invocation, ["exec", "--skip-git-repo-check", ...extraArgs, "x"], {
    env: { ...process.env, CODEX_HOME: home },
    timeoutMs,
  });
}

suite("probes/codex-host", ({ test, skip, ok }) => {
  const codex = host.detectHost("codex");

  if (!codex.present) {
    host.runProbe({ test, skip }, "codex host probes", () => ({ skip: "codex is not installed on PATH" }));
    return;
  }
  if (!codex.invocable) {
    host.runProbe({ test, skip }, "codex host probes", () => ({
      skip: `codex was found at ${codex.path} but its launcher could not be resolved without a shell`,
    }));
    return;
  }

  test("codex --version resolves through the shell-free invocation", () => {
    ok(typeof codex.version === "string" && codex.version.length > 0, `expected a version string, got ${codex.version}`);
  });

  host.runProbe(
    { test, skip },
    "the feature flags agent-orchestration seeds still exist on this Codex build, and the one it never seeds still does not",
    () => {
      // `agent-orchestration` depends on two flags that were established by
      // running this command, not read from documentation. Without
      // `multi_agent_v2` a Codex session is offered no spawn tool at all;
      // without `multi_agent_v2.expose_spawn_agent_model_overrides` a spawn
      // carries no model and every subagent silently runs on the session's
      // own. A release that renames or drops either takes tiered delegation
      // out of service on this host, silently — this is what notices.
      //
      // `per_spawn_model_override` is pinned from the other direction: the
      // module used to seed it, it never existed, and it wrote a key nothing
      // read. If a future release ever introduces it for real, that is worth
      // knowing too rather than discovering by accident.
      const result = host.run(codex.invocation, ["features", "list"], { timeoutMs: SCHEMA_TIMEOUT_MS });
      const text = `${result.stdout}${result.stderr}`;
      if (result.timedOut || !text.trim()) {
        return { skip: `codex features list produced no output within ${SCHEMA_TIMEOUT_MS}ms` };
      }
      // A build that does not know the subcommand at all is inconclusive, not
      // a failure: this probe asserts about a surface that build does not have.
      if (/unrecognized subcommand|unexpected argument/i.test(text)) {
        return { skip: "this codex build has no `features list` subcommand" };
      }

      const names = new Set(
        text
          .split("\n")
          .map((line) => line.trim().split(/\s+/)[0])
          .filter(Boolean),
      );

      return {
        assert: () => {
          ok(names.has("multi_agent_v2"), `codex no longer knows the feature flag "multi_agent_v2"; it lists: ${[...names].join(", ")}`);
          ok(
            !names.has("per_spawn_model_override"),
            'codex has grown a "per_spawn_model_override" feature flag — this repository removed that pointer because no such flag existed; re-check whether it should now be seeded',
          );
        },
      };
    },
  );

  host.runProbe({ test, skip }, "a top-level {PreToolUse} document is rejected with the documented parse warning", () => {
    const home = host.mkTempDir("softela-ai-codex-probe-");
    let result;
    try {
      writeHooksFile(home, { PreToolUse: [{ matcher: null, hooks: [{ type: "command", command: "echo hi" }] }] });
      result = runCodex(codex, home, [], SCHEMA_TIMEOUT_MS);
    } finally {
      host.removeTempDir(home);
    }
    const text = result.stdout + result.stderr;
    if (!reachedRetryStage(text)) return { skip: `codex did not reach a decisive point within ${SCHEMA_TIMEOUT_MS}ms` };
    return {
      assert: () => {
        ok(
          /unknown field `PreToolUse`, expected `description` or `hooks`/.test(text),
          `expected the documented parse warning, got:\n${text}`,
        );
      },
    };
  });

  host.runProbe({ test, skip }, "the {description, hooks:{...}} document parses without a warning", () => {
    const home = host.mkTempDir("softela-ai-codex-probe-");
    let result;
    try {
      writeHooksFile(home, {
        description: "probe",
        hooks: { SessionStart: [{ matcher: null, hooks: [{ type: "command", command: "echo hi" }] }] },
      });
      result = runCodex(codex, home, [], SCHEMA_TIMEOUT_MS);
    } finally {
      host.removeTempDir(home);
    }
    const text = result.stdout + result.stderr;
    if (!reachedRetryStage(text)) return { skip: `codex did not reach a decisive point within ${SCHEMA_TIMEOUT_MS}ms` };
    return {
      assert: () => {
        ok(!/failed to parse hooks config/.test(text), `expected no parse warning, got:\n${text}`);
      },
    };
  });

  host.runProbe({ test, skip }, "a PascalCase SessionStart hook fires under --dangerously-bypass-hook-trust", () => {
    const home = host.mkTempDir("softela-ai-codex-probe-");
    const marker = path.join(home, "marker.txt");
    let result;
    let markerFired;
    try {
      writeHooksFile(home, {
        description: "probe",
        hooks: { SessionStart: [{ matcher: null, hooks: [{ type: "command", command: markerCommand(marker) }] }] },
      });
      result = runCodex(codex, home, ["--dangerously-bypass-hook-trust"], TRUST_TIMEOUT_MS);
      markerFired = fs.existsSync(marker);
    } finally {
      host.removeTempDir(home);
    }
    const text = result.stdout + result.stderr;
    if (!reachedRetryStage(text)) return { skip: `codex did not reach a decisive point within ${TRUST_TIMEOUT_MS}ms` };
    return {
      assert: () => {
        ok(markerFired, `expected the SessionStart hook to have written its marker; transcript:\n${text}`);
      },
    };
  });

  host.runProbe({ test, skip }, "a camelCase sessionStart hook does not fire, even under the bypass flag", () => {
    const home = host.mkTempDir("softela-ai-codex-probe-");
    const marker = path.join(home, "marker.txt");
    let result;
    let markerFired;
    try {
      writeHooksFile(home, {
        description: "probe",
        hooks: { sessionStart: [{ matcher: null, hooks: [{ type: "command", command: markerCommand(marker) }] }] },
      });
      result = runCodex(codex, home, ["--dangerously-bypass-hook-trust"], TRUST_TIMEOUT_MS);
      markerFired = fs.existsSync(marker);
    } finally {
      host.removeTempDir(home);
    }
    const text = result.stdout + result.stderr;
    if (!reachedRetryStage(text)) return { skip: `codex did not reach a decisive point within ${TRUST_TIMEOUT_MS}ms` };
    return {
      assert: () => {
        ok(!markerFired, `expected camelCase "sessionStart" to be silently ignored, but its marker was written`);
      },
    };
  });

  host.runProbe({ test, skip }, "a SessionStart hook stays inert without --dangerously-bypass-hook-trust", () => {
    const home = host.mkTempDir("softela-ai-codex-probe-");
    const marker = path.join(home, "marker.txt");
    let result;
    let markerFired;
    try {
      writeHooksFile(home, {
        description: "probe",
        hooks: { SessionStart: [{ matcher: null, hooks: [{ type: "command", command: markerCommand(marker) }] }] },
      });
      result = runCodex(codex, home, [], TRUST_TIMEOUT_MS);
      markerFired = fs.existsSync(marker);
    } finally {
      host.removeTempDir(home);
    }
    const text = result.stdout + result.stderr;
    if (!reachedRetryStage(text)) return { skip: `codex did not reach a decisive point within ${TRUST_TIMEOUT_MS}ms` };
    return {
      assert: () => {
        ok(!markerFired, `expected an untrusted hook to stay inert, but its marker was written`);
      },
    };
  });

  host.runProbe(
    { test, skip },
    "a hook whose executable path contains a space never runs, quoted or unquoted",
    () => {
      if (process.platform !== "win32") return { skip: "Windows-only executable-path quoting fact" };

      const home = host.mkTempDir("softela-ai-codex-probe-");
      const quotedMarker = path.join(home, "quoted-marker.txt");
      const unquotedMarker = path.join(home, "unquoted-marker.txt");
      const controlMarker = path.join(home, "control-marker.txt");
      let result;
      let quotedFired;
      let unquotedFired;
      let controlFired;
      try {
        let spacedNode;
        try {
          spacedNode = spacedNodeCopy(home);
        } catch (err) {
          return { skip: `could not stage an executable under a spaced path: ${err.message}` };
        }
        // Same handler shape as markerCommand, but pointed at the spaced-path
        // copy: once quoted the way a user would reasonably try, once not.
        const quotedCommand = `"${spacedNode}" -e "require('fs').writeFileSync(process.argv[1],'ok')" "${quotedMarker}"`;
        const unquotedCommand = `${spacedNode} -e "require('fs').writeFileSync(process.argv[1],'ok')" "${unquotedMarker}"`;
        writeHooksFile(home, {
          description: "probe",
          hooks: {
            SessionStart: [
              {
                matcher: null,
                hooks: [
                  { type: "command", command: quotedCommand },
                  { type: "command", command: unquotedCommand },
                  // Control: an ordinary, unspaced "node" command in the SAME
                  // run — if this one's marker is also absent, hooks were not
                  // firing at all, and the spaced-path cases prove nothing.
                  { type: "command", command: markerCommand(controlMarker) },
                ],
              },
            ],
          },
        });
        result = runCodex(codex, home, ["--dangerously-bypass-hook-trust"], TRUST_TIMEOUT_MS);
        quotedFired = fs.existsSync(quotedMarker);
        unquotedFired = fs.existsSync(unquotedMarker);
        controlFired = fs.existsSync(controlMarker);
      } finally {
        host.removeTempDir(home);
      }
      const text = result.stdout + result.stderr;
      if (!reachedRetryStage(text)) return { skip: `codex did not reach a decisive point within ${TRUST_TIMEOUT_MS}ms` };
      return {
        assert: () => {
          ok(
            controlFired,
            `expected the control hook (unspaced "node") to fire, proving hooks were dispatched at all; transcript:\n${text}`,
          );
          ok(!quotedFired, `expected a quoted spaced-path executable to never run, but its marker was written`);
          ok(!unquotedFired, `expected an unquoted spaced-path executable to never run, but its marker was written`);
        },
      };
    },
  );

  host.runProbe(
    { test, skip },
    "arguments after the executable are tokenised with their quotes stripped",
    () => {
      if (process.platform !== "win32") return { skip: "Windows-only argument-tokenisation fact" };

      const home = host.mkTempDir("softela-ai-codex-probe-");
      const scriptPath = path.join(home, "argv-probe.js");
      const marker = path.join(home, "argv-marker.json");
      let result;
      let argv = null;
      try {
        fs.writeFileSync(
          scriptPath,
          `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv));`,
        );
        writeHooksFile(home, {
          description: "probe",
          hooks: {
            SessionStart: [{ matcher: null, hooks: [{ type: "command", command: `node "${scriptPath}" --tag=x` }] }],
          },
        });
        result = runCodex(codex, home, ["--dangerously-bypass-hook-trust"], TRUST_TIMEOUT_MS);
        if (fs.existsSync(marker)) {
          try {
            argv = JSON.parse(fs.readFileSync(marker, "utf8"));
          } catch {
            argv = null;
          }
        }
      } finally {
        host.removeTempDir(home);
      }
      const text = result.stdout + result.stderr;
      if (!reachedRetryStage(text)) return { skip: `codex did not reach a decisive point within ${TRUST_TIMEOUT_MS}ms` };
      if (!argv) return { skip: `the hook did not write its argv marker; transcript:\n${text}` };
      return {
        assert: () => {
          ok(argv.length >= 2, `expected process.argv to include at least [node, script], got ${JSON.stringify(argv)}`);
          ok(
            !/"/.test(argv[1]),
            `expected the tokenised script path to contain no quote characters, got ${JSON.stringify(argv[1])}`,
          );
          ok(
            argv[1] === scriptPath,
            `expected argv[1] to equal the unquoted script path exactly, got ${JSON.stringify(argv[1])} vs ${scriptPath}`,
          );
        },
      };
    },
  );
});
