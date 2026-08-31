"use strict";

/**
 * `delegate-bulk-reading` — advises spawning a subagent for a survey of the
 * codebase instead of reading it into the orchestrator's own context.
 *
 * This rule guesses, and it knows it: the same command shape is produced by
 * reviewing a subagent's diff, which the rulebook requires. It is therefore
 * advisory on both hosts and can never block. What that buys is worth
 * stating in a test file, because it decides how these cases are weighted —
 * the negatives below far outnumber the positives on purpose. A rule that
 * fires on ordinary work gets switched off, and an advisory rule that fires
 * on ordinary work gets ignored, which is worse: it stays on, teaching an
 * agent that this whole channel is noise.
 */

const { suite } = require("../harness");
const { decide, decision } = require("./_ctx");
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

suite("guards/delegate-bulk-reading", ({ test, eq, ok }) => {
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
});
