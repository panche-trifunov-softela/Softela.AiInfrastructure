#!/usr/bin/env node
"use strict";

/**
 * Seeds the resolved memory directory from this module's own shipped
 * knowledge base, then regenerates `MEMORY.md`'s managed index block — the
 * mechanism that makes `inject-memory.js` actually inject something on a
 * fresh install, instead of the module shipping a mechanism with nothing to
 * read.
 *
 * Every seed file this module ships lands at `<memoryDir>/softela/<name>.md`, a
 * subdirectory this tool owns outright and may freely rewrite on every run.
 * Nothing outside `softela/` is ever overwritten: a seed file whose slug already
 * exists as `<memoryDir>/<name>.md` is skipped outright, since the developer
 * already keeps that topic under their own management and their copy wins;
 * `ACTIVE-WORK.md` is written from `ACTIVE-WORK.tmpl.md` only when absent,
 * and never touched again once it exists.
 *
 * Deliberately self-contained, like every other script in this module — see
 * `memory-location.js`'s own module doc for why (siblings only, never
 * `core/lib`).
 *
 * Exposes two entry points:
 * - `seed({memoryDir, agentHome})` — the fast path `inject-memory.js` calls
 *   directly (no subprocess), with a memory directory it has already
 *   resolved.
 * - `main()`, run when this file is invoked directly — parses the same
 *   `--agent-home=`/`--location=` arguments and stdin payload shape every
 *   other hook script in this module reads, resolves the memory directory
 *   itself, then calls `seed()`. Exists so this script stays independently
 *   runnable and testable via a real subprocess, exactly like its siblings.
 *
 * Fails open on every error, always: an unreadable seed catalogue, an
 * unwritable memory directory, or one seed file with malformed frontmatter
 * never stops a session — worst case, less (or none) of the seed content
 * lands this run, exactly like the rest of this module's hooks.
 *
 * `MARKER_FILE` (`softela/.seed-version.json`) records a fully SUCCESSFUL run —
 * never a partial one. In particular, a `MEMORY.md` `locateBlock` judges
 * ambiguous (a duplicated managed block, or an `END` before its own
 * `BEGIN`) is a real failure of this run, not a detail to shrug off: the
 * marker is withheld so the next session retries automatically, once the
 * developer fixes `MEMORY.md` by hand, with no `SEED_VERSION` bump needed.
 * The ambiguity itself is recorded in `WARNING_FILE`
 * (`softela/.seed-index-warning.json`) — read directly by
 * `core/installer/doctor.js`, so `doctor` stays the one place a stuck seed
 * is always visible regardless of whether any session has run since — and
 * surfaced once, the first time it is detected, in `inject-memory.js`'s own
 * `additionalContext` (the one channel already guaranteed to reach the
 * developer, since it is injected straight into the conversation, unlike
 * stderr — which a host may not surface at all — or a log file nobody is
 * looking at); it is not repeated on every later session while the same
 * ambiguity persists, so `doctor` is the place to check its ongoing status.
 */

const fs = require("fs");
const path = require("path");
const { parseArgs, resolveMemoryDir, ensureSelfIgnored, UNSPECIFIED_LOCATION } = require("./memory-location");
const { commitAll } = require("./git-commit");
const { readStdin } = require("./stdin");

/**
 * Bumped whenever the packaged seed content, or this script's own generation
 * logic, changes in a way the on-disk marker must invalidate. The marker
 * records exactly this number; a matching marker short-circuits every run
 * after the first to a single file read, which is what keeps this hook cheap
 * enough to run on every session start (see `MARKER_FILE`).
 *
 * Bumped to 2 when the `Softela.Bugworx` seed files were added, and to 3 when
 * the knowledge base for a product belonging to a different company was
 * removed. A machine that already seeded at an earlier version reconciles on
 * its next session start instead of short-circuiting on a stale marker —
 * which matters more for a removal than for an addition, since the stale copy
 * would otherwise keep being injected as context.
 */
const SEED_VERSION = 3;

/** The memory-directory subdirectory this tool owns outright and may freely rewrite. */
const SEED_SUBDIR = "softela";

/** Records the last-applied `SEED_VERSION`, inside `SEED_SUBDIR` so it is part of the same owned, rewritable subtree. */
const MARKER_FILE = ".seed-version.json";

/**
 * Records an ambiguous `MEMORY.md` — a duplicated managed block, or an
 * `END` marker before its `BEGIN` — that left {@link upsertIndex} unable to
 * touch the file at all. Written only while the ambiguity persists, and
 * removed the moment a later run finds `MEMORY.md` unambiguous again; its
 * mere presence is therefore this module's own on-disk signal that the
 * index is currently stuck, read directly by `core/installer/doctor.js`
 * rather than duplicated as a second source of truth. Deliberately never
 * gates {@link MARKER_FILE}, which records the seed as a whole succeeding —
 * see this file's own module doc for why the two must never be conflated.
 */
const WARNING_FILE = ".seed-index-warning.json";

/**
 * Records every shipped seed file this run could not parse — an unreadable
 * file, a missing or malformed frontmatter fence, or a missing/empty
 * `name`/`description` field — so a source file this defensive skip logic
 * silently drops never simply vanishes with nothing anywhere to say why.
 * Rewritten on every full rescan; removed outright once nothing is skipped.
 */
const SKIPPED_FILE = ".seed-skipped.json";

/** The generated index file this seeder maintains a managed block inside. */
const INDEX_FILE = "MEMORY.md";

/** The live work-state stub this seeder writes only when the file is absent. */
const ACTIVE_FILE = "ACTIVE-WORK.md";

/** The shipped template `ACTIVE_FILE` is written from, relative to this module's own catalogue directory. */
const ACTIVE_TEMPLATE_NAME = "ACTIVE-WORK.tmpl.md";

/**
 * Opens the region this seeder owns inside `MEMORY.md`.
 *
 * A literal duplicate of `core/installer/managed-block.js`'s own `BEGIN` —
 * never a `require` of it, since this module's hook scripts stay
 * self-contained (siblings only, never `core/lib`; `memory-location.js`'s
 * own module doc explains why). `tests/modules/memory-as-context-seed.test.js`
 * asserts this stays byte-identical to the original, so the duplication
 * cannot silently drift.
 */
const BEGIN = "<!-- BEGIN softela-ai (managed — edits here are overwritten on update) -->";

/**
 * Closes the region this seeder owns inside `MEMORY.md`.
 *
 * @see BEGIN for why this is a literal duplicate, not a `require`.
 */
const END = "<!-- END softela-ai -->";

/**
 * Overrides where {@link resolveModuleCatalogDir} looks, when set —
 * exclusively: a set-but-invalid override yields no catalogue directory at
 * all, rather than falling through to the real on-disk layouts. Exists so a
 * test can point this script at a fixture catalogue instead of whatever this
 * module's own real `seed/` directory currently holds, which is both
 * unrelated test data this repository's own tests must never depend on, and,
 * mid-development, a directory that may not exist yet at all.
 */
const CATALOG_DIR_OVERRIDE_ENV = "SOFTELA_AI_SEED_CATALOG_DIR";

/**
 * Resolves this module's own catalogue directory — the whole-module copy
 * `core/installer/detect.js#listShippedFiles` places at
 * `<agentHome>/softela-ai/modules/memory-as-context/` (`addShippedDir`), an
 * entirely different location from the flat `<agentHome>/softela-ai/hooks/` copy
 * this very file is installed into (`stdin.js`'s own module doc covers the
 * same split for the same reason). Two on-disk layouts are tried in turn,
 * mirroring `stdin.js`'s own approach:
 *
 * - Installed: this file lives at `<agentHome>/softela-ai/hooks/seed-memory.js`,
 *   so the catalogue sits at `<one level up>/modules/memory-as-context`.
 * - Repository: this file lives at
 *   `modules/memory-as-context/hooks/seed-memory.js`, so the catalogue is
 *   its own parent directory.
 *
 * Either candidate is accepted only once it is confirmed to actually be this
 * module's own directory — presence of a `module.json` — rather than merely
 * existing, since an installed agent home's own root directory technically
 * "exists" too and would otherwise be silently mistaken for the catalogue.
 *
 * @returns {string | null} The resolved catalogue directory, or `null` when
 * neither candidate (or, when set, {@link CATALOG_DIR_OVERRIDE_ENV}) checks out.
 */
function resolveModuleCatalogDir() {
  const override = process.env[CATALOG_DIR_OVERRIDE_ENV];
  if (override) return looksLikeModuleDir(override) ? override : null;

  const candidates = [path.join(path.dirname(__dirname), "modules", "memory-as-context"), path.join(__dirname, "..")];
  for (const dir of candidates) {
    if (looksLikeModuleDir(dir)) return dir;
  }
  return null;
}

/**
 * Checks whether a directory is plausibly this module's own catalogue
 * directory, by the presence of its `module.json`.
 *
 * @param {string} dir The candidate directory.
 * @returns {boolean} `true` when `<dir>/module.json` exists and is a file.
 */
function looksLikeModuleDir(dir) {
  try {
    return fs.statSync(path.join(dir, "module.json")).isFile();
  } catch {
    return false;
  }
}

/**
 * Matches a YAML block-scalar indicator standing alone as a field's value —
 * `|`, `|-`, `|+`, `>`, `>-`, `>+` — the literal and folded block styles,
 * each with an optional chomping indicator.
 */
const BLOCK_SCALAR_INDICATOR = /^[|>][+-]?$/;

/**
 * Extracts one top-level YAML scalar field from a frontmatter block —
 * intentionally not a general YAML parser: only an unindented `key: value`
 * line is matched, so a nested field under the same key name (e.g.
 * `metadata:\n  type: ...`) is never mistaken for the top-level one.
 *
 * A block-scalar value (`key: |` or `key: >`, followed by indented lines) is
 * handled as a narrow special case rather than left to fall through: without
 * it, the indicator character itself — a bare `|` or `>` — would be
 * extracted as if it were the whole value, silently producing something
 * like an index line reading `— |`. Every indented line immediately
 * following the indicator is folded into one space-joined line instead —
 * right for a field this module always renders as a single markdown-list
 * line regardless of whether the source used `|` (literal) or `>` (folded)
 * style, and far simpler than actually reproducing YAML's own indentation
 * and chomping rules.
 *
 * @param {string} block The frontmatter block's text, between the `---` markers.
 * @param {string} key The field name to extract.
 * @returns {string | null} The trimmed value, with one layer of matching
 * surrounding quotes stripped, or a block scalar's folded continuation
 * lines; `null` when the field is absent, empty, or a block scalar with no
 * continuation lines to fold.
 */
function extractTopLevelField(block, key) {
  const lines = block.split(/\r?\n/);
  const re = new RegExp(`^${key}:[ \\t]*(.*)$`);

  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;

    let value = m[1].trim();

    if (BLOCK_SCALAR_INDICATOR.test(value)) {
      const folded = [];
      for (let j = i + 1; j < lines.length && /^[ \t]/.test(lines[j]); j++) {
        const trimmed = lines[j].trim();
        if (trimmed) folded.push(trimmed);
      }
      return folded.join(" ").trim() || null;
    }

    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1).trim();
    }
    return value || null;
  }
  return null;
}

/**
 * Parses a seed file's `name` and `description` out of its YAML frontmatter.
 *
 * @param {string} raw The seed file's full text, frontmatter included.
 * @returns {{name: string, description: string} | null} The two fields when
 * both are present and non-empty, and `name` is safe to use as a single path
 * segment; `null` for anything else — no opening/closing `---` fence, a
 * missing or empty field, or a `name` that would not be a plain slug — so a
 * malformed or hostile seed file is skipped rather than crashing the hook or
 * escaping the memory directory.
 */
function parseFrontmatter(raw) {
  if (typeof raw !== "string") return null;
  // A leading UTF-8 BOM — ordinary output from several Windows editors —
  // sits before the very first `-`, so the fence regex's anchored `^---`
  // would otherwise never match and the file would be dropped with no
  // diagnostic at all. Stripped here, once, rather than at every read site.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const fence = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!fence) return null;

  const name = extractTopLevelField(fence[1], "name");
  const description = extractTopLevelField(fence[1], "description");
  if (!name || !description) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return null;

  return { name, description };
}

/**
 * Finds every occurrence of a literal marker string in `content`.
 *
 * @param {string} content The text to search.
 * @param {string} marker The literal marker text.
 * @returns {number[]} Every byte offset the marker occurs at, in file order.
 */
function markerOffsets(content, marker) {
  const offsets = [];
  let from = 0;
  for (;;) {
    const idx = content.indexOf(marker, from);
    if (idx === -1) break;
    offsets.push(idx);
    from = idx + marker.length;
  }
  return offsets;
}

/**
 * Locates the single managed block this seeder owns inside `MEMORY.md`'s
 * content, matched only when unambiguous — exactly one `BEGIN`, exactly one
 * `END`, `BEGIN` before `END` — the same conservative rule
 * `core/installer/managed-block.js#locateBlock` applies to the installer's
 * own managed blocks, reimplemented here rather than required (this module's
 * scripts stay self-contained; see `BEGIN`'s own doc comment).
 *
 * @param {string} content The text to search.
 * @returns {{start: number, end: number} | null | "ambiguous"} The block's
 * span (end exclusive, just past `END`); `null` when neither marker appears
 * at all; the literal string `"ambiguous"` when the markers are present but
 * cannot be safely attributed to one region — the caller's signal to leave
 * the file untouched rather than guess.
 */
function locateBlock(content) {
  const beginHits = markerOffsets(content, BEGIN);
  const endHits = markerOffsets(content, END);
  if (beginHits.length === 0 && endHits.length === 0) return null;
  if (beginHits.length === 1 && endHits.length === 1 && beginHits[0] < endHits[0]) {
    return { start: beginHits[0], end: endHits[0] + END.length };
  }
  return "ambiguous";
}

/**
 * Explains why {@link locateBlock} returned `"ambiguous"` for a given
 * `MEMORY.md` content, in one plain sentence a developer can act on without
 * reading this file's own marker-matching logic.
 *
 * @param {string} content The `MEMORY.md` content {@link locateBlock} judged ambiguous.
 * @returns {string} A one-sentence, human-readable explanation.
 */
function describeAmbiguity(content) {
  const beginCount = markerOffsets(content, BEGIN).length;
  const endCount = markerOffsets(content, END).length;
  if (beginCount !== 1 || endCount !== 1) {
    return `MEMORY.md has ${beginCount} BEGIN marker(s) and ${endCount} END marker(s) for the softela-ai managed block — expected exactly one of each`;
  }
  return "MEMORY.md's END marker for the softela-ai managed block appears before its BEGIN marker";
}

/**
 * Reads a file's text content, never throwing.
 *
 * @param {string} filePath The absolute file path.
 * @returns {string | null} The file's content, or `null` when it cannot be read.
 */
function tryRead(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Writes a file's content only when it actually differs from what is on
 * disk, so an unchanged file's mtime — and this hook's own idempotency
 * guarantee — is never disturbed by a no-op rewrite.
 *
 * @param {string} filePath The absolute file path.
 * @param {string} content The content to ensure is on disk.
 * @returns {void}
 */
function writeIfChanged(filePath, content) {
  if (tryRead(filePath) === content) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

/**
 * Inserts or replaces this seeder's managed block inside `MEMORY.md`.
 *
 * Flow:
 * - File absent — written fresh, with a short header explaining what the
 *   file is, followed by the block.
 * - File present, no block — the block is appended, on its own blank line;
 *   every existing line is preserved verbatim.
 * - File present, exactly one block — the block's body is replaced in place;
 *   everything outside it is preserved verbatim.
 * - File present, an ambiguous marker pair — left untouched entirely, rather
 *   than guessing which occurrence is this seeder's own; reported back as
 *   `"ambiguous"` rather than silently treated the same as success, which is
 *   what let the on-disk marker ({@link MARKER_FILE}) previously claim a
 *   fully successful run when the index update never actually happened.
 *
 * @param {string} memoryDir The resolved memory directory.
 * @param {string} body The index text to place between the markers, without
 * the markers themselves.
 * @returns {{status: "written"} | {status: "ambiguous", reason: string}}
 * `"written"` whenever the block is now present and unambiguous on disk
 * (whether or not this call actually changed any bytes); `"ambiguous"` when
 * the file was left untouched, with `reason` from {@link describeAmbiguity}.
 */
function upsertIndex(memoryDir, body) {
  const indexPath = path.join(memoryDir, INDEX_FILE);
  const existing = tryRead(indexPath);
  const full = `${BEGIN}\n\n${body}\n\n${END}`;

  let next;
  if (existing === null) {
    next =
      "# Memory index\n\n" +
      "This file is the knowledge-base index `inject-memory.js` reads at session start. " +
      "The block below is generated by `seed-memory.js` from this module's own shipped " +
      "knowledge base — never hand-edit it, since the next reseed overwrites it outright. " +
      "Add the developer's own entries above or below the block instead.\n\n" +
      `${full}\n`;
  } else {
    const span = locateBlock(existing);
    if (span === "ambiguous") return { status: "ambiguous", reason: describeAmbiguity(existing) };
    if (span) {
      next = existing.slice(0, span.start) + full + existing.slice(span.end);
    } else {
      const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
      next = `${existing}${sep}${full}\n`;
    }
  }

  if (next !== existing) fs.writeFileSync(indexPath, next, "utf8");
  return { status: "written" };
}

/**
 * Records or clears {@link WARNING_FILE}, this module's own on-disk signal
 * that a run got stuck on an ambiguous `MEMORY.md` — read directly by
 * `core/installer/doctor.js` rather than duplicated as a second source of
 * truth (see {@link WARNING_FILE}'s own doc comment).
 *
 * @param {string} softelaDir The `<memoryDir>/softela` directory; must already exist.
 * @param {string} reason {@link describeAmbiguity}'s explanation for the current ambiguity.
 * @returns {boolean} `true` when this call is the first to record this exact
 * reason — i.e. the previous run's warning marker was absent or named a
 * different reason — the signal `inject-memory.js` uses to surface the
 * ambiguity in `additionalContext` exactly once rather than on every session
 * while it persists; `false` when an identical warning was already on disk.
 */
function recordIndexAmbiguity(softelaDir, reason) {
  const warningPath = path.join(softelaDir, WARNING_FILE);
  const previous = tryRead(warningPath);
  let previousReason = null;
  if (previous !== null) {
    try {
      previousReason = JSON.parse(previous).reason;
    } catch {
      // A corrupt previous marker is treated the same as none — report fresh.
    }
  }
  const isNew = previousReason !== reason;
  if (isNew) {
    try {
      fs.writeFileSync(warningPath, `${JSON.stringify({ reason, detectedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
    } catch {
      // Fail open: worst case the next run reports this as new again too.
    }
  }
  return isNew;
}

/**
 * Removes {@link WARNING_FILE} once the index is no longer ambiguous —
 * called only from the success path, so a resolved ambiguity does not
 * linger as a stale warning forever.
 *
 * @param {string} softelaDir The `<memoryDir>/softela` directory.
 * @returns {void}
 */
function clearIndexAmbiguity(softelaDir) {
  try {
    fs.unlinkSync(path.join(softelaDir, WARNING_FILE));
  } catch {
    // Absent already, or unremovable — either way nothing further to do.
  }
}

/**
 * Records or clears {@link SKIPPED_FILE} — every shipped seed file this run
 * could not parse, with a one-line reason each — so a source file the
 * defensive skip logic in {@link seedUnsafe} drops never simply vanishes
 * with nothing anywhere to say why (M5's own "say so somewhere" requirement).
 *
 * @param {string} softelaDir The `<memoryDir>/softela` directory; must already exist.
 * @param {{file: string, reason: string}[]} skipped Every skipped seed file this run found.
 * @returns {void}
 */
function writeSkippedDiagnostics(softelaDir, skipped) {
  const filePath = path.join(softelaDir, SKIPPED_FILE);
  if (skipped.length === 0) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Already absent, or unremovable — nothing left to report either way.
    }
    return;
  }
  try {
    fs.writeFileSync(filePath, `${JSON.stringify({ files: skipped }, null, 2)}\n`, "utf8");
  } catch {
    // Fail open: a diagnostic that could not be written is no worse than one that was never attempted.
  }
}

/**
 * Reads the seed marker's recorded version, never throwing.
 *
 * @param {string} markerPath The marker file's absolute path.
 * @returns {number | null} The recorded `version`, or `null` when the marker
 * is absent, unreadable, or malformed.
 */
function readMarkerVersion(markerPath) {
  const raw = tryRead(markerPath);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.version === "number" ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * The shape {@link seedUnsafe} and {@link seed} report back to their caller
 * — deliberately narrow: whether the index write is currently stuck, why,
 * and whether this is the first run to say so. Every early-return path
 * (nothing to do, an unreadable catalogue, the steady-state fast path) uses
 * this same "nothing to report" shape, so a caller never needs to
 * special-case which path produced it.
 *
 * @returns {{indexAmbiguous: false, indexAmbiguousReason: null, newlyDetected: false}}
 */
function noIndexProblem() {
  return { indexAmbiguous: false, indexAmbiguousReason: null, newlyDetected: false };
}

/**
 * Does the real work of {@link seed} — everything here may throw, and the
 * caller is what makes this fail open.
 *
 * @param {{memoryDir: string, agentHome: string}} options See {@link seed}.
 * @returns {ReturnType<typeof noIndexProblem> | {indexAmbiguous: true, indexAmbiguousReason: string, newlyDetected: boolean}}
 * See {@link seed}.
 */
function seedUnsafe({ memoryDir, agentHome }) {
  const catalogDir = resolveModuleCatalogDir();
  if (!catalogDir) return noIndexProblem();

  const softelaDir = path.join(memoryDir, SEED_SUBDIR);
  const markerPath = path.join(softelaDir, MARKER_FILE);

  // Steady-state fast path: the marker already names the current seed
  // version, so nothing under this run needs to touch the filesystem beyond
  // the one read that just happened. The marker is stamped only on a fully
  // successful run (see below), so this path is only ever reached once the
  // index write has actually succeeded — never while it is stuck.
  if (readMarkerVersion(markerPath) === SEED_VERSION) return noIndexProblem();

  const seedSourceDir = path.join(catalogDir, "seed");
  let seedFileNames;
  try {
    seedFileNames = fs.readdirSync(seedSourceDir).filter((name) => name.endsWith(".md"));
  } catch {
    return noIndexProblem();
  }

  /** @type {Map<string, string>} Slug (frontmatter `name`) to the seed file's full raw content. */
  const expected = new Map();
  const indexEntries = [];
  /** @type {{file: string, reason: string}[]} Every shipped seed file this run could not use, and why — see {@link writeSkippedDiagnostics}. */
  const skipped = [];

  for (const fileName of seedFileNames) {
    const raw = tryRead(path.join(seedSourceDir, fileName));
    if (raw === null) {
      skipped.push({ file: fileName, reason: "could not be read" });
      continue;
    }

    const meta = parseFrontmatter(raw);
    if (!meta) {
      skipped.push({ file: fileName, reason: "no valid frontmatter fence, or a missing/empty name or description field" });
      continue;
    }

    // The developer already keeps this topic under their own management —
    // their copy wins, and the shipped twin is skipped outright. Not a
    // parse failure, so this never adds to `skipped`.
    if (tryRead(path.join(memoryDir, `${meta.name}.md`)) !== null) continue;

    expected.set(meta.name, raw);
    indexEntries.push(meta);
  }

  fs.mkdirSync(softelaDir, { recursive: true });

  for (const [name, content] of expected) {
    writeIfChanged(path.join(softelaDir, `${name}.md`), content);
  }

  // softela/ is owned outright, so it is kept as an exact mirror of `expected`:
  // a slug no longer expected (its seed file vanished, or a top-level
  // override newly suppresses it) has its old copy removed rather than left
  // to linger as stale, unindexed content.
  let onDisk = [];
  try {
    onDisk = fs.readdirSync(softelaDir).filter((name) => name.endsWith(".md"));
  } catch {
    // softela/ was just created above; a failure here just means nothing to prune.
  }
  for (const fileName of onDisk) {
    if (!expected.has(fileName.slice(0, -3))) {
      try {
        fs.unlinkSync(path.join(softelaDir, fileName));
      } catch {
        // Best-effort pruning only — a leftover stale file is not worth failing over.
      }
    }
  }

  writeSkippedDiagnostics(softelaDir, skipped);

  indexEntries.sort((a, b) => a.name.localeCompare(b.name));
  const body = indexEntries.length
    ? indexEntries.map((e) => `- [${e.name}](${SEED_SUBDIR}/${e.name}.md) — ${e.description}`).join("\n")
    : "_No shipped knowledge-base entries are currently seeded._";
  const indexResult = upsertIndex(memoryDir, body);

  const activePath = path.join(memoryDir, ACTIVE_FILE);
  const activeWasAbsent = tryRead(activePath) === null;
  if (activeWasAbsent) {
    const template = tryRead(path.join(catalogDir, ACTIVE_TEMPLATE_NAME));
    if (template !== null) fs.writeFileSync(activePath, template, "utf8");
  }
  const activeWorkCreated = activeWasAbsent && tryRead(activePath) !== null;

  // The version marker records that the seed as a whole SUCCEEDED, so it
  // must never be written when any part of it did not — an ambiguous
  // MEMORY.md previously still got a marker claiming a completed run, which
  // permanently short-circuited every later session's own retry (the
  // steady-state fast path above trusts this marker completely). Stamped
  // only in the success branch; the ambiguous branch instead records (or
  // refreshes) the warning marker `core/installer/doctor.js` reads directly.
  let indexAmbiguousIsNew = false;
  if (indexResult.status === "written") {
    clearIndexAmbiguity(softelaDir);
    fs.writeFileSync(
      markerPath,
      `${JSON.stringify({ version: SEED_VERSION, seededAt: new Date().toISOString(), fileCount: expected.size }, null, 2)}\n`,
      "utf8",
    );
  } else {
    indexAmbiguousIsNew = recordIndexAmbiguity(softelaDir, indexResult.reason);
  }

  ensureSelfIgnored(memoryDir, agentHome);

  // Only the paths this run actually wrote are staged — never the whole
  // memory directory. A `SessionStart` hook fires before the developer has
  // done anything in this session at all, so a personal scratch note left
  // uncommitted elsewhere in the memory directory must never be swept into
  // a commit titled "Seed softela-ai memory files"; `memory-autocommit.js`'s own
  // `Write`/`Edit`-triggered commits are a different situation and keep
  // staging the whole directory, explicitly, at its own call site.
  const seedPaths = [SEED_SUBDIR, INDEX_FILE, ...(activeWorkCreated ? [ACTIVE_FILE] : [])];
  commitAll({ memoryDir, agentHome, buildSubject: () => "Seed softela-ai memory files", paths: seedPaths });

  if (indexResult.status === "written") return noIndexProblem();
  return { indexAmbiguous: true, indexAmbiguousReason: indexResult.reason, newlyDetected: indexAmbiguousIsNew };
}

/**
 * Seeds `memoryDir` from this module's own shipped knowledge base — see this
 * file's own module doc for the full behaviour.
 *
 * Fails open, always: any error anywhere in the process — an unreadable seed
 * catalogue, an unwritable memory directory, malformed frontmatter in one
 * seed file — leaves whatever was already on disk exactly as it was, and
 * never propagates to the caller.
 *
 * @param {object} options
 * @param {string} options.memoryDir The resolved memory directory.
 * @param {string} options.agentHome The resolved agent home directory, used
 * only to classify `memoryDir` via `isSharedMemoryDir` before ever
 * initialising a git repository in it.
 * @returns {{indexAmbiguous: boolean, indexAmbiguousReason: string | null, newlyDetected: boolean}}
 * Whether `MEMORY.md`'s generated index is currently stuck on an ambiguous
 * managed block, why, and whether this is the first run to say so —
 * `indexAmbiguous: false` for every other outcome, including any error this
 * call swallowed. `inject-memory.js` uses `newlyDetected` to surface the
 * ambiguity in `additionalContext` exactly once; `core/installer/doctor.js`
 * instead reads {@link WARNING_FILE} directly, so it stays accurate on a run
 * that never calls this function at all.
 */
function seed({ memoryDir, agentHome }) {
  try {
    return seedUnsafe({ memoryDir, agentHome });
  } catch {
    // Fail open — a seeding failure must never stop session-start injection.
    return noIndexProblem();
  }
}

/**
 * Runs this script when invoked directly as a subprocess: resolves the
 * memory directory the same way every other hook in this module does, then
 * seeds it. Never used by `inject-memory.js`'s own fast path, which already
 * has a resolved `memoryDir` and calls {@link seed} directly.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const agentHome = args["agent-home"] || "";
  const location = args.location || UNSPECIFIED_LOCATION;
  if (!agentHome) return;

  let payload = {};
  try {
    payload = JSON.parse((await readStdin()) || "{}") || {};
  } catch {
    // A malformed or absent payload just falls back to process.cwd() below.
  }
  const cwd = payload.cwd || payload.workspace || payload.working_directory || process.cwd();

  const memoryDir = resolveMemoryDir({ agentHome, cwd, location });
  seed({ memoryDir, agentHome });
}

if (require.main === module) main();

module.exports = {
  seed,
  resolveModuleCatalogDir,
  parseFrontmatter,
  describeAmbiguity,
  CATALOG_DIR_OVERRIDE_ENV,
  SEED_VERSION,
  SEED_SUBDIR,
  MARKER_FILE,
  WARNING_FILE,
  SKIPPED_FILE,
  INDEX_FILE,
  ACTIVE_FILE,
  BEGIN,
  END,
};
