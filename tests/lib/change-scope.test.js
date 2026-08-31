"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { suite } = require("../harness");
const { classifyChange } = require("../../core/lib/change-scope");
const { gitState } = require("../../core/lib/git-state");

/** Git identity, so a fixture repo commits without relying on global git config. */
const GIT_IDENTITY = ["-c", "user.email=change-scope-test@example.invalid", "-c", "user.name=change-scope-test"];

/**
 * Runs a real git command against a fixture repository, for building test
 * fixtures only — `classifyChange` itself is exercised through its own
 * `runGit`, never through this helper.
 *
 * @param {string} cwd The fixture repository's working directory.
 * @param {string[]} args The git arguments, after the identity flags.
 * @returns {void}
 */
function git(cwd, args) {
  execFileSync("git", [...GIT_IDENTITY, ...args], { cwd, encoding: "utf8" });
}

/**
 * Builds a `{repoRoot}`-shaped object the same way `ctx.git` exposes it, from
 * a real, lazy `gitState`.
 *
 * @param {string} cwd A directory inside (or outside) the fixture repository.
 * @returns {{repoRoot: string | null}} The lazy git state.
 */
function realGit(cwd) {
  return gitState(cwd);
}

/**
 * Resolves a directory to its canonical, real path.
 *
 * On this machine `os.tmpdir()` hands back a short (8.3) Windows path form
 * (`TEMP`/`TMP` are themselves set that way), while `git rev-parse
 * --show-toplevel` — `classifyChange`'s own primary source for `repoRoot` —
 * always reports the long form. `fs.realpathSync` alone does not expand an
 * 8.3 name (confirmed: it echoed the short form back unchanged); only the
 * native binding does, since it asks the filesystem directly rather than
 * doing string-level resolution. Fixing the fixture directory up front
 * keeps every path built from it comparable to what git itself reports, the
 * same way a real host payload's already-resolved paths naturally are.
 *
 * @param {string} dir The directory to resolve.
 * @returns {string} The canonical, long-form path.
 */
function realDir(dir) {
  return fs.realpathSync.native(dir);
}

suite("lib/change-scope", ({ test, eq, notThrows, tmpdir }) => {
  test("a committed, tracked file classifies as existing", () => {
    const repo = realDir(tmpdir());
    git(repo, ["init", "-q"]);
    fs.writeFileSync(path.join(repo, "a.js"), "console.log('a');\n", "utf8");
    git(repo, ["add", "a.js"]);
    git(repo, ["commit", "-q", "-m", "init"]);

    eq(classifyChange(path.join(repo, "a.js"), realGit(repo)), "existing");
  });

  test("a brand-new untracked file classifies as new", () => {
    const repo = realDir(tmpdir());
    git(repo, ["init", "-q"]);
    fs.writeFileSync(path.join(repo, "a.js"), "console.log('a');\n", "utf8");
    git(repo, ["add", "a.js"]);
    git(repo, ["commit", "-q", "-m", "init"]);

    fs.writeFileSync(path.join(repo, "brand-new.js"), "console.log('new');\n", "utf8");

    eq(classifyChange(path.join(repo, "brand-new.js"), realGit(repo)), "new");
  });

  test("a file moved with git mv and then edited, not yet committed, classifies as existing (the rename case)", () => {
    const repo = realDir(tmpdir());
    git(repo, ["init", "-q"]);
    fs.writeFileSync(path.join(repo, "old.js"), "console.log('a');\n", "utf8");
    git(repo, ["add", "old.js"]);
    git(repo, ["commit", "-q", "-m", "init"]);

    git(repo, ["mv", "old.js", "new.js"]);
    fs.appendFileSync(path.join(repo, "new.js"), "console.log('edited after the move');\n", "utf8");

    eq(classifyChange(path.join(repo, "new.js"), realGit(repo)), "existing");
  });

  /**
   * A copy staged with a plain `git add` is caught by the cheapest check —
   * the destination is already "tracked" the instant it is staged, exactly
   * like a `git mv` destination. This holds regardless of whether git's own
   * similarity heuristic goes on to recognise the staged addition as a copy
   * of `source.js`: the tracked check answers "existing" first, so the
   * copy-detection parsing this module also carries (for a destination that
   * is a rename/copy against `HEAD` but not currently staged) is never even
   * reached for this case. That is the documented behaviour when git does
   * not — or does not need to — report the copy as such.
   */
  test("a file copied to a new path and staged classifies as existing", () => {
    const repo = realDir(tmpdir());
    git(repo, ["init", "-q"]);
    const original = "export function helper() {\n  return 'shared behaviour';\n}\n";
    fs.writeFileSync(path.join(repo, "source.js"), original, "utf8");
    git(repo, ["add", "source.js"]);
    git(repo, ["commit", "-q", "-m", "init"]);

    fs.writeFileSync(path.join(repo, "copy.js"), original, "utf8");
    git(repo, ["add", "copy.js"]);

    eq(classifyChange(path.join(repo, "copy.js"), realGit(repo)), "existing");
  });

  test("a path outside any repository classifies as unknown", () => {
    const repo = realDir(tmpdir());
    git(repo, ["init", "-q"]);
    fs.writeFileSync(path.join(repo, "a.js"), "console.log('a');\n", "utf8");
    git(repo, ["add", "a.js"]);
    git(repo, ["commit", "-q", "-m", "init"]);

    const outside = realDir(tmpdir());
    const outsidePath = path.join(outside, "elsewhere.js");
    fs.writeFileSync(outsidePath, "console.log('elsewhere');\n", "utf8");

    eq(classifyChange(outsidePath, realGit(repo)), "unknown");
  });

  test("a directory that is not a repository at all classifies as unknown, no throw", () => {
    const dir = realDir(tmpdir());
    const filePath = path.join(dir, "a.js");
    fs.writeFileSync(filePath, "console.log('a');\n", "utf8");

    let result;
    notThrows(() => {
      result = classifyChange(filePath, realGit(dir));
    });
    eq(result, "unknown");
  });

  test("no repository root at all (git object carrying null) classifies as unknown, no throw", () => {
    let result;
    notThrows(() => {
      result = classifyChange("/some/file.js", { repoRoot: null });
    });
    eq(result, "unknown");
  });
});
