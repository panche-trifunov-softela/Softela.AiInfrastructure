"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { suite } = require("../harness");
const { resolveProject, loadAllProjects, globToRegex } = require("../../core/lib/project-resolver");

const REAL_PROJECTS_DIR = path.join(__dirname, "..", "..", "projects");

/**
 * Initialises a throwaway git repository, optionally with an origin remote.
 *
 * @param {string} dir The directory to initialise.
 * @param {string} [remoteUrl] The `origin` remote URL to configure.
 * @returns {void}
 */
function initRepo(dir, remoteUrl) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (remoteUrl) execFileSync("git", ["remote", "add", "origin", remoteUrl], { cwd: dir });
}

suite("lib/project-resolver", ({ test, eq, ok, deepEq, tmpdir, fixture }) => {
  /* ---------------------------------------------------------- glob shape */

  // The regression this pins: `**/` translated as "one or more directories"
  // matched `config/.env` and missed the repository-root `.env`, which is
  // where the credentials actually are. Every shipped credential protection
  // is written in that form, so the miss silenced all of them at once.
  test("a **/ prefix matches at the repository root, not only inside a directory", () => {
    for (const [glob, target] of [
      ["**/.env", ".env"],
      ["**/.env.*", ".env.local"],
      ["**/.npmrc", ".npmrc"],
      ["**/id_rsa", "id_rsa"],
      ["**/*.pfx", "signing.pfx"],
    ]) {
      ok(globToRegex(glob).test(target), `${glob} must match a root-level ${target}`);
    }
  });

  test("a **/ prefix still matches at any depth", () => {
    for (const target of [".env", "config/.env", "a/b/c/.env"]) {
      ok(globToRegex("**/.env").test(target), `**/.env must match ${target}`);
    }
  });

  test("a **/ prefix does not match a merely similar name", () => {
    for (const target of ["denv", "src/env", "env", ".environment", "a/.envrc"]) {
      eq(globToRegex("**/.env").test(target), false, `**/.env must not match ${target}`);
    }
  });

  test("a bare * stays inside one path segment", () => {
    eq(globToRegex("src/*.ts").test("src/a.ts"), true);
    eq(globToRegex("src/*.ts").test("src/nested/a.ts"), false);
  });

  test("a ** not followed by a separator still spans segments", () => {
    eq(globToRegex("projects/**.json").test("projects/a.json"), true);
    eq(globToRegex("projects/**.json").test("projects/nested/a.json"), true);
    eq(globToRegex("projects/**.json").test("other/a.json"), false);
  });

  // A config field takes exactly one glob, so a project whose components
  // legitimately live under several roots needs alternation to say so.
  test("a brace group matches any of its branches", () => {
    const re = globToRegex("react-app/src/{components,pages,layouts}/**");
    for (const target of [
      "react-app/src/components/Common/Table/Table.jsx",
      "react-app/src/pages/Customers.jsx",
      "react-app/src/layouts/Header.jsx",
    ]) {
      ok(re.test(target), `the alternation must match ${target}`);
    }
  });

  test("a brace group matches nothing outside its branches", () => {
    const re = globToRegex("react-app/src/{components,pages,layouts}/**");
    for (const target of [
      "react-app/src/utils/format.js",
      "react-app/src/services/api.js",
      "react-app/src/componentsX/A.jsx",
      "other/src/components/A.jsx",
    ]) {
      eq(re.test(target), false, `the alternation must not match ${target}`);
    }
  });

  test("a two-branch group works mid-segment as well as as a whole one", () => {
    const re = globToRegex("src/{a,b}Panel/**");
    eq(re.test("src/aPanel/x.ts"), true);
    eq(re.test("src/bPanel/x.ts"), true);
    eq(re.test("src/cPanel/x.ts"), false);
  });

  // Everything below keeps the literal, escaped meaning braces have always
  // had, so a real path containing one is unaffected by the addition above.
  test("a brace group with no comma stays a literal brace", () => {
    const re = globToRegex("a/{b}/c");
    eq(re.test("a/{b}/c"), true);
    eq(re.test("a/b/c"), false);
  });

  test("a brace group with an empty branch stays literal", () => {
    const re = globToRegex("a/{,b}/c");
    eq(re.test("a/{,b}/c"), true);
    eq(re.test("a/b/c"), false);
  });

  test("a brace group spanning a separator stays literal", () => {
    const re = globToRegex("a/{b/c,d}/e");
    eq(re.test("a/{b/c,d}/e"), true);
    eq(re.test("a/b/c/e"), false);
    eq(re.test("a/d/e"), false);
  });

  test("an unclosed brace never swallows the rest of the pattern", () => {
    const re = globToRegex("a/{b");
    eq(re.test("a/{b"), true);
    eq(re.test("a/b"), false);
  });

  test("an unparseable glob compiles to nothing rather than throwing", () => {
    eq(globToRegex(null), null);
    eq(globToRegex(42), null);
  });

  // Asserted against the directory rather than a hard-coded list: adding a
  // project is routine, and a test that has to be edited every time one lands
  // teaches nothing except to edit it.
  test("loadAllProjects reads every shipped project file", () => {
    const onDisk = fs
      .readdirSync(REAL_PROJECTS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
    const ids = loadAllProjects(REAL_PROJECTS_DIR)
      .map((p) => p.id)
      .sort();

    deepEq(ids, onDisk);
    ok(ids.includes("_default"));
    ok(ids.length >= 2);
  });

  test("every shipped project declares an id matching its filename", () => {
    for (const project of loadAllProjects(REAL_PROJECTS_DIR)) {
      ok(typeof project.id === "string" && project.id.length > 0);
      ok(fs.existsSync(path.join(REAL_PROJECTS_DIR, `${project.id}.json`)));
    }
  });

  test("loadAllProjects returns an empty array for a missing directory", () => {
    deepEq(loadAllProjects(path.join(REAL_PROJECTS_DIR, "does-not-exist")), []);
  });

  test("an SSH remote resolves to the matching project", () => {
    const dir = tmpdir();
    initRepo(dir, "git@dev.azure.com:v3/org/Softela.ReactSCExpert.git");
    const project = resolveProject(dir, { projectsDir: REAL_PROJECTS_DIR });
    eq(project.id, "Softela.ReactSCExpert");
  });

  test("a plain HTTPS remote resolves to the same project", () => {
    const dir = tmpdir();
    initRepo(dir, "https://dev.azure.com/org/Softela.ReactSCExpert");
    const project = resolveProject(dir, { projectsDir: REAL_PROJECTS_DIR });
    eq(project.id, "Softela.ReactSCExpert");
  });

  test("an Azure DevOps _git remote resolves to the same project", () => {
    const dir = tmpdir();
    initRepo(dir, "https://org@dev.azure.com/org/Softela.ReactSCExpert/_git/Softela.ReactSCExpert");
    const project = resolveProject(dir, { projectsDir: REAL_PROJECTS_DIR });
    eq(project.id, "Softela.ReactSCExpert");
  });

  test("the backend repository resolves by its own remote", () => {
    const dir = tmpdir();
    initRepo(dir, "git@dev.azure.com:v3/org/Softela.SCExpert.git");
    const project = resolveProject(dir, { projectsDir: REAL_PROJECTS_DIR });
    eq(project.id, "Softela.SCExpert");
  });

  test("an unknown remote falls back to _default", () => {
    const dir = tmpdir();
    initRepo(dir, "https://github.com/someone/unrelated-repo.git");
    const project = resolveProject(dir, { projectsDir: REAL_PROJECTS_DIR });
    eq(project.id, "_default");
  });

  test("a directory with no remote at all falls back to _default", () => {
    const dir = tmpdir();
    initRepo(dir);
    const project = resolveProject(dir, { projectsDir: REAL_PROJECTS_DIR });
    eq(project.id, "_default");
  });

  test("a non-repository cwd falls back to _default without throwing", () => {
    const dir = tmpdir();
    const project = resolveProject(dir, { projectsDir: REAL_PROJECTS_DIR });
    eq(project.id, "_default");
  });

  test("match.paths is used when the remote does not match", () => {
    const dir = tmpdir();
    const repoDir = path.join(dir, "SpecialRepoName");
    require("fs").mkdirSync(repoDir);
    initRepo(repoDir, "https://github.com/someone/unrelated-repo.git");

    const defaultFile = fixture("projects/_default.json", { id: "_default", baseBranches: [] });
    fixture("projects/by-path.json", { id: "by-path", match: { paths: ["SpecialRepoName"] } });
    const projectsDir = path.dirname(defaultFile);

    const project = resolveProject(repoDir, { projectsDir });
    eq(project.id, "by-path");
  });

  test("an unreadable projects directory yields the minimal safe default", () => {
    const dir = tmpdir();
    initRepo(dir, "https://github.com/someone/unrelated-repo.git");
    const project = resolveProject(dir, { projectsDir: path.join(dir, "nowhere") });
    eq(project.id, "_default");
    deepEq(project.baseBranches, []);
  });

  test("resolveProject never throws even with a bogus cwd", () => {
    let threw = false;
    try {
      resolveProject(null, { projectsDir: REAL_PROJECTS_DIR });
    } catch {
      threw = true;
    }
    eq(threw, false);
  });
});
