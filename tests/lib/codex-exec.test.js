"use strict";

const { suite } = require("../harness");
const { extractOperations } = require("../../core/lib/codex-exec");

suite("lib/codex-exec", ({ test, eq, deepEq, ok }) => {
  /* --------------------------------------------------------- no mutation */

  test("an exec call with no mutating nested tool extracts nothing", () => {
    const source = [
      'const plan = await tools.update_plan({plan:[{step:"a",status:"pending"}]});',
      "text(plan);",
    ].join("\n");
    deepEq(extractOperations(source), []);
  });

  test("tolerates a non-string, empty, or garbage source", () => {
    deepEq(extractOperations(""), []);
    deepEq(extractOperations(null), []);
    deepEq(extractOperations(undefined), []);
    deepEq(extractOperations("not javascript at all {{{"), []);
  });

  /* -------------------------------------------------------------- patch */

  test("a patch assigned to a variable first, then applied indirectly, is still extracted", () => {
    // The exact real-capture pattern: a double-quoted string carrying
    // escaped newlines, assigned to a variable, applied indirectly. Decoded
    // through the shared grammar (`write-decode.js#decodePatchBody`), so
    // `content` is the whole reconstructed file, needing a real `pathExists`.
    const source = [
      'const patch = "*** Begin Patch\\n*** Update File: src/Widget.ts\\n@@\\n' +
        ' function widget() {\\n+  console.log(1);\\n }\\n*** End Patch";',
      "const result = await tools.apply_patch(patch);",
    ].join("\n");

    const readFile = (p) => (p === "src/Widget.ts" ? "function widget() {\n}\n" : null);
    const pathExists = (p) => p === "src/Widget.ts";

    const ops = extractOperations(source, readFile, pathExists);
    eq(ops.length, 1);
    eq(ops[0].kind, "write");
    eq(ops[0].toolName, "apply_patch");
    eq(ops[0].filePath, "src/Widget.ts");
    eq(ops[0].action, "update");
    eq(ops[0].content, "function widget() {\n  console.log(1);\n}\n");
  });

  test("an Update File header naming a path pathExists reports as absent is uninspectable, not a guess", () => {
    // The C1 fix itself: codex-exec.js no longer accepts an Update/Delete
    // header on faith the way its own independent parser used to.
    const source = [
      'const patch = "*** Begin Patch\\n*** Update File: ghost.ts\\n @@\\n+bad: any;\\n*** End Patch";',
      "const result = await tools.apply_patch(patch);",
    ].join("\n");

    const ops = extractOperations(source, () => null, () => false);
    eq(ops.length, 1);
    eq(ops[0].kind, "uninspectable");
    eq(ops[0].toolName, "apply_patch");
    eq(ops[0].category, "file write");
  });

  test("no reader supplied at all defaults to the fail-safe direction: an Update File header is uninspectable, never trusted", () => {
    const source = [
      'const patch = "*** Begin Patch\\n*** Update File: src/Widget.ts\\n @@\\n+bad: any;\\n*** End Patch";',
      "const result = await tools.apply_patch(patch);",
    ].join("\n");

    const ops = extractOperations(source);
    eq(ops.length, 1);
    eq(ops[0].kind, "uninspectable");
    eq(ops[0].category, "file write");
  });

  test("Add File and Delete File sections in the same envelope each produce their own operation", () => {
    // An Add File header is exempt from the existence check (a new file
    // legitimately need not exist yet); a Delete File header still needs
    // pathExists to confirm the file it names is really there.
    const source = [
      'const patch = "*** Begin Patch\\n' +
        '*** Add File: src/New.ts\\n' +
        '+export const x = 1;\\n' +
        '*** Delete File: src/Old.ts\\n' +
        '*** End Patch";',
      "await tools.apply_patch(patch);",
    ].join("\n");

    const pathExists = (p) => p === "src/Old.ts";
    const ops = extractOperations(source, () => null, pathExists);
    eq(ops.length, 2);
    eq(ops[0].action, "add");
    eq(ops[0].filePath, "src/New.ts");
    eq(ops[0].content, "export const x = 1;");
    eq(ops[1].action, "delete");
    eq(ops[1].filePath, "src/Old.ts");
    eq(ops[1].content, null);
  });

  test("a patch envelope found only inside a piped shell command is still extracted as a write, alongside the shell call itself", () => {
    // Mirrors a real captured sample: the patch is a template literal
    // (real newlines, no escaping needed), never passed to
    // `tools.apply_patch` at all — it is piped into an external `apply_patch`
    // binary through `tools.shell_command`, referenced by shorthand.
    const source = [
      "const patch = `*** Begin Patch",
      "*** Add File: src/components/Widget/index.ts",
      "+export const secret = computeSecret();",
      "*** End Patch`;",
      'const command = "echo apply patch here";',
      'const r = await tools.shell_command({command,workdir:"C:\\\\repo",timeout_ms:30000});',
      "text(r);",
    ].join("\n");

    const ops = extractOperations(source);
    const write = ops.find((op) => op.kind === "write");
    const shell = ops.find((op) => op.kind === "shell");

    ok(write, "expected the patch block to be extracted as a write operation");
    eq(write.filePath, "src/components/Widget/index.ts");
    eq(write.action, "add");
    eq(write.content, "export const secret = computeSecret();");

    ok(shell, "expected the shell_command call to be extracted");
    eq(shell.toolName, "shell_command");
    eq(shell.command, "echo apply patch here");
    eq(shell.cwd, "C:\\repo");
  });

  /* -------------------------------------------------------------- shell */

  test("a direct object-literal command and workdir are extracted", () => {
    const source = [
      'const r = await tools.shell_command({command:"git status --short",workdir:"C:\\\\repo",timeout_ms:1000});',
      "text(r);",
    ].join("\n");

    const ops = extractOperations(source);
    eq(ops.length, 1);
    eq(ops[0].kind, "shell");
    eq(ops[0].command, "git status --short");
    eq(ops[0].cwd, "C:\\repo");
  });

  test("a shell-like call with no discoverable command becomes an uninspectable operation, not silence", () => {
    const source = [
      "const command = buildDynamicCommand();",
      "const r = await tools.shell_command(command);",
      "text(r);",
    ].join("\n");

    const ops = extractOperations(source);
    eq(ops.length, 1);
    eq(ops[0].kind, "uninspectable");
    eq(ops[0].toolName, "shell_command");
    eq(ops[0].category, "shell command");
  });

  /* ------------------------------------------------------------- spawn */

  test("a spawn call's literal model and reasoning_effort are extracted", () => {
    const source = [
      'const r = await tools.spawn_agent({model:"sonnet", reasoning_effort:"high", prompt:"do the work"});',
    ].join("\n");

    const ops = extractOperations(source);
    eq(ops.length, 1);
    eq(ops[0].kind, "spawn");
    eq(ops[0].toolName, "spawn_agent");
    deepEq(ops[0].input, { model: "sonnet", reasoning_effort: "high" });
  });

  test("a spawn call that never mentions a model at all is a normal, non-uninspectable spawn", () => {
    const source = ['const r = await tools.spawn_agent({prompt:"do the work"});'].join("\n");

    const ops = extractOperations(source);
    eq(ops.length, 1);
    eq(ops[0].kind, "spawn");
    deepEq(ops[0].input, {});
  });

  test("a spawn call whose model is set through an unresolved expression is flagged uninspectable", () => {
    const source = [
      "const cfg = pickConfig();",
      'const r = await tools.spawn_agent({model: cfg.model, prompt:"do the work"});',
    ].join("\n");

    const ops = extractOperations(source);
    const uninspectable = ops.find((op) => op.kind === "uninspectable");
    ok(uninspectable, "expected an uninspectable entry for the unresolved model expression");
    eq(uninspectable.category, "subagent spawn");
  });

  /* ---------------------------------------------------------- nested exec */

  test("a nested tools.exec call site is flagged uninspectable when its own opaque payload carries no visible content", () => {
    // Codex re-exposing its own indirection tool one level down, built from a
    // variable with no literal text in this source — the same fundamental
    // limit `extractShellOperations` hits for a dynamic shell command.
    // `tools.exec` matches none of the other three name regexes, so without
    // this check the whole nested call would vanish with zero signal.
    const source = ["const inner = buildNestedExecPayload();", "const r = await tools.exec(inner);"].join("\n");

    const ops = extractOperations(source);
    eq(ops.length, 1);
    eq(ops[0].kind, "uninspectable");
    eq(ops[0].category, "nested exec call");
    eq(ops[0].toolName, "exec");
  });

  test("a nested tools.exec call whose own inline patch envelope is literal text is still both extracted AND flagged", () => {
    // The nested envelope is real V4A grammar, assigned to a variable and
    // passed by reference — the exact indirection pattern this module
    // already tolerates for the OUTER call — so the flat, nesting-agnostic
    // block scan finds it regardless of which `tools.<name>(` call actually
    // wraps it. The redundant "nested exec call" advisory costs nothing: it
    // is only ever surfaced when nothing else in the call already denied.
    const source = [
      'const patch = "*** Begin Patch\\n*** Add File: src/New.ts\\n+export const x = 1;\\n*** End Patch";',
      "const r = await tools.exec(patch);",
    ].join("\n");

    const ops = extractOperations(source);
    const write = ops.find((op) => op.kind === "write");
    const nested = ops.find((op) => op.kind === "uninspectable" && op.category === "nested exec call");
    ok(write, "expected the inline patch envelope to still be extracted as a write");
    eq(write.filePath, "src/New.ts");
    ok(nested, "expected the nested exec call site to also be reported");
  });
});
