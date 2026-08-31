"use strict";

/**
 * The interactive first-run configuration step `install` runs before
 * computing its plan: for every `module.json` option belonging to a module
 * this run enables, on an interactive terminal with `--yes` not passed, no
 * dedicated flag already supplying the value, and no value already stored
 * from an earlier run, `install` asks the option's own declared `prompt`
 * instead of silently applying its default. Everywhere else — a non-TTY
 * stdin, `--yes`, a flag-supplied value, an already-answered option — the
 * pre-existing silent-default behaviour is unchanged, since `install` also
 * runs in CI and in every other test in this suite against a piped stdin.
 *
 * A real terminal cannot be driven from this suite. Every case here instead
 * sets `SOFTELA_AI_FORCE_TTY=1`, the seam `core/installer/index.js`'s
 * `isInteractiveStdin()` checks alongside `process.stdin.isTTY` — the exact
 * discipline `SOFTELA_AI_LOCK_STALE_MS` and `SOFTELA_AI_LOCK_WAIT_MS` already use in
 * `core/installer/manifest.js` to give a test control over a value the
 * production code otherwise reads from its real environment. stdin itself
 * stays the ordinary pipe `runCli` always spawns the CLI with; scripted
 * answers are written to that same pipe via `runCli`'s `input` option. This
 * drives the CLI's own real `readline` interface, its real per-option
 * validation and retry, and its real state write end to end — never a
 * parallel test-only copy of the prompting logic.
 */

const fs = require("fs");
const { suite } = require("../harness");
const { runCli, readState, installedRootPath } = require("./_home");

/** Forces `isInteractiveStdin()` to treat this run's piped stdin as a terminal. */
const FORCE_TTY_ENV = { SOFTELA_AI_FORCE_TTY: "1" };

suite("installer/interactive-options", ({ test, eq, deepEq, ok, fakeHome }) => {
  test("a non-TTY install asks nothing and stores every enabled module's declared defaults", () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "--agent", "claude", "--modules", "memory-as-context,reply-language"]);
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);
    ok(!result.stdout.includes("Where should memory live"), "a non-interactive stdin must never be asked a module option's prompt");

    const state = readState(home, "claude");
    deepEq(state.options["memory-as-context"], { location: "global", checkpoint: "on" });
    deepEq(state.options["reply-language"], { languages: ["English"] });
  });

  test("--yes skips every prompt even on a forced-interactive stdin", () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "--agent", "claude", "--yes", "--modules", "memory-as-context"], { env: FORCE_TTY_ENV });
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);
    ok(!result.stdout.includes("Where should memory live"), "--yes must suppress every option prompt regardless of stdin");

    const state = readState(home, "claude");
    deepEq(state.options["memory-as-context"], { location: "global", checkpoint: "on" });
  });

  test("a flag-supplied option value is applied without its own prompt, but a sibling option with no flag is still asked", () => {
    const home = fakeHome();
    // A trailing blank line accepts the review step's own default ("Install
    // now") once at least one question — here, `checkpoint` — was actually
    // asked; see the "review screen" suite below for the review itself.
    const result = runCli(
      home,
      ["install", "--agent", "claude", "--modules", "memory-as-context", "--memory-location", "global"],
      { env: FORCE_TTY_ENV, input: "off\n\n" },
    );
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);
    ok(!result.stdout.includes("Where should memory live"), "--memory-location already supplied a value; its own option must not be asked");
    ok(result.stdout.includes("Before a compaction"), "checkpoint has no dedicated flag and must still be asked");

    const state = readState(home, "claude");
    deepEq(state.options["memory-as-context"], { location: "global", checkpoint: "off" });
  });

  test("an already-answered option is not asked again on a later install", () => {
    const home = fakeHome();
    const first = runCli(home, ["install", "--agent", "claude", "--modules", "memory-as-context"], {
      env: FORCE_TTY_ENV,
      // The trailing blank line accepts the review step's own "Install now"
      // default, reached once both options have been asked.
      input: "global\noff\n\n",
    });
    eq(first.code, 0, `first install stdout:\n${first.stdout}\n${first.stderr}`);

    // Nothing left unanswered and nothing else changed, so this run should
    // find no more input even needing to be read — and, with nothing asked,
    // no review step either.
    const second = runCli(home, ["install", "--agent", "claude", "--modules", "memory-as-context"], {
      env: FORCE_TTY_ENV,
      input: "",
    });
    eq(second.code, 2, `a second install with nothing left to configure or change reports "nothing to do":\n${second.stdout}\n${second.stderr}`);
    ok(!second.stdout.includes("Where should memory live"), "an option already answered on a prior run must not be asked again");

    const state = readState(home, "claude");
    deepEq(state.options["memory-as-context"], { location: "global", checkpoint: "off" });
  });

  test("an invalid enum answer is re-asked, and a valid one is stored", () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "--agent", "claude", "--modules", "memory-as-context"], {
      env: FORCE_TTY_ENV,
      // "mars" is rejected and re-asked; the trailing blank line accepts the
      // review step's own "Install now" default.
      input: "mars\nglobal\n\n\n",
    });
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);
    ok(result.stdout.includes("is not one of"), "an invalid enum answer must be reported and the question re-asked");

    const state = readState(home, "claude");
    // "mars" was rejected and re-asked ("global" then applies); the
    // checkpoint question's blank-line answer accepts its own default.
    deepEq(state.options["memory-as-context"], { location: "global", checkpoint: "on" });
  });

  test("a repeatedly invalid enum answer falls back to the declared default after a bounded number of attempts, instead of looping forever", () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "--agent", "claude", "--modules", "memory-as-context"], {
      env: FORCE_TTY_ENV,
      // The trailing blank line accepts the review step's own default.
      input: "x\ny\nz\n\n\n",
    });
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);
    ok(result.stdout.includes("using the default"), "exhausting every attempt must fall back to the option's own default, not hang");

    const state = readState(home, "claude");
    deepEq(state.options["memory-as-context"], { location: "global", checkpoint: "on" });
  });

  test("a stringList answer is split and trimmed into the same shape --reply-language produces", () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "--agent", "claude", "--modules", "reply-language"], {
      env: FORCE_TTY_ENV,
      // The trailing blank line accepts the review step's own default.
      input: " de , en ,,fr \n\n",
    });
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);

    const state = readState(home, "claude");
    deepEq(state.options["reply-language"], { languages: ["de", "en", "fr"] });
  });

  test("a dry-run install still asks, so its preview reflects the answers, but writes nothing to disk", () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "--agent", "claude", "--modules", "memory-as-context", "--dry-run"], {
      env: FORCE_TTY_ENV,
      // The trailing blank line accepts the review step's own default —
      // "Continue to preview" under `--dry-run` (see the "review screen"
      // suite below).
      input: "global\noff\n\n",
    });
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);
    ok(result.stdout.includes("Where should memory live"), "a dry-run must still ask, or its preview would not reflect what a real install would apply");

    const state = readState(home, "claude");
    eq(state, null, "a dry-run must never write state.json, regardless of whether it asked anything");
  });
});

/**
 * The review step every interactive collection now ends with, once at least
 * one question was actually asked: everything chosen, printed and grouped,
 * followed by a confirmation before anything is written — and a "go back"
 * that jumps straight to a named step rather than restarting from scratch.
 */
suite("installer/interactive-options/review", ({ test, eq, deepEq, ok, fakeHome }) => {
  test("the review step lists the chosen module set and every option's chosen value before installing", () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "--agent", "claude", "--modules", "memory-as-context,reply-language"], {
      env: FORCE_TTY_ENV,
      input: "infrastructure\noff\nde, fr\n\n",
    });
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);
    ok(result.stdout.includes("configuration to install:"), `expected a review listing:\n${result.stdout}`);
    ok(
      result.stdout.includes("Memory as context — location: infrastructure, checkpoint: off"),
      `expected the review to list the chosen option values:\n${result.stdout}`,
    );
    ok(result.stdout.includes("Reply language — languages: de, fr"), `expected the review to list the reply-language values:\n${result.stdout}`);
    ok(result.stdout.includes("Install now"), "the review must offer to install now");
    ok(result.stdout.includes("Go back and change something"), "the review must offer to go back");

    const state = readState(home, "claude");
    deepEq(state.options["memory-as-context"], { location: "infrastructure", checkpoint: "off" });
    deepEq(state.options["reply-language"], { languages: ["de", "fr"] });
  });

  test("nothing is written to the agent home until the review is confirmed — stopping short of that leaves it untouched", () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "--agent", "claude", "--modules", "memory-as-context"], {
      env: FORCE_TTY_ENV,
      // Answers both options and reaches the review, but stdin ends right
      // there — no line ever answers "install now, or go back", so the run
      // never confirms and the code path that writes anything never runs.
      input: "global\non\n",
    });
    ok(result.stdout.includes("configuration to install:"), `expected the run to have reached the review step:\n${result.stdout}`);
    ok(!result.stdout.includes("Done."), "the closing summary must never print without a confirmed review");
    eq(readState(home, "claude"), null, "state.json must not exist — the review was never confirmed");
    ok(!fs.existsSync(installedRootPath(home, "claude")), "no payload must have been installed");
  });

  test('"go back and change something" jumps straight to a named step; answering it returns to the review with the new value, without re-asking the others', () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "--agent", "claude", "--modules", "memory-as-context"], {
      env: FORCE_TTY_ENV,
      // location(blank->global), checkpoint(blank->on), review -> "back" ->
      // pick "2) checkpoint" by name -> "off" -> back at a fresh review -> confirm.
      input: "\n\nback\n2\noff\n\n",
    });
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);
    ok(result.stdout.includes("Which step would you like to change?"), `expected the named-step menu:\n${result.stdout}`);
    ok(
      /2\) Before a compaction[^\n]*— on/.test(result.stdout),
      `expected the checkpoint entry in the named-step menu to carry its current answer as a hint:\n${result.stdout}`,
    );

    const state = readState(home, "claude");
    deepEq(state.options["memory-as-context"], { location: "global", checkpoint: "off" }, "the revised answer from the named step must land in the final result");
  });

  test("--yes and a non-interactive stdin both skip the review entirely", () => {
    const nonInteractiveHome = fakeHome();
    const nonInteractive = runCli(nonInteractiveHome, ["install", "--agent", "claude", "--modules", "memory-as-context"]);
    eq(nonInteractive.code, 0, `install stdout:\n${nonInteractive.stdout}\n${nonInteractive.stderr}`);
    ok(!nonInteractive.stdout.includes("configuration to install:"), "a non-interactive stdin must never show the review");

    const yesHome = fakeHome();
    const withYes = runCli(yesHome, ["install", "--agent", "claude", "--yes", "--modules", "memory-as-context"], { env: FORCE_TTY_ENV });
    eq(withYes.code, 0, `install stdout:\n${withYes.stdout}\n${withYes.stderr}`);
    ok(!withYes.stdout.includes("configuration to install:"), "--yes must never show the review either");
  });
});
