"use strict";

/**
 * `core/lib/short-path.js#resolvePathToken` — every case here drives the
 * `platform` and `shortPathResolver` injection points the module exposes,
 * so none of it depends on this machine's own volume settings (whether 8.3
 * short-name generation happens to be enabled on the disk running these
 * tests). Only the two cases that must observe real ancestor-verification
 * behaviour (a genuine successful resolution, and a failed one) touch the
 * filesystem, via `tmpdir()`, and even there the "short form" itself is a
 * plain directory this suite creates — never a real OS-generated 8.3 alias.
 */

const fs = require("fs");
const path = require("path");

const { suite } = require("../harness");
const shortPath = require("../../core/lib/short-path");

suite("lib/short-path", ({ test, eq, ok, tmpdir }) => {
  /**
   * A resolver that fails the test if it is ever invoked — proves a code
   * path never spawns the underlying subprocess.
   *
   * @returns {never} Never returns; always throws.
   */
  function unreachableResolver() {
    throw new Error("shortPathResolver must not be called for this input");
  }

  const cases = [
    // --- negative: non-Windows always quotes, short-path machinery never engages
    {
      label: "a non-Windows platform always quotes, regardless of spaces",
      absPath: "/usr/local/bin/node",
      platform: "linux",
      resolver: unreachableResolver,
      want: { value: '"/usr/local/bin/node"', usedShortPath: false },
    },

    // --- positive: no space means no resolution work is needed at all
    {
      label: "a Windows path with no space is returned bare, with no resolver call",
      absPath: "C:\\PROGRA~1\\nodejs\\node.exe",
      platform: "win32",
      resolver: unreachableResolver,
      want: { value: "C:\\PROGRA~1\\nodejs\\node.exe", usedShortPath: false },
    },

    // --- negative: resolver ran, but every result is untrustworthy
    {
      label: "a resolver result that still contains a space falls back to quoted",
      absPath: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
      resolver: () => "C:\\Program Files\\nodejs\\node.exe",
      want: { value: '"C:\\Program Files\\nodejs\\node.exe"', usedShortPath: false },
    },
    {
      label: "a resolver returning null falls back to quoted",
      absPath: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
      resolver: () => null,
      want: { value: '"C:\\Program Files\\nodejs\\node.exe"', usedShortPath: false },
    },
    {
      label: "a resolver that throws falls back to quoted instead of propagating",
      absPath: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
      resolver: () => {
        throw new Error("cmd.exe is not available");
      },
      want: { value: '"C:\\Program Files\\nodejs\\node.exe"', usedShortPath: false },
    },
  ];

  for (const c of cases) {
    test(c.label, () => {
      const got = shortPath.resolvePathToken(c.absPath, { platform: c.platform, shortPathResolver: c.resolver });
      eq(got.value, c.want.value, c.label);
      eq(got.usedShortPath, c.want.usedShortPath, c.label);
    });
  }

  // --- positive: a genuine, verifiable short form is trusted and used bare
  //
  // The stand-in "short form" directory below is deliberately named nothing
  // like a real 8.3 alias (no `~1` tilde form) — on a volume that actually
  // has 8.3 generation enabled, creating the long-named directory first
  // would otherwise silently reserve its real alias, and a same-shaped
  // fabricated directory would then collide with it (EEXIST) instead of
  // existing as the independent entry this test needs.
  test("a resolver result verified against a real, existing ancestor is used bare", () => {
    const dir = tmpdir();
    const longDir = path.join(dir, "space dir");
    const shortDir = path.join(dir, "fabricatedshortform");
    fs.mkdirSync(longDir);
    fs.mkdirSync(shortDir);

    const got = shortPath.resolvePathToken(longDir, { platform: "win32", shortPathResolver: () => shortDir });
    eq(got.value, shortDir);
    eq(got.usedShortPath, true);
  });

  // --- negative: a syntactically clean short form that fails on-disk verification still falls back
  test("a short form that fails ancestor verification falls back to quoted", () => {
    const dir = tmpdir();
    const absPath = path.join(dir, "sub dir", "target.js"); // neither "sub dir" nor "target.js" exist
    const badShort = path.join(dir, "bogus-ancestor", "SUBDIR~1", "target.js"); // "bogus-ancestor" was never created

    const got = shortPath.resolvePathToken(absPath, { platform: "win32", shortPathResolver: () => badShort });
    eq(got.value, shortPath.quotePath(absPath));
    eq(got.usedShortPath, false);
  });

  // --- positive: the fresh-install case — the target's own tree does not exist yet, only an ancestor does
  test("a target that does not exist yet still resolves, off its nearest existing ancestor", () => {
    const dir = tmpdir();
    const absPath = path.join(dir, "sub dir", "target.js"); // neither "sub dir" nor "target.js" exist
    const shortForm = path.join(dir, "SUBDIR~1", "target.js"); // same depth, no ancestor directory required to exist

    const got = shortPath.resolvePathToken(absPath, { platform: "win32", shortPathResolver: () => shortForm });
    eq(got.value, shortForm);
    eq(got.usedShortPath, true);
  });
});
