"use strict";

const path = require("path");
const fs = require("fs");
const { suite } = require("../harness");
const { CODEX_DISPATCH, runDispatcher, agentPaths, writeState } = require("./_spawn");

/** A shell command no rule in this repository flags, used to prove a failure path blocks nothing. */
const HARMLESS_COMMAND = ["git", "status"];

/** A command `infra-self-protection` denies, used to check the reason text carries the rule id and the fix. */
const SELF_APPROVE_COMMAND = ["softela-ai", "approve", "subagent-model"];

/**
 * Builds a minimal, well-formed `PreToolUse` payload for a shell command, in
 * Codex's own shape: `local_shell` with the command as an argv array.
 *
 * @param {string[]} command The argv of the shell command.
 * @param {string} cwd The working directory to report.
 * @returns {object} A Codex-shaped payload.
 */
function shellPayload(command, cwd) {
  return { hook_event_name: "PreToolUse", tool_name: "local_shell", tool_input: { command }, cwd };
}

suite("adapters/codex-dispatch", ({ test, eq, ok, tmpdir }) => {
  /* ------------------------------------------------------------- fail-open */

  test("fail-open: unparseable JSON on stdin blocks nothing", () => {
    const home = tmpdir();
    const result = runDispatcher(CODEX_DISPATCH, "{ this is not json", { home, cwd: tmpdir() });
    eq(result.code, 0);
    eq(result.stdout, "");
    eq(result.parsed, null);
  });

  test("fail-open: empty stdin blocks nothing", () => {
    const home = tmpdir();
    const result = runDispatcher(CODEX_DISPATCH, undefined, { home, cwd: tmpdir() });
    eq(result.code, 0);
    eq(result.stdout, "");
  });

  test("fail-open: a bare JSON array payload blocks nothing", () => {
    const home = tmpdir();
    const result = runDispatcher(CODEX_DISPATCH, "[1, 2, 3]", { home, cwd: tmpdir() });
    eq(result.code, 0);
    eq(result.stdout, "");
  });

  test("fail-open: a missing state file blocks nothing", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    // No .softela-ai directory exists under `home` at all — loadState() must fall
    // back to defaults instead of throwing on a missing file.
    const result = runDispatcher(CODEX_DISPATCH, shellPayload(HARMLESS_COMMAND, cwd), { home, cwd });
    eq(result.code, 0);
    eq(result.stdout, "");
  });

  test("fail-open: a corrupt state file blocks nothing", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    const p = agentPaths(home, "codex");
    fs.mkdirSync(p.stateDir, { recursive: true });
    fs.writeFileSync(p.stateFile, "{ not valid json at all", "utf8");
    const result = runDispatcher(CODEX_DISPATCH, shellPayload(HARMLESS_COMMAND, cwd), { home, cwd });
    eq(result.code, 0);
    eq(result.stdout, "");
  });

  test("fail-open: a working directory that cannot be read blocks nothing", () => {
    const home = tmpdir();
    // The payload names a cwd nobody ever created, simulating a host
    // reporting a project directory that has since moved or been deleted.
    const goneDir = path.join(tmpdir(), "this-directory-was-never-created");
    const result = runDispatcher(CODEX_DISPATCH, shellPayload(HARMLESS_COMMAND, goneDir), { home });
    eq(result.code, 0);
    eq(result.stdout, "");
  });

  /* ------------------------------------------------------------ happy path */

  test("a passing tool call writes nothing to stdout and exits 0", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    const result = runDispatcher(CODEX_DISPATCH, shellPayload(HARMLESS_COMMAND, cwd), { home, cwd });
    eq(result.code, 0);
    eq(result.stdout, "");
    eq(result.stderr, "");
  });

  test("a denied tool call still exits 0, and the reason carries the rule id and the fix", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    const result = runDispatcher(CODEX_DISPATCH, shellPayload(SELF_APPROVE_COMMAND, cwd), { home, cwd });
    eq(result.code, 0);
    ok(result.parsed !== null, "expected a decision on stdout");
    eq(result.parsed.hookSpecificOutput.permissionDecision, "deny");
    const reason = result.parsed.hookSpecificOutput.permissionDecisionReason;
    ok(Boolean(reason) && reason.length > 0, "Codex requires a non-empty reason on every deny");
    ok(reason.includes("infra-self-protection"), "reason should name the rule");
  });

  /* ------------------------------------------------------- module gating */

  test("a subagent spawn is judged once its module is enabled via local state", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    writeState(home, "codex", { modules: ["agent-orchestration"] });
    const payload = { hook_event_name: "PreToolUse", tool_name: "agent", tool_input: {}, cwd };
    const result = runDispatcher(CODEX_DISPATCH, payload, { home, cwd });
    eq(result.code, 0);
    ok(result.parsed !== null);
    eq(result.parsed.hookSpecificOutput.permissionDecision, "deny");
    ok(
      result.parsed.hookSpecificOutput.permissionDecisionReason.includes("subagent-model"),
      "reason should name the rule",
    );
  });

  /* --------------------------------------------------------- host invariants */

  test("invariant: this host never emits permissionDecision: ask", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    writeState(home, "codex", { modules: ["agent-orchestration"] });
    const payload = { hook_event_name: "PreToolUse", tool_name: "agent", tool_input: { model: "opus" }, cwd };
    const result = runDispatcher(CODEX_DISPATCH, payload, { home, cwd });
    eq(result.code, 0);
    ok(result.parsed !== null, "an ask-worthy spawn must still produce a decision on Codex");
    ok(
      result.parsed.hookSpecificOutput.permissionDecision !== "ask",
      "Codex rejects permissionDecision: ask on PreToolUse by name",
    );
    ok(
      result.parsed.hookSpecificOutput.permissionDecision !== "allow",
      "Codex rejects permissionDecision: allow on PreToolUse by name",
    );
  });
});
