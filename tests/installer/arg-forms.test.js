"use strict";

/**
 * The two interchangeable ways to write a flag value on the command line:
 * as the following token (`--agent codex`) and inline (`--agent=codex`).
 *
 * The inline form matters because `npm run <script> -- --agent=codex` is a
 * common habit, and a parser that only understood the space form turned a
 * typo-free command into "unknown flag".
 */

const { suite } = require("../harness");
const { runCli } = require("./_home");
const { parseArgs } = require("../../core/installer/index.js");

suite("installer/arg-forms", ({ test, eq, ok, deepEq, fakeHome }) => {
  test("a value flag parses identically whether its value follows or is inline", () => {
    deepEq(parseArgs(["doctor", "--agent", "codex"]), parseArgs(["doctor", "--agent=codex"]));
  });

  test("the inline form keeps the command and positional arguments intact", () => {
    const parsed = parseArgs(["module", "enable", "reply-language", "--agent=claude"]);
    eq(parsed.command, "module");
    deepEq(parsed.positional, ["enable", "reply-language"]);
    eq(parsed.flags.agent, "claude");
  });

  test("only the first equals sign splits the flag, so a value may contain one", () => {
    eq(parseArgs(["install", "--memory-location=a=b"]).flags["memory-location"], "a=b");
  });

  test("an inline value that is empty stays an empty string, not a boolean true", () => {
    eq(parseArgs(["install", "--agent="]).flags.agent, "");
  });

  test("a bare boolean flag is true", () => {
    eq(parseArgs(["install", "--dry-run"]).flags["dry-run"], true);
  });

  test("a boolean flag written --flag=false is false, so a preview is never applied", () => {
    for (const off of ["false", "FALSE", "0", "no", "off"]) {
      eq(parseArgs(["install", `--dry-run=${off}`]).flags["dry-run"], false, `--dry-run=${off}`);
    }
  });

  test("a boolean flag written with any other inline value stays true", () => {
    for (const on of ["true", "1", "yes", "anything"]) {
      eq(parseArgs(["install", `--dry-run=${on}`]).flags["dry-run"], true, `--dry-run=${on}`);
    }
  });

  test("a command that takes no argument refuses one instead of ignoring it", () => {
    const home = fakeHome();
    const result = runCli(home, ["doctor", "codex"]);
    eq(result.code, 1, result.stdout + result.stderr);
    ok(
      result.stderr.includes("takes no argument"),
      `stderr must name the unexpected argument, got: ${result.stderr}`,
    );
  });

  test("the refusal names an invocation that carries the flag through intact", () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "codex"]);
    ok(
      result.stderr.includes("npx softela-ai") && result.stderr.includes("npm run softela-ai --"),
      `stderr must offer both working forms, got: ${result.stderr}`,
    );
  });

  test("a command that does take arguments still accepts them", () => {
    const home = fakeHome();
    const result = runCli(home, ["module", "list", "--agent", "claude"]);
    eq(result.code, 0, result.stdout + result.stderr);
  });
});
