"use strict";

/**
 * The in-session approval channel — `adapters/shared/approve-from-prompt.js`,
 * the `UserPromptSubmit` hook that lets a developer say yes to an `ask`
 * without leaving the session they are already in.
 *
 * Run as a real child process fed a real payload on stdin, exactly like the
 * dispatcher suites: this hook's whole value rests on it behaving correctly
 * as a process the host launches, and an in-process call would not catch it
 * hanging on stdin, writing to the wrong stream, or exiting non-zero and
 * failing the developer's turn.
 *
 * Two properties are load-bearing and each has its own test below:
 *
 * 1. **Only a person can use it.** The event is raised by the host from what
 *    the developer typed; a tool call cannot author one, and a subagent does
 *    not raise one (measured on Codex 0.149.1 with `multi_agent_v2` on).
 *    The payload check here is the second lock on that door.
 * 2. **It can never break a turn.** Malformed stdin, an unwritable state
 *    directory, an empty payload — every one of them must exit 0 and leave
 *    the developer's message untouched.
 */

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");
const { runDispatcher, agentPaths } = require("./_spawn");

/** Absolute path to the approval hook under test. */
const APPROVE_HOOK = path.join(__dirname, "..", "..", "adapters", "shared", "approve-from-prompt.js");

/**
 * Builds a `UserPromptSubmit` payload carrying one typed message.
 *
 * @param {string} prompt What the developer typed.
 * @param {object} [extra] Extra top-level payload fields, for the subagent
 * case.
 * @returns {object} The payload.
 */
function promptPayload(prompt, extra) {
  return { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: process.cwd(), prompt, ...(extra || {}) };
}

/**
 * Reads the approvals file an agent's state directory holds.
 *
 * @param {string} home The scratch `SOFTELA_AI_HOME`.
 * @param {string} agent `"claude"` or `"codex"`.
 * @returns {object} The parsed approvals map, `{}` when the file is absent.
 */
function approvalsIn(home, agent) {
  const file = agentPaths(home, agent).approvals;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Runs the hook against one typed message.
 *
 * @param {string} home The scratch `SOFTELA_AI_HOME`.
 * @param {string} agent `"claude"` or `"codex"`.
 * @param {*} payload The stdin payload.
 * @returns {object} A `runDispatcher` result.
 */
function runHook(home, agent, payload) {
  return runDispatcher(APPROVE_HOOK, payload, { home, args: [`--agent=${agent}`] });
}

suite("adapters/approve-from-prompt", ({ test, eq, ok, tmpdir }) => {
  /* ------------------------------------------------------------ granting */

  for (const agent of ["claude", "codex"]) {
    test(`[${agent}] a developer typing the approval line grants a time-boxed approval for exactly that rule`, () => {
      const home = tmpdir();
      const result = runHook(home, agent, promptPayload("softela approve branch-naming"));

      eq(result.code, 0);
      const granted = approvalsIn(home, agent);
      ok(granted["branch-naming"], `expected an approval to be recorded, got: ${JSON.stringify(granted)}`);
      ok(
        Date.parse(granted["branch-naming"].until) > Date.now(),
        "the approval must be live, not already expired",
      );
      eq(Object.keys(granted).length, 1, "exactly one rule may be approved by one line");

      // The agent is told it may retry, and told what the approval does not cover.
      ok(result.parsed, `expected a JSON report, got: ${JSON.stringify(result.stdout)}`);
      ok(result.parsed.hookSpecificOutput.additionalContext.includes("branch-naming"), result.stdout);
      ok(result.parsed.systemMessage.includes("branch-naming"), "the developer must see it too, not only the agent");
    });
  }

  test("the approval a typed line writes is the same one the engine already reads", () => {
    // Not a separate mechanism: this must land in the exact file
    // `core/lib/approvals.js` checks, so `softela-ai approve --list` and `doctor`
    // report it and the engine honours it, with no second code path.
    const home = tmpdir();
    runHook(home, "codex", promptPayload("softela approve protected-paths"));

    const previous = process.env.SOFTELA_AI_HOME;
    process.env.SOFTELA_AI_HOME = home;
    try {
      const approvals = require("../../core/lib/approvals");
      ok(approvals.isApproved("protected-paths", { agent: "codex" }), "the engine's own check must see it");
      ok(!approvals.isApproved("branch-naming", { agent: "codex" }), "and must not see one that was never granted");
    } finally {
      if (previous === undefined) delete process.env.SOFTELA_AI_HOME;
      else process.env.SOFTELA_AI_HOME = previous;
    }
  });

  test("both host command prefixes are accepted, since each host spells a command its own way", () => {
    for (const line of ["/softela approve reuse-before-new", "$softela approve reuse-before-new", "softela-ai approve reuse-before-new"]) {
      const home = tmpdir();
      runHook(home, "claude", promptPayload(line));
      ok(approvalsIn(home, "claude")["reuse-before-new"], `expected "${line}" to be recognised`);
    }
  });

  test("text after the rule id is ignored, so a trailing comment costs nothing", () => {
    const home = tmpdir();
    runHook(home, "claude", promptPayload("softela approve file-size-limit — yes, this file really is that big"));
    ok(approvalsIn(home, "claude")["file-size-limit"], "a trailing comment must not defeat the command");
  });

  /* --------------------------------------------------------- not granting */

  test("a subagent's payload never grants anything, however it is worded", () => {
    // The structural guarantee is that the host raises this event from the
    // developer's keystrokes and no tool call can author one. This is the
    // second lock: a payload marked as a subagent's is refused outright.
    const home = tmpdir();
    const result = runHook(
      home,
      "codex",
      promptPayload("softela approve protected-paths", { agent_id: "01a0-abc", agent_type: "default" }),
    );

    eq(result.code, 0);
    eq(result.stdout.trim(), "", "a refused payload must report nothing at all");
    eq(Object.keys(approvalsIn(home, "codex")).length, 0, "a subagent must never be able to grant an approval");
  });

  test("merely discussing the command does not grant anything", () => {
    // The most likely false positive by far: the denial text names the line,
    // so the words appear in the conversation constantly. Only a message that
    // STARTS with the command counts.
    const lines = [
      "please softela approve branch-naming",
      "what does softela approve branch-naming actually do?",
      "it told me to run softela approve protected-paths",
      "softela approve",
      "approve branch-naming",
    ];
    for (const line of lines) {
      const home = tmpdir();
      const result = runHook(home, "claude", promptPayload(line));
      eq(result.code, 0);
      eq(
        Object.keys(approvalsIn(home, "claude")).length,
        0,
        `"${line}" must not be read as an approval`,
      );
    }
  });

  test("a mistyped rule id grants nothing, rather than silently approving its own prefix", () => {
    // The id must run to whitespace or end of message. Without that,
    // `Not_Valid` matched its longest valid prefix and approved `not` — a
    // developer believing they approved one thing while something else was
    // written is worse than the command simply not being recognised.
    const home = tmpdir();
    runHook(home, "claude", promptPayload("softela approve Not_Valid"));
    eq(Object.keys(approvalsIn(home, "claude")).length, 0, "a malformed id must be refused, not truncated");
  });

  /* -------------------------------------------------------------- fail-safe */

  test("nothing this hook can be fed fails the developer's turn", () => {
    const cases = [
      { label: "empty stdin", payload: "" },
      { label: "malformed JSON", payload: "{not json at all" },
      { label: "JSON that is not an object", payload: "[1,2,3]" },
      { label: "an object with no prompt", payload: { hook_event_name: "UserPromptSubmit" } },
      { label: "a non-string prompt", payload: promptPayload(42) },
    ];
    for (const c of cases) {
      const home = tmpdir();
      const result = runHook(home, "claude", c.payload);
      eq(result.code, 0, `${c.label}: must exit 0, got ${result.code} (stderr: ${result.stderr})`);
      eq(result.stderr.trim(), "", `${c.label}: must write nothing to stderr`);
    }
  });

  test("an unwritable state directory reports the failure instead of claiming an approval that was never written", () => {
    const home = tmpdir();
    // A FILE where the state directory should be: the write cannot succeed,
    // and the hook must say so rather than tell the agent to retry.
    const stateDir = agentPaths(home, "claude").stateDir;
    fs.mkdirSync(path.dirname(stateDir), { recursive: true });
    fs.writeFileSync(stateDir, "not a directory", "utf8");

    const result = runHook(home, "claude", promptPayload("softela approve branch-naming"));

    eq(result.code, 0, "even this must not fail the turn");
    ok(result.parsed, `expected a report, got: ${JSON.stringify(result.stdout)}`);
    ok(
      result.parsed.systemMessage.includes("Nothing was approved"),
      `must state plainly that nothing was approved, got: ${result.parsed.systemMessage}`,
    );
  });
});
