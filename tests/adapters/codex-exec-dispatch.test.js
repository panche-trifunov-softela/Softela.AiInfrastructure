"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { suite } = require("../harness");
const { CODEX_DISPATCH, runDispatcher, writeState } = require("./_spawn");
const { buildContext } = require("../../core/lib/context");
const { evaluateExecCall } = require("../../adapters/shared/dispatch-core");
const patchManifestRule = require("../../core/guards/patch-manifest");

/**
 * Builds a Codex `exec` call payload — the single `custom_tool_call` shape
 * every real captured Codex session uses, carrying its JavaScript source
 * under `tool_input.input`.
 *
 * @param {string} source The `exec` call's JavaScript source.
 * @param {string} cwd The working directory to report.
 * @returns {object} A Codex-shaped `PreToolUse` payload.
 */
function execPayload(source, cwd) {
  return { hook_event_name: "PreToolUse", tool_name: "exec", tool_input: { input: source }, cwd };
}

/**
 * Creates a disposable git repository whose `origin` remote matches this
 * repository's own real `projects/Softela.Bugworx.json`, so a real
 * dispatcher run resolves that project's actual `frontend` stack and
 * `componentFolders` convention — the same way a real Codex session working
 * inside that repository would, and the only way to prove
 * `barrel-exports-only` fires through the real dispatcher rather than a
 * test-only stand-in project.
 *
 * @param {() => string} tmpdir The suite's disposable-directory factory.
 * @returns {string} The repository's working directory.
 */
function frontendRepo(tmpdir) {
  const dir = tmpdir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/trifunov/Softela.Bugworx"], {
    cwd: dir,
  });
  return dir;
}

suite("adapters/codex-exec-dispatch", ({ test, eq, ok, tmpdir }) => {
  /* ------------------------------------------------------------ clean call */

  test("a clean exec call with only tools.update_plan passes silently", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    const source = [
      'const plan = await tools.update_plan({plan:[{step:"a",status:"pending"}]});',
      "text(plan);",
    ].join("\n");

    const result = runDispatcher(CODEX_DISPATCH, execPayload(source, cwd), { home, cwd });
    eq(result.code, 0);
    eq(result.stdout, "");
    eq(result.stderr, "");
  });

  /* --------------------------------------------------- C1: shared parser */

  test("C1: a phantom Update File header buried inside an exec-wrapped patch no longer silently reassigns content away from the real file", () => {
    // Regression for the C1 bug: `codex-exec.js` used to carry its own
    // independent patch parser with no existence check at all, so a stray
    // unprefixed line reading like an `*** Update File:` header for an
    // unrelated path silently reassigned every following `+` line onto that
    // ghost path — a real violation vanishing with a total silent pass. Now
    // both paths share `write-decode.js`'s own existence invariant instead.
    const home = tmpdir();
    const repo = frontendRepo(tmpdir);
    const filePath = path.join(repo, "react-app/src/types/GhostProbe.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "export type Foo = {\n};\n", "utf8");

    const patchBodyLines = [
      "*** Begin Patch",
      "*** Update File: react-app/src/types/GhostProbe.ts",
      " export type Foo = {",
      "*** Update File: outside/Ghost.ts",
      "+  bad: any;",
      " };",
      "*** End Patch",
    ];
    const source = [
      `const patch = "${patchBodyLines.join("\\n")}";`,
      "const result = await tools.apply_patch(patch);",
      "text(result);",
    ].join("\n");

    const result = runDispatcher(CODEX_DISPATCH, execPayload(source, repo), { home, cwd: repo });
    eq(result.code, 0);
    // Never a silent pass: no permissionDecision (which would mean the
    // engine judged and cleared it) AND no empty stdout (which is what the
    // bug produced — total silence). An ambiguous envelope must surface as
    // an advisory instead.
    const out = result.parsed && result.parsed.hookSpecificOutput;
    ok(!out || out.permissionDecision === undefined, "an ambiguous exec-wrapped patch must never resolve to a decision");
    ok(result.stdout.includes("additionalContext"), "an ambiguous exec-wrapped patch must surface as an advisory, not silence");
    ok(
      result.parsed.hookSpecificOutput.additionalContext.includes("apply_patch"),
      "the advisory should name the nested tool whose payload could not be extracted",
    );

    // Confirms the file really was left untouched by this dry evaluation —
    // the same "on disk still" check the original probe used.
    eq(fs.readFileSync(filePath, "utf8"), "export type Foo = {\n};\n");
  });

  test("C1: the same clean any-addition, wrapped in exec with no ghost header, still denies through the shared parser", () => {
    const home = tmpdir();
    const repo = frontendRepo(tmpdir);
    const filePath = path.join(repo, "react-app/src/types/CleanProbe.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "export type Foo = {\n};\n", "utf8");

    const patchBodyLines = [
      "*** Begin Patch",
      "*** Update File: react-app/src/types/CleanProbe.ts",
      " export type Foo = {",
      "+  bad: any;",
      " };",
      "*** End Patch",
    ];
    const source = [
      `const patch = "${patchBodyLines.join("\\n")}";`,
      "const result = await tools.apply_patch(patch);",
      "text(result);",
    ].join("\n");

    const result = runDispatcher(CODEX_DISPATCH, execPayload(source, repo), { home, cwd: repo });
    eq(result.code, 0);
    ok(result.parsed !== null, "expected a decision on stdout");
    eq(result.parsed.hookSpecificOutput.permissionDecision, "deny");
    ok(
      result.parsed.hookSpecificOutput.permissionDecisionReason.includes("no-explicit-any"),
      "reason should name the rule that actually fired",
    );
  });

  /* --------------------------------------------------------------- gap */

  test("an exec call wrapping a barrel-violating apply_patch write is denied, naming the nested operation", () => {
    const home = tmpdir();
    const repo = frontendRepo(tmpdir);

    // The real captured pattern: the patch is assigned to a variable as a
    // double-quoted string with escaped newlines, then applied indirectly
    // through `tools.apply_patch(patch)`.
    const source = [
      'const patch = "*** Begin Patch\\n' +
        "*** Add File: react-app/src/components/Widget/index.js\\n" +
        "+export const secret = computeSecret();\\n" +
        '*** End Patch";',
      "const result = await tools.apply_patch(patch);",
      "text(result);",
    ].join("\n");

    const result = runDispatcher(CODEX_DISPATCH, execPayload(source, repo), { home, cwd: repo });
    eq(result.code, 0);
    ok(result.parsed !== null, "expected a decision on stdout");
    eq(result.parsed.hookSpecificOutput.permissionDecision, "deny");

    const reason = result.parsed.hookSpecificOutput.permissionDecisionReason;
    ok(reason.includes("barrel-exports-only"), "reason should name the rule that actually fired");
    ok(reason.includes("apply_patch"), "reason should name the nested operation that caused the denial");
    ok(reason.includes("react-app/src/components/Widget/index.js"), "reason should name the file the nested write targeted");
  });

  /* -------------------------------------------------------- reasoning effort */

  test("an exec call wrapping a nested spawn with reasoning_effort: low is denied, naming the nested call", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    writeState(home, "codex", { modules: ["agent-orchestration"] });

    // The nested spawn sets a real, session-tier-matching model so
    // subagent-model itself stays silent — this call isolates the
    // reasoning-effort-floor path specifically, on Codex's own
    // `reasoning_effort` spelling rather than Claude Code's `effort`.
    const source = [
      "const result = await tools.spawn_agent({model: 'sonnet', reasoning_effort: 'low', prompt: 'do the thing'});",
      "text(result);",
    ].join("\n");

    const result = runDispatcher(CODEX_DISPATCH, execPayload(source, cwd), { home, cwd });
    eq(result.code, 0);
    ok(result.parsed !== null, "expected a decision on stdout");
    eq(result.parsed.hookSpecificOutput.permissionDecision, "deny");

    const reason = result.parsed.hookSpecificOutput.permissionDecisionReason;
    ok(reason.includes("reasoning-effort-floor"), "reason should name the rule that actually fired");
    ok(reason.includes("tools.spawn_agent"), "reason should name the nested call that carried the low effort");
  });

  /* ------------------------------------------------------ shell-write gap */

  test("an exec call wrapping a nested shell_command sed -i write is denied, naming the nested call", () => {
    const home = tmpdir();
    const cwd = tmpdir();

    // The real captured pattern for a shell operation: the command is set as
    // an object property on the nested call rather than passed as a bare
    // string argument.
    const source = [
      'const result = await tools.shell_command({command: "sed -i \'s/a/b/\' src/a.ts"});',
      "text(result);",
    ].join("\n");

    const result = runDispatcher(CODEX_DISPATCH, execPayload(source, cwd), { home, cwd });
    eq(result.code, 0);
    ok(result.parsed !== null, "expected a decision on stdout");
    eq(result.parsed.hookSpecificOutput.permissionDecision, "deny");

    const reason = result.parsed.hookSpecificOutput.permissionDecisionReason;
    ok(reason.includes("shell-file-write"), "reason should name the rule that actually fired");
    ok(reason.includes("shell_command"), "reason should name the nested tool call that ran the write");
    ok(reason.includes("src/a.ts"), "reason should name the file the nested command wrote to");
  });

  /* -------------------------------------------------------- uninspectable */

  test("an exec call whose mutating shell payload cannot be extracted produces an advisory, not a block", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    const source = [
      "const command = buildDynamicCommand();",
      "const r = await tools.shell_command(command);",
      "text(r);",
    ].join("\n");

    const result = runDispatcher(CODEX_DISPATCH, execPayload(source, cwd), { home, cwd });
    eq(result.code, 0);
    ok(result.stdout.trim().length > 0, "an uninspectable nested operation must not pass in total silence");
    ok(result.stdout.includes("additionalContext"), "must be reported as an advisory, not a decision");
    const out = result.parsed && result.parsed.hookSpecificOutput;
    ok(!out || out.permissionDecision === undefined, "an advisory must never carry a permissionDecision — it must not block");
    ok(
      result.parsed.hookSpecificOutput.additionalContext.includes("shell_command"),
      "the advisory should name the nested tool that could not be inspected",
    );
  });

  /* ------------------------------------------------------------- unaffected */

  test("a non-exec payload is unaffected by the exec-unwrapping path", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    // The command text below merely mentions the exec machinery's own
    // vocabulary in prose; since tool_name is not "exec", none of it should
    // ever reach the unwrapper at all.
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "local_shell",
      tool_input: { command: ["echo", "tools.apply_patch and *** Begin Patch are just words here"] },
      cwd,
    };
    const result = runDispatcher(CODEX_DISPATCH, payload, { home, cwd });
    eq(result.code, 0);
    eq(result.stdout, "");
    eq(result.stderr, "");
  });

  /* --------------------------------------------- gap review: exec + patch-manifest */

  test("gap review: patch-manifest's whole-document ratchet still catches a newly-unpaired declaration through the exec-wrapped path", () => {
    // Named explicitly as an unattacked gap: `patch-manifest` needs the
    // WHOLE reconstructed document to pair a declaration correctly — before
    // C1, `codex-exec.js` only surfaced a section's own added lines as
    // `content`, so this rule judged a bare fragment through the exec path.
    // C1 makes `buildOperationContext` set `resultingContent` from the same
    // shared, fully-reconstructed output the direct path already used.
    const repo = tmpdir();
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const manifestPath = path.join(repo, "deploy/patch.manifest.xml");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const onDisk = '<Manifest>\n  <Database table="Orders" />\n  <UpgradeScript for="Orders" />\n</Manifest>\n';
    fs.writeFileSync(manifestPath, onDisk, "utf8");

    // The write adds a SECOND, unpaired declaration — a genuinely new
    // violation the pairing logic can only see by reading the whole
    // resulting document, not merely the section's own added lines (which,
    // on their own, are just `<Database table="Invoices" />` with nothing
    // around it to prove it lacks an entry anywhere in the real file).
    const patchBodyLines = [
      "*** Begin Patch",
      "*** Update File: deploy/patch.manifest.xml",
      " <Manifest>",
      '   <Database table="Orders" />',
      '   <UpgradeScript for="Orders" />',
      "+  <Database table=\"Invoices\" />",
      " </Manifest>",
      "*** End Patch",
    ];
    const source = [
      `const patch = "${patchBodyLines.join("\\n")}";`,
      "const result = await tools.apply_patch(patch);",
      "text(result);",
    ].join("\n");

    const baseCtx = buildContext(
      { hook_event_name: "PreToolUse", tool_name: "exec", tool_input: { input: source }, cwd: repo },
      { agent: "codex" },
    );
    const ctx = {
      ...baseCtx,
      project: {
        ...baseCtx.project,
        stacks: undefined,
        stack: "backend",
        patchManifest: {
          filePattern: "patch\\.manifest\\.xml$",
          databasePattern: "<Database",
          requiredEntry: "UpgradeScript",
        },
      },
    };

    const result = evaluateExecCall(ctx, source, { rules: [patchManifestRule], diagnostics: [] });
    ok(result.decision, "a newly-unpaired declaration reached through the exec-wrapped path must still deny");
    eq(result.decision.action, "deny");
    eq(result.decision.ruleId, "patch-manifest");
    ok(result.decision.reason.includes("counted as new"), "reason should explain the identity ratchet's own comparison");
  });
});
