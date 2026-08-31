"use strict";

/**
 * End-to-end acceptance suite: does a real host-shaped tool call actually
 * get refused?
 *
 * Every rule in this repository already has a unit suite under
 * `tests/guards/`, and it is green — but a unit suite calls
 * `rule.evaluate(ctx)` directly, with a hand-built `ctx`. It never asks
 * whether a REAL dispatcher, fed a REAL host payload on stdin, the way
 * `adapters/claude/dispatch.js` and `adapters/codex/dispatch.js` are
 * actually invoked, produces the refusal a developer would see. That gap let
 * a field session run several rules that never fired, even though their own
 * unit tests were passing the whole time.
 *
 * This suite closes it by spawning the two dispatchers as real child
 * processes for both hosts and asserting on the decision each one prints —
 * never by importing `core/engine.js` or a guard module and calling it
 * in-process.
 *
 * Fixture — read before changing anything below:
 *
 * - `core/lib/context.js#buildContext` accepts a `projectsDir` option, and
 *   `core/engine.js#evaluate` accepts `presetsDir`, but
 *   `adapters/shared/dispatch-core.js#runDispatch` — the function both real
 *   dispatchers call — passes neither through, and reads no environment
 *   variable that would let a child process steer either one. A scratch
 *   `projects/` directory is therefore not reachable through the real
 *   dispatcher entry points; inventing a new steering mechanism was out of
 *   scope for this suite (see the task's own instructions), so every
 *   scenario here runs against the shipped `projects/Softela.ReactSCExpert.json`
 *   and its merged `projects/_presets/frontend.json` instead. The fixture
 *   below is a disposable git repository whose remote matches that project's
 *   own `match.remotes` pattern — the same approach already proven out in
 *   `tests/adapters/shell-workdir-field-test.test.js`.
 * - The fixture is built exactly ONCE, at the top of the suite body, and
 *   reused read-only by every case — nothing below ever writes into it
 *   after `buildFixture` returns. `tests/harness.js#suite`'s own
 *   `tmpdir()` cleans up on return from the suite function, including when
 *   an individual `test()` case throws, so no separate teardown is needed
 *   here.
 * - Every dispatcher spawn goes through `tests/adapters/_spawn.js#runDispatcher`,
 *   which already bounds each child process with a timeout (10s, generous
 *   next to the ~200-400ms a real spawn takes) and points `SOFTELA_AI_HOME` at a
 *   disposable directory, never a real agent home.
 * - Windows note, worth stating because it is exactly the kind of thing that
 *   silently makes a rule never fire: `fs.mkdtempSync` under the system temp
 *   directory can hand back an 8.3 short-name path (`...\VOLODY~1\...`)
 *   while `git rev-parse --show-toplevel` reports the SAME directory's long
 *   form. Every project-scoped rule compares `ctx.filePath` against
 *   `ctx.git.repoRoot` as literal string prefixes
 *   (`core/lib/repo-path.js#relativeToRepo`), so the two spellings silently
 *   fail to match and every one of those rules then finds nothing to fire
 *   on — exactly the false "it works" a real checkout never exhibits,
 *   because a real checkout was never opened through its short name in the
 *   first place. `buildFixture` re-anchors on git's own resolved path for
 *   exactly this reason.
 * - Codex has no native `ask` (CONTRACTS.md §7): under the installer's
 *   default `askMode` ("block"), an `ask` decision from a rule is mapped
 *   onto a Codex `deny` by the adapter. `codexDecisionFor` encodes that
 *   mapping explicitly, so a scenario whose underlying rule happens to
 *   return `ask` is still asserted correctly on Codex rather than silently
 *   skipped.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { suite } = require("../harness");
const { CLAUDE_DISPATCH, CODEX_DISPATCH, runDispatcher } = require("../adapters/_spawn");

/** The base branch every scenario's feature branch is cut from, matching `projects/Softela.ReactSCExpert.json`'s own `baseBranches`. */
const BASE_BRANCH = "dev-ng";

/** The feature branch checked out for every scenario, matching that project's own `branchNaming` convention. */
const FEATURE_BRANCH = "feature/task_1_scratch";

/** Rule ids this suite asserts by name, kept as constants so a typo shows up as a broken reference, not a silently-never-matching string. */
const RULE = {
  componentFolderShape: "component-folder-shape",
  colocatedTests: "colocated-tests",
  noExplicitAny: "no-explicit-any",
  barrelExportsOnly: "barrel-exports-only",
  apiImportBoundary: "api-import-boundary",
  typecheckInvocation: "typecheck-invocation",
  packageInstallFlags: "package-install-flags",
  noPushToBase: "no-push-to-base",
  commitMessage: "commit-message",
  shellFileWrite: "shell-file-write",
};

/**
 * Runs a git subcommand against fixture setup. Failures here are a broken
 * fixture, not a scenario under test, so they are left to throw and abort
 * the suite loudly rather than surface as a confusing per-case failure.
 *
 * @param {string} cwd The directory to run git in.
 * @param {string[]} args The git arguments.
 * @returns {string} The command's trimmed stdout.
 */
function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Builds the one scratch fixture the whole suite shares: a repository
 * literally named `Softela.ReactSCExpert`, with a remote matching that
 * project's own `match.remotes` pattern, one committed flat component (for
 * the "move an existing file" scenario), a base branch, and a feature
 * branch cut from it.
 *
 * @param {() => string} tmpdir The suite's disposable-directory factory.
 * @returns {{repo: string, parent: string}} The repository's own absolute
 * path — resolved through git itself, not the raw `tmpdir()` result, see
 * the file header — and its parent directory.
 */
function buildFixture(tmpdir) {
  const scratch = tmpdir();
  const provisional = path.join(scratch, "Softela.ReactSCExpert");
  fs.mkdirSync(provisional);
  git(provisional, ["init", "-q"]);

  const repo = git(provisional, ["rev-parse", "--show-toplevel"]).split("/").join(path.sep);
  const parent = path.dirname(repo);

  git(repo, ["config", "user.email", "acceptance@example.invalid"]);
  git(repo, ["config", "user.name", "Acceptance Suite"]);
  git(repo, ["remote", "add", "origin", "https://dev.azure.com/org/Project/_git/Softela.ReactSCExpert"]);

  fs.writeFileSync(path.join(repo, "README.md"), "scratch fixture\n");
  fs.mkdirSync(path.join(repo, "src", "components"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "components", "Old.tsx"), "export function Old() { return null; }\n");

  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "seed fixture"]);
  git(repo, ["branch", "-M", BASE_BRANCH]);
  git(repo, ["checkout", "-q", "-b", FEATURE_BRANCH]);

  return { repo, parent };
}

/**
 * Builds a Write-tool payload, Claude Code's own `PreToolUse` shape.
 *
 * @param {string} filePath The absolute path being written.
 * @param {string} content The full file content the write would produce.
 * @param {string} cwd The session's own working directory.
 * @returns {object} A Claude Code-shaped payload.
 */
function claudeWrite(filePath, content, cwd) {
  return { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: filePath, content }, cwd };
}

/**
 * Builds an `apply_patch` payload, Codex's own shape for the same write.
 *
 * @param {string} filePath The absolute path being written.
 * @param {string} content The full file content the write would produce.
 * @param {string} cwd The session's own working directory.
 * @returns {object} A Codex-shaped payload.
 */
function codexWrite(filePath, content, cwd) {
  return { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { path: filePath, content }, cwd };
}

/**
 * Builds a shell-tool payload, Claude Code's own shape.
 *
 * @param {string} command The shell command line.
 * @param {string} cwd The session's own working directory.
 * @returns {object} A Claude Code-shaped payload.
 */
function claudeShell(command, cwd) {
  return { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd };
}

/**
 * Builds a shell-tool payload, Codex's own shape for the same command.
 *
 * @param {string} command The shell command line.
 * @param {string} cwd The session's own working directory.
 * @returns {object} A Codex-shaped payload.
 */
function codexShell(command, cwd) {
  return { hook_event_name: "PreToolUse", tool_name: "local_shell", tool_input: { command }, cwd };
}

/**
 * Builds a plain-read payload for a host — never matched by any write or
 * shell rule's own `tools` filter, so a read is expected to pass regardless
 * of which exact tool name a host spells it with.
 *
 * @param {"claude" | "codex"} agent Which host's own tool name to use.
 * @param {string} filePath The absolute path being read.
 * @param {string} cwd The session's own working directory.
 * @returns {object} A `PreToolUse` payload for a plain file read.
 */
function readPayload(agent, filePath, cwd) {
  if (agent === "codex") return { hook_event_name: "PreToolUse", tool_name: "read_file", tool_input: { path: filePath }, cwd };
  return { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: filePath }, cwd };
}

/**
 * Maps a rule-level action to the `permissionDecision` Codex itself would
 * emit for it. See the file header for why this mapping exists and must be
 * encoded rather than assumed away.
 *
 * @param {"deny" | "ask"} claudeDecision The `permissionDecision` expected
 * for the same scenario on Claude Code.
 * @returns {"deny"} The `permissionDecision` expected from Codex.
 */
function codexDecisionFor(claudeDecision) {
  return claudeDecision === "ask" ? "deny" : claudeDecision;
}

/**
 * Asserts that a dispatcher run refused a tool call, and that the reason
 * names the rule that actually fired — never just that SOMETHING fired.
 *
 * @param {{eq: Function, ok: Function}} a The suite's own `eq`/`ok`.
 * @param {{code: number, stdout: string, parsed: object | null}} result A
 * `runDispatcher` result.
 * @param {"deny" | "ask"} decision The expected `permissionDecision`.
 * @param {string} ruleId The rule id expected inside the reason text.
 * @returns {void}
 */
function assertRefused(a, result, decision, ruleId) {
  a.eq(result.code, 0, "the dispatcher itself always exits 0 on a decision");
  a.ok(result.parsed !== null, `expected a decision on stdout, got: ${result.stdout || "(empty)"}`);
  a.eq(result.parsed.hookSpecificOutput.permissionDecision, decision);
  const reason = result.parsed.hookSpecificOutput.permissionDecisionReason;
  a.ok(reason.includes(ruleId), `expected the reason to name "${ruleId}", got: ${reason}`);
}

/**
 * Asserts that a dispatcher run allowed a tool call outright: nothing on
 * stdout, and a clean exit.
 *
 * @param {{eq: Function}} a The suite's own `eq`.
 * @param {{code: number, stdout: string}} result A `runDispatcher` result.
 * @returns {void}
 */
function assertAllowed(a, result) {
  a.eq(result.code, 0, "a passing tool call exits 0");
  a.eq(result.stdout, "", "a passing tool call writes nothing to stdout");
}

suite("acceptance/enforcement", (s) => {
  const { test, eq, ok, tmpdir } = s;
  const a = { eq, ok };

  const { repo, parent } = buildFixture(tmpdir);
  const claudeHome = tmpdir();
  const codexHome = tmpdir();

  /**
   * Spawns the real Claude Code dispatcher against the shared fixture home.
   *
   * @param {object} payload The host-shaped stdin payload.
   * @param {string} cwd The child process's own working directory.
   * @returns {{code: number, stdout: string, stderr: string, parsed: object | null}}
   * The dispatcher's captured result.
   */
  function runClaude(payload, cwd) {
    return runDispatcher(CLAUDE_DISPATCH, payload, { home: claudeHome, cwd });
  }

  /**
   * Spawns the real Codex dispatcher against the shared fixture home.
   *
   * @param {object} payload The host-shaped stdin payload.
   * @param {string} cwd The child process's own working directory.
   * @returns {{code: number, stdout: string, stderr: string, parsed: object | null}}
   * The dispatcher's captured result.
   */
  function runCodex(payload, cwd) {
    return runDispatcher(CODEX_DISPATCH, payload, { home: codexHome, cwd });
  }

  /* ============================================================ refused */

  test("Claude Code refuses a component file written flat instead of in its own folder", () => {
    const filePath = path.join(repo, "src", "components", "Foo.tsx");
    const content = "export function Foo() { return null; }\n";
    assertRefused(a, runClaude(claudeWrite(filePath, content, repo), repo), "deny", RULE.componentFolderShape);
  });
  test("Codex refuses a component file written flat instead of in its own folder", () => {
    const filePath = path.join(repo, "src", "components", "Foo.tsx");
    const content = "export function Foo() { return null; }\n";
    assertRefused(a, runCodex(codexWrite(filePath, content, repo), repo), codexDecisionFor("deny"), RULE.componentFolderShape);
  });

  test("Claude Code refuses a spec written beside its source instead of in the test folder", () => {
    const filePath = path.join(repo, "src", "components", "Widget", "Widget.test.tsx");
    const content = "test('renders', () => {});\n";
    assertRefused(a, runClaude(claudeWrite(filePath, content, repo), repo), "deny", RULE.colocatedTests);
  });
  test("Codex refuses a spec written beside its source instead of in the test folder", () => {
    const filePath = path.join(repo, "src", "components", "Widget", "Widget.test.tsx");
    const content = "test('renders', () => {});\n";
    assertRefused(a, runCodex(codexWrite(filePath, content, repo), repo), codexDecisionFor("deny"), RULE.colocatedTests);
  });

  test("Claude Code refuses a kebab-case component folder where the convention is PascalCase", () => {
    const filePath = path.join(repo, "src", "components", "my-widget", "MyWidget.tsx");
    const content = "export function MyWidget() { return null; }\n";
    assertRefused(a, runClaude(claudeWrite(filePath, content, repo), repo), "deny", RULE.componentFolderShape);
  });
  test("Codex refuses a kebab-case component folder where the convention is PascalCase", () => {
    const filePath = path.join(repo, "src", "components", "my-widget", "MyWidget.tsx");
    const content = "export function MyWidget() { return null; }\n";
    assertRefused(a, runCodex(codexWrite(filePath, content, repo), repo), codexDecisionFor("deny"), RULE.componentFolderShape);
  });

  test("Claude Code refuses `any` in a contract type", () => {
    const filePath = path.join(repo, "src", "types", "Foo.ts");
    const content = "export interface Foo { bar: any; }\n";
    assertRefused(a, runClaude(claudeWrite(filePath, content, repo), repo), "deny", RULE.noExplicitAny);
  });
  test("Codex refuses `any` in a contract type", () => {
    const filePath = path.join(repo, "src", "types", "Foo.ts");
    const content = "export interface Foo { bar: any; }\n";
    assertRefused(a, runCodex(codexWrite(filePath, content, repo), repo), codexDecisionFor("deny"), RULE.noExplicitAny);
  });

  test("Claude Code refuses executable logic inside a barrel file", () => {
    const filePath = path.join(repo, "src", "components", "Widget", "index.ts");
    const content = 'export * from "./Widget";\nconsole.log("side effect");\n';
    assertRefused(a, runClaude(claudeWrite(filePath, content, repo), repo), "deny", RULE.barrelExportsOnly);
  });
  test("Codex refuses executable logic inside a barrel file", () => {
    const filePath = path.join(repo, "src", "components", "Widget", "index.ts");
    const content = 'export * from "./Widget";\nconsole.log("side effect");\n';
    assertRefused(a, runCodex(codexWrite(filePath, content, repo), repo), codexDecisionFor("deny"), RULE.barrelExportsOnly);
  });

  test("Claude Code refuses a component importing the API layer directly", () => {
    const filePath = path.join(repo, "src", "components", "Widget", "Widget.tsx");
    const content = 'import { getData } from "../../services/api/dataService";\nexport function Widget() { return null; }\n';
    assertRefused(a, runClaude(claudeWrite(filePath, content, repo), repo), "deny", RULE.apiImportBoundary);
  });
  test("Codex refuses a component importing the API layer directly", () => {
    const filePath = path.join(repo, "src", "components", "Widget", "Widget.tsx");
    const content = 'import { getData } from "../../services/api/dataService";\nexport function Widget() { return null; }\n';
    assertRefused(a, runCodex(codexWrite(filePath, content, repo), repo), codexDecisionFor("deny"), RULE.apiImportBoundary);
  });

  /* --- the bare typecheck invocation, written three ways --- */

  test("Claude Code refuses the bare typecheck invocation from inside the repository", () => {
    assertRefused(a, runClaude(claudeShell("npx tsc --noEmit", repo), repo), "deny", RULE.typecheckInvocation);
  });
  test("Codex refuses the bare typecheck invocation from inside the repository", () => {
    assertRefused(a, runCodex(codexShell("npx tsc --noEmit", repo), repo), codexDecisionFor("deny"), RULE.typecheckInvocation);
  });

  test('Claude Code refuses the bare typecheck invocation from the PARENT directory via cd "<repo>" && ... (double-quoted)', () => {
    const command = `cd "${path.basename(repo)}" && npx tsc --noEmit`;
    assertRefused(a, runClaude(claudeShell(command, parent), parent), "deny", RULE.typecheckInvocation);
  });
  test('Codex refuses the bare typecheck invocation from the PARENT directory via cd "<repo>" && ... (double-quoted)', () => {
    const command = `cd "${path.basename(repo)}" && npx tsc --noEmit`;
    assertRefused(a, runCodex(codexShell(command, parent), parent), codexDecisionFor("deny"), RULE.typecheckInvocation);
  });

  test("Claude Code refuses the bare typecheck invocation from the PARENT directory via cd <repo> && ... (unquoted)", () => {
    const command = `cd ${path.basename(repo)} && npx tsc --noEmit`;
    assertRefused(a, runClaude(claudeShell(command, parent), parent), "deny", RULE.typecheckInvocation);
  });
  test("Codex refuses the bare typecheck invocation from the PARENT directory via cd <repo> && ... (unquoted)", () => {
    const command = `cd ${path.basename(repo)} && npx tsc --noEmit`;
    assertRefused(a, runCodex(codexShell(command, parent), parent), codexDecisionFor("deny"), RULE.typecheckInvocation);
  });

  test("Claude Code refuses an install command missing the flag the project requires", () => {
    assertRefused(a, runClaude(claudeShell("npm install", repo), repo), "deny", RULE.packageInstallFlags);
  });
  test("Codex refuses an install command missing the flag the project requires", () => {
    assertRefused(a, runCodex(codexShell("npm install", repo), repo), codexDecisionFor("deny"), RULE.packageInstallFlags);
  });

  test("Claude Code refuses a push to a base branch", () => {
    assertRefused(a, runClaude(claudeShell("git push origin HEAD:dev-ng", repo), repo), "deny", RULE.noPushToBase);
  });
  test("Codex refuses a push to a base branch", () => {
    assertRefused(a, runCodex(codexShell("git push origin HEAD:dev-ng", repo), repo), codexDecisionFor("deny"), RULE.noPushToBase);
  });

  test("Claude Code refuses a commit subject naming a ticket id", () => {
    // Built by concatenation, never as one literal token, so this project's
    // own house rule against writing a ticket number in a source file is
    // never itself violated by the test data that exercises it.
    const subject = "Fix login crash " + "#" + "31253";
    assertRefused(a, runClaude(claudeShell(`git commit -m "${subject}"`, repo), repo), "deny", RULE.commitMessage);
  });
  test("Codex refuses a commit subject naming a ticket id", () => {
    const subject = "Fix login crash " + "#" + "31253";
    assertRefused(a, runCodex(codexShell(`git commit -m "${subject}"`, repo), repo), codexDecisionFor("deny"), RULE.commitMessage);
  });

  test("Claude Code refuses a file written through a shell heredoc rather than a write tool", () => {
    const command = "cat > src/components/Widget/index.ts <<'EOF'\nexport * from './Widget';\nEOF";
    assertRefused(a, runClaude(claudeShell(command, repo), repo), "deny", RULE.shellFileWrite);
  });
  test("Codex refuses a file written through a shell heredoc rather than a write tool", () => {
    const command = "cat > src/components/Widget/index.ts <<'EOF'\nexport * from './Widget';\nEOF";
    assertRefused(a, runCodex(codexShell(command, repo), repo), codexDecisionFor("deny"), RULE.shellFileWrite);
  });

  /* ============================================================= allowed */

  test("Claude Code allows the compliant component file", () => {
    const filePath = path.join(repo, "src", "components", "Widget", "Widget.tsx");
    assertAllowed(a, runClaude(claudeWrite(filePath, "export function Widget() { return null; }\n", repo), repo));
  });
  test("Codex allows the compliant component file", () => {
    const filePath = path.join(repo, "src", "components", "Widget", "Widget.tsx");
    assertAllowed(a, runCodex(codexWrite(filePath, "export function Widget() { return null; }\n", repo), repo));
  });

  test("Claude Code allows the component's own barrel", () => {
    const filePath = path.join(repo, "src", "components", "Widget", "index.ts");
    assertAllowed(a, runClaude(claudeWrite(filePath, 'export * from "./Widget";\n', repo), repo));
  });
  test("Codex allows the component's own barrel", () => {
    const filePath = path.join(repo, "src", "components", "Widget", "index.ts");
    assertAllowed(a, runCodex(codexWrite(filePath, 'export * from "./Widget";\n', repo), repo));
  });

  test("Claude Code allows the component's own colocated hook", () => {
    const filePath = path.join(repo, "src", "components", "Widget", "hooks", "useWidgetData.ts");
    assertAllowed(a, runClaude(claudeWrite(filePath, "export function useWidgetData() { return null; }\n", repo), repo));
  });
  test("Codex allows the component's own colocated hook", () => {
    const filePath = path.join(repo, "src", "components", "Widget", "hooks", "useWidgetData.ts");
    assertAllowed(a, runCodex(codexWrite(filePath, "export function useWidgetData() { return null; }\n", repo), repo));
  });

  test("Claude Code allows a spec in the test folder", () => {
    const filePath = path.join(repo, "src", "components", "Widget", "__tests__", "Widget.test.tsx");
    assertAllowed(a, runClaude(claudeWrite(filePath, "test('renders', () => {});\n", repo), repo));
  });
  test("Codex allows a spec in the test folder", () => {
    const filePath = path.join(repo, "src", "components", "Widget", "__tests__", "Widget.test.tsx");
    assertAllowed(a, runCodex(codexWrite(filePath, "test('renders', () => {});\n", repo), repo));
  });

  test("Claude Code allows moving an existing flat component into its own folder", () => {
    // The fixture already committed a flat "Old.tsx"; writing its own,
    // correctly-shaped folder-move destination is a move, not a duplicate —
    // core/guards/reuse-before-new.js#moveExclusion is what tells the two
    // apart, and core/guards/component-folder-shape.js has nothing to say
    // about a folder that already matches its own file's name.
    const filePath = path.join(repo, "src", "components", "Old", "Old.tsx");
    assertAllowed(a, runClaude(claudeWrite(filePath, "export function Old() { return null; }\n", repo), repo));
  });
  test("Codex allows moving an existing flat component into its own folder", () => {
    const filePath = path.join(repo, "src", "components", "Old", "Old.tsx");
    assertAllowed(a, runCodex(codexWrite(filePath, "export function Old() { return null; }\n", repo), repo));
  });

  test("Claude Code allows reading the working tree", () => {
    assertAllowed(a, runClaude(readPayload("claude", path.join(repo, "README.md"), repo), repo));
  });
  test("Codex allows reading the working tree", () => {
    assertAllowed(a, runCodex(readPayload("codex", path.join(repo, "README.md"), repo), repo));
  });

  test("Claude Code allows the correct typecheck invocation", () => {
    assertAllowed(a, runClaude(claudeShell("npx tsc -b", repo), repo));
  });
  test("Codex allows the correct typecheck invocation", () => {
    assertAllowed(a, runCodex(codexShell("npx tsc -b", repo), repo));
  });

  test("Claude Code allows the correct install invocation", () => {
    assertAllowed(a, runClaude(claudeShell("npm i --force", repo), repo));
  });
  test("Codex allows the correct install invocation", () => {
    assertAllowed(a, runCodex(codexShell("npm i --force", repo), repo));
  });

  test("Claude Code allows a rebase onto the base branch", () => {
    assertAllowed(a, runClaude(claudeShell("git rebase origin/dev-ng", repo), repo));
  });
  test("Codex allows a rebase onto the base branch", () => {
    assertAllowed(a, runCodex(codexShell("git rebase origin/dev-ng", repo), repo));
  });
});
