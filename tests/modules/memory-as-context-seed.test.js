"use strict";

/**
 * Tests for `modules/memory-as-context/hooks/seed-memory.js` — the seeder
 * that lands this module's shipped knowledge base into a developer's memory
 * directory.
 *
 * Every fixture here is authored by this file, under a disposable `tmpdir()`
 * — never this repository's own real `modules/memory-as-context/seed/`
 * content, which is populated independently and may hold anywhere from zero
 * to many files while these tests run. `seed-memory.js`'s own
 * `SOFTELA_AI_SEED_CATALOG_DIR` override (see its module doc) is what makes that
 * isolation possible: every call below points it at a fixture catalogue this
 * file built itself.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { suite } = require("../harness");
const { paths } = require("./_helpers");
const { listFilesRecursive } = require("../../core/lib/fs-safe");
const managedBlock = require("../../core/installer/managed-block");
const seedMemoryLib = require("../../modules/memory-as-context/hooks/seed-memory");
const { HOME_LOCATION_DIRNAME } = require("../../modules/memory-as-context/hooks/memory-location");

const HOOKS_DIR = path.join(paths.repoRoot(), "modules", "memory-as-context", "hooks");
const SEED_SCRIPT = path.join(HOOKS_DIR, "seed-memory.js");
const INJECT_SCRIPT = path.join(HOOKS_DIR, "inject-memory.js");

/** Fixture `ACTIVE-WORK.tmpl.md` content — distinctive, so an exact-match assertion is unambiguous. */
const FIXTURE_TEMPLATE = "# Fixture active-work template\n\nThis text exists only to be asserted on by seed-memory.js's own tests.\n";

/**
 * Resolves the `"global"` memory root for an agent home, matching what
 * `resolveMemoryDir` itself resolves for that location.
 *
 * @param {string} agentHome The agent home directory.
 * @returns {string} `<agentHome>/memory`.
 */
function homeMemoryRoot(agentHome) {
  return path.join(agentHome, HOME_LOCATION_DIRNAME);
}

/**
 * Builds one seed file's full text, frontmatter included.
 *
 * @param {object} options
 * @param {string} options.name The frontmatter `name` field.
 * @param {string} options.description The frontmatter `description` field.
 * @param {string} [options.body] The body text below the frontmatter.
 * @returns {string} The file's full text.
 */
function seedFile({ name, description, body = "Fixture body text." }) {
  return `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: reference\n  source: softela-ai\n---\n\n${body}\n`;
}

/**
 * Builds a fixture module catalogue directory: a stub `module.json`, a
 * `seed/` directory holding the given files, and (by default) a fixture
 * `ACTIVE-WORK.tmpl.md` — the exact shape `resolveModuleCatalogDir()` looks
 * for.
 *
 * @param {string} root The directory to build the catalogue in; must already exist.
 * @param {Record<string, string>} seedFiles Seed file name to its full text.
 * @param {object} [options]
 * @param {boolean} [options.includeTemplate] Whether to write the fixture
 * `ACTIVE-WORK.tmpl.md`; `true` by default.
 * @returns {string} `root`, for chaining.
 */
function buildFixtureCatalog(root, seedFiles, { includeTemplate = true } = {}) {
  fs.writeFileSync(path.join(root, "module.json"), JSON.stringify({ id: "memory-as-context" }));
  const seedDir = path.join(root, "seed");
  fs.mkdirSync(seedDir, { recursive: true });
  for (const [fileName, content] of Object.entries(seedFiles)) {
    fs.writeFileSync(path.join(seedDir, fileName), content);
  }
  if (includeTemplate) fs.writeFileSync(path.join(root, "ACTIVE-WORK.tmpl.md"), FIXTURE_TEMPLATE);
  return root;
}

/**
 * Copies one real hook script's current on-disk content into a fixture
 * `hooks/` directory — code this repository ships, never seed data, so
 * copying it does not touch the "fixtures only, never real seed content"
 * boundary this file otherwise holds to.
 *
 * @param {string} destHooksDir The fixture `hooks/` directory; created if absent.
 * @param {string} name The script's file name under the real `hooks/`.
 * @returns {void}
 */
function copyRealHookFile(destHooksDir, name) {
  fs.mkdirSync(destHooksDir, { recursive: true });
  fs.writeFileSync(path.join(destHooksDir, name), fs.readFileSync(path.join(HOOKS_DIR, name), "utf8"));
}

/**
 * Copies the real `core/lib/hook-stdin.js` — code, not seed data — to where
 * `hooks/stdin.js`'s own installed-layout resolution
 * (`INSTALLED_LAYOUT_PATH`, one directory above `hooks/`) expects to find
 * it: `<root>/core/lib/hook-stdin.js`. Satisfies `stdin.js`'s own
 * `require`, which every hook script in this module — `seed-memory.js`
 * included — depends on transitively.
 *
 * @param {string} root The fixture's own root — the real module's directory
 * for a repo-layout fixture, or the fixture's `softela-ai`-equivalent installed
 * root for an installed-layout fixture; either way, one level above `hooks/`.
 * @returns {void}
 */
function copyRealHookStdinDependency(root) {
  const destDir = path.join(root, "core", "lib");
  fs.mkdirSync(destDir, { recursive: true });
  const source = path.join(paths.repoRoot(), "core", "lib", "hook-stdin.js");
  fs.writeFileSync(path.join(destDir, "hook-stdin.js"), fs.readFileSync(source, "utf8"));
}

/**
 * Runs `seed-memory.js` as a real subprocess, exactly the way a developer
 * (or `inject-memory.js`'s own standalone CLI path) would invoke it, with
 * its catalogue-directory override pointed at a fixture.
 *
 * @param {string} agentHome A real, disposable agent home directory.
 * @param {string} catalogDir A fixture catalogue directory built by
 * {@link buildFixtureCatalog}.
 * @param {object} [payload] The JSON payload written to stdin.
 * @returns {string} The subprocess's stdout.
 */
function runSeedMemory(agentHome, catalogDir, payload = {}) {
  return execFileSync(process.execPath, [SEED_SCRIPT, `--agent-home=${agentHome}`, "--location=global"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, [seedMemoryLib.CATALOG_DIR_OVERRIDE_ENV]: catalogDir },
  });
}

/**
 * Runs the real `inject-memory.js` — never a fixture copy, since its own
 * sibling `require("./seed-memory")` must resolve to this module's real,
 * current `seed-memory.js` — as a real subprocess, with its catalogue
 * override pointed at a fixture, exactly like {@link runSeedMemory}.
 *
 * @param {string} agentHome A real, disposable agent home directory.
 * @param {string} catalogDir A fixture catalogue directory built by {@link buildFixtureCatalog}.
 * @param {object} [payload] The JSON payload written to stdin.
 * @returns {string} The subprocess's stdout — a single JSON hook payload.
 */
function runInjectMemory(agentHome, catalogDir, payload = {}) {
  return execFileSync(process.execPath, [INJECT_SCRIPT, `--agent-home=${agentHome}`, "--location=global"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, [seedMemoryLib.CATALOG_DIR_OVERRIDE_ENV]: catalogDir },
  });
}

/**
 * Builds the text of a `MEMORY.md` whose managed block is ambiguous by
 * duplication — two complete `BEGIN…END` pairs — the shape
 * `seed-memory.js#locateBlock` refuses to touch.
 *
 * @returns {string} The ambiguous file content.
 */
function duplicatedBlockMemoryMd() {
  return `${seedMemoryLib.BEGIN}\n\nold\n\n${seedMemoryLib.END}\n\n${seedMemoryLib.BEGIN}\n\nold2\n\n${seedMemoryLib.END}\n`;
}

/**
 * Runs a hook script directly, with the catalogue-override environment
 * variable explicitly absent — for the two tests that must prove
 * `resolveModuleCatalogDir()`'s own on-disk-layout resolution works, not
 * just the override escape hatch.
 *
 * @param {string} scriptPath The absolute path to the hook script to run.
 * @param {string} agentHome A real, disposable agent home directory.
 * @returns {void}
 */
function runWithoutOverride(scriptPath, agentHome) {
  const env = { ...process.env };
  delete env[seedMemoryLib.CATALOG_DIR_OVERRIDE_ENV];
  execFileSync(process.execPath, [scriptPath, `--agent-home=${agentHome}`, "--location=global"], {
    input: "{}",
    encoding: "utf8",
    env,
  });
}

/**
 * Snapshots every non-`.git` file under a directory: content and mtime,
 * keyed by path relative to `dir`.
 *
 * @param {string} dir The directory to snapshot.
 * @returns {Record<string, {content: string, mtimeMs: number}>} One entry per file.
 */
function snapshotTree(dir) {
  const snapshot = {};
  for (const rel of listFilesRecursive(dir)) {
    const full = path.join(dir, ...rel.split("/"));
    snapshot[rel] = { content: fs.readFileSync(full, "utf8"), mtimeMs: fs.statSync(full).mtimeMs };
  }
  return snapshot;
}

suite("modules/memory-as-context: seed-memory.js", ({ test, eq, deepEq, ok, notThrows, tmpdir }) => {
  /* --------------------------------------------------- marker-drift guard */

  test("the managed-block markers duplicated in seed-memory.js stay byte-identical to core/installer/managed-block.js's own", () => {
    eq(seedMemoryLib.BEGIN, managedBlock.BEGIN, "BEGIN marker must not have drifted from the installer's own");
    eq(seedMemoryLib.END, managedBlock.END, "END marker must not have drifted from the installer's own");
  });

  /* ---------------------------------------------------------- core cases */

  test("a fresh, empty memory directory gets softela/, a generated index block, and an ACTIVE-WORK.md stub", () => {
    const agentHome = tmpdir();
    const catalogDir = tmpdir();
    buildFixtureCatalog(catalogDir, {
      "alpha.md": seedFile({ name: "alpha", description: "Alpha topic description." }),
      "beta.md": seedFile({ name: "beta", description: "Beta topic description." }),
    });
    const memoryDir = homeMemoryRoot(agentHome);
    ok(!fs.existsSync(memoryDir), "sanity check: the memory directory must not exist yet");

    runSeedMemory(agentHome, catalogDir);

    eq(fs.readFileSync(path.join(memoryDir, "softela", "alpha.md"), "utf8"), seedFile({ name: "alpha", description: "Alpha topic description." }));
    eq(fs.readFileSync(path.join(memoryDir, "softela", "beta.md"), "utf8"), seedFile({ name: "beta", description: "Beta topic description." }));

    const memoryMd = fs.readFileSync(path.join(memoryDir, "MEMORY.md"), "utf8");
    ok(memoryMd.includes(seedMemoryLib.BEGIN) && memoryMd.includes(seedMemoryLib.END), "the managed block must be present");
    ok(memoryMd.includes("- [alpha](softela/alpha.md) — Alpha topic description."), "the index must link the alpha entry");
    ok(memoryMd.includes("- [beta](softela/beta.md) — Beta topic description."), "the index must link the beta entry");

    eq(fs.readFileSync(path.join(memoryDir, "ACTIVE-WORK.md"), "utf8"), FIXTURE_TEMPLATE);
  });

  test("a directory holding the developer's own MEMORY.md keeps every line outside the block", () => {
    const agentHome = tmpdir();
    const catalogDir = tmpdir();
    buildFixtureCatalog(catalogDir, { "alpha.md": seedFile({ name: "alpha", description: "Alpha topic description." }) });
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });
    const developerContent = "# My own index\n\nOlder knowledge already on disk, written by hand.\n";
    fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), developerContent);

    runSeedMemory(agentHome, catalogDir);

    const after = fs.readFileSync(path.join(memoryDir, "MEMORY.md"), "utf8");
    ok(after.startsWith(developerContent), "every developer line must survive, untouched, ahead of the appended block");
    ok(after.includes("- [alpha](softela/alpha.md) — Alpha topic description."), "the generated block must still have been appended");
  });

  test("a top-level file with the same slug suppresses its seed twin", () => {
    const agentHome = tmpdir();
    const catalogDir = tmpdir();
    buildFixtureCatalog(catalogDir, {
      "alpha.md": seedFile({ name: "alpha", description: "Alpha topic description." }),
      "beta.md": seedFile({ name: "beta", description: "Beta topic description." }),
    });
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });
    const developerAlpha = "# The developer's own alpha notes\n\nmanaged by hand, not by the seeder\n";
    fs.writeFileSync(path.join(memoryDir, "alpha.md"), developerAlpha);

    runSeedMemory(agentHome, catalogDir);

    ok(!fs.existsSync(path.join(memoryDir, "softela", "alpha.md")), "the developer's own copy wins — no seed twin under softela/");
    ok(fs.existsSync(path.join(memoryDir, "softela", "beta.md")), "an unsuppressed entry must still be seeded");

    const memoryMd = fs.readFileSync(path.join(memoryDir, "MEMORY.md"), "utf8");
    ok(!memoryMd.includes("softela/alpha.md"), "a suppressed entry must not appear in the index");
    ok(memoryMd.includes("softela/beta.md"), "an unsuppressed entry must appear in the index");

    eq(fs.readFileSync(path.join(memoryDir, "alpha.md"), "utf8"), developerAlpha, "the developer's own top-level file must be untouched");
  });

  test("a second run is a no-op — marker-gated, byte-identical, mtime-identical, and commits exactly once", () => {
    const agentHome = tmpdir();
    const catalogDir = tmpdir();
    buildFixtureCatalog(catalogDir, { "alpha.md": seedFile({ name: "alpha", description: "Alpha topic description." }) });
    const memoryDir = homeMemoryRoot(agentHome);

    runSeedMemory(agentHome, catalogDir);
    const before = snapshotTree(memoryDir);
    ok(Object.keys(before).length > 0, "sanity check: the first run must have written something");

    runSeedMemory(agentHome, catalogDir);
    const after = snapshotTree(memoryDir);

    deepEq(Object.keys(after).sort(), Object.keys(before).sort(), "no file should be added or removed by the second run");
    for (const rel of Object.keys(before)) {
      eq(after[rel].content, before[rel].content, `${rel} must be byte-identical after the no-op run`);
      eq(after[rel].mtimeMs, before[rel].mtimeMs, `${rel} must keep its exact mtime — the second run must not even rewrite it`);
    }

    const log = execFileSync("git", ["-C", memoryDir, "log", "--oneline"], { encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
    eq(log.length, 1, "the second run must not have attempted a second commit");
  });

  test("malformed frontmatter is skipped without throwing", () => {
    const agentHome = tmpdir();
    const catalogDir = tmpdir();
    buildFixtureCatalog(catalogDir, {
      "good.md": seedFile({ name: "good", description: "A well-formed entry." }),
      "no-fence.md": "This file has no frontmatter fence at all.\n",
      "missing-description.md": "---\nname: missing-description\nmetadata:\n  type: reference\n---\n\nbody\n",
      "empty-name.md": '---\nname: ""\ndescription: has a name field but it is empty\n---\n\nbody\n',
      "unsafe-name.md": "---\nname: ../escape\ndescription: a name that is not a plain slug\n---\n\nbody\n",
    });
    const memoryDir = homeMemoryRoot(agentHome);

    notThrows(() => runSeedMemory(agentHome, catalogDir), "a catalogue full of malformed seed files must never crash the hook");

    const listing = fs
      .readdirSync(path.join(memoryDir, "softela"))
      .filter((n) => n.endsWith(".md"))
      .sort();
    deepEq(listing, ["good.md"], "only the well-formed entry should have landed under softela/");

    const memoryMd = fs.readFileSync(path.join(memoryDir, "MEMORY.md"), "utf8");
    ok(memoryMd.includes("softela/good.md"));
    ok(!memoryMd.includes("no-fence") && !memoryMd.includes("missing-description") && !memoryMd.includes("../escape"));
  });

  test("an unwritable target fails open — a memory-directory path colliding with an existing file never throws", () => {
    const agentHome = tmpdir();
    const catalogDir = tmpdir();
    buildFixtureCatalog(catalogDir, { "alpha.md": seedFile({ name: "alpha", description: "Alpha topic description." }) });
    // Force the resolved memory directory to already exist as a plain FILE,
    // so the very first filesystem operation inside seed-memory.js (creating
    // softela/ underneath it) throws ENOTDIR.
    fs.writeFileSync(homeMemoryRoot(agentHome), "not a directory");

    notThrows(() => runSeedMemory(agentHome, catalogDir), "an unwritable target must fail open, never throw or exit non-zero");
    eq(fs.readFileSync(homeMemoryRoot(agentHome), "utf8"), "not a directory", "the colliding file must be left exactly as found");
  });

  /* ------------------------------- M1: ambiguous MEMORY.md never "succeeds" */

  test("an ambiguous MEMORY.md never gets marked as a successful seed, and self-heals once the developer fixes it by hand — no SEED_VERSION bump needed", () => {
    const agentHome = tmpdir();
    const catalogDir = tmpdir();
    buildFixtureCatalog(catalogDir, { "alpha.md": seedFile({ name: "alpha", description: "Alpha topic description." }) });
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });
    const ambiguous = duplicatedBlockMemoryMd();
    fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), ambiguous);

    runSeedMemory(agentHome, catalogDir);

    ok(fs.existsSync(path.join(memoryDir, "softela", "alpha.md")), "seed files still land even while the index write is stuck");
    eq(fs.readFileSync(path.join(memoryDir, "MEMORY.md"), "utf8"), ambiguous, "an ambiguous MEMORY.md must be left completely untouched");
    ok(!fs.existsSync(path.join(memoryDir, "softela", seedMemoryLib.MARKER_FILE)), "the success marker must never be written for a run that could not update the index");
    const warningPath = path.join(memoryDir, "softela", seedMemoryLib.WARNING_FILE);
    ok(fs.existsSync(warningPath), "the warning marker must record the stuck index");
    const warning = JSON.parse(fs.readFileSync(warningPath, "utf8"));
    ok(typeof warning.reason === "string" && warning.reason.length > 0, "the warning must explain why, not just that something is wrong");

    // Still ambiguous: a second run must retry rather than short-circuit on a
    // marker it never wrote, and must still refuse to stamp success.
    runSeedMemory(agentHome, catalogDir);
    ok(!fs.existsSync(path.join(memoryDir, "softela", seedMemoryLib.MARKER_FILE)), "still no success marker on a second run while still ambiguous");

    // The developer repairs MEMORY.md by hand.
    fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), "# My own index\n\nOlder knowledge, written by hand.\n");
    runSeedMemory(agentHome, catalogDir);

    const memoryMd = fs.readFileSync(path.join(memoryDir, "MEMORY.md"), "utf8");
    ok(memoryMd.includes(seedMemoryLib.BEGIN) && memoryMd.includes("softela/alpha.md"), "the index must land automatically once the ambiguity is fixed");
    ok(fs.existsSync(path.join(memoryDir, "softela", seedMemoryLib.MARKER_FILE)), "the success marker is written once the index write actually succeeds");
    ok(!fs.existsSync(warningPath), "the warning marker must be cleared once the ambiguity is resolved");
  });

  test("an END-before-BEGIN MEMORY.md is judged ambiguous too, with a distinct, accurate reason", () => {
    const agentHome = tmpdir();
    const catalogDir = tmpdir();
    buildFixtureCatalog(catalogDir, { "alpha.md": seedFile({ name: "alpha", description: "Alpha topic description." }) });
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), `${seedMemoryLib.END}\n\n${seedMemoryLib.BEGIN}\n`);

    runSeedMemory(agentHome, catalogDir);

    ok(!fs.existsSync(path.join(memoryDir, "softela", seedMemoryLib.MARKER_FILE)));
    const warning = JSON.parse(fs.readFileSync(path.join(memoryDir, "softela", seedMemoryLib.WARNING_FILE), "utf8"));
    ok(/before its BEGIN/i.test(warning.reason), `reason must describe the END-before-BEGIN shape, got: ${warning.reason}`);
  });

  test("inject-memory.js surfaces a stuck index exactly once — not on a later run while the same ambiguity persists", () => {
    const agentHome = tmpdir();
    const catalogDir = tmpdir();
    buildFixtureCatalog(catalogDir, { "alpha.md": seedFile({ name: "alpha", description: "Alpha topic description." }) });
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), duplicatedBlockMemoryMd());

    const first = JSON.parse(runInjectMemory(agentHome, catalogDir));
    const firstContext = (first.hookSpecificOutput && first.hookSpecificOutput.additionalContext) || "";
    ok(firstContext.includes("Knowledge-base index needs attention"), "the first run must surface the ambiguity in additionalContext");

    const second = JSON.parse(runInjectMemory(agentHome, catalogDir));
    const secondContext = (second.hookSpecificOutput && second.hookSpecificOutput.additionalContext) || "";
    ok(!secondContext.includes("Knowledge-base index needs attention"), "a later run must not repeat the same notice while the ambiguity persists");
  });

  /* -------------------------------------------------- M2: scoped commit paths */

  test("the seeder stages only the paths it wrote — a developer's own untracked scratch file elsewhere in the memory directory is never swept into the seed commit", () => {
    const agentHome = tmpdir();
    const catalogDir = tmpdir();
    buildFixtureCatalog(catalogDir, { "alpha.md": seedFile({ name: "alpha", description: "Alpha topic description." }) });
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, "scratch-note.md"), "the developer's own uncommitted note, unrelated to seeding\n");

    runSeedMemory(agentHome, catalogDir);

    const status = execFileSync("git", ["-C", memoryDir, "status", "--porcelain"], { encoding: "utf8" });
    ok(/\?\?\s+scratch-note\.md/.test(status), `the scratch file must remain untracked after seeding, got status:\n${status}`);

    const committed = execFileSync("git", ["-C", memoryDir, "show", "--stat", "--name-only", "HEAD"], { encoding: "utf8" });
    ok(!committed.includes("scratch-note.md"), `the seed commit must never include the developer's own file, got:\n${committed}`);
    ok(committed.includes("softela/alpha.md"), "the seed commit must still include what it actually wrote");
    ok(committed.includes("MEMORY.md"), "the seed commit must still include the regenerated index");
    ok(committed.includes("ACTIVE-WORK.md"), "the seed commit must still include the freshly created ACTIVE-WORK.md");
  });

  /* ------------------------------------------ M4/M5: parseFrontmatter fixes */

  test("parseFrontmatter: folds a YAML literal block-scalar (|) description into one line instead of capturing the bare indicator", () => {
    const parsed = seedMemoryLib.parseFrontmatter(
      "---\nname: alpha\ndescription: |\n  First line of the description.\n  Second line, folded in too.\n---\n\nbody\n",
    );
    deepEq(parsed, { name: "alpha", description: "First line of the description. Second line, folded in too." });
  });

  test("parseFrontmatter: folds a YAML folded block-scalar (>-) description the same way", () => {
    const parsed = seedMemoryLib.parseFrontmatter("---\nname: alpha\ndescription: >-\n  Folded text here.\n---\n\nbody\n");
    deepEq(parsed, { name: "alpha", description: "Folded text here." });
  });

  test("parseFrontmatter: a block-scalar indicator with nothing indented after it yields no description, never a bare | or >", () => {
    eq(seedMemoryLib.parseFrontmatter("---\nname: alpha\ndescription: |\nmetadata:\n  type: reference\n---\n\nbody\n"), null);
  });

  test("a shipped file using a block-scalar description seeds a proper folded line, never an index entry reading '— |'", () => {
    const agentHome = tmpdir();
    const catalogDir = tmpdir();
    buildFixtureCatalog(catalogDir, {
      "block.md": "---\nname: block\ndescription: |\n  Folded description\n  spanning two lines.\n---\n\nbody\n",
    });

    runSeedMemory(agentHome, catalogDir);

    const memoryMd = fs.readFileSync(path.join(homeMemoryRoot(agentHome), "MEMORY.md"), "utf8");
    ok(memoryMd.includes("- [block](softela/block.md) — Folded description spanning two lines."), memoryMd);
    ok(!memoryMd.includes("— |") && !memoryMd.includes("— >"), "must never render the bare block-scalar indicator as the description");
  });

  test("a leading UTF-8 BOM no longer drops a seed file with no diagnostic", () => {
    const agentHome = tmpdir();
    const catalogDir = tmpdir();
    buildFixtureCatalog(catalogDir, {
      "bommed.md": `﻿${seedFile({ name: "bommed", description: "Has a BOM at the very start of the file." })}`,
    });

    runSeedMemory(agentHome, catalogDir);

    ok(fs.existsSync(path.join(homeMemoryRoot(agentHome), "softela", "bommed.md")), "a BOM-prefixed file must still be seeded");
    const memoryMd = fs.readFileSync(path.join(homeMemoryRoot(agentHome), "MEMORY.md"), "utf8");
    ok(memoryMd.includes("softela/bommed.md"), memoryMd);
  });

  test("a file that genuinely cannot be parsed is recorded in the skipped-files diagnostic instead of simply vanishing", () => {
    const agentHome = tmpdir();
    const catalogDir = tmpdir();
    buildFixtureCatalog(catalogDir, {
      "good.md": seedFile({ name: "good", description: "A well-formed entry." }),
      "no-fence.md": "This file has no frontmatter fence at all.\n",
    });

    runSeedMemory(agentHome, catalogDir);

    const skipped = JSON.parse(fs.readFileSync(path.join(homeMemoryRoot(agentHome), "softela", seedMemoryLib.SKIPPED_FILE), "utf8"));
    deepEq(skipped.files.map((f) => f.file), ["no-fence.md"]);
    ok(typeof skipped.files[0].reason === "string" && skipped.files[0].reason.length > 0);
  });

  /* --------------------------------------- resolveModuleCatalogDir layouts */

  test("resolveModuleCatalogDir: finds the repository layout's sibling seed/ directory without the test override", () => {
    const root = tmpdir();
    buildFixtureCatalog(root, { "alpha.md": seedFile({ name: "alpha", description: "Alpha topic description." }) });
    const hooksDir = path.join(root, "hooks");
    for (const name of ["seed-memory.js", "memory-location.js", "git-commit.js", "stdin.js"]) copyRealHookFile(hooksDir, name);
    copyRealHookStdinDependency(root);

    const agentHome = tmpdir();
    runWithoutOverride(path.join(hooksDir, "seed-memory.js"), agentHome);

    ok(fs.existsSync(path.join(homeMemoryRoot(agentHome), "softela", "alpha.md")), "the repo-layout catalogue must be found without any override");
  });

  test("resolveModuleCatalogDir: finds the installed layout's nested catalogue directory without the test override", () => {
    const root = tmpdir();
    const installedRoot = path.join(root, "softela-ai");
    const hooksDir = path.join(installedRoot, "hooks");
    for (const name of ["seed-memory.js", "memory-location.js", "git-commit.js", "stdin.js"]) copyRealHookFile(hooksDir, name);
    copyRealHookStdinDependency(installedRoot);
    const catalogDir = path.join(installedRoot, "modules", "memory-as-context");
    fs.mkdirSync(catalogDir, { recursive: true });
    buildFixtureCatalog(catalogDir, { "alpha.md": seedFile({ name: "alpha", description: "Alpha topic description." }) });

    const agentHome = tmpdir();
    runWithoutOverride(path.join(hooksDir, "seed-memory.js"), agentHome);

    ok(fs.existsSync(path.join(homeMemoryRoot(agentHome), "softela", "alpha.md")), "the installed-layout catalogue must be found without any override");
  });

  /* ---------------------------------------------------------- parseFrontmatter */

  test("parseFrontmatter: extracts name and description, ignoring nested metadata fields of the same key name", () => {
    const parsed = seedMemoryLib.parseFrontmatter(
      "---\nname: real-name\ndescription: real description\nmetadata:\n  type: nested-name-should-not-match\n  source: softela-ai\n---\n\nbody\n",
    );
    deepEq(parsed, { name: "real-name", description: "real description" });
  });

  test("parseFrontmatter: rejects a non-slug name even when description is present", () => {
    eq(seedMemoryLib.parseFrontmatter("---\nname: not a slug\ndescription: fine\n---\n\nbody\n"), null);
  });

  test("parseFrontmatter: rejects text with no frontmatter fence at all", () => {
    eq(seedMemoryLib.parseFrontmatter("just plain markdown, no frontmatter\n"), null);
  });

  /* -------------------------------------------------------------- cost budget */

  test("cold-start and steady-state seeding cost with 37 files stays well inside the 5s hook budget", () => {
    const agentHome = tmpdir();
    const catalogDir = tmpdir();
    const files = {};
    for (let i = 0; i < 37; i++) {
      const name = `topic-${String(i).padStart(2, "0")}`;
      files[`${name}.md`] = seedFile({ name, description: `Synthetic fixture topic number ${i}, used only to measure seeding cost.` });
    }
    buildFixtureCatalog(catalogDir, files);

    const coldStartedAt = Date.now();
    runSeedMemory(agentHome, catalogDir);
    const coldStartMs = Date.now() - coldStartedAt;

    const steadyStartedAt = Date.now();
    runSeedMemory(agentHome, catalogDir);
    const steadyStateMs = Date.now() - steadyStartedAt;

    ok(fs.readdirSync(path.join(homeMemoryRoot(agentHome), "softela")).filter((n) => n.endsWith(".md")).length === 37, "sanity check: all 37 fixture files should have been seeded");
    ok(coldStartMs < 5000, `cold-start seeding of 37 files took ${coldStartMs}ms, must stay under the 5000ms hook budget`);
    ok(steadyStateMs < 1500, `steady-state (marker already current) took ${steadyStateMs}ms, expected a fast single-read short-circuit well under a fresh cold-start`);
  });
});
