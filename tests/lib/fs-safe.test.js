"use strict";

const fs = require("fs");
const path = require("path");

const { suite } = require("../harness");
const fsSafe = require("../../core/lib/fs-safe");

suite("lib/fs-safe", ({ test, eq, ok, deepEq, tmpdir }) => {
  test("readText normalises CRLF to LF", () => {
    const dir = tmpdir();
    const p = path.join(dir, "a.txt");
    fs.writeFileSync(p, "line1\r\nline2\r\n");
    eq(fsSafe.readText(p), "line1\nline2\n");
  });

  test("readText returns null for a missing file", () => {
    eq(fsSafe.readText(path.join(tmpdir(), "missing.txt")), null);
  });

  test("readJson parses valid JSON", () => {
    const dir = tmpdir();
    const p = path.join(dir, "a.json");
    fs.writeFileSync(p, '{"a": 1}');
    deepEq(fsSafe.readJson(p), { a: 1 });
  });

  test("readJson returns null for malformed JSON", () => {
    const dir = tmpdir();
    const p = path.join(dir, "bad.json");
    fs.writeFileSync(p, "{not json");
    eq(fsSafe.readJson(p), null);
  });

  test("readJson returns null for a missing file", () => {
    eq(fsSafe.readJson(path.join(tmpdir(), "missing.json")), null);
  });

  test("writeTextAtomic creates parent directories and writes LF", () => {
    const dir = tmpdir();
    const p = path.join(dir, "nested", "deep", "a.txt");
    fsSafe.writeTextAtomic(p, "hello\r\nworld");
    eq(fs.readFileSync(p, "utf8"), "hello\nworld");
  });

  test("writeTextAtomic leaves no temp file behind", () => {
    const dir = tmpdir();
    const p = path.join(dir, "a.txt");
    fsSafe.writeTextAtomic(p, "content");
    const entries = fs.readdirSync(dir);
    deepEq(entries, ["a.txt"]);
  });

  test("writeJsonAtomic writes formatted JSON with a trailing newline", () => {
    const dir = tmpdir();
    const p = path.join(dir, "a.json");
    fsSafe.writeJsonAtomic(p, { a: 1, b: [1, 2] });
    const raw = fs.readFileSync(p, "utf8");
    eq(raw, `${JSON.stringify({ a: 1, b: [1, 2] }, null, 2)}\n`);
  });

  test("sha256 is stable across CRLF and LF of the same content", () => {
    eq(fsSafe.sha256("a\r\nb"), fsSafe.sha256("a\nb"));
  });

  test("sha256 differs for different content", () => {
    ok(fsSafe.sha256("a") !== fsSafe.sha256("b"));
  });

  test("copyFileSafe copies a file and creates the destination directory", () => {
    const dir = tmpdir();
    const src = path.join(dir, "src.txt");
    fs.writeFileSync(src, "data");
    const dest = path.join(dir, "nested", "dest.txt");
    eq(fsSafe.copyFileSafe(src, dest), true);
    eq(fs.readFileSync(dest, "utf8"), "data");
  });

  test("copyFileSafe returns false instead of throwing when the source is missing", () => {
    const dir = tmpdir();
    eq(fsSafe.copyFileSafe(path.join(dir, "missing.txt"), path.join(dir, "dest.txt")), false);
  });

  test("ensureDir creates nested directories", () => {
    const dir = tmpdir();
    const target = path.join(dir, "a", "b", "c");
    fsSafe.ensureDir(target);
    ok(fs.statSync(target).isDirectory());
  });

  test("removeIfExists removes a file without throwing", () => {
    const dir = tmpdir();
    const p = path.join(dir, "a.txt");
    fs.writeFileSync(p, "x");
    fsSafe.removeIfExists(p);
    eq(fs.existsSync(p), false);
  });

  test("removeIfExists is a no-op on a missing path", () => {
    const dir = tmpdir();
    fsSafe.removeIfExists(path.join(dir, "missing.txt"));
    ok(true);
  });

  test("listFilesRecursive lists nested files, sorted, POSIX-separated", () => {
    const dir = tmpdir();
    fs.mkdirSync(path.join(dir, "b"), { recursive: true });
    fs.mkdirSync(path.join(dir, "a"), { recursive: true });
    fs.writeFileSync(path.join(dir, "b", "two.txt"), "x");
    fs.writeFileSync(path.join(dir, "a", "one.txt"), "x");
    fs.writeFileSync(path.join(dir, "root.txt"), "x");
    deepEq(fsSafe.listFilesRecursive(dir), ["a/one.txt", "b/two.txt", "root.txt"]);
  });

  test("listFilesRecursive skips .git and node_modules", () => {
    const dir = tmpdir();
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".git", "config"), "x");
    fs.writeFileSync(path.join(dir, "node_modules", "pkg.js"), "x");
    fs.writeFileSync(path.join(dir, "kept.txt"), "x");
    deepEq(fsSafe.listFilesRecursive(dir), ["kept.txt"]);
  });

  test("listFilesRecursive returns an empty array for a missing directory", () => {
    deepEq(fsSafe.listFilesRecursive(path.join(tmpdir(), "missing")), []);
  });

  /* ------------------------------------------------ options: skipDirs */

  test("listFilesRecursive with an empty options object behaves like no options at all", () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, "kept.txt"), "x");
    deepEq(fsSafe.listFilesRecursive(dir, {}), ["kept.txt"]);
  });

  test("listFilesRecursive skipDirs adds to, rather than replaces, the default skip set", () => {
    const dir = tmpdir();
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".git", "config"), "x");
    fs.writeFileSync(path.join(dir, "bin", "built.dll"), "x");
    fs.writeFileSync(path.join(dir, "kept.txt"), "x");
    deepEq(fsSafe.listFilesRecursive(dir, { skipDirs: ["bin"] }), ["kept.txt"]);
  });

  /* ---------------------------------------------- options: extensions */

  test("listFilesRecursive extensions restricts the result to matching files", () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, "a.cs"), "x");
    fs.writeFileSync(path.join(dir, "b.csproj"), "x");
    fs.writeFileSync(path.join(dir, "c.ts"), "x");
    deepEq(fsSafe.listFilesRecursive(dir, { extensions: [".cs", ".ts"] }), ["a.cs", "c.ts"]);
  });

  test("listFilesRecursive extensions comparison is case-insensitive", () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, "a.CS"), "x");
    deepEq(fsSafe.listFilesRecursive(dir, { extensions: [".cs"] }), ["a.CS"]);
  });

  /* --------------------------------------------------- options: limit */

  test("listFilesRecursive with a limit returns complete:true and the full sorted list when under the bound", () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, "b.txt"), "x");
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    deepEq(fsSafe.listFilesRecursive(dir, { limit: 5 }), { files: ["a.txt", "b.txt"], complete: true });
  });

  test("listFilesRecursive with a limit exactly equal to the file count is still complete", () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    fs.writeFileSync(path.join(dir, "b.txt"), "x");
    deepEq(fsSafe.listFilesRecursive(dir, { limit: 2 }), { files: ["a.txt", "b.txt"], complete: true });
  });

  test("listFilesRecursive with a limit exceeded returns complete:false and no files", () => {
    const dir = tmpdir();
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), "x");
    deepEq(fsSafe.listFilesRecursive(dir, { limit: 3 }), { files: [], complete: false });
  });

  test("listFilesRecursive with limit:0 and no files is complete with an empty list", () => {
    const dir = tmpdir();
    deepEq(fsSafe.listFilesRecursive(dir, { limit: 0 }), { files: [], complete: true });
  });
});
