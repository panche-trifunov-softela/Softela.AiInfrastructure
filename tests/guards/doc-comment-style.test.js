"use strict";

const { suite } = require("../harness");
const { decide, PROJECT_MINIMAL, PROJECT_BACKEND } = require("./_ctx");
const rule = require("../../core/guards/doc-comment-style");

/**
 * Builds a `/** ... *\/` block of `n` filler lines, none of them structured.
 *
 * @param {number} n The number of filler lines inside the block.
 * @returns {string} The block text.
 */
function proseBlock(n) {
  return "/**\n" + " *x\n".repeat(n) + " */";
}

/**
 * Builds `n` consecutive `// x` lines.
 *
 * @param {number} n The number of lines.
 * @returns {string} The text.
 */
function lineComments(n) {
  return "// x\n".repeat(n);
}

/**
 * Builds a `/** ... *\/` block whose body is `n` filler prose lines followed
 * by one `@param` line — the shape that used to exempt an oversized block
 * from the length ceiling at any length, before a tag anywhere stopped being
 * treated as proof the whole block was structured.
 *
 * @param {number} n The number of prose filler lines before the tag.
 * @returns {string} The block text.
 */
function proseBlockWithTrailingParam(n) {
  return "/**\n" + " *x\n".repeat(n) + " * @param x Something.\n */";
}

/**
 * Builds a `/** ... *\/` block of two `n`-line prose paragraphs separated by
 * one blank ` *` line.
 *
 * @param {number} n The number of filler lines in each paragraph.
 * @returns {string} The block text.
 */
function twoProseParagraphs(n) {
  return "/**\n" + " *x\n".repeat(n) + " *\n" + " *x\n".repeat(n) + " */";
}

suite("guards/doc-comment-style", ({ test, eq }) => {
  /* -------------------------------------------------------- positive: deny */

  test("denies @example in a .ts doc block", () => {
    eq(decide(rule, { toolName: "Write", filePath: "a.ts", content: "/**\n * Does x.\n * @example\n * f();\n */" }), "deny");
  });

  test("denies a JSDoc block in a .cs file", () => {
    eq(decide(rule, { toolName: "Write", filePath: "a.cs", content: "/** summary */\npublic void X(){}" }), "deny");
  });

  test("denies a ticket id anywhere in written content", () => {
    eq(decide(rule, { toolName: "Edit", filePath: "a.ts", content: "// fixes the off-by-one seen in #54321" }), "deny");
  });

  test("still denies a ticket id inside parentheses", () => {
    eq(decide(rule, { toolName: "Edit", filePath: "a.ts", content: "// (see #12345)" }), "deny");
  });

  /* --------------------------------------------------------- positive: ask */

  test("asks on a prose-only block past the line backstop", () => {
    eq(decide(rule, { toolName: "Write", filePath: "a.ts", content: proseBlock(20) }), "ask");
  });

  test("asks on an oversized prose run even when the block ends in one @param", () => {
    // 25 prose lines plus the opening line, the trailing @param line and the
    // closing line make 28 lines total. Before the fix, that single @param
    // exempted the whole block from the length ceiling no matter how long the
    // prose run in front of it was; now the ceiling judges the run itself.
    eq(decide(rule, { toolName: "Write", filePath: "a.ts", content: proseBlockWithTrailingParam(25) }), "ask");
  });

  test("asks on a 20-line unbroken prose run even inside a fully tagged block", () => {
    const content = "/**\n" + " *x\n".repeat(20) + " *\n * @param a A.\n * @returns b B.\n */";
    eq(decide(rule, { toolName: "Write", filePath: "a.ts", content }), "ask");
  });

  test("passes two prose paragraphs separated by a blank line, neither past the ceiling", () => {
    eq(decide(rule, { toolName: "Write", filePath: "a.ts", content: twoProseParagraphs(12) }), "pass");
  });

  test("passes 30 bullet lines followed by a long @-tag list", () => {
    const bulletsAndTags =
      "/**\n * Options.\n *\n" +
      " * - opt: does a thing\n".repeat(30) +
      " * @param a First.\n * @param b Second.\n * @param c Third.\n * @returns void.\n */";
    eq(decide(rule, { toolName: "Write", filePath: "a.ts", content: bulletsAndTags }), "pass");
  });

  test("asks on more than 6 consecutive // lines", () => {
    eq(decide(rule, { toolName: "Edit", filePath: "a.tsx", content: lineComments(9) }), "ask");
  });

  test("keeps asking on 12 consecutive // lines", () => {
    eq(decide(rule, { toolName: "Edit", filePath: "a.tsx", content: lineComments(12) }), "ask");
  });

  /* ------------------------------------------------- positive: ask, XML tags */

  test("asks when a method with parameters has no <param>", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "a.cs",
        content: "/// <summary>Reads a thing.</summary>\npublic Thing Read(int id)\n{\n    return null;\n}",
      }),
      "ask",
    );
  });

  test("asks when a method returning a value has no <returns>", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "a.cs",
        content: "/// <summary>Reads a thing.</summary>\npublic Thing Read()\n{\n    return null;\n}",
      }),
      "ask",
    );
  });

  test("asks when a constructor with parameters has no <param>", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "a.cs",
        content: "/// <summary>Creates a thing.</summary>\npublic Thing(int id)\n{\n}",
      }),
      "ask",
    );
  });

  test("asks when an interface member with parameters has no <param>", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "a.cs",
        content: "/// <summary>Reads a thing.</summary>\nThing Read(int id);",
      }),
      "ask",
    );
  });

  /* -------------------------------------------------------------- evasion */

  test("still denies @example through the Codex apply_patch tool name", () => {
    eq(decide(rule, { toolName: "apply_patch", filePath: "a.ts", content: "/**\n * @example\n */" }), "deny");
  });

  test("still denies a JSDoc block in .cs through NotebookEdit", () => {
    eq(decide(rule, { toolName: "NotebookEdit", filePath: "a.cs", content: "/** x */" }), "deny");
  });

  test("still denies a ticket id hidden inside an otherwise well-formed block", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "a.ts",
        content: "/**\n * Reads a thing.\n *\n * @param id Identifier, see #12345 for background.\n * @returns The thing.\n */",
      }),
      "deny",
    );
  });

  test("still asks on a slash wall split across an Edit's replacement text", () => {
    eq(decide(rule, { toolName: "Edit", filePath: "a.js", content: lineComments(7) }), "ask");
  });

  /* -------------------------------------------------------------- negative */

  test("passes a well-formed JSDoc block", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "a.ts",
        content: "/**\n * Reads a thing.\n *\n * @param id Identifier.\n * @returns The thing.\n */",
      }),
      "pass",
    );
  });

  test("passes an XML summary in a .cs file", () => {
    eq(decide(rule, { toolName: "Write", filePath: "a.cs", content: "/// <summary>Reads.</summary>\n/// <returns>Thing.</returns>" }), "pass");
  });

  test("passes a fully-tagged method with parameters and a return value", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "a.cs",
        content:
          "/// <summary>Reads a thing.</summary>\n/// <param name=\"id\">Identifier.</param>\n/// <returns>The thing.</returns>\npublic Thing Read(int id)\n{\n    return null;\n}",
      }),
      "pass",
    );
  });

  test("passes a void method with documented parameters and no <returns>", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "a.cs",
        content: "/// <summary>Writes a thing.</summary>\n/// <param name=\"id\">Identifier.</param>\npublic void Write(int id)\n{\n}",
      }),
      "pass",
    );
  });

  test("passes a parameterless method with no <param>", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "a.cs",
        content: "/// <summary>Reads a thing.</summary>\n/// <returns>The thing.</returns>\npublic Thing Read()\n{\n    return null;\n}",
      }),
      "pass",
    );
  });

  test("passes a parameterless constructor", () => {
    eq(decide(rule, { toolName: "Write", filePath: "a.cs", content: "/// <summary>Creates a thing.</summary>\npublic Thing()\n{\n}" }), "pass");
  });

  test("still asks when a constructor with parameters has no <param>", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "a.cs",
        content: "/// <summary>Creates a thing.</summary>\npublic Thing(int id)\n{\n}",
      }),
      "ask",
    );
  });

  test("passes a doc block sitting above a property, not a method", () => {
    eq(decide(rule, { toolName: "Write", filePath: "a.cs", content: "/// <summary>The identifier.</summary>\npublic int Id { get; set; }" }), "pass");
  });

  test("passes a doc block sitting above a record's primary constructor", () => {
    eq(decide(rule, { toolName: "Write", filePath: "a.cs", content: "/// <summary>A point.</summary>\npublic record Point(int X, int Y);" }), "pass");
  });

  test("passes a doc block above an if-statement, not a member", () => {
    eq(decide(rule, { toolName: "Write", filePath: "a.cs", content: "/// note: guards against a null id\nif (id != null)\n{\n}" }), "pass");
  });

  test("passes a doc block with nothing following it", () => {
    eq(decide(rule, { toolName: "Write", filePath: "a.cs", content: "/// <summary>End of file.</summary>" }), "pass");
  });

  test("passes a short prose-only block", () => {
    eq(decide(rule, { toolName: "Write", filePath: "a.ts", content: proseBlock(8) }), "pass");
  });

  test("passes a long block that is a bulleted list", () => {
    eq(decide(rule, { toolName: "Write", filePath: "a.ts", content: "/**\n * Strategy for concurrent calls.\n *\n" + " * - opt: does a thing\n".repeat(15) + " */" }), "pass");
  });

  test("passes a long block carrying @-tags", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "a.ts",
        content: "/**\n * Hook for managing loading states.\n *\n" + " *x\n".repeat(14) + " * @returns Object with loading utilities\n */",
      }),
      "pass",
    );
  });

  test("passes 3 consecutive // lines", () => {
    eq(decide(rule, { toolName: "Edit", filePath: "a.tsx", content: lineComments(3) }), "pass");
  });

  test("passes a fully tagged XML doc block, however many /// lines it takes", () => {
    // The exact shape this rule asks a C# author to write: a summary, one
    // <param> per parameter, a <returns>. Every line opens with "//", so the
    // naive run counter read it as nine consecutive line comments and asked
    // — on Codex, where an ask is a hard stop, that denied correct C#
    // documentation and made every documented method need an approval.
    const xmlDoc =
      "    /// <summary>\n" +
      "    /// Clones an app component and its data template.\n" +
      "    /// </summary>\n" +
      '    /// <param name="sourceCode">The component being cloned.</param>\n' +
      '    /// <param name="request">The new code and optional name.</param>\n' +
      '    /// <param name="cancellationToken">Cancels the operation.</param>\n' +
      "    /// <returns>The new app component code.</returns>\n" +
      "    public async Task<Response<string>> CloneAsync(string sourceCode, CloneAppComponentRequest request, CancellationToken cancellationToken = default)\n" +
      "    {";
    eq(decide(rule, { toolName: "Write", filePath: "a.cs", content: xmlDoc }), "pass");
  });

  test("a /// block ends a run of plain // lines rather than extending it", () => {
    // Four ordinary line comments, a doc block, then four more: neither
    // stretch is over the threshold, and the doc block between them must not
    // join them into one run of nine.
    const mixed = `${lineComments(4)}/// <summary>\n/// Does x.\n/// </summary>\n${lineComments(4)}`;
    eq(decide(rule, { toolName: "Edit", filePath: "a.cs", content: mixed }), "pass");
  });

  test("still asks on a genuine run of plain // lines in a .cs file", () => {
    // The carve-out is for `///` specifically — the check itself still works
    // on the backend, so this is not a hole opened in the name of the fix.
    eq(decide(rule, { toolName: "Edit", filePath: "a.cs", content: lineComments(9) }), "ask");
  });

  test("passes @example inside a Markdown file", () => {
    eq(decide(rule, { toolName: "Write", filePath: "a.md", content: "/**\n * @example\n */" }), "pass");
  });

  test("passes a JSON file regardless of content", () => {
    eq(decide(rule, { toolName: "Write", filePath: "a.json", content: "/** @example */" }), "pass");
  });

  test("passes a test file with a compliant JSDoc block", () => {
    eq(decide(rule, { toolName: "Write", filePath: "a.test.ts", content: "/**\n * Guards x.\n *\n * @returns void\n */" }), "pass");
  });

  test("passes when @example is only mentioned mid-sentence, not opening a comment line", () => {
    eq(decide(rule, { toolName: "Edit", filePath: "a.ts", content: "// the @example tag is forbidden in this project" }), "pass");
  });

  test("denies the branch-name spelling of a ticket id, not only the # form", () => {
    eq(decide(rule, { toolName: "Edit", filePath: "a.ts", content: "// see task_54321 in the tracker" }), "deny");
    eq(decide(rule, { toolName: "Edit", filePath: "a.ts", content: "// see TASK-54321 in the tracker" }), "deny");
  });

  test("denies every ticket-word spelling and separator a person actually writes", () => {
    eq(decide(rule, { toolName: "Edit", filePath: "a.ts", content: "// Task 30464 phase 2: build groups" }), "deny");
    eq(
      decide(rule, { toolName: "Edit", filePath: "a.ts", content: "describe('filterGroups task 30464 phase 2', () => {});" }),
      "deny",
    );
    eq(decide(rule, { toolName: "Edit", filePath: "a.ts", content: "// ticket 30464 needs a fix" }), "deny");
    eq(decide(rule, { toolName: "Edit", filePath: "a.ts", content: "// issue 30464 needs a fix" }), "deny");
    eq(decide(rule, { toolName: "Edit", filePath: "a.ts", content: "// story#30464 needs a fix" }), "deny");
    eq(decide(rule, { toolName: "Edit", filePath: "a.ts", content: "// bug: 30464 needs a fix" }), "deny");
  });

  test("passes a word that merely starts with task, with no id after it", () => {
    eq(decide(rule, { toolName: "Edit", filePath: "a.ts", content: "// the task queue drains oldest first" }), "pass");
    eq(decide(rule, { toolName: "Edit", filePath: "a.ts", content: "// task_id is assigned by the server" }), "pass");
  });

  test("passes a ticket word followed by too few digits to be an id", () => {
    eq(decide(rule, { toolName: "Edit", filePath: "a.ts", content: "// task 30 items remain in the queue" }), "pass");
  });

  test("passes a short numeric fragment that is not a ticket id", () => {
    eq(decide(rule, { toolName: "Edit", filePath: "a.ts", content: "// retry #2 succeeded" }), "pass");
  });

  test("passes a CSS hex-color literal, not a ticket id", () => {
    eq(decide(rule, { toolName: "Write", filePath: "a.tsx", content: "const theme = {\n  primary: '#336699',\n};\n" }), "pass");
  });

  test("passes a short hex-color literal outside quotes", () => {
    eq(decide(rule, { toolName: "Edit", filePath: "a.ts", content: "// border: 1px solid #639;" }), "pass");
  });

  test("passes a 3-letter hex color that uses hex-only letters, not a ticket id", () => {
    eq(decide(rule, { toolName: "Write", filePath: "a.ts", content: "const theme = {\n  primary: '#fff',\n};\n" }), "pass");
  });

  test("passes a 6-letter hex color that uses hex-only letters, not a ticket id", () => {
    eq(decide(rule, { toolName: "Write", filePath: "a.ts", content: "const theme = {\n  primary: '#a1b2c3',\n};\n" }), "pass");
  });

  test("passes a numeric URL fragment, not a ticket id", () => {
    eq(decide(rule, { toolName: "Edit", filePath: "a.ts", content: "// see https://en.wikipedia.org/wiki/Section#1990s for background" }), "pass");
  });

  test("passes a long word right before a # fragment, past the short-prefix cap", () => {
    eq(decide(rule, { toolName: "Edit", filePath: "a.ts", content: "// see Section#1990 here" }), "pass");
  });

  test("denies the Azure Boards AB# spelling alongside the bare # form", () => {
    eq(decide(rule, { toolName: "Edit", filePath: "a.ts", content: "// AB#31921 fixed the off-by-one" }), "deny");
    eq(decide(rule, { toolName: "Edit", filePath: "a.ts", content: "// #31921 fixed the off-by-one" }), "deny");
  });

  test("passes a banner comment in a .cs file that is not JSDoc", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "a.cs",
        content: "/**************************************\n * Section: Repository setup\n **************************************/\npublic class Foo {}",
      }),
      "pass",
    );
  });

  test("passes empty replacement content", () => {
    eq(decide(rule, { toolName: "Edit", filePath: "a.ts", content: "   \n" }), "pass");
  });

  test("passes a non-write tool touching the same file", () => {
    eq(decide(rule, { toolName: "Read", filePath: "a.ts", content: "/**\n * @example\n */" }), "pass");
  });

  test("passes an ordinary two-line inline comment", () => {
    eq(decide(rule, { toolName: "Edit", filePath: "a.ts", content: "// Cache the result: recomputing it is expensive on every render.\nconst x = 1;" }), "pass");
  });

  /* ------------------------------------------------------------ overrides */

  test("an override softens the deny to ask", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "a.ts",
        content: "/**\n * @example\n */",
        overrideSpec: { "doc-comment-style": { action: "ask" } },
      }),
      "ask",
    );
  });

  /* ---------------------------------------------- configurable thresholds */

  test("a project's own docCommentStyle softens the block-length backstop", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "a.ts",
        content: proseBlock(20),
        project: { docCommentStyle: { maxBlockLines: 25 } },
      }),
      "pass",
    );
  });

  test("a project's own docCommentStyle tightens the line-comment-run backstop", () => {
    eq(
      decide(rule, {
        toolName: "Edit",
        filePath: "a.tsx",
        content: lineComments(4),
        project: { docCommentStyle: { maxLineCommentRun: 3 } },
      }),
      "ask",
    );
  });

  test("the backend stack preset raises the block-length backstop past the default 18", () => {
    // filePath is .ts on purpose: the block-length check itself is extension-
    // agnostic, and a .cs path would hit the earlier JSDoc-in-.cs denial
    // before ever reaching it. This isolates the preset-merge mechanism.
    eq(decide(rule, { toolName: "Write", filePath: "a.ts", content: proseBlock(20), project: PROJECT_BACKEND }), "pass");
  });

  test("the backend stack preset raises the line-comment-run backstop past the default 6", () => {
    eq(decide(rule, { toolName: "Edit", filePath: "a.cs", content: lineComments(9), project: PROJECT_BACKEND }), "pass");
  });

  test("the backend stack preset's raised backstop still asks once genuinely exceeded", () => {
    eq(decide(rule, { toolName: "Write", filePath: "a.ts", content: proseBlock(35), project: PROJECT_BACKEND }), "ask");
  });

  /* --------------------------------------------------- minimal project */

  test("stays correct with no project configuration beyond an id", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "a.ts",
        content: "/**\n * Reads a thing.\n *\n * @returns The thing.\n */",
        project: PROJECT_MINIMAL,
      }),
      "pass",
    );
  });
});
