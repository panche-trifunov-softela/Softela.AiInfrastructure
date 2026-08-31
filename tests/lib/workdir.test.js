"use strict";

const fs = require("fs");
const path = require("path");

const { suite } = require("../harness");
const { resolveWorkdir, findRepoRoot, extractShellWorkdir } = require("../../core/lib/workdir");

suite("lib/workdir", ({ test, eq, ok, tmpdir }) => {
  /* ------------------------------------------------------- resolveWorkdir */

  test("resolveWorkdir prefers an absolute filePath's directory over opCwd and payloadCwd", () => {
    const fileDir = tmpdir();
    const opDir = tmpdir();
    const payloadDir = tmpdir();
    const filePath = path.join(fileDir, "a.ts");

    const result = resolveWorkdir({ filePath, opCwd: opDir, payloadCwd: payloadDir });
    eq(result, fileDir);
  });

  test("resolveWorkdir walks up to the nearest existing ancestor when the target file's directory does not exist yet", () => {
    const root = tmpdir();
    const filePath = path.join(root, "not-yet-created", "nested", "a.ts");

    const result = resolveWorkdir({ filePath });
    eq(result, root);
  });

  test("resolveWorkdir skips a relative filePath and falls through to opCwd", () => {
    const opDir = tmpdir();
    const result = resolveWorkdir({ filePath: "relative/a.ts", opCwd: opDir });
    eq(result, opDir);
  });

  test("resolveWorkdir skips a relative opCwd and falls through to payloadCwd", () => {
    const payloadDir = tmpdir();
    const result = resolveWorkdir({ opCwd: "relative/dir", payloadCwd: payloadDir });
    eq(result, payloadDir);
  });

  test("resolveWorkdir returns process.cwd() when nothing else is usable", () => {
    eq(resolveWorkdir({}), process.cwd());
    eq(resolveWorkdir({ filePath: "", opCwd: "", payloadCwd: "" }), process.cwd());
  });

  test("resolveWorkdir never throws on null, undefined or numeric candidates", () => {
    let result;
    try {
      result = resolveWorkdir(null);
    } catch {
      result = "THREW";
    }
    eq(result, process.cwd());

    try {
      result = resolveWorkdir(undefined);
    } catch {
      result = "THREW";
    }
    eq(result, process.cwd());

    try {
      result = resolveWorkdir({ filePath: 42, opCwd: 7, payloadCwd: false });
    } catch {
      result = "THREW";
    }
    eq(result, process.cwd());
  });

  test("resolveWorkdir skips an opCwd naming a directory that does not exist", () => {
    const payloadDir = tmpdir();
    const missing = path.join(payloadDir, "does-not-exist-either");
    const result = resolveWorkdir({ opCwd: missing, payloadCwd: payloadDir });
    eq(result, payloadDir);
  });

  /* ---------------------------------------------------------- findRepoRoot */

  test("findRepoRoot finds a root from a nested subdirectory", () => {
    const repo = tmpdir();
    fs.mkdirSync(path.join(repo, ".git"));
    const nested = path.join(repo, "packages", "app", "src");
    fs.mkdirSync(nested, { recursive: true });

    eq(findRepoRoot(nested), repo);
  });

  test("findRepoRoot returns null outside any repository", () => {
    const dir = tmpdir();
    eq(findRepoRoot(dir), null);
  });

  test("findRepoRoot accepts .git as a directory", () => {
    const repo = tmpdir();
    fs.mkdirSync(path.join(repo, ".git"));
    eq(findRepoRoot(repo), repo);
  });

  test("findRepoRoot accepts .git as a worktree-style FILE", () => {
    const repo = tmpdir();
    const externalGitDir = tmpdir();
    fs.writeFileSync(path.join(repo, ".git"), `gitdir: ${externalGitDir}\n`, "utf8");

    eq(findRepoRoot(repo), repo);
  });

  test("findRepoRoot never throws on a bogus input", () => {
    let threw = false;
    try {
      findRepoRoot(null);
      findRepoRoot(undefined);
      findRepoRoot(42);
    } catch {
      threw = true;
    }
    eq(threw, false);
    eq(findRepoRoot(null), null);
  });

  test("findRepoRoot memoises: a second call for the same directory returns the same answer without re-walking", () => {
    const repo = tmpdir();
    fs.mkdirSync(path.join(repo, ".git"));
    const nested = path.join(repo, "sub");
    fs.mkdirSync(nested);

    const first = findRepoRoot(nested);
    // Removing the .git entry proves the second call is served from the
    // memoised cache rather than re-walking the (now different) filesystem.
    fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true });
    const second = findRepoRoot(nested);

    eq(first, repo);
    eq(second, repo);
    ok(!fs.existsSync(path.join(repo, ".git")), "the .git entry really was removed before the second call");
  });

  /* ------------------------------------------------------ extractShellWorkdir */

  test("extractShellWorkdir: cd <dir> resolves the named directory", () => {
    const parent = tmpdir();
    const repo = path.join(parent, "RepoA");
    fs.mkdirSync(repo);
    eq(extractShellWorkdir("cd RepoA && npx tsc --noEmit", parent), repo);
  });

  test("extractShellWorkdir: pushd <dir> resolves the named directory", () => {
    const parent = tmpdir();
    const repo = path.join(parent, "RepoA");
    fs.mkdirSync(repo);
    eq(extractShellWorkdir("pushd RepoA", parent), repo);
  });

  test("extractShellWorkdir: git -C <dir> <verb> resolves the named directory", () => {
    const parent = tmpdir();
    const repo = path.join(parent, "RepoB");
    fs.mkdirSync(repo);
    eq(extractShellWorkdir('git -C RepoB commit -m "x"', parent), repo);
  });

  test("extractShellWorkdir: npm --prefix <dir> resolves the named directory", () => {
    const parent = tmpdir();
    const repo = path.join(parent, "RepoA");
    fs.mkdirSync(repo);
    eq(extractShellWorkdir("npm --prefix RepoA run build", parent), repo);
  });

  test("extractShellWorkdir: npm -C <dir> resolves the named directory", () => {
    const parent = tmpdir();
    const repo = path.join(parent, "RepoA");
    fs.mkdirSync(repo);
    eq(extractShellWorkdir("npm -C RepoA run build", parent), repo);
  });

  test("extractShellWorkdir: yarn --cwd <dir> resolves the named directory", () => {
    const parent = tmpdir();
    const repo = path.join(parent, "RepoB");
    fs.mkdirSync(repo);
    eq(extractShellWorkdir("yarn --cwd RepoB install", parent), repo);
  });

  test("extractShellWorkdir: pnpm -C <dir> resolves the named directory", () => {
    const parent = tmpdir();
    const repo = path.join(parent, "RepoB");
    fs.mkdirSync(repo);
    eq(extractShellWorkdir("pnpm -C RepoB run build", parent), repo);
  });

  test("extractShellWorkdir: dotnet <path-to-csproj> resolves the project's containing directory", () => {
    const parent = tmpdir();
    const repo = path.join(parent, "RepoB");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "Thing.csproj"), "");
    eq(extractShellWorkdir("dotnet build RepoB/src/Thing.csproj", parent), path.join(repo, "src"));
  });

  test("extractShellWorkdir: dotnet <path-to-sln> with no verb also resolves", () => {
    const parent = tmpdir();
    const repo = path.join(parent, "RepoB");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "All.sln"), "");
    eq(extractShellWorkdir("dotnet RepoB/All.sln", parent), repo);
  });

  test("extractShellWorkdir: a generic --cwd flag resolves on any command", () => {
    const parent = tmpdir();
    const repo = path.join(parent, "RepoA");
    fs.mkdirSync(repo);
    eq(extractShellWorkdir("sometool --cwd RepoA doit", parent), repo);
  });

  test("extractShellWorkdir: a generic --project flag resolves on any command", () => {
    const parent = tmpdir();
    const repo = path.join(parent, "RepoB");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "tsconfig.json"), "{}");
    eq(extractShellWorkdir("npx tsc --project RepoB/tsconfig.json", parent), repo);
  });

  test("extractShellWorkdir: two different directories fall back to null rather than guessing", () => {
    const parent = tmpdir();
    const repoA = path.join(parent, "RepoA");
    const repoB = path.join(parent, "RepoB");
    fs.mkdirSync(repoA);
    fs.mkdirSync(repoB);
    eq(extractShellWorkdir("cd RepoA && git -C RepoB status", parent), null);
  });

  test("extractShellWorkdir: naming the same directory twice still resolves cleanly", () => {
    const parent = tmpdir();
    const repo = path.join(parent, "RepoA");
    fs.mkdirSync(repo);
    eq(extractShellWorkdir("cd RepoA && npm --prefix RepoA run build", parent), repo);
  });

  test("extractShellWorkdir: a directory that does not exist on disk yields null", () => {
    const parent = tmpdir();
    eq(extractShellWorkdir("cd DoesNotExist && npx tsc --noEmit", parent), null);
  });

  test("extractShellWorkdir: a quoted path with spaces resolves correctly", () => {
    const parent = tmpdir().split(path.sep).join("/");
    const target = `${parent}/Program Files (x86)/x`;
    fs.mkdirSync(target.split("/").join(path.sep), { recursive: true });
    const command = `cd "${target}" && npx tsc --noEmit`;
    eq(extractShellWorkdir(command, parent), target.split("/").join(path.sep));
  });

  test("extractShellWorkdir: a plain command naming no directory yields null", () => {
    const parent = tmpdir();
    eq(extractShellWorkdir("npx tsc --noEmit", parent), null);
  });

  test("extractShellWorkdir: an absolute candidate is used as-is, ignoring the anchor", () => {
    const parent = tmpdir();
    const other = tmpdir();
    eq(extractShellWorkdir(`cd '${other}' && npm test`, parent), other);
  });

  /* -------------------------- extractShellWorkdir: double-quoted Windows paths */

  test("extractShellWorkdir: a double-quoted Windows path with backslashes resolves correctly (regression)", () => {
    // core/lib/shell-parse.js#splitTokens used to apply POSIX backslash-escape
    // rules inside double quotes, which ate every backslash out of a raw
    // Windows path and left this resolving to null instead of the repo.
    const parent = tmpdir();
    const repo = path.join(parent, "SomeRepo");
    fs.mkdirSync(repo);
    eq(extractShellWorkdir(`cd "${repo}" && npx tsc --noEmit`, parent), repo);
  });

  test("extractShellWorkdir: a double-quoted forward-slash path resolves correctly", () => {
    const parent = tmpdir().split(path.sep).join("/");
    const target = `${parent}/RepoA`;
    fs.mkdirSync(target.split("/").join(path.sep));
    const command = `cd "${target}" && npx tsc --noEmit`;
    eq(extractShellWorkdir(command, parent), target.split("/").join(path.sep));
  });

  /* -------------------------------- extractShellWorkdir: PowerShell cd verbs */

  const powershellCwdVerbs = [
    { label: "Set-Location", makeCommand: (dir) => `Set-Location "${dir}"; npx tsc --noEmit` },
    { label: "sl (Set-Location alias)", makeCommand: (dir) => `sl "${dir}"; npx tsc --noEmit` },
    { label: "chdir (Set-Location alias)", makeCommand: (dir) => `chdir "${dir}"; npx tsc --noEmit` },
    { label: "Push-Location", makeCommand: (dir) => `Push-Location "${dir}"` },
  ];

  for (const c of powershellCwdVerbs) {
    test(`extractShellWorkdir: PowerShell ${c.label} resolves the named directory`, () => {
      const parent = tmpdir();
      const repo = path.join(parent, "RepoA");
      fs.mkdirSync(repo);
      eq(extractShellWorkdir(c.makeCommand(repo), parent), repo);
    });
  }

  /* --------------------------------------- extractShellWorkdir: negative cases */

  test("extractShellWorkdir: git status alone, with no -C flag, names no directory", () => {
    const parent = tmpdir();
    eq(extractShellWorkdir("git status", parent), null);
  });

  test("extractShellWorkdir: cd with no argument yields null", () => {
    const parent = tmpdir();
    eq(extractShellWorkdir("cd", parent), null);
  });

  test("extractShellWorkdir: Set-Location with no argument yields null", () => {
    const parent = tmpdir();
    eq(extractShellWorkdir("Set-Location", parent), null);
  });

  test("extractShellWorkdir: a directory named only inside a quoted string argument to an unrelated command yields null", () => {
    const parent = tmpdir();
    const repo = path.join(parent, "RepoA");
    fs.mkdirSync(repo);
    eq(extractShellWorkdir(`echo "cd ${repo}"`, parent), null);
  });

  test("extractShellWorkdir: never throws on a bogus command or cwd", () => {
    let threw = false;
    let result;
    try {
      result = extractShellWorkdir(null, undefined);
      extractShellWorkdir(42, {});
      extractShellWorkdir("", "");
    } catch {
      threw = true;
    }
    eq(threw, false);
    eq(result, null);
  });

  test("extractShellWorkdir: empty command yields null", () => {
    eq(extractShellWorkdir("", tmpdir()), null);
  });
});
