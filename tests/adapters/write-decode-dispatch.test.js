"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { suite } = require("../harness");
const { CLAUDE_DISPATCH, CODEX_DISPATCH, runDispatcher } = require("./_spawn");
const { buildContext } = require("../../core/lib/context");
const { evaluateDecodedWrites } = require("../../adapters/shared/dispatch-core");
const patchManifestRule = require("../../core/guards/patch-manifest");

/**
 * Initialises a throwaway git repository with no remote, so a relative-path
 * rule anchors its boundary on the repository root rather than falling back
 * to `ctx.cwd` — which, for a call editing a file that already exists,
 * `core/lib/workdir.js#resolveWorkdir` anchors on the file's own containing
 * directory instead of the payload's own `cwd`, exactly as it would for a
 * real `Edit`/`MultiEdit` call outside any repository. A real repository
 * always has a `.git` directory, so this is what makes the test faithful to
 * production rather than exercising a no-git edge case the fix itself has
 * nothing to do with.
 *
 * @param {string} dir The directory to initialise.
 * @returns {void}
 */
function initRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
}

/**
 * Resolves a directory to its canonical, non-8.3-shortened form.
 *
 * `tmpdir()` hands back whatever form `os.tmpdir()` reports, which on this
 * machine is the Windows 8.3 short-name spelling (`VOLODY~1`); `git`
 * resolves the same directory to its long-name form. `path.relative` between
 * the two disagreeing spellings of one identical directory produces a `..`
 * climbing path instead of recognising the file sits under the boundary — an
 * environmental quirk of this machine's `TEMP`, unrelated to anything under
 * test, that only bites a case combining a real git repository with a
 * relative-glob rule the way this suite's `no-explicit-any` case does.
 *
 * @param {string} dir The directory to canonicalise.
 * @returns {string} The same directory, in its long-name form.
 */
function realDir(dir) {
  return fs.realpathSync.native(dir);
}

/**
 * Builds a `PreToolUse` payload for a direct tool call, in either host's own
 * envelope shape — both dispatchers read the same `tool_input` field name.
 *
 * @param {string} toolName The tool name to report.
 * @param {object} toolInput The tool's own input object.
 * @param {string} cwd The working directory to report.
 * @returns {object} The payload.
 */
function payload(toolName, toolInput, cwd) {
  return { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, cwd };
}

/**
 * Reads the `permissionDecision` a dispatcher reported, tolerating that
 * Codex has no native `ask` and instead reports a mapped `deny` (CONTRACTS
 * §7, `askMode: "block"`, this repository's default).
 *
 * @param {object} result A `runDispatcher` result.
 * @returns {string | null} The decision, or `null` when the dispatcher wrote
 * nothing (a pass).
 */
function decisionOf(result) {
  // `null` for "no decision" whether the dispatcher wrote nothing at all or
  // wrote an advisory — an advisory carries a `hookSpecificOutput` with no
  // `permissionDecision` key, and reading that back as `undefined` would make
  // "reported without blocking" and "stayed silent" look like different
  // outcomes to every caller here when neither blocks anything.
  return (result.parsed && result.parsed.hookSpecificOutput.permissionDecision) || null;
}

/**
 * Reads the composed reason text a dispatcher reported.
 *
 * @param {object} result A `runDispatcher` result.
 * @returns {string} The reason, or `""` when the dispatcher wrote nothing.
 */
function reasonOf(result) {
  return result.parsed ? result.parsed.hookSpecificOutput.permissionDecisionReason || "" : "";
}

/**
 * Reads the advisory text a dispatcher reported — the non-blocking channel a
 * write this dispatcher could not decode is reported through, on either host.
 *
 * @param {object} result A `runDispatcher` result.
 * @returns {string} The advisory, or `""` when the dispatcher wrote nothing
 * or wrote a decision instead.
 */
function advisoryOf(result) {
  return result.parsed ? result.parsed.hookSpecificOutput.additionalContext || "" : "";
}

/**
 * Reads the developer-visible half of an advisory, which sits beside
 * `hookSpecificOutput` rather than inside it.
 *
 * @param {object} result A `runDispatcher` result.
 * @returns {string} The system message, or `""` when there was none.
 */
function systemMessageOf(result) {
  return result.parsed ? result.parsed.systemMessage || "" : "";
}

suite("adapters/write-decode-dispatch", ({ test, eq, ok, tmpdir }) => {
  /* ------------------------------------------------- previously-inert shapes */

  test("apply_patch {input: patch text} now denies, where it used to pass silently", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/components/scheduler/StatusSummaryProbe.tsx",
      "+export function StatusSummaryProbe() { return null; }",
      "*** End Patch",
    ].join("\n");
    const result = runDispatcher(CODEX_DISPATCH, payload("apply_patch", { input: patch }, cwd), { home, cwd });
    eq(decisionOf(result), "deny");
    ok(reasonOf(result).includes("component-folder-shape"), "reason should name the folder-shape rule");
  });

  test("apply_patch {patch: patch text} now denies, where it used to pass silently", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/components/scheduler/StatusSummaryProbe.tsx",
      "+export function StatusSummaryProbe() { return null; }",
      "*** End Patch",
    ].join("\n");
    const result = runDispatcher(CODEX_DISPATCH, payload("apply_patch", { patch }, cwd), { home, cwd });
    eq(decisionOf(result), "deny");
    ok(reasonOf(result).includes("component-folder-shape"), "reason should name the folder-shape rule");
  });

  test("apply_patch {changes: {...}} now denies, where it used to pass silently", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    const changes = {
      "src/components/scheduler/StatusSummaryProbe.tsx": {
        type: "add",
        content: "export function StatusSummaryProbe() { return null; }",
      },
    };
    const result = runDispatcher(CODEX_DISPATCH, payload("apply_patch", { changes }, cwd), { home, cwd });
    eq(decisionOf(result), "deny");
    ok(reasonOf(result).includes("component-folder-shape"), "reason should name the folder-shape rule");
  });

  test("MultiEdit's content is now checked, not only its path", () => {
    // `no-explicit-any` ratchets an existing file's own `any` count, so it
    // fires on an EDIT of an existing file — unlike the two folder/type rules
    // used above, which only govern a brand-new file. It is exactly the kind
    // of content-only rule `MultiEdit`'s missing content used to hide from.
    const home = tmpdir();
    const cwd = realDir(tmpdir());
    initRepo(cwd);
    const filePath = path.join(cwd, "src/types/FooProbe.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "export type FooProbe = { id: string };\n", "utf8");

    const result = runDispatcher(
      CLAUDE_DISPATCH,
      payload(
        "MultiEdit",
        {
          file_path: filePath,
          edits: [{ old_string: "id: string", new_string: "id: any" }],
        },
        cwd,
      ),
      { home, cwd },
    );
    eq(decisionOf(result), "deny");
    ok(reasonOf(result).includes("no-explicit-any"), "reason should name the any-ratchet rule");
  });

  /* --------------------------------------------------------------------- F1: CRLF */

  test("F1: a CRLF-joined apply_patch envelope denies exactly like its LF-joined equivalent, not a generic unrecognised-shape ask", () => {
    // Before the fix, PATCH_FILE_HEADER_RE's `.` never matches `\r`, so the
    // header line of a \r\n-joined envelope failed to match at all — the
    // whole section vanished, decodeWrites came back empty, and the call
    // degraded to the generic "write-payload-unrecognised" ask instead of
    // being judged by component-folder-shape like the LF-joined patch is.
    const home = tmpdir();
    const cwd = tmpdir();
    const linesLF = [
      "*** Begin Patch",
      "*** Add File: src/components/scheduler/CrlfRegressionProbe.tsx",
      "+export function CrlfRegressionProbe() { return null; }",
      "*** End Patch",
    ];

    const lfResult = runDispatcher(CODEX_DISPATCH, payload("apply_patch", { input: linesLF.join("\n") }, cwd), {
      home,
      cwd,
    });
    const crlfResult = runDispatcher(CODEX_DISPATCH, payload("apply_patch", { input: linesLF.join("\r\n") }, cwd), {
      home,
      cwd,
    });

    eq(decisionOf(crlfResult), decisionOf(lfResult));
    eq(decisionOf(crlfResult), "deny");
    ok(reasonOf(crlfResult).includes("component-folder-shape"), "reason should name the folder-shape rule, not the unrecognised-shape ask");
  });

  /* --------------------------------------------------------- D1: filePath anchor */

  test("D1: a relative file_path from a subdirectory cwd resolves against the repository root, not the raw string", () => {
    // Reproduces the reviewer's own scenario: the agent's own cwd is a
    // subdirectory of the repository, not the repository root itself, and
    // the tool call's own `file_path` is relative to THAT cwd. Before D1,
    // `ctx.filePath` was left as the raw, unresolved string — which never
    // starts with the repository root, so `component-folder-shape`'s own
    // `relativeToRepo` could not strip anything off it and the rule simply
    // never matched its own `componentFolders` convention at all, passing
    // silently on a file this shape is exactly meant to catch.
    const home = tmpdir();
    const repoRoot = realDir(tmpdir());
    initRepo(repoRoot);
    const toolsDir = path.join(repoRoot, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });

    const result = runDispatcher(
      CLAUDE_DISPATCH,
      payload(
        "Write",
        {
          file_path: "../src/components/scheduler/StatusSummaryProbe.tsx",
          content: "export function StatusSummaryProbe() { return null; }",
        },
        toolsDir,
      ),
      { home, cwd: toolsDir },
    );
    eq(decisionOf(result), "deny");
    ok(reasonOf(result).includes("component-folder-shape"), "reason should name the folder-shape rule");
  });

  /* --------------------------------------------------- R2: reconstruction reader anchor */

  test("R2: reconstruction reads through a repo-root-anchored reader, not the wrong file a same-named path under cwd would resolve to", () => {
    // D1 fixed `ctx.filePath` itself; this reproduces the reviewer's own
    // next step — RECONSTRUCTING the file's content still went through
    // `ctx.readFile`, which `core/lib/context.js#makeReadFile` anchors on
    // `cwd` regardless of `pathBase`. Two files share the same repo-relative
    // name: the real target at the repo root, and a decoy under the agent's
    // own (subdirectory) cwd. The hunk's own context line exists ONLY in the
    // decoy, so reading the wrong file lets the hunk apply and produces
    // reconstructed content carrying an `any` the rule then denies; reading
    // the correct file (which never had that text) fails reconstruction to
    // content:null and the rule stays silent.
    const home = tmpdir();
    const repoRoot = realDir(tmpdir());
    initRepo(repoRoot);
    const toolsDir = path.join(repoRoot, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });

    const realFile = path.join(repoRoot, "src/types/DupProbe2.ts");
    fs.mkdirSync(path.dirname(realFile), { recursive: true });
    fs.writeFileSync(realFile, "export type DupProbe2 = {\n  id: string;\n};\n", "utf8");

    const decoyFile = path.join(toolsDir, "src/types/DupProbe2.ts");
    fs.mkdirSync(path.dirname(decoyFile), { recursive: true });
    fs.writeFileSync(decoyFile, "export type DupProbe2 = {\n  bogus: any;\n};\n", "utf8");

    const patch = [
      "*** Begin Patch",
      "*** Update File: src/types/DupProbe2.ts",
      " export type DupProbe2 = {",
      "-  bogus: any;",
      "+  bogus: any; // still any",
      " };",
      "*** End Patch",
    ].join("\n");

    const result = runDispatcher(CODEX_DISPATCH, payload("apply_patch", { input: patch }, toolsDir), {
      home,
      cwd: toolsDir,
    });
    eq(decisionOf(result), null);
  });

  /* --------------------------------------------------- F4: header-shape collision */

  test("F4a: a genuine violation sitting past a stray header-shaped context line no longer passes silently — it asks instead", () => {
    // The hunk proves itself "real" via an earlier, unrelated change BEFORE
    // the stray header-shaped line — exactly the case the old
    // hunkHasChange() special case declared safe to treat as an
    // unconditional genuine second header, silently truncating everything
    // past it (including the real `any` addition further down) out of the
    // reconstructed content the rule judges.
    const home = tmpdir();
    const repoRoot = realDir(tmpdir());
    initRepo(repoRoot);
    const filePath = path.join(repoRoot, "src/types/AnyBypassRegressionProbe.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const existing = "export type Foo = {\n  id: string;\n};\n\nexport function helper() {\n  return 1;\n}\n";
    fs.writeFileSync(filePath, existing, "utf8");

    const patch = [
      "*** Begin Patch",
      "*** Update File: src/types/AnyBypassRegressionProbe.ts",
      " export type Foo = {",
      "-  id: string;",
      "+  id: number;",
      "*** Update File: ghost-file-that-was-never-named.ts",
      " };",
      "",
      " export function helper() {",
      "-  return 1;",
      "+  return x as any;",
      " }",
      "*** End Patch",
    ].join("\n");

    const result = runDispatcher(CODEX_DISPATCH, payload("apply_patch", { input: patch }, repoRoot), {
      home,
      cwd: repoRoot,
    });
    eq(decisionOf(result), null);
    ok(
      advisoryOf(result).includes("write-payload-ambiguous"),
      `must report the ambiguous parse, never pass silently over a real \`any\`; got: ${advisoryOf(result) || "(nothing)"}`,
    );
    ok(advisoryOf(result).includes("apply_patch"), "the advisory must name the call it is about");

    // Control: the identical `any` addition, same shape, with no stray
    // header-shaped line anywhere — denies cleanly through no-explicit-any,
    // proving the rule and the fixture are both sound and the advisory above
    // is caused by the collision, not by something else about this patch.
    const controlFilePath = path.join(repoRoot, "src/types/AnyBypassControlRegressionProbe.ts");
    fs.writeFileSync(controlFilePath, existing, "utf8");
    const controlPatch = [
      "*** Begin Patch",
      "*** Update File: src/types/AnyBypassControlRegressionProbe.ts",
      " export type Foo = {",
      "-  id: string;",
      "+  id: number;",
      " };",
      "",
      " export function helper() {",
      "-  return 1;",
      "+  return x as any;",
      " }",
      "*** End Patch",
    ].join("\n");
    const controlResult = runDispatcher(CODEX_DISPATCH, payload("apply_patch", { input: controlPatch }, repoRoot), {
      home,
      cwd: repoRoot,
    });
    eq(decisionOf(controlResult), "deny");
    ok(reasonOf(controlResult).includes("no-explicit-any"), "control: without the stray line the rule catches it normally");
  });

  test("F4b: a clean single-file edit with a stray header-shaped context line no longer misfiles a phantom section as a false deny", () => {
    // Same collision shape as F4a, but on an otherwise entirely innocuous
    // edit: before the fix, the phantom "ghost" path became its own decoded
    // write entry and ran through engine.evaluate like any real file, so a
    // path-based rule could fire on a path the agent never named at all.
    const home = tmpdir();
    const cwd = tmpdir();
    fs.writeFileSync(path.join(cwd, "widget.js"), "constructor() {\nold init\n}\n", "utf8");

    const patch = [
      "*** Begin Patch",
      "*** Update File: widget.js",
      " constructor() {",
      "-old init",
      "+new init",
      "*** Update File: ghost-file-that-was-never-named.js",
      " }",
      "*** End Patch",
    ].join("\n");

    const result = runDispatcher(CODEX_DISPATCH, payload("apply_patch", { input: patch }, cwd), { home, cwd });
    eq(decisionOf(result), null);
    ok(
      advisoryOf(result).includes("write-payload-ambiguous"),
      `should be the ambiguous-parse advisory, not a rule firing on the phantom path; got: ${advisoryOf(result) || "(nothing)"}`,
    );
    ok(
      !advisoryOf(result).includes("ghost-file-that-was-never-named.js"),
      "must never name the phantom path the agent never wrote",
    );
  });

  /* ------------------------------------------------------- unrecognised shape */

  test("an apply_patch payload matching none of the known shapes is reported without blocking the call", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    const result = runDispatcher(CODEX_DISPATCH, payload("apply_patch", { totally: "unknown shape" }, cwd), {
      home,
      cwd,
    });
    // A shape this decoder cannot read names a gap in softela-ai, not a problem
    // with the developer's change, so it reports rather than decides. This
    // used to be an `ask`, which on Codex became a denial telling the
    // developer to run `softela-ai approve` in a second terminal — and that
    // denial could not be lifted at all, because a synthesised decision never
    // reaches the engine where the approvals gate lives.
    eq(decisionOf(result), null);
    ok(advisoryOf(result).includes("apply_patch"), "advisory should name the tool whose payload was not recognised");
    ok(advisoryOf(result).includes("write-payload-unrecognised"), "advisory should name which kind it is");
    ok(!advisoryOf(result).includes("softela-ai approve"), "must never send the developer to a second terminal");
  });

  test("on Claude Code the same unrecognised shape reports identically — same channel, same words", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    const claude = runDispatcher(CLAUDE_DISPATCH, payload("apply_patch", { totally: "unknown shape" }, cwd), {
      home,
      cwd,
    });
    const codex = runDispatcher(CODEX_DISPATCH, payload("apply_patch", { totally: "unknown shape" }, cwd), {
      home,
      cwd,
    });
    eq(decisionOf(claude), null);
    ok(advisoryOf(claude).includes("write-payload-unrecognised"), advisoryOf(claude));
    eq(advisoryOf(claude), advisoryOf(codex), "the same situation must read the same way on both hosts");
    // The agent-visible half is `additionalContext`; the developer-visible
    // half is `systemMessage`. An advisory only the model can read is not a
    // report, so both hosts must carry both.
    eq(systemMessageOf(claude), advisoryOf(claude), "Claude Code must surface the advisory to the developer too");
    eq(systemMessageOf(codex), advisoryOf(codex), "Codex must surface the advisory to the developer too");
  });

  test("Codex's real apply_patch payload — the patch under `command` — is decoded and judged, not reported as unreadable", () => {
    // The exact shape a live Codex 0.149.1 PreToolUse payload carries,
    // measured off the real host. Until the decoder read this field, EVERY
    // patch Codex wrote decoded to nothing and came back as a hard denial:
    // the agent could not change a single file.
    const home = tmpdir();
    const cwd = tmpdir();
    fs.writeFileSync(path.join(cwd, "widget.js"), "old\n", "utf8");
    const patch = ["*** Begin Patch", "*** Update File: widget.js", "@@", "-old", "+new", "*** End Patch"].join("\n");

    const result = runDispatcher(CODEX_DISPATCH, payload("apply_patch", { command: patch }, cwd), { home, cwd });

    eq(decisionOf(result), null);
    eq(advisoryOf(result), "", "a payload the decoder can read must produce no visibility advisory at all");
  });

  /* ------------------------------------------------------------ fail-open */

  test("a MultiEdit call naming no path at all blocks nothing (decode returns [], not a write tool name miss)", () => {
    // `edits` present but no `file_path` at all is a genuinely unrecognised
    // MultiEdit shape too, which is the ask path — this case instead proves
    // the harmless companion: a tool name this dispatcher does not treat as
    // a write at all (Read) is completely unaffected by any of this.
    const home = tmpdir();
    const cwd = tmpdir();
    const result = runDispatcher(CLAUDE_DISPATCH, payload("Read", { file_path: "src/a.ts" }, cwd), { home, cwd });
    eq(decisionOf(result), null);
    eq(result.code, 0);
  });

  /* --------------------------------------------- the five real violations */

  test("a single multi-file apply_patch replaying the five real violations denies", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    // Fresh sibling paths ("...Probe.tsx"), per the task: the already-tracked
    // real files in a product repository must not soften these rules
    // through the newCodeOnly-existing-file path.
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/components/appointmentScheduler/scheduler/AppointmentStatusSummaryProbe.tsx",
      "+interface AppointmentStatusSummaryProbeProps {",
      "+  status: string;",
      "+}",
      "+export function AppointmentStatusSummaryProbe(props: AppointmentStatusSummaryProbeProps) {",
      "+  return props.status;",
      "+}",
      "*** Add File: src/__tests__/AppointmentStatusSummaryProbe.test.tsx",
      "+test('renders', () => {});",
      "*** Add File: src/__tests__/SomeOtherComponentProbe.test.tsx",
      "+test('renders', () => {});",
      "*** Add File: src/__tests__/YetAnotherComponentProbe.test.tsx",
      "+test('renders', () => {});",
      "*** End Patch",
    ].join("\n");

    const result = runDispatcher(CODEX_DISPATCH, payload("apply_patch", { input: patch }, cwd), { home, cwd });
    eq(decisionOf(result), "deny");
    // The component file is decoded first, and within it component-folder-shape
    // (alphabetically before component-types-file, so registered first) wins
    // the per-file tie — see core/guards/index.js's own alphabetical ordering
    // and core/engine.js's "earliest registered rule wins" tie-break.
    ok(reasonOf(result).includes("component-folder-shape"), "the folder-shape violation should be the reported one");
  });

  /* ------------------------------------------------------------------ F5 */

  test("F5: patch-manifest's ratchet is identity-based — fixing one pre-existing unpaired declaration while newly breaking another still denies", () => {
    // Driven through the real evaluateDecodedWrites and the real
    // patch-manifest rule (via engine.evaluate, scoped to just this one rule
    // so the assertion is not at the mercy of the whole registry's own
    // per-project routing) rather than calling rule.evaluate() directly.
    const cwd = realDir(tmpdir());
    initRepo(cwd);
    const manifestPath = path.join(cwd, "deploy/patch.manifest.xml");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });

    // On disk: declaration A has no UpgradeScript (a pre-existing violation
    // this write does not go near), declaration B is properly paired.
    const onDisk = ["<Database id=\"A\" />", "<Database id=\"B\" />", "<UpgradeScript for=\"B\" />"].join("\n");
    fs.writeFileSync(manifestPath, onDisk, "utf8");

    // New write: A is fixed, but B's own UpgradeScript entry is removed in
    // the same edit — the total unpaired count stays flat (1 before, 1
    // after), yet B is a genuinely NEW violation a count-only ratchet would
    // wrongly forgive.
    const newContent = ["<Database id=\"A\" />", "<UpgradeScript for=\"A\" />", "<Database id=\"B\" />"].join("\n");

    const baseCtx = buildContext(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: manifestPath, content: newContent },
        cwd,
      },
      { agent: "codex" },
    );
    const ctx = {
      ...baseCtx,
      project: {
        ...baseCtx.project,
        // The resolved project (`_default.json`) declares its own monorepo
        // `stacks` glob list, which `core/lib/stack-resolver.js#resolveStack`
        // prefers over the plain `stack` shorthand below — cleared so the
        // manifest's own `.xml` extension (matching none of those globs)
        // does not resolve to "no stack" and silence this stack-scoped rule.
        stacks: undefined,
        stack: "backend",
        patchManifest: {
          filePattern: "patch\\.manifest\\.xml$",
          databasePattern: "<Database",
          requiredEntry: "UpgradeScript",
        },
      },
    };

    const result = evaluateDecodedWrites(ctx, { rules: [patchManifestRule], diagnostics: [] });
    eq(result.handled, true);
    ok(result.decision, "a newly-unpaired declaration must still deny even though the total count did not increase");
    eq(result.decision.action, "deny");
    ok(result.decision.reason.includes("counted as new"), "reason should name that something was counted as new by this write");
  });

  /* ------------------------------------------------- gap review: no repoRoot */

  test("gap review: git.repoRoot === null falls back to ctx.cwd for the header-existence check, rather than trusting or crashing", () => {
    // A working directory outside any git repository — `ctx.git.repoRoot`
    // genuinely `null`. Pins that `evaluateDecodedWrites`'s fallback
    // existence checker (anchored on `cwd` instead) still enforces the
    // boundary correctly both directions: a real file reconstructs, and a
    // phantom header still escalates to ambiguous rather than being trusted.
    const cwd = realDir(tmpdir());
    const realFilePath = path.join(cwd, "src/types/NoRepoProbe.ts");
    fs.mkdirSync(path.dirname(realFilePath), { recursive: true });
    fs.writeFileSync(realFilePath, "export type Foo = {\n};\n", "utf8");

    const baseCtx = buildContext(
      { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: {}, cwd },
      { agent: "codex" },
    );
    eq(baseCtx.git.repoRoot, null, "sanity: this cwd must genuinely resolve to no repository at all");

    const realPatch = [
      "*** Begin Patch",
      "*** Update File: src/types/NoRepoProbe.ts",
      " export type Foo = {",
      "+  real: string;",
      " };",
      "*** End Patch",
    ].join("\n");
    const realCtx = { ...baseCtx, input: { input: realPatch } };
    const realResult = evaluateDecodedWrites(realCtx, { rules: [], diagnostics: [] });
    eq(realResult.handled, true);
    eq(realResult.decision, null, "no rules configured, but the write must have decoded");
    eq(realResult.advisory, null, "a write that decoded cleanly must produce no visibility advisory");

    const phantomPatch = [
      "*** Begin Patch",
      "*** Update File: src/types/DoesNotExist.ts",
      " x",
      "-a",
      "+b",
      "*** End Patch",
    ].join("\n");
    const phantomCtx = { ...baseCtx, input: { input: phantomPatch } };
    const phantomResult = evaluateDecodedWrites(phantomCtx, { rules: [], diagnostics: [] });
    eq(phantomResult.handled, true);
    eq(phantomResult.decision, null, "a phantom header is a fact about the patch, not grounds to block the call");
    ok(
      phantomResult.advisory && phantomResult.advisory.includes("write-payload-ambiguous"),
      `a phantom Update File header naming a nonexistent path must still be reported, not pass silently; got: ${
        phantomResult.advisory || "(nothing)"
      }`,
    );
  });

  test("a write to a real file outside the working directory is evaluated, not written off as ambiguous", () => {
    // Measured against a live Codex session: cwd was the folder holding the
    // repositories, and the file written was the agent's own memory file,
    // outside it. The boundary-anchored existence check answers false for
    // every such path whatever is on disk, so the whole patch was declared
    // undecidable, no rule ran on it, and the advisory that followed made
    // the agent apply the same patch twice.
    const outside = realDir(tmpdir());
    const memoryFile = path.join(outside, "memory", "ACTIVE-WORK.md");
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    fs.writeFileSync(memoryFile, "# Active work\n", "utf8");

    const cwd = realDir(tmpdir());
    const baseCtx = buildContext(
      { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: {}, cwd },
      { agent: "codex" },
    );

    const patch = [
      "*** Begin Patch",
      `*** Update File: ${memoryFile}`,
      " # Active work",
      "+",
      "+## A section the agent appended",
      "*** End Patch",
    ].join("\n");

    const result = evaluateDecodedWrites({ ...baseCtx, input: { input: patch } }, { rules: [], diagnostics: [] });
    eq(result.handled, true);
    eq(result.advisory, null, "a legitimate write outside the boundary is not a decoder blind spot");
    eq(result.decision, null, "no rules configured here — what matters is that the write reached evaluation at all");
  });

  test("the visibility advisory tells the agent the call already went through", () => {
    // The advisory's own wording is load-bearing: an agent that reads "NOT
    // checked" as "did not happen" re-applies the patch and doubles its
    // content, which is exactly what was observed.
    const cwd = realDir(tmpdir());
    const baseCtx = buildContext(
      { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: {}, cwd },
      { agent: "codex" },
    );
    const phantom = ["*** Begin Patch", "*** Update File: src/Gone.ts", " x", "-a", "+b", "*** End Patch"].join("\n");
    const result = evaluateDecodedWrites({ ...baseCtx, input: { input: phantom } }, { rules: [], diagnostics: [] });
    ok(result.advisory && /already gone through/.test(result.advisory), `got: ${result.advisory || "(nothing)"}`);
    ok(result.advisory && /do NOT re-apply/.test(result.advisory), `got: ${result.advisory || "(nothing)"}`);
  });
});
