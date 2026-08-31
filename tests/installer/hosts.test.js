"use strict";

/**
 * Both hosts (INSTALLER.md, CONTRACTS §11): a home with only `.claude`, only
 * `.codex`, and both — `--agent` omitted, so the installer must detect the
 * right subset by itself and never conjure the other host's home into
 * existence.
 */

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");
const { runCli, seedForeign, agentHomePath, installedRootPath } = require("./_home");

suite("installer/hosts", ({ test, eq, ok, fakeHome }) => {
  test("a home with only .claude installs claude and never creates .codex", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(fs.existsSync(agentHomePath(home, "codex")), false);

    const result = runCli(home, ["install", "--yes"]);
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);

    ok(fs.existsSync(installedRootPath(home, "claude")));
    eq(fs.existsSync(agentHomePath(home, "codex")), false, "the installer must never create a home for an agent it never targeted");
  });

  test("a home with only .codex installs codex and never creates .claude", () => {
    const home = fakeHome();
    seedForeign(home, "codex");
    eq(fs.existsSync(agentHomePath(home, "claude")), false);

    const result = runCli(home, ["install", "--yes"]);
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);

    ok(fs.existsSync(installedRootPath(home, "codex")));
    eq(fs.existsSync(agentHomePath(home, "claude")), false);
  });

  test("a home with both installs both agents", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    seedForeign(home, "codex");

    const result = runCli(home, ["install", "--yes"]);
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);

    ok(fs.existsSync(installedRootPath(home, "claude")));
    ok(fs.existsSync(installedRootPath(home, "codex")));
  });

  test("a home with neither reports nothing to install rather than guessing an agent", () => {
    const home = fakeHome();
    const result = runCli(home, ["install", "--yes"]);
    eq(result.code, 2);
    eq(fs.existsSync(path.join(home, ".claude")), false);
    eq(fs.existsSync(path.join(home, ".codex")), false);
  });

  test("--agent all targets both agents explicitly, creating homes as needed, even where auto-detection would find neither", () => {
    const home = fakeHome();
    eq(fs.existsSync(path.join(home, ".claude")), false);
    eq(fs.existsSync(path.join(home, ".codex")), false);

    const result = runCli(home, ["install", "--agent", "all", "--yes"]);
    eq(result.code, 0, `install stdout:\n${result.stdout}\n${result.stderr}`);

    ok(fs.existsSync(installedRootPath(home, "claude")), "--agent all must install claude even though no home pre-existed");
    ok(fs.existsSync(installedRootPath(home, "codex")), "--agent all must install codex even though no home pre-existed");
  });
});
