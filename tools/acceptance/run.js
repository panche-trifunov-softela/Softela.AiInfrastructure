#!/usr/bin/env node
"use strict";

/**
 * Layer 2: `node tools/acceptance/run.js --agent=claude|codex --scenario=<id> [--live]`.
 *
 * Without `--live`: scores the scenario's own recorded fixture transcript
 * (`tools/acceptance/fixtures/<agent>/<scenario.fixture>.jsonl`) against a
 * freshly-built scratch git repository — deterministic, costs nothing, and
 * the mode anyone can run, including in CI.
 *
 * With `--live`: builds a scratch agent home, installs this repository's
 * rules into it through the real CLI, drives the real agent binary against
 * the scenario's own prompt inside a freshly-built scratch git repository,
 * locates the transcript the agent itself just wrote, saves a copy under
 * `tools/acceptance/captures/`, then scores THAT. Never run automatically —
 * it costs money and needs a real, authenticated agent binary.
 *
 * Every piece `--live` needs beyond the non-`--live` path — argument
 * parsing, scenario/fixture resolution, and the scratch home/repo setup —
 * is separated into its own function specifically so it can be exercised
 * without ever launching an agent (`tests/acceptance/run-cli.test.js`,
 * `tests/acceptance/scratch-setup.test.js`).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { normalizeTranscript } = require("./transcript");
const { score } = require("./score");
const { getScenario, SCENARIOS } = require("./scenarios");
const { buildFixtureRepo } = require("./fixture-repo");
const { buildScratchHome, installInto, readInstalledModules } = require("./scratch-home");
const { locateClaudeBinary, locateCodexBinary, walkFiles } = require("./binaries");

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const CAPTURES_DIR = path.join(__dirname, "captures");

/**
 * Parses this script's own CLI arguments.
 *
 * @param {string[]} argv Arguments after the script name, e.g.
 * `process.argv.slice(2)`.
 * @returns {{agent: string | null, scenario: string | null, live: boolean, errors: string[]}}
 * `agent`/`scenario` are `null` when missing or unrecognised — `errors`
 * names exactly why, so a caller can print a precise refusal instead of a
 * generic usage dump.
 */
function parseArgs(argv) {
  let agentRaw = null;
  let scenarioRaw = null;
  let live = false;
  const errors = [];

  for (const token of argv) {
    if (token === "--live") {
      live = true;
    } else if (token.startsWith("--agent=")) {
      agentRaw = token.slice("--agent=".length);
    } else if (token.startsWith("--scenario=")) {
      scenarioRaw = token.slice("--scenario=".length);
    } else {
      errors.push(`unrecognised argument "${token}"`);
    }
  }

  if (agentRaw === null) errors.push("missing --agent=claude|codex");
  else if (agentRaw !== "claude" && agentRaw !== "codex") errors.push(`--agent must be "claude" or "codex", got "${agentRaw}"`);

  if (scenarioRaw === null) errors.push("missing --scenario=<id>");
  else if (!getScenario(scenarioRaw)) {
    errors.push(`unknown scenario "${scenarioRaw}" — known scenarios: ${Object.keys(SCENARIOS).join(", ")}`);
  }

  return {
    agent: agentRaw === "claude" || agentRaw === "codex" ? agentRaw : null,
    scenario: scenarioRaw && getScenario(scenarioRaw) ? scenarioRaw : null,
    live,
    errors,
  };
}

/**
 * Creates a disposable directory under the OS temp directory — this
 * script's own equivalent of the test harness's `tmpdir()`, since `run.js`
 * runs outside that harness.
 *
 * @returns {string} The created directory's absolute path.
 */
function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "softela-ai-acceptance-"));
}

/**
 * Reads a scenario's own recorded fixture transcript.
 *
 * @param {object} scenario A scenario from `tools/acceptance/scenarios`.
 * @param {"claude" | "codex"} agent Which host's fixture to read.
 * @returns {string} The raw `.jsonl` content.
 */
function readFixtureTranscript(scenario, agent) {
  const file = path.join(FIXTURES_DIR, agent, `${scenario.fixture}.jsonl`);
  return fs.readFileSync(file, "utf8");
}

/**
 * Resolves the environment override that points a real agent binary at a
 * scratch home — distinct from `SOFTELA_AI_HOME` (`core/lib/paths.js`), which
 * points the INSTALLER at the same physical directory from the other side:
 * `SOFTELA_AI_HOME` names the parent a `.claude`/`.codex` folder lives under,
 * while a real host binary is pointed at that `.claude`/`.codex` folder
 * itself — `CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for Codex
 * (`tests/probes/README.md`'s own "Isolation" section documents both).
 *
 * @param {string} scratchHome The scratch home {@link buildScratchHome}
 * built.
 * @param {"claude" | "codex"} agent Which host is about to run.
 * @returns {object} The environment variable(s) to add.
 */
function hostHomeEnv(scratchHome, agent) {
  return agent === "codex"
    ? { CODEX_HOME: path.join(scratchHome, ".codex") }
    : { CLAUDE_CONFIG_DIR: path.join(scratchHome, ".claude") };
}

/**
 * Resolves the directory a real agent binary writes its own transcripts
 * into, under a scratch home.
 *
 * @param {string} scratchHome The scratch home {@link buildScratchHome}
 * built.
 * @param {"claude" | "codex"} agent Which host's transcript store to
 * resolve.
 * @returns {string} The directory to search for a newly-written transcript.
 */
function transcriptStoreDir(scratchHome, agent) {
  return agent === "codex" ? path.join(scratchHome, ".codex", "sessions") : path.join(scratchHome, ".claude", "projects");
}

/**
 * Finds the most recently modified `.jsonl` file under a directory tree —
 * the transcript a just-finished agent run wrote, when nothing else could
 * have written into a scratch home built fresh for this one run.
 *
 * @param {string} dir The directory to search.
 * @returns {string | null} The newest file's absolute path, or `null` when
 * none was found.
 */
function newestJsonl(dir) {
  const files = walkFiles(dir).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) return null;
  let newest = files[0];
  let newestMtime = fs.statSync(newest).mtimeMs;
  for (const f of files.slice(1)) {
    const mtime = fs.statSync(f).mtimeMs;
    if (mtime > newestMtime) {
      newest = f;
      newestMtime = mtime;
    }
  }
  return newest;
}

/**
 * Drives the real agent binary against a scenario's own prompt, inside a
 * scratch repository, with this repository's rules already installed into
 * the scratch home — the actual `--live` behaviour.
 *
 * Claude Code's own non-interactive single-prompt invocation is not
 * independently verified against a real binary the way Codex's
 * `exec --skip-git-repo-check` is (`docs/internal/CONTRACTS.md`,
 * `tests/probes/`) — this repository's own probe suite states plainly that
 * driving a real, authenticated Claude Code session has no offline way to
 * verify yet. The invocation below is this module's best-effort reading of
 * the documented CLI shape; treat a `--live --agent=claude` run's exact
 * flags as unverified until a probe confirms them the way the Codex path
 * already is.
 *
 * @param {"claude" | "codex"} agent Which host to drive.
 * @param {string} prompt The scenario's own prompt.
 * @param {string} repoCwd The scratch repository to run inside.
 * @param {string} scratchHome The scratch home the binary should read its
 * configuration and write its transcript into.
 * @returns {{code: number, stdout: string, stderr: string}} The captured
 * outcome.
 */
function driveLiveAgent(agent, prompt, repoCwd, scratchHome) {
  const env = { ...process.env, ...hostHomeEnv(scratchHome, agent) };

  if (agent === "codex") {
    const codexPath = locateCodexBinary();
    if (!codexPath) throw new Error("codex binary not found — see tools/acceptance/binaries.js#locateCodexBinary");
    const result = spawnSync(codexPath, ["exec", "--skip-git-repo-check", prompt], { cwd: repoCwd, env, encoding: "utf8", timeout: 600000 });
    return { code: result.status === null ? -1 : result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
  }

  const claude = locateClaudeBinary();
  if (!claude) throw new Error("claude binary not found on PATH — see tools/acceptance/binaries.js#locateClaudeBinary");
  const result = spawnSync(claude.command, [...claude.prefixArgs, "--print", prompt], { cwd: repoCwd, env, encoding: "utf8", timeout: 600000 });
  return { code: result.status === null ? -1 : result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

/**
 * Runs the full `--live` flow: scratch home, real install, real agent
 * binary, captured transcript saved under `tools/acceptance/captures/`.
 *
 * @param {object} scenario The scenario to run.
 * @param {"claude" | "codex"} agent Which host to drive.
 * @returns {{content: string, modules: string[]}} `content` is the captured
 * transcript's raw content; `modules` is the module set the real install
 * actually wrote into the scratch home's own state
 * ({@link readInstalledModules}) — the real replay input `standards-obeyed`
 * must be scored against, never a scenario's own hand-maintained module
 * list, which the live agent binary this function just drove was never
 * bound by.
 */
function runLive(scenario, agent) {
  const scratchParent = tmpdir();
  const scratchHome = buildScratchHome(scratchParent);

  const installResult = installInto(scratchHome, agent);
  if (installResult.code !== 0) {
    throw new Error(`scratch install failed (exit ${installResult.code}): ${installResult.stderr || installResult.stdout}`);
  }
  const modules = readInstalledModules(scratchHome, agent);

  const { repo } = buildFixtureRepo(tmpdir, scenario.repo);
  const runResult = driveLiveAgent(agent, scenario.prompt, repo, scratchHome);
  if (runResult.code !== 0) {
    process.stderr.write(`softela-ai acceptance: live agent run exited ${runResult.code}\n${runResult.stderr}\n`);
  }

  const transcriptPath = newestJsonl(transcriptStoreDir(scratchHome, agent));
  if (!transcriptPath) throw new Error("no transcript was written by the live agent run");

  const content = fs.readFileSync(transcriptPath, "utf8");
  fs.mkdirSync(path.join(CAPTURES_DIR, agent), { recursive: true });
  const savedAs = path.join(CAPTURES_DIR, agent, `${scenario.id}-${Date.now()}.jsonl`);
  fs.writeFileSync(savedAs, content, "utf8");
  process.stderr.write(`softela-ai acceptance: captured transcript saved to ${savedAs}\n`);

  return { content, modules };
}

/**
 * Renders a scorecard a human reads in five seconds: one line per
 * assertion, its verdict, its strength class, and its own one-line evidence
 * summary — plus a summary line that states passed/warned/failed counts
 * separately, so "N passed" can never read as "N/M were fine" when some of
 * those N were actually a real dispatcher `ask` a live session would have
 * stopped for.
 *
 * @param {{id: string, verdict: string, strength: string, detail: string}[]} results
 * A `tools/acceptance/score.js#score` result.
 * @returns {string} The rendered scorecard, ending in a newline.
 */
function renderScorecard(results) {
  const idWidth = Math.max(...results.map((r) => r.id.length));
  const lines = results.map((r) => `${r.verdict.padEnd(4)}  ${r.id.padEnd(idWidth)}  [${r.strength}]  ${r.detail}`);
  const passed = results.filter((r) => r.verdict === "PASS").length;
  const warned = results.filter((r) => r.verdict === "WARN").length;
  const failed = results.filter((r) => r.verdict === "FAIL").length;
  const mechanical = results.filter((r) => r.strength === "mechanical").length;
  const heuristic = results.filter((r) => r.strength === "heuristic").length;
  lines.push("");
  lines.push(
    `${passed}/${results.length} assertions passed, ${warned} warned, ${failed} failed` +
      `  —  ${mechanical} mechanical, ${heuristic} heuristic`,
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Runs the whole CLI: parse, resolve, score, print, exit.
 *
 * @returns {void}
 */
function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.errors.length) {
    process.stderr.write(`softela-ai acceptance: ${parsed.errors.join("; ")}\n`);
    process.stderr.write("usage: node tools/acceptance/run.js --agent=claude|codex --scenario=<id> [--live]\n");
    process.exitCode = 1;
    return;
  }

  const scenario = getScenario(parsed.scenario);
  const { repo } = buildFixtureRepo(tmpdir, scenario.repo);

  // `--live` scores against the REAL module set a real install just wrote
  // into the scratch home (`runLive`'s own `modules`), never the scenario's
  // own hardcoded array — the non-`--live` path has no install to read from,
  // so it keeps falling back to the scenario's own declared modules exactly
  // as before (`score()`'s own `scenario.modules` fallback).
  const scoreOptions = { agent: parsed.agent, repoRoot: repo };
  let transcriptText;
  if (parsed.live) {
    const live = runLive(scenario, parsed.agent);
    transcriptText = live.content;
    scoreOptions.modules = live.modules;
  } else {
    transcriptText = readFixtureTranscript(scenario, parsed.agent);
  }
  const events = normalizeTranscript(parsed.agent, transcriptText);
  const results = score(events, scenario, scoreOptions);

  process.stdout.write(`scenario: ${scenario.id} (${parsed.live ? "live" : "recorded"}), agent: ${parsed.agent}\n\n`);
  process.stdout.write(renderScorecard(results));

  // Three-valued: a clean run exits 0; a run with no denial but at least one
  // real `ask` a live session would have stopped for exits 2, distinct from
  // a denial's 1 — a CI script that only checks for non-zero still catches
  // both, but the two are told apart for anything that wants to.
  const hasFail = results.some((r) => r.verdict === "FAIL");
  const hasWarn = results.some((r) => r.verdict === "WARN");
  process.exitCode = hasFail ? 1 : hasWarn ? 2 : 0;
}

if (require.main === module) main();

module.exports = { parseArgs, readFixtureTranscript, hostHomeEnv, transcriptStoreDir, newestJsonl, renderScorecard };
