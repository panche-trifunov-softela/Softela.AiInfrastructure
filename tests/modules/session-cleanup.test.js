"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { suite } = require("../harness");
const { loadModule, validateModuleJson, renderPrompt, unsubstitutedTokens, runInstall, snapshotAgentHome, paths } = require("./_helpers");

const MODULE_ID = "session-cleanup";
const WORKER = path.join(__dirname, "..", "..", "modules", MODULE_ID, "assets", "clean-sessions.js");

/**
 * Builds a fake Claude Code session store under a fresh agent home:
 * `<agentHome>/projects/<projectDirName>/` holding two sessions (transcript
 * plus side-car folder) and a `memory` directory, mirroring the layout the
 * real host produces.
 *
 * @param {string} agentHome The fake agent home directory.
 * @param {string} projectDirName The sanitized project directory name.
 * @returns {{projectDir: string, memoryDir: string, sessionA: string, sessionB: string}}
 * The paths built, and the two session ids created.
 */
function buildFakeSessionStore(agentHome, projectDirName) {
  const projectDir = path.join(agentHome, "projects", projectDirName);
  fs.mkdirSync(projectDir, { recursive: true });

  const memoryDir = path.join(projectDir, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), "# durable project knowledge\n");

  const sessionA = crypto.randomUUID();
  const sessionB = crypto.randomUUID();
  for (const id of [sessionA, sessionB]) {
    fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), `{"line": "${id}"}\n`);
    fs.mkdirSync(path.join(projectDir, id), { recursive: true });
    fs.writeFileSync(path.join(projectDir, id, "note.txt"), "side-car content\n");
  }

  return { projectDir, memoryDir, sessionA, sessionB };
}

/**
 * Runs the worker script directly as a real subprocess, against its own
 * source copy under `modules/session-cleanup/assets/` — this exercises the
 * worker's own file-handling logic in isolation, not the `softela-ai
 * clean-sessions` command itself. The command wires argument-forwarding and
 * exit codes onto the module's *installed* copy
 * (`<agentHome>/softela-ai/hooks/clean-sessions.js`) once the module is
 * enabled; that end-to-end path is covered by
 * `tests/installer/clean-sessions.test.js`, which drives the real CLI as a
 * subprocess instead.
 *
 * @param {string[]} args Extra CLI arguments.
 * @returns {string} The process's stdout.
 */
function runCleaner(args) {
  return execFileSync(process.execPath, [WORKER, ...args], { encoding: "utf8" });
}

suite("modules/session-cleanup", ({ test, eq, deepEq, ok, tmpdir, fakeHome }) => {
  const mod = loadModule(MODULE_ID);

  test("module.json validates against the shape MODULES.md documents", () => {
    deepEq(validateModuleJson(mod), []);
  });

  test("defaults off, per MODULES.md", () => {
    eq(mod.json.defaultEnabled, false);
  });

  test("ships no guard — the exclusion is enforced in the worker script, not by a PreToolUse rule", () => {
    eq(mod.json.guards.length, 0);
  });

  test("prompt.md renders with no unsubstituted placeholder", () => {
    deepEq(unsubstitutedTokens(renderPrompt(mod)), []);
  });

  test("dry run by default deletes nothing", () => {
    const agentHome = tmpdir();
    const { projectDir, memoryDir, sessionA, sessionB } = buildFakeSessionStore(agentHome, "myproject");
    const before = fs.readdirSync(projectDir).sort();

    const out = runCleaner([`--agent-home=${agentHome}`, "--all", `--current=${sessionA}`]);
    ok(out.includes("WOULD DELETE"), "a dry run should say what it would do, not that it did it");
    ok(out.includes("Nothing has been deleted"), "a dry run should say so explicitly");

    const after = fs.readdirSync(projectDir).sort();
    deepEq(after, before, "nothing should be removed without --apply");
    ok(fs.existsSync(path.join(memoryDir, "MEMORY.md")), "memory survives a dry run trivially, since nothing is deleted at all");
    ok(fs.existsSync(path.join(projectDir, `${sessionB}.jsonl`)), "the non-current session should still be listed, not removed");
  });

  test("--apply deletes the non-current session but never the memory folder", () => {
    const agentHome = tmpdir();
    const { projectDir, memoryDir, sessionA, sessionB } = buildFakeSessionStore(agentHome, "myproject");

    const out = runCleaner([`--agent-home=${agentHome}`, "--all", `--current=${sessionA}`, "--apply"]);
    ok(out.includes("DELETING:"));

    ok(fs.existsSync(memoryDir), "the memory directory must survive");
    ok(fs.existsSync(path.join(memoryDir, "MEMORY.md")), "the memory directory's content must survive intact");
    ok(fs.existsSync(path.join(projectDir, `${sessionA}.jsonl`)), "the pinned current session's transcript must survive");
    ok(!fs.existsSync(path.join(projectDir, `${sessionB}.jsonl`)), "the non-current session's transcript should be gone");
    ok(!fs.existsSync(path.join(projectDir, sessionB)), "the non-current session's side-car should be gone");
  });

  // The two guarantees that hold whatever the arguments say. There is no
  // flag for either, which is the point: the surface a developer can reach
  // is `--all` and `--apply`, and neither of them opens a route to these.
  test("--all --apply still never touches a memory folder, at any depth", () => {
    const agentHome = tmpdir();
    const { memoryDir } = buildFakeSessionStore(agentHome, "myproject");
    const storeMemory = path.join(agentHome, "projects", "memory");
    fs.mkdirSync(storeMemory, { recursive: true });
    fs.writeFileSync(path.join(storeMemory, "MEMORY.md"), "# a memory folder beside the projects\n");

    runCleaner([`--agent-home=${agentHome}`, "--all", "--apply"]);

    ok(fs.existsSync(path.join(memoryDir, "MEMORY.md")), "memory inside a project folder must survive");
    ok(fs.existsSync(path.join(storeMemory, "MEMORY.md")), "memory beside the project folders must survive too");
  });

  test("--all --apply always leaves the live session behind", () => {
    const agentHome = tmpdir();
    const { projectDir, sessionA } = buildFakeSessionStore(agentHome, "myproject");

    const out = runCleaner([`--agent-home=${agentHome}`, "--all", `--current=${sessionA}`, "--apply"]);

    ok(fs.existsSync(path.join(projectDir, `${sessionA}.jsonl`)), "the live session is never deletable");
    ok(out.includes("never optional"), "and the report says so, rather than implying a flag exists");
  });

  test("a store with no saved sessions reports that plainly rather than erroring", () => {
    const agentHome = tmpdir();
    fs.mkdirSync(path.join(agentHome, "projects", "empty"), { recursive: true });
    const out = runCleaner([`--agent-home=${agentHome}`, "--all"]);
    ok(out.includes("No saved sessions found"));
  });

  test("an agent home with no session store at all says so, and points at the wider sweep", () => {
    const agentHome = tmpdir();
    const out = runCleaner([`--agent-home=${agentHome}`]);
    ok(out.includes("No sessions found"), "it must report, not throw");
    ok(out.includes("--all"), "and name the argument that widens the search");
  });

  /* ------------------------------------------------------ codex's layout */

  // Codex files transcripts by date, with no project dimension and no
  // side-car: `<home>/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`.
  // Assuming Claude Code's shape here is what made this module report an
  // empty result on Codex while a real store sat next to it.
  test("codex sessions are found in their own date-nested layout", () => {
    const agentHome = tmpdir();
    const dayDir = path.join(agentHome, "sessions", "2026", "08", "25");
    fs.mkdirSync(dayDir, { recursive: true });

    const older = crypto.randomUUID();
    const newer = crypto.randomUUID();
    fs.writeFileSync(path.join(dayDir, `rollout-2026-08-25T10-10-51-${older}.jsonl`), "{}\n");
    fs.writeFileSync(path.join(dayDir, `rollout-2026-08-25T15-04-58-${newer}.jsonl`), "{}\n");

    const out = runCleaner([`--agent-home=${agentHome}`, "--agent=codex", "--all", `--current=${newer}`]);
    ok(out.includes(older), "the older transcript must be listed for deletion");
    ok(out.includes("KEEPING the live session"), "the pinned session must be spared");
  });

  test("a codex transcript that is not named the way the host names one is left alone", () => {
    const agentHome = tmpdir();
    const dayDir = path.join(agentHome, "sessions", "2026", "08", "25");
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(path.join(dayDir, "notes.jsonl"), "{}\n");
    fs.writeFileSync(path.join(dayDir, "rollout-missing-the-uuid.jsonl"), "{}\n");

    const out = runCleaner([`--agent-home=${agentHome}`, "--agent=codex", "--all", "--apply"]);
    ok(!out.includes("notes"), "an unrelated file is not a session and must not even be listed");
    ok(!out.includes("rollout-missing"), "a half-matching name is not a match");
    ok(fs.existsSync(path.join(dayDir, "notes.jsonl")), "an unrelated file must survive");
    ok(fs.existsSync(path.join(dayDir, "rollout-missing-the-uuid.jsonl")), "a half-matching name must survive");
  });

  test("the host is inferred from the agent home when it is not stated", () => {
    const agentHome = path.join(tmpdir(), ".codex");
    const dayDir = path.join(agentHome, "sessions", "2026", "08", "25");
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(path.join(dayDir, `rollout-2026-08-25T10-10-51-${crypto.randomUUID()}.jsonl`), "{}\n");

    const out = runCleaner([`--agent-home=${agentHome}`, "--all"]);
    ok(out.includes("session(s)"), "a home named .codex must be read with codex's layout, unprompted");
  });

  /* ------------------------------------------- enable/disable round trip */

  test("enabling then disabling leaves the agent home exactly as it was", () => {
    fakeHome();
    runInstall("codex", []);
    const baseline = snapshotAgentHome("codex");

    runInstall("codex", [MODULE_ID]);
    const enabled = snapshotAgentHome("codex");
    ok(enabled.globalInstructions.includes("Session cleanup"), "the prompt block should appear once enabled");
    ok(
      Object.keys(enabled.files).some((f) => f.includes("modules/session-cleanup/assets/clean-sessions.js")),
      "the worker script should be installed under the module's own directory",
    );

    runInstall("codex", []);
    const after = snapshotAgentHome("codex");
    deepEq(after.files, baseline.files);
    deepEq(after.settingsHooks, baseline.settingsHooks);
    eq(after.globalInstructions, baseline.globalInstructions);
  });

  /* ------------------------------------------------------- host commands */

  test("each host gets the command at the location it actually discovers commands from", () => {
    // The CLI alone was never reachable from where a developer notices the
    // problem: they had to leave the session for a second terminal. These two
    // files are what make `/clean-sessions` and `$clean-sessions` exist.
    // Neither may land under `softela-ai/` — a host only looks in its own fixed
    // location, and a file anywhere else is simply never found.
    for (const [agent, expected] of [
      ["claude", "commands/clean-sessions.md"],
      ["codex", "skills/clean-sessions/SKILL.md"],
    ]) {
      fakeHome();
      runInstall(agent, [MODULE_ID]);
      const files = Object.keys(snapshotAgentHome(agent).files);
      ok(files.includes(expected), `[${agent}] expected ${expected}, got: ${files.join(", ")}`);
      ok(
        !files.some((f) => f.startsWith("softela-ai/") && f.endsWith("clean-sessions.md")),
        `[${agent}] a command must not be installed under the installed root, where the host never looks`,
      );
    }
  });

  test("the two hosts get different documents, because their command formats differ", () => {
    fakeHome();
    runInstall("claude", [MODULE_ID]);
    const command = fs.readFileSync(path.join(paths.agentHome("claude"), "commands", "clean-sessions.md"), "utf8");

    fakeHome();
    runInstall("codex", [MODULE_ID]);
    const skill = fs.readFileSync(path.join(paths.agentHome("codex"), "skills", "clean-sessions", "SKILL.md"), "utf8");

    ok(command && skill, "both hosts must get a command");
    ok(command.includes("argument-hint"), "a Claude Code command declares its own argument hint");
    ok(skill.includes("name: \"clean-sessions\""), "a Codex skill is keyed by its own `name` front matter");
    ok(
      /Never use it for anything under a directory named memory/i.test(skill),
      "a Codex skill's description decides whether it loads at all, so it must state when NOT to use it",
    );
    // The rules neither host may lose, and the dependency neither may regain:
    // an installed command that shells out to `softela-ai` is a command that does
    // nothing on a machine where nobody ran `npm link`, which is most of them.
    for (const [label, text] of [["command", command], ["skill", skill]]) {
      ok(text.includes("--apply"), `[${label}] must name what actually deletes`);
      ok(text.includes("--all"), `[${label}] must name the argument that widens the sweep`);
      ok(text.toLowerCase().includes("memory"), `[${label}] must carry the memory exclusion`);
      ok(text.includes("clean-sessions.js"), `[${label}] must invoke the installed script directly`);
      ok(!/\bsoftela-ai\s+clean-sessions\b/.test(text), `[${label}] must not depend on the softela-ai CLI being on PATH`);
      ok(!text.includes("--days"), `[${label}] must not document an argument the script does not accept`);
    }
  });

  test("disabling the module takes the host command away with it", () => {
    fakeHome();
    runInstall("claude", [MODULE_ID]);
    ok(snapshotAgentHome("claude").files["commands/clean-sessions.md"], "sanity: it was installed");

    runInstall("claude", []);
    ok(
      !snapshotAgentHome("claude").files["commands/clean-sessions.md"],
      "a command left behind by a disabled module is a command that no longer works",
    );
  });
});
