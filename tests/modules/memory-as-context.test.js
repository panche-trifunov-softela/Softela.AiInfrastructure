"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { suite } = require("../harness");
const {
  loadModule,
  validateModuleJson,
  renderPrompt,
  unsubstitutedTokens,
  runInstall,
  snapshotAgentHome,
  paths,
} = require("./_helpers");
const {
  resolveMemoryDir,
  isSharedMemoryDir,
  sanitize,
  TOOL_OWNED_DIRNAME,
  HOME_LOCATION_DIRNAME,
  CODEX_NATIVE_MEMORIES_DIRNAME,
} = require("../../modules/memory-as-context/hooks/memory-location");
const { extractDeveloperTurns } = require("../../modules/memory-as-context/hooks/transcript");

const MODULE_ID = "memory-as-context";
const HOOKS_DIR = path.join(paths.repoRoot(), "modules", MODULE_ID, "hooks");

/**
 * A directory guaranteed to hold no `module.json`, handed to every hook
 * subprocess this file spawns as `seed-memory.js`'s catalogue-directory
 * override.
 *
 * `inject-memory.js` now seeds before it reads (see `seed-memory.js`), and
 * every test in this file is about the pre-existing reading/guarding/
 * committing behaviour, not about seeding — which additionally must never
 * depend on this repository's own real `modules/memory-as-context/seed/`
 * content, since a sibling task populates that directory independently and
 * it may hold anywhere from zero to many files at the moment these tests
 * run. Pointing the override here makes `resolveModuleCatalogDir()` resolve
 * to nothing, so seeding is a guaranteed no-op for every call in this file —
 * exactly the "pure reader" behaviour these tests were already written
 * against. `tests/modules/memory-as-context-seed.test.js` is what exercises
 * seeding itself, against its own fixtures.
 */
let NO_SEED_CATALOG_DIR;

/**
 * Runs one of this module's hook scripts as a real subprocess, exactly the
 * way the installed dispatcher command invokes it — through stdin JSON and
 * `--key=value` arguments, never by requiring its internals. Always carries
 * the {@link NO_SEED_CATALOG_DIR} override, so no test in this file can be
 * affected by this module's own real, independently-evolving seed content.
 *
 * @param {string} script The script's file name under `hooks/`.
 * @param {string[]} args Extra `--key=value` arguments.
 * @param {object} payload The JSON payload written to stdin.
 * @returns {string} The process's stdout, `""` for a silent pass.
 */
function runHook(script, args, payload) {
  return execFileSync(process.execPath, [path.join(HOOKS_DIR, script), ...args], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, SOFTELA_AI_SEED_CATALOG_DIR: NO_SEED_CATALOG_DIR },
  });
}

/**
 * Runs one of this module's hook scripts with raw, unencoded text on stdin —
 * for payload shapes `JSON.stringify` cannot produce, such as empty input or
 * genuinely malformed JSON. Carries the same {@link NO_SEED_CATALOG_DIR}
 * override as {@link runHook}.
 *
 * @param {string} script The script's file name under `hooks/`.
 * @param {string[]} args Extra `--key=value` arguments.
 * @param {string} rawInput The exact text written to stdin.
 * @returns {string} The process's stdout, `""` for a silent pass.
 */
function runHookRaw(script, args, rawInput) {
  return execFileSync(process.execPath, [path.join(HOOKS_DIR, script), ...args], {
    input: rawInput,
    encoding: "utf8",
    env: { ...process.env, SOFTELA_AI_SEED_CATALOG_DIR: NO_SEED_CATALOG_DIR },
  });
}

/**
 * Builds a standard argument list for a hostile-payload crash-safety case —
 * every flag every one of this module's scripts might read, so no script
 * exits early for lacking a flag it actually needs.
 *
 * @param {string} agentHome A real, disposable agent home directory.
 * @returns {string[]} `--agent=claude --agent-home=<home> --location=infrastructure --checkpoint=on`.
 */
function crashSafetyArgs(agentHome) {
  return ["--agent=claude", `--agent-home=${agentHome}`, "--location=infrastructure", "--checkpoint=on"];
}

/**
 * Builds the `"global"` memory root for a given agent home, matching what
 * {@link resolveMemoryDir} itself resolves for that location — the agent's
 * own global memory directory, shared with whatever the developer already
 * keeps there, never a directory nested under {@link TOOL_OWNED_DIRNAME}.
 *
 * @param {string} agentHome The agent home directory.
 * @returns {string} `<agentHome>/memory`.
 */
function homeMemoryRoot(agentHome) {
  return path.join(agentHome, HOME_LOCATION_DIRNAME);
}

suite("modules/memory-as-context", ({ test, eq, deepEq, ok, notThrows, tmpdir, fakeHome }) => {
  const mod = loadModule(MODULE_ID);
  NO_SEED_CATALOG_DIR = tmpdir();

  test("module.json validates against the shape MODULES.md documents", () => {
    deepEq(validateModuleJson(mod), []);
  });

  test("ships no guard — the write guard is a standalone script outside core/guards/", () => {
    eq(mod.json.guards.length, 0);
  });

  test("declares the nine generalised hook scripts, and each is a readable file", () => {
    const hookToPaths = mod.json.files.map((f) => f.to).filter((to) => to.startsWith("hooks/")).sort();
    deepEq(hookToPaths, [
      "hooks/compact-checkpoint.js",
      "hooks/git-commit.js",
      "hooks/guard-memory.js",
      "hooks/inject-memory.js",
      "hooks/memory-autocommit.js",
      "hooks/memory-location.js",
      "hooks/seed-memory.js",
      "hooks/stdin.js",
      "hooks/transcript.js",
    ]);
  });

  test("declares ACTIVE-WORK.tmpl.md, and it is a readable file", () => {
    const toPaths = mod.json.files.map((f) => f.to);
    ok(toPaths.includes("ACTIVE-WORK.tmpl.md"), "module.json must ship the ACTIVE-WORK.md template");
  });

  test("every file under seed/ has a matching files[] entry, and vice versa — no hand-maintained drift", () => {
    const seedDir = path.join(mod.dir, "seed");
    const onDisk = fs
      .readdirSync(seedDir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => `seed/${name}`)
      .sort();
    const declared = mod.json.files
      .map((f) => f.to)
      .filter((to) => to.startsWith("seed/"))
      .sort();
    deepEq(declared, onDisk, "modules/memory-as-context/module.json files[] must exactly mirror modules/memory-as-context/seed/*.md on disk");
  });

  test("declares the location option with global as its default", () => {
    eq(mod.json.options.location.type, "enum");
    eq(mod.json.options.location.default, "global");
    deepEq(mod.json.options.location.values.slice().sort(), ["global", "infrastructure", "repo"]);
  });

  test("declares the checkpoint option with on as its default", () => {
    eq(mod.json.options.checkpoint.type, "enum");
    eq(mod.json.options.checkpoint.default, "on");
    deepEq(mod.json.options.checkpoint.values.slice().sort(), ["off", "on"]);
  });

  test("prompt.md and MODULES.md describe the seed as this repository's own Softela knowledge base, never as generic or host-agnostic content — a wording the shipped seed files, which name real Softela repositories directly, flatly contradict", () => {
    const modulesMd = fs.readFileSync(path.join(paths.repoRoot(), "docs", "internal", "MODULES.md"), "utf8");

    for (const [label, text] of [["prompt.md", mod.promptText], ["docs/internal/MODULES.md", modulesMd]]) {
      ok(typeof text === "string" && text.length > 0, `${label} must be readable`);
      ok(
        !/general,?\s+host-agnostic\s+(practices|starter)/i.test(text) && !/never anything project-specific/i.test(text),
        `${label} must not claim the seed is generic, host-agnostic practice with nothing project-specific — it is this repository's own Softela knowledge base`,
      );
      ok(
        /softela/i.test(text),
        `${label} must name what the seed actually is — the Softela knowledge base — wherever it describes the seed`,
      );
    }
  });

  test("registers compact-checkpoint.js on PreCompact for both agents, and inject-memory.js on Codex's PostCompact", () => {
    const events = mod.json.hooks.map((h) => `${h.agent}:${h.event}`).sort();
    ok(events.includes("claude:PreCompact"), "Claude Code must register the checkpoint hook on PreCompact");
    ok(events.includes("codex:PreCompact"), "Codex must register the checkpoint hook on PreCompact");
    ok(events.includes("codex:PostCompact"), "Codex must re-inject memory on PostCompact, since Claude Code has no equivalent event");
    ok(!events.includes("claude:PostCompact"), "Claude Code has no PostCompact event — SessionStart's compact matcher already covers it");
  });

  test("prompt.md renders with no unsubstituted placeholder", () => {
    const rendered = renderPrompt(mod);
    deepEq(unsubstitutedTokens(rendered), []);
  });

  /* ------------------------------------------------ location resolution */

  test("resolveMemoryDir: global is the agent's own global memory directory, for a Claude home", () => {
    eq(resolveMemoryDir({ agentHome: "/home/.claude", cwd: "/anywhere", location: "global" }), path.join("/home/.claude", "memory"));
  });

  test("resolveMemoryDir: global is the agent's own global memory directory, for a Codex home", () => {
    eq(resolveMemoryDir({ agentHome: "/home/.codex", cwd: "/anywhere", location: "global" }), path.join("/home/.codex", "memory"));
  });

  test("resolveMemoryDir: infrastructure still resolves to a per-project folder inside the tool's own directory", () => {
    const dir = tmpdir();
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const projectId = sanitize(path.basename(dir));
    eq(resolveMemoryDir({ agentHome: "/home", cwd: dir, location: "infrastructure" }), path.join("/home", "softela-ai", "memory", projectId));
  });

  test("resolveMemoryDir: infrastructure falls back to a 'default' project when cwd is not a git repo", () => {
    const dir = tmpdir();
    eq(resolveMemoryDir({ agentHome: "/home", cwd: dir, location: "infrastructure" }), path.join("/home", "softela-ai", "memory", "default"));
  });

  test("resolveMemoryDir: repo falls back to global when cwd is not inside a git repository", () => {
    const dir = tmpdir();
    eq(resolveMemoryDir({ agentHome: "/home", cwd: dir, location: "repo" }), path.join("/home", "memory"));
  });

  test("resolveMemoryDir: repo resolves inside the product repository when cwd is a git repo", () => {
    const dir = tmpdir();
    execFileSync("git", ["init", "-q"], { cwd: dir });
    eq(resolveMemoryDir({ agentHome: "/home", cwd: dir, location: "repo" }), path.join(dir, ".softela-ai-memory"));
  });

  test("resolveMemoryDir: global resolves to exactly <agentHome>/memory, never inside <agentHome>/softela-ai", () => {
    const resolved = resolveMemoryDir({ agentHome: "/home", cwd: "/anywhere", location: "global" });
    eq(resolved, path.join("/home", "memory"));
    ok(!resolved.startsWith(path.join("/home", "softela-ai") + path.sep), "global must never nest under the tool-owned directory");
  });

  test("resolveMemoryDir: infrastructure and repo never resolve to the agent's own global memory directory, or anywhere beneath it", () => {
    const dir = tmpdir();
    const repoDir = tmpdir();
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    const globalDir = path.join("/home", "memory");
    const forbiddenPrefix = `${globalDir}${path.sep}`;

    const resolved = [
      resolveMemoryDir({ agentHome: "/home", cwd: dir, location: "infrastructure" }),
      resolveMemoryDir({ agentHome: "/home", cwd: repoDir, location: "infrastructure" }),
      // "repo" only avoids the global directory when cwd is actually inside a
      // git repository — outside one it deliberately falls back to "global",
      // covered by its own dedicated test above, so this array uses repoDir.
      resolveMemoryDir({ agentHome: "/home", cwd: repoDir, location: "repo" }),
    ];

    for (const p of resolved) {
      ok(p !== globalDir, `${p} must never equal the agent's own global memory directory itself`);
      ok(!p.startsWith(forbiddenPrefix), `${p} must never nest inside the agent's own global memory directory`);
    }

    // "repo" resolved inside a real git repo is the one exception this
    // module ever creates outside the tool-owned directory — it belongs to
    // the product repository instead, and must equal neither the global
    // directory nor any tool-owned path.
    const repoLocated = resolveMemoryDir({ agentHome: "/home", cwd: repoDir, location: "repo" });
    eq(repoLocated, path.join(repoDir, ".softela-ai-memory"));
  });

  test("resolveMemoryDir: global never collides with Codex's own native <agentHome>/memories directory", () => {
    for (const agentHome of ["/home/.claude", "/home/.codex"]) {
      const resolved = resolveMemoryDir({ agentHome, cwd: "/anywhere", location: "global" });
      ok(resolved !== path.join(agentHome, CODEX_NATIVE_MEMORIES_DIRNAME), `${resolved} must never equal ${agentHome}'s native "memories" directory`);
      ok(path.basename(resolved) !== CODEX_NATIVE_MEMORIES_DIRNAME, `${resolved} must never be named "${CODEX_NATIVE_MEMORIES_DIRNAME}"`);
    }
  });

  /* ------------------------------------------------- isSharedMemoryDir */

  test("isSharedMemoryDir: true for the resolved global directory", () => {
    ok(isSharedMemoryDir(path.join("/home", "memory"), "/home"));
  });

  test("isSharedMemoryDir: false for a resolved infrastructure or repo directory", () => {
    ok(!isSharedMemoryDir(path.join("/home", "softela-ai", "memory", "default"), "/home"));
    ok(!isSharedMemoryDir(path.join("/repo", ".softela-ai-memory"), "/home"));
  });

  test("isSharedMemoryDir: false for an unrelated path, and never throws on a malformed input", () => {
    ok(!isSharedMemoryDir("/somewhere/else", "/home"));
    notThrows(() => isSharedMemoryDir(undefined, "/home"));
    notThrows(() => isSharedMemoryDir(path.join("/home", "memory"), undefined));
    eq(isSharedMemoryDir(undefined, undefined), false);
  });

  /* ------------------------------------------------------- inject-memory */

  test("inject-memory: writes a valid, context-free payload and creates nothing when the memory directory holds neither expected file, or does not exist at all", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const memoryDir = homeMemoryRoot(agentHome);
    ok(!fs.existsSync(memoryDir), "sanity check: the memory directory must not exist yet");

    const out = runHook("inject-memory.js", [`--agent-home=${agentHome}`, "--location=global"], { cwd });
    const parsed = JSON.parse(out);
    deepEq(parsed, { hookSpecificOutput: { hookEventName: "SessionStart" } }, "empty output must still be valid JSON, with additionalContext omitted rather than empty");
    ok(!fs.existsSync(memoryDir), "with seeding neutralised for this test, inject-memory.js must never create the memory directory or a placeholder MEMORY.md/ACTIVE-WORK.md inside it");
  });

  test("inject-memory: creates nothing new alongside an already-populated memory directory it merely reads from", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), "# Index\n");
    const before = fs.readdirSync(memoryDir).sort();

    runHook("inject-memory.js", [`--agent-home=${agentHome}`, "--location=global"], { cwd });

    deepEq(fs.readdirSync(memoryDir).sort(), before, "inject-memory.js must never add ACTIVE-WORK.md or anything else on its own");
  });

  test("inject-memory: injects both files and the authority model when present", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), "# Index\nsee ACTIVE-WORK.md\n");
    fs.writeFileSync(path.join(memoryDir, "ACTIVE-WORK.md"), "## Task\ncurrently doing stuff\n");

    const out = runHook("inject-memory.js", [`--agent-home=${agentHome}`, "--location=global"], { cwd });
    const parsed = JSON.parse(out);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    eq(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    ok(ctx.includes("currently doing stuff"), "should carry ACTIVE-WORK.md's content");
    ok(ctx.includes("see ACTIVE-WORK.md"), "should carry MEMORY.md's content");
    ok(ctx.includes("## INTENT"), "should state the authority model");
    ok(ctx.includes("## CONFLICT"), "should state the conflict convention");
  });

  /* -------------------------------------------------------- guard-memory */

  test("guard-memory: a Write that drops an INTENT section asks, on Claude Code", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });
    const file = path.join(memoryDir, "topic.md");
    const original = "## INTENT — Foo\n\nAgreed design here.\n\n## AS-OBSERVED 2026 @ abc\n\nObserved stuff.\n";
    fs.writeFileSync(file, original);

    const out = runHook("guard-memory.js", ["--agent=claude", `--agent-home=${agentHome}`, "--location=global"], {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: file, content: "## AS-OBSERVED 2026 @ abc\n\nObserved stuff.\n" },
      cwd,
    });
    const parsed = JSON.parse(out);
    eq(parsed.hookSpecificOutput.permissionDecision, "ask");
    ok(parsed.hookSpecificOutput.permissionDecisionReason.includes("INTENT"));
  });

  test("guard-memory: the same dropped INTENT section is a hard deny on Codex, which has no native ask", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });
    const file = path.join(memoryDir, "topic.md");
    fs.writeFileSync(file, "## INTENT — Foo\n\nAgreed design here.\n");

    const out = runHook("guard-memory.js", ["--agent=codex", `--agent-home=${agentHome}`, "--location=global"], {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: file, content: "nothing left of the section" },
      cwd,
    });
    const parsed = JSON.parse(out);
    eq(parsed.hookSpecificOutput.permissionDecision, "deny");
    ok(parsed.hookSpecificOutput.permissionDecisionReason.includes('no interactive "ask"'));
  });

  test("guard-memory: appending to an INTENT block passes silently", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });
    const file = path.join(memoryDir, "topic.md");
    const original = "## INTENT — Foo\n\nAgreed design here.\n";
    fs.writeFileSync(file, original);

    const out = runHook("guard-memory.js", ["--agent=claude", `--agent-home=${agentHome}`, "--location=global"], {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: file, content: `${original}\n## AS-OBSERVED 2026 @ abc\n\nnew section, INTENT untouched\n` },
      cwd,
    });
    eq(out, "");
  });

  test("guard-memory: an apply_patch that deletes an INTENT section is caught, the same as a Write", () => {
    // Codex writes through `apply_patch` and nothing else. This guard used
    // to filter on Claude Code's two tool names only, so on Codex the INTENT
    // protection never ran on the one path Codex actually uses.
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });
    const file = path.join(memoryDir, "topic.md");
    fs.writeFileSync(file, "## INTENT — Foo\n\nAgreed design here.\n\n## Notes\n\nplain.\n");

    const patch = [
      "*** Begin Patch",
      `*** Update File: ${file}`,
      "@@",
      "-## INTENT — Foo",
      "-",
      "-Agreed design here.",
      "-",
      " ## Notes",
      "*** End Patch",
    ].join("\n");

    const out = runHook("guard-memory.js", ["--agent=codex", `--agent-home=${agentHome}`, "--location=global"], {
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: { input: patch },
      cwd,
    });
    const parsed = JSON.parse(out);
    eq(parsed.hookSpecificOutput.permissionDecision, "deny");
    ok(parsed.hookSpecificOutput.permissionDecisionReason.includes("INTENT"));
  });

  test("guard-memory: an apply_patch that only appends passes silently", () => {
    // The everyday case, and the one that must never be obstructed: the
    // agent recording new state below an INTENT section it leaves alone.
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });
    const file = path.join(memoryDir, "ACTIVE-WORK.md");
    fs.writeFileSync(file, "## INTENT — Foo\n\nAgreed design here.\n");

    const patch = [
      "*** Begin Patch",
      `*** Update File: ${file}`,
      "@@",
      " Agreed design here.",
      "+",
      "+## AS-OBSERVED 2026 @ abc",
      "+",
      "+what the code actually does",
      "*** End Patch",
    ].join("\n");

    const out = runHook("guard-memory.js", ["--agent=codex", `--agent-home=${agentHome}`, "--location=global"], {
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: { input: patch },
      cwd,
    });
    eq(out, "");
  });

  test("guard-memory: an apply_patch outside the memory directory is left alone", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const outside = path.join(cwd, "src.ts");
    fs.writeFileSync(outside, "const a = 1;\n");

    const patch = ["*** Begin Patch", `*** Update File: ${outside}`, "@@", "-const a = 1;", "+const a = 2;", "*** End Patch"].join("\n");

    const out = runHook("guard-memory.js", ["--agent=codex", `--agent-home=${agentHome}`, "--location=global"], {
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: { input: patch },
      cwd,
    });
    eq(out, "");
  });

  test("guard-memory: a write outside the memory directory is left alone", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const outsideFile = path.join(tmpdir(), "unrelated.md");
    fs.writeFileSync(outsideFile, "## INTENT — Foo\n\nsomething\n");

    const out = runHook("guard-memory.js", ["--agent=claude", `--agent-home=${agentHome}`, "--location=global"], {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: outsideFile, content: "wiped" },
      cwd,
    });
    eq(out, "");
  });

  test("guard-memory: a tool other than Write/Edit is left alone", () => {
    const agentHome = tmpdir();
    const out = runHook("guard-memory.js", ["--agent=claude", `--agent-home=${agentHome}`, "--location=global"], {
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: path.join(homeMemoryRoot(agentHome), "topic.md") },
      cwd: tmpdir(),
    });
    eq(out, "");
  });

  /* ------------------------------------------------ guard-memory: shell tools */

  test("guard-memory: a Bash heredoc writing inside the memory directory is denied outright, on Claude Code", () => {
    const agentHome = tmpdir();
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });

    const out = runHook("guard-memory.js", ["--agent=claude", `--agent-home=${agentHome}`, "--location=global"], {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "cat >> ACTIVE-WORK.md <<EOF" },
      cwd: memoryDir,
    });
    const parsed = JSON.parse(out);
    eq(parsed.hookSpecificOutput.permissionDecision, "deny");
    ok(parsed.hookSpecificOutput.permissionDecisionReason.includes("ACTIVE-WORK.md"));
    ok(parsed.hookSpecificOutput.permissionDecisionReason.includes("write tool"));
  });

  test("guard-memory: the same shell write is a plain deny on Codex too — it is already a hard stop on both hosts", () => {
    const agentHome = tmpdir();
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });

    const out = runHook("guard-memory.js", ["--agent=codex", `--agent-home=${agentHome}`, "--location=global"], {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo hi >> ACTIVE-WORK.md" },
      cwd: memoryDir,
    });
    const parsed = JSON.parse(out);
    eq(parsed.hookSpecificOutput.permissionDecision, "deny");
    ok(!parsed.hookSpecificOutput.permissionDecisionReason.includes('no interactive "ask"'), "a genuine deny carries no ask-translation caveat");
  });

  test("guard-memory: a PowerShell Set-Content writing inside the memory directory is denied", () => {
    const agentHome = tmpdir();
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });

    const out = runHook("guard-memory.js", ["--agent=claude", `--agent-home=${agentHome}`, "--location=global"], {
      hook_event_name: "PreToolUse",
      tool_name: "PowerShell",
      tool_input: { command: "Set-Content -Path MEMORY.md -Value x" },
      cwd: memoryDir,
    });
    eq(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
  });

  test("guard-memory: a shell write inside the memory directory is denied regardless of extension — this check protects the location, not a content type", () => {
    const agentHome = tmpdir();
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(path.join(memoryDir, "checkpoints"), { recursive: true });

    const out = runHook("guard-memory.js", ["--agent=claude", `--agent-home=${agentHome}`, "--location=global"], {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo x > checkpoints/notes.txt" },
      cwd: memoryDir,
    });
    eq(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
  });

  test("guard-memory: a shell write outside the memory directory passes silently", () => {
    const agentHome = tmpdir();
    const outsideCwd = tmpdir();

    const out = runHook("guard-memory.js", ["--agent=claude", `--agent-home=${agentHome}`, "--location=global"], {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo hi >> ACTIVE-WORK.md" },
      cwd: outsideCwd,
    });
    eq(out, "");
  });

  test("guard-memory: an unresolvable shell write target (a variable) is skipped rather than guessed at, even from inside the memory directory", () => {
    const agentHome = tmpdir();
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });

    const out = runHook("guard-memory.js", ["--agent=claude", `--agent-home=${agentHome}`, "--location=global"], {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: 'cat >> "$OUT"' },
      cwd: memoryDir,
    });
    eq(out, "");
  });

  test("guard-memory: a plain read of a memory file with no redirect passes silently", () => {
    const agentHome = tmpdir();
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });

    const out = runHook("guard-memory.js", ["--agent=claude", `--agent-home=${agentHome}`, "--location=global"], {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "cat ACTIVE-WORK.md" },
      cwd: memoryDir,
    });
    eq(out, "");
  });

  test("guard-memory: a non-string command field never crashes the shell check", () => {
    const agentHome = tmpdir();
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });

    const out = runHook("guard-memory.js", ["--agent=claude", `--agent-home=${agentHome}`, "--location=global"], {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: { not: "a string" } },
      cwd: memoryDir,
    });
    eq(out, "");
  });

  /* ---------------------------------------------------- memory-autocommit */

  test("memory-autocommit: initialises version history lazily and commits the change", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });
    const file = path.join(memoryDir, "topic.md");
    const content = "## INTENT — Foo\n\nAgreed design.\n";
    fs.writeFileSync(file, content);

    ok(!fs.existsSync(path.join(memoryDir, ".git")), "no repo before the first commit");

    const out = runHook("memory-autocommit.js", [`--agent-home=${agentHome}`, "--location=global"], {
      tool_name: "Write",
      tool_input: { file_path: file, content },
      cwd,
    });
    deepEq(JSON.parse(out), { suppressOutput: true });

    ok(fs.existsSync(path.join(memoryDir, ".git")), "a repo should now exist");
    const log = execFileSync("git", ["-C", memoryDir, "log", "--oneline"], { encoding: "utf8" });
    ok(log.includes("topic.md"), "the commit subject should name the changed file");
  });

  test("memory-autocommit: an apply_patch write into the memory directory is committed too", () => {
    // On Codex this hook was dead: it filtered `tool_name` to Write/Edit,
    // and Codex sends `apply_patch`. Nothing an agent recorded in memory on
    // that host was ever versioned.
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });
    const file = path.join(memoryDir, "ACTIVE-WORK.md");
    fs.writeFileSync(file, "# Active work\n\nstep one done\n");

    const patch = ["*** Begin Patch", `*** Update File: ${file}`, "@@", " step one done", "+step two done", "*** End Patch"].join("\n");

    const out = runHook("memory-autocommit.js", [`--agent-home=${agentHome}`, "--location=global"], {
      tool_name: "apply_patch",
      tool_input: { input: patch },
      cwd,
    });
    deepEq(JSON.parse(out), { suppressOutput: true });

    const log = execFileSync("git", ["-C", memoryDir, "log", "--oneline"], { encoding: "utf8" });
    ok(log.includes("ACTIVE-WORK.md"), `the commit subject should name the patched file; got: ${log}`);
  });

  test("memory-autocommit: an apply_patch outside the memory directory is ignored", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const outside = path.join(cwd, "src.ts");
    fs.writeFileSync(outside, "const a = 1;\n");

    const patch = ["*** Begin Patch", `*** Update File: ${outside}`, "@@", "-const a = 1;", "+const a = 2;", "*** End Patch"].join("\n");

    const out = runHook("memory-autocommit.js", [`--agent-home=${agentHome}`, "--location=global"], {
      tool_name: "apply_patch",
      tool_input: { input: patch },
      cwd,
    });
    eq(out, "");
  });

  test("memory-autocommit: a repo-located memory directory is excluded from its enclosing repository, never the memory directory's own tracked .gitignore", () => {
    const agentHome = tmpdir();
    const productRepo = tmpdir();
    execFileSync("git", ["init", "-q"], { cwd: productRepo });
    const memoryDir = path.join(productRepo, ".softela-ai-memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    const file = path.join(memoryDir, "MEMORY.md");
    fs.writeFileSync(file, "# index\n");

    runHook("memory-autocommit.js", [`--agent-home=${agentHome}`, "--location=repo"], {
      tool_name: "Write",
      tool_input: { file_path: file, content: "# index\n" },
      cwd: productRepo,
    });

    ok(!fs.existsSync(path.join(memoryDir, ".gitignore")), "must never write a tracked .gitignore inside the memory directory");
    const exclude = fs.readFileSync(path.join(productRepo, ".git", "info", "exclude"), "utf8");
    ok(exclude.includes("/.softela-ai-memory/"), "the enclosing repo's own exclude file should list the memory directory");

    const status = execFileSync("git", ["-C", productRepo, "status", "--porcelain"], { encoding: "utf8" });
    eq(status, "", "the product repo must see the memory directory as fully ignored");

    const memoryLog = execFileSync("git", ["-C", memoryDir, "log", "--oneline"], { encoding: "utf8" });
    ok(memoryLog.includes("MEMORY.md"), "the memory directory's own nested repo should still have committed the file");
  });

  test("memory-autocommit: a write outside the memory directory is ignored", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const outsideFile = path.join(tmpdir(), "unrelated.md");
    fs.writeFileSync(outsideFile, "content");

    const out = runHook("memory-autocommit.js", [`--agent-home=${agentHome}`, "--location=global"], {
      tool_name: "Write",
      tool_input: { file_path: outsideFile, content: "content" },
      cwd,
    });
    eq(out, "");
    ok(!fs.existsSync(homeMemoryRoot(agentHome)), "the memory directory should never have been created");
  });

  test("memory-autocommit: refuses — stays silent, nests no repository — when a global directory is not yet its own git repository but already sits inside an enclosing one", () => {
    const agentHome = tmpdir();
    execFileSync("git", ["init", "-q"], { cwd: agentHome });
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });
    const file = path.join(memoryDir, "topic.md");
    const content = "content the enclosing repository already tracks\n";
    fs.writeFileSync(file, content);

    const out = runHook("memory-autocommit.js", [`--agent-home=${agentHome}`, "--location=global"], {
      tool_name: "Write",
      tool_input: { file_path: file, content },
      cwd: agentHome,
    });

    eq(out, "");
    ok(!fs.existsSync(path.join(memoryDir, ".git")), "must never nest a fresh, historyless repository into content the enclosing repo already tracks");
    // `git init` itself seeds an empty, comment-only `info/exclude` template
    // file, so its mere existence proves nothing — only its content matters.
    let excludeContent = "";
    try {
      excludeContent = fs.readFileSync(path.join(agentHome, ".git", "info", "exclude"), "utf8");
    } catch {
      // No exclude file at all is an equally valid pass.
    }
    ok(!excludeContent.includes("/memory/"), "must never write an exclude entry on behalf of a directory it declined to touch");
    eq(fs.readFileSync(file, "utf8"), content, "the file itself must be left exactly as found");
  });

  /* --------------------------------------------------------------- adoption */

  test("adoption: a full run of every hook over a pre-populated, already-versioned global directory only adds — nothing pre-existing is deleted, moved, renamed, truncated or rewritten", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(path.join(memoryDir, "topics"), { recursive: true });

    const intentContent = "## INTENT — Foo\n\nAgreed design already on disk.\n";
    const preExisting = {
      "MEMORY.md": "# Index\n\nolder knowledge already on disk\n",
      "ACTIVE-WORK.md": "## Current step\n\nsomething already in progress\n",
      [path.join("topics", "topic.md")]: intentContent,
    };
    for (const [rel, content] of Object.entries(preExisting)) fs.writeFileSync(path.join(memoryDir, rel), content);

    execFileSync("git", ["init", "-q"], { cwd: memoryDir });
    execFileSync("git", ["add", "-A"], { cwd: memoryDir });
    execFileSync(
      "git",
      ["-c", "user.name=developer", "-c", "user.email=developer@localhost", "commit", "-m", "Initial developer history"],
      { cwd: memoryDir },
    );
    const originalHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: memoryDir, encoding: "utf8" }).trim();
    const originalGitHead = fs.readFileSync(path.join(memoryDir, ".git", "HEAD"), "utf8");

    const snapshotBefore = {};
    for (const rel of Object.keys(preExisting)) {
      const full = path.join(memoryDir, rel);
      snapshotBefore[rel] = { content: fs.readFileSync(full, "utf8"), mtimeMs: fs.statSync(full).mtimeMs };
    }

    // 1. inject-memory.js — SessionStart, a pure reader.
    const injectOut = runHook("inject-memory.js", [`--agent-home=${agentHome}`, "--location=global"], { cwd, session_id: "adopt-sess" });
    ok(JSON.parse(injectOut).hookSpecificOutput.additionalContext.includes("older knowledge already on disk"));

    // 2. guard-memory.js — PreToolUse; appending to the INTENT block passes silently.
    const topicFile = path.join(memoryDir, "topics", "topic.md");
    const guardOut = runHook("guard-memory.js", ["--agent=claude", `--agent-home=${agentHome}`, "--location=global"], {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: topicFile, content: `${intentContent}\nappended, INTENT untouched\n` },
      cwd,
    });
    eq(guardOut, "");

    // 3. memory-autocommit.js — PostToolUse; commits a brand-new file into the
    // developer's existing history, without re-initialising it.
    const newFile = path.join(memoryDir, "new-note.md");
    fs.writeFileSync(newFile, "brand new file this run adds\n");
    const commitOut = runHook("memory-autocommit.js", [`--agent-home=${agentHome}`, "--location=global"], {
      tool_name: "Write",
      tool_input: { file_path: newFile, content: "brand new file this run adds\n" },
      cwd,
    });
    deepEq(JSON.parse(commitOut), { suppressOutput: true });

    // 4. compact-checkpoint.js — PreCompact; writes only its own checkpoints/ subdirectory.
    const transcriptPath = path.join(tmpdir(), "transcript.jsonl");
    fs.writeFileSync(transcriptPath, claudeLine({ type: "user", message: { content: "adoption checkpoint turn" } }));
    runHook("compact-checkpoint.js", ["--agent=claude", `--agent-home=${agentHome}`, "--location=global", "--checkpoint=on"], {
      session_id: "adopt-sess",
      transcript_path: transcriptPath,
      cwd,
      trigger: "manual",
    });
    ok(fs.existsSync(path.join(memoryDir, "checkpoints", "adopt-sess.md")), "compact-checkpoint should have added its own checkpoints/ subdirectory");

    // Every pre-existing file survives byte-identical, with its mtime untouched.
    for (const [rel, snapshot] of Object.entries(snapshotBefore)) {
      const full = path.join(memoryDir, rel);
      eq(fs.readFileSync(full, "utf8"), snapshot.content, `${rel} must come back byte-identical`);
      eq(fs.statSync(full).mtimeMs, snapshot.mtimeMs, `${rel} must keep its original mtime`);
    }

    // The developer's own git history is untouched: not re-initialised, and
    // the original commit this test made is still reachable.
    eq(fs.readFileSync(path.join(memoryDir, ".git", "HEAD"), "utf8"), originalGitHead, ".git/HEAD must be exactly as this test left it");
    execFileSync("git", ["cat-file", "-e", originalHead], { cwd: memoryDir });
  });

  test("adoption: no memories path is ever created, and a pre-existing <codexHome>/memories directory is untouched by any hook run against any location", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const nativeDir = path.join(agentHome, CODEX_NATIVE_MEMORIES_DIRNAME);
    fs.mkdirSync(nativeDir, { recursive: true });
    const nativeFile = path.join(nativeDir, "codex-own-note.md");
    const nativeContent = "Codex's own native memory content, never softela-ai's.\n";
    fs.writeFileSync(nativeFile, nativeContent);
    const nativeBefore = { content: fs.readFileSync(nativeFile, "utf8"), mtimeMs: fs.statSync(nativeFile).mtimeMs };
    const nativeListingBefore = fs.readdirSync(nativeDir).sort();

    for (const location of ["global", "infrastructure", "repo"]) {
      const resolved = resolveMemoryDir({ agentHome, cwd, location });
      ok(!resolved.split(path.sep).includes(CODEX_NATIVE_MEMORIES_DIRNAME), `${location} must never resolve through Codex's native memories directory`);

      runHook("inject-memory.js", [`--agent-home=${agentHome}`, `--location=${location}`], { cwd, session_id: "codex-sess" });

      fs.mkdirSync(resolved, { recursive: true });
      const file = path.join(resolved, "note.md");
      fs.writeFileSync(file, "content\n");

      runHook("guard-memory.js", ["--agent=codex", `--agent-home=${agentHome}`, `--location=${location}`], {
        tool_name: "Write",
        tool_input: { file_path: file, content: "content\n" },
        cwd,
      });
      runHook("memory-autocommit.js", [`--agent-home=${agentHome}`, `--location=${location}`], {
        tool_name: "Write",
        tool_input: { file_path: file, content: "content\n" },
        cwd,
      });

      const transcriptPath = path.join(tmpdir(), "transcript.jsonl");
      fs.writeFileSync(transcriptPath, claudeLine({ type: "user", message: { content: "codex checkpoint turn" } }));
      runHook("compact-checkpoint.js", ["--agent=codex", `--agent-home=${agentHome}`, `--location=${location}`, "--checkpoint=on"], {
        session_id: "codex-sess",
        transcript_path: transcriptPath,
        cwd,
        trigger: "manual",
      });
    }

    eq(fs.readFileSync(nativeFile, "utf8"), nativeBefore.content, "Codex's own native memory file must survive byte-identical");
    eq(fs.statSync(nativeFile).mtimeMs, nativeBefore.mtimeMs, "Codex's own native memory file's mtime must be untouched");
    deepEq(fs.readdirSync(nativeDir).sort(), nativeListingBefore, "nothing should have been added to or removed from Codex's own native memories directory");
    ok(!fs.existsSync(path.join(homeMemoryRoot(agentHome), CODEX_NATIVE_MEMORIES_DIRNAME)), "no memories path should ever be created inside the resolved global directory");
  });

  /* -------------------------------------------- ships mechanism, not content */

  test("installing the module never writes into a memory directory that already exists — pre-populated content comes back byte-identical", () => {
    fakeHome();
    const agentHome = paths.agentHome("claude");
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });
    const preExisting = {
      "MEMORY.md": "# Index\n\nolder knowledge already on disk\n",
      "ACTIVE-WORK.md": "## Current step\n\nsomething already in progress\n",
    };
    for (const [name, content] of Object.entries(preExisting)) fs.writeFileSync(path.join(memoryDir, name), content);
    const before = fs.readdirSync(memoryDir).sort();

    runInstall("claude", [MODULE_ID], { options: { [MODULE_ID]: { location: "global" } } });

    const after = fs.readdirSync(memoryDir).sort();
    deepEq(after, before, "no file should have been added to or removed from the memory directory");
    for (const [name, content] of Object.entries(preExisting)) {
      eq(fs.readFileSync(path.join(memoryDir, name), "utf8"), content, `${name} must come back byte-identical`);
    }
  });

  test("the install plan never targets any path under a resolvable memory directory", () => {
    fakeHome();
    const { actions } = runInstall("claude", [MODULE_ID], { options: { [MODULE_ID]: { location: "global" } } });
    const agentHome = paths.agentHome("claude");
    const forbiddenPrefix = homeMemoryRoot(agentHome) + path.sep;
    const offenders = actions
      .filter((a) => a.kind === "copy" || a.kind === "remove")
      .filter((a) => a.target && a.target.startsWith(forbiddenPrefix));
    deepEq(offenders, []);
  });

  /* ------------------------------------------- enable/disable round trip */

  test("enabling then disabling leaves the agent home exactly as it was", () => {
    fakeHome();
    runInstall("codex", []);
    const baseline = snapshotAgentHome("codex");

    runInstall("codex", [MODULE_ID]);
    const enabled = snapshotAgentHome("codex");
    ok(enabled.globalInstructions.includes("Memory as context"), "the prompt block should appear once enabled");
    ok(Object.keys(enabled.files).some((f) => f.includes("hooks/guard-memory.js")), "hook scripts should be installed");

    runInstall("codex", []);
    const after = snapshotAgentHome("codex");
    deepEq(after.files, baseline.files);
    deepEq(after.settingsHooks, baseline.settingsHooks);
    eq(after.globalInstructions, baseline.globalInstructions);
  });

  /* ------------------------------------------------------- transcript.js */

  /**
   * Serialises one fake Claude Code transcript line.
   *
   * @param {object} obj The line's parsed shape.
   * @returns {string} The JSON text for one JSONL line.
   */
  function claudeLine(obj) {
    return JSON.stringify(obj);
  }

  /**
   * Serialises one fake Codex rollout line.
   *
   * @param {object} obj The line's parsed shape.
   * @returns {string} The JSON text for one JSONL line.
   */
  function codexLine(obj) {
    return JSON.stringify(obj);
  }

  test("extractDeveloperTurns: keeps genuine Claude Code developer turns, in order, alongside other line kinds", () => {
    const lines = [
      claudeLine({ type: "system", text: "boot" }),
      claudeLine({
        type: "user",
        isSidechain: false,
        isMeta: false,
        uuid: "u1",
        timestamp: "2026-01-01T00:00:00Z",
        cwd: "/repo",
        gitBranch: "main",
        message: { role: "user", content: "First real message" },
      }),
      claudeLine({ type: "assistant", message: { role: "assistant", content: "ack" } }),
      claudeLine({
        type: "user",
        isSidechain: false,
        isMeta: false,
        uuid: "u2",
        timestamp: "2026-01-01T00:01:00Z",
        message: { role: "user", content: "Second real message" },
      }),
    ];
    const turns = extractDeveloperTurns(lines.join("\n"));
    deepEq(turns.map((t) => t.text), ["First real message", "Second real message"]);
    eq(turns[0].uuid, "u1");
    eq(turns[0].gitBranch, "main");
  });

  test("extractDeveloperTurns: envelope-marker and continuation lines are excluded even when logged as user turns", () => {
    const excludedTexts = [
      "<task-notification>something happened</task-notification>",
      "<command-name>foo</command-name>",
      "<local-command-stdout>output</local-command-stdout>",
      "<system-reminder>reminder text</system-reminder>",
      "This session is being continued from a previous conversation, summarised below.",
    ];
    const lines = excludedTexts.map((text, i) => claudeLine({ type: "user", uuid: `x${i}`, message: { content: text } }));
    lines.push(claudeLine({ type: "user", uuid: "keep", message: { content: "a real message" } }));
    const turns = extractDeveloperTurns(lines.join("\n"));
    deepEq(turns.map((t) => t.text), ["a real message"]);
  });

  test("extractDeveloperTurns: isSidechain and isMeta lines are excluded", () => {
    const lines = [
      claudeLine({ type: "user", isSidechain: true, message: { content: "subagent traffic" } }),
      claudeLine({ type: "user", isMeta: true, message: { content: "## Context Usage" } }),
      claudeLine({ type: "user", message: { content: "genuine" } }),
    ];
    const turns = extractDeveloperTurns(lines.join("\n"));
    deepEq(turns.map((t) => t.text), ["genuine"]);
  });

  test("extractDeveloperTurns: array-form message.content keeps text parts and drops tool_result parts", () => {
    const line = claudeLine({
      type: "user",
      message: {
        content: [
          { type: "tool_result", content: "should be dropped" },
          { type: "text", text: "kept part one" },
          { type: "text", text: "kept part two" },
        ],
      },
    });
    const turns = extractDeveloperTurns(line);
    eq(turns.length, 1);
    ok(turns[0].text.includes("kept part one"));
    ok(turns[0].text.includes("kept part two"));
    ok(!turns[0].text.includes("should be dropped"));
  });

  test("extractDeveloperTurns: a duplicated turn whose second copy is a superset collapses into one entry", () => {
    const lines = [
      claudeLine({ type: "user", uuid: "short", timestamp: "t1", message: { content: "please fix the bug" } }),
      claudeLine({ type: "user", uuid: "long", timestamp: "t2", message: { content: "please fix the bug [attachment: foo.png]" } }),
    ];
    const turns = extractDeveloperTurns(lines.join("\n"));
    eq(turns.length, 1);
    eq(turns[0].text, "please fix the bug [attachment: foo.png]");
    eq(turns[0].uuid, "long");
  });

  test("extractDeveloperTurns: a near-duplicate whose second copy inserts text in the middle is NOT a prefix and both turns are kept", () => {
    // Mirrors a real transcript pair: the second copy contains the first
    // copy's opening text, but with extra sentences inserted in the middle
    // rather than appended at the end — so it is not a strict prefix, and
    // the dedup rule must not fire.
    const first = "Please refactor the payment module so retries use exponential backoff.";
    const second = "Please refactor the payment module, and also add a metric for retry count, so retries use exponential backoff.";
    ok(!second.startsWith(first), "sanity check: the fixture must not actually be a strict prefix");

    const lines = [
      claudeLine({ type: "user", uuid: "first", timestamp: "t1", message: { content: first } }),
      claudeLine({ type: "user", uuid: "second", timestamp: "t2", message: { content: second } }),
    ];
    const turns = extractDeveloperTurns(lines.join("\n"));
    deepEq(turns.map((t) => t.text), [first, second], "both non-prefix near-duplicates must be kept as distinct turns");
  });

  test("extractDeveloperTurns: host-emitted interruption notices are excluded", () => {
    const lines = [
      claudeLine({ type: "user", timestamp: "t1", message: { content: "[Request interrupted by user for tool use]" } }),
      claudeLine({ type: "user", timestamp: "t2", message: { content: "[Request interrupted by user]" } }),
      claudeLine({ type: "user", timestamp: "t3", message: { content: "a real message" } }),
    ];
    const turns = extractDeveloperTurns(lines.join("\n"));
    deepEq(turns.map((t) => t.text), ["a real message"]);
  });

  test("extractDeveloperTurns: an interruption notice quoted inside a longer real message is kept, since the exclusion is whole-message only", () => {
    const line = claudeLine({
      type: "user",
      message: { content: 'earlier it said "[Request interrupted by user for tool use]" and I want to know why' },
    });
    const turns = extractDeveloperTurns(line);
    eq(turns.length, 1);
    ok(turns[0].text.includes("[Request interrupted by user for tool use]"));
  });

  test("extractDeveloperTurns: a Codex rollout keeps user messages and drops the developer role and environment_context", () => {
    const lines = [
      codexLine({ type: "session_meta", payload: { session_id: "s1" } }),
      codexLine({
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd stuff</environment_context>" }] },
      }),
      codexLine({
        type: "response_item",
        payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "system instructions" }] },
      }),
      codexLine({
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "assistant reply" }] },
      }),
      codexLine({
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "a real developer request" }] },
      }),
    ];
    const turns = extractDeveloperTurns(lines.join("\n"));
    deepEq(turns.map((t) => t.text), ["a real developer request"]);
  });

  test("extractDeveloperTurns: a malformed or truncated line is skipped without losing the good lines", () => {
    const lines = [
      claudeLine({ type: "user", message: { content: "before the garbage" } }),
      "{ this is not valid json at all",
      '{"type":"user","message":{"content":',
      claudeLine({ type: "user", message: { content: "after the garbage" } }),
    ];
    const turns = extractDeveloperTurns(lines.join("\n"));
    deepEq(turns.map((t) => t.text), ["before the garbage", "after the garbage"]);
  });

  /* ------------------------------------------------- compact-checkpoint */

  test("compact-checkpoint: running the hook twice over the same transcript is idempotent", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const transcriptPath = path.join(tmpdir(), "transcript.jsonl");
    fs.writeFileSync(
      transcriptPath,
      [
        claudeLine({ type: "user", uuid: "1", timestamp: "2026-01-01T00:00:00Z", message: { content: "first" } }),
        claudeLine({ type: "user", uuid: "2", timestamp: "2026-01-01T00:01:00Z", message: { content: "second" } }),
      ].join("\n"),
    );

    const payload = { session_id: "sess-idempotent", transcript_path: transcriptPath, cwd, trigger: "manual" };
    const args = ["--agent=claude", `--agent-home=${agentHome}`, "--location=global", "--checkpoint=on"];
    const file = path.join(homeMemoryRoot(agentHome), "checkpoints", "sess-idempotent.md");

    runHook("compact-checkpoint.js", args, payload);
    const first = fs.readFileSync(file, "utf8");

    runHook("compact-checkpoint.js", args, payload);
    const second = fs.readFileSync(file, "utf8");

    eq(second, first, "re-running over an unchanged transcript must produce byte-identical output");
    ok(first.includes("first"));
    ok(first.includes("second"));
  });

  test("compact-checkpoint: an unreadable transcript never overwrites an existing checkpoint", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const checkpointFile = path.join(homeMemoryRoot(agentHome), "checkpoints", "sess-unreadable.md");
    fs.mkdirSync(path.dirname(checkpointFile), { recursive: true });
    const existing = "<!-- softela-ai-checkpoint turns=3 agent=claude trigger=manual -->\n\n# Compaction checkpoint — sess-unreadable\n\nold content\n";
    fs.writeFileSync(checkpointFile, existing);

    const out = runHook("compact-checkpoint.js", ["--agent=claude", `--agent-home=${agentHome}`, "--location=global", "--checkpoint=on"], {
      session_id: "sess-unreadable",
      transcript_path: path.join(tmpdir(), "does-not-exist.jsonl"),
      cwd,
      trigger: "auto",
    });

    eq(fs.readFileSync(checkpointFile, "utf8"), existing, "the existing checkpoint must survive byte-for-byte");
    const parsed = JSON.parse(out);
    ok(typeof parsed.systemMessage === "string" && parsed.systemMessage.length > 0, "the failure should be noted in systemMessage");
  });

  test("compact-checkpoint: fewer extracted turns than the existing checkpoint records never overwrites it", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const checkpointFile = path.join(homeMemoryRoot(agentHome), "checkpoints", "sess-fewer.md");
    fs.mkdirSync(path.dirname(checkpointFile), { recursive: true });
    const existing = "<!-- softela-ai-checkpoint turns=5 agent=claude trigger=manual -->\n\n# Compaction checkpoint — sess-fewer\n\nfive turns recorded here\n";
    fs.writeFileSync(checkpointFile, existing);

    const transcriptPath = path.join(tmpdir(), "transcript.jsonl");
    fs.writeFileSync(transcriptPath, claudeLine({ type: "user", message: { content: "only one turn this time" } }));

    runHook("compact-checkpoint.js", ["--agent=claude", `--agent-home=${agentHome}`, "--location=global", "--checkpoint=on"], {
      session_id: "sess-fewer",
      transcript_path: transcriptPath,
      cwd,
      trigger: "manual",
    });

    eq(fs.readFileSync(checkpointFile, "utf8"), existing, "fewer turns than already recorded must never overwrite");
  });

  test("compact-checkpoint: retention keeps the 1000 most recently modified checkpoints", () => {
    // MAX_CHECKPOINTS in compact-checkpoint.js is 1000 — mirrored here as a
    // literal rather than derived from an export, since both hook scripts in
    // this module run their whole body unconditionally at the bottom of the
    // file (`run().catch(...)`), so requiring either as a module to reach its
    // constant would execute that body as a side effect of the require.
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const checkpointsDir = path.join(homeMemoryRoot(agentHome), "checkpoints");
    fs.mkdirSync(checkpointsDir, { recursive: true });

    const now = Date.now();
    for (let i = 0; i < 1000; i++) {
      const file = path.join(checkpointsDir, `old-${i}.md`);
      fs.writeFileSync(file, `<!-- softela-ai-checkpoint turns=1 agent=claude trigger=manual -->\nold ${i}\n`);
      const t = new Date(now - (1000 - i) * 60000);
      fs.utimesSync(file, t, t);
    }

    const transcriptPath = path.join(tmpdir(), "transcript.jsonl");
    fs.writeFileSync(transcriptPath, claudeLine({ type: "user", message: { content: "the newest session" } }));

    runHook("compact-checkpoint.js", ["--agent=claude", `--agent-home=${agentHome}`, "--location=global", "--checkpoint=on"], {
      session_id: "newest",
      transcript_path: transcriptPath,
      cwd,
      trigger: "manual",
    });

    const remaining = fs.readdirSync(checkpointsDir).filter((f) => f.endsWith(".md"));
    eq(remaining.length, 1000, "retention must keep exactly 1000 checkpoints");
    ok(remaining.includes("newest.md"), "the just-written checkpoint must survive pruning");
    ok(!remaining.includes("old-0.md"), "the oldest checkpoint must be the one pruned");
  });

  test("compact-checkpoint: checkpoint=off writes nothing at all", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const transcriptPath = path.join(tmpdir(), "transcript.jsonl");
    fs.writeFileSync(transcriptPath, claudeLine({ type: "user", message: { content: "should never be written" } }));

    const out = runHook("compact-checkpoint.js", ["--agent=claude", `--agent-home=${agentHome}`, "--location=global", "--checkpoint=off"], {
      session_id: "sess-off",
      transcript_path: transcriptPath,
      cwd,
      trigger: "manual",
    });

    eq(out, "");
    ok(!fs.existsSync(path.join(homeMemoryRoot(agentHome), "checkpoints")), "no checkpoints directory should have been created");
  });

  test("compact-checkpoint: garbage on stdin exits 0 and writes no output", () => {
    const agentHome = tmpdir();
    const out = execFileSync(
      process.execPath,
      [path.join(HOOKS_DIR, "compact-checkpoint.js"), "--agent=claude", `--agent-home=${agentHome}`, "--location=global", "--checkpoint=on"],
      { input: "not json at all", encoding: "utf8" },
    );
    eq(out, "");
  });

  test("compact-checkpoint: the PreCompact output never carries hookSpecificOutput", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const transcriptPath = path.join(tmpdir(), "transcript.jsonl");
    fs.writeFileSync(transcriptPath, claudeLine({ type: "user", message: { content: "a message for the record" } }));

    const out = runHook("compact-checkpoint.js", ["--agent=claude", `--agent-home=${agentHome}`, "--location=global", "--checkpoint=on"], {
      session_id: "sess-shape",
      transcript_path: transcriptPath,
      cwd,
      trigger: "manual",
    });
    const parsed = JSON.parse(out);
    ok(!("hookSpecificOutput" in parsed), "PreCompact accepts only the universal output keys");
    ok(typeof parsed.systemMessage === "string");
  });

  /* --------------------------------- inject-memory: checkpoint injection */

  test("inject-memory: injects the session's own checkpoint and echoes back the given hook_event_name", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const checkpointsDir = path.join(homeMemoryRoot(agentHome), "checkpoints");
    fs.mkdirSync(checkpointsDir, { recursive: true });
    fs.writeFileSync(
      path.join(checkpointsDir, "sess-inject.md"),
      "<!-- softela-ai-checkpoint turns=1 agent=claude trigger=manual -->\n\n# Compaction checkpoint — sess-inject\n\n### 1.\n\nthe developer's own verbatim request\n",
    );
    // A decoy checkpoint for a different session proves selection is by session id, not "any file present".
    fs.writeFileSync(
      path.join(checkpointsDir, "other-session.md"),
      "<!-- softela-ai-checkpoint turns=1 agent=claude trigger=manual -->\n\ndecoy content\n",
    );

    const out = runHook("inject-memory.js", [`--agent-home=${agentHome}`, "--location=global"], {
      cwd,
      session_id: "sess-inject",
      hook_event_name: "PostCompact",
    });
    const parsed = JSON.parse(out);
    eq(parsed.hookSpecificOutput.hookEventName, "PostCompact");
    ok(parsed.hookSpecificOutput.additionalContext.includes("the developer's own verbatim request"));
    ok(!parsed.hookSpecificOutput.additionalContext.includes("decoy content"));
  });

  test("inject-memory: falls back to the most recently modified checkpoint when the current session has none", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const checkpointsDir = path.join(homeMemoryRoot(agentHome), "checkpoints");
    fs.mkdirSync(checkpointsDir, { recursive: true });
    const older = path.join(checkpointsDir, "older.md");
    const newer = path.join(checkpointsDir, "newer.md");
    fs.writeFileSync(older, "<!-- softela-ai-checkpoint turns=1 agent=claude trigger=manual -->\n\nolder checkpoint content\n");
    fs.writeFileSync(newer, "<!-- softela-ai-checkpoint turns=1 agent=claude trigger=manual -->\n\nnewer checkpoint content\n");
    const now = Date.now();
    fs.utimesSync(older, new Date(now - 60000), new Date(now - 60000));
    fs.utimesSync(newer, new Date(now), new Date(now));

    const out = runHook("inject-memory.js", [`--agent-home=${agentHome}`, "--location=global"], {
      cwd,
      session_id: "unknown-session-with-no-checkpoint",
    });
    const parsed = JSON.parse(out);
    ok(parsed.hookSpecificOutput.additionalContext.includes("newer checkpoint content"));
  });

  test("inject-memory: a checkpoint larger than the byte bound is truncated from the front, keeping the most recent turns", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const checkpointsDir = path.join(homeMemoryRoot(agentHome), "checkpoints");
    fs.mkdirSync(checkpointsDir, { recursive: true });
    const big = "x".repeat(9000);
    const content = `<!-- softela-ai-checkpoint turns=2 agent=claude trigger=manual -->\n\n### 1.\n\n${big}\n\n### 2.\n\nthe most recent turn must survive\n`;
    fs.writeFileSync(path.join(checkpointsDir, "sess-big.md"), content);

    const out = runHook("inject-memory.js", [`--agent-home=${agentHome}`, "--location=global"], { cwd, session_id: "sess-big" });
    const parsed = JSON.parse(out);
    ok(parsed.hookSpecificOutput.additionalContext.includes("the most recent turn must survive"), "the newest content must survive truncation");
    ok(!parsed.hookSpecificOutput.additionalContext.includes(big), "the oldest content must have been truncated away");
    ok(parsed.hookSpecificOutput.additionalContext.includes("sess-big.md"), "the truncation marker must name the checkpoint file to open");
  });

  /* --------------------------------------------------------- crash safety */

  test("guard-memory: a bare JSON null payload never throws an uncaught exception — it must fail open like every other malformed shape", () => {
    const agentHome = tmpdir();
    const out = runHook("guard-memory.js", ["--agent=claude", `--agent-home=${agentHome}`, "--location=infrastructure"], null);
    eq(out, "", "a null payload must degrade to a silent pass, not a crash");
  });

  test("inject-memory: a numeric, boolean or plain-object cwd never throws", () => {
    const agentHome = tmpdir();
    for (const cwd of [999, true, {}]) {
      const out = runHook("inject-memory.js", [`--agent-home=${agentHome}`, "--location=infrastructure"], { cwd });
      deepEq(
        JSON.parse(out),
        { hookSpecificOutput: { hookEventName: "SessionStart" } },
        `cwd=${JSON.stringify(cwd)} must exit 0 with a valid, context-free payload`,
      );
    }
  });

  test("guard-memory: non-string content is coerced via String() against a real INTENT file instead of crashing", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });
    const file = path.join(memoryDir, "topic.md");
    fs.writeFileSync(file, "## INTENT — Foo\n\nAgreed design here.\n");

    const out = runHook("guard-memory.js", ["--agent=claude", `--agent-home=${agentHome}`, "--location=global"], {
      tool_name: "Write",
      tool_input: { file_path: file, content: 12345 },
      cwd,
    });
    eq(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask", "a coerced, non-string content that plainly drops the heading must still be caught");
  });

  test("guard-memory: non-string old_string/new_string on an Edit are coerced via String() instead of crashing", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const memoryDir = homeMemoryRoot(agentHome);
    fs.mkdirSync(memoryDir, { recursive: true });
    const file = path.join(memoryDir, "topic.md");
    fs.writeFileSync(file, "## INTENT — Foo\n\nAgreed design here.\n");

    const out = runHook("guard-memory.js", ["--agent=claude", `--agent-home=${agentHome}`, "--location=global"], {
      tool_name: "Edit",
      tool_input: { file_path: file, old_string: {}, new_string: [] },
      cwd,
    });
    eq(out, "", "coerced strings that match nothing in the file must pass silently, not crash");
  });

  test("memory-autocommit: a non-string file_path is rejected by its own typeof check, not by crashing", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const out = runHook("memory-autocommit.js", [`--agent-home=${agentHome}`, "--location=global"], {
      tool_name: "Write",
      tool_input: { file_path: 12345, content: "x" },
      cwd,
    });
    eq(out, "");
  });

  test("compact-checkpoint: wrong-typed session_id, trigger and transcript_path never crash the run", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const out = runHook("compact-checkpoint.js", ["--agent=claude", `--agent-home=${agentHome}`, "--location=global", "--checkpoint=on"], {
      session_id: 12345,
      trigger: {},
      transcript_path: true,
      cwd,
    });
    ok(typeof JSON.parse(out).systemMessage === "string");
  });

  test("inject-memory: a non-string session_id is sanitized via String(), never crashes checkpoint lookup", () => {
    const agentHome = tmpdir();
    const cwd = tmpdir();
    const out = runHook("inject-memory.js", [`--agent-home=${agentHome}`, "--location=global"], { cwd, session_id: 999888 });
    deepEq(JSON.parse(out), { hookSpecificOutput: { hookEventName: "SessionStart" } });
  });

  /**
   * Every executable hook script in this module, run through the full
   * hostile-payload matrix below. `memory-location.js`, `transcript.js` and
   * `stdin.js` are excluded — they are required-only libraries with no
   * stdin of their own, already exercised directly (`resolveMemoryDir`,
   * `findGitRoot`, `extractDeveloperTurns`, etc.) elsewhere in this file, or
   * in `memory-as-context-stdin.test.js`.
   *
   * @type {string[]}
   */
  const CRASH_SAFETY_SCRIPTS = ["guard-memory.js", "inject-memory.js", "memory-autocommit.js", "compact-checkpoint.js"];

  for (const script of CRASH_SAFETY_SCRIPTS) {
    test(`${script}: empty stdin exits 0 without blocking`, () => {
      runHookRaw(script, crashSafetyArgs(tmpdir()), "");
    });

    test(`${script}: malformed JSON on stdin exits 0 without blocking`, () => {
      runHookRaw(script, crashSafetyArgs(tmpdir()), "not json at all {{{");
    });

    test(`${script}: a bare JSON array on stdin exits 0 without blocking`, () => {
      runHook(script, crashSafetyArgs(tmpdir()), [1, 2, 3]);
    });

    test(`${script}: a bare JSON null on stdin exits 0 without blocking`, () => {
      runHook(script, crashSafetyArgs(tmpdir()), null);
    });

    test(`${script}: a bare JSON string on stdin exits 0 without blocking`, () => {
      runHook(script, crashSafetyArgs(tmpdir()), "just a bare string");
    });

    test(`${script}: a bare JSON number on stdin exits 0 without blocking`, () => {
      runHook(script, crashSafetyArgs(tmpdir()), 42);
    });

    test(`${script}: a bare JSON boolean on stdin exits 0 without blocking`, () => {
      runHook(script, crashSafetyArgs(tmpdir()), true);
    });

    test(`${script}: a huge payload exits 0 without blocking`, () => {
      const cwd = tmpdir();
      runHook(script, crashSafetyArgs(tmpdir()), {
        cwd,
        session_id: "huge",
        tool_name: "Write",
        tool_input: { file_path: path.join(cwd, "x"), content: "y".repeat(5 * 1024 * 1024) },
        transcript_path: path.join(cwd, "does-not-exist.jsonl"),
      });
    });

    test(`${script}: missing fields ({}) exits 0 without blocking`, () => {
      runHook(script, crashSafetyArgs(tmpdir()), {});
    });

    test(`${script}: wrong types for every field the script reads exits 0 without blocking`, () => {
      runHook(script, crashSafetyArgs(tmpdir()), {
        cwd: 12345,
        workspace: true,
        working_directory: {},
        hook_event_name: {},
        hookEventName: [],
        tool_name: 42,
        toolName: null,
        tool_input: "not-an-object",
        toolInput: 999,
        input: [1, 2, 3],
        session_id: {},
        sessionId: [],
        trigger: 123,
        reason: {},
        transcript_path: 456,
        transcriptPath: {},
      });
    });

    test(`${script}: cwd pointing at a path that does not exist exits 0 without blocking`, () => {
      const cwd = path.join(tmpdir(), "does", "not", "exist", "at", "all");
      runHook(script, crashSafetyArgs(tmpdir()), { cwd, session_id: "s1", tool_name: "Write", tool_input: {} });
    });
  }
});
