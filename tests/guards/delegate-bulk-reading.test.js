"use strict";

/**
 * `delegate-bulk-reading` — advises, and once a task's own tally proves it,
 * denies reading or editing a bulk of the codebase directly instead of
 * delegating it to a subagent.
 *
 * The shell-shape heuristic guesses, and it knows it: the same command shape
 * is produced by reviewing a subagent's diff, which the rulebook requires.
 * It stays advisory-only and can never block. What that buys is worth
 * stating in a test file, because it decides how those cases are weighted —
 * the negatives below far outnumber the positives on purpose. A rule that
 * fires on ordinary work gets switched off, and an advisory rule that fires
 * on ordinary work gets ignored, which is worse: it stays on, teaching an
 * agent that this whole channel is noise.
 *
 * The tally-based tier is different: it is evidence of what a task actually
 * touched, not a guess about one command's shape, so it can escalate to a
 * real `deny` — but only once a trustworthy `sessionId` and a non-null tally
 * are both in hand. Every case below that exercises the tally writes a real
 * guard-activity log under a disposable `SOFTELA_AI_HOME` (`fakeHome()`) and
 * reads it back through the real `readTaskTally`, the same way
 * `tests/lib/task-tally.test.js` does — this suite never fakes that module
 * out, since the whole point is proving the two work together correctly.
 *
 * The tally-aware cases run the rule through the engine directly rather than
 * through the shared `decide`/`decision` helpers, so one case can hold the
 * rule set to this rule alone while a real log file backs the tally.
 *
 * Softela departure from upstream: on Codex the tally tier never denies,
 * because a Codex hook payload carries no `agent_id` at all, so a Codex
 * subagent's own bulk reading cannot be told apart from the orchestrator's.
 * The "claude vs. codex at denyAt" cases below prove that split directly.
 */

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");
const { decide, decision, makeCtx } = require("./_ctx");
const { evaluate } = require("../../core/engine");
const { guardLogPath, formatLogDate } = require("../../core/lib/paths");
const rule = require("../../core/guards/delegate-bulk-reading");

/** The module this rule is only meaningful under. */
const MODULES = ["agent-orchestration"];

/**
 * Runs one shell command through the rule.
 *
 * @param {string} command The command line.
 * @param {object} [extra] Context fields for this case.
 * @returns {string} The resulting action.
 */
function onCommand(command, extra = {}) {
  return decide(rule, { toolName: "Bash", command, modules: MODULES, ...extra });
}

/**
 * Runs the rule through the engine against a session-aware context and
 * reports the resulting action.
 *
 * @param {object} partial Context fields for this case, as `makeCtx` accepts, including `sessionId`.
 * @returns {string} `"deny"`, `"ask"` or `"pass"`.
 */
function actionWithSession(partial) {
  const result = evaluate(makeCtx(partial), { rules: [rule] });
  return result ? result.action : "pass";
}

/**
 * Builds one guard-activity log record for a file read or write, close
 * enough to `logGuardActivity`'s own shape for `readTaskTally` to count it.
 *
 * @param {string} tool The host tool name, e.g. `"Read"` or `"Write"`.
 * @param {string} filePath The file path this record names.
 * @param {string} sessionId The session id this record belongs to.
 * @returns {object} One log record.
 */
function tallyRecord(tool, filePath, sessionId) {
  return {
    ts: new Date().toISOString(),
    agent: "claude",
    event: "PreToolUse",
    tool,
    action: "pass",
    ruleId: null,
    advisory: false,
    filePath,
    command: null,
    cwd: "",
    sessionId,
    agentId: null,
    agentType: null,
  };
}

/**
 * Writes a set of records to TODAY's guard-activity log, under the fake home
 * a test has already established via `fakeHome()` — `readTaskTally` is
 * always called with no `date` override in production, so a test log must
 * land on the same date it resolves to.
 *
 * @param {object[]} records The records to write, one JSON line each.
 * @param {string} [agent] `"claude"` or `"codex"`; defaults to `"claude"`.
 * @returns {void}
 */
function writeTodayLog(records, agent = "claude") {
  const logPath = guardLogPath(agent, formatLogDate(new Date()));
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
}

/**
 * Builds `count` distinct-file `"Read"` records for one session — exactly
 * the shape `readTaskTally` needs to report `filesRead: count`.
 *
 * @param {number} count How many distinct files to record.
 * @param {string} sessionId The session id every record belongs to.
 * @returns {object[]} The records.
 */
function readRecords(count, sessionId) {
  const records = [];
  for (let i = 0; i < count; i += 1) records.push(tallyRecord("Read", `C:/repo/file${i}.ts`, sessionId));
  return records;
}

suite("guards/delegate-bulk-reading", ({ test, eq, ok, fakeHome }) => {
  /* ------------------------------------------------------------- advises */

  test("a recursive grep across a tree is advised", () => {
    eq(onCommand("grep -rn useDrillDown src/"), "ask");
    eq(onCommand("grep -R pattern ."), "ask");
    eq(onCommand("grep --recursive pattern src"), "ask");
  });

  test("ripgrep with no file argument is advised, since it recurses by default", () => {
    eq(onCommand('rg "ApplyFilterGroup"'), "ask");
    eq(onCommand("rg pattern core/"), "ask");
  });

  test("opening four or more files in one command is advised", () => {
    eq(onCommand("cat a.ts b.ts c.ts d.ts"), "ask");
    eq(onCommand("head -n 40 one.cs two.cs three.cs four.cs"), "ask");
  });

  test("a survey hidden inside a nested shell is still seen", () => {
    eq(onCommand('bash -c "grep -r pattern ."'), "ask");
  });

  test("a survey anywhere in a chained command line is seen", () => {
    eq(onCommand("cd src && rg pattern"), "ask");
  });

  test("the advice never blocks, on either host", () => {
    const d = decision(rule, { toolName: "Bash", command: "grep -rn x src/", modules: MODULES });
    eq(d.action, "ask");
    eq(d.advisory, true);
    ok(/DELEGATION/.test(d.reason));
    ok(d.fix.length > 0);
  });

  test("the advice names the reviewing case it cannot tell apart, rather than pretending to be certain", () => {
    const search = decision(rule, { toolName: "Bash", command: "rg pattern", modules: MODULES });
    const files = decision(rule, { toolName: "Bash", command: "cat a.ts b.ts c.ts d.ts", modules: MODULES });
    ok(/review/i.test(search.fix));
    ok(/review/i.test(files.fix));
  });

  /* -------------------------------------------------------- stays silent */

  test("a narrow search inside one named file is ordinary work", () => {
    eq(onCommand("grep -n resolveStack core/engine.js"), "pass");
    eq(onCommand("rg pattern core/lib/context.js"), "pass");
    eq(onCommand("grep -c TODO src/index.ts"), "pass");
  });

  test("reading one file, or a handful, is ordinary work", () => {
    eq(onCommand("cat package.json"), "pass");
    eq(onCommand("cat a.ts b.ts"), "pass");
    eq(onCommand("cat a.ts b.ts c.ts"), "pass");
    eq(onCommand("sed -n 1,40p core/engine.js"), "pass");
  });

  test("a bare word argument is not a file, so it never reaches the threshold", () => {
    eq(onCommand("head -n 5 output"), "pass");
    eq(onCommand("cat one two three four"), "pass");
  });

  test("the same file named repeatedly is one file", () => {
    eq(onCommand("cat a.ts a.ts a.ts a.ts"), "pass");
  });

  test("ordinary git, build and test commands are untouched", () => {
    for (const command of [
      "git status --porcelain",
      "git log --oneline -20",
      "git diff --stat",
      "npm test",
      "npm run build",
      "node tests/run.js guards",
      "dotnet build",
      "npx tsc -b",
      "ls -la src",
      "mkdir -p out",
    ]) {
      eq(onCommand(command), "pass", `${command} must stay silent`);
    }
  });

  test("a -r flag on a command that is not a search is not a recursive search", () => {
    eq(onCommand("cp -r src dest"), "pass");
    eq(onCommand("rm -rf node_modules"), "pass");
    eq(onCommand("ls -R src"), "pass");
  });

  /* ------------------------------------------------------------- gating */

  test("silent when the orchestration module is not enabled", () => {
    eq(decide(rule, { toolName: "Bash", command: "grep -rn x src/", modules: [] }), "pass");
  });

  test("silent on a tool that is not a shell", () => {
    eq(decide(rule, { toolName: "Write", command: "grep -rn x src/", filePath: "a.ts", modules: MODULES }), "pass");
  });

  test("silent on an empty command", () => {
    eq(onCommand(""), "pass");
    eq(decide(rule, { toolName: "Bash", modules: MODULES }), "pass");
  });

  test("an override can soften it, the same as any other rule", () => {
    eq(onCommand("grep -rn x src/", { overrideSpec: { "delegate-bulk-reading": { action: "off" } } }), "pass");
  });

  /* --------------------------------------------- silent inside a subagent */

  test("silent inside a delegated agent, even on a shape that would otherwise be advised", () => {
    eq(onCommand("grep -rn x src/", { agentId: "agent-1" }), "pass");
    eq(onCommand("cat a.ts b.ts c.ts d.ts", { agentId: "agent-1" }), "pass");
  });

  /* -------------------------------------------------- a bounded pipeline */

  test("a recursive grep piped straight into head is bounded, not a survey", () => {
    eq(onCommand('grep -rn "Pattern" some/dir --include=*.cs | head -30'), "pass");
  });

  test("a recursive grep piped into tail or wc is bounded the same way", () => {
    eq(onCommand("grep -rn pattern src | tail -20"), "pass");
    eq(onCommand("grep -rn pattern src | wc -l"), "pass");
  });

  test("a search piped through sort into head is still bounded", () => {
    eq(onCommand("grep -rn pattern src | sort | head -30"), "pass");
  });

  test("opening many files piped into head is bounded the same way a search is", () => {
    eq(onCommand("cat a.ts b.ts c.ts d.ts | head -50"), "pass");
  });

  test("a bare sort with nothing bounding after it does not, by itself, bound the survey", () => {
    eq(onCommand("grep -rn pattern src | sort"), "ask");
  });

  test("piping into an unrelated command does not bound the survey", () => {
    eq(onCommand("grep -rn pattern src | grep -v skip"), "ask");
  });

  /* --------------------------------------------------- the tally-based tier */

  test("below adviseAt, the tally says nothing and today's shell-shape behaviour still governs", () => {
    fakeHome();
    writeTodayLog(readRecords(4, "s1"));

    eq(actionWithSession({ toolName: "Bash", command: "echo hi", sessionId: "s1", modules: MODULES }), "pass");
    eq(actionWithSession({ toolName: "Bash", command: "grep -rn x src/", sessionId: "s1", modules: MODULES }), "ask");
  });

  test("at adviseAt, a plain file read is advised purely from the tally, with no command line at all", () => {
    fakeHome();
    writeTodayLog(readRecords(5, "s1"));

    eq(
      actionWithSession({ toolName: "Read", filePath: "C:/repo/other.ts", sessionId: "s1", modules: MODULES }),
      "ask",
    );
  });

  test("at denyAt, a plain file write is denied", () => {
    fakeHome();
    writeTodayLog(readRecords(15, "s1"));

    eq(
      actionWithSession({ toolName: "Write", filePath: "C:/repo/other.ts", sessionId: "s1", modules: MODULES }),
      "deny",
    );
  });

  test("the max of filesRead and filesWritten is what counts, not their sum", () => {
    fakeHome();
    // 15 distinct reads and, of those same files, 15 also written — the sum
    // would be 30, well past denyAt, but the max is exactly denyAt.
    const sessionId = "s1";
    const records = readRecords(15, sessionId);
    for (let i = 0; i < 15; i += 1) records.push(tallyRecord("Write", `C:/repo/file${i}.ts`, sessionId));
    writeTodayLog(records);

    eq(
      actionWithSession({ toolName: "Read", filePath: "C:/repo/another.ts", sessionId, modules: MODULES }),
      "deny",
    );
  });

  test("a project config overriding both thresholds is honoured", () => {
    fakeHome();
    writeTodayLog(readRecords(3, "s1"));

    eq(
      actionWithSession({
        toolName: "Read",
        filePath: "C:/repo/other.ts",
        sessionId: "s1",
        modules: MODULES,
        project: { delegation: { adviseAt: 2, denyAt: 3 } },
      }),
      "deny",
    );
  });

  /* -------------------------------------------------------- the safety rule */

  test("a null ctx.sessionId never denies, however high the count actually is", () => {
    fakeHome();
    writeTodayLog(readRecords(50, "s1"));

    eq(
      actionWithSession({ toolName: "Write", filePath: "C:/repo/other.ts", sessionId: null, modules: MODULES }),
      "pass",
    );
  });

  test("a null tally (no log at all) never denies, even at a call shaped to deny", () => {
    fakeHome();
    // No log file written for today at all — readTaskTally must come back null.

    eq(
      actionWithSession({ toolName: "Write", filePath: "C:/repo/other.ts", sessionId: "s1", modules: MODULES }),
      "pass",
    );
  });

  test("a call inside a subagent still passes, even with a tally that would otherwise deny", () => {
    fakeHome();
    writeTodayLog(readRecords(50, "s1"));

    eq(
      actionWithSession({
        toolName: "Write",
        filePath: "C:/repo/other.ts",
        sessionId: "s1",
        modules: MODULES,
        agentId: "agent-1",
      }),
      "pass",
    );
  });

  test("a tool that is neither a shell nor a read/write shape passes immediately, tally or not", () => {
    fakeHome();
    writeTodayLog(readRecords(50, "s1"));

    eq(
      actionWithSession({ toolName: "SomeOtherTool", filePath: "C:/repo/other.ts", sessionId: "s1", modules: MODULES }),
      "pass",
    );
  });

  /* ------------------------------------------------------- version control */

  test("a version-control command is out of scope, however high the tally has climbed", () => {
    fakeHome();
    writeTodayLog(readRecords(50, "s1"));

    for (const command of ['git commit -m "a subject"', "git diff", "git status --short", "git add -A"]) {
      eq(actionWithSession({ toolName: "Bash", command, sessionId: "s1", modules: MODULES }), "pass");
    }
  });

  test("a cd in front of a version-control command does not bring it back into scope", () => {
    fakeHome();
    writeTodayLog(readRecords(50, "s1"));

    eq(
      actionWithSession({
        toolName: "Bash",
        command: 'cd C:/repo && git add -A && git commit -m "a subject"',
        sessionId: "s1",
        modules: MODULES,
      }),
      "pass",
    );
  });

  test("git grep is not exempt, since it sweeps a tree the same way a plain search does", () => {
    fakeHome();
    writeTodayLog(readRecords(50, "s1"));

    eq(
      actionWithSession({ toolName: "Bash", command: "git grep -rn useDrillDown", sessionId: "s1", modules: MODULES }),
      "deny",
    );
  });

  test("a survey cannot be smuggled through by prefixing it with a commit", () => {
    eq(onCommand('git commit -m "a subject" && cat a.ts b.ts c.ts d.ts'), "ask");
  });

  /* ----------------------------------------------- Softela: Codex at denyAt */

  test("Softela adaptation: claude at or past denyAt denies", () => {
    fakeHome();
    writeTodayLog(readRecords(15, "s1"), "claude");

    eq(
      actionWithSession({
        agent: "claude",
        toolName: "Write",
        filePath: "C:/repo/other.ts",
        sessionId: "s1",
        modules: MODULES,
      }),
      "deny",
    );
  });

  test("Softela adaptation: codex at or past denyAt asks instead of denying, since it cannot tell a subagent apart", () => {
    fakeHome();
    writeTodayLog(readRecords(15, "s1"), "codex");

    const result = evaluate(
      makeCtx({
        agent: "codex",
        toolName: "Write",
        filePath: "C:/repo/other.ts",
        sessionId: "s1",
        modules: MODULES,
      }),
      { rules: [rule] },
    );

    eq(result.action, "ask");
    ok(/codex/i.test(result.reason));
  });

  test("Softela adaptation: both claude and codex ask at adviseAt, below denyAt", () => {
    fakeHome();
    writeTodayLog(readRecords(5, "s1"), "claude");

    eq(
      actionWithSession({
        agent: "claude",
        toolName: "Read",
        filePath: "C:/repo/other.ts",
        sessionId: "s1",
        modules: MODULES,
      }),
      "ask",
    );

    writeTodayLog(readRecords(5, "s1"), "codex");

    eq(
      actionWithSession({
        agent: "codex",
        toolName: "Read",
        filePath: "C:/repo/other.ts",
        sessionId: "s1",
        modules: MODULES,
      }),
      "ask",
    );
  });
});
