"use strict";

const fs = require("fs");
const path = require("path");

const { suite } = require("../harness");
const { main, buildDocument, DOCUMENTS, STANDARDS_DIR } = require("../../tools/build-standard");

/**
 * Captures everything written to `process.stdout` while `fn` runs.
 *
 * @param {() => *} fn Function to run with stdout captured.
 * @returns {{ result: *, output: string }} What `fn` returned, and every
 * chunk written to stdout while it ran, concatenated.
 */
function captureStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  let output = "";
  process.stdout.write = (chunk) => {
    output += chunk;
    return true;
  };
  try {
    return { result: fn(), output };
  } finally {
    process.stdout.write = original;
  }
}

const frontendDoc = DOCUMENTS.find((doc) => doc.key === "frontend-architecture");
const codeDocDoc = DOCUMENTS.find((doc) => doc.key === "code-documentation");

suite("docs/standard-assembly", ({ test, eq, ok }) => {
  test("every committed generated document matches what the parts currently produce", () => {
    const { result, output } = captureStdout(() => main(["--check"]));
    eq(result, 0, `expected --check to pass with no drift, got:\n${output}`);
  });

  test("--check reports drift instead of writing when a committed document disagrees with its parts", () => {
    const original = fs.readFileSync(frontendDoc.outputFile, "utf8");
    try {
      fs.writeFileSync(frontendDoc.outputFile, `${original}\nsome uncommitted drift\n`, "utf8");
      const { result, output } = captureStdout(() => main(["--check"]));
      eq(result, 1, "expected --check to fail on drift");
      ok(output.includes("out of date"), `expected the drift report to say the file is out of date, got:\n${output}`);
      eq(
        fs.readFileSync(frontendDoc.outputFile, "utf8"),
        `${original}\nsome uncommitted drift\n`,
        "--check must never write",
      );
    } finally {
      fs.writeFileSync(frontendDoc.outputFile, original, "utf8");
    }
  });

  test("--check reports drift on the standalone code documentation standard independently", () => {
    const original = fs.readFileSync(codeDocDoc.outputFile, "utf8");
    try {
      fs.writeFileSync(codeDocDoc.outputFile, `${original}\nsome uncommitted drift\n`, "utf8");
      const { result, output } = captureStdout(() => main(["--check"]));
      eq(result, 1, "expected --check to fail when only the standalone document has drifted");
      ok(
        output.includes(path.basename(codeDocDoc.outputFile)),
        `expected the drift report to name ${path.basename(codeDocDoc.outputFile)}, got:\n${output}`,
      );
    } finally {
      fs.writeFileSync(codeDocDoc.outputFile, original, "utf8");
    }
  });

  test("the default (write) mode regenerates every document byte-identically when nothing changed", () => {
    const before = DOCUMENTS.map((doc) => fs.readFileSync(doc.outputFile, "utf8"));
    const { result } = captureStdout(() => main([]));
    eq(result, 0);
    DOCUMENTS.forEach((doc, index) => {
      eq(fs.readFileSync(doc.outputFile, "utf8"), before[index], `regenerating ${doc.key} with no source changes must be a no-op`);
    });
  });

  test("every section file referenced by any document's sectionOrder exists in docs/standards/", () => {
    for (const doc of DOCUMENTS) {
      for (const fileName of doc.sectionOrder) {
        ok(fs.existsSync(path.join(STANDARDS_DIR, fileName)), `${fileName} is declared in ${doc.key}'s sectionOrder but missing`);
      }
    }
  });

  test("the assembled frontend architecture standard is at least as long as its source document (2106 lines)", () => {
    const lineCount = buildDocument(frontendDoc).split("\n").length;
    ok(
      lineCount >= 2106,
      `expected the assembled document to be at least 2106 lines (the source document's length), got ${lineCount}`,
    );
  });

  test("the assembled code documentation standard is at least as long as its source document (194 lines)", () => {
    const lineCount = buildDocument(codeDocDoc).split("\n").length;
    ok(
      lineCount >= 194,
      `expected the assembled document to be at least 194 lines (the source document's length), got ${lineCount}`,
    );
  });

  test("every generated header states plainly that the file is generated and names the script", () => {
    for (const doc of DOCUMENTS) {
      const content = buildDocument(doc);
      ok(content.includes("Generated file"), `expected ${doc.key}'s header to say the file is generated`);
      ok(content.includes("tools/build-standard.js"), `expected ${doc.key}'s header to name the generating script`);
    }
  });

  test("every document's table of contents lists every section in its sectionOrder, in order", () => {
    for (const doc of DOCUMENTS) {
      const content = buildDocument(doc);
      const tocEnd = content.indexOf("\n\n---\n\n");
      const toc = content.slice(0, tocEnd);
      let lastIndex = -1;
      for (const fileName of doc.sectionOrder) {
        const heading = fs
          .readFileSync(path.join(STANDARDS_DIR, fileName), "utf8")
          .match(/^#\s+(.+)$/m)[1]
          .trim();
        const index = toc.indexOf(heading);
        ok(index !== -1, `expected ${doc.key}'s table of contents to list "${heading}" from ${fileName}`);
        ok(index > lastIndex, `expected "${heading}" to appear after the previous section in ${doc.key}'s table of contents`);
        lastIndex = index;
      }
    }
  });

  test("code-documentation.md anchors both the frontend standard's SECTION_ORDER and the standalone document", () => {
    ok(
      frontendDoc.sectionOrder.includes("code-documentation.md"),
      "expected code-documentation.md to remain a chapter of the frontend architecture standard",
    );
    ok(
      codeDocDoc.sectionOrder.includes("code-documentation.md"),
      "expected code-documentation.md to anchor the standalone code documentation standard",
    );
  });

  test("EXCLUDED-FROM-SOURCE.md and ONBOARDING.md are meta documents and are not part of any assembly", () => {
    for (const doc of DOCUMENTS) {
      ok(!doc.sectionOrder.includes("EXCLUDED-FROM-SOURCE.md"), `${doc.key} must not include EXCLUDED-FROM-SOURCE.md`);
      ok(!doc.sectionOrder.includes("ONBOARDING.md"), `${doc.key} must not include ONBOARDING.md`);
    }
  });
});
