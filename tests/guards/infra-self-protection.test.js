"use strict";

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");
const rule = require("../../core/guards/infra-self-protection");
const { installedRoot, stateDir, agentHome } = require("../../core/lib/paths");
const { PROJECT_MINIMAL, decide } = require("./_ctx");

suite("guards/infra-self-protection", ({ test, eq, ok }) => {
  /* -------------------------------------------------- installed infra: ask */

  test("a write under the installed infrastructure root asks", () => {
    const target = path.join(installedRoot("claude"), "hooks", "some-hook.js");
    eq(decide(rule, { toolName: "Write", filePath: target, content: "x" }), "ask");
  });

  test("a write to Claude's settings.json asks", () => {
    const target = path.join(agentHome("claude"), "settings.json");
    eq(decide(rule, { toolName: "Edit", filePath: target, content: "x" }), "ask");
  });

  test("a write to Codex's hooks.json asks", () => {
    const target = path.join(agentHome("codex"), "hooks.json");
    eq(decide(rule, { toolName: "Write", filePath: target, content: "x" }), "ask");
  });

  test("a write to Codex's config.toml asks", () => {
    const target = path.join(agentHome("codex"), "config.toml");
    eq(decide(rule, { toolName: "Edit", filePath: target, content: "x" }), "ask");
  });

  /* ------------------------------------------------- self-approval: deny */

  test("invoking softela-ai approve directly is denied", () => {
    eq(decide(rule, { toolName: "Bash", command: "softela-ai approve subagent-model" }), "deny");
  });

  test("invoking softela-ai approve with a --minutes flag is denied", () => {
    eq(decide(rule, { toolName: "Bash", command: "softela-ai approve subagent-model --minutes 120" }), "deny");
  });

  test("a write to approvals.json under the state directory is denied", () => {
    const target = path.join(stateDir("claude"), "approvals.json");
    eq(decide(rule, { toolName: "Write", filePath: target, content: "{}" }), "deny");
  });

  test("a write to overrides.json under the state directory is denied", () => {
    const target = path.join(stateDir("codex"), "overrides.json");
    eq(decide(rule, { toolName: "Edit", filePath: target, content: "{}" }), "deny");
  });

  test("deleting the state directory is denied", () => {
    eq(decide(rule, { toolName: "Bash", command: "rm -rf ~/.claude/.softela-ai" }), "deny");
  });

  test("a PowerShell removal of the state directory is denied", () => {
    eq(
      decide(rule, {
        toolName: "PowerShell",
        command: 'Remove-Item -Recurse -Force "$env:USERPROFILE\\.claude\\.softela-ai"',
      }),
      "deny",
    );
  });

  test("changing permissions on the state directory is denied", () => {
    eq(decide(rule, { toolName: "Bash", command: "chmod -R 000 ~/.claude/.softela-ai" }), "deny");
  });

  test("an icacls permission change on the state directory is denied", () => {
    eq(
      decide(rule, {
        toolName: "PowerShell",
        command: 'icacls "$env:USERPROFILE\\.claude\\.softela-ai" /deny Everyone:F',
      }),
      "deny",
    );
  });

  test("a shell redirect that writes approvals.json under the state directory is denied", () => {
    eq(decide(rule, { toolName: "Bash", command: "echo '{}' > ~/.claude/.softela-ai/approvals.json" }), "deny");
  });

  test("a PowerShell Set-Content that writes overrides.json under the state directory is denied", () => {
    eq(
      decide(rule, {
        toolName: "PowerShell",
        command: 'Set-Content -Path "$env:USERPROFILE\\.codex\\.softela-ai\\overrides.json" -Value \'{}\'',
      }),
      "deny",
    );
  });

  test("a cp onto approvals.json under the state directory is denied even with no redirect syntax", () => {
    const target = path.join(stateDir("claude"), "approvals.json");
    eq(decide(rule, { toolName: "Bash", command: `cp /tmp/fake.json "${target}"` }), "deny");
  });

  test("a python -c write to overrides.json under the state directory is denied", () => {
    const target = path.join(stateDir("codex"), "overrides.json").replace(/\\/g, "/");
    eq(
      decide(rule, {
        toolName: "Bash",
        command: `python3 -c "open('${target}','w').write('{}')"`,
      }),
      "deny",
    );
  });

  /* --------------------------------------- self-approval: read-only carve-out */

  test("softela-ai approve --list passes", () => {
    eq(decide(rule, { toolName: "Bash", command: "softela-ai approve --list" }), "pass");
  });

  test("softela-ai approve --list --json passes", () => {
    eq(decide(rule, { toolName: "Bash", command: "softela-ai approve --list --json" }), "pass");
  });

  test("softela-ai approve --agent codex --list passes", () => {
    eq(decide(rule, { toolName: "Bash", command: "softela-ai approve --agent codex --list" }), "pass");
  });

  test("softela-ai approve --agent=codex --list passes", () => {
    eq(decide(rule, { toolName: "Bash", command: "softela-ai approve --agent=codex --list" }), "pass");
  });

  test("softela-ai approve --help passes", () => {
    eq(decide(rule, { toolName: "Bash", command: "softela-ai approve --help" }), "pass");
  });

  test("softela-ai approve -h passes", () => {
    eq(decide(rule, { toolName: "Bash", command: "softela-ai approve -h" }), "pass");
  });

  test("softela-ai approve with a rule id still denies despite the read-only carve-out", () => {
    eq(decide(rule, { toolName: "Bash", command: "softela-ai approve no-push-to-base" }), "deny");
  });

  test("softela-ai approve --minutes 30 still denies", () => {
    eq(decide(rule, { toolName: "Bash", command: "softela-ai approve --minutes 30" }), "deny");
  });

  test("softela-ai approve --list --minutes 30 still denies, since not every argument is read-only", () => {
    eq(decide(rule, { toolName: "Bash", command: "softela-ai approve --list --minutes 30" }), "deny");
  });

  test("a bare softela-ai approve with no arguments still denies, since that is the usage-error path, not a read", () => {
    eq(decide(rule, { toolName: "Bash", command: "softela-ai approve" }), "deny");
  });

  test("softela-ai approve --status still denies, since it is not a real flag", () => {
    eq(decide(rule, { toolName: "Bash", command: "softela-ai approve --status" }), "deny");
  });

  test("softela-ai approve --list with an output redirect of its own still denies", () => {
    eq(decide(rule, { toolName: "Bash", command: "softela-ai approve --list > approvals.txt" }), "deny");
  });

  test("cd somewhere && softela-ai approve --list passes", () => {
    eq(decide(rule, { toolName: "Bash", command: "cd somewhere && softela-ai approve --list" }), "pass");
  });

  test("cd somewhere && softela-ai approve no-push-to-base still denies", () => {
    eq(decide(rule, { toolName: "Bash", command: "cd somewhere && softela-ai approve no-push-to-base" }), "deny");
  });

  test("evasion: a backslash-split invocation of a granting approve is still denied despite the read-only carve-out", () => {
    eq(decide(rule, { toolName: "Bash", command: "softela-ai appro\\ve no-push-to-base" }), "deny");
  });

  test("evasion: a backslash-split invocation of a read-only approve still passes", () => {
    eq(decide(rule, { toolName: "Bash", command: "softela-ai appro\\ve --list" }), "pass");
  });

  /* -------------------------------------------------------------- negative */

  test("an ordinary write inside the product repository passes", () => {
    eq(decide(rule, { toolName: "Write", filePath: "/repo/src/App.tsx", content: "x" }), "pass");
  });

  test("an ordinary edit to an unrelated config file passes", () => {
    eq(decide(rule, { toolName: "Edit", filePath: "/repo/package.json", content: "{}" }), "pass");
  });

  test("reading approvals.json, without writing, passes", () => {
    const target = path.join(stateDir("claude"), "approvals.json");
    eq(decide(rule, { toolName: "Bash", command: `cat "${target}"` }), "pass");
  });

  test("removing an unrelated directory passes", () => {
    eq(decide(rule, { toolName: "Bash", command: "rm -rf ./dist" }), "pass");
  });

  test("an ordinary chmod on a project file passes", () => {
    eq(decide(rule, { toolName: "Bash", command: "chmod +x ./scripts/build.sh" }), "pass");
  });

  test("removing a disposable test fixture that merely shares the .softela-ai directory name passes", () => {
    eq(decide(rule, { toolName: "Bash", command: "rm -rf /tmp/softela-ai-test-87421/.softela-ai" }), "pass");
  });

  test("a chmod on a disposable test fixture that merely shares the .softela-ai directory name passes", () => {
    eq(decide(rule, { toolName: "Bash", command: "chmod -R 700 ./tmp-fixtures/.softela-ai" }), "pass");
  });

  test("an ordinary git push passes — this rule is not the one that governs it", () => {
    eq(decide(rule, { toolName: "Bash", command: "git push origin feature/task_1_x" }), "pass");
  });

  test("a commit message that merely mentions 'approve' in prose passes", () => {
    eq(
      decide(rule, {
        toolName: "Bash",
        command: 'git commit -m "reviewer will approve this after the demo"',
      }),
      "pass",
    );
  });

  test("running the project's own test suite passes", () => {
    eq(decide(rule, { toolName: "Bash", command: "npx vitest run" }), "pass");
  });

  test("a Read tool call is not a write and is left alone", () => {
    const target = path.join(installedRoot("claude"), "hooks", "some-hook.js");
    eq(decide(rule, { toolName: "Read", filePath: target }), "pass");
  });

  test("a bare cd is not a shell violation", () => {
    eq(decide(rule, { toolName: "Bash", command: "cd ~/repos/Softela.AiInfrastructure" }), "pass");
  });

  test("the rule behaves the same under a minimal project, since protection is not project-scoped", () => {
    eq(
      decide(rule, {
        toolName: "Bash",
        command: "softela-ai approve subagent-model",
        project: PROJECT_MINIMAL,
      }),
      "deny",
    );
  });

  /* --------------------------------------------------------------- evasion */

  test("evasion: softela-ai approve run through node still counts", () => {
    eq(decide(rule, { toolName: "Bash", command: "node bin/softela-ai approve subagent-model" }), "deny");
  });

  test("evasion: softela-ai approve preceded by a compound statement still counts", () => {
    eq(decide(rule, { toolName: "Bash", command: "cd ~/repo && softela-ai approve subagent-model" }), "deny");
  });

  test("evasion: a different-cased invocation of the approval command still counts", () => {
    eq(decide(rule, { toolName: "Bash", command: "Softela-AI APPROVE subagent-model" }), "deny");
  });

  test("evasion: a different tool name for the same file write is still caught", () => {
    const target = path.join(stateDir("claude"), "approvals.json");
    eq(decide(rule, { toolName: "MultiEdit", filePath: target, content: "{}" }), "deny");
  });

  test("evasion: a different shell (PowerShell) invoking the approval CLI still counts", () => {
    eq(decide(rule, { toolName: "PowerShell", command: "softela-ai approve reasoning-effort-floor" }), "deny");
  });

  test("evasion: softela-ai approve hidden inside a bash -c nested shell still counts", () => {
    eq(decide(rule, { toolName: "Bash", command: 'bash -c "softela-ai approve subagent-model"' }), "deny");
  });

  test("evasion: a state-directory removal hidden inside a PowerShell -Command nested shell still counts", () => {
    // The outer wrapper's own argument is single-quoted deliberately: this
    // asserts unwrapping, not PowerShell's own double-quote escaping rules.
    eq(
      decide(rule, {
        toolName: "PowerShell",
        command: "powershell -Command 'Remove-Item -Recurse -Force \"$env:USERPROFILE\\.claude\\.softela-ai\"'",
      }),
      "deny",
    );
  });

  test("a nested shell running an unrelated command is left alone", () => {
    eq(decide(rule, { toolName: "Bash", command: 'bash -c "npm test"' }), "pass");
  });

  test("evasion: an empty-quote-split invocation of approve still counts", () => {
    eq(decide(rule, { toolName: "Bash", command: "softela-ai a''pprove subagent-model" }), "deny");
  });

  test("evasion: a backslash-split invocation of approve still counts", () => {
    eq(decide(rule, { toolName: "Bash", command: "softela-ai appro\\ve subagent-model" }), "deny");
  });

  test("a PowerShell path is not corrupted by POSIX-style backslash canonicalisation", () => {
    // PowerShell's backslash is a plain path separator, never an escape
    // character, so this must still resolve to the real state directory and
    // deny — not have its path characters eaten by canonicalisation.
    eq(
      decide(rule, {
        toolName: "PowerShell",
        command: 'Remove-Item -Recurse -Force "$env:USERPROFILE\\.claude\\.softela-ai"',
      }),
      "deny",
    );
  });

  /* ------------------------------------ raw-text conservative backstop */

  test("evasion: a parameter-expansion default hides the state directory name from the adjacent marker, still caught as ask", () => {
    // STATE_DIR_MARKER requires ".softela-ai" immediately after the host home
    // separator; the "${zzzvar:-...}" default value sits between them and
    // defeats that adjacency. The raw-text backstop still sees both words.
    eq(decide(rule, { toolName: "Bash", command: "rm -rf ~/.claude/${zzzvar:-.softela-ai}" }), "ask");
  });

  test("evasion: a parameter-expansion default hides the approve verb from the adjacent invocation pattern, still caught as ask", () => {
    eq(decide(rule, { toolName: "Bash", command: "softela-ai ${zzzvar:-approve} subagent-model" }), "ask");
  });

  test("evasion: a brace-expansion alternative spelling out 'approve' still caught as ask", () => {
    eq(decide(rule, { toolName: "Bash", command: "softela-ai {approve,list} subagent-model" }), "ask");
  });

  test("evasion: an alias defined in one statement and invoked in another splits the tool name from the verb across statements, still caught as ask", () => {
    // Each statement, evaluated on its own, is innocent: the statement that
    // names softela-ai never contains "approve", and the statement that
    // contains "approve" never names softela-ai. Only reading the whole raw
    // text together catches this.
    eq(
      decide(rule, {
        toolName: "Bash",
        command: "shopt -s expand_aliases; alias mrun=softela-ai; mrun approve subagent-model",
      }),
      "ask",
    );
  });

  test("a precise deny still wins over the conservative backstop, not merely an ask", () => {
    // A direct, unobfuscated invocation must stay at the stronger, precise
    // deny — the coarse backstop only fires when the precise checks find
    // nothing.
    eq(decide(rule, { toolName: "Bash", command: "softela-ai approve subagent-model" }), "deny");
  });

  /* ---------------------- raw-text conservative backstop: false positives */

  test("false positive, accepted: a commit message mentioning both the tool name and 'approve' asks rather than passing", () => {
    // The whole-text scan cannot distinguish this from a real evasion
    // without re-introducing statement-scoped parsing, which is exactly
    // what the evasions above defeat. The cost is one prompt.
    eq(
      decide(rule, {
        toolName: "Bash",
        command: 'git commit -m "add softela-ai approve integration test"',
      }),
      "ask",
    );
  });

  test("false positive, accepted: a grep pattern containing both the tool name and 'approve' asks rather than passing", () => {
    eq(decide(rule, { toolName: "Bash", command: 'grep -rn "softela-ai approve" src/' }), "ask");
  });

  test("not a false positive: a grep pattern containing only the tool name, without 'approve' or a destructive verb, passes", () => {
    eq(decide(rule, { toolName: "Bash", command: 'find . -name "*softela-ai*"' }), "pass");
  });

  test("not a false positive: an editor opening a non-approval file under the state directory, with no destructive verb, passes", () => {
    // approvals.json/overrides.json specifically are already covered by the
    // precise, pre-existing check above (any non-read-only verb touching
    // either denies); this exercises an ordinary file under the same
    // directory, which only the raw-text backstop could possibly catch, and
    // should not.
    eq(decide(rule, { toolName: "Bash", command: "code ~/.claude/.softela-ai/manifest.json" }), "pass");
  });

  test("not a false positive: reading rather than removing a file under the state directory through the same obfuscated spelling still passes", () => {
    eq(decide(rule, { toolName: "Bash", command: "cat ~/.claude/${zzzvar:-.softela-ai}/approvals.json" }), "pass");
  });

  test("not a false positive: the tool name as a substring of a longer, unrelated word passes", () => {
    // "ssoftela-ai-cache" has no word boundary before "softela-ai", so it never
    // reads as the tool's own name.
    eq(decide(rule, { toolName: "Bash", command: "rm -rf ./ssoftela-ai-cache" }), "pass");
  });

  test("not a false positive: removing a disposable fixture that shares the .softela-ai name, with no host home directory mentioned, passes", () => {
    // Repeats the existing disposable-fixture case through the raw-text
    // backstop's own lens: without ".claude" or ".codex" anywhere in the
    // text, the state-directory-plus-destructive-verb pairing never fires.
    eq(decide(rule, { toolName: "Bash", command: "rm -rf /tmp/softela-ai-test-87421/.softela-ai" }), "pass");
  });

  /* ------------------------------------------------------- closed evasions */

  test("a write to overrides.json through an unresolved parent segment is denied", () => {
    // Mixed separators deliberately: the state-dir portion uses the native
    // separator, the injected "../" uses a forward slash — exactly the mix a
    // tool call can hand in even on Windows.
    const target = `${stateDir("claude")}\\subdir/../overrides.json`;
    eq(decide(rule, { toolName: "Write", filePath: target, content: "{}" }), "deny");
  });

  test("a write to overrides.json through a nested unresolved parent segment is denied", () => {
    const target = `${stateDir("codex")}/a/b/../../overrides.json`;
    eq(decide(rule, { toolName: "Bash", command: `cp /tmp/fake.json "${target}"` }), "deny");
  });

  test("a read-only verb redirected onto overrides.json under the state directory is denied", () => {
    const target = path.join(stateDir("claude"), "overrides.json");
    eq(decide(rule, { toolName: "Bash", command: `cat > "${target}" <<EOF` }), "deny");
  });

  test("a Get-Content piped into Set-Content onto overrides.json under the state directory is denied", () => {
    const target = path.join(stateDir("codex"), "overrides.json");
    eq(
      decide(rule, {
        toolName: "PowerShell",
        command: `Get-Content "$env:USERPROFILE\\.codex\\.softela-ai\\overrides.json" | Set-Content "${target}"`,
      }),
      "deny",
    );
  });

  test("a doubled path separator in a node -e write still denies the write to overrides.json", () => {
    // The literal command text a shell-quoted script must carry: each real
    // path separator is written twice, e.g. as it appears inside a
    // single-quoted JS string literal passed to `node -e`.
    const doubled = path.join(stateDir("claude"), "overrides.json").replace(/\\/g, "\\\\");
    eq(
      decide(rule, {
        toolName: "Bash",
        command: `node -e "require('fs').writeFileSync('${doubled}','{}')"`,
      }),
      "deny",
    );
  });

  /* -------------------------------------------------------------- negative */

  test("a plain read of overrides.json through a mixed-separator path still passes", () => {
    const target = `${stateDir("claude")}\\subdir/../overrides.json`;
    eq(decide(rule, { toolName: "Bash", command: `cat "${target}"` }), "pass");
  });

  test("a read of approvals.json with its stderr discarded to /dev/null passes", () => {
    // The false positive this carve-out exists for: `2>` is a redirect
    // operator, but /dev/null is not a destination — nothing is written
    // anywhere. Silencing the error output of a read that may legitimately
    // fail is ordinary shell hygiene, and denying it teaches the agent to
    // write worse commands rather than safer ones.
    const target = path.join(stateDir("claude"), "approvals.json");
    eq(decide(rule, { toolName: "Bash", command: `cat "${target}" 2>/dev/null` }), "pass");
  });

  test("the same read passes with Windows' NUL and with PowerShell's $null", () => {
    const target = path.join(stateDir("codex"), "approvals.json");
    eq(decide(rule, { toolName: "Bash", command: `type "${target}" 2>NUL` }), "pass");
    eq(decide(rule, { toolName: "PowerShell", command: `Get-Content "${target}" 2>$null` }), "pass");
  });

  test("a discard alongside a genuine redirect onto approvals.json is still denied", () => {
    // Only the discard is stripped before the operator test, so the real
    // redirect sitting beside it is still there to be found.
    const target = path.join(stateDir("claude"), "approvals.json");
    eq(decide(rule, { toolName: "Bash", command: `cat /tmp/grant.json 2>/dev/null > "${target}"` }), "deny");
  });

  test("a read-only pipeline containing a quoted '>' character passes", () => {
    // The ">" sits inside a quoted filter expression, not as a redirect —
    // this must not be mistaken for a write.
    eq(
      decide(rule, {
        toolName: "PowerShell",
        command: 'Get-Content "$env:USERPROFILE\\.claude\\.softela-ai\\overrides.json" | Where-Object { $_ -match "value > 5" }',
      }),
      "pass",
    );
  });

  /* ------------------------------- fixture, read-only and name-only false positives */

  test("a disposable scratch home that spells .claude/.softela-ai under its own unrelated root passes", () => {
    // Exactly the shape this project's own test fixtures create through the
    // SOFTELA_AI_HOME convention (tests/installer/_home.js, tests/adapters/_spawn.js):
    // a fixture root that is not the real, currently-resolved agent home is
    // not the thing this rule protects, even though it spells out the same
    // segment names.
    eq(
      decide(rule, {
        toolName: "Bash",
        command: 'touch "/tmp/softela-ai-scratch-9213/.claude/.softela-ai/approvals.json"',
      }),
      "pass",
    );
  });

  test("a read-only node -e one-liner checking whether overrides.json exists passes", () => {
    const target = path.join(stateDir("claude"), "overrides.json").replace(/\\/g, "/");
    eq(
      decide(rule, {
        toolName: "Bash",
        command: `node -e "console.log(require('fs').existsSync('${target}'))"`,
      }),
      "pass",
    );
  });

  test("a node -e one-liner that also writes overrides.json under the state directory is still denied", () => {
    // The read-only carve-out only exempts a script with no write call at
    // all; existsSync alongside a real write must not launder the write.
    const target = path.join(stateDir("claude"), "overrides.json").replace(/\\/g, "/");
    eq(
      decide(rule, {
        toolName: "Bash",
        command: `node -e "require('fs').existsSync('${target}') || require('fs').writeFileSync('${target}','{}')"`,
      }),
      "deny",
    );
  });

  test("reading a doc file whose name merely mentions the tool and 'approve' passes", () => {
    eq(decide(rule, { toolName: "Bash", command: "cat /repo/docs/softela-ai-approve-workflow.md" }), "pass");
  });

  test("the same read-only doc read still passes when wrapped in a bare subshell", () => {
    // shell-parse's splitStatements now returns this as two entries — the
    // outer, still-wrapped statement and its clean unwrapped one — both
    // describing the exact same single read; the read-only exemption must
    // still recognise it as wholly read-only rather than treating the extra
    // entry as a second, unproven statement.
    eq(decide(rule, { toolName: "Bash", command: "(cat /repo/docs/softela-ai-approve-workflow.md)" }), "pass");
  });

  test("the same read-only doc read still passes preceded by an inert cd", () => {
    // A leading `cd repo &&` makes `isWhollyReadOnlyCommand`'s naive
    // "every statement opens with a read-only verb" check fail on the `cd`
    // statement itself; navigation is neither a read nor a write and must
    // not force the coarse ask-fallback to fire on an otherwise harmless read.
    eq(
      decide(rule, { toolName: "Bash", command: "cd repo && cat /repo/docs/softela-ai-approve-workflow.md" }),
      "pass",
    );
  });

  test("the same read-only doc read still passes as a pipeline's second stage after a no-op", () => {
    eq(decide(rule, { toolName: "Bash", command: "true | cat /repo/docs/softela-ai-approve-workflow.md" }), "pass");
  });

  test("the same read-only doc read still passes wrapped in bash -c", () => {
    // `bash -c '…'` is itself a nested-shell wrapper statement whose own
    // leading word is `bash`, not a read-only verb; the genuine read lives
    // in the separate, already-unwrapped inner statement `splitStatements`
    // also returns, and that is what must be judged.
    eq(decide(rule, { toolName: "Bash", command: "bash -c 'cat /repo/docs/softela-ai-approve-workflow.md'" }), "pass");
  });

  test("the same read-only doc read still passes through the nested cd && (…) combination", () => {
    eq(
      decide(rule, {
        toolName: "Bash",
        command: "cd repo && (cat /repo/docs/softela-ai-approve-workflow.md)",
      }),
      "pass",
    );
  });

  test("a bash -c wrapper that redirects its own output is still not waved through as inert", () => {
    // The wrapper-statement exemption only ever excuses the wrapper from
    // needing a read-only verb of its own; a genuine redirect on the OUTER
    // statement is invisible to the unwrapped inner statement, so nothing
    // else in the loop would ever catch it if this were skipped too.
    eq(
      decide(rule, {
        toolName: "Bash",
        command: "bash -c 'cat /repo/docs/softela-ai-approve-workflow.md' > /repo/out.txt",
      }),
      "ask",
    );
  });

  test("a destructive command in a subshell is still denied despite the navigation/no-op exemptions", () => {
    const target = path.join(stateDir("claude"), "junk");
    eq(decide(rule, { toolName: "Bash", command: `(rm -rf ${target})` }), "deny");
  });

  test("a destructive command after cd is still denied despite the navigation exemption", () => {
    const target = path.join(stateDir("claude"), "junk");
    eq(decide(rule, { toolName: "Bash", command: `cd x && rm -rf ${target}` }), "deny");
  });

  test("a destructive command as a pipeline's second stage is still denied despite the no-op exemption", () => {
    const target = path.join(stateDir("claude"), "junk");
    eq(decide(rule, { toolName: "Bash", command: `true | rm -rf ${target}` }), "deny");
  });

  test("a destructive command hidden inside a command substitution is still denied", () => {
    const target = path.join(stateDir("claude"), "junk");
    eq(decide(rule, { toolName: "Bash", command: `cat $(rm -rf ${target})` }), "deny");
  });

  /* ------------------------------------------------------- closed evasions: cwd, find/python, globs */

  test("rm -rf .softela-ai is denied when the working directory already sits inside the agent home", () => {
    eq(decide(rule, { toolName: "Bash", command: "rm -rf .softela-ai", cwd: agentHome("claude") }), "deny");
  });

  test("a PowerShell Remove-Item of .softela-ai is denied when the working directory already sits inside the agent home", () => {
    eq(
      decide(rule, {
        toolName: "PowerShell",
        command: "Remove-Item -Recurse -Force .softela-ai",
        cwd: agentHome("codex"),
      }),
      "deny",
    );
  });

  test("a bare .softela-ai reference is not treated as the state directory when the working directory is unrelated", () => {
    eq(decide(rule, { toolName: "Bash", command: "rm -rf .softela-ai", cwd: "/repo" }), "pass");
  });

  test("find ... -delete against the state directory is denied", () => {
    eq(decide(rule, { toolName: "Bash", command: "find ~/.claude/.softela-ai -delete" }), "deny");
  });

  test("find ... -exec unlink against the state directory is denied", () => {
    eq(decide(rule, { toolName: "Bash", command: "find ~/.claude/.softela-ai -exec unlink {} ;" }), "deny");
  });

  test("find ... -exec rm against the state directory is denied", () => {
    eq(decide(rule, { toolName: "Bash", command: 'find ~/.claude/.softela-ai -exec rm -rf {} \\;' }), "deny");
  });

  test("a plain find that only lists files under the state directory, with no -delete or -exec removal, passes", () => {
    // "manifest.json" deliberately, not "approvals.json"/"overrides.json" —
    // this exercises hasFindRemove() in isolation, not the pre-existing
    // approval-filename check that already denies any non-read-only verb
    // touching either of those two names.
    eq(decide(rule, { toolName: "Bash", command: "find ~/.claude/.softela-ai -name manifest.json" }), "pass");
  });

  test("a python3 -c shutil.rmtree against the state directory is denied", () => {
    const target = stateDir("claude").replace(/\\/g, "/");
    eq(
      decide(rule, {
        toolName: "Bash",
        command: `python3 -c "import shutil; shutil.rmtree('${target}')"`,
      }),
      "deny",
    );
  });

  test("rm -rf against a glob spelling of the state directory name is denied", () => {
    eq(decide(rule, { toolName: "Bash", command: "rm -rf ~/.claude/.softela*" }), "deny");
  });

  test("rm -rf against a dotfile-glob spelling covering the state directory is denied", () => {
    eq(decide(rule, { toolName: "Bash", command: "rm -rf ~/.claude/.*" }), "deny");
  });

  test("rm -rf against a glob that does not cover the state directory name passes", () => {
    eq(decide(rule, { toolName: "Bash", command: "rm -rf ~/.claude/.git*" }), "pass");
  });

  /* ------------------------- inline script read-only test, per language: deny */

  /**
   * An inline script counts as read-only only when its own language's list
   * finds neither a file change nor a process start. Each case below writes
   * the real overrides.json or approvals.json by a call the old single list
   * did not know. The shell sees no redirect and no write verb in any of them.
   */
  const nodeDenyBodies = (target) => [
    `require("fs").copyFileSync("/tmp/x.json","${target}")`,
    `require("fs").renameSync("/tmp/x.json","${target}")`,
    `require("fs").cpSync("/tmp/x.json","${target}")`,
    `require("fs").symlinkSync("/tmp/x.json","${target}")`,
    `require("fs").chmodSync("${target}",0o666)`,
    `const fs=require("fs");const fd=fs.openSync("${target}","w");fs.writeSync(fd,"{}")`,
    `const fs=require("fs");const fd=fs.openSync("${target}","r+");console.log(fd)`,
    `require("fs")["copyFileSync"]("/tmp/x.json","${target}")`,
    `const {copyFileSync}=require("fs");copyFileSync("/tmp/x.json","${target}")`,
    `require("child_process").execSync("cp /tmp/x.json ${target}")`,
  ];

  const pythonDenyBodies = (target) => [
    `import shutil; shutil.copy('/tmp/x.json','${target}')`,
    `import shutil; shutil.move('/tmp/x.json','${target}')`,
    `import os; os.replace('/tmp/x.json','${target}')`,
    `import os; os.system('cp /tmp/x.json ${target}')`,
    `f=open('${target}', 'r+'); print(f)`,
    `from pathlib import Path; Path('${target}').write_text('{}')`,
  ];

  for (const file of ["overrides.json", "approvals.json"]) {
    const target = path.join(stateDir("claude"), file).replace(/\\/g, "/");

    nodeDenyBodies(target).forEach((body, i) => {
      test(`a node -e script that changes ${file} by a call the old list missed is denied (node case ${i + 1})`, () => {
        eq(decide(rule, { toolName: "Bash", command: `node -e '${body}'` }), "deny");
        eq(decide(rule, { toolName: "PowerShell", command: `node -e "${body.replace(/"/g, '\\"')}"` }), "deny");
      });
    });

    pythonDenyBodies(target).forEach((body, i) => {
      test(`a python -c script that changes ${file} by a call the old list missed is denied (python case ${i + 1})`, () => {
        eq(decide(rule, { toolName: "Bash", command: `python3 -c "${body}"` }), "deny");
      });
    });
  }

  /* ------------------------ inline script read-only test, per language: pass */

  test("node -e scripts that only read the real approvals.json and overrides.json still pass", () => {
    for (const file of ["approvals.json", "overrides.json"]) {
      const target = path.join(stateDir("claude"), file).replace(/\\/g, "/");
      const reads = [
        `console.log(JSON.parse(require('fs').readFileSync('${target}','utf8')))`,
        `console.log(require('fs').existsSync('${target}'))`,
        `console.log(String(require('fs').statSync('${target}').size))`,
      ];

      for (const body of reads) eq(decide(rule, { toolName: "Bash", command: `node -e "${body}"` }), "pass");
    }
  });

  test("python -c scripts that only read the real approvals.json and overrides.json still pass", () => {
    const dir = stateDir("claude").replace(/\\/g, "/");
    const reads = [
      `import json; print(json.load(open('${dir}/approvals.json')))`,
      `print(open('${dir}/overrides.json', 'r').read())`,
      `import os; print(open(os.path.join('${dir}', 'approvals.json')).read())`,
      `print(open('${dir}/overrides.json').read().replace('a', 'b'))`,
      `print(open('${dir}/overrides.json', 'rb').read())`,
    ];

    for (const body of reads) eq(decide(rule, { toolName: "Bash", command: `python3 -c "${body}"` }), "pass");
  });

  /* ------------------------- raw-text backstop: the one sealed node exception */

  /**
   * The shape the backstop used to stop for no reason: a log-analysis script
   * in one single-quoted `node -e` that holds `rm`, `mkdir` and `cp` inside a
   * regular expression, beside the state directory's own path. Built from
   * `stateDir`, never from a literal home path.
   */
  const logDir = path.join(stateDir("claude"), "logs").replace(/\\/g, "/");
  const sealedBody = [
    "",
    'const fs=require("fs");',
    'const path=require("path");',
    `const d=path.join("${logDir}","");`,
    "let n=0;",
    'for(const f of fs.readdirSync(d).filter(f=>f.startsWith("guard-activity"))){',
    'for(const l of fs.readFileSync(d+f,"utf8").split("\\n")){',
    "if(!l.trim())continue;",
    "try{const o=JSON.parse(l);if(o.action===\"ask\")n++}catch(e){}",
    "}}",
    "const verbs=/\\b(sed -i|tee |Set-Content|Out-File|cp |mv |mkdir|touch|rm )/;",
    'console.log("asks",n,verbs.test("x rm y"));',
    "",
  ].join("\n");

  const sealed = (body = sealedBody, flag = "-e") => `node ${flag} '${body}'`;
  const bash = (command, extra = {}) => decide(rule, { toolName: "Bash", command, ...extra });

  test("sealed node: a single-quoted log-analysis script that merely holds rm and mkdir in a regex passes", () => {
    eq(bash(sealed()), "pass");
  });

  test("sealed node: the same shape through -p, --eval and --print passes", () => {
    for (const flag of ["-p", "--eval", "--print"]) eq(bash(sealed(sealedBody, flag)), "pass");
  });

  test("sealed node: a script that names softela-ai and approve only as data passes", () => {
    const body = 'const fs=require("fs");const t=fs.readFileSync(process.argv[1]||"/dev/null","utf8");console.log(t.split("softela-ai approve").length-1)';
    eq(bash(sealed(body)), "pass");
  });

  test("sealed node: process.argv, process.env and process.stdout.write are allowed", () => {
    const body = 'process.stdout.write(String(process.argv.length)+" "+(process.env.HOME||"")+" "+process.cwd());process.exit(0)';
    eq(bash(sealed(`${sealedBody}${body}`)), "pass");
  });

  test("sealed node: the backstop still asks for the identical script when not sealed (control)", () => {
    eq(decide(rule, { toolName: "PowerShell", command: sealed() }), "ask");
  });

  /** Everything below keeps today's action — ask — because one condition of the sealed shape fails. */
  const stillAsks = [
    ["a child_process call", `${sealedBody}require("child_process").execSync("rm -rf ~/.claude/.softela-ai")`],
    ["a split child_process name", `${sealedBody}require("child"+"_process")`],
    ["an aliased require", `${sealedBody}const r=require;`],
    ["eval", `${sealedBody}eval("1")`],
    ["Function", `${sealedBody}Function("return 1")()`],
    ["dynamic import", `${sealedBody}import("fs")`],
    ["process.binding", `${sealedBody}process.binding("fs")`],
    ["this", `${sealedBody}this.x=1`],
    ["globalThis", `${sealedBody}globalThis.y=1`],
    ["constructor", `${sealedBody}[].constructor`],
    ["arguments", `${sealedBody}arguments[0]`],
    ["a unicode-escaped eval", `${sealedBody}\\u0065val("1")`],
    ["fs.rm", `${sealedBody}fs.rm("/tmp/x",()=>{})`],
    // The statement-level removal check already denies this one, ahead of the backstop.
    ["fs.unlinkSync on an unrelated path", `${sealedBody}fs.unlinkSync("/tmp/x")`, "deny"],
    ["a bracketed rmSync", `${sealedBody}fs["rmSync"]("/tmp/x")`],
    ["util.promisify of fs.unlink", `${sealedBody}require("util").promisify(fs.unlink)`],
    ["a destructured rmSync", `${sealedBody}const {rmSync}=require("fs")`],
    ["a curly quote inside the code", `${sealedBody}console.log("it’s")`],
    ["a require of an unlisted module", `${sealedBody}require("http")`],
    ["a require with a variable name", `${sealedBody}const m="fs";require(m)`],
    ["worker_threads", `${sealedBody}require("worker_threads")`],
    ["process.chdir", `${sealedBody}process.chdir("/")`],
  ];

  for (const [label, body, expected = "ask"] of stillAsks) {
    test(`sealed node: ${label} keeps today's ${expected}`, () => {
      eq(bash(sealed(body)), expected);
    });
  }

  test("sealed node: a double-quoted script, a PowerShell tool call and a Codex shell tool all keep the ask", () => {
    const doubleQuoted = `node -e "${sealedBody.replace(/"/g, '\\"')}"`;
    eq(bash(doubleQuoted), "ask");
    eq(decide(rule, { toolName: "PowerShell", command: sealed() }), "ask");
    eq(decide(rule, { toolName: "exec_command", command: sealed() }), "ask");
    eq(decide(rule, { toolName: "shell", command: sealed() }), "ask");
  });

  test("sealed node: anything around the single quoted invocation keeps the ask", () => {
    const wrapped = [
      `${sealed()} | sh`,
      `${sealed()}; echo done`,
      `${sealed()} > out.txt`,
      `${sealed()} 2>&1`,
      `cd /tmp && ${sealed()}`,
      `FOO=1 ${sealed()}`,
      `echo $(${sealed()})`,
      `${sealed()}\necho hi`,
      `${sealed()} # note`,
      `${sealed()} --extra`,
    ];

    for (const command of wrapped) eq(bash(command), "ask");
  });

  test("sealed node: a script wrapped in eval \"$( … )\" is never passed", () => {
    // The statement-level checks unwrap eval and split the script's lines, so
    // this may deny rather than ask; either way it must not pass.
    ok(bash(`eval "$(${sealed()})"`) !== "pass");
  });

  test("sealed node: a python -c script with the same body keeps the ask", () => {
    eq(bash(`python -c '${sealedBody}'`), "ask");
  });

  test("sealed node: a script that names the approve command and also writes is still not waved through", () => {
    const body = `${sealedBody}require("fs").writeFileSync("/tmp/out.txt","softela-ai approve")`;
    eq(bash(sealed(body)), "ask");
  });

  test("sealed node: a sealed script that writes the real overrides.json is still denied, not passed", () => {
    const target = path.join(stateDir("claude"), "overrides.json").replace(/\\/g, "/");
    eq(bash(sealed(`${sealedBody}require("fs").copyFileSync("/tmp/x.json","${target}")`)), "deny");
  });

  /* ----------------------------- sealed exception: shape, disguise and extras */

  test("sealed node: a newline between node, the flag and the quoted code is never sealed", () => {
    // A newline is a command separator in a POSIX shell: the quoted word
    // would run as its own command, so none of these may pass.
    const split = [
      `node -e\n'${sealedBody}'`,
      `node\n-e '${sealedBody}'`,
      `node -p\n'${sealedBody}'`,
      `node --eval\n'${sealedBody}'`,
      `node --print\n'${sealedBody}'`,
    ];

    for (const command of split) ok(bash(command) !== "pass", command.slice(0, 20));
  });

  test("sealed node: tab separators between node, the flag and the quoted code still seal", () => {
    eq(bash(`node\t-e\t'${sealedBody}'`), "pass");
  });

  test("sealed node: a sealed script with quote escapes, += and plus-strings stays sealed", () => {
    // The shapes of the log-analysis scripts this exception exists for:
    // `\x27` and `\x5c` escapes inside regexes, `+=` and a string that opens with `+`.
    const body = [
      'let k="a";k+="+scratch/tmp";',
      'const q=/[\\x27"]/;const bs=/[\\x5c/]/;',
      'console.log(k,q.test("x"),bs.test("/"));',
    ].join("");

    eq(bash(sealed(body)), "pass");
  });

  /** One change each to the sealed body: a name built or reached without writing it out, or a mode option. */
  const sealedExtras = [
    ["a readFileSync flag of w", 'fs.readFileSync("/tmp/x",{flag:"w"})'],
    ["a readFileSync flag of a", 'fs.readFileSync("/tmp/x",{flag:"a"})'],
    ["flags on createReadStream", 'fs.createReadStream("/tmp/x",{flags:"w"})'],
    ["flags on a new ReadStream", 'new fs.ReadStream("/tmp/x",{flags:"w"})'],
    ["a flag on promises.readFile", 'fs.promises.readFile("/tmp/x",{flag:"w"})'],
    ["O_WRONLY and O_TRUNC", 'fs.readFileSync("/tmp/x",{flag:fs.constants.O_WRONLY|fs.constants.O_TRUNC})'],
    ["a FileWriteStream", 'new fs.FileWriteStream("/tmp/x")'],
    ["mkdtempDisposableSync", 'fs.mkdtempDisposableSync("/tmp/x")'],
    ["util.promisify of fs.rm", 'require("util").promisify(fs.rm)'],
    ["a hex-escaped bracket name", 'fs["\\x72mSync"]("/tmp/x")'],
    ["an octal-escaped bracket name", 'fs["\\162mSync"]("/tmp/x")'],
    ["two string literals joined with +", 'fs["rm"+"Sync"]("/tmp/x")'],
    ["a template placeholder opening with a literal", 'fs[`${"rm"}Sync`]("/tmp/x")'],
    ["String.fromCharCode", 'fs[String.fromCharCode(114,109)+"Sync"]("/tmp/x")'],
    ["the getPrototypeOf and getOwnPropertyNames chain", 'const P=Object.getPrototypeOf(()=>1);P[Object.getOwnPropertyNames(P)[0]]("return 1")()'],
    ["a .open member", 'console.log(JSON.parse("{}").open)'],
    ["a .link member", 'console.log(JSON.parse("{}").link)'],
    ["a .write member that is not called", "const w=fs.write"],
    ["node:sqlite", 'require("node:sqlite")'],
  ];

  for (const [label, extra] of sealedExtras) {
    test(`sealed node: ${label} is not sealed`, () => {
      eq(bash(sealed(`${sealedBody}${extra}`)), "ask");
    });
  }

  /* ---------------- inline script test, round two: nothing the old test denied passes */

  const stateFile = (file) => path.join(stateDir("claude"), file).replace(/\\/g, "/");
  const nodeE = (body) => `node -e '${body}'`;
  const nodeFs = (target) => `const fs=require("fs");const p="${target}";`;

  /** The forms the first rewrite let through although the old single list denied them. */
  const oldDeniedNode = (t) => [
    ["a parameter destructuring alias", nodeE(`${nodeFs(t)}(({writeFileSync:w})=>w(p,"{}"))(fs)`)],
    ["a for-of destructuring alias", nodeE(`${nodeFs(t)}for (const {writeFileSync:w} of [fs]) w(p,"{}")`)],
    ["a comment between the dot and the name", nodeE(`${nodeFs(t)}fs./**/writeFileSync.call(fs,p,"{}")`)],
    ["a name held in a variable", nodeE(`${nodeFs(t)}const k="writeFileSync";fs[k](p,"{}")`)],
    ["a name found by Object.values", nodeE(`${nodeFs(t)}Object.values(fs).find(f=>f.name==="writeFileSync")(p,"{}")`)],
    ["an ES module import alias", `node --input-type=module -e 'import {writeFileSync as w} from "fs"; w("${t}","{}")'`],
    ["a dynamic import destructuring", nodeE(`import("fs").then(({writeFileSync:w})=>w("${t}","{}"))`)],
  ];

  /** Options and names that turn a read call into a write, or load code the guard never read. */
  const newDeniedNode = (t) => [
    ["a readFileSync flag of w", nodeE(`${nodeFs(t)}fs.readFileSync(p,{flag:"w"})`)],
    ["a readFileSync flag of a", nodeE(`${nodeFs(t)}fs.readFileSync(p,{flag:"a"})`)],
    ["flags on createReadStream", nodeE(`${nodeFs(t)}fs.createReadStream(p,{flags:"w"})`)],
    ["flags on a new ReadStream", nodeE(`${nodeFs(t)}new fs.ReadStream(p,{flags:"w"})`)],
    ["a flag on promises.readFile", nodeE(`${nodeFs(t)}fs.promises.readFile(p,{flag:"w"})`)],
    ["O_WRONLY and O_TRUNC", nodeE(`${nodeFs(t)}fs.readFileSync(p,{flag:fs.constants.O_WRONLY|fs.constants.O_TRUNC})`)],
    ["a FileWriteStream", nodeE(`${nodeFs(t)}new fs.FileWriteStream(p)`)],
    ["mkdtempDisposableSync", nodeE(`${nodeFs(t)}fs.mkdtempDisposableSync(p+"x")`)],
    ["a parameter destructuring of unlinkSync", nodeE(`${nodeFs(t)}(({unlinkSync:u})=>u(p))(fs)`)],
    ["a function parameter destructuring of rmSync", nodeE(`${nodeFs(t)}function f({rmSync:r}){r(p)}f(fs)`)],
    ["util.promisify of fs.unlink", nodeE(`${nodeFs(t)}require("util").promisify(fs.unlink)(p)`)],
    ["a bare call after ||", nodeE(`${nodeFs(t)}const mkdir=fs.mkdirSync;x||mkdir(p)`)],
    ["process.binding", nodeE(`process.binding("fs").writeFileUtf8("${t}","{}",577,438)`)],
    ["a require of a file path", `${nodeE('require("/tmp/w.js")')} ${t}`],
    ["a require of a relative path", `${nodeE('require("./w")')} ${t}`],
    ["a require with a variable", `${nodeE('const n="/tmp/w.js";require(n)')} ${t}`],
    ["eval of a file", `${nodeE('eval(require("fs").readFileSync("/tmp/w.js","utf8"))')} ${t}`],
    ["a command substitution script", `node -e "$(cat /tmp/w.js)" ${t}`],
    ["the vm module", `${nodeE('require("vm").runInThisContext("1")')} ${t}`],
    ["new Function", `${nodeE('new Function("return 1")()')} ${t}`],
    ["a dynamic import of a file", `${nodeE('import("/tmp/w.mjs")')} ${t}`],
    ["node:sqlite", nodeE(`new (require("node:sqlite").DatabaseSync)("${t}")`)],
    ["-p with copyFileSync", `node -p 'require("fs").copyFileSync("/tmp/x.json","${t}")'`],
  ];

  for (const file of ["overrides.json", "approvals.json"]) {
    oldDeniedNode(stateFile(file)).forEach(([label, command]) => {
      test(`deny, as the old test did: ${label} onto ${file}`, () => {
        eq(bash(command), "deny");
      });
    });

    newDeniedNode(stateFile(file)).forEach(([label, command]) => {
      test(`deny, new: ${label} onto ${file}`, () => {
        eq(bash(command), "deny");
      });
    });
  }

  const pythonE = (body) => `python -c '${body}'`;

  /** Python writes the first rewrite missed: `open(` with a nested call, pathlib moves, loaded code, rarer writers. */
  const deniedPython = (t, dir) => [
    ["open with a raw-prefixed mode literal", pythonE(`open("${t}", r"w").close()`)],
    ["open with a nested os.path.join and mode w", pythonE(`import os\nwith open(os.path.join("${dir}","approvals.json"),"w") as f: pass`)],
    ["open of os.path.expanduser with mode w", pythonE(`import json,os; json.dump({}, open(os.path.expanduser("${t}"),"w"))`)],
    ["open of str(path) with mode w", pythonE(`import json; json.dump({}, open(str("${t}"),"w"))`)],
    ["open of a Path division with mode w", pythonE(`from pathlib import Path; open(Path("${dir}")/"overrides.json","w").close()`)],
    ["open with a mode held in a variable", pythonE(`m="w"; open("${t}",m).close()`)],
    ["open with a mode keyword", pythonE(`open("${t}", mode="a").close()`)],
    ["open split over lines with a parenthesis in a comment", pythonE(`f = open("${t}", # (note)\n  "w")`)],
    ["Path.open with the mode as its first argument", pythonE(`from pathlib import Path; Path("${t}").open("w").close()`)],
    ["an open whose parentheses never balance", pythonE(`open("${t}", "r"`)],
    ["Path().replace onto the target", pythonE(`from pathlib import Path; Path("/tmp/x.json").replace("${t}")`)],
    ["pathlib.Path().rename onto the target", pythonE(`import pathlib; pathlib.Path("/tmp/x.json").rename("${t}")`)],
    ["exec of a file", `${pythonE('exec(open("/tmp/w.py").read())')} ${t}`],
    ["importlib reaching shutil", pythonE(`import importlib; importlib.import_module("shutil").copy("/tmp/x.json","${t}")`)],
    ["from os import *", pythonE(`from os import *; rename("/tmp/x.json","${t}")`)],
    ["eval of compile", `${pythonE('eval(compile("1","x","eval"))')} ${t}`],
    ["sqlite3.connect", pythonE(`import sqlite3; sqlite3.connect("${t}")`)],
    ["fileinput in place", pythonE(`import fileinput\nfor l in fileinput.input("${t}", inplace=True): print(l)`)],
    ["zipfile", pythonE(`import zipfile; zipfile.ZipFile("${t}","w")`)],
    ["a logging FileHandler", pythonE(`import logging; logging.FileHandler("${t}")`)],
    ["a pandas to_json", pythonE(`import pandas as pd; pd.DataFrame([{"a":1}]).to_json("${t}")`)],
    ["from shutil import copy", pythonE(`from shutil import copy; copy("/tmp/x.json","${t}")`)],
  ];

  for (const file of ["overrides.json", "approvals.json"]) {
    deniedPython(stateFile(file), stateDir("claude").replace(/\\/g, "/")).forEach(([label, command]) => {
      test(`deny, python: ${label} onto ${file}`, () => {
        eq(bash(command), "deny");
      });
    });
  }

  test("deny: a comment or an assigned value that merely mentions node -e or python -c does not make a write a read", () => {
    const t = stateFile("overrides.json");
    const commands = [
      `cp /tmp/x.json ${t} # node -e 'x'`,
      `ln -sf /tmp/x.json ${t} # node -e 'x'`,
      `cp /tmp/x.json ${t} # python -c 'x'`,
      `dd if=/tmp/x.json of=${t} # node -e 'x'`,
      `install -m 600 /tmp/x.json ${t} # node -e 'x'`,
      `rsync /tmp/x.json ${t} # python -c 'x'`,
      `sed -i s/a/b/ ${t} # node -e 'x'`,
      `truncate -s 0 ${t} # node -e 'x'`,
      `X="node -e 'x'" cp /tmp/x.json ${t}`,
    ];

    for (const command of commands) eq(bash(command), "deny", command.slice(0, 30));
    eq(decide(rule, { toolName: "PowerShell", command: `Copy-Item C:/tmp/x.json ${t} # node -e 'x'` }), "deny");
  });

  test("deny: node -p, --print and -pe that remove the state directory", () => {
    const dir = stateDir("claude").replace(/\\/g, "/");

    for (const flag of ["-p", "--print", "-pe"]) {
      eq(bash(`node ${flag} 'require("fs").rmSync("${dir}",{recursive:true})'`), "deny", flag);
    }
  });

  test("deny: a removal behind a time prefix is still found by the loose recogniser", () => {
    const dir = stateDir("claude").replace(/\\/g, "/");
    eq(bash(`time node -e "require('fs').rmSync('${dir}',{recursive:true})"`), "deny");
  });

  test("pass: an interpreter after an env assignment, a path or a group still reads", () => {
    const t = stateFile("overrides.json");
    const read = `console.log(require("fs").existsSync("${t}"))`;

    eq(bash(`FOO=1 node -e '${read}'`), "pass");
    eq(bash(`/usr/bin/node -e '${read}'`), "pass");
    eq(bash(`(node -e '${read}')`), "pass");
    eq(bash(`python3 -c 'import os; print(os.path.exists("${t}"))'`), "pass");
  });

  /* ------------------ inline script test, round two: reads that must still pass */

  test("pass: a node read whose template placeholder holds a key ending in write", () => {
    const t = stateFile("overrides.json");
    const body = `const o=JSON.parse(require("fs").readFileSync("${t}","utf8"));for(const k in o){if(o[k]==="off"&&k.endsWith("write"))console.log(\`\${k}=\${o[k]}\`)}`;

    eq(bash(nodeE(body)), "pass");
  });

  test("pass: node reads that name shell verbs only as data", () => {
    const t = stateFile("overrides.json");
    const reads = [
      `console.log(/mkdir(\\s|$)/.test(fs.readFileSync(p,"utf8")))`,
      `console.log(/rm(dir)?\\b/.test(fs.readFileSync(p,"utf8")))`,
      `console.log(/x|mkdir(\\s)/.test(fs.readFileSync(p,"utf8")))`,
      `console.log("mkdir(",fs.existsSync(p))`,
    ];

    for (const read of reads) eq(bash(nodeE(`${nodeFs(t)}${read}`)), "pass", read);
  });

  test("pass: node data fields named link and open, and plain reads", () => {
    const t = stateFile("overrides.json");
    const reads = [
      `const o=JSON.parse(require("fs").readFileSync("${t}","utf8"));console.log(o.link,o.open)`,
      `console.log(JSON.parse(require("fs").readFileSync("${t}","utf8")).length)`,
      `const fs=require("node:fs"),p=require("path"),u=require("util");console.log(fs.existsSync("${t}"))`,
    ];

    for (const read of reads) eq(bash(nodeE(read)), "pass", read.slice(0, 40));
  });

  test("pass: python reads through open without a writing mode, from shutil import which, re.compile", () => {
    const t = stateFile("overrides.json");
    const dir = stateDir("claude").replace(/\\/g, "/");
    const reads = [
      `from shutil import which; print(which("git"), open("${t}").read())`,
      `print(open("${t}").read())`,
      `print(open("${t}", "r").read())`,
      `print(open("${t}", "rb").read())`,
      `print(open("${t}", encoding="utf-8").read())`,
      `import os; print(open(os.path.join("${dir}", "approvals.json")).read())`,
      `import json; print(json.load(open("${t}")))`,
      `print(open("${t}").read().replace("a","b"))`,
      `import re; print(re.compile("a").findall(open("${t}").read()))`,
    ];

    for (const read of reads) eq(bash(pythonE(read)), "pass", read.slice(0, 40));
  });

  /* ----------- round three: the deny half is strictly additive over the old test */

  const ov = stateFile("overrides.json");
  const ap = stateFile("approvals.json");
  const st = stateDir("claude").replace(/\\/g, "/");
  const pre = nodeFs(ov);
  const readCount = `console.log(Object.keys(JSON.parse(require("fs").readFileSync("${ap}","utf8"))).length)`;
  const innerRead = `console.log(require(\\"fs\\").readFileSync(\\"${ap}\\",\\"utf8\\"))`;

  /** Registers one test per `[label, command, expectedAction, toolName]` row. */
  const rowTests = (group, rows) => {
    for (const [label, command, expected, toolName = "Bash"] of rows) {
      test(`${group}: ${label} is ${expected}`, () => {
        eq(decide(rule, { toolName, command }), expected);
      });
    }
  };

  /** Recognition goes back to the old unanchored recogniser: everyday reads pass, `-p` is no read-only script. */
  rowTests("recognition", [
    ["a command substitution assigned to a variable", `x=$(node -e '${readCount}'); echo $x`, "pass"],
    ["a command substitution inside an echo", `echo "n: $(node -e '${readCount}')"`, "pass"],
    ["a backtick substitution", `x=\`node -e 'console.log(require("fs").readFileSync("${ap}","utf8").length)'\`; echo $x`, "pass"],
    ["an if condition", `if node -e '${readCount}'; then echo y; fi`, "pass"],
    ["a negation", `! node -e '${readCount}' && echo missing`, "pass"],
    ["a for loop body", `for f in a b; do node -e '${readCount}'; done`, "pass"],
    ["a time prefix", `time node -e '${readCount}'`, "pass"],
    ["a timeout prefix", `timeout 5 node -e '${readCount}'`, "pass"],
    ["a nohup prefix", `nohup node -e '${readCount}'`, "pass"],
    ["a command prefix", `command node -e '${readCount}'`, "pass"],
    ["an env prefix", `env NODE_NO_WARNINGS=1 node -e '${readCount}'`, "pass"],
    ["a bash -c wrapper", `bash -c "node -e '${innerRead}'"`, "pass"],
    ["a Codex bash -lc wrapper", `bash -lc "node -e '${innerRead}'"`, "pass", "exec_command"],
    ["a bash -c wrapper around a writer", `bash -c "node -e 'require(\\"fs\\").copyFileSync(\\"/tmp/x.json\\",\\"${ov}\\")'"`, "deny"],
    ["-p naming the approvals file", `node -p '${readCount}'`, "deny"],
    ["-pe", `node -pe '${readCount}'`, "deny"],
    ["-ep", `node -ep '${readCount}'`, "deny"],
    ["--print", `node --print '${readCount}'`, "deny"],
    ["a preload flag before -p", `node --require=/tmp/w.js -p '${readCount}'`, "deny"],
    ["NODE_OPTIONS before -p", `NODE_OPTIONS="--require /tmp/w.js" node -p '${readCount}'`, "deny"],
    ["a removal through --print", `node --print 'require("fs").rmSync("${st}",{recursive:true})'`, "deny"],
    ["a removal through -ep", `node -ep 'require("fs").rmSync("${st}",{recursive:true})'`, "deny"],
  ]);

  /** Output calls are not neutralised in the deny half: the old `.write(` net applies to the raw script again. */
  rowTests("output", [
    ["process.stdout.write in node", nodeE(`${pre}process.stdout.write(fs.readFileSync(p,"utf8"))`), "deny"],
    ["process.stderr.write in node", nodeE(`${pre}process.stderr.write(String(fs.statSync(p).size))`), "deny"],
    ["fs.writeSync to descriptor 1 (the old test never flagged it)", nodeE(`${pre}fs.writeSync(1,fs.readFileSync(p,"utf8"))`), "pass"],
    ["sys.stdout.write in python", `python3 -c 'import sys; sys.stdout.write(open("${ov}").read())'`, "deny"],
    ["sys.stdout pointed at a file", `python3 -c 'import sys; sys.stdout=open("/tmp/o.txt","w"); print(open("${ov}").read())'`, "deny"],
    ["sys.stdout assigned a stream", `python3 -c 'import sys,io; sys.stdout=io.StringIO(); print(open("${ov}").read())'`, "deny"],
  ]);

  /** A comment and an assigned value are cut before recognising; a real command substitution is kept. */
  rowTests("shell text around the script", [
    ["an assignment value with a command substitution and the words", `X="$(:) node -e 'x'" cp /tmp/x.json ${ov}`, "deny"],
    ["a trailing comment after a read", `node -e '${readCount}' # count the entries`, "pass"],
    ["a leading assignment before a read", `FOO=1 node -e '${readCount}'`, "pass"],
    ["a hash inside the script", `node -e 'console.log("a #b", require("fs").existsSync("${ap}"))'`, "pass"],
  ]);

  /** The deny half's new detections for Node, tuned so that a read is not hard-denied. */
  rowTests("node detection", [
    ["data fields named like short fs names", nodeE(`${pre}const o=JSON.parse(fs.readFileSync(p,"utf8"));console.log(o.rules.mkdir,o.x.cp,o.c.rm)`), "ask"],
    ["a member call with a space", nodeE(`${pre}fs.unlink (p,()=>{})`), "deny"],
    ["a promises member call", nodeE(`${pre}fs.promises.rm(p)`), "deny"],
    ["util.promisify of fs.unlink", nodeE(`${pre}require("util").promisify(fs.unlink)(p)`), "deny"],
    ["a long name before a regular expression end anchor", nodeE(`${pre}console.log(/^rmSync$/.test(fs.readFileSync(p,"utf8")))`), "deny"],
    ["a label that looks like a bare call", nodeE(`${pre}console.log("open (n)", "write (x)", fs.existsSync(p))`), "pass"],
    ["a comment that looks like a bare call", nodeE(`\n${pre}\n// open (unexpired)\nconsole.log(fs.existsSync(p))\n`), "pass"],
    ["a regular expression holding rm and a paren", nodeE(`${pre}console.log(/^rm(-|$)/.test(fs.readFileSync(p,"utf8")))`), "ask"],
    ["a nested destructuring", nodeE(`${pre}const {promises:{rm:r}}=fs;r(p)`), "deny"],
    ["an array-wrapped destructuring", nodeE(`${pre}const [{rm:r}]=[fs];r(p)`), "deny"],
    ["a quoted destructuring key", nodeE(`${pre}const {"rm":r}=fs;r(p)`), "deny"],
    ["a plain destructuring", nodeE(`${pre}const {rmSync}=fs;rmSync(p)`), "deny"],
    ["destructured generic data keys", nodeE(`${pre}const o=JSON.parse(fs.readFileSync(p,"utf8"));const {open,link,write}=o;console.log(open,link,write)`), "pass"],
    ["a name held in a string (open: one indirection, the old test passed it too; the backstop still asks)", nodeE(`${pre}const m="rm";fs[m](p)`), "ask"],
    ["a parenthesised string name (same)", nodeE(`${pre}fs[("rm")](p)`), "ask"],
    ["a name in an array of strings", nodeE(`${pre}["rename"].map(n=>fs[n])`), "deny"],
    ["generic names as strings", nodeE(`${pre}console.log(["open","write","link"].length,fs.existsSync(p))`), "pass"],
    ["a block comment after the dot", nodeE(`${pre}fs./**/rm(p)`), "deny"],
    ["a line comment after the dot", nodeE(`${pre}fs.//x\nunlink(p,()=>{})`), "deny"],
    ["a with scope", nodeE(`${pre}with(fs){rm(p)}`), "deny"],
    ["a flag of w", nodeE(`${pre}fs.readFileSync(p,{flag:"w"})`), "deny"],
    ["a quoted flag of a", nodeE(`${pre}fs.readFileSync(p,{"flag":"a"})`), "deny"],
    ["flags of r+", nodeE(`${pre}fs.createReadStream(p,{flags:"r+"})`), "deny"],
    ["a flag of r", nodeE(`${pre}console.log(fs.readFileSync(p,{encoding:"utf8",flag:"r"}))`), "pass"],
    ["a flag held in a variable, which the old test passed too", nodeE(`${pre}const m="r";console.log(fs.readFileSync(p,{flag:m}))`), "pass"],
    ["O_WRONLY", nodeE(`${pre}fs.readFileSync(p,{flag:fs.constants.O_WRONLY})`), "deny"],
    ["a label ending in flags", nodeE(`${pre}console.log("flags: "+fs.existsSync(p))`), "pass"],
    ["openSync with one argument", nodeE(`${pre}const fd=fs.openSync(p);console.log(fd);fs.closeSync(fd)`), "pass"],
    ["openSync with r", nodeE(`${pre}const fd=fs.openSync(p,"r");console.log(fd);fs.closeSync(fd)`), "pass"],
    ["openSync with rs", nodeE(`${pre}console.log(fs.openSync(p,"rs"))`), "pass"],
    ["openSync with O_RDONLY", nodeE(`${pre}console.log(fs.openSync(p,fs.constants.O_RDONLY))`), "pass"],
    ["openSync with w", nodeE(`${pre}fs.openSync(p,"w")`), "deny"],
    ["openSync with r+", nodeE(`${pre}fs.openSync(p,"r+")`), "deny"],
    ["openSync with a mode in a variable", nodeE(`${pre}const m="w";fs.openSync(p,m)`), "deny"],
    ["openSync with a template mode", nodeE(`${pre}fs.openSync(p,\`w\`)`), "deny"],
    ["promises.open with a", nodeE(`${pre}fs.promises.open(p,"a")`), "deny"],
    ["a destructured openSync with w", nodeE(`${pre}const {openSync}=fs;openSync(p,"w")`), "deny"],
    ["a destructured openSync with r", nodeE(`${pre}const {openSync}=fs;console.log(openSync(p,"r"))`), "pass"],
    ["a renamed openSync", nodeE(`${pre}const {openSync:o}=fs;o(p,"w")`), "deny"],
    ["an imported openSync alias", `node --input-type=module -e 'import {openSync as o} from "fs";o("${ov}","w")'`, "deny"],
    ["an openSync whose parentheses never balance", nodeE(`${pre}fs.openSync(p,"r"`), "deny"],
    ["a require of the json file itself", nodeE(`const o=require("${ov}");console.log(Object.keys(o))`), "pass"],
    ["a require of a variable", nodeE(`${pre}const n="/tmp/w.js";require(n)`), "deny"],
    ["a require of a path", nodeE(`${pre}require("/tmp/w.js")`), "deny"],
    ["a spaced require of a path", nodeE(`${pre}require ("/tmp/w.js")`), "deny"],
    ["a label that looks like a spaced require", nodeE(`${pre}console.log("require (n):", fs.existsSync(p))`), "pass"],
    ["a dynamic import of fs", `node --input-type=module -e 'const fs=await import("fs");console.log(fs.existsSync("${ov}"))'`, "pass"],
    ["a dynamic import of node:fs", `node --input-type=module -e 'const fs=await import("node:fs");console.log(fs.existsSync("${ov}"))'`, "pass"],
    ["a dynamic import of a path", `node --input-type=module -e 'await import("/tmp/w.mjs");console.log("${ov}")'`, "deny"],
    ["a dynamic import of a variable", `node --input-type=module -e 'const n="fs";await import(n);console.log("${ov}")'`, "deny"],
    ["Utf8Stream", nodeE(`${pre}new fs.Utf8Stream({dest:p})`), "deny"],
    ["v8.writeHeapSnapshot", nodeE(`${pre}require("v8").writeHeapSnapshot(p)`), "deny"],
    ["process.report.writeReport", nodeE(`${pre}process.report.writeReport(p)`), "deny"],
    ["vm as a global", nodeE(`${pre}vm.runInThisContext("1")`), "deny"],
    ["cluster as a global", nodeE(`${pre}cluster.fork()`), "deny"],
    ["inspector as a global", nodeE(`${pre}inspector.open()`), "deny"],
    ["v8 as a global", nodeE(`${pre}v8.writeHeapSnapshot(p)`), "deny"],
    ["v8 as a dotted data field", nodeE(`${pre}console.log(process.versions.v8,fs.existsSync(p))`), "pass"],
    ["vm and cluster as data fields", nodeE(`${pre}const o=JSON.parse(fs.readFileSync(p,"utf8"));console.log(o.vm,o.cluster)`), "pass"],
  ]);

  /** What the shell does to a double-quoted script, and to a word that runs on past the closing quote. */
  rowTests("shell quoting", [
    ["a dollar-paren in a single-quoted regular expression", `node -e 'const o=JSON.parse(require("fs").readFileSync("${ap}","utf8"));console.log(Object.keys(o).filter(k=>/\\$(\\d+)/.test(k)))'`, "pass"],
    ["a template placeholder in a single-quoted script", `node -e 'const o=JSON.parse(require("fs").readFileSync("${ap}","utf8"));console.log(\`\${Object.keys(o).length}\`)'`, "pass"],
    ["a command substitution in a double-quoted script", `node -e "$(cat /tmp/w.js)" ${ov}`, "deny"],
    ["a bare braced parameter in a double-quoted script", `node -e "console.log(\\"\${X}\\",require('fs').existsSync('${ov}'))"`, "pass"],
    ["a backtick in a double-quoted script", `node -e "console.log(\`cat /tmp/w.js\`,require('fs').existsSync('${ov}'))"`, "deny"],
    ["a plain variable in a double-quoted script", `node -e "console.log(require('fs').existsSync('${ov}'),'$HOME'.length)"`, "pass"],
    ["a script split across two single-quoted pieces", nodeE(`${pre}fs.copyFi''leSync("/tmp/x",p)`), "deny"],
    ["a script followed by a double-quoted piece", `node -e '${pre}fs.copyFi'"leSync"'("/tmp/x",p)'`, "deny"],
    ["a script followed by a variable", `node -e 'console.log("${ov}")'$X`, "deny"],
    ["a script followed by a word", `node -e 'console.log("${ov}")'x`, "deny"],
  ]);

  /** Python: the same tuning, and the rarer writers. */
  rowTests("python detection", [
    ["io.FileIO", `python3 -c 'import io; io.FileIO("${ov}","w")'`, "deny"],
    ["gzip.GzipFile", `python3 -c 'import gzip; gzip.GzipFile("${ov}","wb")'`, "deny"],
    ["bz2.BZ2File", `python3 -c 'import bz2; bz2.BZ2File("${ov}","w")'`, "deny"],
    ["lzma.LZMAFile", `python3 -c 'import lzma; lzma.LZMAFile("${ov}","w")'`, "deny"],
    ["io.BufferedWriter", `python3 -c 'import io; io.BufferedWriter(io.FileIO("${ov}","r+"))'`, "deny"],
    ["shelve.open", `python3 -c 'import shelve; shelve.open("${ov}")'`, "deny"],
    ["dbm.open", `python3 -c 'import dbm; dbm.open("${ov}","c")'`, "deny"],
    ["urlretrieve", `python3 -c 'import urllib.request as u; u.urlretrieve("http://x/y","${ov}")'`, "deny"],
    ["numpy savetxt", `python3 -c 'import numpy as np; np.savetxt("${ov}",[1])'`, "deny"],
    ["numpy save", `python3 -c 'import numpy as np; np.save("${ov}",[1])'`, "deny"],
    ["logging.basicConfig with filename", `python3 -c 'import logging; logging.basicConfig(level=logging.getLevelName("INFO"), filename="${ov}")'`, "deny"],
    ["logging.basicConfig without filename", `python3 -c 'import logging; logging.basicConfig(level=10); print(open("${ov}").read())'`, "pass"],
    ["make_archive", `python3 -c 'import shutil_x as s; s.make_archive("${ov}","zip")'`, "deny"],
    ["unpack_archive", `python3 -c 'import sh as s; s.unpack_archive("/tmp/a.zip","${ov}")'`, "deny"],
    ["getattr on os", `python3 -c 'import os; getattr(os,"re"+"move")("${ov}")'`, "deny"],
    ["getattr on Path", `python3 -c 'from pathlib import Path; getattr(Path("${ov}"),"unlink")()'`, "deny"],
    ["an os alias used for a read", `python3 -c 'import os as o; print(o.path.exists("${ov}"))'`, "pass"],
    ["an os alias used for replace", `python3 -c 'import os as o; o.replace("/tmp/x","${ov}")'`, "deny"],
    ["an os alias used for system", `python3 -c 'import os as o; o.system("cp /tmp/x ${ov}")'`, "deny"],
    ["an os alias handed to getattr", `python3 -c 'import os as o; getattr(o,"remove")("${ov}")'`, "deny"],
    ["a shutil alias used for copy", `python3 -c 'import shutil as sh; sh.copy("/tmp/x","${ov}")'`, "deny"],
    ["from os.path import *", `python3 -c 'from os.path import *;print(exists("${ap}"), getsize("${ap}"))'`, "pass"],
    ["from os import *", `python3 -c 'from os import *; rename("/tmp/x","${ov}")'`, "deny"],
    ["from pathlib import *", `python3 -c 'from pathlib import *; Path("/tmp/x").replace("${ov}")'`, "deny"],
    ["a bare compile name", `python3 -c 'import re; print(compile, re.compile("a").findall(open("${ov}").read()))'`, "pass"],
    ["eval and exec inside a string", `python3 -c 'print("eval(x) and exec(y)", open("${ov}").read())'`, "pass"],
    ["an exec call", `python3 -c 'exec(open("/tmp/w.py").read()); print("${ov}")'`, "deny"],
    ["an eval call", `python3 -c 'eval("1"); print("${ov}")'`, "deny"],
    ["to_json without an argument", `python3 -c 'import pandas as pd; print(pd.read_json("${ov}").to_json())'`, "pass"],
    ["to_csv with a path", `python3 -c 'import pandas as pd; pd.read_json("${ov}").to_csv("/tmp/o.csv")'`, "deny"],
    ["python inside a bash -c wrapper", `bash -c "python3 -c 'import json;print(len(json.load(open(\\"${ap}\\"))))'"`, "pass"],
  ]);

  /** The commands the old test denied, all still denied: the deny half only ever adds to it. */
  rowTests("old denies still deny", [
    ["a read stream piped into a write stream", nodeE(`fs.createReadStream("/tmp/x.json").pipe(fs.createWriteStream("${ov}"))`), "deny"],
    ["an ES import alias of appendFileSync", `node --input-type=module -e 'import {appendFileSync as a} from "fs"; a("${ap}","x")'`, "deny"],
    ["a name held in a variable", nodeE(`const m="writeFileSync";require("fs")[m]("${ov}","{}")`), "deny"],
    ["a name in an array of strings", nodeE(`["writeFileSync"].forEach(m=>fs[m]("${ov}","{}"))`), "deny"],
    ["a name built with toString", nodeE(`require("fs")["writeFileSync".toString()]("${ov}","{}")`), "deny"],
    ["a destructuring alias", nodeE(`(({writeFileSync:w})=>w("${ov}","{}"))(require("fs"))`), "deny"],
    ["a dynamic import destructuring", nodeE(`import("fs").then(({writeFileSync:w})=>w("${ov}","{}"))`), "deny"],
    ["a preload flag before -e", `node --require=/tmp/w.js -e 0 ${ov}`, "deny"],
    ["--eval= with copyFileSync", `node --eval='require("fs").copyFileSync("/tmp/x.json","${ov}")'`, "deny"],
    ["-p with copyFileSync", `node -p 'require("fs").copyFileSync("/tmp/x.json","${ov}")'`, "deny"],
    ["a plain writeFileSync", nodeE(`require("fs").writeFileSync("${ov}","{}")`), "deny"],
    ["promises.open with w", nodeE(`require("fs").promises.open("${ov}","w").then(h=>h.close())`), "deny"],
    ["a with scope", nodeE(`with(require("fs")){writeFileSync("${ov}","{}")}`), "deny"],
    ["io.open with w", `python -c 'import io,json; json.dump({}, io.open("${ov}","w"))'`, "deny"],
    ["codecs.open with w", `python -c 'import codecs; codecs.open("${ov}","w","utf8").close()'`, "deny"],
    ["open with a raw string mode", `python -c 'open("${ov}", r"w").close()'`, "deny"],
    ["open with keyword arguments", `python -c 'open(file="${ov}", mode="w").close()'`, "deny"],
    ["process.stdout.write on a read of approvals", nodeE(`process.stdout.write(require("fs").readFileSync("${ap}","utf8"))`), "deny"],
    ["-p on a read of approvals", `node -p 'JSON.parse(require("fs").readFileSync("${ap}","utf8")).length'`, "deny"],
    ["sys.stdout.write on a read of approvals", `python -c 'import json,sys; sys.stdout.write(json.dumps(json.load(open("${ap}"))))'`, "deny"],
    ["cp onto overrides", `cp /tmp/x.json ${ov}`, "deny"],
    ["sed -i on overrides", `sed -i s/a/b/ ${ov}`, "deny"],
    ["truncate on overrides", `truncate -s 0 ${ov}`, "deny"],
    ["a destructuring alias piped on", `${nodeE(`${pre}(({writeFileSync:w})=>w(p,"{}"))(fs)`)} | cat`, "deny"],
    ["-p with a read of the json file", `node -p 'require("${ap}")'`, "deny"],
    ["python -X utf8 -c reading approvals", `python3 -X utf8 -c 'import json;print(json.load(open("${ap}")))'`, "deny"],
    ["a quoted absolute node path with -e", `"/c/Program Files/nodejs/node.exe" -e '${readCount}'`, "deny"],
    ["-p in a command substitution", `n=$(node -p 'Object.keys(JSON.parse(require("fs").readFileSync("${ap}","utf8"))).length') && echo $n`, "deny"],
    ["-p inside a bash -c with a redirect", `bash -c "node -p 'Object.keys(JSON.parse(require(String.fromCharCode(102,115)).readFileSync(0)))'" < ${ap}`, "deny"],
    ["a flag shorthand with -p", `node -p 'const flag="w";fs.readFileSync("${ov}",{flag})'`, "deny"],
    ["a removal of the state directory", nodeE(`require("fs").rmSync("${st}",{recursive:true})`), "deny"],
    ["a pipe into tee", `node -e 'console.log(1)' | tee ${ov}`, "deny"],
    ["a redirect after -p", `node -p '1' &>>${ov}`, "deny"],
    ["a command chained after -p", `node -p '1' && cp /tmp/x ${ov}`, "deny"],
    ["a command substitution as an argument", `node -e 'x' $(cp /tmp/x ${ov})`, "deny"],
    ["a script that prints a cp for sh to run", `node -p '"cp /tmp/x ${ov}"' | sh`, "deny"],
    ["softela-ai approve", "softela-ai approve subagent-model", "deny"],
    ["softela-ai approve through bash -c", `bash -c "softela-ai approve subagent-model"`, "deny"],
    ["softela-ai approve with a split word", "softela-ai a''pprove subagent-model", "deny"],
  ]);

  /* ------------------------- round three: the sealed exception stays stricter */

  const sealedExtraRows = [
    ["vm as a global", 'vm.runInThisContext("1")', "ask"],
    ["cluster as a global", "cluster.fork()", "ask"],
    ["v8 as a global", 'v8.writeHeapSnapshot("/tmp/h")', "ask"],
    ["zlib as a global", "console.log(typeof zlib)", "ask"],
    ["url as a global", "console.log(typeof url)", "ask"],
    ["events as a global", "console.log(typeof events)", "ask"],
    ["a dotted .test call", 'console.log(/x/.test("x"))', "pass"],
    ["a dotted .events field", 'console.log(JSON.parse("{}").events)', "pass"],
    ["a data field named mkdir", "const o={};console.log(o.rules,o.x.mkdir)", "ask"],
    ["a data field named cp", "const o={};console.log(o.x.cp)", "ask"],
    ["util.promisify of fs.rm", 'require("util").promisify(fs.rm)', "ask"],
    ["a bare call of rm", "console.log(rm(1))", "ask"],
    ["a destructuring of generic keys", 'const {open,link}=JSON.parse("{}")', "ask"],
    ["a string that is exactly open", 'console.log("open")', "ask"],
    ["a string that is exactly rm", 'console.log(["rm"])', "ask"],
    ["a flag shorthand", 'const flag="r";console.log({flag})', "ask"],
    ["a flag assignment", 'const o={};o.flag="w"', "ask"],
    ["a computed flag key", 'const o={["flag"]:1}', "ask"],
    ["the word flags in a string", 'console.log("flags")', "ask"],
    ["new of an unlisted class", "new Foo()", "ask"],
    ["new Worker", 'new Worker("x")', "ask"],
    [
      "new of the harmless built-ins",
      'console.log(new Map(),new Set(),new Date(0),new RegExp("a"),new Array(2),new Object(),new Error("x"),new URL("file:///a"),new Intl.NumberFormat())',
      "pass",
    ],
    ["a call on a computed member", 'const t={a:console.log};t["a"](1)', "ask"],
    ["a call on a call result", "(()=>console.log)()(1)", "ask"],
    ["a tagged template", "console.log(String.raw`a`)", "ask"],
    ["a tagged template through a variable", "const f=console.log;f(1)\nf`a`", "ask"],
    ["an ordinary template with a closing paren", "console.log(`n=${n} (${(n)})`)", "pass"],
    ["process.stdout.write and process.stderr.write", 'process.stdout.write("x\\n");process.stderr.write("y\\n")', "pass"],
    ["a dollar-paren inside a single-quoted regular expression", 'console.log(/\\$(\\d+)/.test("$1"))', "pass"],
  ];

  for (const [label, extra, expected] of sealedExtraRows) {
    test(`sealed node, round three: ${label} is ${expected}`, () => {
      eq(bash(sealed(`${sealedBody}${extra}`)), expected);
    });
  }

  test("sealed node, round three: process.stdout.write is neutralised only by the exception, not by the deny half", () => {
    eq(bash(nodeE(`${pre}process.stdout.write("x")`)), "deny");
  });

  test("sealed node, round three: a sanitised copy of the logged analysis scripts stays sealed", () => {
    const first = String.raw`
const fs=require("fs");
const d="${logDir}/";
let ask=[];for(const f of fs.readdirSync(d).filter(f=>f.startsWith("guard-activity"))){for(const l of fs.readFileSync(d+f,"utf8").split("\n")){if(!l.trim())continue;try{const o=JSON.parse(l);if(o.event==="PreToolUse"&&o.action==="ask"&&o.agentType==="workflow-subagent")ask.push(o)}catch(e){}}}
function sample(rule,tool,n){const a=ask.filter(e=>e.ruleId===rule&&(!tool||e.tool===tool));const step=Math.max(1,Math.floor(a.length/n));console.log("\n##",rule,tool||"",a.length);for(let i=0;i<a.length&&i<step*n;i+=step){const e=a[i];console.log("-",e.tool,"|",(e.filePath||"").slice(-90),"|",(e.command||"").replace(/\s+/g," ").slice(0,260))}}
sample("shell-file-write","Bash",12);sample("doc-comment-style",null,8);sample("reuse-before-new",null,8);
const s=ask.filter(e=>e.ruleId==="shell-file-write");const c={};
for(const e of s){const cmd=e.command||"";let k="other";
if(/<<\s*[\x27"]?\w+/.test(cmd))k="heredoc";
if(/(scratchpad|[/]tmp[/]|[\x5c/]Temp[\x5c/]|[$]TEMP|env:TEMP)/i.test(cmd))k+="+scratch/tmp";
if(/\b(sed -i|tee |Set-Content|Out-File|Add-Content|cp |mv |mkdir|touch|rm )/.test(cmd))k+="+writecmd";
c[k]=(c[k]||0)+1}
console.log("\nclassify",JSON.stringify(c,null,1));
`;

    eq(bash(sealed(first)), "pass");
  });

  /* ------------- round four: the sealed exception, fs only as fs.<member> */

  /** Each row is one extra statement after the sealed log-analysis body; the sealed body itself binds `fs` once. */
  const sealedRoundFourRows = [
    ["a destructuring with an alias and a nested promises", 'const {unlink:del,promises:{readFile}}=fs;del("/tmp/x",()=>{})', "ask"],
    ["a destructuring with a default object sibling", 'const {rm:r,o={}}=fs;r("/tmp/x",{recursive:true},()=>{})', "ask"],
    ["a destructuring with a brace in a string key", 'const {"}":q,unlink:del}=fs;del("/tmp/x",()=>{})', "ask"],
    ["a destructuring with a comment before the equals sign", 'const {rm:r}/**/=fs;r("/tmp/x",{recursive:true},()=>{})', "ask"],
    ["fs handed to another name", 'const g=fs;console.log(g.existsSync("/tmp/x"))', "ask"],
    ["a spread of fs", 'const m={...fs};console.log(m.existsSync("/tmp/x"))', "ask"],
    ["Object.keys of fs", 'console.log(Object.keys(fs).length)', "ask"],
    ["Object.values of fs", 'console.log(Object.values(fs).length)', "ask"],
    ["Object.entries of fs", 'console.log(Object.entries(fs).length)', "ask"],
    ["a for-in over fs", 'for(const k in fs){console.log(k)}', "ask"],
    ["a with scope over fs", 'with(fs){console.log(1)}', "ask"],
    ["fs in an array", 'console.log([fs].length)', "ask"],
    ["fs handed to Map", 'console.log(new Map(fs).size)', "ask"],
    ["fs.promises as a value", "const q=fs.promises;console.log(typeof q)", "ask"],
    ["fs.promises.readFile through a member", 'fs.promises.readFile("/tmp/x").then(()=>console.log(1))', "pass"],
    ["a second require of fs bound to another name", 'const f2=require("fs");console.log(f2.existsSync("/tmp/x"))', "ask"],
    ["a node:fs require bound to another name", 'const f3=require("node:fs");console.log(f3.existsSync("/tmp/x"))', "ask"],
    ["a destructured require of fs", 'const {readFileSync}=require("fs");console.log(readFileSync("/tmp/x").length)', "ask"],
    ["a require of fs used through a member", 'console.log(require("fs").readFileSync("/tmp/x","utf8").length)', "pass"],
    ["fs used through optional chaining", 'console.log(fs?.readFileSync("/tmp/x","utf8").length)', "pass"],
    ["a data field named fs", "const o={};console.log(o.fs)", "pass"],
    ["the word fs in a label", 'console.log("fs: ok")', "ask"],
    ["an HTML-like open comment after a member dot", 'const f=fs.<!--x\nrm;f("/tmp/x",()=>{})', "ask"],
    ["an HTML-like close comment at the start of a line", 'const f=fs.\n-->x\nrename;f("/tmp/x","/tmp/y",()=>{})', "ask"],
    ["an HTML-like open comment alone", "console.log(1)<!--x", "ask"],
    ["a decrement followed by a greater-than in the middle of a line", "let i=3;while(i-->0){}", "pass"],
    ["a spread of vm", 'const m={...vm};m.runInThisContext("1")', "ask"],
    ["a spread of cluster", "const m={...cluster};m.fork()", "ask"],
    ["a spread of repl", "const m={...repl};console.log(typeof m)", "ask"],
    ["a comment between new and the class", "const c=new /**/ console.Console(process.stdout)", "ask"],
    ["a comment between new and the class, no space", "const c=new/**/ Foo()", "ask"],
    ["a comment between a call and its second argument list", "(()=>console.log)()/**/(1)", "ask"],
    ["a comment between a name and a template", "const t=console.log;t/**/`x`", "ask"],
    ["a comment between a computed member and its call", 'const t={a:console.log};t["a"]/**/(1)', "ask"],
    ["setPriority", 'require("os").setPriority(0,19)', "ask"],
    ["WebAssembly", "console.log(typeof WebAssembly)", "ask"],
    ["fetch", 'fetch("//127.0.0.1:9/").catch(()=>0)', "ask"],
    ["WebSocket", 'console.log(typeof WebSocket)', "ask"],
    ["EventSource", "console.log(typeof EventSource)", "ask"],
    ["localStorage", "console.log(typeof localStorage)", "ask"],
  ];

  for (const [label, extra, expected] of sealedRoundFourRows) {
    test(`sealed node, round four: ${label} is ${expected}`, () => {
      eq(bash(sealed(`${sealedBody}${extra}`)), expected);
    });
  }

  /* ---- round four: the deny half stops hard-denying reads (new detections only) */

  /** A Node script that reads the approvals file through the standard descriptors and common idioms. */
  const readOf = `JSON.parse(require("fs").readFileSync("${ap}","utf8"))`;
  const pyRead = `json.load(open("${ap}"))`;

  rowTests("round four, double quotes", [
    ["a bare braced parameter in a python script", `python3 -c "import json;d=json.load(open('${ap}'));print('\${n}'.replace('n',str(len(d))))"`, "pass"],
    ["a braced parameter with a default", `node -e "console.log(\\"\${X:-y}\\",require('fs').existsSync('${ov}'))"`, "deny"],
    ["an indirect braced parameter", `node -e "console.log(\\"\${!X}\\",require('fs').existsSync('${ov}'))"`, "deny"],
    ["a command substitution", `node -e "console.log(\\"$(id)\\",require('fs').existsSync('${ov}'))"`, "deny"],
    ["an escaped dollar before a paren", `node -e "const o=${readOf.replace(/"/g, '\\"')};console.log(Object.keys(o).filter(k=>/^a\\$(b)/.test(k)))"`, "pass"],
    ["an escaped backslash before a dollar paren", `node -e "const o=${readOf.replace(/"/g, '\\"')};console.log(Object.keys(o).filter(k=>/^a\\\\$(b)/.test(k)))"`, "deny"],
    ["an escaped backtick", `node -e "const o=${readOf.replace(/"/g, '\\"')};console.log(\\\`n=\\\${Object.keys(o).length}\\\`)"`, "pass"],
    ["an unescaped backtick", `node -e "console.log(\`id\`,require('fs').existsSync('${ov}'))"`, "deny"],
    ["a backtick in a PowerShell script", 'node -e "console.log(\'a`b\',require(\'fs\').existsSync(\'' + ov + '\'))"', "pass", "PowerShell"],
    ["the same backtick in a Bash script", 'node -e "console.log(\'a`b\',require(\'fs\').existsSync(\'' + ov + '\'))"', "deny"],
    ["a subexpression in a PowerShell script", `node -e "console.log($(1),require('fs').existsSync('${ov}'))"`, "deny", "PowerShell"],
  ]);

  rowTests("round four, apostrophe splice", [
    ["an apostrophe in a node string", `node -e 'console.log("it'"'"'s",Object.keys(${readOf}).length)'`, "pass"],
    ["an apostrophe in a python comment", `python -c 'import json\n# don'"'"'t crash\nprint(len(${pyRead}))'`, "pass"],
    ["an apostrophe in a python3 string", `python3 -c 'import json;print("it'"'"'s",len(${pyRead}))'`, "pass"],
    ["a writer after the splice", `node -e 'require("fs").copyFileSync("/tmp/x","${ov}");console.log("it'"'"'s")'`, "deny"],
    ["another adjacent piece after the splice", `node -e 'console.log("${ov}")'"'"'x'"y"`, "deny"],
    ["a splice whose second piece never closes", `node -e 'console.log("${ov}")'"'"'x`, "deny"],
  ]);

  rowTests("round four, dynamic import", [
    ["node:crypto and fs", `node --input-type=module -e 'const h=await import("node:crypto");const f=await import("fs");console.log(h.createHash("sha256").update(f.readFileSync("${ap}")).digest("hex"))'`, "pass"],
    ["node:url", `node --input-type=module -e 'const {pathToFileURL}=await import("node:url");console.log(pathToFileURL("${ap}").href)'`, "pass"],
    ["node:readline/promises with a sub-path", `node --input-type=module -e 'const rl=await import("node:readline/promises");console.log(typeof rl,"${ap}".length)'`, "pass"],
    ["events and node:assert and node:process", `node --input-type=module -e 'const e=await import("events");const a=await import("node:assert");const p=await import("node:process");console.log(typeof e,typeof a,p.cwd(),"${ap}".length)'`, "pass"],
    ["node:vm", `node --input-type=module -e 'const v=await import("node:vm");console.log("${ap}",typeof v)'`, "deny"],
    ["inspector with a sub-path", `node --input-type=module -e 'const v=await import("node:inspector/promises");console.log("${ap}",typeof v)'`, "deny"],
    ["worker_threads", `node --input-type=module -e 'const v=await import("node:worker_threads");console.log("${ap}",typeof v)'`, "deny"],
    ["child_process", `node --input-type=module -e 'const v=await import("child_process");console.log("${ap}",typeof v)'`, "deny"],
    ["a path", `node --input-type=module -e 'await import("/tmp/w.mjs");console.log("${ap}")'`, "deny"],
  ]);

  rowTests("round four, code-running globals", [
    ["a loop variable named vm", nodeE(`const o=${readOf};for(const [k,vm] of Object.entries(o))console.log(k,vm)`), "pass"],
    ["strings named cluster, repl and v8", nodeE(`const o=${readOf};console.log(Object.keys(o).filter(k=>k==="cluster"||k==="repl"||k==="v8"))`), "pass"],
    ["a label v8 beside process.versions.v8", nodeE(`console.log("v8",process.versions.v8);console.log(require("fs").readFileSync("${ap}","utf8").length)`), "pass"],
    ["the word inspector in a string", nodeE(`const o=${readOf};console.log(JSON.stringify(o).includes("inspector"))`), "pass"],
    ["the word repl in a label", nodeE(`const o=${readOf};console.log("repl: "+Object.keys(o).length)`), "pass"],
    ["the word vm in an in test", nodeE(`const o=${readOf};console.log(JSON.stringify(o).length,"vm" in o)`), "pass"],
    ["a spread of vm", nodeE(`${pre}const m={...vm};m.runInThisContext("1")`), "deny"],
    ["an optional call on vm", nodeE(`${pre}vm?.runInThisContext("1")`), "deny"],
    ["a subscript on cluster", nodeE(`${pre}cluster["fork"]()`), "deny"],
  ]);

  test("round four: a home folder named with vm does not stop an inline read of approvals.json", () => {
    const before = process.env.SOFTELA_AI_HOME;
    process.env.SOFTELA_AI_HOME = "/home/dev-vm";
    try {
      const target = path.join(stateDir("claude"), "approvals.json").replace(/\\/g, "/");
      const read = `node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync("${target}","utf8"))).length)'`;

      ok(target.includes("dev-vm"), "the state directory sits under the vm-named home");
      eq(bash(read), "pass");
      eq(bash(`node -e 'require("fs").copyFileSync("/tmp/x","${target}")'`), "deny");
    } finally {
      if (before === undefined) delete process.env.SOFTELA_AI_HOME;
      else process.env.SOFTELA_AI_HOME = before;
    }
  });

  rowTests("round four, python words and streams", [
    ["dbm as a word in a string", `python -c 'import json;d=${pyRead};print([k for k in d if "dbm" in k])'`, "pass"],
    ["zipfile as a word in a string", `python -c 'import json;d=${pyRead};print([k for k in d if "zipfile" in k])'`, "pass"],
    ["shelve in a path", `python -c 'import json;print(len(json.load(open("${ap}"))),"/tmp/shelve-notes")'`, "pass"],
    ["an import of zipfile", `python -c 'import json,zipfile;print(len(${pyRead}))'`, "deny"],
    ["an import of shelve after a comma", `python -c 'import json, shelve;print(len(${pyRead}))'`, "deny"],
    ["a from import of tarfile", `python -c 'from tarfile import open as o;print("${ap}")'`, "deny"],
    ["a zipfile member call", `python -c 'import json;print(zipfile.ZipFile("/tmp/x.zip","w"),"${ap}")'`, "deny"],
    ["a text wrapper over stdout", `python -c 'import io,sys,json;sys.stdout=io.TextIOWrapper(sys.stdout.buffer,encoding="utf-8");print(${pyRead})'`, "pass"],
    ["a text wrapper over stderr", `python -c 'import io,sys,json;sys.stderr=io.TextIOWrapper(sys.stderr.buffer,encoding="utf-8");print(${pyRead})'`, "pass"],
    ["a codecs writer over stdout", `python -c 'import codecs,sys,json;sys.stdout=codecs.getwriter("utf-8")(sys.stdout.buffer);print(${pyRead})'`, "pass"],
    ["a wrapper over a file", `python -c 'import io,sys,json;sys.stdout=io.TextIOWrapper(open("/tmp/o","wb"));print(${pyRead})'`, "deny"],
    ["stdout assigned to stderr", `python -c 'import sys,json;sys.stdout=sys.stderr;print(${pyRead})'`, "deny"],
    ["__import__ of json", `python -c 'import sys;print(__import__("json").load(open("${ap}")))'`, "pass"],
    ["__import__ of json in double quotes", `python3 -c "print(__import__('json').load(open('${ap}'))['x'])"`, "pass"],
    ["__import__ of os", `python -c '__import__("os").replace("/tmp/x","${ov}")'`, "deny"],
    ["__import__ of os.path", `python -c 'print(__import__("os.path"),"${ap}")'`, "deny"],
    ["__import__ of shutil", `python -c '__import__("shutil").copy("/tmp/x","${ov}")'`, "deny"],
    ["__import__ of a variable", `python -c 'n="json";print(__import__(n),"${ap}")'`, "deny"],
    ["to_json with options", `python -c 'import pandas as pd;print(pd.read_json("${ap}").to_json(orient="records"))'`, "pass"],
    ["to_csv with an option", `python -c 'import pandas as pd;print(pd.read_json("${ap}").to_csv(index=False))'`, "pass"],
    ["to_csv to stdout", `python -c 'import sys,pandas as pd;pd.read_json("${ap}").to_csv(sys.stdout,index=False)'`, "pass"],
    ["to_csv to a path keyword", `python -c 'import pandas as pd;pd.read_json("${ap}").to_csv(path_or_buf="/tmp/o.csv")'`, "deny"],
    ["to_json to a path keyword after an option", `python -c 'import pandas as pd;pd.read_json("${ap}").to_json(orient="records",path_or_buf="/tmp/o.json")'`, "deny"],
    ["getattr of a harmless literal", `python -c 'import json,os;d=${pyRead};print(getattr(d,"get")("x"),getattr(os,"sep"))'`, "pass"],
    ["getattr of remove", `python -c 'import os;getattr(os,"remove")("${ov}")'`, "deny"],
    ["getattr of copy on shutil", `python -c 'import shutil;getattr(shutil,"copy")("/tmp/x","${ov}")'`, "deny"],
    ["getattr with a variable name", `python -c 'import os;n="remove";getattr(os,n)("${ov}")'`, "deny"],
  ]);

  rowTests("round four, bindings and names", [
    ["a local named cp in an arrow body", nodeE(`const o=${readOf};Object.values(o).forEach(r=>{const cp=r.count;console.log(cp)})`), "pass"],
    ["a local named rm in an arrow body (the backstop still asks on the verb)", nodeE(`const o=${readOf};console.log(Object.entries(o).map(([k,v])=>{const rm=v.removed;return k+rm}))`), "ask"],
    ["a local named truncate", nodeE(`const o=${readOf};console.log(Object.keys(o).map(k=>{const truncate=k.slice(0,8);return truncate}))`), "pass"],
    ["an object literal key named rename", nodeE(`const o=${readOf};console.log(Object.entries(o).map(([k,v])=>({id:k,rename:v.renamed})))`), "pass"],
    ["a destructuring declaration", nodeE(`${pre}const {rm:r}=fs;r(p)`), "deny"],
    ["a function parameter", nodeE(`${pre}function f({rm:r}){r(p)}f(fs)`), "deny"],
    ["an arrow parameter", nodeE(`${pre}(({rm:r})=>r(p))(fs)`), "deny"],
    ["a second parameter", nodeE(`${pre}((a,{rm:r})=>r(p))(1,fs)`), "deny"],
    ["a for-of binding", nodeE(`${pre}for (const {rm:r} of [fs]) r(p)`), "deny"],
    ["an ES import list", `node --input-type=module -e 'import {rm as r} from "fs"; r("${ov}")'`, "deny"],
    ["a destructuring assignment", nodeE(`${pre}let r;({rm:r}=fs);r(p)`), "deny"],
    ["a nested binding", nodeE(`${pre}const {promises:{unlink:u}}=fs;u(p)`), "deny"],
    ["a short name in an array of strings", nodeE(`${pre}console.log(["rm","mkdir"].length,fs.existsSync(p))`), "ask"],
    ["a data key written in brackets", nodeE(`const o=${readOf};console.log(o.rules["write"],o.hooks["open"])`), "pass"],
    ["a single-element string array is still a bracket string", nodeE(`${pre}["rename"].map(n=>fs[n])`), "deny"],
    ["open with a callback arrow", nodeE(`require("fs").open("${ap}",(e,fd)=>{console.log(e,fd)})`), "pass"],
    ["open with a callback function", nodeE(`require("fs").open("${ap}",function(e,fd){console.log(e,fd)})`), "pass"],
    ["open with w and a callback", nodeE(`require("fs").open("${ov}","w",(e,fd)=>{console.log(e,fd)})`), "deny"],
    ["open with a variable mode", nodeE(`const m="r";console.log(require("fs").openSync("${ap}",m))`), "deny"],
    ["a bracketed openSync with w", nodeE(`${pre}fs["openSync"](p,"w")`), "deny"],
    ["a bracketed open with one argument", nodeE(`${pre}console.log(fs["open"](p))`), "pass"],
  ]);

  rowTests("round four, text tests skip string text", [
    ["with ( inside a label", nodeE(`console.log("rules with (any) expiry:",Object.keys(${readOf}).length)`), "pass"],
    ["a dot and a comment opener inside a label", nodeE(`console.log("scanning ./*.json");console.log(require("fs").readFileSync("${ap}","utf8").length)`), "pass"],
    ["a dot and a double slash inside a label", nodeE(`console.log("x.//y",Object.keys(${readOf}).length)`), "pass"],
    ["open as inside a label", nodeE(`console.log("open as json");console.log(Object.keys(${readOf}).length)`), "pass"],
    ["with ( inside a template text", nodeE(`console.log(\`with (x) ./*\`,Object.keys(${readOf}).length)`), "pass"],
    ["a block comment after the dot in code", nodeE(`${pre}fs./**/rm(p)`), "deny"],
    ["an HTML-like comment after the dot in code", nodeE(`${pre}fs.<!--x\nunlink(p,()=>{})`), "deny"],
    ["a with scope in code", nodeE(`${pre}with(fs){rm(p)}`), "deny"],
    ["a renamed open in code", nodeE(`${pre}const {openSync:o}=fs;o(p,"w")`), "deny"],
  ]);

  rowTests("round four, writes to the standard descriptors", [
    ["writeSync to descriptor 1", nodeE(`require("fs").writeSync(1,${readOf}+"\\n")`), "pass"],
    ["writeSync to descriptor 2", nodeE(`${pre}fs.writeSync(2,fs.readFileSync(p,"utf8"))`), "pass"],
    ["writeSync to another descriptor", nodeE(`${pre}fs.writeSync(fs.openSync("/tmp/x","r"),fs.readFileSync(p,"utf8"))`), "deny"],
    ["writeSync to descriptor 1 beside a real write", nodeE(`${pre}fs.writeSync(1,"x");fs.writeFileSync(p,"{}")`), "deny"],
  ]);

  test("round four: the sealed exception does not neutralise writeSync to descriptor 1", () => {
    eq(bash(sealed(`${sealedBody}fs.writeSync(1,"x")`)), "ask");
  });

  test("round four: a double-quoted script with a bare braced parameter is still not sealed", () => {
    eq(bash(`node -e "const fs=require('fs');console.log('\${HOME}',fs.existsSync('${ov}'))"`), "pass");
    eq(bash(`FOO=1 node -e "const fs=require('fs');console.log('\${HOME}','rm',fs.existsSync('${ov}'))"`), "ask");
  });

  /* ----------------------------------------------------------- source hygiene */

  test("source hygiene: the guard holds no Unicode escape sequence and no typographic quote", () => {
    const source = fs.readFileSync(require.resolve("../../core/guards/infra-self-protection"), "utf8");
    const backslashU = `${String.fromCharCode(92)}u`;
    const curly = [...source].filter((ch) => ch.charCodeAt(0) >= 0x2018 && ch.charCodeAt(0) <= 0x201b);

    ok(!source.includes(backslashU), "no backslash-u sequence anywhere in the source");
    eq(curly.length, 0);
  });

  /* -------------------------------------------------------------- mandatory */

  test("mandatory: true means a developer override cannot soften this rule", () => {
    eq(
      decide(rule, {
        toolName: "Bash",
        command: "softela-ai approve subagent-model",
        overrideSpec: { "infra-self-protection": { action: "ask" } },
      }),
      "deny",
    );
  });

  test("mandatory: true means a developer override cannot even allow-list past it", () => {
    eq(
      decide(rule, {
        toolName: "Bash",
        command: "softela-ai approve subagent-model",
        overrideSpec: { "infra-self-protection": { allow: ["softela-ai approve"] } },
      }),
      "deny",
    );
  });

  /* ------------------------------------- persisting SOFTELA_AI_HOME: deny */

  /**
   * Redirecting the home every path resolves through is the one way to
   * disarm this rule without touching a single file it protects: the
   * statement names nothing under the state directory, so every other check
   * here passes it, while every future hook process resolves somewhere else
   * entirely. Setting the variable for ONE command is untouched — a hook
   * runs in its own process and never inherits it.
   */
  test("setx persisting SOFTELA_AI_HOME is denied", () => {
    eq(decide(rule, { toolName: "Bash", command: "setx SOFTELA_AI_HOME C:\\tmp\\decoy" }), "deny");
  });

  test("SetEnvironmentVariable persisting SOFTELA_AI_HOME is denied", () => {
    eq(
      decide(rule, {
        toolName: "PowerShell",
        command: '[Environment]::SetEnvironmentVariable("SOFTELA_AI_HOME", "C:/tmp/decoy", "User")',
      }),
      "deny",
    );
  });

  test("reg add against the Environment key persisting SOFTELA_AI_HOME is denied", () => {
    eq(
      decide(rule, {
        toolName: "PowerShell",
        command: 'reg add "HKCU\\Environment" /v SOFTELA_AI_HOME /d C:/tmp/decoy /f',
      }),
      "deny",
    );
  });

  test("appending an SOFTELA_AI_HOME export to a shell startup file is denied", () => {
    eq(decide(rule, { toolName: "Bash", command: "echo export SOFTELA_AI_HOME=/tmp/decoy >> ~/.bashrc" }), "deny");
  });

  test("writing an SOFTELA_AI_HOME export into a startup file through a write tool is denied", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(agentHome("claude"), "..", ".bashrc"),
        content: "export SOFTELA_AI_HOME=/tmp/decoy\n",
      }),
      "deny",
    );
  });

  test("merely reading a startup file for the variable is not persistence", () => {
    eq(decide(rule, { toolName: "Bash", command: "grep SOFTELA_AI_HOME ~/.bashrc" }), "pass");
  });

  test("setting SOFTELA_AI_HOME for the duration of one command is untouched", () => {
    eq(decide(rule, { toolName: "Bash", command: "export SOFTELA_AI_HOME=/tmp/scratch && node tests/run.js" }), "pass");
  });

  test("setting SOFTELA_AI_HOME for one PowerShell command is untouched", () => {
    eq(
      decide(rule, { toolName: "PowerShell", command: '$env:SOFTELA_AI_HOME = "$env:TEMP\\scratch"; node bin/softela-ai doctor' }),
      "pass",
    );
  });

  test("persisting some other variable is not this rule's business", () => {
    eq(decide(rule, { toolName: "Bash", command: "setx PATH C:/tools" }), "pass");
  });

  test("writing an unrelated line into a startup file is not this rule's business", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(agentHome("claude"), "..", ".bashrc"),
        content: 'alias ll="ls -la"\n',
      }),
      "pass",
    );
  });

  test("mandatory: true means the project config's rules switch cannot turn this rule off", () => {
    eq(
      decide(rule, {
        toolName: "Bash",
        command: "softela-ai approve subagent-model",
        project: { rules: { groups: { agent: "off" }, byId: { "infra-self-protection": "off" } } },
      }),
      "deny",
    );
  });
});
