"use strict";

const fs = require("fs");
const path = require("path");

const { suite } = require("../harness");
const { buildContext, makeReadFile, makeFileExists, makeStatFile } = require("../../core/lib/context");

suite("lib/context", ({ test, eq, ok, deepEq, tmpdir, fixture }) => {
  /**
   * Builds a controlled `buildContext` call: a tmp cwd outside any git
   * repository (so project resolution deterministically falls back to a
   * fixture `_default`), and a non-existent overrides file, so the result
   * never depends on the host machine's real `~/.claude`.
   *
   * @param {object} payload The raw payload to normalise.
   * @returns {object} The built context.
   */
  function build(payload) {
    const dir = tmpdir();
    const defaultFile = fixture("projects/_default.json", { id: "_default", baseBranches: [] });
    return buildContext(payload, {
      agent: "claude",
      projectsDir: path.dirname(defaultFile),
      overridesFile: path.join(dir, "overrides.json"),
    });
  }

  /* --------------------------------------------------------------- event */

  test("event: hook_event_name", () => eq(build({ hook_event_name: "PreToolUse" }).event, "PreToolUse"));
  test("event: hookEventName", () => eq(build({ hookEventName: "PreToolUse" }).event, "PreToolUse"));
  test("event: event", () => eq(build({ event: "PreToolUse" }).event, "PreToolUse"));
  test("event: event_name", () => eq(build({ event_name: "PreToolUse" }).event, "PreToolUse"));

  /* ------------------------------------------------------------ tool name */

  test("toolName: tool_name", () => eq(build({ tool_name: "Bash" }).toolName, "Bash"));
  test("toolName: toolName", () => eq(build({ toolName: "Bash" }).toolName, "Bash"));
  test("toolName: tool", () => eq(build({ tool: "Bash" }).toolName, "Bash"));
  test("toolName: name", () => eq(build({ name: "Bash" }).toolName, "Bash"));

  /* ----------------------------------------------------------- tool input */

  test("input: tool_input object", () => {
    deepEq(build({ tool_input: { command: "git push" } }).input, { command: "git push" });
  });
  test("input: toolInput object", () => {
    deepEq(build({ toolInput: { command: "git push" } }).input, { command: "git push" });
  });
  test("input: input object", () => {
    deepEq(build({ input: { command: "git push" } }).input, { command: "git push" });
  });
  test("input: arguments object", () => {
    deepEq(build({ arguments: { command: "git push" } }).input, { command: "git push" });
  });
  test("input: params object", () => {
    deepEq(build({ params: { command: "git push" } }).input, { command: "git push" });
  });
  test("input: a JSON string is parsed", () => {
    const ctx = build({ tool_input: '{"command":"git push"}' });
    deepEq(ctx.input, { command: "git push" });
    eq(ctx.command, "git push");
  });
  test("input: a non-JSON string falls back to an empty object", () => {
    deepEq(build({ tool_input: "not json" }).input, {});
  });

  /* --------------------------------------------------------------- command */

  test("command: input.command", () => eq(build({ tool_input: { command: "git push" } }).command, "git push"));
  test("command: input.cmd", () => eq(build({ tool_input: { cmd: "git push" } }).command, "git push"));
  test("command: input.script", () => eq(build({ tool_input: { script: "git push" } }).command, "git push"));
  test("command: an argv array is joined with spaces", () => {
    eq(build({ tool_input: { command: ["git", "push", "origin", "HEAD"] } }).command, "git push origin HEAD");
  });
  test("command: absent yields an empty string", () => eq(build({ tool_input: {} }).command, ""));

  test("command: an argv element with whitespace stays one quoted argument", () => {
    const trailer = "Add feature\n\nCo-Authored-By: Claude <noreply@anthropic.com>";
    const ctx = build({ tool_input: { command: ["git", "commit", "-m", trailer] } });
    const { extractQuoted } = require("../../core/lib/shell-parse");
    eq(extractQuoted(ctx.command, "-m"), trailer);
  });

  test("command: an argv element with a shell metacharacter cannot fabricate a second statement", () => {
    const { splitStatements } = require("../../core/lib/shell-parse");
    const ctx = build({ tool_input: { command: ["echo", "hi; rm -rf /"] } });
    deepEq(splitStatements(ctx.command), [ctx.command]);
  });

  test("command: a bare argv metacharacter element also cannot fabricate a second statement", () => {
    const { splitStatements } = require("../../core/lib/shell-parse");
    const ctx = build({ tool_input: { command: ["git", "status", "&&", "rm", "-rf", "/"] } });
    eq(splitStatements(ctx.command).length, 1);
  });

  test("command: a string command is never re-quoted (parity path stays unchanged)", () => {
    const raw = 'git commit -m "Add feature\n\nCo-Authored-By: Claude <noreply@anthropic.com>"';
    eq(build({ tool_input: { command: raw } }).command, raw);
  });

  /* -------------------------------------------------------------- filePath */

  // A relative file_path is now normalised to absolute against the resolved
  // `ctx.cwd` (CONTRACTS.md's workdir-independence requirement), so these
  // assert the join rather than the raw relative string the host sent.
  test("filePath: input.file_path", () => {
    const ctx = build({ tool_input: { file_path: "a.ts" } });
    eq(ctx.filePath, path.resolve(ctx.cwd, "a.ts"));
  });
  test("filePath: input.filePath", () => {
    const ctx = build({ tool_input: { filePath: "a.ts" } });
    eq(ctx.filePath, path.resolve(ctx.cwd, "a.ts"));
  });
  test("filePath: input.path", () => {
    const ctx = build({ tool_input: { path: "a.ts" } });
    eq(ctx.filePath, path.resolve(ctx.cwd, "a.ts"));
  });
  test("filePath: input.target_file", () => {
    const ctx = build({ tool_input: { target_file: "a.ts" } });
    eq(ctx.filePath, path.resolve(ctx.cwd, "a.ts"));
  });

  test("filePath: a relative file_path is normalised to absolute against the resolved cwd", () => {
    const dir = tmpdir();
    const ctx = build({ cwd: dir, tool_input: { file_path: path.join("src", "a.ts") } });
    eq(ctx.cwd, dir);
    eq(ctx.filePath, path.resolve(dir, "src", "a.ts"));
  });

  test("filePath: an absolute file_path is kept as-is", () => {
    const dir = tmpdir();
    const abs = path.join(dir, "a.ts");
    const ctx = build({ tool_input: { file_path: abs } });
    eq(ctx.filePath, abs);
  });

  test("filePath: absent yields an empty string, never a resolved cwd", () => {
    eq(build({ tool_input: {} }).filePath, "");
  });

  /* --------------------------------------------------------------- content */

  test("content: input.content", () => eq(build({ tool_input: { content: "x" } }).content, "x"));
  test("content: input.new_string", () => eq(build({ tool_input: { new_string: "x" } }).content, "x"));
  test("content: input.newString", () => eq(build({ tool_input: { newString: "x" } }).content, "x"));
  test("content: input.new_str", () => eq(build({ tool_input: { new_str: "x" } }).content, "x"));

  /* ------------------------------------------------------------------ cwd */

  test("cwd: payload.cwd", () => {
    const dir = tmpdir();
    eq(build({ cwd: dir }).cwd, dir);
  });
  test("cwd: payload.workspace", () => {
    const dir = tmpdir();
    eq(build({ workspace: dir }).cwd, dir);
  });
  test("cwd: payload.working_directory", () => {
    const dir = tmpdir();
    eq(build({ working_directory: dir }).cwd, dir);
  });
  test("cwd: falls back to process.cwd()", () => {
    eq(build({}).cwd, process.cwd());
  });

  /* ---------------------------------------------------- workdir resolution */

  test("cwd: an absolute input.workdir is preferred over payload.cwd", () => {
    const opDir = tmpdir();
    const payloadDir = tmpdir();
    const ctx = build({ cwd: payloadDir, tool_input: { workdir: opDir } });
    eq(ctx.cwd, opDir);
  });

  test("cwd: no cwd in the payload but an absolute file_path resolves the FILE's own repository, not process.cwd()", () => {
    const fileRepo = tmpdir();
    fs.mkdirSync(path.join(fileRepo, ".git"));
    const elsewhereRepo = tmpdir();
    fs.mkdirSync(path.join(elsewhereRepo, ".git"));

    const defaultFile = fixture("projects/_default.json", { id: "_default", baseBranches: [] });
    fixture("projects/by-file-repo.json", { id: "by-file-repo", match: { paths: [path.basename(fileRepo)] } });
    const projectsDir = path.dirname(defaultFile);

    const nestedFilePath = path.join(fileRepo, "src", "a.ts");
    const previousCwd = process.cwd();
    process.chdir(elsewhereRepo);
    try {
      const ctx = buildContext(
        { hook_event_name: "PreToolUse", tool_input: { file_path: nestedFilePath } },
        { agent: "claude", projectsDir, overridesFile: path.join(tmpdir(), "overrides.json") },
      );

      eq(ctx.cwd, fileRepo);
      eq(ctx.filePath, nestedFilePath);
      eq(ctx.project.id, "by-file-repo");
      eq(ctx.git.repoRoot, fileRepo);
    } finally {
      process.chdir(previousCwd);
    }
  });

  /* -------------------------------------------------------------- session */

  test("session.model: payload.model", () => eq(build({ model: "sonnet" }).session.model, "sonnet"));
  test("session.model: payload.session.model", () => eq(build({ session: { model: "sonnet" } }).session.model, "sonnet"));
  test("session.model: payload.session_model", () => eq(build({ session_model: "sonnet" }).session.model, "sonnet"));
  test("session.model: null when genuinely unknown", () => eq(build({}).session.model, null));

  test("session.effort: payload.effort", () => eq(build({ effort: "high" }).session.effort, "high"));
  test("session.effort: payload.reasoning_effort", () => eq(build({ reasoning_effort: "high" }).session.effort, "high"));
  test("session.effort: null when genuinely unknown", () => eq(build({}).session.effort, null));

  /* ---------------------------------------------------------- agent id/type */

  test("agentId: payload.agent_id", () => eq(build({ agent_id: "agent-1" }).agentId, "agent-1"));
  test("agentId: payload.agentId", () => eq(build({ agentId: "agent-1" }).agentId, "agent-1"));
  test("agentId: null on a main-thread call", () => eq(build({}).agentId, null));

  test("agentType: payload.agent_type", () => eq(build({ agent_type: "Explore" }).agentType, "Explore"));
  test("agentType: payload.agentType", () => eq(build({ agentType: "Explore" }).agentType, "Explore"));
  test("agentType: null on a main-thread call", () => eq(build({}).agentType, null));

  /* ------------------------------------------------------------- garbage */

  test("a garbage payload produces a usable, empty-ish context instead of throwing", () => {
    let ctx;
    try {
      ctx = buildContext("not even an object", { agent: "claude" });
    } catch {
      ctx = undefined;
    }
    ok(ctx !== undefined);
    eq(ctx.toolName, "");
    eq(ctx.command, "");
    eq(ctx.agentId, null);
    eq(ctx.agentType, null);
    deepEq(ctx.modules, new Set());
    eq(typeof ctx.readFile, "function");
    eq(ctx.readFile("anything"), null);
  });

  // The project id is deliberately NOT asserted here. With no cwd in the
  // payload the resolver falls back to `process.cwd()`, so the answer depends
  // on where the suite happens to run — and it runs inside a repository that
  // now has a project file of its own. The fallback itself is asserted below,
  // from a location that genuinely matches nothing.
  test("null payload produces a usable empty context", () => {
    const ctx = buildContext(null, { agent: "claude" });
    eq(ctx.event, "");
    eq(ctx.toolName, "");
    eq(ctx.command, "");
    ok(ctx.project !== null && typeof ctx.project.id === "string");
  });

  test("a location matching no project falls back to the default", () => {
    const ctx = buildContext({ cwd: tmpdir() }, { agent: "claude" });
    eq(ctx.project.id, "_default");
  });

  test("undefined payload produces a usable empty context", () => {
    const ctx = buildContext(undefined);
    eq(ctx.agent, "claude");
  });

  /* ---------------------------------------- makeReadFile / makeFileExists */

  test("makeReadFile reads an ordinary file inside the boundary", () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n", "utf8");
    const readFile = makeReadFile(dir, { repoRoot: dir });
    eq(readFile("a.ts"), "export const a = 1;\n");
  });

  test("makeFileExists answers true for an ordinary file, false for one that is not there", () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, "a.ts"), "x", "utf8");
    const fileExists = makeFileExists(dir, { repoRoot: dir });
    eq(fileExists("a.ts"), true);
    eq(fileExists("missing.ts"), false);
  });

  test("makeReadFile refuses a path that textually escapes the boundary", () => {
    const dir = tmpdir();
    const outside = tmpdir();
    fs.writeFileSync(path.join(outside, "secret.ts"), "secret", "utf8");
    const readFile = makeReadFile(dir, { repoRoot: dir });
    eq(readFile(path.join(outside, "secret.ts")), null);
  });

  // Gap review (this round): a symlink/junction naming an `Update File:`
  // target. Its OWN path lives inside the boundary, so the cheap textual
  // check alone passes it, and both `fs.existsSync`/`readFileSync` follow it
  // — without resolving it first, content from OUTSIDE the repository was
  // reachable. A directory junction (needs no elevated Windows privilege,
  // unlike a file symlink) exercises the identical boundary-check code path.
  test("a directory junction inside the boundary that points outside it is refused, not silently followed", () => {
    const dir = tmpdir();
    const outside = tmpdir();
    fs.writeFileSync(path.join(outside, "secret.ts"), "export const secret = 1;\n", "utf8");
    fs.symlinkSync(outside, path.join(dir, "linkdir"), "junction");

    const readFile = makeReadFile(dir, { repoRoot: dir });
    const fileExists = makeFileExists(dir, { repoRoot: dir });

    eq(fileExists("linkdir/secret.ts"), false);
    eq(readFile("linkdir/secret.ts"), null);
  });

  // Gap review (this round): a directory-level permission/read failure. A
  // real one needs elevated privileges to reproduce here, but a directory
  // produces the same fail shape `fs.existsSync` reports as `true` (it is
  // there) while reading it as text fails (EISDIR) — pins that
  // `makeFileExists`/`makeReadFile` disagree the way the header-existence
  // invariant needs (see `makeFileExists`'s own doc comment).
  test("gap review: makeFileExists answers true for a directory, but makeReadFile fails to null reading it as text", () => {
    const dir = tmpdir();
    fs.mkdirSync(path.join(dir, "not-a-file"));
    const fileExists = makeFileExists(dir, { repoRoot: dir });
    const readFile = makeReadFile(dir, { repoRoot: dir });
    eq(fileExists("not-a-file"), true);
    eq(readFile("not-a-file"), null);
  });

  test("a repository root that itself sits behind a symlink still resolves ordinary files inside it normally", () => {
    // The boundary-resolution fix must not turn every dev machine whose own
    // checkout (or whose OS temp directory) happens to be reached through a
    // symlink into a false "escaped the boundary" — only a target that
    // resolves OUTSIDE the (equally resolved) boundary is refused.
    const realDir = tmpdir();
    fs.writeFileSync(path.join(realDir, "a.ts"), "export const a = 1;\n", "utf8");
    const parent = tmpdir();
    const linkedRoot = path.join(parent, "repo-link");
    fs.symlinkSync(realDir, linkedRoot, "junction");

    const readFile = makeReadFile(linkedRoot, { repoRoot: linkedRoot });
    eq(readFile("a.ts"), "export const a = 1;\n");
  });

  /* -------------------------------------------------------- makeStatFile */

  test("makeStatFile answers an ordinary file's real byte size without reading its content", () => {
    const dir = tmpdir();
    const content = "export const a = 1;\n";
    fs.writeFileSync(path.join(dir, "a.ts"), content, "utf8");
    const statFile = makeStatFile(dir, { repoRoot: dir });
    eq(statFile("a.ts"), Buffer.byteLength(content, "utf8"));
  });

  test("makeStatFile answers null, not a throw, for a file that is not there", () => {
    const dir = tmpdir();
    const statFile = makeStatFile(dir, { repoRoot: dir });
    eq(statFile("missing.ts"), null);
  });

  test("makeStatFile answers null for a directory — mirrors makeReadFile's own EISDIR failure, not makeFileExists' true", () => {
    const dir = tmpdir();
    fs.mkdirSync(path.join(dir, "not-a-file"));
    const statFile = makeStatFile(dir, { repoRoot: dir });
    eq(statFile("not-a-file"), null);
  });

  test("makeStatFile refuses a path that textually escapes the boundary", () => {
    const dir = tmpdir();
    const outside = tmpdir();
    fs.writeFileSync(path.join(outside, "secret.ts"), "secret content that must stay unseen", "utf8");
    const statFile = makeStatFile(dir, { repoRoot: dir });
    eq(statFile(path.join(outside, "secret.ts")), null);
  });

  test("makeStatFile refuses a directory junction inside the boundary that resolves outside it", () => {
    const dir = tmpdir();
    const outside = tmpdir();
    fs.writeFileSync(path.join(outside, "secret.ts"), "export const secret = 1;\n", "utf8");
    fs.symlinkSync(outside, path.join(dir, "linkdir"), "junction");

    const statFile = makeStatFile(dir, { repoRoot: dir });
    eq(statFile("linkdir/secret.ts"), null);
  });

  test("makeStatFile never throws on a garbage path", () => {
    const dir = tmpdir();
    const statFile = makeStatFile(dir, { repoRoot: dir });
    let threw = false;
    try {
      eq(statFile(""), null);
      eq(statFile(null), null);
      eq(statFile(undefined), null);
    } catch {
      threw = true;
    }
    eq(threw, false);
  });

  test("buildContext exposes ctx.statFile, anchored the same way ctx.readFile is", () => {
    const ctx = build({ tool_name: "Bash" });
    ok(typeof ctx.statFile === "function", "ctx.statFile must be a function");
    eq(ctx.statFile("missing.ts"), null);
  });

  /* ------------------------------------------------------------- frozen */

  test("the returned context is frozen", () => {
    const ctx = build({ tool_name: "Bash" });
    ok(Object.isFrozen(ctx));
  });
});
