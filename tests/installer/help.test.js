"use strict";

/**
 * `softela-ai`'s own discoverability: the overview, per-command help, and the
 * refusal (never a silent no-op) of an unrecognised command or flag.
 *
 * Every flag assertion here reads `COMMANDS` straight off
 * `core/installer/index.js` — the same registry {@link module:index#main}
 * validates real flags against — rather than a hand-copied list, so this
 * suite fails the moment the parser and its own help text disagree, instead
 * of only when a human remembers to update both.
 */

const path = require("path");
const { suite } = require("../harness");
const { runCli } = require("./_home");
const { COMMANDS } = require("../../core/installer/index.js");
const pkg = require("../../package.json");

/**
 * Extracts every flag name (without its leading `--`) from a rendered
 * `--help` block's Options section.
 *
 * An option's own head line always starts with exactly two spaces then
 * `--`; its "default:" continuation line starts with two spaces followed by
 * more spaces (padding), never `--` — so anchoring on `  --` is enough to
 * collect one entry per flag without also matching the continuation line.
 *
 * @param {string} helpText A command's rendered `--help` stdout.
 * @returns {string[]} Flag names found, in the order they appear.
 */
function flagsMentionedIn(helpText) {
  const found = [];
  for (const line of helpText.split("\n")) {
    const match = /^ {2}--([a-z][a-z-]*)/.exec(line);
    if (match) found.push(match[1]);
  }
  return found;
}

suite("installer/help", ({ test, eq, ok, deepEq, fakeHome }) => {
  test("no arguments prints the overview, exits 0, and lists every command", () => {
    const home = fakeHome();
    const result = runCli(home, []);
    eq(result.code, 0, result.stdout + result.stderr);
    for (const name of Object.keys(COMMANDS)) {
      ok(result.stdout.includes(name), `overview must mention "${name}", got:\n${result.stdout}`);
    }
  });

  test("-h and --help print the identical overview, and so does no command at all", () => {
    const home = fakeHome();
    const bare = runCli(home, []);
    const dashH = runCli(home, ["-h"]);
    const dashDashHelp = runCli(home, ["--help"]);
    eq(dashH.code, 0, dashH.stdout + dashH.stderr);
    eq(dashDashHelp.code, 0, dashDashHelp.stdout + dashDashHelp.stderr);
    eq(dashH.stdout, bare.stdout, "-h must print exactly what no arguments prints");
    eq(dashDashHelp.stdout, bare.stdout, "--help must print exactly what no arguments prints");
  });

  test("--version prints exactly package.json's own version, and exits 0", () => {
    const home = fakeHome();
    const result = runCli(home, ["--version"]);
    eq(result.code, 0, result.stdout + result.stderr);
    eq(result.stdout.trim(), pkg.version);
  });

  for (const command of Object.keys(COMMANDS)) {
    test(`"${command} --help" mentions exactly the flags the parser accepts for it, and exits 0`, () => {
      const home = fakeHome();
      const viaFlag = runCli(home, [command, "--help"]);
      eq(viaFlag.code, 0, viaFlag.stdout + viaFlag.stderr);

      const viaHelpCommand = runCli(home, ["help", command]);
      eq(viaHelpCommand.code, 0, viaHelpCommand.stdout + viaHelpCommand.stderr);
      eq(viaHelpCommand.stdout, viaFlag.stdout, `"help ${command}" must print exactly what "${command} --help" prints`);

      const mentioned = new Set(flagsMentionedIn(viaFlag.stdout));
      const accepted = new Set(COMMANDS[command].flags);
      deepEq(
        [...mentioned].sort(),
        [...accepted].sort(),
        `"${command}"'s help must mention exactly its own accepted flags, got:\n${viaFlag.stdout}`,
      );

      ok(viaFlag.stdout.includes("Example:"), `"${command} --help" must include a worked example`);
    });
  }

  test("an unknown command is refused with a suggestion", () => {
    const home = fakeHome();
    const result = runCli(home, ["instal"]);
    ok(result.code !== 0, "an unknown command must exit non-zero");
    eq(result.stdout, "", "an error must not be printed to stdout");
    ok(/unknown command "instal"/.test(result.stderr), result.stderr);
    ok(/did you mean "install"/.test(result.stderr), `expected a suggestion for the nearest command, got:\n${result.stderr}`);
  });

  test("an unknown flag for a known command is refused with a suggestion, and never dispatched", () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "--dryrun"]);
    ok(result.code !== 0, "an unknown flag must exit non-zero");
    ok(/unknown flag "--dryrun" for "install"/.test(result.stderr), result.stderr);
    ok(/did you mean "--dry-run"/.test(result.stderr), `expected a suggestion for the nearest flag, got:\n${result.stderr}`);
  });

  test("a flag one command accepts is refused for a command that does not accept it", () => {
    const home = fakeHome();
    // --repo is link's own flag; doctor never reads it.
    const result = runCli(home, ["doctor", "--repo", "."]);
    ok(result.code !== 0, "a flag foreign to this command must exit non-zero, not be silently ignored");
    ok(/unknown flag "--repo" for "doctor"/.test(result.stderr), result.stderr);
  });

  test("a value flag with a fixed set of choices refuses anything outside it", () => {
    const home = fakeHome();
    const result = runCli(home, ["doctor", "--agent", "windows"]);
    ok(result.code !== 0, "an invalid --agent value must exit non-zero, not silently fall back to auto-detect");
    ok(/invalid value "windows" for "--agent"/.test(result.stderr), result.stderr);
  });

  test("help for an unknown command by name is also refused with a suggestion", () => {
    const home = fakeHome();
    const result = runCli(home, ["help", "instal"]);
    ok(result.code !== 0);
    ok(/unknown command "instal"/.test(result.stderr), result.stderr);
  });

  test("bare \"help\" with no target prints the same overview as no arguments", () => {
    const home = fakeHome();
    const bare = runCli(home, []);
    const help = runCli(home, ["help"]);
    eq(help.code, 0, help.stdout + help.stderr);
    eq(help.stdout, bare.stdout);
  });

  test("flags-only invocation with no command word prints the overview rather than an error", () => {
    const home = fakeHome();
    const result = runCli(home, ["--json"]);
    eq(result.code, 0, result.stdout + result.stderr);
    ok(result.stdout.includes("install"), result.stdout);
  });
});
