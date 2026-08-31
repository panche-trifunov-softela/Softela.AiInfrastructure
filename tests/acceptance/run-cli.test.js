"use strict";

/**
 * Tests `tools/acceptance/run.js`'s own argument handling in-process, and
 * its non-`--live` scoring mode end-to-end as a real subprocess — the mode
 * anyone can run, deterministic and free, no agent binary involved. The
 * `--live` path itself is never exercised here, per this project's own task
 * instructions.
 */

const path = require("path");
const { execFileSync } = require("child_process");
const { suite } = require("../harness");
const { parseArgs, hostHomeEnv, transcriptStoreDir, newestJsonl, renderScorecard } = require("../../tools/acceptance/run");

const RUN_JS = path.join(__dirname, "..", "..", "tools", "acceptance", "run.js");

/**
 * Runs `run.js` as a real subprocess.
 *
 * @param {string[]} args CLI arguments.
 * @returns {{code: number, stdout: string, stderr: string}} The captured
 * outcome; never throws even on a non-zero exit.
 */
function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [RUN_JS, ...args], { encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: typeof error.status === "number" ? error.status : -1, stdout: error.stdout || "", stderr: error.stderr || "" };
  }
}

suite("acceptance/run-cli argument parsing", ({ test, eq, ok }) => {
  test("a well-formed invocation parses cleanly", () => {
    const parsed = parseArgs(["--agent=claude", "--scenario=trivial-read"]);
    eq(parsed.agent, "claude");
    eq(parsed.scenario, "trivial-read");
    eq(parsed.live, false);
    eq(parsed.errors.length, 0);
  });

  test("--live is recognised as a flag with no value", () => {
    const parsed = parseArgs(["--agent=codex", "--scenario=trivial-read", "--live"]);
    eq(parsed.live, true);
    eq(parsed.errors.length, 0);
  });

  test("a missing --agent is reported by name", () => {
    const parsed = parseArgs(["--scenario=trivial-read"]);
    eq(parsed.agent, null);
    ok(parsed.errors.some((e) => e.includes("--agent")), JSON.stringify(parsed.errors));
  });

  test("an invalid --agent value is reported, naming what was actually typed", () => {
    const parsed = parseArgs(["--agent=windows", "--scenario=trivial-read"]);
    eq(parsed.agent, null);
    ok(parsed.errors.some((e) => e.includes("windows")), JSON.stringify(parsed.errors));
  });

  test("a missing --scenario is reported by name", () => {
    const parsed = parseArgs(["--agent=claude"]);
    eq(parsed.scenario, null);
    ok(parsed.errors.some((e) => e.includes("--scenario")), JSON.stringify(parsed.errors));
  });

  test("an unknown scenario id is reported, listing the known ones", () => {
    const parsed = parseArgs(["--agent=claude", "--scenario=does-not-exist"]);
    eq(parsed.scenario, null);
    ok(parsed.errors.some((e) => e.includes("does-not-exist") && e.includes("cross-repo-delegation")), JSON.stringify(parsed.errors));
  });

  test("an unrecognised argument is reported without silently being ignored", () => {
    const parsed = parseArgs(["--agent=claude", "--scenario=trivial-read", "--bogus"]);
    ok(parsed.errors.some((e) => e.includes("--bogus")), JSON.stringify(parsed.errors));
  });

  test("hostHomeEnv points Claude at CLAUDE_CONFIG_DIR and Codex at CODEX_HOME, not at each other's variable", () => {
    const claudeEnv = hostHomeEnv("C:\\scratch", "claude");
    eq(claudeEnv.CLAUDE_CONFIG_DIR, "C:\\scratch\\.claude");
    eq(claudeEnv.CODEX_HOME, undefined);

    const codexEnv = hostHomeEnv("C:\\scratch", "codex");
    eq(codexEnv.CODEX_HOME, "C:\\scratch\\.codex");
    eq(codexEnv.CLAUDE_CONFIG_DIR, undefined);
  });

  test("transcriptStoreDir resolves under each host's own scratch subdirectory", () => {
    eq(transcriptStoreDir("C:\\scratch", "claude"), "C:\\scratch\\.claude\\projects");
    eq(transcriptStoreDir("C:\\scratch", "codex"), "C:\\scratch\\.codex\\sessions");
  });

  test("newestJsonl returns null for a directory with no .jsonl files", () => {
    eq(newestJsonl(path.join(__dirname, "does-not-exist-at-all")), null);
  });

  test("renderScorecard renders one line per result, its strength, and a pass/warn/fail summary", () => {
    const text = renderScorecard([
      { id: "memory-written", verdict: "PASS", strength: "heuristic", detail: "ok" },
      { id: "tier-named", verdict: "FAIL", strength: "mechanical", detail: "no model named" },
      { id: "standards-obeyed", verdict: "WARN", strength: "mechanical", detail: "would ask" },
    ]);
    ok(/PASS\s+memory-written\s+\[heuristic\]/.test(text), text);
    ok(/FAIL\s+tier-named\s+\[mechanical\]/.test(text), text);
    ok(/WARN\s+standards-obeyed\s+\[mechanical\]/.test(text), text);
    ok(text.includes("1/3 assertions passed, 1 warned, 1 failed"), text);
    ok(text.includes("2 mechanical, 1 heuristic"), text);
  });
});

suite("acceptance/run-cli non-live scoring end to end", ({ test, eq, ok }) => {
  test("the trivial-read scenario, scored against its own recorded fixture, exits 0 for both hosts", () => {
    for (const agent of ["claude", "codex"]) {
      const result = runCli([`--agent=${agent}`, "--scenario=trivial-read"]);
      eq(result.code, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      ok(result.stdout.includes("assertions passed"), result.stdout);
      ok(!result.stdout.includes("FAIL"), result.stdout);
    }
  });

  test("the cross-repo-delegation scenario, scored against its own rejected-shaped fixture, exits 1 and prints every failure for both hosts", () => {
    for (const agent of ["claude", "codex"]) {
      const result = runCli([`--agent=${agent}`, "--scenario=cross-repo-delegation"]);
      eq(result.code, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      ok(result.stdout.includes("FAIL  memory-written"), result.stdout);
      ok(result.stdout.includes("FAIL  standards-obeyed"), result.stdout);
      ok(result.stdout.includes("0/7 assertions passed"), result.stdout);
    }
  });

  test("an invalid invocation exits 1 with a usage line on stderr, never a stack trace", () => {
    const result = runCli(["--agent=bogus", "--scenario=trivial-read"]);
    eq(result.code, 1);
    ok(result.stderr.includes("usage:"), result.stderr);
    ok(!result.stderr.includes("at Object."), "a clean argument refusal should never print a JS stack trace");
  });
});
