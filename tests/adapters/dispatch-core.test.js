"use strict";

const path = require("path");
const { execFileSync } = require("child_process");

const { suite } = require("../harness");
const { buildContext } = require("../../core/lib/context");
const { buildOperationContext, buildWriteContext, evaluateDecodedWrites } = require("../../adapters/shared/dispatch-core");
const { deny, ask, pass } = require("../../core/lib/decision");
const { makeCtx, PROJECT_BACKEND } = require("../guards/_ctx");
const patchManifestRule = require("../../core/guards/patch-manifest");
const noExplicitAnyRule = require("../../core/guards/no-explicit-any");

/**
 * Initialises a throwaway git repository with an `origin` remote, so
 * `resolveProject` (called with no `projectsDir` override, exactly the way
 * `adapters/shared/dispatch-core.js` calls it in production) matches this
 * repository's own real, shipped project files by remote — the only way to
 * prove `buildOperationContext` resolves a genuinely different project,
 * without touching the real dispatcher's default project resolution.
 *
 * @param {string} dir The directory to initialise.
 * @param {string} remoteUrl The `origin` remote URL to configure.
 * @returns {void}
 */
function initRepo(dir, remoteUrl) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remoteUrl], { cwd: dir });
}

suite("adapters/dispatch-core", ({ test, eq, ok, tmpdir }) => {
  test("a nested shell operation naming a workdir in a different repository resolves its own project and git", () => {
    const outerRepo = tmpdir();
    initRepo(outerRepo, "git@dev.azure.com:v3/org/Softela.SCExpert.git");
    const innerRepo = tmpdir();
    initRepo(innerRepo, "https://dev.azure.com/org/Project/_git/Softela.ReactSCExpert");

    const ctx = buildContext({ hook_event_name: "PreToolUse", tool_name: "exec", cwd: outerRepo }, { agent: "codex" });
    eq(ctx.project.id, "Softela.SCExpert");

    const op = { kind: "shell", toolName: "shell_command", command: "npm test", cwd: innerRepo };
    const opCtx = buildOperationContext(ctx, op);

    eq(opCtx.cwd, innerRepo);
    eq(opCtx.project.id, "Softela.ReactSCExpert");
    eq(opCtx.command, "npm test");
    ok(opCtx.git !== ctx.git, "a re-resolved operation must not share the outer call's git object");
  });

  test("a nested shell operation with no `workdir` literal derives its anchor from the command text itself", () => {
    const outerRepo = tmpdir();
    initRepo(outerRepo, "git@dev.azure.com:v3/org/Softela.SCExpert.git");
    const innerRepo = tmpdir();
    initRepo(innerRepo, "https://dev.azure.com/org/Project/_git/Softela.ReactSCExpert");

    const ctx = buildContext({ hook_event_name: "PreToolUse", tool_name: "exec", cwd: outerRepo }, { agent: "codex" });
    eq(ctx.project.id, "Softela.SCExpert");

    // No `cwd` field at all — the only evidence of which repository this
    // operation targets is the `cd` inside the command text itself, exactly
    // the shape a real captured `tools.shell_command({command: "cd … && …"})`
    // call with no separate `workdir` literal produces. Single-quoted: the
    // shared shell tokeniser treats a backslash inside DOUBLE quotes as an
    // escape character, which would corrupt a raw Windows path.
    const op = { kind: "shell", toolName: "shell_command", command: `cd '${innerRepo}' && npm test` };
    const opCtx = buildOperationContext(ctx, op);

    eq(opCtx.cwd, innerRepo);
    eq(opCtx.project.id, "Softela.ReactSCExpert");
    ok(opCtx.git !== ctx.git, "a re-resolved operation must not share the outer call's git object");
    ok(opCtx.git.repoRoot, "git.repoRoot must be recomputed for the new anchor, not left null");
  });

  test("a nested shell operation's own `workdir` literal wins over anything parsed from its command text", () => {
    const outerRepo = tmpdir();
    initRepo(outerRepo, "git@dev.azure.com:v3/org/Softela.SCExpert.git");
    const explicitRepo = tmpdir();
    initRepo(explicitRepo, "https://dev.azure.com/org/Project/_git/Softela.ReactSCExpert");
    const commandNamedRepo = tmpdir();

    const ctx = buildContext({ hook_event_name: "PreToolUse", tool_name: "exec", cwd: outerRepo }, { agent: "codex" });

    const op = {
      kind: "shell",
      toolName: "shell_command",
      command: `cd '${commandNamedRepo}' && npm test`,
      cwd: explicitRepo,
    };
    const opCtx = buildOperationContext(ctx, op);

    eq(opCtx.cwd, explicitRepo);
    eq(opCtx.project.id, "Softela.ReactSCExpert");
  });

  test("a nested shell operation with no cwd reuses the outer call's project and git unchanged", () => {
    const outerDir = tmpdir();
    const ctx = buildContext({ hook_event_name: "PreToolUse", tool_name: "exec", cwd: outerDir }, { agent: "codex" });

    const op = { kind: "shell", toolName: "shell_command", command: "npm test" };
    const opCtx = buildOperationContext(ctx, op);

    eq(opCtx.cwd, ctx.cwd);
    ok(opCtx.project === ctx.project, "project should be reused by reference, not re-resolved");
    ok(opCtx.git === ctx.git, "git should be reused by reference, not re-resolved");
  });

  test("a write operation's relative filePath never changes the anchor", () => {
    const outerDir = tmpdir();
    const ctx = buildContext({ hook_event_name: "PreToolUse", tool_name: "exec", cwd: outerDir }, { agent: "codex" });

    const op = { kind: "write", toolName: "apply_patch", filePath: "src/index.ts", content: "x", action: "update" };
    const opCtx = buildOperationContext(ctx, op);

    eq(opCtx.cwd, ctx.cwd);
    ok(opCtx.project === ctx.project, "a relative write filePath must not trigger re-resolution");
    eq(opCtx.filePath, "src/index.ts");
  });

  test("buildOperationContext never throws even when the outer context is malformed", () => {
    let threw = false;
    let opCtx;
    try {
      opCtx = buildOperationContext({}, { kind: "shell", toolName: "shell_command", command: "echo hi" });
    } catch {
      threw = true;
    }
    eq(threw, false);
    eq(opCtx.command, "echo hi");
  });
});

/**
 * A test-only rule denying a write whose `ctx.filePath` ends with a given
 * suffix, the reason naming the actual path so a tie-break test can tell
 * which of several matching files' own decision survived.
 *
 * @param {string} id The rule's own id.
 * @param {string} suffix The path suffix this rule fires on.
 * @returns {object} A minimal, valid rule module.
 */
function denyOnPathSuffix(id, suffix) {
  return {
    id,
    title: `test-only: deny a write ending in ${suffix}`,
    events: ["PreToolUse"],
    tools: null,
    defaultAction: "deny",
    group: "code",
    requiresConfig: [],
    evaluate(ctx) {
      return ctx.filePath.endsWith(suffix) ? deny(`denied ${ctx.filePath}`) : pass();
    },
  };
}

/**
 * The `ask`-severity counterpart to {@link denyOnPathSuffix}, used to prove
 * `evaluateDecodedWrites`'s strongest-wins combination actually compares
 * severity rather than merely picking the last decoded write.
 *
 * @param {string} id The rule's own id.
 * @param {string} suffix The path suffix this rule fires on.
 * @returns {object} A minimal, valid rule module.
 */
function askOnPathSuffix(id, suffix) {
  return {
    id,
    title: `test-only: ask on a write ending in ${suffix}`,
    events: ["PreToolUse"],
    tools: null,
    defaultAction: "ask",
    group: "code",
    requiresConfig: [],
    evaluate(ctx) {
      return ctx.filePath.endsWith(suffix) ? ask(`asked ${ctx.filePath}`) : pass();
    },
  };
}

suite("adapters/dispatch-core write decode", ({ test, eq, ok }) => {
  /* -------------------------------------------------------- buildWriteContext */

  test("buildWriteContext replaces filePath/content/input and reuses cwd/project/git by reference; filePath is resolved absolute (D1), input.file_path stays raw", () => {
    const cwd = path.win32.resolve("C:\\repo");
    const ctx = makeCtx({ toolName: "apply_patch", cwd, filePath: "", content: "" });
    const opCtx = buildWriteContext(ctx, {
      path: "src/New.ts",
      content: "export const x = 1;",
      kind: "add",
      pathBase: "cwd",
    });

    eq(opCtx.filePath, path.resolve(cwd, "src/New.ts"));
    eq(opCtx.content, "export const x = 1;");
    eq(opCtx.resultingContent, "export const x = 1;");
    eq(opCtx.input.file_path, "src/New.ts");
    eq(opCtx.input.content, "export const x = 1;");
    ok(opCtx.project === ctx.project, "project must be reused by reference, not re-resolved");
    ok(opCtx.git === ctx.git, "git must be reused by reference, not re-resolved");
    ok(opCtx.cwd === ctx.cwd, "cwd must be reused unchanged");
  });

  test("buildWriteContext resolves a repoRoot-anchored path (a patch header) against ctx.git.repoRoot, not ctx.cwd, when the two differ (D1)", () => {
    const cwd = path.win32.resolve("C:\\repo\\tools");
    const repoRoot = path.win32.resolve("C:\\repo");
    const ctx = makeCtx({ toolName: "apply_patch", cwd, git: { repoRoot } });
    const opCtx = buildWriteContext(ctx, {
      path: "src/Widget.ts",
      content: "export const widget = 1;",
      kind: "update",
      pathBase: "repoRoot",
    });

    eq(opCtx.filePath, path.resolve(repoRoot, "src/Widget.ts"));
  });

  test("buildWriteContext maps an unreconstructable content:null write to an empty string, never to the literal null", () => {
    const ctx = makeCtx({ toolName: "Edit" });
    const opCtx = buildWriteContext(ctx, { path: "src/a.ts", content: null, kind: "update" });
    eq(opCtx.content, "");
    eq(opCtx.input.content, "");
    eq(opCtx.resultingContent, null);
  });

  test("buildWriteContext prefers write.insertedText for ctx.content, keeping resultingContent as the full reconstructed file (D6)", () => {
    const ctx = makeCtx({ toolName: "MultiEdit" });
    const opCtx = buildWriteContext(ctx, {
      path: "src/a.ts",
      content: "export const token = secret_value;",
      insertedText: "secret_value",
      kind: "update",
      pathBase: "cwd",
    });

    eq(opCtx.content, "secret_value");
    eq(opCtx.resultingContent, "export const token = secret_value;");
    eq(opCtx.input.content, "secret_value");
  });

  /* ---------------------------------------------------------- evaluateDecodedWrites */

  test("a non-write tool call is not handled at all, so the caller falls back to plain evaluation", () => {
    const ctx = makeCtx({ toolName: "Bash", command: "git status" });
    const result = evaluateDecodedWrites(ctx, {});
    eq(result.handled, false);
    eq(result.decision, null);
  });

  test("an apply_patch call whose payload shape is not recognised advises instead of deciding, naming the tool", () => {
    const ctx = makeCtx({ toolName: "apply_patch", input: { weird: "shape" } });
    const result = evaluateDecodedWrites(ctx, {});
    eq(result.handled, true);
    // Not a decision: this names a limit of the decoder, not a problem with
    // the developer's change, so it must be reported rather than blocked.
    eq(result.decision, null);
    ok(typeof result.advisory === "string" && result.advisory.length > 0, "an unseen write must still be reported");
    ok(result.advisory.includes("apply_patch"), "advisory should name the tool");
    ok(result.advisory.includes("write-payload-unrecognised"), "advisory should name which of the two kinds it is");
    ok(!result.advisory.includes("softela-ai approve"), "an advisory must never send the developer to a second terminal");
  });

  test("an apply_patch envelope that parses but is ambiguous is told apart from one whose shape is unknown", () => {
    // A header naming a file that is not on disk: the envelope's grammar is
    // fine, its claim about the working tree is not.
    const patch = ["*** Begin Patch", "*** Update File: src/gone.ts", "@@", "-old", "+new", "*** End Patch"].join("\n");
    const ctx = makeCtx({ toolName: "apply_patch", input: { command: patch } });
    const result = evaluateDecodedWrites(ctx, {});
    eq(result.handled, true);
    eq(result.decision, null);
    ok(result.advisory.includes("write-payload-ambiguous"), `expected the ambiguous kind, got: ${result.advisory}`);
    ok(
      !result.advisory.includes("write-payload-unrecognised"),
      "an ambiguous parse must not be reported as an unknown shape — the two have different fixes",
    );
  });

  test("Codex's real apply_patch payload — the patch under `command` — decodes into the file it writes", () => {
    // Measured off a live Codex 0.149.1 PreToolUse payload. Before the decoder
    // read this field, every patch Codex wrote decoded to nothing and came
    // back as a hard denial on that host.
    const patch = ["*** Begin Patch", "*** Add File: src/new.ts", "+export const a = 1;", "*** End Patch"].join("\n");
    const ctx = makeCtx({ toolName: "apply_patch", input: { command: patch } });
    const result = evaluateDecodedWrites(ctx, { rules: [denyOnPathSuffix("deny-new", "new.ts")] });
    eq(result.handled, true);
    eq(result.decision.action, "deny");
    eq(result.decision.ruleId, "deny-new");
  });

  test("a single decoded write is judged exactly like a direct Write call", () => {
    const ctx = makeCtx({ toolName: "Write", input: { file_path: "src/a.ts", content: "x" } });
    const result = evaluateDecodedWrites(ctx, { rules: [denyOnPathSuffix("deny-a", "a.ts")] });
    eq(result.handled, true);
    eq(result.decision.action, "deny");
    eq(result.decision.ruleId, "deny-a");
  });

  test("several decoded writes combine by strongest-wins: a deny on one file beats an ask on another", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/one.ts",
      "+export const one = 1;",
      "*** Add File: src/two.ts",
      "+export const two = 2;",
      "*** End Patch",
    ].join("\n");
    const ctx = makeCtx({ toolName: "apply_patch", input: { patch } });
    const result = evaluateDecodedWrites(ctx, {
      rules: [askOnPathSuffix("ask-one", "one.ts"), denyOnPathSuffix("deny-two", "two.ts")],
    });
    eq(result.handled, true);
    eq(result.decision.action, "deny");
    eq(result.decision.ruleId, "deny-two");
  });

  test("several decoded writes at the same severity keep the first file's own decision", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/x.ts",
      "+export const x = 1;",
      "*** Add File: src/y.ts",
      "+export const y = 2;",
      "*** End Patch",
    ].join("\n");
    const ctx = makeCtx({ toolName: "apply_patch", input: { patch } });
    const result = evaluateDecodedWrites(ctx, { rules: [denyOnPathSuffix("deny-any-ts", ".ts")] });
    eq(result.handled, true);
    eq(result.decision.action, "deny");
    eq(result.decision.reason, `denied ${path.resolve(ctx.git.repoRoot, "src/x.ts")}`);
  });

  test("a MultiEdit call's content is visible to a content rule, not only its path", () => {
    // The other half of the defect this module closes: `MultiEdit`'s text
    // lives inside `edits[]`, which `buildContext` never reads at all — the
    // path rule fires, the content rule stays silent, until this wiring.
    const contentRule = {
      id: "deny-secret-content",
      title: "test-only: deny content containing the word secret",
      events: ["PreToolUse"],
      tools: null,
      defaultAction: "deny",
      group: "code",
      requiresConfig: [],
      evaluate(ctx) {
        return ctx.content.includes("secret") ? deny("content rule fired") : pass();
      },
    };
    const ctx = makeCtx({
      toolName: "MultiEdit",
      input: {
        file_path: "src/a.ts",
        edits: [{ old_string: "public", new_string: "secret" }],
      },
      files: { "src/a.ts": "export const token = public_value;" },
    });
    const result = evaluateDecodedWrites(ctx, { rules: [contentRule] });
    eq(result.handled, true);
    eq(result.decision.action, "deny");
    eq(result.decision.ruleId, "deny-secret-content");
  });

  /* --------------------------------------------------- F2: ambiguous header collision */

  test("F2: a header-shaped, unprefixed context line inside a still-context-only hunk is reported instead of silently dropping the real edit", () => {
    // Reproduces the worse-than-nothing false pass: before the fix, this
    // malformed hunk (missing leading space on a context line that itself
    // reads like a section header — this repository's own patch-grammar
    // source and fixtures are full of that exact text) split into a real
    // section carrying only leading context and a phantom section for a
    // path that does not exist, so the real `id: any` change never reached
    // no-explicit-any's own ratchet and the write silently passed.
    const filePath = "src/types/WorseThanNothingRegression.ts";
    const onDisk =
      "export type WorseThanNothingRegression = {\n" +
      '  marker: "*** Update File: sneaky.ts",\n' +
      "  id: string;\n" +
      "};\n";
    const patch = [
      "*** Begin Patch",
      "*** Update File: " + filePath,
      " export type WorseThanNothingRegression = {",
      "*** Update File: sneaky.ts", // malformed: missing leading context space
      "-  id: string;",
      "+  id: any;",
      " };",
      "*** End Patch",
    ].join("\n");

    const ctx = makeCtx({ toolName: "apply_patch", input: { input: patch }, files: { [filePath]: onDisk } });
    const result = evaluateDecodedWrites(ctx, { rules: [noExplicitAnyRule] });

    eq(result.handled, true);
    // The point of this regression test is that the edit is never SILENTLY
    // dropped. It is now reported rather than blocked — the parse itself was
    // ambiguous, which is a fact about this patch, so the advisory says so and
    // points at the patch rather than at the decoder.
    eq(result.decision, null);
    ok(result.advisory.includes("write-payload-ambiguous"), `expected the ambiguous kind, got: ${result.advisory}`);
    ok(result.advisory.includes("NOT checked"), "the advisory must state plainly that no rule ran");
  });

  /* ------------------------------------------------------- F3: patch-manifest ratchet */

  test("F3: an Edit touching only an unrelated line does not deny on a pre-existing unpaired declaration it never went near", () => {
    // Reproduces the false denial end to end: `evaluateDecodedWrites`
    // reconstructs the WHOLE manifest for this Edit (not only the inserted
    // snippet), so `patch-manifest` now sees a pre-existing gap the write
    // itself never touches. Before the ratchet fix this denied unconditionally.
    const filePath = "deploy/patch.manifest.xml";
    const onDisk =
      "<Manifest>\n" +
      '  <Database table="Orders">\n' +
      "    <Comment>adds a column, added long before today's edit</Comment>\n" +
      "  </Database>\n" +
      "  <Note>TODO: update this note</Note>\n" +
      "</Manifest>\n";

    const ctx = makeCtx({
      toolName: "Edit",
      filePath,
      input: {
        file_path: filePath,
        old_string: "<Note>TODO: update this note</Note>",
        new_string: "<Note>done</Note>",
      },
      project: PROJECT_BACKEND,
      files: { [filePath]: onDisk },
    });

    const result = evaluateDecodedWrites(ctx, { rules: [patchManifestRule] });
    eq(result.handled, true);
    eq(result.decision, null);
  });

  test("F3: an Edit that introduces a NEW unpaired declaration still denies — the ratchet only forgives what was already there", () => {
    const filePath = "deploy/patch.manifest.xml";
    const onDisk =
      "<Manifest>\n" +
      '  <Database table="Orders">\n' +
      "    <UpgradeScript>001_orders.sql</UpgradeScript>\n" +
      "  </Database>\n" +
      "</Manifest>\n";

    const ctx = makeCtx({
      toolName: "Edit",
      filePath,
      input: {
        file_path: filePath,
        old_string: "</Manifest>",
        new_string: '  <Database table="Invoices">\n    <Comment>no script yet</Comment>\n  </Database>\n</Manifest>',
      },
      project: PROJECT_BACKEND,
      files: { [filePath]: onDisk },
    });

    const result = evaluateDecodedWrites(ctx, { rules: [patchManifestRule] });
    eq(result.handled, true);
    ok(result.decision && result.decision.action === "deny", "a genuinely new unpaired declaration must still deny");
  });
});
