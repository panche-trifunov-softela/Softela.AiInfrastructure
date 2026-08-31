"use strict";

/**
 * `core/installer/managed-block.js` — the BEGIN/END marker mechanics that
 * back every text file the installer shares with the developer (global
 * instructions, the repo-pointer template). Content outside the markers must
 * survive verbatim, and an absent marker pair must mean "append", never
 * "replace the file".
 */

const { suite } = require("../harness");
const mb = require("../../core/installer/managed-block");

suite("installer/managed-block", ({ test, eq, ok, throws }) => {
  test("upsertBlock on empty content creates the block with markers", () => {
    const result = mb.upsertBlock("", "hello world");
    ok(result.changed);
    ok(result.content.includes(mb.BEGIN));
    ok(result.content.includes(mb.END));
    ok(result.content.includes("hello world"));
  });

  test("upsertBlock replaces an existing block in place, preserving surrounding content verbatim", () => {
    const before = `# My own notes\n\nBefore the block.\n\n${mb.BEGIN}\n\nold body\n\n${mb.END}\n\nAfter the block, untouched.\n`;
    const result = mb.upsertBlock(before, "new body");
    ok(result.changed);
    ok(result.content.includes("# My own notes"));
    ok(result.content.includes("Before the block."));
    ok(result.content.includes("After the block, untouched."));
    ok(result.content.includes("new body"));
    ok(!result.content.includes("old body"));
  });

  test("upsertBlock is a no-op when the block already matches", () => {
    const before = `${mb.BEGIN}\n\nsame body\n\n${mb.END}\n`;
    const result = mb.upsertBlock(before, "same body");
    eq(result.changed, false);
    eq(result.content, before);
  });

  test("upsertBlock appends when markers are absent, never replacing the file", () => {
    const before = "# Developer's own file\n\nSome prior content that must survive.\n";
    const result = mb.upsertBlock(before, "appended body");
    ok(result.changed);
    ok(result.content.startsWith("# Developer's own file"));
    ok(result.content.includes("Some prior content that must survive."));
    ok(result.content.includes(mb.BEGIN));
    ok(result.content.includes("appended body"));
  });

  test("removeBlock removes the block and collapses surrounding blank lines", () => {
    const before = `before\n\n${mb.BEGIN}\n\nbody\n\n${mb.END}\n\nafter\n`;
    const result = mb.removeBlock(before);
    ok(result.changed);
    ok(!result.content.includes(mb.BEGIN));
    ok(!result.content.includes("body"));
    ok(result.content.includes("before"));
    ok(result.content.includes("after"));
    ok(!result.content.includes("\n\n\n"));
  });

  test("removeBlock is a no-op when no block is present", () => {
    const before = "nothing managed here\n";
    const result = mb.removeBlock(before);
    eq(result.changed, false);
    eq(result.content, before);
  });

  test("extractBody returns the trimmed inner text of a marked template", () => {
    const template = `${mb.BEGIN}\n\n  inner text  \n\n${mb.END}\n`;
    eq(mb.extractBody(template), "inner text");
  });

  test("extractBody returns the whole trimmed text when the template carries no markers", () => {
    eq(mb.extractBody("  plain template body  "), "plain template body");
  });

  test("hasBlock detects presence and absence correctly", () => {
    eq(mb.hasBlock(`${mb.BEGIN}\n${mb.END}`), true);
    eq(mb.hasBlock("no markers here"), false);
  });

  test("applyTemplate writes the whole template verbatim for a nonexistent file", () => {
    const result = mb.applyTemplate(null, "fresh content\n");
    ok(result.changed);
    eq(result.content, "fresh content\n");
  });

  test("applyTemplate upserts only the template's own block into existing content", () => {
    const existing = "# Existing file\n\nDeveloper's own text.\n";
    const template = `${mb.BEGIN}\n\ntemplate body\n\n${mb.END}\n`;
    const result = mb.applyTemplate(existing, template);
    ok(result.content.includes("Developer's own text."));
    ok(result.content.includes("template body"));
  });

  test("upsertBlock refuses rather than guess when the file already carries more than one BEGIN/END occurrence", () => {
    // Superseded scenario: an earlier round's design trusted a greedy "first
    // BEGIN to last END" scan to recover a block a previous corrupted run
    // had left carrying an embedded fake marker pair, silently picking the
    // outermost markers as "the real ones". That is exactly the same
    // mechanism that lets a developer's own prose — quoting the delimiter,
    // as anyone documenting this tool naturally would — destroy or strand
    // real content between two markers this installer never wrote. The
    // current design refuses outright instead of guessing which occurrence
    // is real, naming every marker occurrence it found so the developer can
    // resolve the ambiguity by hand.
    const corrupted = `before\n\n${mb.BEGIN}\n\nold body ${mb.END} INJECTED ${mb.BEGIN} more old\n\n${mb.END}\n\nafter\n`;
    throws(() => mb.upsertBlock(corrupted, "clean new body"), "expected upsertBlock to refuse rather than guess which marker pair is real");
    try {
      mb.upsertBlock(corrupted, "clean new body");
      ok(false, "unreachable");
    } catch (err) {
      ok(err instanceof mb.AmbiguousBlockError, `expected an AmbiguousBlockError, got: ${err}`);
      eq(err.beginLines.length, 2);
      eq(err.endLines.length, 2);
    }
  });

  test("upsertBlock never destroys developer sections that come after the block, even when a later one quotes the literal END marker verbatim", () => {
    // The exact reported failure: a developer documenting this very tool
    // naturally quotes its delimiter somewhere in their own prose. A greedy
    // "first BEGIN to last END" scan then treats that quoted marker as the
    // block's real closing END, silently swallowing (or, run the other way,
    // stranding) every developer section in between. The fix refuses to
    // guess rather than pick a marker occurrence it cannot attribute to
    // itself and destroy content around it.
    const before =
      `${mb.BEGIN}\n\nold body\n\n${mb.END}\n\n` +
      `## Developer section one\n\nImportant notes that must never be lost.\n\n` +
      `## Developer section two\n\nThis tool's block ends with a line reading exactly:\n\n\`${mb.END}\`\n`;
    throws(() => mb.upsertBlock(before, "new body"), "expected upsertBlock to refuse rather than silently drop developer sections");
  });

  test("removeBlock never destroys developer sections when a later one quotes the literal END marker verbatim", () => {
    // The uninstall-side mirror of the same defect: `softela-ai uninstall`
    // removing the managed block must not also remove real developer
    // content simply because their prose quotes the delimiter.
    const before =
      `${mb.BEGIN}\n\nbody\n\n${mb.END}\n\n` +
      `## Developer note\n\nQuoting the delimiter for documentation: \`${mb.END}\`\n\n` +
      `## Another developer note\n\nThis must survive uninstall too.\n`;
    throws(() => mb.removeBlock(before), "expected removeBlock to refuse rather than silently drop developer sections");
  });

  test("upsertBlock keeps updating an ordinary, already-installed CLAUDE.md exactly as before — the migration case", () => {
    // An existing file this tool itself wrote — one clean BEGIN, one clean
    // END, arbitrary developer prose before and after that never quotes
    // either marker verbatim — must keep updating in place. The stricter
    // matching this fix introduces must never orphan an install that
    // predates it.
    const before =
      `# Team notes\n\nSome prior context the developer wrote.\n\n` +
      `${mb.BEGIN}\n\nold instructions\n\n${mb.END}\n\n` +
      `## Local conventions\n\nMore of the developer's own material.\n`;
    const result = mb.upsertBlock(before, "new instructions");
    ok(result.changed);
    ok(result.content.includes("Some prior context the developer wrote."));
    ok(result.content.includes("More of the developer's own material."));
    ok(result.content.includes("new instructions"));
    ok(!result.content.includes("old instructions"));
  });

  test("upsertBlock leaves a developer's own unrelated HTML comment, outside the managed block, untouched", () => {
    const before = `# Notes\n\n<!-- a developer's own unrelated comment -->\n\nSome text.\n\n${mb.BEGIN}\n\nold body\n\n${mb.END}\n`;
    const result = mb.upsertBlock(before, "new body");
    ok(result.content.includes("<!-- a developer's own unrelated comment -->"), `expected the unrelated comment to survive, got:\n${result.content}`);
    ok(result.content.includes("new body"));
    ok(!result.content.includes("old body"));
  });

  test("upsertBlock leaves the bare word BEGIN, appearing in the developer's own prose outside the block, untouched", () => {
    const before = `# Notes\n\nLet's BEGIN with the basics, and END on a high note.\n\n${mb.BEGIN}\n\nold body\n\n${mb.END}\n`;
    const result = mb.upsertBlock(before, "new body");
    ok(result.content.includes("Let's BEGIN with the basics, and END on a high note."), `expected the bare words to survive, got:\n${result.content}`);
    ok(result.content.includes("new body"));
  });

  test("removeBlock preserves a developer's own HTML comment and the bare words BEGIN/END in surrounding prose", () => {
    const before = `before <!-- unrelated --> and the word BEGIN itself\n\n${mb.BEGIN}\n\nbody\n\n${mb.END}\n\nafter, also END as a plain word\n`;
    const result = mb.removeBlock(before);
    ok(result.changed);
    ok(result.content.includes("<!-- unrelated -->"), `expected the unrelated comment to survive, got:\n${result.content}`);
    ok(result.content.includes("the word BEGIN itself"), `expected the bare word to survive, got:\n${result.content}`);
    ok(result.content.includes("also END as a plain word"), `expected the bare word to survive, got:\n${result.content}`);
  });
});
