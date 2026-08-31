"use strict";

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");
const { CLAUDE_DISPATCH, CODEX_DISPATCH, runDispatcher, writeState, agentPaths } = require("./_spawn");

/**
 * Runs the same logical action through both dispatchers against a shared
 * fake home, so `agentPaths`-derived state (approvals.json, overrides.json,
 * installed roots) resolves identically for both — exactly as it would on
 * one developer's machine with both hosts installed.
 *
 * @param {object} claudePayload The Claude Code-shaped payload.
 * @param {object} codexPayload The Codex-shaped payload.
 * @param {{home: string, cwd?: string}} options `home` is shared by both
 * runs; `cwd` defaults to `home`.
 * @returns {{claude: object, codex: object}} Each dispatcher's
 * `{stdout, stderr, code, parsed}`.
 */
function runBoth(claudePayload, codexPayload, options) {
  const claude = runDispatcher(CLAUDE_DISPATCH, claudePayload, options);
  const codex = runDispatcher(CODEX_DISPATCH, codexPayload, options);
  return { claude, codex };
}

/**
 * Reads a dispatcher's decision fields out of its parsed stdout, tolerating
 * a `null` parse (a pass).
 *
 * @param {object} run One side of a {@link runBoth} result.
 * @returns {{decision: string | null, reason: string}} `decision` is
 * `permissionDecision`, or `null` when nothing was written; `reason` is
 * `permissionDecisionReason`, or `""` when there is none.
 */
function decisionOf(run) {
  const out = run.parsed && run.parsed.hookSpecificOutput;
  return { decision: out ? out.permissionDecision : null, reason: out ? out.permissionDecisionReason || "" : "" };
}

suite("adapters/parity", ({ test, eq, ok, tmpdir }) => {
  /* --------------------------------------------------------- shell denial */

  test("parity: a self-granted approval is denied on both hosts, for the same reason", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    const claudePayload = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "softela-ai approve subagent-model" },
      cwd,
    };
    const codexPayload = {
      hook_event_name: "PreToolUse",
      tool_name: "local_shell",
      tool_input: { command: ["softela-ai", "approve", "subagent-model"] },
      cwd,
    };
    const { claude, codex } = runBoth(claudePayload, codexPayload, { home, cwd });

    eq(claude.code, 0);
    eq(codex.code, 0);
    const c = decisionOf(claude);
    const x = decisionOf(codex);
    eq(c.decision, "deny");
    eq(x.decision, "deny");
    const sharedText = "`softela-ai approve` grants an approval from inside a tool call";
    ok(c.reason.includes(sharedText), "Claude reason should carry the rule's own text");
    ok(x.reason.includes(sharedText), "Codex reason should carry the same rule text");
    ok(c.reason.includes("infra-self-protection"), "Claude reason should name the rule");
    ok(x.reason.includes("infra-self-protection"), "Codex reason should name the rule");
  });

  /* ----------------------------------------------------------- shell pass */

  test("parity: an ordinary shell command passes on both hosts", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    const claudePayload = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" }, cwd };
    const codexPayload = {
      hook_event_name: "PreToolUse",
      tool_name: "local_shell",
      tool_input: { command: ["git", "status"] },
      cwd,
    };
    const { claude, codex } = runBoth(claudePayload, codexPayload, { home, cwd });

    eq(claude.code, 0);
    eq(codex.code, 0);
    eq(claude.stdout, "");
    eq(codex.stdout, "");
  });

  /* --------------------------------------------------------- file write */

  test("parity: a write to the approvals file is denied on both hosts, for the same reason", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    const claudeTarget = agentPaths(home, "claude").approvals;
    const codexTarget = agentPaths(home, "codex").approvals;
    const claudePayload = { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: claudeTarget, content: "{}" }, cwd };
    const codexPayload = { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { path: codexTarget, content: "{}" }, cwd };
    const { claude, codex } = runBoth(claudePayload, codexPayload, { home, cwd });

    eq(claude.code, 0);
    eq(codex.code, 0);
    const c = decisionOf(claude);
    const x = decisionOf(codex);
    eq(c.decision, "deny");
    eq(x.decision, "deny");
    const sharedText = "a write to the approvals or overrides file grants an approval from inside a tool call";
    ok(c.reason.includes(sharedText));
    ok(x.reason.includes(sharedText));
    ok(c.reason.includes("infra-self-protection"));
    ok(x.reason.includes("infra-self-protection"));
  });

  /* ----------------------------------------------------- subagent spawn */

  test("parity: a subagent spawn with no model is denied on both hosts, for the same reason", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    writeState(home, "claude", { modules: ["agent-orchestration"] });
    writeState(home, "codex", { modules: ["agent-orchestration"] });
    const claudePayload = { hook_event_name: "PreToolUse", tool_name: "Task", tool_input: {}, cwd };
    const codexPayload = { hook_event_name: "PreToolUse", tool_name: "agent", tool_input: {}, cwd };
    const { claude, codex } = runBoth(claudePayload, codexPayload, { home, cwd });

    eq(claude.code, 0);
    eq(codex.code, 0);
    const c = decisionOf(claude);
    const x = decisionOf(codex);
    eq(c.decision, "deny");
    eq(x.decision, "deny");
    const sharedText = "a subagent spawn with no explicit model inherits the session's own model";
    ok(c.reason.includes(sharedText));
    ok(x.reason.includes(sharedText));
    ok(c.reason.includes("subagent-model"));
    ok(x.reason.includes("subagent-model"));
  });

  /* --------------------------------------------------------------- ask */

  test("parity: an ask decision stays ask on Claude and becomes a named-approval denial on Codex", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    writeState(home, "claude", { modules: ["agent-orchestration"] });
    writeState(home, "codex", { modules: ["agent-orchestration"] });
    // Same model on both sides so the underlying rule reason text is
    // byte-identical, and only the two hosts' envelopes can differ.
    const claudePayload = { hook_event_name: "PreToolUse", tool_name: "Task", tool_input: { model: "opus" }, cwd };
    const codexPayload = { hook_event_name: "PreToolUse", tool_name: "agent", tool_input: { model: "opus" }, cwd };
    const { claude, codex } = runBoth(claudePayload, codexPayload, { home, cwd });

    eq(claude.code, 0);
    eq(codex.code, 0);
    const c = decisionOf(claude);
    const x = decisionOf(codex);

    // The one legitimate divergence: Claude can express "ask" natively.
    eq(c.decision, "ask");
    // Codex cannot: measured against the real binary, PreToolUse accepts
    // `deny` and nothing else, and every other spelling — `ask` included — is
    // rejected FAIL-OPEN, letting the call through unreviewed. So the default
    // askMode maps it onto a denial that names how the developer says yes.
    eq(x.decision, "deny");
    ok(
      x.reason.includes("softela approve subagent-model"),
      `Codex should name the in-session approval line, got: ${x.reason}`,
    );
    // ...and must NOT send them to a second terminal. That was the whole
    // reason the mechanism went unused: a rule wanting a second look turned
    // into a context switch, several times a day.
    ok(
      !x.reason.includes("in your own terminal"),
      `the approval must be answerable without leaving the session, got: ${x.reason}`,
    );

    // Everything else — the rule and its own reason text — must match.
    const sharedText = 'is a frontier-tier model. A single frontier session is a deliberate choice';
    ok(c.reason.includes(sharedText), "Claude reason should carry the rule's own text");
    ok(x.reason.includes(sharedText), "Codex reason should carry the same rule text");
    ok(c.reason.includes("subagent-model"));
    ok(x.reason.includes("subagent-model"));
  });

  test("parity: a nudge reaches Codex as advice, not as a typed approval, with askMode left at its default", () => {
    // The everyday case behind the whole change: `file-size-limit` is a
    // backstop, and on an existing file the engine has already reframed it
    // as advice. Claude Code renders that as one keystroke; Codex has no
    // interactive ask, so it used to become a denial the developer cleared
    // by typing `softela approve` — several times an hour, for a nudge. State
    // is written WITHOUT askMode so this is the default configuration, not
    // an opt-in.
    const home = tmpdir();
    const cwd = tmpdir();
    writeState(home, "codex", { modules: [] });

    const big = Array.from({ length: 1700 }, (_, i) => `const x${i} = ${i};`).join("\n");
    const target = path.join(cwd, "src", "components", "Huge.tsx");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, big, "utf8");

    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: target, content: `${big}\nconst extra = 1;` },
      cwd,
    };
    const codex = runDispatcher(CODEX_DISPATCH, payload, { home, cwd });

    eq(codex.code, 0);
    const out = codex.parsed && codex.parsed.hookSpecificOutput;
    ok(
      !out || out.permissionDecision === undefined,
      `a nudge must not block on Codex; got: ${codex.stdout || "(nothing)"}`,
    );
    if (codex.stdout.trim().length > 0) {
      ok(codex.stdout.includes("additionalContext"), "a nudge that fires is still reported, through additionalContext");
    }
  });

  test("parity: advise mode reports the same ask without blocking the call", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    writeState(home, "codex", { modules: ["agent-orchestration"], adapterOptions: { askMode: "advise" } });
    const payload = { hook_event_name: "PreToolUse", tool_name: "agent", tool_input: { model: "opus" }, cwd };
    const codex = runDispatcher(CODEX_DISPATCH, payload, { home, cwd });

    eq(codex.code, 0);
    ok(codex.stdout.trim().length > 0, "advise mode should still report the rule via additionalContext");
    ok(codex.stdout.includes("additionalContext"), "advise mode reports through additionalContext, not a decision");
    const out = codex.parsed && codex.parsed.hookSpecificOutput;
    ok(
      !out || out.permissionDecision === undefined,
      "advise mode must not carry a permissionDecision — the call proceeds",
    );
  });

  /* ------------------------------------------------------- SOFTELA_AI_EXIT2 */

  test("parity: SOFTELA_AI_EXIT2 blocks exactly when the wire-level decision is a deny, on both hosts", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    writeState(home, "claude", { modules: ["agent-orchestration"] });
    writeState(home, "codex", { modules: ["agent-orchestration"] });
    const options = { home, cwd, env: { SOFTELA_AI_EXIT2: "1" } };

    // A genuine denial: both hosts write permissionDecision "deny" and both
    // must additionally exit 2.
    const denyClaude = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "softela-ai approve subagent-model" }, cwd };
    const denyCodex = { hook_event_name: "PreToolUse", tool_name: "local_shell", tool_input: { command: ["softela-ai", "approve", "subagent-model"] }, cwd };
    const denyRuns = runBoth(denyClaude, denyCodex, options);
    eq(decisionOf(denyRuns.claude).decision, "deny");
    eq(denyRuns.claude.code, 2, "Claude must exit 2 for a real deny under SOFTELA_AI_EXIT2");
    eq(decisionOf(denyRuns.codex).decision, "deny");
    eq(denyRuns.codex.code, 2, "Codex must exit 2 for a real deny under SOFTELA_AI_EXIT2");

    // An `ask` from the rule: Claude expresses it natively as "ask" and must
    // NOT exit 2 — the flag would otherwise silently turn every ask into a
    // hard block the developer never sees. Codex has no native ask, so its
    // default askMode maps it onto an actual "deny" on the wire, and that
    // wire-level deny does get exit 2 — the same rule ("deny on the wire
    // exits 2") applied consistently, not a divergence.
    const askClaude = { hook_event_name: "PreToolUse", tool_name: "Task", tool_input: { model: "opus" }, cwd };
    const askCodex = { hook_event_name: "PreToolUse", tool_name: "agent", tool_input: { model: "opus" }, cwd };
    const askRuns = runBoth(askClaude, askCodex, options);
    eq(decisionOf(askRuns.claude).decision, "ask");
    eq(askRuns.claude.code, 0, "Claude must not exit 2 for a plain ask under SOFTELA_AI_EXIT2");
    eq(askRuns.claude.stderr, "");
    eq(decisionOf(askRuns.codex).decision, "deny");
    eq(askRuns.codex.code, 2, "Codex must exit 2 for its wire-level deny under SOFTELA_AI_EXIT2");
  });

  test("parity: SOFTELA_AI_EXIT2 never fires under Codex advise mode, which never denies", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    writeState(home, "codex", { modules: ["agent-orchestration"], adapterOptions: { askMode: "advise" } });
    const payload = { hook_event_name: "PreToolUse", tool_name: "agent", tool_input: { model: "opus" }, cwd };
    const codex = runDispatcher(CODEX_DISPATCH, payload, { home, cwd, env: { SOFTELA_AI_EXIT2: "1" } });

    eq(codex.code, 0);
    eq(codex.stderr, "");
  });

  /* ---------------------------------------------------------- garbage */

  test("parity: a garbage payload passes on both hosts and writes nothing", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    const garbage = "not json at all, just text";
    const claude = runDispatcher(CLAUDE_DISPATCH, garbage, { home, cwd });
    const codex = runDispatcher(CODEX_DISPATCH, garbage, { home, cwd });

    eq(claude.code, 0);
    eq(codex.code, 0);
    eq(claude.stdout, "");
    eq(codex.stdout, "");
  });

  /* -------------------------------------------------- host invariants */

  test("invariant: Codex never emits allow or ask, across every scenario above", () => {
    const home = tmpdir();
    const cwd = tmpdir();
    writeState(home, "codex", { modules: ["agent-orchestration"] });

    const scenarios = [
      { hook_event_name: "PreToolUse", tool_name: "local_shell", tool_input: { command: ["softela-ai", "approve", "x"] }, cwd },
      { hook_event_name: "PreToolUse", tool_name: "local_shell", tool_input: { command: ["git", "status"] }, cwd },
      { hook_event_name: "PreToolUse", tool_name: "agent", tool_input: { model: "opus" }, cwd },
      { hook_event_name: "PreToolUse", tool_name: "agent", tool_input: {}, cwd },
    ];

    for (const payload of scenarios) {
      const result = runDispatcher(CODEX_DISPATCH, payload, { home, cwd });
      eq(result.code, 0);
      const out = result.parsed && result.parsed.hookSpecificOutput;
      if (!out) continue;
      ok(out.permissionDecision !== "ask", `unexpected ask for ${JSON.stringify(payload.tool_input)}`);
      ok(out.permissionDecision !== "allow", `unexpected allow for ${JSON.stringify(payload.tool_input)}`);
      if (out.permissionDecision === "deny") {
        ok(
          typeof out.permissionDecisionReason === "string" && out.permissionDecisionReason.length > 0,
          "Codex requires a non-empty reason on every deny",
        );
      }
    }
  });
});
