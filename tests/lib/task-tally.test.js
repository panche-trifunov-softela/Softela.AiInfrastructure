"use strict";

const fs = require("fs");
const path = require("path");

const { suite } = require("../harness");
const { readTaskTally, TASK_TALLY_READ_BOUND_BYTES } = require("../../core/lib/task-tally");
const { guardLogPath } = require("../../core/lib/paths");

/** A fixed log date every test in this suite uses, so no test depends on today's date. */
const LOG_DATE = "2026-01-01";

/**
 * Builds one guard-activity log record, defaulted to a harmless passing
 * `Read` for a given session, with `overrides` layered on top.
 *
 * @param {object} overrides Fields to override on the default record.
 * @returns {object} One record shaped exactly like `logGuardActivity`'s own
 * output (`adapters/shared/dispatch-core.js`).
 */
function record(overrides) {
  return Object.assign(
    {
      ts: new Date().toISOString(),
      agent: "claude",
      event: "PreToolUse",
      tool: "Read",
      action: "pass",
      ruleId: null,
      advisory: false,
      filePath: null,
      command: null,
      cwd: "",
      sessionId: null,
      agentId: null,
      agentType: null,
    },
    overrides,
  );
}

/**
 * Writes a guard-activity log file for the given agent/date under the
 * currently active `SOFTELA_AI_HOME`, from a list of already-built records.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @param {string} date The `YYYY-MM-DD` log date.
 * @param {object[]} records The records to write, one JSON line each, in
 * order.
 * @returns {string} The log file's path.
 */
function writeLog(agent, date, records) {
  const logPath = guardLogPath(agent, date);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
  return logPath;
}

suite("lib/task-tally", ({ test, eq, deepEq, notThrows, fakeHome }) => {
  test("distinct file paths are counted once, regardless of separator or case", () => {
    fakeHome();
    writeLog("claude", LOG_DATE, [
      record({ tool: "Read", filePath: "C:/repo/src/a.js", sessionId: "s1" }),
      record({ tool: "Read", filePath: "C:\\repo\\src\\A.JS", sessionId: "s1" }),
      record({ tool: "Read", filePath: "C:/repo/src/b.js", sessionId: "s1" }),
    ]);

    deepEq(readTaskTally("claude", "s1", { date: LOG_DATE }), { filesRead: 2, filesWritten: 0 });
  });

  test("a record from a foreign session is ignored", () => {
    fakeHome();
    writeLog("claude", LOG_DATE, [
      record({ tool: "Read", filePath: "C:/repo/a.js", sessionId: "s1" }),
      record({ tool: "Read", filePath: "C:/repo/b.js", sessionId: "other-session" }),
    ]);

    deepEq(readTaskTally("claude", "s1", { date: LOG_DATE }), { filesRead: 1, filesWritten: 0 });
  });

  test("a record carrying an agentId is ignored, since it was produced inside a subagent", () => {
    fakeHome();
    writeLog("claude", LOG_DATE, [
      record({ tool: "Write", filePath: "C:/repo/a.js", sessionId: "s1", agentId: null }),
      record({ tool: "Write", filePath: "C:/repo/b.js", sessionId: "s1", agentId: "sub-1" }),
    ]);

    deepEq(readTaskTally("claude", "s1", { date: LOG_DATE }), { filesRead: 0, filesWritten: 1 });
  });

  test("records before the last UserPromptSubmit marker for this session are excluded", () => {
    fakeHome();
    writeLog("claude", LOG_DATE, [
      record({ tool: "Read", filePath: "C:/repo/old.js", sessionId: "s1" }),
      record({ event: "UserPromptSubmit", tool: "", sessionId: "s1" }),
      record({ tool: "Read", filePath: "C:/repo/new.js", sessionId: "s1" }),
    ]);

    deepEq(readTaskTally("claude", "s1", { date: LOG_DATE }), { filesRead: 1, filesWritten: 0 });
  });

  test("a null-session UserPromptSubmit marker resets every session for this agent", () => {
    fakeHome();
    writeLog("claude", LOG_DATE, [
      record({ tool: "Read", filePath: "C:/repo/old.js", sessionId: "s1" }),
      // A host that could not say which session the prompt belongs to still
      // has to reset every session's count conservatively.
      record({ event: "UserPromptSubmit", tool: "", sessionId: null }),
      record({ tool: "Read", filePath: "C:/repo/new.js", sessionId: "s1" }),
    ]);

    deepEq(readTaskTally("claude", "s1", { date: LOG_DATE }), { filesRead: 1, filesWritten: 0 });
  });

  test("a missing log file returns null", () => {
    fakeHome();
    // No log file written at all for this date — `guardLogPath` resolves to a
    // path that does not exist yet.
    eq(readTaskTally("claude", "s1", { date: LOG_DATE }), null);
  });

  test("a missing or empty sessionId returns null without reading the log at all", () => {
    fakeHome();
    writeLog("claude", LOG_DATE, [record({ tool: "Read", filePath: "C:/repo/a.js", sessionId: "s1" })]);

    eq(readTaskTally("claude", "", { date: LOG_DATE }), null);
    eq(readTaskTally("claude", undefined, { date: LOG_DATE }), null);
    eq(readTaskTally("claude", null, { date: LOG_DATE }), null);
  });

  test("a corrupt or half-written line is skipped without throwing", () => {
    fakeHome();
    const logPath = guardLogPath("claude", LOG_DATE);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const goodLine = JSON.stringify(record({ tool: "Read", filePath: "C:/repo/a.js", sessionId: "s1" }));
    // A truncated final line, as a crash mid-append would leave behind.
    const halfWrittenLine = '{"ts":"2026-01-01T00:00:00.000Z","agent":"claude","tool":"Wr';
    fs.writeFileSync(logPath, `${goodLine}\n${halfWrittenLine}`, "utf8");

    let result;
    notThrows(() => {
      result = readTaskTally("claude", "s1", { date: LOG_DATE });
    });
    deepEq(result, { filesRead: 1, filesWritten: 0 });
  });

  test("a file with only corrupt content returns null, since nothing usable was parsed", () => {
    fakeHome();
    const logPath = guardLogPath("claude", LOG_DATE);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, "not json at all\nneither is this\n", "utf8");

    eq(readTaskTally("claude", "s1", { date: LOG_DATE }), null);
  });

  test("a file larger than the read bound does not throw and still returns a usable count", () => {
    fakeHome();
    const logPath = guardLogPath("claude", LOG_DATE);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });

    // Pad the file well past the read bound with old, irrelevant records for
    // a different session, so they fall entirely outside the tail window.
    const padLine = JSON.stringify(record({ tool: "Read", filePath: "C:/repo/pad.js", sessionId: "other" }));
    const padCount = Math.ceil((TASK_TALLY_READ_BOUND_BYTES * 2) / (padLine.length + 1)) + 10;
    const lines = [];
    for (let i = 0; i < padCount; i++) lines.push(padLine);

    // The marker and the records that should actually be counted land near
    // the end of the file, safely inside the last TASK_TALLY_READ_BOUND_BYTES
    // bytes.
    lines.push(JSON.stringify(record({ event: "UserPromptSubmit", tool: "", sessionId: "s1" })));
    lines.push(JSON.stringify(record({ tool: "Read", filePath: "C:/repo/real.js", sessionId: "s1" })));
    lines.push(JSON.stringify(record({ tool: "Write", filePath: "C:/repo/real.js", sessionId: "s1" })));

    fs.writeFileSync(logPath, `${lines.join("\n")}\n`, "utf8");
    const size = fs.statSync(logPath).size;
    eq(size > TASK_TALLY_READ_BOUND_BYTES, true, "fixture file must actually exceed the read bound");

    let result;
    notThrows(() => {
      result = readTaskTally("claude", "s1", { date: LOG_DATE });
    });
    deepEq(result, { filesRead: 1, filesWritten: 1 });
  });
});
