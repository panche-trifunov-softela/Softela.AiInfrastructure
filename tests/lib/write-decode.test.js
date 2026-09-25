"use strict";

const { suite } = require("../harness");
const {
  decodeWrites,
  decodeWritesDetailed,
  isWriteToolName,
  KNOWN_PATCH_MARKERS,
  decodePatchBody,
  MAX_RECONSTRUCT_BYTES,
} = require("../../core/lib/write-decode");

/**
 * Builds a `readFile`-shaped function backed by a plain path-to-content map,
 * for a test to feed `decodeWrites` a fake filesystem without touching disk.
 *
 * @param {object} files A map of path to file content.
 * @returns {(p: string) => string | null} A reader returning `null` for any
 * path not present in `files`.
 */
function fakeReader(files) {
  return (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null);
}

suite("lib/write-decode", ({ test, eq, deepEq, ok }) => {
  /* --------------------------------------------------------- isWriteToolName */

  test("isWriteToolName recognises every write-shaped tool name, on either host", () => {
    for (const name of ["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch", "write_file", "edit_file"]) {
      ok(isWriteToolName(name), `expected ${name} to be recognised`);
    }
  });

  test("isWriteToolName rejects a non-write tool name", () => {
    eq(isWriteToolName("Bash"), false);
    eq(isWriteToolName("local_shell"), false);
    eq(isWriteToolName(""), false);
    eq(isWriteToolName(undefined), false);
  });

  /* -------------------------------------------------------------------- Write */

  test("Write decodes a brand-new file as kind:add", () => {
    const writes = decodeWrites(
      "Write",
      { file_path: "src/a.ts", content: "export const a = 1;" },
      { readFile: fakeReader({}) },
    );
    deepEq(writes, [{ path: "src/a.ts", content: "export const a = 1;", kind: "add", pathBase: "cwd" }]);
  });

  test("Write decodes an existing file as kind:update", () => {
    const writes = decodeWrites(
      "Write",
      { file_path: "src/a.ts", content: "export const a = 2;" },
      { readFile: fakeReader({ "src/a.ts": "export const a = 1;" }) },
    );
    eq(writes[0].kind, "update");
  });

  test("Write with no recognised path field decodes nothing", () => {
    deepEq(decodeWrites("Write", { content: "x" }, { readFile: fakeReader({}) }), []);
  });

  test("write_file decodes the same Write-like shape", () => {
    const writes = decodeWrites("write_file", { path: "src/a.ts", content: "x" }, { readFile: fakeReader({}) });
    deepEq(writes, [{ path: "src/a.ts", content: "x", kind: "add", pathBase: "cwd" }]);
  });

  /* --------------------------------------------------------------------- Edit */

  test("Edit reconstructs the resulting content when old_string is found", () => {
    const writes = decodeWrites(
      "Edit",
      { file_path: "src/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
      { readFile: fakeReader({ "src/a.ts": "export const a = 1;\n" }) },
    );
    deepEq(writes, [
      { path: "src/a.ts", content: "export const a = 2;\n", insertedText: "const a = 2;", kind: "update", pathBase: "cwd" },
    ]);
  });

  test("Edit reconstruction fails to content:null when old_string is not found", () => {
    const writes = decodeWrites(
      "Edit",
      { file_path: "src/a.ts", old_string: "does not appear anywhere", new_string: "x" },
      { readFile: fakeReader({ "src/a.ts": "export const a = 1;\n" }) },
    );
    deepEq(writes, [{ path: "src/a.ts", content: null, insertedText: "x", kind: "update", pathBase: "cwd" }]);
  });

  test("Edit reconstruction fails to content:null when the file cannot be read", () => {
    const writes = decodeWrites(
      "Edit",
      { file_path: "src/missing.ts", old_string: "a", new_string: "b" },
      { readFile: fakeReader({}) },
    );
    deepEq(writes, [{ path: "src/missing.ts", content: null, insertedText: "b", kind: "update", pathBase: "cwd" }]);
  });

  test("edit_file decodes the same Edit-like shape", () => {
    const writes = decodeWrites(
      "edit_file",
      { file_path: "src/a.ts", old_string: "a = 1", new_string: "a = 2" },
      { readFile: fakeReader({ "src/a.ts": "a = 1" }) },
    );
    deepEq(writes, [{ path: "src/a.ts", content: "a = 2", insertedText: "a = 2", kind: "update", pathBase: "cwd" }]);
  });

  test("Edit honours replace_all, replacing every occurrence rather than only the first", () => {
    const writes = decodeWrites(
      "Edit",
      { file_path: "src/a.ts", old_string: "foo", new_string: "bar", replace_all: true },
      { readFile: fakeReader({ "src/a.ts": "foo(foo(foo()))" }) },
    );
    deepEq(writes, [
      { path: "src/a.ts", content: "bar(bar(bar()))", insertedText: "bar", kind: "update", pathBase: "cwd" },
    ]);
  });

  test("Edit without replace_all still replaces only the first occurrence", () => {
    const writes = decodeWrites(
      "Edit",
      { file_path: "src/a.ts", old_string: "foo", new_string: "bar" },
      { readFile: fakeReader({ "src/a.ts": "foo(foo(foo()))" }) },
    );
    deepEq(writes, [
      { path: "src/a.ts", content: "bar(foo(foo()))", insertedText: "bar", kind: "update", pathBase: "cwd" },
    ]);
  });

  /* ---------------------------------------------------------------- MultiEdit */

  test("MultiEdit applies every edit in order against the file's own content", () => {
    const writes = decodeWrites(
      "MultiEdit",
      {
        file_path: "src/a.ts",
        edits: [
          { old_string: "const a = 1;", new_string: "const a = 2;" },
          { old_string: "a = 2", new_string: "a = 3" },
        ],
      },
      { readFile: fakeReader({ "src/a.ts": "export const a = 1;\n" }) },
    );
    deepEq(writes, [
      {
        path: "src/a.ts",
        content: "export const a = 3;\n",
        insertedText: "const a = 2;\na = 3",
        kind: "update",
        pathBase: "cwd",
      },
    ]);
  });

  test("MultiEdit fails to content:null the moment one edit in the sequence cannot be applied", () => {
    const writes = decodeWrites(
      "MultiEdit",
      {
        file_path: "src/a.ts",
        edits: [
          { old_string: "const a = 1;", new_string: "const a = 2;" },
          { old_string: "does not exist", new_string: "x" },
        ],
      },
      { readFile: fakeReader({ "src/a.ts": "export const a = 1;\n" }) },
    );
    deepEq(writes, [
      { path: "src/a.ts", content: null, insertedText: "const a = 2;\nx", kind: "update", pathBase: "cwd" },
    ]);
  });

  test("MultiEdit honours each edit's own replace_all flag independently", () => {
    const writes = decodeWrites(
      "MultiEdit",
      {
        file_path: "src/a.ts",
        edits: [
          { old_string: "foo", new_string: "bar", replace_all: true },
          { old_string: "bar()", new_string: "baz()" },
        ],
      },
      { readFile: fakeReader({ "src/a.ts": "foo(foo(foo()))" }) },
    );
    deepEq(writes, [
      {
        path: "src/a.ts",
        content: "bar(bar(baz()))",
        insertedText: "bar\nbaz()",
        kind: "update",
        pathBase: "cwd",
      },
    ]);
  });

  test("MultiEdit with no edits array decodes nothing — this is the defect's own miniature case", () => {
    // Before this module existed, `MultiEdit`'s text lived only inside
    // `edits[]`, which `core/lib/context.js#buildContext` never read at all —
    // the path rule fired, the content rule stayed silent. This asserts the
    // decoder itself sees nothing when `edits` genuinely is not an array.
    deepEq(decodeWrites("MultiEdit", { file_path: "src/a.ts" }, { readFile: fakeReader({}) }), []);
  });

  /* -------------------------------------------------------------- NotebookEdit */

  test("NotebookEdit decodes the path but never guesses the resulting content", () => {
    const writes = decodeWrites(
      "NotebookEdit",
      { notebook_path: "nb/analysis.ipynb", cell_id: "c1", new_source: "print(1)", edit_mode: "replace" },
      { readFile: fakeReader({}) },
    );
    deepEq(writes, [{ path: "nb/analysis.ipynb", content: null, kind: "update", pathBase: "cwd" }]);
  });

  test("NotebookEdit maps edit_mode to kind", () => {
    const insert = decodeWrites("NotebookEdit", { notebook_path: "nb/a.ipynb", edit_mode: "insert" }, {});
    eq(insert[0].kind, "add");
    const del = decodeWrites("NotebookEdit", { notebook_path: "nb/a.ipynb", edit_mode: "delete" }, {});
    eq(del[0].kind, "delete");
  });

  /* -------------------------------------------------------------- apply_patch */

  test("apply_patch decodes the already-working {file_path, content} direct shape", () => {
    const writes = decodeWrites(
      "apply_patch",
      { file_path: "src/a.ts", content: "export const a = 9;" },
      { readFile: fakeReader({}) },
    );
    deepEq(writes, [{ path: "src/a.ts", content: "export const a = 9;", kind: "add", pathBase: "cwd" }]);
  });

  test("apply_patch decodes a {input: patch text} single-file update", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/Widget.ts",
      "@@ constructor",
      " constructor() {",
      "-old init",
      "+new init",
      " }",
      "*** End Patch",
    ].join("\n");
    const writes = decodeWrites(
      "apply_patch",
      { input: patch },
      { readFile: fakeReader({ "src/Widget.ts": "constructor() {\nold init\n}\n" }) },
    );
    deepEq(writes, [
      { path: "src/Widget.ts", content: "constructor() {\nnew init\n}\n", kind: "update", pathBase: "repoRoot" },
    ]);
  });

  test("apply_patch decodes a {patch: ...} envelope carrying add, update and delete sections for three files", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/New.ts",
      "+export const x = 1;",
      "*** Update File: src/Widget.ts",
      " constructor() {",
      "-old init",
      "+new init",
      " }",
      "*** Delete File: src/Old.ts",
      "*** End Patch",
    ].join("\n");
    // A genuine Delete File header always targets a file that is actually
    // there — src/Old.ts is given real (if irrelevant) content here purely
    // so the header-existence invariant sees it as present; the delete
    // reconstruction itself never reads it.
    const writes = decodeWrites(
      "apply_patch",
      { patch },
      {
        readFile: fakeReader({
          "src/Widget.ts": "constructor() {\nold init\n}\n",
          "src/Old.ts": "doomed",
        }),
      },
    );
    deepEq(writes, [
      { path: "src/New.ts", content: "export const x = 1;", kind: "add", pathBase: "repoRoot" },
      { path: "src/Widget.ts", content: "constructor() {\nnew init\n}\n", kind: "update", pathBase: "repoRoot" },
      { path: "src/Old.ts", content: null, kind: "delete", pathBase: "repoRoot" },
    ]);
  });

  /* ---------------------------------------------------------- R1: mid-file */

  test("R1: a single-hunk update patching the middle of a file reconstructs correctly — not only when it happens to reach the file's own last line", () => {
    // PATCH_BLOCK_RE always captures the newline sitting right before the
    // literal "*** End Patch" as part of the envelope body. Before the fix,
    // splitting on "\n" turned that artifact into a phantom trailing
    // context line with an empty value, appended to whichever hunk was
    // still open — demanding a genuinely blank line immediately after the
    // hunk's own last line in the CURRENT file. Every prior fixture happened
    // to patch the file's final content, where that phantom blank
    // coincidentally lined up with the file's own trailing newline. This
    // file has real content — `export const marker = "end";` — sitting
    // after the hunk's own last touched line, so the coincidence cannot
    // happen: only the fix (stripping the one artifact newline before
    // parsing) reconstructs this correctly.
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/types/FooProbe.ts",
      " export type FooProbe = {",
      "-  id: string;",
      "+  id: any;",
      "   name: string;",
      " };",
      "*** End Patch",
    ].join("\n");
    const writes = decodeWrites(
      "apply_patch",
      { input: patch },
      {
        readFile: fakeReader({
          "src/types/FooProbe.ts":
            'export type FooProbe = {\n  id: string;\n  name: string;\n};\nexport const marker = "end";\n',
        }),
      },
    );
    deepEq(writes, [
      {
        path: "src/types/FooProbe.ts",
        content: 'export type FooProbe = {\n  id: any;\n  name: string;\n};\nexport const marker = "end";\n',
        kind: "update",
        pathBase: "repoRoot",
      },
    ]);
  });

  /* ------------------------------------------- budget gap: one oversized file */

  test("R5: applyHunksToFile's budget gate stops reconstruction the instant a file's OWN size exceeds what remains — not only on the next file's reserve()", () => {
    // Before the fix, `applyHunksToFile` called `budget.chargeBytes(existing.length)`
    // and threw away its return value, so a file whose own size alone
    // exhausted the budget was still split, searched and reconstructed in
    // full — only the NEXT file's own `reserve()` call would ever see the
    // damage. This budget's `chargeBytes` always reports "over budget",
    // simulating a file whose size alone is already too much (`reserve()`
    // and `take()` still succeed, exactly like the real budget before this
    // file's size is known) — a small fixture stands in for a large one
    // since the structural gap this proves is independent of how big the
    // file actually is.
    const body = ["*** Update File: src/Big.ts", " context line", "-old", "+new", " after"].join("\n");
    const readFile = fakeReader({ "src/Big.ts": "context line\nold\nafter" });
    const budget = { reserve: () => true, take: () => true, chargeBytes: () => false };

    const { ambiguous, entries } = decodePatchBody(body, readFile, () => true, budget);

    eq(ambiguous, false);
    // Without the fix this would be the fully-applied
    // "context line\nnew\nafter" — the hunk genuinely does match — proving
    // the budget's own verdict on this file's size was never consulted.
    deepEq(entries, [{ path: "src/Big.ts", content: null, kind: "update", pathBase: "repoRoot" }]);
  });

  /* --------------------------------------------- statFile: read-avoidance gap */

  test("THE GAP THIS UNIT CLOSES: statFile lets an over-budget file's own size be charged BEFORE readFile is ever called for it", () => {
    // Direct proof, not merely a null-content inference: `readFile` throws if
    // it is ever invoked for this section's path, so a bug that still reads
    // the file before consulting `statFile` fails this test loudly rather
    // than merely producing the same `content: null` a correct implementation
    // would also produce.
    const body = ["*** Update File: src/Huge.ts", " context line", "-old", "+new", " after"].join("\n");
    const readFile = () => {
      throw new Error("readFile must not be called once statFile alone already exceeds the budget");
    };
    const chargeCalls = [];
    const budget = {
      reserve: () => true,
      take: () => true,
      chargeBytes(n) {
        chargeCalls.push(n);
        return false;
      },
    };
    const statFile = () => MAX_RECONSTRUCT_BYTES;

    const { ambiguous, entries } = decodePatchBody(body, readFile, () => true, budget, undefined, statFile);

    eq(ambiguous, false);
    deepEq(entries, [{ path: "src/Huge.ts", content: null, kind: "update", pathBase: "repoRoot" }]);
    deepEq(chargeCalls, [MAX_RECONSTRUCT_BYTES], "the stat's own size, not the (never-read) file content, must be charged");
  });

  test("a file that fits, with statFile supplied, charges its size exactly once and reconstructs unchanged", () => {
    const existing = "context line\nold\nafter";
    const body = ["*** Update File: src/Fine.ts", " context line", "-old", "+new", " after"].join("\n");
    const readFile = fakeReader({ "src/Fine.ts": existing });
    const chargeCalls = [];
    const budget = {
      reserve: () => true,
      take: () => true,
      chargeBytes(n) {
        chargeCalls.push(n);
        return true;
      },
    };
    const statFile = (p) => (p === "src/Fine.ts" ? existing.length : null);

    const { ambiguous, entries } = decodePatchBody(body, readFile, () => true, budget, undefined, statFile);

    eq(ambiguous, false);
    deepEq(entries, [{ path: "src/Fine.ts", content: "context line\nnew\nafter", kind: "update", pathBase: "repoRoot" }]);
    // Exactly one charge: the stat already answered, so the post-read charge
    // must be skipped rather than double-counting the same file's bytes.
    deepEq(chargeCalls, [existing.length]);
  });

  test("statFile returning null (a file the stat itself cannot answer for) falls back to the read-then-check path, and never throws", () => {
    const body = ["*** Update File: src/Unstattable.ts", " x", "-a", "+b"].join("\n");
    const readFile = fakeReader({ "src/Unstattable.ts": "x\na\n" });
    const chargeCalls = [];
    const budget = {
      reserve: () => true,
      take: () => true,
      chargeBytes(n) {
        chargeCalls.push(n);
        return true;
      },
    };
    const statFile = () => null;

    let threw = false;
    let result;
    try {
      result = decodePatchBody(body, readFile, () => true, budget, undefined, statFile);
    } catch {
      threw = true;
    }

    eq(threw, false);
    eq(result.ambiguous, false);
    deepEq(result.entries, [{ path: "src/Unstattable.ts", content: "x\nb\n", kind: "update", pathBase: "repoRoot" }]);
    // The stat answered nothing, so the charge must come from the read's own
    // real length — exactly today's fallback, not skipped and not doubled.
    deepEq(chargeCalls, ["x\na\n".length]);
  });

  test("omitting statFile altogether (an older caller) falls back to exactly today's read-then-check behaviour", () => {
    // No 6th argument at all — the shape every pre-existing caller of
    // decodePatchBody (including R5, above) already uses.
    const body = ["*** Update File: src/NoStat.ts", " x", "-a", "+b"].join("\n");
    const readFile = fakeReader({ "src/NoStat.ts": "x\na\n" });
    const budget = { reserve: () => true, take: () => true, chargeBytes: () => true };

    const { ambiguous, entries } = decodePatchBody(body, readFile, () => true, budget);

    eq(ambiguous, false);
    deepEq(entries, [{ path: "src/NoStat.ts", content: "x\nb\n", kind: "update", pathBase: "repoRoot" }]);
  });

  test("decodeWrites end-to-end: a statFileRepoRoot answering an over-budget size means the reader is never reached, even through the full apply_patch path", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/Huge.ts",
      " context",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    const readFileRepoRoot = () => {
      throw new Error("readFileRepoRoot must not be called for an over-budget file");
    };
    const writes = decodeWrites(
      "apply_patch",
      { input: patch },
      {
        readFile: fakeReader({}),
        readFileRepoRoot,
        pathExistsRepoRoot: () => true,
        statFileRepoRoot: () => MAX_RECONSTRUCT_BYTES,
      },
    );
    deepEq(writes, [{ path: "src/Huge.ts", content: null, kind: "update", pathBase: "repoRoot" }]);
  });

  test("decodeWrites end-to-end: statFileRepoRoot defaults to statFile when only the latter is supplied, mirroring readFileRepoRoot's own default", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/Huge.ts",
      " context",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    const readFileRepoRoot = () => {
      throw new Error("readFileRepoRoot must not be called for an over-budget file");
    };
    const writes = decodeWrites(
      "apply_patch",
      { input: patch },
      {
        readFile: fakeReader({}),
        readFileRepoRoot,
        pathExistsRepoRoot: () => true,
        statFile: () => MAX_RECONSTRUCT_BYTES,
      },
    );
    deepEq(writes, [{ path: "src/Huge.ts", content: null, kind: "update", pathBase: "repoRoot" }]);
  });

  test("apply_patch update reconstruction fails to content:null when a hunk's context cannot be located", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/Widget.ts",
      " this line does not appear in the file",
      "-neither does this one",
      "+so this cannot be placed",
      "*** End Patch",
    ].join("\n");
    const writes = decodeWrites(
      "apply_patch",
      { input: patch },
      { readFile: fakeReader({ "src/Widget.ts": "totally different content\n" }) },
    );
    deepEq(writes, [{ path: "src/Widget.ts", content: null, kind: "update", pathBase: "repoRoot" }]);
  });

  test("apply_patch update reconstruction fails to content:null when the target file EXISTS but cannot be read", () => {
    // Distinct from "does not exist at all": a dedicated pathExistsRepoRoot
    // says the header's target is genuinely there (a permission failure, in
    // the real dispatcher's own case), so the header-existence invariant does
    // not fire — only the content reconstruction itself fails, exactly as
    // before this invariant existed.
    const patch = ["*** Begin Patch", "*** Update File: src/gone.ts", " x", "-a", "+b", "*** End Patch"].join("\n");
    const writes = decodeWrites(
      "apply_patch",
      { input: patch },
      { readFile: fakeReader({}), pathExistsRepoRoot: () => true },
    );
    deepEq(writes, [{ path: "src/gone.ts", content: null, kind: "update", pathBase: "repoRoot" }]);
  });

  test("apply_patch decodes a {changes: {...}} object-keyed envelope", () => {
    const writes = decodeWrites(
      "apply_patch",
      {
        changes: {
          "src/New2.ts": { type: "add", content: "export const y = 2;" },
          "src/Old2.ts": { type: "delete" },
        },
      },
      { readFile: fakeReader({}) },
    );
    deepEq(writes, [
      { path: "src/New2.ts", content: "export const y = 2;", kind: "add", pathBase: "repoRoot" },
      { path: "src/Old2.ts", content: null, kind: "delete", pathBase: "repoRoot" },
    ]);
  });

  test("apply_patch decodes a {changes: [...]} array-of-entries envelope", () => {
    const writes = decodeWrites(
      "apply_patch",
      { changes: [{ path: "src/New3.ts", action: "add", content: "export const z = 3;" }] },
      { readFile: fakeReader({}) },
    );
    deepEq(writes, [{ path: "src/New3.ts", content: "export const z = 3;", kind: "add", pathBase: "repoRoot" }]);
  });

  test("apply_patch with a genuinely unrecognised payload shape decodes nothing", () => {
    deepEq(decodeWrites("apply_patch", { weird: "shape", nothing: "recognised" }, { readFile: fakeReader({}) }), []);
  });

  /* ------------------------------------------------------- D4: diff-only entries */

  test("a changes[] entry naming a path but no content still yields that path, content:null, not a silent drop", () => {
    const writes = decodeWrites(
      "apply_patch",
      { changes: [{ path: "src/DiffOnlyProbe.ts", type: "update" }] },
      { readFile: fakeReader({ "src/DiffOnlyProbe.ts": "old" }) },
    );
    deepEq(writes, [{ path: "src/DiffOnlyProbe.ts", content: null, kind: "update", pathBase: "repoRoot" }]);
  });

  test("a changes[] entry naming no path at all voids the whole call rather than silently dropping just that entry", () => {
    const writes = decodeWrites(
      "apply_patch",
      {
        changes: [
          { path: "src/WithPathProbe.ts", type: "add", content: "export const withPath = 1;" },
          { type: "update" },
        ],
      },
      { readFile: fakeReader({}) },
    );
    deepEq(writes, []);
  });

  /* ------------------------------------------------------------------- D5: rename */

  test("a patch section carrying a *** Move to: destination yields a delete of the old path and an add of the new one", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/OldNameProbe.ts",
      "*** Move to: src/NewNameProbe.ts",
      " constructor() {",
      "-old init",
      "+new init",
      " }",
      "*** End Patch",
    ].join("\n");
    const writes = decodeWrites(
      "apply_patch",
      { input: patch },
      { readFile: fakeReader({ "src/OldNameProbe.ts": "constructor() {\nold init\n}\n" }) },
    );
    deepEq(writes, [
      { path: "src/OldNameProbe.ts", content: null, kind: "delete", pathBase: "repoRoot" },
      { path: "src/NewNameProbe.ts", content: "constructor() {\nnew init\n}\n", kind: "add", pathBase: "repoRoot" },
    ]);
  });

  test("a pure rename with no hunks still yields the destination carrying the old file's unchanged content", () => {
    const patch = ["*** Begin Patch", "*** Update File: src/OldPureProbe.ts", "*** Move to: src/NewPureProbe.ts", "*** End Patch"].join(
      "\n",
    );
    const writes = decodeWrites(
      "apply_patch",
      { input: patch },
      { readFile: fakeReader({ "src/OldPureProbe.ts": "unchanged content\n" }) },
    );
    deepEq(writes, [
      { path: "src/OldPureProbe.ts", content: null, kind: "delete", pathBase: "repoRoot" },
      { path: "src/NewPureProbe.ts", content: "unchanged content\n", kind: "add", pathBase: "repoRoot" },
    ]);
  });

  /* ---------------------------------------------------------------- R2: readFileRepoRoot */

  test("R2: a patch-header path reconstructs through readFileRepoRoot, not the cwd-anchored readFile, when the two disagree", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/Widget.ts",
      " constructor() {",
      "-old init",
      "+new init",
      " }",
      "*** End Patch",
    ].join("\n");
    const writes = decodeWrites(
      "apply_patch",
      { input: patch },
      {
        // The cwd-anchored reader sees a same-named file with UNRELATED
        // content — reading through this one would either fail to find the
        // hunk's context at all, or (worse) reconstruct from the wrong
        // file's text.
        readFile: fakeReader({ "src/Widget.ts": "totally unrelated content\n" }),
        // The repo-root-anchored reader sees the real target.
        readFileRepoRoot: fakeReader({ "src/Widget.ts": "constructor() {\nold init\n}\n" }),
      },
    );
    deepEq(writes, [
      { path: "src/Widget.ts", content: "constructor() {\nnew init\n}\n", kind: "update", pathBase: "repoRoot" },
    ]);
  });

  test("R2: omitting readFileRepoRoot falls back to readFile, so every pre-existing single-reader caller keeps working unchanged", () => {
    const patch = ["*** Begin Patch", "*** Update File: src/Widget.ts", " x", "-a", "+b", "*** End Patch"].join("\n");
    const writes = decodeWrites(
      "apply_patch",
      { input: patch },
      { readFile: fakeReader({ "src/Widget.ts": "x\na\n" }) },
    );
    deepEq(writes, [{ path: "src/Widget.ts", content: "x\nb\n", kind: "update", pathBase: "repoRoot" }]);
  });

  /* ---------------------------------------------- narrowed unprefixed-line tolerance */

  test("a blank unprefixed line is still tolerated as context, reconstructing correctly", () => {
    const existing = "function f() {\n\n  return 1;\n}\n";
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/Blank.ts",
      " function f() {",
      "",
      "-  return 1;",
      "+  return 2;",
      " }",
      "*** End Patch",
    ].join("\n");
    const writes = decodeWrites("apply_patch", { input: patch }, { readFile: fakeReader({ "src/Blank.ts": existing }) });
    deepEq(writes, [
      { path: "src/Blank.ts", content: "function f() {\n\n  return 2;\n}\n", kind: "update", pathBase: "repoRoot" },
    ]);
  });

  test("a non-empty unprefixed line that is not header-shaped makes the whole patch ambiguous, not a tolerated context line", () => {
    const existing = "function f() {\nnote\n  return 1;\n}\n";
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/Stray.ts",
      " function f() {",
      "note",
      "-  return 1;",
      "+  return 2;",
      " }",
      "*** End Patch",
    ].join("\n");
    const writes = decodeWrites("apply_patch", { input: patch }, { readFile: fakeReader({ "src/Stray.ts": existing }) });
    deepEq(writes, []);
  });

  /* -------------------------------------------------------- C2: End of File */

  test("C2: a *** End of File marker after a hunk's last line is tolerated, not ambiguous — real V4A grammar, not attacker content", () => {
    const existing = "line one\nline two\nline three\n";
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/Eof.ts",
      "@@",
      " line one",
      " line two",
      "-line three",
      "+line three, edited",
      "*** End of File",
      "*** End Patch",
    ].join("\n");
    const writes = decodeWrites(
      "apply_patch",
      { input: patch },
      {
        readFile: fakeReader({}),
        pathExistsRepoRoot: (p) => p === "src/Eof.ts",
        readFileRepoRoot: fakeReader({ "src/Eof.ts": existing }),
      },
    );
    deepEq(writes, [
      { path: "src/Eof.ts", content: "line one\nline two\nline three, edited\n", kind: "update", pathBase: "repoRoot" },
    ]);
  });

  test("C2: an unrecognised *** -prefixed marker still makes the whole patch ambiguous — the tolerance is a real allowlist, not a blanket '*** ' pass", () => {
    const existing = "line one\nline two\n";
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/Unknown.ts",
      "@@",
      " line one",
      "*** Some Future Marker",
      "-line two",
      "+line two, edited",
      "*** End Patch",
    ].join("\n");
    const writes = decodeWrites(
      "apply_patch",
      { input: patch },
      {
        readFile: fakeReader({}),
        pathExistsRepoRoot: (p) => p === "src/Unknown.ts",
        readFileRepoRoot: fakeReader({ "src/Unknown.ts": existing }),
      },
    );
    deepEq(writes, []);
  });

  test("C2: the known patch grammar marker set is pinned — a change here must be deliberate, not an accidental gap", () => {
    // Verified directly against the real Codex binary (see this file's own
    // top-of-file doc comment). A future host version growing a new marker
    // must update this array (and the tolerance logic that reads it) in one
    // place — this test is what makes silently missing that update loud
    // instead of quietly voiding envelopes that carry the new marker.
    deepEq(KNOWN_PATCH_MARKERS, [
      "*** Begin Patch",
      "*** End Patch",
      "*** Add File:",
      "*** Update File:",
      "*** Delete File:",
      "*** Move to:",
      "*** End of File",
    ]);
  });

  /* --------------------------------------------------- header-existence invariant */

  test("an Update File header naming a path that exists reconstructs normally", () => {
    const patch = ["*** Begin Patch", "*** Update File: src/Real.ts", " x", "-a", "+b", "*** End Patch"].join("\n");
    const writes = decodeWrites(
      "apply_patch",
      { input: patch },
      { readFile: fakeReader({}), pathExistsRepoRoot: (p) => p === "src/Real.ts", readFileRepoRoot: fakeReader({ "src/Real.ts": "x\na\n" }) },
    );
    deepEq(writes, [{ path: "src/Real.ts", content: "x\nb\n", kind: "update", pathBase: "repoRoot" }]);
  });

  test("an Update File header naming a path that does not exist escalates the whole call to ambiguous", () => {
    const patch = ["*** Begin Patch", "*** Update File: src/Phantom.ts", " x", "-a", "+b", "*** End Patch"].join("\n");
    const writes = decodeWrites(
      "apply_patch",
      { input: patch },
      { readFile: fakeReader({}), pathExistsRepoRoot: () => false },
    );
    deepEq(writes, []);
  });

  test("a Delete File header naming a path that does not exist escalates the whole call to ambiguous", () => {
    const patch = ["*** Begin Patch", "*** Delete File: src/Phantom.ts", "*** End Patch"].join("\n");
    const writes = decodeWrites(
      "apply_patch",
      { input: patch },
      { readFile: fakeReader({}), pathExistsRepoRoot: () => false },
    );
    deepEq(writes, []);
  });

  test("an Update File header outside this dispatcher's reach is decoded, not called ambiguous", () => {
    // The everyday case: an agent whose cwd sits outside any repository
    // writes to its memory directory. `pathExistsRepoRoot` answers false for
    // every path outside its boundary whatever is actually on disk, so
    // without the reach precondition this legitimate write was declared
    // undecidable and checked against no rule at all.
    const memoryFile = "C:/Users/dev/.codex/memory/ACTIVE-WORK.md";
    const patch = ["*** Begin Patch", `*** Update File: ${memoryFile}`, "@@", "+a new line", "*** End Patch"].join("\n");
    const { writes, ambiguous } = decodeWritesDetailed(
      "apply_patch",
      { input: patch },
      { readFile: fakeReader({}), pathExistsRepoRoot: () => false, withinReachRepoRoot: () => false },
    );
    eq(ambiguous, false, "out of reach is not the same as demonstrably absent");
    eq(writes.length, 1);
    eq(writes[0].path, memoryFile);
    eq(writes[0].kind, "update");
    // Unreadable from here, so there is no resulting content to judge — the
    // path-only entry every path rule still sees, exactly as this module's
    // own header comment describes for any other unreconstructable write.
    eq(writes[0].content, null);
  });

  test("a path that IS in reach and genuinely absent still escalates to ambiguous", () => {
    // The precondition softens nothing inside the boundary: the phantom-header
    // invariant this check exists for is untouched.
    const patch = ["*** Begin Patch", "*** Update File: src/Phantom.ts", " x", "-a", "+b", "*** End Patch"].join("\n");
    const { writes, ambiguous } = decodeWritesDetailed(
      "apply_patch",
      { input: patch },
      { readFile: fakeReader({}), pathExistsRepoRoot: () => false, withinReachRepoRoot: () => true },
    );
    eq(ambiguous, true);
    deepEq(writes, []);
  });

  test("an Add File header is exempt from the existence check — a brand-new file legitimately need not exist yet", () => {
    const patch = ["*** Begin Patch", "*** Add File: src/Brand.ts", "+export const a = 1;", "*** End Patch"].join("\n");
    const writes = decodeWrites(
      "apply_patch",
      { input: patch },
      { readFile: fakeReader({}), pathExistsRepoRoot: () => false },
    );
    deepEq(writes, [{ path: "src/Brand.ts", content: "export const a = 1;", kind: "add", pathBase: "repoRoot" }]);
  });

  /* -------------------------------------------------- gap review: header path shape */

  test("gap review: a trailing space after a header path is trimmed before existence-checking and reading", () => {
    const patch = ["*** Begin Patch", "*** Update File: src/Real.ts ", " x", "-a", "+b", "*** End Patch"].join("\n");
    const writes = decodeWrites(
      "apply_patch",
      { input: patch },
      { readFile: fakeReader({}), pathExistsRepoRoot: (p) => p === "src/Real.ts", readFileRepoRoot: fakeReader({ "src/Real.ts": "x\na\n" }) },
    );
    deepEq(writes, [{ path: "src/Real.ts", content: "x\nb\n", kind: "update", pathBase: "repoRoot" }]);
  });

  test("gap review: a mixed backslash/forward-slash header path is passed through unchanged to pathExists/readFile as written", () => {
    // Verified fine at the E2E level (Windows path.resolve/path.relative
    // already treat both separators equivalently, and every downstream rule
    // that globs against the path normalises backslashes first) — this pins
    // that this module itself does not mangle or reject the mixed spelling,
    // leaving normalisation entirely to the caller, exactly as it already
    // does for a forward-slash-only path.
    const patch = ["*** Begin Patch", "*** Update File: src\\types/Real.ts", " x", "-a", "+b", "*** End Patch"].join("\n");
    const writes = decodeWrites(
      "apply_patch",
      { input: patch },
      {
        readFile: fakeReader({}),
        pathExistsRepoRoot: (p) => p === "src\\types/Real.ts",
        readFileRepoRoot: fakeReader({ "src\\types/Real.ts": "x\na\n" }),
      },
    );
    deepEq(writes, [{ path: "src\\types/Real.ts", content: "x\nb\n", kind: "update", pathBase: "repoRoot" }]);
  });

  /* -------------------------------------------------------------- other tools */

  test("a non-write tool name decodes nothing", () => {
    deepEq(decodeWrites("Bash", { command: "echo hi" }, { readFile: fakeReader({}) }), []);
  });

  test("decodeWrites never throws on a malformed input object", () => {
    let threw = false;
    try {
      decodeWrites("apply_patch", null, {});
      decodeWrites("MultiEdit", { file_path: "a", edits: "not an array" }, {});
      decodeWrites("Edit", undefined, undefined);
    } catch {
      threw = true;
    }
    eq(threw, false);
  });
});
