"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { suite } = require("../harness");
const { gitState } = require("../../core/lib/git-state");

suite("lib/git-state", ({ test, eq, tmpdir }) => {
  /* --------------------------------------------------------- repoRoot */

  test("repoRoot returns the injected value without shelling out to git", () => {
    const cwd = tmpdir();
    const state = gitState(cwd, { repoRoot: "Z:/not-a-real-path/does-not-matter" });
    eq(state.repoRoot, "Z:/not-a-real-path/does-not-matter");
  });

  test("repoRoot falls back to findRepoRoot(cwd) when git itself returns null", () => {
    // A bare `.git` directory with no real repository contents makes
    // `git rev-parse --show-toplevel` fail, exercising the fallback.
    const repo = tmpdir();
    fs.mkdirSync(path.join(repo, ".git"));
    const state = gitState(repo);
    eq(state.repoRoot, repo);
  });

  /* ------------------------------------------------------ upstreamBranch */

  test("upstreamBranch resolves the tracked branch's short name when a base-branch upstream is configured", () => {
    const upstreamRepo = tmpdir();
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: upstreamRepo });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "seed"], { cwd: upstreamRepo });

    const repo = tmpdir();
    execFileSync("git", ["clone", "-q", upstreamRepo, repo]);
    execFileSync("git", ["checkout", "-q", "-b", "feature/task_1_x"], { cwd: repo });
    execFileSync("git", ["branch", "-q", "--set-upstream-to=origin/master", "feature/task_1_x"], { cwd: repo });

    const state = gitState(repo);
    eq(state.branch, "feature/task_1_x");
    eq(state.upstreamBranch, "master");
  });

  test("upstreamBranch is null when the branch has no upstream configured", () => {
    const repo = tmpdir();
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "seed"], { cwd: repo });

    const state = gitState(repo);
    eq(state.upstreamBranch, null);
  });

  test("upstreamBranch never throws and returns null on a non-repository cwd", () => {
    const dir = tmpdir();
    const state = gitState(dir);
    eq(state.upstreamBranch, null);
  });

  /* --------------------------------------------------- rebaseInProgress */

  test("rebaseInProgress is true from a nested subdirectory (regression: was false before this fix)", () => {
    const repo = tmpdir();
    execFileSync("git", ["init", "-q"], { cwd: repo });
    fs.mkdirSync(path.join(repo, ".git", "rebase-merge"), { recursive: true });

    const nested = path.join(repo, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });

    const state = gitState(nested);
    eq(state.rebaseInProgress, true);
  });

  test("rebaseInProgress is false from a nested subdirectory when no rebase is in progress", () => {
    const repo = tmpdir();
    execFileSync("git", ["init", "-q"], { cwd: repo });

    const nested = path.join(repo, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });

    const state = gitState(nested);
    eq(state.rebaseInProgress, false);
  });

  test("rebaseInProgress is true for a worktree-style .git FILE pointing at a separate gitdir", () => {
    const repo = tmpdir();
    const externalGitDir = tmpdir();
    fs.mkdirSync(path.join(externalGitDir, "rebase-apply"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git"), `gitdir: ${externalGitDir}\n`, "utf8");

    const state = gitState(repo, { repoRoot: repo });
    eq(state.rebaseInProgress, true);
  });

  test("rebaseInProgress resolves a relative gitdir pointer against the repo directory", () => {
    const parent = tmpdir();
    const repo = path.join(parent, "repo");
    const externalGitDir = path.join(parent, "repo.git-worktree");
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(path.join(externalGitDir, "rebase-apply"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git"), `gitdir: ../repo.git-worktree\n`, "utf8");

    const state = gitState(repo, { repoRoot: repo });
    eq(state.rebaseInProgress, true);
  });

  test("rebaseInProgress never throws and returns false on a non-repository cwd", () => {
    const dir = tmpdir();
    const state = gitState(dir);
    eq(state.rebaseInProgress, false);
  });
});
