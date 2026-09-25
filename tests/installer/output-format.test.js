"use strict";

/**
 * Console-output formatting for `install`/`update` (INSTALLER.md §2): a
 * single, unambiguous header naming the command and agent once; the
 * DEFAULT (non-`--verbose`) output bulking routine added/changed files into
 * one count line while still naming every settings change, a kept edit, a
 * removal and the instructions block individually; columns that actually
 * align; and a closing summary with next steps. `--verbose` keeps printing
 * every line individually, and `--json` must not change shape at all.
 */

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");
const { runCli, seedForeign, agentHomePath, listBackupDirs, readManifest } = require("./_home");
const doctor = require("../../core/installer/doctor");
const tty = require("../../core/installer/tty");

/**
 * Widths every "no line exceeds the terminal" case below drives the CLI at —
 * both ends of `tty.js`'s own clamp range, its `FALLBACK_WIDTH`, a wide
 * terminal where nothing should wrap at all, and 100 columns in between.
 */
const PROBE_WIDTHS = [tty.MIN_WIDTH, 60, tty.FALLBACK_WIDTH, 100, tty.MAX_WIDTH];

/**
 * The one line this suite's own scenarios can produce that deliberately does
 * not hold to the width invariant: `core/installer/doctor.js#formatDoctorReport`'s
 * own "run via:" line — a real, copy-pasteable filesystem path, one unbroken
 * "word" that cannot be wrapped without corrupting it, the same
 * "never mangle something meant to be typed verbatim" rule this suite's own
 * backup-directory and run-command assertions above rely on.
 */
const WIDTH_INVARIANT_EXEMPT_PREFIXES = ["  run via:"];

/**
 * Asserts every non-empty line a CLI invocation printed (stdout and stderr
 * together) fits within `width` columns — excluding the narrow, structural
 * exemption {@link WIDTH_INVARIANT_EXEMPT_PREFIXES} lists — and, regardless
 * of that exemption, that no line ends in whitespace (a padded column's
 * trailing spaces, never legitimate in output meant to be read or piped).
 *
 * @param {(a: *, b: *, c?: *) => void} ok The harness's own assertion.
 * @param {{stdout: string, stderr: string}} result A `runCli` result.
 * @param {number} width The width this run was driven at.
 * @returns {void}
 */
function assertFitsWidth(ok, result, width) {
  const lines = `${result.stdout}${result.stderr}`.split("\n");
  for (const line of lines) {
    if (!line) continue;
    ok(line === line.trimEnd(), `line ends in whitespace: ${JSON.stringify(line)}\nfull output:\n${result.stdout}${result.stderr}`);
    if (WIDTH_INVARIANT_EXEMPT_PREFIXES.some((p) => line.startsWith(p))) continue;
    ok(
      tty.displayWidth(line) <= width,
      `line exceeds width ${width} (${tty.displayWidth(line)} columns): ${JSON.stringify(line)}\nfull output:\n${result.stdout}${result.stderr}`,
    );
  }
}

/** The fixed key set every `agents[]` entry of an install/update `--json` result carries. */
const AGENT_RESULT_KEYS = [
  "agent",
  "actions",
  "empty",
  "applied",
  "unknownModules",
  "newlyEnabledModules",
  "requiresBlockedModules",
  "home",
  "codexTrustCaveat",
  "areaWarnings",
  "configErrors",
  "tierFallbacks",
  "conflicts",
  "conflictResolution",
  "blockedByConflicts",
  "disabledForeignHooks",
].sort();

suite("installer/output-format", ({ test, eq, ok, deepEq, fakeHome, tmpdir }) => {
  test("[claude] the header names the command exactly once, for a real run", () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "--agent", "claude", "--yes"]);
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);
    const header = result.stdout.split("\n")[0];
    eq(header, "softela-ai install -> claude");
  });

  test("[claude] a dry run's header is unmistakably a preview, still naming the command once", () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "--agent", "claude", "--yes", "--dry-run"]);
    eq(result.code, 0, `dry-run stdout:\n${result.stdout}\n${result.stderr}`);
    const header = result.stdout.split("\n")[0];
    ok(header.startsWith("softela-ai install -> claude"), header);
    ok(/dry run/.test(header), `expected the header to say this is a dry run, got: ${header}`);
    eq((header.match(/install/g) || []).length, 1, `"install" must appear exactly once, got: ${header}`);
  });

  test("[claude] a first install's default output is dramatically shorter than the file count it writes, and still names every settings change and the instructions block", () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "--agent", "claude", "--yes"]);
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);

    const manifest = readManifest(home, "claude");
    const fileCount = Object.keys(manifest.files).length;
    ok(fileCount > 100, `expected a first install to write over 100 files, wrote ${fileCount}`);

    const lines = result.stdout.split("\n").filter((l) => l.length > 0);
    ok(lines.length < 30, `expected fewer than 30 lines for ${fileCount} files written, got ${lines.length}:\n${result.stdout}`);

    ok(/^ {2}files {2}\d+ added/m.test(result.stdout), `expected a single bulk count line for added files:\n${result.stdout}`);
    ok(result.stdout.includes("hooks.PreToolUse[softela-ai]"), "every settings change must still print its own line");
    ok(result.stdout.includes("hooks.SessionStart[memory-as-context]"));
    ok(result.stdout.includes("CLAUDE.md"), "the instructions block must still print its own line");
  });

  test("[claude] --verbose prints a line per file, and more lines than the default", () => {
    const defaultHome = fakeHome();
    const defaultResult = runCli(defaultHome, ["install", "--agent", "claude", "--yes"]);
    eq(defaultResult.code, 0, `install stdout:\n${defaultResult.stdout}\n${defaultResult.stderr}`);

    const verboseHome = fakeHome();
    const verboseResult = runCli(verboseHome, ["install", "--agent", "claude", "--yes", "--verbose"]);
    eq(verboseResult.code, 0, `verbose install stdout:\n${verboseResult.stdout}\n${verboseResult.stderr}`);

    const defaultLines = defaultResult.stdout.split("\n").filter((l) => l.length > 0).length;
    const verboseLines = verboseResult.stdout.split("\n").filter((l) => l.length > 0).length;
    ok(verboseLines > defaultLines, `expected --verbose (${verboseLines} lines) to print more than the default (${defaultLines} lines)`);

    const manifest = readManifest(verboseHome, "claude");
    const someRelPath = Object.keys(manifest.files).find((p) => p.endsWith("core/lib/decision.js"));
    ok(someRelPath, "expected core/lib/decision.js to be tracked");
    ok(verboseResult.stdout.includes(`  +   ${someRelPath}`), `expected --verbose to print an individual line for every file, including ${someRelPath}:\n${verboseResult.stdout}`);
  });

  test("[claude] a locally-modified tracked file still gets its own line in the DEFAULT output", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    const manifest = readManifest(home, "claude");
    const relPath = Object.keys(manifest.files).find((p) => p.endsWith("core/lib/decision.js"));
    ok(relPath, "expected core/lib/decision.js to be tracked by the manifest");
    const absPath = path.join(agentHomePath(home, "claude"), relPath.split("/").join(path.sep));
    fs.appendFileSync(absPath, "\n// a developer's own local edit\n", "utf8");

    const updated = runCli(home, ["update", "--agent", "claude", "--yes"]);
    eq(updated.code, 0, `update stdout:\n${updated.stdout}\n${updated.stderr}`);
    ok(
      updated.stdout.includes(`  !   ${relPath}`),
      `expected an individual "!" line for the locally-modified file in the DEFAULT output:\n${updated.stdout}`,
    );
  });

  test("[claude] a removed file still gets its own line in the DEFAULT output", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);
    eq(runCli(home, ["module", "enable", "session-cleanup", "--agent", "claude", "--yes"]).code, 0);

    const disabled = runCli(home, ["module", "disable", "session-cleanup", "--agent", "claude", "--yes"]);
    eq(disabled.code, 0, `module disable stdout:\n${disabled.stdout}\n${disabled.stderr}`);
    ok(
      /\n {2}- {3}softela-ai\/modules\/session-cleanup\//.test(disabled.stdout),
      `expected an individual "-" line for a removed file in the DEFAULT output:\n${disabled.stdout}`,
    );
  });

  test("[codex] columns align across settings entries with both a short and a long label", () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "--agent", "codex", "--yes"]);
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);

    const settingsLines = result.stdout.split("\n").filter((l) => /\((enforce|seed)/.test(l));
    ok(settingsLines.length >= 2, "expected multiple settings lines to compare alignment across");
    const columns = settingsLines.map((l) => {
      const i = l.indexOf("(enforce");
      return i !== -1 ? i : l.indexOf("(seed");
    });
    ok(
      columns.every((c) => c === columns[0]),
      `expected every settings line's suffix to start at the same column, got: ${JSON.stringify(columns)}\n${result.stdout}`,
    );
  });

  for (const width of PROBE_WIDTHS) {
    test(`[claude] an unchanged settings entry's "already registered" reason wraps onto an aligned continuation line at width ${width}, instead of being cut with an ellipsis`, () => {
      const home = fakeHome();
      eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

      const env = { SOFTELA_AI_COLUMNS: String(width) };
      const result = runCli(home, ["update", "--agent", "claude", "--yes", "--verbose"], { env });
      eq(result.code, 2, `update stdout:\n${result.stdout}\n${result.stderr}`);
      assertFitsWidth(ok, result, width);

      ok(!/regist…/.test(result.stdout), `expected "already registered" to wrap rather than be cut mid-word at width ${width}:\n${result.stdout}`);
      if (width >= 80) {
        // Wide enough that the whole reason is expected to survive intact,
        // whether on the first line or wrapped onto its own continuation —
        // narrower widths may not have room for even one full word of it,
        // the same documented last-resort {@link wrapWithPrefix} accepts.
        ok(
          result.stdout.includes("already registered)"),
          `expected the full "already registered)" reason to survive unbroken at width ${width}:\n${result.stdout}`,
        );
      }
    });
  }

  test("[claude] the completion summary states what happened and names doctor and the backup directory", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    const result = runCli(home, ["install", "--agent", "claude", "--yes"]);
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);

    const dirs = listBackupDirs(home, "claude");
    eq(dirs.length, 1);
    ok(/^Done. Installed for claude./m.test(result.stdout), result.stdout);
    ok(result.stdout.includes("Next steps"), result.stdout);
    ok(result.stdout.includes("softela-ai doctor"), result.stdout);
    ok(result.stdout.includes(dirs[0]), "the closing summary must name the actual backup directory");
  });

  test("[claude] the completion summary states a preview wrote nothing, and never claims a backup", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    const result = runCli(home, ["install", "--agent", "claude", "--yes", "--dry-run"]);
    eq(result.code, 0, `dry-run stdout:\n${result.stdout}\n${result.stderr}`);

    ok(/^Preview only - nothing was written/m.test(result.stdout), result.stdout);
    ok(!/backup \(/.test(result.stdout), `a preview writes nothing, so it must never claim a backup was made:\n${result.stdout}`);
  });

  test("[claude] the PATH notice appears when softela-ai cannot be found on a controlled PATH, and stays silent when it can", () => {
    const emptyBinDir = tmpdir();
    const homeAbsent = fakeHome();
    const resultAbsent = runCli(homeAbsent, ["install", "--agent", "claude", "--yes"], { env: { PATH: emptyBinDir } });
    eq(resultAbsent.code, 0, `install stdout:\n${resultAbsent.stdout}\n${resultAbsent.stderr}`);
    ok(
      resultAbsent.stdout.includes("is not on your PATH"),
      `expected the PATH notice when softela-ai cannot be found on PATH:\n${resultAbsent.stdout}`,
    );

    const binDir = tmpdir();
    const exeName = process.platform === "win32" ? "softela-ai.cmd" : "softela-ai";
    fs.writeFileSync(path.join(binDir, exeName), "#!/bin/sh\necho fake\n", "utf8");
    const homePresent = fakeHome();
    const resultPresent = runCli(homePresent, ["install", "--agent", "claude", "--yes"], { env: { PATH: binDir } });
    eq(resultPresent.code, 0, `install stdout:\n${resultPresent.stdout}\n${resultPresent.stderr}`);
    ok(
      !resultPresent.stdout.includes("is not on your PATH"),
      `expected no PATH notice once softela-ai is already reachable on PATH:\n${resultPresent.stdout}`,
    );
  });

  test("[codex] the hook-trust review appears as one of the next steps", () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "--agent", "codex", "--yes"]);
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);

    const nextStepsIndex = result.stdout.indexOf("Next steps");
    const caveatIndex = result.stdout.indexOf(doctor.CODEX_TRUST_CAVEAT);
    ok(nextStepsIndex !== -1 && caveatIndex !== -1, `expected both "Next steps" and the trust caveat:\n${result.stdout}`);
    ok(caveatIndex > nextStepsIndex, "the codex trust caveat must read as one of the next steps, after the Next steps heading");
  });

  test("[claude] a claude-only install never mentions the codex hook-trust review", () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "--agent", "claude", "--yes"]);
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);
    ok(!result.stdout.toLowerCase().includes("hook-trust"), "Claude Code has no such review step");
  });

  test("[claude] --json output shape is unchanged for a real install", () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "--agent", "claude", "--yes", "--json"]);
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);
    const out = JSON.parse(result.stdout);

    deepEq(Object.keys(out).sort(), ["agents", "mode"]);
    eq(out.mode, "install");
    ok(Array.isArray(out.agents) && out.agents.length === 1);
    deepEq(Object.keys(out.agents[0]).sort(), AGENT_RESULT_KEYS);

    ok(Array.isArray(out.agents[0].actions) && out.agents[0].actions.length > 100);
    for (const a of out.agents[0].actions) {
      ok(
        typeof a.kind === "string" && typeof a.action === "string" && typeof a.state === "string" && typeof a.reason === "string",
        `every action must still carry kind/action/state/reason: ${JSON.stringify(a)}`,
      );
    }

    const applied = out.agents[0].applied;
    ok(applied && typeof applied === "object", "a real install with something to write must apply");
    deepEq(Object.keys(applied).sort(), ["manifest", "backupsDir", "report"].sort());
    deepEq(Object.keys(applied.report).sort(), ["written", "removed", "modifiedKept", "backedUp", "errors"].sort());
  });

  test("[claude] --json output shape is unchanged for a dry run", () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "--agent", "claude", "--yes", "--json", "--dry-run"]);
    eq(result.code, 0, `dry-run stdout:\n${result.stdout}\n${result.stderr}`);
    const out = JSON.parse(result.stdout);

    deepEq(Object.keys(out).sort(), ["agents", "mode"]);
    deepEq(Object.keys(out.agents[0]).sort(), AGENT_RESULT_KEYS);
    eq(out.agents[0].applied, null, "a dry run must never apply anything");
    ok(Array.isArray(out.agents[0].actions) && out.agents[0].actions.length > 100);
  });

  for (const width of PROBE_WIDTHS) {
    const env = { SOFTELA_AI_COLUMNS: String(width) };

    test(`no line of "--help" exceeds a ${width}-column terminal`, () => {
      const result = runCli(fakeHome(), ["--help"], { env });
      eq(result.code, 0, result.stdout + result.stderr);
      assertFitsWidth(ok, result, width);
    });

    test(`no line of an "install --dry-run" preview exceeds a ${width}-column terminal`, () => {
      const result = runCli(fakeHome(), ["install", "--agent", "claude", "--yes", "--dry-run"], { env });
      eq(result.code, 0, result.stdout + result.stderr);
      assertFitsWidth(ok, result, width);
    });

    test(`no line of an unknown-flag refusal exceeds a ${width}-column terminal`, () => {
      const result = runCli(fakeHome(), ["install", "--dryrun"], { env });
      ok(result.code !== 0);
      assertFitsWidth(ok, result, width);
    });

    test(`no line of "doctor" on a real install exceeds a ${width}-column terminal`, () => {
      const home = fakeHome();
      eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);
      const result = runCli(home, ["doctor", "--agent", "claude"], { env });
      assertFitsWidth(ok, result, width);
    });
  }
});
