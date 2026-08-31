"use strict";

/**
 * Covers the interactive module-selection step `install`/`update` run
 * before the per-option questions: on a first install, a multi-select of
 * which shipped modules to enable (defaults pre-marked); on any later
 * interactive run, a printed summary of the currently stored configuration
 * plus a "continue or change it" question, defaulting to "continue" so a
 * routine re-run behaves exactly as it always has.
 *
 * `moduleRequiresClosure`'s own dependency-auto-enable behaviour is unit
 * tested directly against synthetic module lists — no shipped `module.json`
 * declares a `requires` dependency today (checked below), so this is the
 * only way to exercise it.
 *
 * Every CLI-level case here follows `interactive-options.test.js`'s own
 * discipline: `SOFTELA_AI_FORCE_TTY=1` drives the installer's real interactive
 * path over a still-piped stdin, never a parallel test-only copy of the
 * prompting logic.
 */

const { suite } = require("../harness");
const { runCli, readState } = require("./_home");
const { moduleRequiresClosure } = require("../../core/installer/index.js");
const detect = require("../../core/installer/detect");

/** Forces `isInteractiveStdin()` to treat this run's piped stdin as a terminal. */
const FORCE_TTY_ENV = { SOFTELA_AI_FORCE_TTY: "1" };

/**
 * Counts non-overlapping occurrences of a substring — used to assert a
 * question rendered exactly once (or exactly once per group), rather than
 * only checking the final stored state, which stayed correct even before
 * the multi-agent question-deduplication fix this file also covers.
 *
 * @param {string} haystack The text to search.
 * @param {string} needle The substring to count.
 * @returns {number} The occurrence count.
 */
function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

suite("installer/module-selection", ({ test, eq, deepEq, ok, fakeHome }) => {
  test("moduleRequiresClosure auto-enables a direct dependency and reports it", () => {
    const allModules = [
      { id: "a", json: { requires: ["b"] } },
      { id: "b", json: { requires: [] } },
      { id: "c", json: { requires: [] } },
    ];
    const result = moduleRequiresClosure(["a"], allModules);
    deepEq(result.ids, ["a", "b"], "the dependency must be appended after the developer's own selection");
    deepEq(result.added, [{ id: "b", requiredBy: "a" }]);
  });

  test("moduleRequiresClosure resolves a transitive dependency chain", () => {
    const allModules = [
      { id: "a", json: { requires: ["b"] } },
      { id: "b", json: { requires: ["c"] } },
      { id: "c", json: { requires: [] } },
    ];
    const result = moduleRequiresClosure(["a"], allModules);
    deepEq(result.ids, ["a", "b", "c"]);
    deepEq(result.added, [
      { id: "b", requiredBy: "a" },
      { id: "c", requiredBy: "b" },
    ]);
  });

  test("moduleRequiresClosure never duplicates a dependency already selected, and ignores an unknown one", () => {
    const allModules = [
      { id: "a", json: { requires: ["b", "ghost"] } },
      { id: "b", json: { requires: [] } },
    ];
    const result = moduleRequiresClosure(["a", "b"], allModules);
    deepEq(result.ids, ["a", "b"]);
    deepEq(result.added, [], 'b was already selected, and "ghost" is not a real module — neither is reported as added');
  });

  test("no module this repository actually ships declares a requires dependency today — moduleRequiresClosure is unit-tested only, unexercised by the real CLI", () => {
    const allModules = detect.discoverModules();
    const anyRequires = allModules.some((m) => Array.isArray(m.json.requires) && m.json.requires.length > 0);
    ok(!anyRequires, "if this ever fails, a shipped module now declares requires — add a CLI-level auto-enable test alongside the unit tests above");
    const ids = allModules.map((m) => m.id);
    deepEq(moduleRequiresClosure(ids, allModules).ids, ids, "with no requires declared anywhere, the closure is a pure no-op over every shipped module id");
  });

  test("a first interactive install shows every shipped module, marks the defaultEnabled ones, and stores exactly what the developer selected — including deselecting one that is on by default", () => {
    const home = fakeHome();
    // The trailing blank line accepts the review step's own "Install now" default.
    const result = runCli(home, ["install", "--agent", "claude"], { env: FORCE_TTY_ENV, input: "1,3,4\n\n\n\n\n" });
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);
    ok(result.stdout.includes("Which modules should be enabled"), "the module-selection question must be asked on a first install");
    ok(result.stdout.includes("1) Agent orchestration"), `expected every shipped module listed, got:\n${result.stdout}`);
    ok(result.stdout.includes("5) Session cleanup"), "the not-defaultEnabled module must still be listed as a choice");
    ok(/Agent orchestration[^\n]*\(default\)/.test(result.stdout), "a defaultEnabled module must be marked (default)");
    ok(!/Session cleanup[^\n]*\(default\)/.test(result.stdout), "a module that is not defaultEnabled must not be marked (default)");

    const state = readState(home, "claude");
    deepEq(
      state.modules,
      ["agent-orchestration", "memory-as-context", "reply-language"],
      "typing \"1,3,4\" must deselect analyze-first (on by default) and never enable session-cleanup",
    );
  });

  test("selecting no modules at all installs with an empty module set and does not error", () => {
    const home = fakeHome();
    // The trailing blank line accepts the review step's own "Install now" default.
    const result = runCli(home, ["install", "--agent", "claude"], { env: FORCE_TTY_ENV, input: "none\n\n" });
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);
    deepEq(readState(home, "claude").modules, [], "an explicit empty selection must be respected, not silently replaced by the defaults");
  });

  test("--modules skips the module-selection question entirely, even though each option is still asked", () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "--agent", "claude", "--modules", "memory-as-context"], {
      env: FORCE_TTY_ENV,
      // The trailing blank line accepts the review step's own default.
      input: "global\non\n\n",
    });
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);
    ok(!result.stdout.includes("Which modules should be enabled"), "--modules must skip the module-selection question");
    deepEq(readState(home, "claude").modules, ["memory-as-context"]);
  });

  test("--yes skips the module-selection question and takes the defaultEnabled set", () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "--agent", "claude", "--yes"], { env: FORCE_TTY_ENV });
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);
    ok(!result.stdout.includes("Which modules should be enabled"), "--yes must skip the module-selection question");
    deepEq(
      readState(home, "claude").modules.slice().sort(),
      ["agent-orchestration", "analyze-first", "memory-as-context"],
    );
  });

  test("a non-TTY install skips the module-selection question, takes the defaultEnabled set, and never blocks", () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "--agent", "claude"]);
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);
    ok(!result.stdout.includes("Which modules should be enabled"), "a non-interactive stdin must never be asked the module-selection question");
    deepEq(
      readState(home, "claude").modules.slice().sort(),
      ["agent-orchestration", "analyze-first", "memory-as-context"],
    );
  });

  test("module enable never prompts, even on a forced-interactive stdin", () => {
    const home = fakeHome();
    const first = runCli(home, ["install", "--agent", "claude", "--yes", "--modules", "reply-language"]);
    eq(first.code, 0, `first install stdout:\n${first.stdout}\n${first.stderr}`);

    const result = runCli(home, ["module", "enable", "memory-as-context", "--agent", "claude"], { env: FORCE_TTY_ENV });
    eq(result.code, 0, `module enable stdout:\n${result.stdout}\n${result.stderr}`);
    ok(!result.stdout.includes("Which modules should be enabled"), "module enable must never show the module-selection question");
    ok(!result.stdout.includes("current configuration"), "module enable must never show the reconfigure summary either");
    ok(readState(home, "claude").modules.includes("memory-as-context"));
  });

  test("a second interactive install prints the current configuration and asks; answering \"continue\" (Enter) stores exactly the same state as before, byte for byte", () => {
    const home = fakeHome();
    // Each trailing blank line accepts the review step's own "Install now" default.
    const first = runCli(home, ["install", "--agent", "claude", "--modules", "memory-as-context,reply-language"], {
      env: FORCE_TTY_ENV,
      input: "infrastructure\noff\nde, fr\n\n",
    });
    eq(first.code, 0, `first install stdout:\n${first.stdout}\n${first.stderr}`);
    const before = readState(home, "claude");
    deepEq(before.options["memory-as-context"], { location: "infrastructure", checkpoint: "off" });
    deepEq(before.options["reply-language"], { languages: ["de", "fr"] });

    const result = runCli(home, ["install", "--agent", "claude"], { env: FORCE_TTY_ENV, input: "\n\n" });
    eq(result.code, 2, `a "continue" answer with nothing left to apply reports "nothing to do":\n${result.stdout}\n${result.stderr}`);
    ok(result.stdout.includes("current configuration:"), "a later interactive run must print the stored configuration");
    ok(result.stdout.includes("Continue with this configuration, or change it?"), "a later interactive run must ask to continue or change");
    ok(!result.stdout.includes("Which modules should be enabled"), '"continue" must never fall through to the module multi-select');
    ok(!result.stdout.includes("for claude"), "a single-agent run's prompt text must not carry an agent name — it never varies, so it is noise");

    deepEq(readState(home, "claude"), before, 'answering "continue" must leave the stored state byte-for-byte unchanged');
  });

  test('"change it" re-asks every question with the CURRENT stored value as its default — pressing Enter through all of them reproduces the stored state unchanged', () => {
    const home = fakeHome();
    // The trailing blank line accepts the review step's own default.
    const first = runCli(home, ["install", "--agent", "claude", "--modules", "memory-as-context,reply-language"], {
      env: FORCE_TTY_ENV,
      input: "infrastructure\noff\nde, fr\n\n",
    });
    eq(first.code, 0, `first install stdout:\n${first.stdout}\n${first.stderr}`);
    const before = readState(home, "claude");

    // change -> module multi-select (blank, keep both) -> location, checkpoint,
    // languages (each blank, keep stored) -> review (blank, install now).
    const result = runCli(home, ["install", "--agent", "claude"], { env: FORCE_TTY_ENV, input: "change\n\n\n\n\n\n" });
    eq(result.code, 2, `install stdout:\n${result.stdout}\n${result.stderr}`);
    ok(/infrastructure[^\n]*\(default\)/.test(result.stdout), "the location question must offer the CURRENT stored value as its default, not the module's shipped default");
    ok(/\boff\b[^\n]*\(default\)/.test(result.stdout), "the checkpoint question must offer the current stored value as its default");

    deepEq(readState(home, "claude"), before, "pressing Enter through every reconfigure question must reproduce the exact same stored state");
  });

  test('"change it" deselecting a module removes it from the enabled set but leaves its stored options untouched, so a later re-enable does not lose what it had', () => {
    const home = fakeHome();
    const first = runCli(home, ["install", "--agent", "claude", "--modules", "memory-as-context", "--yes"]);
    eq(first.code, 0, `first install stdout:\n${first.stdout}\n${first.stderr}`);
    deepEq(readState(home, "claude").modules, ["memory-as-context"]);

    // change -> module multi-select ("none") -> review (blank, install now);
    // deselecting every module leaves no option question to ask.
    const result = runCli(home, ["install", "--agent", "claude"], { env: FORCE_TTY_ENV, input: "change\nnone\n\n" });
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);

    const state = readState(home, "claude");
    deepEq(state.modules, [], "memory-as-context must be disabled after deselecting it in the module multi-select");
    deepEq(
      state.options["memory-as-context"],
      { location: "global", checkpoint: "on" },
      "a disabled module's own stored option values must survive in state.json, not be wiped",
    );
  });

  test("an interactive update with stored state shows the same summary and asks the same question install does", () => {
    const home = fakeHome();
    const first = runCli(home, ["install", "--agent", "claude", "--yes"]);
    eq(first.code, 0, `first install stdout:\n${first.stdout}\n${first.stderr}`);

    // The trailing blank line accepts the review step's own default.
    const result = runCli(home, ["update", "--agent", "claude"], { env: FORCE_TTY_ENV, input: "\n\n" });
    ok(result.code !== 1, `update must not error:\n${result.stdout}\n${result.stderr}`);
    ok(result.stdout.includes("current configuration:"), "update must print the same stored-configuration summary install does");
    ok(result.stdout.includes("Continue with this configuration, or change it?"), "update must ask the same continue/change question install does");
  });

  test("a non-TTY update, --yes update and --modules update each print no module question at all", () => {
    const home = fakeHome();
    const first = runCli(home, ["install", "--agent", "claude", "--yes"]);
    eq(first.code, 0, `first install stdout:\n${first.stdout}\n${first.stderr}`);

    const nonTty = runCli(home, ["update", "--agent", "claude"]);
    ok(!nonTty.stdout.includes("current configuration:"), "a non-TTY update must never print the reconfigure summary");

    const withYes = runCli(home, ["update", "--agent", "claude", "--yes"], { env: FORCE_TTY_ENV });
    ok(!withYes.stdout.includes("current configuration:"), "--yes must skip the reconfigure question on update too");

    const withModules = runCli(home, ["update", "--agent", "claude", "--modules", "memory-as-context"], { env: FORCE_TTY_ENV });
    ok(!withModules.stdout.includes("current configuration:"), "--modules must skip the reconfigure question on update too");
  });

  test("--agent all on two fresh homes asks the module question and each option question exactly once, and both agents end up with the identical stored configuration", () => {
    const home = fakeHome();
    // The trailing blank line accepts the review step's own "Install now" default.
    const result = runCli(home, ["install", "--agent", "all"], { env: FORCE_TTY_ENV, input: "1,3,4\n\n\n\n\n" });
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);

    eq(countOccurrences(result.stdout, "Which modules should be enabled"), 1, "the module-selection question must be asked exactly once for two fresh agents, not once per agent");
    eq(countOccurrences(result.stdout, "Where should memory live"), 1, "the location question must be asked exactly once");
    eq(countOccurrences(result.stdout, "Before a compaction"), 1, "the checkpoint question must be asked exactly once");
    eq(countOccurrences(result.stdout, "Which language(s) should replies use"), 1, "the languages question must be asked exactly once");
    // Scoped to the prompting text specifically — the closing summary
    // legitimately says "Installed for claude, codex.", which is a
    // different "for" this assertion must not trip over.
    ok(!result.stdout.includes("Which modules should be enabled for"), "the module-selection question for a single group covering both agents must not name either one");

    const claudeState = readState(home, "claude");
    const codexState = readState(home, "codex");
    deepEq(claudeState.modules, ["agent-orchestration", "memory-as-context", "reply-language"]);
    deepEq(codexState.modules, claudeState.modules, "both agents must end up with the identical stored module set");
    deepEq(claudeState.options, codexState.options, "both agents must end up with the identical stored option values");
  });

  test("--agent all where both agents are installed identically prints the stored configuration once and asks continue/change once", () => {
    const home = fakeHome();
    const first = runCli(home, ["install", "--agent", "all", "--yes"]);
    eq(first.code, 0, `first install stdout:\n${first.stdout}\n${first.stderr}`);

    const result = runCli(home, ["install", "--agent", "all"], { env: FORCE_TTY_ENV, input: "\n\n" });
    eq(result.code, 2, `install stdout:\n${result.stdout}\n${result.stderr}`);
    eq(countOccurrences(result.stdout, "current configuration:"), 1, "the stored configuration must print exactly once for two identically-configured agents");
    eq(countOccurrences(result.stdout, "Continue with this configuration, or change it?"), 1, "the continue/change question must be asked exactly once");
  });

  test("--agent all where the two agents' stored configurations differ asks separately, each labelled with the agent it is for", () => {
    const home = fakeHome();
    const claudeFirst = runCli(home, ["install", "--agent", "claude", "--modules", "memory-as-context", "--yes", "--memory-location", "repo"]);
    eq(claudeFirst.code, 0, `claude first install stdout:\n${claudeFirst.stdout}\n${claudeFirst.stderr}`);
    const codexFirst = runCli(home, ["install", "--agent", "codex", "--modules", "memory-as-context", "--yes", "--memory-location", "global"]);
    eq(codexFirst.code, 0, `codex first install stdout:\n${codexFirst.stdout}\n${codexFirst.stderr}`);

    // The trailing blank line accepts the review step's own default.
    const result = runCli(home, ["install", "--agent", "all"], { env: FORCE_TTY_ENV, input: "\n\n\n" });
    eq(result.code, 2, `install stdout:\n${result.stdout}\n${result.stderr}`);
    eq(countOccurrences(result.stdout, "current configuration for claude:"), 1, "claude's differing configuration must be printed separately, labelled");
    eq(countOccurrences(result.stdout, "current configuration for codex:"), 1, "codex's differing configuration must be printed separately, labelled");
    eq(countOccurrences(result.stdout, "Continue with this configuration for claude, or change it?"), 1);
    eq(countOccurrences(result.stdout, "Continue with this configuration for codex, or change it?"), 1);
  });

  test("--agent all with one fresh agent and one already-installed agent produces two groups, each correctly labelled", () => {
    const home = fakeHome();
    const claudeFirst = runCli(home, ["install", "--agent", "claude", "--yes"]);
    eq(claudeFirst.code, 0, `claude first install stdout:\n${claudeFirst.stdout}\n${claudeFirst.stderr}`);
    // codex has never been installed — its state, and possibly its home
    // directory, do not exist yet.

    // The trailing blank line accepts the review step's own "Install now" default.
    const result = runCli(home, ["install", "--agent", "all"], { env: FORCE_TTY_ENV, input: "\n\n\n\n\n\n" });
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);
    ok(result.stdout.includes("current configuration for claude:"), "the already-installed agent's group must print its stored configuration, labelled");
    ok(result.stdout.includes("Which modules should be enabled for codex?"), "the fresh agent's group must ask the module-selection question, labelled");

    const codexState = readState(home, "codex");
    deepEq(codexState.modules.slice().sort(), ["agent-orchestration", "analyze-first", "memory-as-context"]);
  });

  test("--agent all still asks nothing on every skip path: non-TTY, --yes, --modules", () => {
    const nonTtyHome = fakeHome();
    const nonTty = runCli(nonTtyHome, ["install", "--agent", "all"]);
    eq(nonTty.code, 0, `non-TTY install stdout:\n${nonTty.stdout}\n${nonTty.stderr}`);
    ok(!nonTty.stdout.includes("Which modules should be enabled"), "a non-TTY --agent all install must never ask");

    const yesHome = fakeHome();
    const withYes = runCli(yesHome, ["install", "--agent", "all", "--yes"], { env: FORCE_TTY_ENV });
    eq(withYes.code, 0, `--yes install stdout:\n${withYes.stdout}\n${withYes.stderr}`);
    ok(!withYes.stdout.includes("Which modules should be enabled"), "--yes must skip the module-selection question for --agent all too");

    const modulesHome = fakeHome();
    // The trailing blank line accepts the review step's own default.
    const withModules = runCli(modulesHome, ["install", "--agent", "all", "--modules", "memory-as-context"], { env: FORCE_TTY_ENV, input: "global\non\n\n" });
    eq(withModules.code, 0, `--modules install stdout:\n${withModules.stdout}\n${withModules.stderr}`);
    ok(!withModules.stdout.includes("Which modules should be enabled"), "--modules must skip the module-selection question for --agent all too");
  });
});
