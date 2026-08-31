"use strict";

const path = require("path");
const fs = require("fs");
const { suite } = require("../harness");
const { CLAUDE_DISPATCH, runDispatcher, agentPaths, writeState } = require("./_spawn");

/** A shell command no rule in this repository flags, used to prove a failure path blocks nothing. */
const HARMLESS_COMMAND = "git status";

/** A command `infra-self-protection` denies, used to check the reason text carries the rule id and the fix. */
const SELF_APPROVE_COMMAND = "softela-ai approve subagent-model";

/**
 * Builds a minimal, well-formed `PreToolUse` payload for a shell command.
 *
 * @param {string} command The shell command line.
 * @param {string} cwd The working directory to report.
 * @returns {object} A Claude Code-shaped payload.
 */
function shellPayload(command, cwd) {
  return { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd };
}

suite("adapters/claude-dispatch", ({ test, eq, ok, tmpdir }) => {
  /* ------------------------------------------------------------- fail-open */

  test("fail-open: unparseable JSON on stdin blocks nothing", () => {
    const home = tmpdir();
    const result = runDispatcher(CLAUDE_DISPATCH, "{ this is not json", { home, cwd: tmpdir() });
    eq(result.code, 0);
    eq(result.stdout, "");
    eq(result.parsed, null);
  });

  test("fail-open: empty stdin blocks nothing", () => {
    const home = tmpdir();
    const result = runDispatcher(CLAUDE_DISPATCH, undefined, { home, cwd: tmpdir() });
    eq(result.code, 0);
    eq(result.stdout, "");
  });

  test("fail-open: a bare JSON array payload blocks nothing", () => {
    const home = tmpdir();
    const result = runDispatcher(CLAUDE_DISPATCH, "[1, 2, 3]", { home, cwd: tmpdir() });
    eq(result.code, 0);
    eq(result.stdout, "");
  });

  test("fail-open: a missing state file blocks nothing", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    // No .softela-ai directory exists under `home` at all — loadState() must fall
    // back to defaults instead of throwing on a missing file.
    const result = runDispatcher(CLAUDE_DISPATCH, shellPayload(HARMLESS_COMMAND, cwd), { home, cwd });
    eq(result.code, 0);
    eq(result.stdout, "");
  });

  test("fail-open: a corrupt state file blocks nothing", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    const p = agentPaths(home, "claude");
    fs.mkdirSync(p.stateDir, { recursive: true });
    fs.writeFileSync(p.stateFile, "{ not valid json at all", "utf8");
    const result = runDispatcher(CLAUDE_DISPATCH, shellPayload(HARMLESS_COMMAND, cwd), { home, cwd });
    eq(result.code, 0);
    eq(result.stdout, "");
  });

  test("fail-open: a working directory that cannot be read blocks nothing", () => {
    const home = tmpdir();
    // The payload names a cwd nobody ever created, simulating a host
    // reporting a project directory that has since moved or been deleted.
    const goneDir = path.join(tmpdir(), "this-directory-was-never-created");
    const result = runDispatcher(CLAUDE_DISPATCH, shellPayload(HARMLESS_COMMAND, goneDir), { home });
    eq(result.code, 0);
    eq(result.stdout, "");
  });

  /* ------------------------------------------------------------ happy path */

  test("a passing tool call writes nothing to stdout and exits 0", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    const result = runDispatcher(CLAUDE_DISPATCH, shellPayload(HARMLESS_COMMAND, cwd), { home, cwd });
    eq(result.code, 0);
    eq(result.stdout, "");
    eq(result.stderr, "");
  });

  test("a denied tool call still exits 0, and the reason carries the rule id and the fix", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    const result = runDispatcher(CLAUDE_DISPATCH, shellPayload(SELF_APPROVE_COMMAND, cwd), { home, cwd });
    eq(result.code, 0);
    ok(result.parsed !== null, "expected a decision on stdout");
    eq(result.parsed.hookSpecificOutput.permissionDecision, "deny");
    const reason = result.parsed.hookSpecificOutput.permissionDecisionReason;
    ok(reason.includes("infra-self-protection"), "reason should name the rule");
    ok(reason.includes("Fix:") || reason.includes("Ask the developer"), "reason should carry a fix");
  });

  /* ------------------------------------------------------- module gating */

  test("a subagent spawn is judged once its module is enabled via local state", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    writeState(home, "claude", { modules: ["agent-orchestration"] });
    const payload = { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: {}, cwd };
    const result = runDispatcher(CLAUDE_DISPATCH, payload, { home, cwd });
    eq(result.code, 0);
    ok(result.parsed !== null);
    eq(result.parsed.hookSpecificOutput.permissionDecision, "deny");
    ok(
      result.parsed.hookSpecificOutput.permissionDecisionReason.includes("subagent-model"),
      "reason should name the rule",
    );
  });

  /* -------------------------------------------------------- SOFTELA_AI_EXIT2 */

  test("SOFTELA_AI_EXIT2=1 exits 0 for a plain ask decision, so a native ask still reaches the developer", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    writeState(home, "claude", { modules: ["agent-orchestration"] });
    // model: "opus" resolves to an `ask`, not a `deny` — see
    // tests/adapters/parity.test.js's own use of this same shape.
    const payload = { hook_event_name: "PreToolUse", tool_name: "Task", tool_input: { model: "opus" }, cwd };
    const result = runDispatcher(CLAUDE_DISPATCH, payload, { home, cwd, env: { SOFTELA_AI_EXIT2: "1" } });
    ok(result.parsed !== null, "expected a decision on stdout");
    eq(result.parsed.hookSpecificOutput.permissionDecision, "ask");
    eq(result.code, 0);
    eq(result.stderr, "");
  });

  test("SOFTELA_AI_EXIT2=1 exits 2 for a deny decision", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    const result = runDispatcher(CLAUDE_DISPATCH, shellPayload(SELF_APPROVE_COMMAND, cwd), {
      home,
      cwd,
      env: { SOFTELA_AI_EXIT2: "1" },
    });
    ok(result.parsed !== null, "expected a decision on stdout");
    eq(result.parsed.hookSpecificOutput.permissionDecision, "deny");
    eq(result.code, 2);
    ok(result.stderr.includes("infra-self-protection"), "stderr should carry the composed reason");
  });

  test("SOFTELA_AI_EXIT2=1 still exits 0 for an advisory ask, never a hard block", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    const target = path.join(cwd, "src", "components", "Huge.tsx");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const big = Array.from({ length: 1700 }, (_, i) => `const x${i} = ${i};`).join("\n");
    fs.writeFileSync(target, big, "utf8");

    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: target, content: `${big}\nconst extra = 1;` },
      cwd,
    };
    const result = runDispatcher(CLAUDE_DISPATCH, payload, { home, cwd, env: { SOFTELA_AI_EXIT2: "1" } });
    eq(result.code, 0);
    eq(result.stderr, "");
  });

  /* -------------------------------------------------------- advisory ask */

  test("a nudge (advisory ask) produces additionalContext and no permissionDecision, so the call proceeds", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    // file-size-limit declares advisoryAsk: true and is newCodeOnly — writing
    // a further line to an already-oversized, pre-existing frontend file is
    // exactly the nudge case: advice, not a request for the developer's
    // decision. Same fixture tests/adapters/parity.test.js uses for the
    // equivalent Codex assertion.
    const target = path.join(cwd, "src", "components", "Huge.tsx");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const big = Array.from({ length: 1700 }, (_, i) => `const x${i} = ${i};`).join("\n");
    fs.writeFileSync(target, big, "utf8");

    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: target, content: `${big}\nconst extra = 1;` },
      cwd,
    };
    const result = runDispatcher(CLAUDE_DISPATCH, payload, { home, cwd });

    eq(result.code, 0);
    ok(result.parsed !== null, "expected an advisory on stdout");
    const out = result.parsed.hookSpecificOutput;
    eq(out.permissionDecision, undefined, "an advisory ask must not carry a permissionDecision");
    ok(typeof out.additionalContext === "string" && out.additionalContext.length > 0, "expected additionalContext");
    ok(out.additionalContext.includes("file-size-limit"), "advisory should name the rule");
    ok(out.additionalContext.includes("Fix:"), "advisory should carry the fix");
    ok(out.additionalContext.includes("Split the file"), "advisory should carry the rule's own fix text");
    eq(result.parsed.systemMessage, out.additionalContext, "the developer-visible half must match the agent-visible one");
  });

  test("an ask WITHOUT the advisory mark still produces permissionDecision: ask", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    writeState(home, "claude", { modules: ["agent-orchestration"] });
    // subagent-model's ask (a frontier-tier model spawn) is a genuine request
    // for the developer's decision, not a nudge — it must keep blocking as a
    // native ask, unaffected by the advisory channel added for nudges.
    const payload = { hook_event_name: "PreToolUse", tool_name: "Task", tool_input: { model: "opus" }, cwd };
    const result = runDispatcher(CLAUDE_DISPATCH, payload, { home, cwd });

    eq(result.code, 0);
    ok(result.parsed !== null, "expected a decision on stdout");
    const out = result.parsed.hookSpecificOutput;
    eq(out.permissionDecision, "ask");
    eq(out.additionalContext, undefined, "a genuine ask must not be rerouted through the advisory channel");
    ok(out.permissionDecisionReason.includes("subagent-model"), "reason should name the rule");
  });

  test("a deny is unaffected by the advisory channel, including under SOFTELA_AI_EXIT2", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    const result = runDispatcher(CLAUDE_DISPATCH, shellPayload(SELF_APPROVE_COMMAND, cwd), {
      home,
      cwd,
      env: { SOFTELA_AI_EXIT2: "1" },
    });
    eq(result.code, 2);
    ok(result.parsed !== null, "expected a decision on stdout");
    const out = result.parsed.hookSpecificOutput;
    eq(out.permissionDecision, "deny");
    eq(out.additionalContext, undefined, "a deny must never be routed through the advisory channel");
    ok(result.stderr.includes("infra-self-protection"), "stderr should carry the composed reason");
  });
});
