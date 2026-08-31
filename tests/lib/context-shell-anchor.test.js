"use strict";

/**
 * Integration coverage for `core/lib/context.js#buildContext` deriving a
 * shell operation's working directory from the command text itself, via
 * `core/lib/workdir.js#extractShellWorkdir` — the fix for a multi-repository
 * session whose own launch directory holds several repositories and is not
 * one itself, so `resolveProject` would otherwise match nothing and fall
 * back to `_default` for every command naming a repository right there in
 * its own text.
 *
 * Every case here drives `buildContext` — the same context construction the
 * real dispatcher runs — with `payload.cwd` set to a PARENT directory that
 * is deliberately not a git repository at all, exactly the shape the field
 * test that motivated this fix reproduced.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { suite } = require("../harness");
const { buildContext } = require("../../core/lib/context");

/** The real, shipped backend project's own matching remote (see `projects/Softela.SCExpert.json`). */
const REPO_A_REMOTE = "git@dev.azure.com:v3/org/Softela.SCExpert.git";

/** The real, shipped frontend project's own matching remote (see `projects/Softela.ReactSCExpert.json`). */
const REPO_B_REMOTE = "https://dev.azure.com/org/Project/_git/Softela.ReactSCExpert";

/**
 * Initialises a throwaway git repository with an `origin` remote, so
 * `resolveProject` — called with no `projectsDir` override, exactly as the
 * real dispatcher calls it — matches one of this repository's own real,
 * shipped project files by remote.
 *
 * @param {string} dir The directory to initialise.
 * @param {string} remoteUrl The `origin` remote URL to configure.
 * @returns {void}
 */
function initRepo(dir, remoteUrl) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remoteUrl], { cwd: dir });
}

/**
 * Builds a `PreToolUse` shell-command payload, `cwd` naming the SESSION's
 * own launch directory — never the repository the command itself targets.
 *
 * @param {string} command The shell command line.
 * @param {string} cwd The payload's own top-level `cwd`.
 * @returns {object} A Claude Code-shaped payload.
 */
function shellPayload(command, cwd) {
  return { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd };
}

/**
 * Normalises a path for comparison against `ctx.git.repoRoot`, which — on
 * this Windows/Git-Bash environment — comes back from a real `git
 * rev-parse --show-toplevel` shell-out, so it may spell the same directory
 * with forward slashes and the OS's real long username instead of a short
 * `8.3` alias. Ordinary `ctx.cwd`/`ctx.filePath` values never take this
 * detour and compare equal as plain strings; only a `repoRoot` assertion
 * needs it.
 *
 * @param {string} p The path to normalise.
 * @returns {string} A lower-cased, forward-slash, symlink-resolved form —
 * falling back to a simple case/separator normalisation when the path does
 * not exist (`fs.realpathSync` would throw).
 */
function normalizeForRepoRootCompare(p) {
  try {
    return fs.realpathSync.native(p).replace(/\\/g, "/").toLowerCase();
  } catch {
    return String(p).replace(/\\/g, "/").toLowerCase();
  }
}

suite("lib/context-shell-anchor", ({ test, eq, ok, tmpdir }) => {
  test("cd <dir> && <command> resolves project A, anchored on the parent directory", () => {
    const parent = tmpdir();
    const repoA = path.join(parent, "RepoA");
    fs.mkdirSync(repoA);
    initRepo(repoA, REPO_A_REMOTE);

    const ctx = buildContext(shellPayload("cd RepoA && npx tsc --noEmit", parent), { agent: "claude" });

    eq(ctx.cwd, repoA);
    eq(ctx.project.id, "Softela.SCExpert");
    eq(normalizeForRepoRootCompare(ctx.git.repoRoot), normalizeForRepoRootCompare(repoA));
  });

  test("git -C <dir> <verb> resolves project B, anchored on the parent directory", () => {
    const parent = tmpdir();
    const repoB = path.join(parent, "RepoB");
    fs.mkdirSync(repoB);
    initRepo(repoB, REPO_B_REMOTE);

    const ctx = buildContext(shellPayload('git -C RepoB commit -m "x"', parent), { agent: "claude" });

    eq(ctx.cwd, repoB);
    eq(ctx.project.id, "Softela.ReactSCExpert");
    eq(normalizeForRepoRootCompare(ctx.git.repoRoot), normalizeForRepoRootCompare(repoB));
  });

  test("npm --prefix <dir> resolves project A, anchored on the parent directory", () => {
    const parent = tmpdir();
    const repoA = path.join(parent, "RepoA");
    fs.mkdirSync(repoA);
    initRepo(repoA, REPO_A_REMOTE);

    const ctx = buildContext(shellPayload("npm --prefix RepoA run build", parent), { agent: "claude" });

    eq(ctx.cwd, repoA);
    eq(ctx.project.id, "Softela.SCExpert");
    eq(normalizeForRepoRootCompare(ctx.git.repoRoot), normalizeForRepoRootCompare(repoA));
  });

  test("dotnet build <repoB>/src/Thing.csproj resolves project B, anchored on the parent directory", () => {
    const parent = tmpdir();
    const repoB = path.join(parent, "RepoB");
    const repoBSrc = path.join(repoB, "src");
    fs.mkdirSync(repoBSrc, { recursive: true });
    initRepo(repoB, REPO_B_REMOTE);
    fs.writeFileSync(path.join(repoBSrc, "Thing.csproj"), "");

    const ctx = buildContext(shellPayload("dotnet build RepoB/src/Thing.csproj", parent), { agent: "claude" });

    // The `.csproj` itself lives under `repoB/src`, so the working directory
    // this operation anchors on is that containing directory, not the
    // repository root — `git.repoRoot` is what walks back up to `repoB`.
    eq(ctx.cwd, repoBSrc);
    eq(ctx.project.id, "Softela.ReactSCExpert");
    eq(normalizeForRepoRootCompare(ctx.git.repoRoot), normalizeForRepoRootCompare(repoB));
  });

  test("a command naming two different repositories falls back to the parent and resolves neither", () => {
    const parent = tmpdir();
    const repoA = path.join(parent, "RepoA");
    const repoB = path.join(parent, "RepoB");
    fs.mkdirSync(repoA);
    fs.mkdirSync(repoB);
    initRepo(repoA, REPO_A_REMOTE);
    initRepo(repoB, REPO_B_REMOTE);

    const ctx = buildContext(shellPayload("cd RepoA && git -C RepoB status", parent), { agent: "claude" });

    eq(ctx.cwd, parent);
    eq(ctx.project.id, "_default");
    eq(ctx.git.repoRoot, null);
  });

  test("a command naming a directory that does not exist falls back to the parent", () => {
    const parent = tmpdir();

    const ctx = buildContext(shellPayload("cd DoesNotExist && npx tsc --noEmit", parent), { agent: "claude" });

    eq(ctx.cwd, parent);
    eq(ctx.project.id, "_default");
  });

  test('cd "<path with spaces>" && x resolves correctly', () => {
    const parentBackslash = tmpdir();
    const parent = parentBackslash.split(path.sep).join("/");
    const target = `${parent}/RepoA Extra/x`;
    fs.mkdirSync(target.split("/").join(path.sep), { recursive: true });
    initRepo(target.split("/").join(path.sep), REPO_A_REMOTE);

    const ctx = buildContext(shellPayload(`cd "${target}" && npx tsc --noEmit`, parentBackslash), {
      agent: "claude",
    });

    eq(ctx.cwd, target.split("/").join(path.sep));
    eq(ctx.project.id, "Softela.SCExpert");
  });

  test("a plain command with no directory keeps today's behaviour exactly: cwd stays the payload's own cwd", () => {
    const parent = tmpdir();

    const ctx = buildContext(shellPayload("npx tsc --noEmit", parent), { agent: "claude" });

    eq(ctx.cwd, parent);
    eq(ctx.project.id, "_default");
    eq(ctx.git.repoRoot, null);
  });

  test("an explicit host-provided workdir still wins over anything parsed from the command", () => {
    const parent = tmpdir();
    const repoA = path.join(parent, "RepoA");
    const repoB = tmpdir();
    fs.mkdirSync(repoA);
    initRepo(repoA, REPO_A_REMOTE);
    initRepo(repoB, REPO_B_REMOTE);

    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "cd RepoA && npm test", workdir: repoB },
      cwd: parent,
    };
    const ctx = buildContext(payload, { agent: "claude" });

    eq(ctx.cwd, repoB);
    eq(ctx.project.id, "Softela.ReactSCExpert");
  });
});
