"use strict";

/**
 * Builds a disposable, real git repository that a shipped project file
 * actually matches by remote — the same technique
 * `tests/acceptance/enforcement.test.js#buildFixture` already proved out, so
 * a write replayed through the real dispatcher (`adapters/shared/dispatch-core.js`)
 * resolves the exact same project config, stack preset and git state a real
 * checkout of that project would.
 *
 * Used by two callers: `tools/acceptance/score.js`'s `standards-obeyed`
 * assertion, which needs one real repository to replay a transcript's writes
 * against, and `tools/acceptance/run.js`'s `--live` scratch setup, which
 * needs one for the real agent to actually work in.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

/**
 * Runs a git subcommand against fixture setup. Failures here are a broken
 * fixture, not something a caller should silently tolerate, so they are left
 * to throw.
 *
 * @param {string} cwd The directory to run git in.
 * @param {string[]} args The git arguments.
 * @returns {string} The command's trimmed stdout.
 */
function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Writes a file, creating its parent directories first.
 *
 * @param {string} absPath The absolute file path.
 * @param {string} content The file content.
 * @returns {void}
 */
function writeFileDeep(absPath, content) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

/**
 * Builds a disposable repository matching a project's own `match.remotes`
 * pattern, with a base branch, a feature branch cut from it, and whatever
 * seed files the caller supplies already committed.
 *
 * `repoRoot` is re-derived through git's own `rev-parse` rather than trusted
 * as `path.join(scratch, spec.repoName)`, the same short-name-vs-long-name
 * defence `enforcement.test.js#buildFixture` documents: `fs.mkdtempSync`
 * under the system temp directory can hand back an 8.3 short name while git
 * reports the same directory's long form, and every project-scoped rule
 * compares `ctx.filePath` against `ctx.git.repoRoot` as literal string
 * prefixes.
 *
 * @param {() => string} tmpdir A disposable-directory factory — the test
 * harness's own `tmpdir()`, or an equivalent for a non-test caller.
 * @param {{
 *   repoName: string,
 *   remote: string,
 *   baseBranch: string,
 *   featureBranch: string,
 *   seedFiles?: Record<string, string>
 * }} spec `repoName` is also the directory name, matched against a project's
 * `match.paths` as a fallback; `remote` is the `origin` URL, matched against
 * `match.remotes`; `seedFiles` maps a repo-relative path to its content,
 * committed on the base branch before the feature branch is cut.
 * @returns {{repo: string, parent: string}} The repository's own resolved
 * absolute path and its parent directory.
 */
function buildFixtureRepo(tmpdir, spec) {
  const scratch = tmpdir();
  const provisional = path.join(scratch, spec.repoName);
  fs.mkdirSync(provisional, { recursive: true });
  git(provisional, ["init", "-q"]);

  const repo = git(provisional, ["rev-parse", "--show-toplevel"]).split("/").join(path.sep);
  const parent = path.dirname(repo);

  git(repo, ["config", "user.email", "acceptance@example.invalid"]);
  git(repo, ["config", "user.name", "Acceptance Suite"]);
  git(repo, ["remote", "add", "origin", spec.remote]);

  const seedFiles = spec.seedFiles && typeof spec.seedFiles === "object" ? spec.seedFiles : { "README.md": "scratch fixture\n" };
  for (const [rel, content] of Object.entries(seedFiles)) {
    writeFileDeep(path.join(repo, ...rel.split("/")), content);
  }

  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "seed fixture"]);
  git(repo, ["branch", "-M", spec.baseBranch]);
  git(repo, ["checkout", "-q", "-b", spec.featureBranch]);

  return { repo, parent };
}

module.exports = { buildFixtureRepo };
