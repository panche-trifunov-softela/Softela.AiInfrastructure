#!/usr/bin/env node
"use strict";

/**
 * Assembles the split files in `docs/standards/` into generated,
 * human-readable documents.
 *
 * The split files are the single source of truth; nobody edits an output
 * file of this script directly. Run with no flags to (re)write every
 * document in `DOCUMENTS` from the current content of its parts. Run with
 * `--check` to verify every committed output file already matches what its
 * parts produce, without writing anything — this is what
 * `tests/docs/standard-assembly.test.js` calls to catch drift between an
 * edited part and a stale generated file.
 *
 * A part may anchor more than one document — `code-documentation.md` is
 * section 12 of `FRONTEND-ARCHITECTURE-STANDARD.md`'s own `sectionOrder`
 * *and* the sole part of the standalone `CODE-DOCUMENTATION-STANDARD.md`.
 * Editing that one file updates both generated outputs; neither ever carries
 * a hand-maintained copy of the other's content.
 *
 * `docs/standards/EXCLUDED-FROM-SOURCE.md` and `docs/standards/ONBOARDING.md`
 * describe the split itself rather than being part of any standard's own
 * content, and are deliberately not included in any assembly.
 */

const fs = require("fs");
const path = require("path");

const STANDARDS_DIR = path.join(__dirname, "..", "docs", "standards");

/**
 * Where the assembled documents are written.
 *
 * A folder of their own, separate from the parts they are built from, so
 * that "this is the document a person reads" and "this is a source file
 * somebody edits" are told apart by location rather than by noticing which
 * filenames happen to be upper-case.
 */
const ASSEMBLED_DIR = path.join(STANDARDS_DIR, "assembled");
const SCRIPT_LABEL = "tools/build-standard.js";

/**
 * Every document this script assembles, each from its own ordered slice of
 * the split files in `docs/standards/`.
 *
 * @type {{ key: string, title: string, outputFile: string, sectionOrder: string[] }[]}
 */
const DOCUMENTS = [
  {
    key: "frontend-architecture",
    title: "Frontend Architecture Standard",
    outputFile: path.join(ASSEMBLED_DIR, "FRONTEND-ARCHITECTURE-STANDARD.md"),
    /**
     * Declared explicitly, mirroring the source document's own section
     * order: status and how to read it, why the rulebook exists,
     * principles, shared code boundaries, the component-folder shape and
     * its layer rules, naming, file size, state, types, the API layer,
     * local development configuration, documentation, testing, agent
     * rules, git flow, and finally the migration
     * approach — so reading the generated file top to bottom reads the way
     * the original document did.
     */
    sectionOrder: [
      "README.md",
      "rationale.md",
      "principles.md",
      "shared-code-boundaries.md",
      "component-structure.md",
      "layer-boundaries.md",
      "naming.md",
      "file-size.md",
      "state-management.md",
      "types.md",
      "api-layer.md",
      "local-dev-config.md",
      "code-documentation.md",
      "testing.md",
      "agent-rules.md",
      "git-flow.md",
      "migration-approach.md",
    ],
  },
  {
    key: "code-documentation",
    title: "Code Documentation Standard",
    outputFile: path.join(ASSEMBLED_DIR, "CODE-DOCUMENTATION-STANDARD.md"),
    /**
     * A single part today. Declared as a list, not a bare file reference,
     * so a future split of `code-documentation.md` into several files needs
     * no change to how this document is assembled.
     */
    sectionOrder: ["code-documentation.md"],
  },
];

/**
 * Reads a file from `docs/standards/`, normalising line endings and
 * trailing whitespace.
 *
 * @param {string} fileName File name inside `docs/standards/`.
 * @returns {string} The file's content with `\n` line endings and no
 * trailing blank lines.
 */
function readSection(fileName) {
  const raw = fs.readFileSync(path.join(STANDARDS_DIR, fileName), "utf8");
  return raw.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

/**
 * Extracts the first level-1 heading's text from a file's content.
 *
 * @param {string} content File content to search.
 * @param {string} fileName Named in the error when no heading is found.
 * @returns {string} The heading text, without the leading `# `.
 * @throws {Error} When the content has no top-level heading.
 */
function firstHeading(content, fileName) {
  const match = content.match(/^#\s+(.+)$/m);
  if (!match) {
    throw new Error(`${fileName} has no top-level heading to build a table of contents entry from`);
  }
  return match[1].trim();
}

/**
 * Converts heading text to a GitHub-style anchor slug.
 *
 * @param {string} text Heading text.
 * @returns {string} The lower-cased, hyphenated slug.
 */
function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");
}

/**
 * Builds one generated document from the current content of every file in
 * its `sectionOrder`.
 *
 * @param {{ title: string, sectionOrder: string[] }} doc Entry from
 * `DOCUMENTS` describing the document to assemble.
 * @returns {string} The complete assembled document, ending in one `\n`.
 */
function buildDocument(doc) {
  const sections = doc.sectionOrder.map((fileName) => ({
    fileName,
    content: readSection(fileName),
  }));

  const toc = sections
    .map(({ content, fileName }, index) => {
      const heading = firstHeading(content, fileName);
      return `${index + 1}. [${heading}](#${slugify(heading)})`;
    })
    .join("\n");

  const header = [
    `# ${doc.title}`,
    "",
    `> **Generated file — do not edit directly.** Produced by \`${SCRIPT_LABEL}\``,
    "> from the individual files in `docs/standards/`. Edit one of those and run",
    `> \`node ${SCRIPT_LABEL}\` to regenerate this file, or`,
    `> \`node ${SCRIPT_LABEL} --check\` to verify it still matches without`,
    "> writing anything.",
    "",
    "## Contents",
    "",
    toc,
  ].join("\n");

  const body = sections.map(({ content }) => content).join("\n\n---\n\n");

  return `${header}\n\n---\n\n${body}\n`;
}

/**
 * Renders a short, line-based summary of where two versions of a generated
 * document first diverge.
 *
 * @param {{ outputFile: string }} doc The document being checked.
 * @param {string} committed Content currently on disk.
 * @param {string} expected Content the parts currently produce.
 * @returns {string} A human-readable summary ending in `\n`.
 */
function diffSummary(doc, committed, expected) {
  const relPath = path.relative(process.cwd(), doc.outputFile);
  const committedLines = committed.split("\n");
  const expectedLines = expected.split("\n");
  const max = Math.max(committedLines.length, expectedLines.length);

  let firstDiff = -1;
  for (let i = 0; i < max; i += 1) {
    if (committedLines[i] !== expectedLines[i]) {
      firstDiff = i;
      break;
    }
  }

  const lines = [
    `${relPath} is out of date with the parts.`,
    `${committedLines.length} lines committed, ${expectedLines.length} lines expected` +
      (firstDiff === -1 ? "." : `; first difference at line ${firstDiff + 1}.`),
  ];

  if (firstDiff !== -1) {
    const context = 2;
    const start = Math.max(0, firstDiff - context);
    const endCommitted = Math.min(committedLines.length, firstDiff + context + 1);
    const endExpected = Math.min(expectedLines.length, firstDiff + context + 1);

    lines.push("--- committed");
    for (let i = start; i < endCommitted; i += 1) lines.push(`${i + 1}: ${committedLines[i]}`);
    lines.push("+++ expected");
    for (let i = start; i < endExpected; i += 1) lines.push(`${i + 1}: ${expectedLines[i]}`);
  }

  lines.push(`Run \`node ${SCRIPT_LABEL}\` to regenerate.`);
  return `${lines.join("\n")}\n`;
}

/**
 * CLI entry point. Processes every document in `DOCUMENTS` in order.
 *
 * @param {string[]} argv Arguments after the script name (`process.argv.slice(2)`).
 * @returns {number} The process exit code: `0` on success, `1` when
 * `--check` finds drift or a committed file is missing for any document.
 */
function main(argv) {
  const check = argv.includes("--check");
  let anyFailed = false;

  for (const doc of DOCUMENTS) {
    const expected = buildDocument(doc);
    const relPath = path.relative(process.cwd(), doc.outputFile);

    if (!check) {
      // The output folder is tracked and normally present, but a build that
      // cannot run because somebody deleted a directory is a worse failure
      // than one extra syscall.
      fs.mkdirSync(path.dirname(doc.outputFile), { recursive: true });
      fs.writeFileSync(doc.outputFile, expected, "utf8");
      process.stdout.write(`wrote ${relPath}\n`);
      continue;
    }

    let committed;
    try {
      committed = fs.readFileSync(doc.outputFile, "utf8").replace(/\r\n/g, "\n");
    } catch {
      process.stdout.write(`${relPath} does not exist; run \`node ${SCRIPT_LABEL}\` to generate it\n`);
      anyFailed = true;
      continue;
    }

    if (committed === expected) {
      process.stdout.write(`${relPath} is up to date\n`);
      continue;
    }

    process.stdout.write(diffSummary(doc, committed, expected));
    anyFailed = true;
  }

  return anyFailed ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, buildDocument, diffSummary, DOCUMENTS, STANDARDS_DIR };
