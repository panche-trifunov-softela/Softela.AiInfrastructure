"use strict";

/**
 * Replicates, against the real dispatchers and this repository's own real,
 * shipped `projects/` directory, the exact field-test failure that motivated
 * `core/lib/workdir.js#extractShellWorkdir`: an agent working from a
 * multi-repository session's own PARENT directory — not a git repository at
 * all — runs `cd Softela.PestManagement && dotnet ef migrations add X`. Before the
 * fix, `ctx.cwd` stayed the parent, `resolveProject` matched nothing, fell
 * back to `_default`, and `forbidden-commands` — which is entirely
 * project-configured — never even had a `commands.forbidden` pattern to test
 * against, so the known-bad invocation passed silently.
 *
 * The scratch repository below is a throwaway git init'd for this test, not
 * the developer's own real checkout — this never reads or writes anything
 * under the developer's actual repositories.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { suite } = require("../harness");
const { CLAUDE_DISPATCH, CODEX_DISPATCH, runDispatcher } = require("./_spawn");

/**
 * Builds a scratch parent directory holding one subdirectory literally
 * named `Softela.PestManagement`, git-initialised with a remote matching
 * `projects/Softela.PestManagement.json`'s own `match.remotes` pattern —
 * exactly the on-disk shape a multi-repository checkout has, without
 * touching anything the developer actually owns.
 *
 * @param {() => string} tmpdir The suite's disposable-directory factory.
 * @returns {{parent: string, repo: string}} The non-repository parent
 * directory, and the product repository nested inside it.
 */
function buildScratchCheckout(tmpdir) {
  const parent = tmpdir();
  const repo = path.join(parent, "Softela.PestManagement");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync(
    "git",
    ["remote", "add", "origin", "git@dev.azure.com:v3/org/Softela.PestManagement.git"],
    { cwd: repo },
  );
  return { parent, repo };
}

/** The known-bad invocation `projects/Softela.PestManagement.json`'s own `commands.forbidden` pattern matches. */
const TRAP_COMMAND = "cd Softela.PestManagement && dotnet ef migrations add Init";

suite("adapters/shell-workdir-field-test", ({ test, eq, ok, tmpdir }) => {
  test("Claude Code: cd Softela.PestManagement && dotnet ef reaches forbidden-commands from the PARENT directory", () => {
    const { parent } = buildScratchCheckout(tmpdir);
    const home = tmpdir();

    const payload = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: TRAP_COMMAND }, cwd: parent };
    const result = runDispatcher(CLAUDE_DISPATCH, payload, { home, cwd: parent });

    eq(result.code, 0);
    ok(result.parsed !== null, "expected a decision on stdout");
    eq(result.parsed.hookSpecificOutput.permissionDecision, "deny");
    const reason = result.parsed.hookSpecificOutput.permissionDecisionReason;
    ok(reason.includes("forbidden-commands"), "reason should name the rule that actually fired");
  });

  test("Codex: an exec call wrapping the same trap reaches forbidden-commands from the PARENT directory", () => {
    const { parent } = buildScratchCheckout(tmpdir);
    const home = tmpdir();

    const source = [`const r = await tools.shell_command({command: "${TRAP_COMMAND}"});`, "text(r);"].join("\n");
    const payload = { hook_event_name: "PreToolUse", tool_name: "exec", tool_input: { input: source }, cwd: parent };
    const result = runDispatcher(CODEX_DISPATCH, payload, { home, cwd: parent });

    eq(result.code, 0);
    ok(result.parsed !== null, "expected a decision on stdout");
    eq(result.parsed.hookSpecificOutput.permissionDecision, "deny");
    const reason = result.parsed.hookSpecificOutput.permissionDecisionReason;
    ok(reason.includes("forbidden-commands"), "reason should name the rule that actually fired");
    ok(reason.includes("shell_command"), "reason should name the nested operation that triggered it");
  });

  test("control: the same command run directly INSIDE the repository already worked, and still does", () => {
    const { repo } = buildScratchCheckout(tmpdir);
    const home = tmpdir();

    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "dotnet ef migrations add Init" },
      cwd: repo,
    };
    const result = runDispatcher(CLAUDE_DISPATCH, payload, { home, cwd: repo });

    eq(result.code, 0);
    ok(result.parsed !== null, "expected a decision on stdout");
    eq(result.parsed.hookSpecificOutput.permissionDecision, "deny");
    const reason = result.parsed.hookSpecificOutput.permissionDecisionReason;
    ok(reason.includes("forbidden-commands"), "reason should name the rule that actually fired");
  });
});
