"use strict";

/**
 * `core/installer/manifest.js` — the ownership manifest's own read/write
 * shape (INSTALLER.md §4), independent of any full install.
 */

const { suite } = require("../harness");
const manifest = require("../../core/installer/manifest");
const { manifestPath } = require("../../core/lib/paths");
const { writeJsonAtomic, writeTextAtomic } = require("../../core/lib/fs-safe");

suite("installer/manifest", ({ test, eq, deepEq, fakeHome }) => {
  test("readManifest returns null when no manifest file exists", () => {
    fakeHome();
    eq(manifest.readManifest("claude"), null);
  });

  test("emptyManifest defaults version and normalises agent", () => {
    deepEq(manifest.emptyManifest("codex", "1.2.3"), {
      version: "1.2.3",
      installedAt: null,
      agent: "codex",
      files: {},
      settings: [],
      blocks: [],
      modules: [],
    });
    eq(manifest.emptyManifest("claude", undefined).version, "0.0.0");
    eq(manifest.emptyManifest("anything-else", "1.0.0").agent, "claude");
  });

  test("write then read round-trips exactly", () => {
    fakeHome();
    const written = {
      version: "0.3.0",
      installedAt: "2026-08-17T00:00:00.000Z",
      agent: "claude",
      files: { "softela-ai/core/engine.js": "abc123" },
      settings: [{ file: "settings.json", pointer: "/hooks/PreToolUse/0", mode: "enforce" }],
      blocks: [{ file: "CLAUDE.md", marker: "softela-ai" }],
      modules: ["memory-as-context"],
    };
    manifest.writeManifest("claude", written);
    deepEq(manifest.readManifest("claude"), written);
  });

  test("readManifest defaults every non-files field for a malformed file", () => {
    const home = fakeHome();
    writeJsonAtomic(manifestPath("claude"), { modules: "not-an-array", settings: "not-an-array", blocks: 5, version: 7, installedAt: 7, agent: "bogus" });
    deepEq(manifest.readManifest("claude"), {
      version: "0.0.0",
      installedAt: null,
      agent: "claude",
      files: {},
      settings: [],
      blocks: [],
      modules: [],
    });
    eq(typeof home, "string");
  });

  test("readManifest treats a files map of the wrong JSON type as an unreadable manifest, not a silently wiped one", () => {
    fakeHome();
    // A `files` value that is not a genuine per-path-hash object cannot be
    // trusted for ownership tracking at all — `typeof [] === "object"` would
    // slip past a check that only rejects non-objects, so an array is the
    // regression case that actually exercises the guard.
    writeJsonAtomic(manifestPath("claude"), { version: "1.0.0", agent: "claude", files: [], settings: [], blocks: [], modules: [] });
    eq(manifest.readManifest("claude"), null);
  });

  test("readManifest treats a non-object, non-array files value the same way — unreadable, not silently defaulted", () => {
    fakeHome();
    writeJsonAtomic(manifestPath("claude"), { version: "1.0.0", agent: "claude", files: "not-an-object", settings: [], blocks: [], modules: [] });
    eq(manifest.readManifest("claude"), null);
  });

  test("readManifest returns null for a file that is not valid JSON", () => {
    fakeHome();
    writeTextAtomic(manifestPath("claude"), "{ not json");
    eq(manifest.readManifest("claude"), null);
  });

  test("claude and codex manifests are stored independently", () => {
    fakeHome();
    manifest.writeManifest("claude", manifest.emptyManifest("claude", "1.0.0"));
    eq(manifest.readManifest("codex"), null);
    manifest.writeManifest("codex", manifest.emptyManifest("codex", "1.0.0"));
    eq(manifest.readManifest("claude").agent, "claude");
    eq(manifest.readManifest("codex").agent, "codex");
  });
});
