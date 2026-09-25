"use strict";

/**
 * Table-driven suite for `comment-line-width`.
 */

const { suite } = require("../harness");
const { PROJECT_MINIMAL, decide, decision } = require("./_ctx");
const rule = require("../../core/guards/comment-line-width");

/** A project fixture with the width nudge configured at 80 characters. */
const WIDTH_80 = { docCommentStyle: { maxLineWidth: 80 } };

/** A project fixture with the width nudge configured at 40 characters, for shorter fixture lines. */
const WIDTH_40 = { docCommentStyle: { maxLineWidth: 40 } };

const CASES = [
  // positive — an ordinary over-width prose line is still caught
  {
    label: "an over-width JSDoc prose line asks",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/big.ts",
      project: WIDTH_40,
      content: [
        "/**",
        " * This sentence is deliberately long enough to spill well past the limit.",
        " */",
      ].join("\n"),
    },
    want: "ask",
  },
  {
    label: "an over-width // line comment asks",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/plain.ts",
      project: WIDTH_40,
      content: "// This inline comment runs on for far longer than the configured limit allows",
    },
    want: "ask",
  },
  {
    label: "an over-width /// XML doc line asks",
    ctx: {
      toolName: "Write",
      filePath: "/repo/Service/Thing.cs",
      project: WIDTH_40,
      content: [
        "/// <summary>",
        "/// Resolves the thing from a source that is described here at unnecessary length.",
        "/// </summary>",
      ].join("\n"),
    },
    want: "ask",
  },

  // carve-out: unbreakable single token
  {
    label: "a single unbreakable URL with no wrap point is not flagged",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/link.ts",
      project: WIDTH_40,
      content: "// https://example.invalid/a/very/long/path/segment/that/keeps/going/and/going",
    },
    want: "pass",
  },
  {
    label: "an over-width line whose overflow region still has whitespace is flagged, not exempted as unbreakable",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/wordy.ts",
      project: WIDTH_40,
      content: "// short prefix then several more ordinary words after the limit column",
    },
    want: "ask",
  },
  {
    label: "an ordinary sentence whose short last word merely straddles the limit is flagged, not exempted as unbreakable",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/sentence.ts",
      project: WIDTH_80,
      content:
        "// This is an ordinary sentence built only from short common words that is now underway",
    },
    want: "ask",
  },

  // carve-out: markdown table row inside a doc comment
  {
    label: "a markdown table row inside a doc comment is not flagged",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/table.ts",
      project: WIDTH_40,
      content: [
        "/**",
        " * | Threshold | Level    | What it means for the reader |",
        " */",
      ].join("\n"),
    },
    want: "pass",
  },

  // carve-out: a line inside a fenced code block within a doc comment
  {
    label: "a line inside a fenced code block within a doc comment is not flagged",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/fenced.ts",
      project: WIDTH_40,
      content: [
        "/**",
        " * ```",
        " * const veryLongIdentifierNameThatOverflowsTheConfiguredCommentWidth = 1;",
        " * ```",
        " */",
      ].join("\n"),
    },
    want: "pass",
  },
  {
    label: "a line after the fence has closed is judged normally again",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/fenced2.ts",
      project: WIDTH_40,
      content: [
        "/**",
        " * ```",
        " * const short = 1;",
        " * ```",
        " * This trailing sentence is also long enough to spill past the limit.",
        " */",
      ].join("\n"),
    },
    want: "ask",
  },
  {
    label: "an unmatched fence inside one comment does not exempt a later, unrelated comment",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/unmatched-fence.ts",
      project: WIDTH_80,
      content: [
        "/**",
        " * ```",
        " * some code that never closes the fence before the block itself ends",
        " */",
        "",
        "// This unrelated later comment is an ordinary sentence that plainly runs well past the limit",
      ].join("\n"),
    },
    want: "ask",
  },
  {
    label: "a stray fence marker followed by ordinary code does not exempt a later comment",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/stray-fence.ts",
      project: WIDTH_80,
      content: [
        "// ```",
        "const x = 1;",
        "function ok() { return x; }",
        "",
        "// This unrelated later comment is an ordinary sentence that plainly runs well past the eighty column limit",
      ].join("\n"),
    },
    want: "ask",
  },

  // negative — ordinary daily work
  {
    label: "a comment line within the configured width passes",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/ok.ts",
      project: WIDTH_80,
      content: "// a short comment",
    },
    want: "pass",
  },
  {
    label: "ordinary code with no comments passes",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/code.ts",
      project: WIDTH_40,
      content: "const someVeryLongVariableNameThatIsCodeNotACommentAtAll = 1;",
    },
    want: "pass",
  },
  {
    label: "empty content passes",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/empty.ts",
      project: WIDTH_40,
      content: "",
    },
    want: "pass",
  },
  {
    label: "a shell command is not a file write and passes",
    ctx: { toolName: "Bash", command: "cat src/big.ts", project: WIDTH_40 },
    want: "pass",
  },

  // requiresConfig: silent unless the project has opted in
  {
    label: "requiresConfig: a minimal project with no docCommentStyle.maxLineWidth stays silent, however long the comment",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/big.ts",
      project: PROJECT_MINIMAL,
      content: "// This inline comment runs on for far longer than any sane configured limit would allow",
    },
    want: "pass",
  },

  // override
  {
    label: "an override softens the rule to pass",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/big.ts",
      project: WIDTH_40,
      content: "// This inline comment runs on for far longer than the configured limit allows",
      overrideSpec: { "comment-line-width": { action: "off" } },
    },
    want: "pass",
  },
];

suite("guards/comment-line-width", ({ test, eq, ok }) => {
  for (const c of CASES) {
    test(c.label, () => {
      eq(decide(rule, c.ctx), c.want, c.label);
    });
  }

  test("the reason states the configured limit and the line's own width", () => {
    const result = decision(rule, {
      toolName: "Write",
      filePath: "/repo/src/services/big.ts",
      project: WIDTH_40,
      content: "// This inline comment runs on for far longer than the configured limit allows",
    });
    ok(result, "expected a decision");
    eq(result.action, "ask");
    ok(result.reason.includes("40"), "reason should mention the configured limit");
    ok(/\d+/.test(result.reason), "reason should mention the actual line width");
  });

  test("advisoryAsk is set on the module, so the ask is a nudge rather than a hard stop", () => {
    eq(rule.advisoryAsk, true);
  });

  test("defaultAction never exceeds ask", () => {
    eq(rule.defaultAction, "ask");
  });
});
