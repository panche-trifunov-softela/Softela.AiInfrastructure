"use strict";

const { suite } = require("../harness");
const { decide, makeCtx, PROJECT_MINIMAL, PROJECT_BACKEND } = require("./_ctx");
const rule = require("../../core/guards/patch-manifest");
const { evaluateDecodedWrites } = require("../../adapters/shared/dispatch-core");

/** A patch-manifest project fixture, shared by most cases in this suite. */
const patchManifest = {
  filePattern: "patch\\.manifest\\.xml$",
  databasePattern: "<Database\\b[^>]*>",
  requiredEntry: "UpgradeScript",
};

suite("guards/patch-manifest", ({ test, eq, ok }) => {
  /* -------------------------------------------------------------- positive */

  test("denies a declared database change with no upgrade-script entry", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "deploy/patch.manifest.xml",
        content: "<Manifest>\n  <Database table=\"Orders\">\n    <Comment>adds a column</Comment>\n  </Database>\n</Manifest>",
        project: { patchManifest, stack: "backend" },
      }),
      "deny",
    );
  });

  test("denies when only one of two declared changes has its entry", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "deploy/patch.manifest.xml",
        content:
          "<Manifest>\n" +
          "  <Database table=\"Orders\">\n    <UpgradeScript>001_orders.sql</UpgradeScript>\n  </Database>\n" +
          "  <Database table=\"Invoices\">\n    <Comment>no script yet</Comment>\n  </Database>\n" +
          "</Manifest>",
        project: { patchManifest, stack: "backend" },
      }),
      "deny",
    );
  });

  /* -------------------------------------------------------------- evasion */

  test("still denies through the Codex apply_patch tool name", () => {
    eq(
      decide(rule, {
        toolName: "apply_patch",
        filePath: "deploy/patch.manifest.xml",
        content: "<Database table=\"Orders\">\n  <Comment>no script</Comment>\n</Database>",
        project: { patchManifest, stack: "backend" },
      }),
      "deny",
    );
  });

  test("still denies when the missing entry is spread across unusual whitespace and extra attributes", () => {
    eq(
      decide(rule, {
        toolName: "Edit",
        filePath: "deploy/patch.manifest.xml",
        content: "<Database\n  table=\"Orders\"\n  owner=\"billing\"\n>\n\n\n  <Comment>still nothing here</Comment>\n</Database>",
        project: { patchManifest, stack: "backend" },
      }),
      "deny",
    );
  });

  test("still denies when the required entry name is only mentioned in prose, not as an element", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "deploy/patch.manifest.xml",
        content: "<Manifest>\n  <Database table=\"Widgets\">\n    <Comment>reversible change, no UpgradeScript needed here</Comment>\n  </Database>\n</Manifest>",
        project: { patchManifest, stack: "backend" },
      }),
      "deny",
    );
  });

  test("still denies when the required entry name only appears as an attribute value", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "deploy/patch.manifest.xml",
        content: '<Database table="Orders"><Comment kind="UpgradeScript">no script</Comment></Database>',
        project: { patchManifest, stack: "backend" },
      }),
      "deny",
    );
  });

  test("still denies when the required entry only appears in the following, unrelated declaration", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "deploy/patch.manifest.xml",
        content:
          "<Database table=\"Orders\"><Comment>no script</Comment></Database>" +
          "<Database table=\"Invoices\"><UpgradeScript>002_invoices.sql</UpgradeScript></Database>",
        project: { patchManifest, stack: "backend" },
      }),
      "deny",
    );
  });

  /* ------------------------------------------------------------------ R3 */

  test("R3: a MultiEdit's own inserted text alone looks complete, but the true resulting manifest still has an unpaired declaration", () => {
    eq(
      decide(rule, {
        toolName: "MultiEdit",
        filePath: "deploy/patch.manifest.xml",
        // The write's own inserted text is a fully-paired declaration —
        // would wrongly pass if judged on its own, ignoring the rest of the
        // manifest this MultiEdit did not touch.
        content: "<Database table=\"Invoices\">\n  <UpgradeScript>002_invoices.sql</UpgradeScript>\n</Database>",
        // The true resulting manifest still carries an earlier declaration
        // with no entry.
        resultingContent:
          "<Manifest>\n" +
          "  <Database table=\"Orders\">\n    <Comment>adds a column</Comment>\n  </Database>\n" +
          "  <Database table=\"Invoices\">\n    <UpgradeScript>002_invoices.sql</UpgradeScript>\n  </Database>\n" +
          "</Manifest>",
        project: { patchManifest, stack: "backend" },
      }),
      "deny",
    );
  });

  test("R3: a MultiEdit's own inserted text alone looks unpaired, but the true resulting manifest already has the entry", () => {
    eq(
      decide(rule, {
        toolName: "MultiEdit",
        filePath: "deploy/patch.manifest.xml",
        // On its own this looks like a violation — would wrongly deny if
        // judged without the rest of the manifest.
        content: "<Database table=\"Orders\">\n  <Comment>adds a column</Comment>\n</Database>",
        // The true resulting manifest (after every edit in this MultiEdit
        // is applied) pairs the declaration with its entry.
        resultingContent:
          "<Manifest>\n" +
          "  <Database table=\"Orders\">\n    <Comment>adds a column</Comment>\n    <UpgradeScript>001_orders.sql</UpgradeScript>\n  </Database>\n" +
          "</Manifest>",
        project: { patchManifest, stack: "backend" },
      }),
      "pass",
    );
  });

  /* ------------------------------------------------- changed-region ratchet */
  //
  // The four cases below are named after the four historical ratchet designs
  // this rule went through before landing on a changed-region primitive (see
  // this rule's own top-of-file doc comment, "THE RATCHET"): each one is the
  // exact shape of write that broke its predecessor, still run through the
  // real dispatcher and the real rule.

  test("F1 (aggregate count): repairing one pre-existing unpaired declaration while breaking a different, unrelated one nets flat under a count-only ratchet, but still denies", () => {
    // Real code path: `evaluateDecodedWrites` decodes the write and hands the
    // real `patch-manifest` rule the real reconstructed `resultingContent`,
    // exactly as the production dispatcher would for a plain `Write` call.
    const filePath = "deploy/patch.manifest.xml";
    const onDisk =
      "<Manifest>\n" +
      '  <Database table="Orders" />\n' +
      "  <Comment>needs script</Comment>\n" +
      '  <Database table="Invoices" />\n' +
      "  <UpgradeScript>001_invoices.sql</UpgradeScript>\n" +
      "</Manifest>\n";
    // Repairs Orders (adds its entry) AND, in the same write, removes
    // Invoices' entry — a DIFFERENT declaration goes from paired to
    // unpaired. The total unpaired count is unchanged (1 before, 1 after),
    // so a bare aggregate-count ratchet sees nothing new and would wrongly
    // pass; Invoices losing its entry is a real, distinct violation this
    // write itself introduced.
    const written =
      "<Manifest>\n" +
      '  <Database table="Orders" />\n' +
      "  <UpgradeScript>002_orders.sql</UpgradeScript>\n" +
      '  <Database table="Invoices" />\n' +
      "  <Comment>script removed, still deploying anyway</Comment>\n" +
      "</Manifest>\n";

    const ctx = makeCtx({
      toolName: "Write",
      filePath,
      input: { file_path: filePath, content: written },
      project: PROJECT_BACKEND,
      files: { [filePath]: onDisk },
    });

    const result = evaluateDecodedWrites(ctx, { rules: [rule] });
    eq(result.decision && result.decision.action, "deny");
  });

  test("F2 (Set-of-identity ratchet): a second declaration sharing an already-unpaired declaration's identical opening-tag text still denies", () => {
    const filePath = "deploy/patch.manifest.xml";
    const onDisk =
      "<Manifest>\n" +
      '  <Database table="Orders" />\n' +
      "  <Comment>column added last quarter, nobody's business today</Comment>\n" +
      "</Manifest>\n";
    // Adds a SECOND, unrelated change block against the same table, with the
    // identical bare opening tag `databasePattern` (a bare literal, no
    // capturing group — the real config shape) gives every declaration. A
    // `Set`-of-identity ratchet collapses both occurrences to one entry and
    // would wrongly see no change.
    const written =
      "<Manifest>\n" +
      '  <Database table="Orders" />\n' +
      "  <Comment>column added last quarter, nobody's business today</Comment>\n" +
      '  <Database table="Orders" />\n' +
      "  <Comment>today's completely separate migration against the same table</Comment>\n" +
      "</Manifest>\n";

    const ctx = makeCtx({
      toolName: "Write",
      filePath,
      input: { file_path: filePath, content: written },
      project: PROJECT_BACKEND,
      files: { [filePath]: onDisk },
    });

    const result = evaluateDecodedWrites(ctx, { rules: [rule] });
    eq(result.decision && result.decision.action, "deny");
  });

  test("F3 (multiset ratchet): repairing one pre-existing unpaired declaration while adding a different, brand-new unpaired declaration with the identical opening tag still denies", () => {
    const filePath = "deploy/patch.manifest.xml";
    const onDisk =
      "<Manifest>\n" +
      '  <Database table="Orders" />\n' +
      "  <UpgradeScript>001_orders.sql</UpgradeScript>\n" +
      '  <Database table="Orders" />\n' +
      "  <Comment>second Orders change, no script yet</Comment>\n" +
      "</Manifest>\n";
    // This write does two things at once: it repairs the pre-existing
    // second (unpaired) declaration by adding its UpgradeScript entry, AND
    // it appends a THIRD `<Database table="Orders" />` declaration — a
    // genuinely new database change — with no entry at all. A per-identity
    // multiset ratchet sees this identity's unpaired count unchanged (1
    // before, 1 after) and would wrongly pass; the third declaration is a
    // real, distinct violation the repair must not hide.
    const written =
      "<Manifest>\n" +
      '  <Database table="Orders" />\n' +
      "  <UpgradeScript>001_orders.sql</UpgradeScript>\n" +
      '  <Database table="Orders" />\n' +
      "  <UpgradeScript>002_orders.sql</UpgradeScript>\n" +
      '  <Database table="Orders" />\n' +
      "  <Comment>third Orders change, no script at all</Comment>\n" +
      "</Manifest>\n";

    const ctx = makeCtx({
      toolName: "Write",
      filePath,
      input: { file_path: filePath, content: written },
      project: PROJECT_BACKEND,
      files: { [filePath]: onDisk },
    });

    const result = evaluateDecodedWrites(ctx, { rules: [rule] });
    eq(result.decision && result.decision.action, "deny");
  });

  test("F4 (paired/unpaired-delta ratchet): a compliant new declaration sharing an opening-tag identity with a pre-existing, untouched, already-unpaired one passes instead of false-denying", () => {
    const filePath = "deploy/patch.manifest.xml";
    const onDisk =
      "<Manifest>\n" +
      '  <Database table="Orders" />\n' +
      "  <Comment>needs script, forever apparently</Comment>\n" +
      "</Manifest>\n";
    // Appends a SECOND, fully-paired `<Database table="Orders" />`
    // declaration — same opening-tag identity as the pre-existing unpaired
    // one, but this occurrence carries its own entry and the first one is
    // never touched. A paired/unpaired-delta ratchet misreads the identity's
    // rising paired count as "repairing" the old occurrence, spends the old
    // occurrence's own forgiveness budget on a repair that never happened to
    // IT, and false-denies a write that introduced nothing wrong.
    const written =
      "<Manifest>\n" +
      '  <Database table="Orders" />\n' +
      "  <Comment>needs script, forever apparently</Comment>\n" +
      '  <Database table="Orders" />\n' +
      "  <UpgradeScript>002_orders.sql</UpgradeScript>\n" +
      "</Manifest>\n";

    const ctx = makeCtx({
      toolName: "Write",
      filePath,
      input: { file_path: filePath, content: written },
      project: PROJECT_BACKEND,
      files: { [filePath]: onDisk },
    });

    const result = evaluateDecodedWrites(ctx, { rules: [rule] });
    eq(result.decision, null);
  });

  test("F6 (alignment-blind trim): an inserted unpaired declaration whose opening-tag line is byte-identical to the line already at that index still denies", () => {
    // The severe case a reviewer found in the prefix/suffix trim this
    // module used to compute the changed region with: a NEW, unpaired
    // `<Database table="Orders" />` is inserted directly BEFORE an existing,
    // already-paired declaration with byte-identical opening-tag text (the
    // same table name recurring — the ordinary shape, not an exotic one). A
    // positional trim marches straight through the new line (it matches
    // whatever already sat at that index) and only stops at the first REAL
    // difference further down, so the new declaration's own start falls
    // before the region and is never judged. A real LCS-based diff must
    // still catch it.
    const filePath = "deploy/patch.manifest.xml";
    const onDisk =
      "<Manifest>\n" +
      '  <Database table="Orders" />\n' +
      "  <UpgradeScript>001_orders.sql</UpgradeScript>\n" +
      '  <Database table="Invoices" />\n' +
      "  <UpgradeScript>001_invoices.sql</UpgradeScript>\n" +
      "</Manifest>\n";
    const written =
      "<Manifest>\n" +
      '  <Database table="Orders" />\n' + // newly inserted, unpaired
      '  <Database table="Orders" />\n' + // pre-existing, paired — identical text to the line above
      "  <UpgradeScript>001_orders.sql</UpgradeScript>\n" +
      '  <Database table="Invoices" />\n' +
      "  <UpgradeScript>001_invoices.sql</UpgradeScript>\n" +
      "</Manifest>\n";

    const ctx = makeCtx({
      toolName: "Write",
      filePath,
      input: { file_path: filePath, content: written },
      project: PROJECT_BACKEND,
      files: { [filePath]: onDisk },
    });

    const result = evaluateDecodedWrites(ctx, { rules: [rule] });
    eq(result.decision && result.decision.action, "deny");
  });

  test("F7 (multi-line tag): an edit to only a later line of a multi-line opening tag still denies", () => {
    // The opening tag's own FIRST line ("<Database") is untouched — only a
    // later attribute line inside the same tag changes, alongside the
    // pairing content that follows it. A region test keyed to only a
    // declaration's own start offset would find that first line sitting
    // before the changed region and forgive the whole declaration; testing
    // the tag's own full line range for overlap must catch it instead.
    const filePath = "deploy/patch.manifest.xml";
    const onDisk =
      "<Manifest>\n" +
      "  <Database\n" +
      '    table="Orders"\n' +
      '    owner="billing"\n' +
      "  >\n" +
      "    <UpgradeScript>001_orders.sql</UpgradeScript>\n" +
      "  </Database>\n" +
      "</Manifest>\n";
    const written =
      "<Manifest>\n" +
      "  <Database\n" +
      '    table="Orders"\n' +
      '    owner="finance"\n' + // only this attribute line, still inside the tag, changed
      "  >\n" +
      "    <Comment>owner reassigned, script dropped</Comment>\n" +
      "  </Database>\n" +
      "</Manifest>\n";

    const ctx = makeCtx({
      toolName: "Write",
      filePath,
      input: { file_path: filePath, content: written },
      project: { ...PROJECT_BACKEND, patchManifest },
      files: { [filePath]: onDisk },
    });

    const result = evaluateDecodedWrites(ctx, { rules: [rule] });
    eq(result.decision && result.decision.action, "deny");
  });

  test("F8 (line-count ceiling): a baseline past the diff's own line-count ceiling still denies, judging the whole file", () => {
    // On disk exceeds the rule's own LINE_COUNT_CEILING (2000 lines), so the
    // real LCS diff is skipped in favor of the same whole-content fallback
    // "no on-disk baseline" uses — driven right at the boundary (2001 lines,
    // one past the ceiling) rather than at an unrealistically large size.
    const filePath = "deploy/patch.manifest.xml";
    const fillerLines = [];
    for (let i = 0; i < 2001; i++) fillerLines.push(`<Comment>filler ${i}</Comment>`);
    const onDisk = fillerLines.join("\n") + "\n";
    const written = "<Manifest>\n" + '  <Database table="Orders" />\n' + "  <Comment>no script at all</Comment>\n" + "</Manifest>\n";

    const ctx = makeCtx({
      toolName: "Write",
      filePath,
      input: { file_path: filePath, content: written },
      project: PROJECT_BACKEND,
      files: { [filePath]: onDisk },
    });

    const result = evaluateDecodedWrites(ctx, { rules: [rule] });
    eq(result.decision && result.decision.action, "deny");
    ok(
      /whole content was judged/i.test(result.decision.reason) && /line-count ceiling/i.test(result.decision.reason),
      "reason should explain that the whole file was judged for exceeding the diff's own line-count ceiling",
    );
  });

  test("repairing a pre-existing unpaired declaration with no other change still passes — the ordinary fix", () => {
    const filePath = "deploy/patch.manifest.xml";
    const onDisk =
      "<Manifest>\n" +
      '  <Database table="Orders" />\n' +
      "  <UpgradeScript>001_orders.sql</UpgradeScript>\n" +
      '  <Database table="Orders" />\n' +
      "  <Comment>second Orders change, no script yet</Comment>\n" +
      "</Manifest>\n";
    const written =
      "<Manifest>\n" +
      '  <Database table="Orders" />\n' +
      "  <UpgradeScript>001_orders.sql</UpgradeScript>\n" +
      '  <Database table="Orders" />\n' +
      "  <UpgradeScript>002_orders.sql</UpgradeScript>\n" +
      "</Manifest>\n";

    const ctx = makeCtx({
      toolName: "Write",
      filePath,
      input: { file_path: filePath, content: written },
      project: PROJECT_BACKEND,
      files: { [filePath]: onDisk },
    });

    const result = evaluateDecodedWrites(ctx, { rules: [rule] });
    eq(result.decision, null);
  });

  test("an unrelated edit elsewhere in the manifest leaves a pre-existing unpaired declaration outside the changed region, still forgiven", () => {
    const filePath = "deploy/patch.manifest.xml";
    const onDisk =
      "<Manifest>\n" +
      '  <Database table="Orders" />\n' +
      "  <Comment>needs script, forever apparently</Comment>\n" +
      "  <Note>legacy content</Note>\n" +
      "</Manifest>\n";
    // The only change is to the unrelated <Note> element, nowhere near the
    // Orders declaration or its comment — those lines are byte-for-byte
    // identical before and after, so they fall outside the changed region.
    const written =
      "<Manifest>\n" +
      '  <Database table="Orders" />\n' +
      "  <Comment>needs script, forever apparently</Comment>\n" +
      "  <Note>legacy content, annotated for clarity</Note>\n" +
      "</Manifest>\n";

    const ctx = makeCtx({
      toolName: "Write",
      filePath,
      input: { file_path: filePath, content: written },
      project: PROJECT_BACKEND,
      files: { [filePath]: onDisk },
    });

    const result = evaluateDecodedWrites(ctx, { rules: [rule] });
    eq(result.decision, null);
  });

  test("relabelling an already-unpaired declaration's own attribute still denies, since that line itself sits inside the changed region", () => {
    const filePath = "deploy/patch.manifest.xml";
    const onDisk = '<Manifest>\n  <Database id="Legacy1" />\n</Manifest>\n';
    // Same single unpaired declaration, id attribute relabelled — the line
    // itself differs from what is on disk, so it begins inside the changed
    // region regardless of why it changed.
    const written = '<Manifest>\n  <Database id="Legacy1Renamed" />\n</Manifest>\n';

    const ctx = makeCtx({
      toolName: "Write",
      filePath,
      input: { file_path: filePath, content: written },
      project: PROJECT_BACKEND,
      files: { [filePath]: onDisk },
    });

    const result = evaluateDecodedWrites(ctx, { rules: [rule] });
    eq(result.decision && result.decision.action, "deny");
  });

  test("an unreadable on-disk baseline judges the whole file, and the denial reason says so", () => {
    const filePath = "deploy/patch.manifest.xml";
    // No `files` entry for this path at all — `ctx.readFile` returns `null`,
    // the same result it gives both for a brand-new file and for one that
    // exists but could not be opened; this rule cannot tell the two apart
    // and must judge the whole content either way (see this rule's own
    // top-of-file doc comment, "EDGE — no on-disk baseline").
    const written =
      "<Manifest>\n" +
      '  <Database table="Orders" />\n' +
      "  <Comment>no script, and nothing to diff against</Comment>\n" +
      "</Manifest>\n";

    const ctx = makeCtx({
      toolName: "Write",
      filePath,
      input: { file_path: filePath, content: written },
      project: PROJECT_BACKEND,
      files: {},
    });

    const result = evaluateDecodedWrites(ctx, { rules: [rule] });
    eq(result.decision && result.decision.action, "deny");
    ok(
      /whole content was judged/i.test(result.decision.reason),
      "reason should explain that the whole file was judged for lack of an on-disk baseline",
    );
  });

  /* -------------------------------------------------------------- negative */

  test("passes when every declared change has its upgrade-script entry", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "deploy/patch.manifest.xml",
        content: "<Manifest>\n  <Database table=\"Orders\">\n    <UpgradeScript>001_orders.sql</UpgradeScript>\n  </Database>\n</Manifest>",
        project: { patchManifest, stack: "backend" },
      }),
      "pass",
    );
  });

  test("passes when the upgrade-script element itself carries extra attributes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "deploy/patch.manifest.xml",
        content: '<Database table="Orders"><UpgradeScript file="001_orders.sql" owner="billing">001_orders.sql</UpgradeScript></Database>',
        project: { patchManifest, stack: "backend" },
      }),
      "pass",
    );
  });

  test("passes a file that does not match the manifest filename pattern", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "deploy/readme.md",
        content: "<Database table=\"Orders\"><Comment>no script</Comment></Database>",
        project: { patchManifest, stack: "backend" },
      }),
      "pass",
    );
  });

  test("passes a matching manifest with no declared database change", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "deploy/patch.manifest.xml",
        content: "<Manifest>\n  <Note>nothing to deploy yet</Note>\n</Manifest>",
        project: { patchManifest, stack: "backend" },
      }),
      "pass",
    );
  });

  test("passes an ordinary frontend component write", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/Widget.tsx",
        content: "export function Widget() { return null; }",
        project: { patchManifest, stack: "backend" },
      }),
      "pass",
    );
  });

  test("passes empty content on a matching filename", () => {
    eq(
      decide(rule, {
        toolName: "Edit",
        filePath: "deploy/patch.manifest.xml",
        content: "  \n",
        project: { patchManifest, stack: "backend" },
      }),
      "pass",
    );
  });

  test("passes a Bash command that merely mentions the manifest path", () => {
    eq(decide(rule, { toolName: "Bash", command: "cat deploy/patch.manifest.xml" }), "pass");
  });

  test("passes when the project has not configured patchManifest at all", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "deploy/patch.manifest.xml",
        content: "<Database table=\"Orders\"><Comment>no script</Comment></Database>",
      }),
      "pass",
    );
  });

  test("passes when the config is missing the required-entry name", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "deploy/patch.manifest.xml",
        content: "<Database table=\"Orders\"><Comment>no script</Comment></Database>",
        project: {
          patchManifest: { filePattern: patchManifest.filePattern, databasePattern: patchManifest.databasePattern },
          stack: "backend",
        },
      }),
      "pass",
    );
  });

  test("passes when the configured file pattern fails to compile", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "deploy/patch.manifest.xml",
        content: "<Database table=\"Orders\"><Comment>no script</Comment></Database>",
        project: { patchManifest: { ...patchManifest, filePattern: "(" }, stack: "backend" },
      }),
      "pass",
    );
  });

  /* --------------------------------------------------------------- stacks */

  test("stays silent on the frontend stack even with a fully configured patchManifest", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "deploy/patch.manifest.xml",
        content: "<Database table=\"Orders\"><Comment>no script</Comment></Database>",
        project: { patchManifest, stack: "frontend" },
      }),
      "pass",
    );
  });

  test("fires on a monorepo path resolved to the backend stack", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/Server/deploy/patch.manifest.xml",
        content: "<Database table=\"Orders\"><Comment>no script</Comment></Database>",
        project: {
          patchManifest,
          stacks: [{ paths: ["src/Server/**"], stack: "backend" }],
        },
      }),
      "deny",
    );
  });

  /* ------------------------------------------------------------ overrides */

  test("an override softens the deny to ask", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "deploy/patch.manifest.xml",
        content: "<Database table=\"Orders\"><Comment>no script</Comment></Database>",
        project: { patchManifest, stack: "backend" },
        overrideSpec: { "patch-manifest": { action: "ask" } },
      }),
      "ask",
    );
  });

  /* --------------------------------------------------- minimal project */

  test("stays silent against the minimal project fixture", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "deploy/patch.manifest.xml",
        content: "<Database table=\"Orders\"><Comment>no script</Comment></Database>",
        project: PROJECT_MINIMAL,
      }),
      "pass",
    );
  });
});
