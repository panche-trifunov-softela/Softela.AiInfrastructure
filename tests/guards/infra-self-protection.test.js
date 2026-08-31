"use strict";

const path = require("path");
const { suite } = require("../harness");
const rule = require("../../core/guards/infra-self-protection");
const { installedRoot, stateDir, agentHome } = require("../../core/lib/paths");
const { PROJECT_MINIMAL, decide } = require("./_ctx");

suite("guards/infra-self-protection", ({ test, eq }) => {
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
