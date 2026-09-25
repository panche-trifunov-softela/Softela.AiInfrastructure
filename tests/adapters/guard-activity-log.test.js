"use strict";

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");
const { CLAUDE_DISPATCH, runDispatcher, agentPaths } = require("./_spawn");
const paths = require("../../core/lib/paths");

/** A shell command no rule in this repository flags, used for a plain-pass dispatch. */
const HARMLESS_COMMAND = "git status";

/** A command `infra-self-protection` denies, used for a denying dispatch. */
const SELF_APPROVE_COMMAND = "softela-ai approve subagent-model";

/**
 * Builds a minimal, well-formed `PreToolUse` payload for a shell command, in
 * Claude Code's own shape.
 *
 * @param {string} command The shell command line.
 * @param {string} cwd The working directory to report.
 * @returns {object} A Claude Code-shaped payload.
 */
function shellPayload(command, cwd) {
  return { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd };
}

/**
 * Resolves the directory a dispatcher run against a given fake home would
 * write its guard-activity log into, by borrowing `core/lib/paths.js#guardLogPath`
 * itself rather than duplicating its date-naming convention here. The date
 * passed in is irrelevant to the directory this returns — only the file name
 * inside it depends on the date — so any placeholder date does.
 *
 * @param {string} home The disposable home directory a test is using.
 * @param {"claude" | "codex"} agent Which host's log directory to resolve.
 * @returns {string} `<stateDir>/logs` for this `home`/`agent`.
 */
function guardLogDir(home, agent) {
  const previous = process.env.SOFTELA_AI_HOME;
  process.env.SOFTELA_AI_HOME = home;
  try {
    return path.dirname(paths.guardLogPath(agent, "0000-00-00"));
  } finally {
    if (previous === undefined) delete process.env.SOFTELA_AI_HOME;
    else process.env.SOFTELA_AI_HOME = previous;
  }
}

/**
 * Reads every guard-activity log line written under a fake home, parsed as
 * JSON, across whatever dated files happen to exist there — a single test
 * run only ever produces one, since it all happens on the same calendar day.
 *
 * @param {string} home The disposable home directory a test is using.
 * @param {"claude" | "codex"} agent Which host's log to read.
 * @returns {object[]} The parsed log entries, in file/append order.
 */
function readGuardLog(home, agent) {
  const dir = guardLogDir(home, agent);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];

  const files = fs.readdirSync(dir).filter((name) => /^guard-activity-.*\.jsonl$/.test(name));
  const lines = [];
  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    for (const line of text.split("\n")) {
      if (line.trim()) lines.push(JSON.parse(line));
    }
  }
  return lines;
}

suite("adapters/guard-activity-log", ({ test, eq, ok, tmpdir }) => {
  test("a denying call writes one line with the right action and ruleId", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    const result = runDispatcher(CLAUDE_DISPATCH, shellPayload(SELF_APPROVE_COMMAND, cwd), { home, cwd });
    eq(result.code, 0);

    const lines = readGuardLog(home, "claude");
    eq(lines.length, 1);
    eq(lines[0].action, "deny");
    eq(lines[0].ruleId, "infra-self-protection");
  });

  test("a plain passing call also writes a line, with action pass and ruleId null", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    const result = runDispatcher(CLAUDE_DISPATCH, shellPayload(HARMLESS_COMMAND, cwd), { home, cwd });
    eq(result.code, 0);
    eq(result.stdout, "");

    const lines = readGuardLog(home, "claude");
    eq(lines.length, 1);
    eq(lines[0].action, "pass");
    eq(lines[0].ruleId, null);
  });

  test("two dispatches append two lines to the same file, rather than overwriting", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    runDispatcher(CLAUDE_DISPATCH, shellPayload(HARMLESS_COMMAND, cwd), { home, cwd });
    runDispatcher(CLAUDE_DISPATCH, shellPayload(SELF_APPROVE_COMMAND, cwd), { home, cwd });

    const lines = readGuardLog(home, "claude");
    eq(lines.length, 2);
    eq(lines[0].action, "pass");
    eq(lines[1].action, "deny");
  });

  test("a long command is truncated in the log, but the dispatch still decides normally", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    // `git status` plus a long harmless comment: still a passing command, but
    // long enough to exceed the log's own truncation threshold.
    // GUARD_LOG_COMMAND_MAX in adapters/shared/dispatch-core.js is 20000.
    const longCommand = `git status # ${"x".repeat(21000)}`;
    ok(longCommand.length > 20000, "fixture command must actually exceed the truncation threshold");

    const result = runDispatcher(CLAUDE_DISPATCH, shellPayload(longCommand, cwd), { home, cwd });
    eq(result.code, 0);
    eq(result.stdout, "");

    const lines = readGuardLog(home, "claude");
    eq(lines.length, 1);
    ok(lines[0].command.length < longCommand.length, "logged command should be shorter than the original");
    ok(lines[0].command.length <= 20020, "logged command should be capped near the truncation threshold");
    ok(lines[0].command.startsWith("git status"), "logged command should keep the original's own prefix");
  });

  test("an unwritable log directory does not change the decision and does not write to stdout", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    // Pre-create a plain FILE where the log directory would go, so the log's
    // own `mkdirSync(..., {recursive: true})` fails on every OS, without
    // relying on filesystem permission semantics that differ by platform.
    const p = agentPaths(home, "claude");
    fs.mkdirSync(p.stateDir, { recursive: true });
    fs.writeFileSync(path.join(p.stateDir, "logs"), "not a directory", "utf8");

    const result = runDispatcher(CLAUDE_DISPATCH, shellPayload(HARMLESS_COMMAND, cwd), { home, cwd });
    eq(result.code, 0);
    eq(result.stdout, "");
    eq(result.stderr, "");
  });

  test("a log line is valid JSON and carries every documented field", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    const target = path.join(cwd, "notes.txt");
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: target, content: "hello" },
      cwd,
      session_id: "session-abc-123",
    };
    runDispatcher(CLAUDE_DISPATCH, payload, { home, cwd });

    const lines = readGuardLog(home, "claude");
    eq(lines.length, 1);
    const entry = lines[0];

    for (const field of [
      "ts",
      "agent",
      "event",
      "tool",
      "action",
      "ruleId",
      "advisory",
      "filePath",
      "command",
      "cwd",
      "sessionId",
      "agentId",
      "agentType",
    ]) {
      ok(Object.prototype.hasOwnProperty.call(entry, field), `log entry should carry ${field}`);
    }

    eq(entry.agent, "claude");
    eq(entry.event, "PreToolUse");
    eq(entry.tool, "Write");
    eq(entry.sessionId, "session-abc-123");
    eq(entry.agentId, null);
    eq(entry.agentType, null);
    ok(!Number.isNaN(Date.parse(entry.ts)), "ts should be a parseable ISO-8601 timestamp");
  });
});
