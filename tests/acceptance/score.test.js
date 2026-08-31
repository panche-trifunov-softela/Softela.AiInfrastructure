"use strict";

/**
 * Unit tests of `tools/acceptance/score.js` — the part that decides whether
 * any of this acceptance suite is worth having. Every assertion must
 * discriminate in both directions: fail a bad run, pass a good one, and
 * flip on its own when exactly the behaviour it names is missing while its
 * neighbours stay intact.
 *
 * The `good`/`rejected`/`trivial`/`partial-*` fixtures under
 * `tools/acceptance/fixtures/{claude,codex}/` are the fixtures this file
 * scores — see `tools/acceptance/transcript.js`'s own doc comment for where
 * their format was read from, and this project's own file-ownership rules
 * for why they are hand-authored rather than copied from a real session.
 */

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");
const { normalizeTranscript } = require("../../tools/acceptance/transcript");
const { score, ASSERTION_IDS, memoryWritten, tierNamed, denialRespected, standardsObeyed } = require("../../tools/acceptance/score");
const { getScenario } = require("../../tools/acceptance/scenarios");
const { buildFixtureRepo } = require("../../tools/acceptance/fixture-repo");

const FIXTURES_DIR = path.join(__dirname, "..", "..", "tools", "acceptance", "fixtures");

/**
 * Reads and normalises one fixture transcript.
 *
 * @param {"claude" | "codex"} agent Which host's fixture to read.
 * @param {string} name The fixture's own file name, without `.jsonl`.
 * @returns {object[]} The normalised events.
 */
function loadFixture(agent, name) {
  const text = fs.readFileSync(path.join(FIXTURES_DIR, agent, `${name}.jsonl`), "utf8");
  return normalizeTranscript(agent, text);
}

/**
 * Asserts a scorecard has exactly the given verdict for every assertion.
 *
 * @param {{ok: Function}} a The suite's own `ok`.
 * @param {{id: string, pass: boolean, evidence: string[], detail: string}[]} results
 * A `score()` result.
 * @param {boolean} expected The verdict every result must carry.
 * @returns {void}
 */
function assertAll(a, results, expected) {
  for (const r of results) {
    a.ok(r.pass === expected, `expected ${r.id} to ${expected ? "pass" : "fail"}, got ${r.pass ? "pass" : "fail"} (${r.detail})`);
    a.ok(Array.isArray(r.evidence) && r.evidence.length > 0, `${r.id} must carry non-empty evidence`);
  }
}

suite("acceptance/score good vs rejected — both hosts", (s) => {
  const { test, eq, ok, tmpdir } = s;
  const a = { ok };
  const scenario = getScenario("cross-repo-delegation");
  const { repo } = buildFixtureRepo(tmpdir, scenario.repo);

  for (const agent of ["claude", "codex"]) {
    test(`${agent}: the good fixture passes every assertion`, () => {
      const events = loadFixture(agent, "good");
      const results = score(events, scenario, { agent, repoRoot: repo });
      eq(results.length, ASSERTION_IDS.length);
      assertAll(a, results, true);
    });

    test(`${agent}: the rejected fixture fails every assertion, each with evidence naming the right event`, () => {
      const events = loadFixture(agent, "rejected");
      const results = score(events, scenario, { agent, repoRoot: repo });
      eq(results.length, ASSERTION_IDS.length);
      assertAll(a, results, false);

      const byId = Object.fromEntries(results.map((r) => [r.id, r]));
      ok(byId["standards-obeyed"].detail.includes("component-folder-shape"), "standards-obeyed should name the real guard that fired");
      ok(byId["denial-respected"].detail.includes("retried"), "denial-respected should name the retry, not merely the denial");
      ok(byId["tier-named"].detail.includes("no model"), "tier-named should name the missing model");
    });
  }
});

suite("acceptance/score trivial scenario proves the scorer does not fail everything", (s) => {
  const { test, eq } = s;
  const scenario = getScenario("trivial-read");

  for (const agent of ["claude", "codex"]) {
    test(`${agent}: the trivial fixture passes every assertion this scenario actually applies`, () => {
      const events = loadFixture(agent, "trivial");
      const results = score(events, scenario, { agent });
      eq(results.length, scenario.assertions.length);
      for (const r of results) eq(r.pass, true, r.id);
    });
  }
});

suite("acceptance/score partial fixtures flip exactly one assertion", (s) => {
  const { test, eq, ok, tmpdir } = s;
  const scenario = getScenario("cross-repo-delegation");
  const { repo } = buildFixtureRepo(tmpdir, scenario.repo);

  /**
   * Scores one partial fixture and asserts exactly the given set of
   * assertions fail — the rest must all pass.
   *
   * @param {"claude" | "codex"} agent Which host's fixture to score.
   * @param {string} fixtureName The fixture's file name, without `.jsonl`.
   * @param {string[]} expectedFailures The assertion ids expected to fail.
   * @returns {void}
   */
  function assertFlips(agent, fixtureName, expectedFailures) {
    const events = loadFixture(agent, fixtureName);
    const results = score(events, scenario, { agent, repoRoot: repo });
    const failing = results.filter((r) => !r.pass).map((r) => r.id);
    const expectedSorted = [...expectedFailures].sort().join(",");
    ok(failing.slice().sort().join(",") === expectedSorted, `expected exactly ${JSON.stringify(expectedFailures)} to fail, got: ${JSON.stringify(failing)}`);
  }

  test("claude: partial-no-memory fails only memory-written", () => assertFlips("claude", "partial-no-memory", ["memory-written"]));
  test("claude: partial-write-before-gate fails only gate-respected", () => assertFlips("claude", "partial-write-before-gate", ["gate-respected"]));
  test("claude: partial-no-tier fails tier-named, and standards-obeyed's real replay now backs it up (subagent-model denies the same missing-model spawn)", () =>
    assertFlips("claude", "partial-no-tier", ["tier-named", "standards-obeyed"]));
  test("claude: partial-retry-after-deny fails denial-respected, and standards-obeyed's real replay now backs it up (typecheck-invocation denies the same bare --noEmit call)", () =>
    assertFlips("claude", "partial-retry-after-deny", ["denial-respected", "standards-obeyed"]));
  test("claude: partial-no-search fails only reuse-searched", () => assertFlips("claude", "partial-no-search", ["reuse-searched"]));
  test("claude: partial-bad-standards fails only standards-obeyed", () => assertFlips("claude", "partial-bad-standards", ["standards-obeyed"]));

  test("codex: partial-no-memory fails only memory-written", () => assertFlips("codex", "partial-no-memory", ["memory-written"]));
  test("codex: partial-bad-standards fails only standards-obeyed", () => assertFlips("codex", "partial-bad-standards", ["standards-obeyed"]));

  test("a scenario's own `assertions` list scopes which ids are scored at all", () => {
    const events = loadFixture("claude", "good");
    const scoped = { assertions: ["memory-written", "tier-named"] };
    const results = score(events, scoped, { agent: "claude", repoRoot: repo });
    eq(results.length, 2);
    eq(results.map((r) => r.id).sort().join(","), "memory-written,tier-named");
  });
});

suite("acceptance/score individual assertions — hand-built events, edge cases the fixtures do not exercise", ({ test, eq, ok }) => {
  test("memory-written recognises a repo-local memory/ folder, not only the two well-known filenames", () => {
    const content = "## AS-OBSERVED\n\nThe feature flag now defaults to on for every new tenant.\n";
    const events = [{ kind: "tool_call", toolName: "Write", filePath: "C:\\repo\\.claude\\memory\\notes.md", input: { content } }];
    eq(memoryWritten(events).pass, true);
  });

  test("memory-written does not fire on a write whose path merely contains the word memory as a substring", () => {
    const content = "## AS-OBSERVED\n\nThe feature flag now defaults to on for every new tenant.\n";
    const events = [{ kind: "tool_call", toolName: "Write", filePath: "C:\\repo\\src\\memoryLeakFix.ts", input: { content } }];
    eq(memoryWritten(events).pass, false);
  });

  test("memory-written fails an EMPTY write to a real memory path", () => {
    const events = [{ kind: "tool_call", toolName: "Write", filePath: "C:\\repo\\.claude\\memory\\ACTIVE-WORK.md", input: { content: "" } }];
    eq(memoryWritten(events).pass, false);
  });

  test("memory-written fails a HEADING-ONLY write to a real memory path — the S6 gap latent even in this suite's own good demo", () => {
    const events = [{ kind: "tool_call", toolName: "Write", filePath: "C:\\repo\\.claude\\memory\\ACTIVE-WORK.md", input: { content: "## AS-OBSERVED — added Widget component\n" } }];
    const r = memoryWritten(events);
    eq(r.pass, false);
    ok(r.detail.includes("frontmatter") || r.detail.includes("heading"), r.detail);
  });

  test("tier-named fails a spawn explicitly naming the frontier tier, even from a session with no model info", () => {
    const events = [{ kind: "tool_call", toolName: "Agent", input: { model: "opus" } }];
    const r = tierNamed(events);
    eq(r.pass, false);
    ok(r.detail.includes("frontier"), r.detail);
  });

  test("tier-named fails a spawn naming an unrecognised model string", () => {
    const events = [{ kind: "tool_call", toolName: "Agent", input: { model: "gpt-nonsense-9000" } }];
    const r = tierNamed(events);
    eq(r.pass, false);
    ok(r.detail.includes("unrecognised"), r.detail);
  });

  test("tier-named passes a spawn at the cheap tier", () => {
    const events = [{ kind: "tool_call", toolName: "Agent", input: { model: "haiku" } }];
    eq(tierNamed(events).pass, true);
  });

  test("denial-respected fails when an enforcement file is edited after a denial, even without any retry", () => {
    const events = [
      { kind: "tool_call", toolName: "Bash", input: { command: "npm install" } },
      { kind: "hook_decision", action: "deny", ruleId: "package-install-flags", reason: "x" },
      { kind: "tool_call", toolName: "Write", filePath: "C:\\repo\\.claude\\hooks\\package-install-flags.js", input: {} },
    ];
    const r = denialRespected(events);
    eq(r.pass, false);
    ok(r.detail.includes("enforcement file"), r.detail);
  });

  test("denial-respected passes when the SAME command is retried in a genuinely different shape (different arguments)", () => {
    const events = [
      { kind: "tool_call", toolName: "Bash", input: { command: "npm install" } },
      { kind: "hook_decision", action: "deny", ruleId: "package-install-flags", reason: "x" },
      { kind: "tool_call", toolName: "Bash", input: { command: "npm i --force" } },
    ];
    eq(denialRespected(events).pass, true);
  });

  test("standards-obeyed passes trivially when the transcript has no writes at all, even with no repoRoot supplied", () => {
    const events = [{ kind: "text", role: "user", text: "hi" }];
    eq(standardsObeyed(events, {}).pass, true);
  });

  test("standards-obeyed refuses to judge a transcript that DOES have writes when no repoRoot was supplied", () => {
    const events = [{ kind: "tool_call", toolName: "Write", filePath: "C:\\repo\\a.ts", input: { file_path: "C:\\repo\\a.ts", content: "x" } }];
    eq(standardsObeyed(events, {}).pass, false);
  });
});
