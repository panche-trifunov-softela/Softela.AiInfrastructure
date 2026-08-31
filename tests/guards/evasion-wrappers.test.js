"use strict";

/**
 * Cross-guard evasion matrix: every rule that reads `ctx.command`, crossed
 * with every shell wrapper form this project's own `shell-parse.js` claims to
 * see through.
 *
 * The property under test, stated once and asserted everywhere: wrapping a
 * command in shell syntax that does not change what it does must not change
 * what a guard decides about it. Two batteries prove both directions of that
 * property:
 *
 * - `DANGEROUS_FIXTURES` — one command per rule that the rule genuinely
 *   denies or asks about in its bare form. Every wrapper form must produce
 *   the SAME action. A wrapper that turns a `deny`/`ask` into a `pass` is a
 *   bypass — the exact class of hole this suite exists to catch.
 *
 * - `HARMLESS_FIXTURES` — the mirror of each dangerous command, with the
 *   trigger text moved inside a quoted argument (or, for
 *   `infra-self-protection`, a filename that merely mentions the trigger
 *   words) so the bare form passes. Every wrapper form must ALSO pass. A
 *   suite that only checked the first battery would happily accept a parser
 *   that fires on every quoted mention too.
 *
 * The rule axis is discovered from the registry, not hand-listed: any rule
 * module whose own FILE mentions `ctx.command` anywhere — including inside a
 * private helper its `evaluate` merely delegates to — is included
 * automatically, so a rule added later is covered without editing this
 * file's rule list. Only the per-rule FIXTURE (which command actually
 * triggers it) is necessarily hand-authored — a rule discovered with no
 * matching fixture entry is reported as a skipped case with a clear reason,
 * rather than silently left out of the matrix.
 */

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");
const { decide } = require("./_ctx");
const registry = require("../../core/guards/index");

/** Directory the rule registry loads every `*.js` module from. */
const GUARDS_DIR = path.join(__dirname, "..", "..", "core", "guards");

/**
 * A tracked-file/per-machine pair shared by every `local-config-isolation`
 * fixture below, plus the tracked file's offending content — the project
 * config and the file content `local-config-isolation` needs to have
 * anything to say at all, independent of the command line itself.
 */
const LOCAL_CONFIG_PROJECT = {
  localConfig: [{ tracked: "config/hosts.json", perMachine: "config/hosts.local.json", action: "ask" }],
};

/** The tracked file's content, resolved at the default fixture repo root `/repo`. */
const LOCAL_CONFIG_FILES = {
  "/repo/config/hosts.json": 'export const HOST = "http://localhost:5000";',
};

/**
 * One command per command-reading rule that the rule genuinely denies or
 * asks about in its bare form, plus whatever extra context field
 * (`project`, `git`, `files`) that rule's `requiresConfig` or logic needs to
 * be meaningful. Verified directly against the engine before being written
 * down here — see the suite's own sanity-check pass below, which re-asserts
 * every one of these against its own `want` before the wrapper matrix runs.
 */
const DANGEROUS_FIXTURES = {
  "branch-naming": { command: "git checkout -b bad", want: "ask" },
  "commit-message": { command: 'git commit -m "fix stuff" --no-verify', want: "deny" },
  "delegate-bulk-reading": { command: "grep -rn pattern src", want: "ask", modules: ["agent-orchestration"] },
  "forbidden-commands": { command: "cypress run", want: "deny" },
  "infra-self-protection": { command: "softela-ai approve subagent-model", want: "deny" },
  "local-config-isolation": {
    command: "git add -A",
    want: "ask",
    project: LOCAL_CONFIG_PROJECT,
    files: LOCAL_CONFIG_FILES,
  },
  "no-local-merge-to-base": { command: "git merge origin/feature-other", want: "deny", git: { branch: "dev-ng" } },
  "no-push-to-base": { command: "git push origin dev-ng", want: "deny" },
  "package-install-flags": { command: "npm install", want: "deny" },
  "protected-paths": { command: "git add -A", want: "ask" },
  "pull-must-rebase": { command: "git pull", want: "deny" },
  "rebase-safety": { command: "git rebase --abort", want: "ask", git: { rebaseInProgress: true } },
  "shell-file-write": { command: "echo hi > src/App.tsx", want: "deny" },
  "typecheck-invocation": { command: "npx tsc --noEmit", want: "deny" },
};

/**
 * The mirror of {@link DANGEROUS_FIXTURES}: the same trigger text, moved
 * inside a quoted argument (or, for `infra-self-protection`, a filename that
 * merely mentions the tool's name and its self-unlock verb — the exact shape
 * of the regression `infra-self-protection.test.js` already locks in) so the
 * bare form passes. None of these commands carry a single quote, since the
 * `bash -c '…'` wrapper below delimits its argument with single quotes and a
 * fixture with one embedded would close that quote early rather than
 * exercise the wrapper honestly.
 */
const HARMLESS_FIXTURES = {
  "branch-naming": { command: 'echo "git checkout -b bad"' },
  "commit-message": { command: 'echo "git commit --no-verify -m done"' },
  "delegate-bulk-reading": { command: 'echo "grep -rn pattern src"', modules: ["agent-orchestration"] },
  "forbidden-commands": { command: 'echo "cypress run"' },
  "infra-self-protection": { command: "cat softela-ai-approve-notes.txt" },
  "local-config-isolation": {
    command: 'echo "git add -A"',
    project: LOCAL_CONFIG_PROJECT,
    files: LOCAL_CONFIG_FILES,
  },
  "no-local-merge-to-base": { command: 'echo "git merge dev-ng"', git: { branch: "dev-ng" } },
  "no-push-to-base": { command: 'echo "git push origin dev-ng"' },
  "package-install-flags": { command: 'echo "npm install"' },
  "protected-paths": { command: 'echo "git add -A"' },
  "pull-must-rebase": { command: 'echo "git pull"' },
  "rebase-safety": { command: 'echo "git rebase --abort"', git: { rebaseInProgress: true } },
  "shell-file-write": { command: 'echo "echo hi > src/App.tsx"' },
  "typecheck-invocation": { command: 'echo "npx tsc --noEmit"' },
};

/**
 * A realistic backslash-separated Windows path, embedded ahead of a fixture
 * command by the Windows-path wrapper entries below — the exact spelling
 * that once tokenised to a mangled, non-existent directory once a nested
 * shell's double-quoted argument was involved (`peelNestedShellLayer`'s own
 * dequoting bug, now covered directly in `tests/lib/shell-parse.test.js`).
 */
const WINDOWS_PATH = "C:\\Users\\dev\\repos\\Project";

/**
 * Escapes a command for embedding as the double-quoted argument of a nested
 * shell wrapper (`bash -c "…"`, `powershell -Command "…"`, `cmd /c "…"`): any
 * double quote already in the command becomes an escaped `\"`, the exact
 * spelling `peelNestedShellLayer` expects to see and reverse. Round-tripping
 * through escape-then-unwrap is what lets a fixture command that already
 * carries its own double quotes (a commit message, a quoted echo argument)
 * survive this wrapper with its meaning completely unchanged.
 *
 * @param {string} cmd The fixture command being wrapped.
 * @returns {string} `cmd` with its own double quotes escaped for embedding.
 */
function escapeForNestedDoubleQuote(cmd) {
  return cmd.replace(/"/g, '\\"');
}

/**
 * Every wrapper form the matrix applies to a fixture command — bare, plus
 * every shell-grouping, process-substitution, nested-shell, and PowerShell
 * shape `shell-parse.js` claims to see through. `bash -c`, `powershell
 * -Command`, `Invoke-Expression` and `iex` all delimit their argument with a
 * single quote, which is why no fixture command above carries one — except
 * the three Windows-path entries below, which deliberately use the DOUBLE-
 * quoted delimiter form instead, escaping any quotes the fixture command
 * already carries, specifically to route the fixture through the
 * double-quote dequoting branch of `peelNestedShellLayer` that carried the
 * unfixed half of this defect.
 *
 * `$(( … ))` arithmetic expansion is deliberately absent from this list: it
 * is not a command, `splitStatements` never turns it into one, and wrapping
 * a dangerous fixture in it would make the fixture inert rather than exercise
 * evasion — the opposite of what this matrix checks. See
 * `tests/lib/shell-parse.test.js` for the tests proving arithmetic expansion
 * stays inert.
 */
const WRAPPERS = [
  { name: "bare", wrap: (cmd) => cmd },
  { name: "parens", wrap: (cmd) => `(${cmd})` },
  { name: "parens with inner spaces", wrap: (cmd) => `( ${cmd} )` },
  { name: "brace group", wrap: (cmd) => `{ ${cmd}; }` },
  { name: "command substitution", wrap: (cmd) => `$(${cmd})` },
  { name: "backticks", wrap: (cmd) => `\`${cmd}\`` },
  { name: "process substitution <( … )", wrap: (cmd) => `<(${cmd})` },
  { name: "process substitution >( … )", wrap: (cmd) => `>(${cmd})` },
  { name: "leading cd &&", wrap: (cmd) => `cd repo && ${cmd}` },
  { name: "trailing background &", wrap: (cmd) => `${cmd} &` },
  { name: "pipeline stage", wrap: (cmd) => `true | ${cmd}` },
  { name: 'bash -c "…"', wrap: (cmd) => `bash -c '${cmd}'` },
  { name: "PowerShell call operator & { … }", wrap: (cmd) => `& { ${cmd} }` },
  { name: "PowerShell Invoke-Command -ScriptBlock { … }", wrap: (cmd) => `Invoke-Command -ScriptBlock { ${cmd} }` },
  { name: "PowerShell powershell -Command '…'", wrap: (cmd) => `powershell -Command '${cmd}'` },
  { name: "PowerShell Invoke-Expression '…'", wrap: (cmd) => `Invoke-Expression '${cmd}'` },
  { name: "PowerShell iex '…' (Invoke-Expression alias)", wrap: (cmd) => `iex '${cmd}'` },
  { name: "nested: leading cd && around parens", wrap: (cmd) => `cd repo && (${cmd})` },
  {
    name: "nested: bash -c with a double-quoted Windows-path cd prefix",
    wrap: (cmd) => `bash -c "cd \\"${WINDOWS_PATH}\\" && ${escapeForNestedDoubleQuote(cmd)}"`,
  },
  {
    name: "nested: powershell -Command with a double-quoted Windows-path cd prefix",
    wrap: (cmd) => `powershell -Command "cd \\"${WINDOWS_PATH}\\"; ${escapeForNestedDoubleQuote(cmd)}"`,
  },
  {
    name: "nested: cmd /c with a double-quoted Windows-path cd prefix",
    wrap: (cmd) => `cmd /c "cd \\"${WINDOWS_PATH}\\" && ${escapeForNestedDoubleQuote(cmd)}"`,
  },
];

/**
 * Builds the extra `decide()` context fields (`project`, `git`, `files`) a
 * fixture entry declares, wired to the shape `decide`/`makeCtx` expect —
 * `files` becomes the `readFile` lookup table `local-config-isolation`
 * reads its tracked file's content through.
 *
 * @param {object} fixture One `DANGEROUS_FIXTURES`/`HARMLESS_FIXTURES` entry.
 * @param {string} command The (possibly wrapped) command to run.
 * @returns {object} The `decide()`-ready context partial.
 */
function ctxFor(fixture, command) {
  const partial = { command };
  if (fixture.project) partial.project = fixture.project;
  if (fixture.git) partial.git = fixture.git;
  if (fixture.files) partial.files = fixture.files;
  if (fixture.modules) partial.modules = fixture.modules;
  return partial;
}

/**
 * Checks whether a rule module reads `ctx.command` anywhere in its own file
 * — the source-level signal that discovers the rule axis automatically,
 * with no hand-listed rule ids. Reads the module's FILE, not
 * `rule.evaluate.toString()`: several rules (`infra-self-protection`,
 * `local-config-isolation`) read `ctx.command` only inside a private helper
 * their `evaluate` delegates to, which `Function.prototype.toString` on
 * `evaluate` alone would never see.
 *
 * @param {object} rule A loaded rule module.
 * @returns {boolean} `true` when `core/guards/<rule.id>.js` mentions
 * `ctx.command`.
 */
function readsCommand(rule) {
  try {
    const source = fs.readFileSync(path.join(GUARDS_DIR, `${rule.id}.js`), "utf8");
    return source.includes("ctx.command");
  } catch {
    return false;
  }
}

suite("guards/evasion-wrappers", ({ test, skip, eq }) => {
  const commandRules = registry.rules.filter(readsCommand);

  test("the registry actually yielded command-reading rules to test", () => {
    if (commandRules.length < 10) {
      throw new Error(`expected at least 10 command-reading rules, found ${commandRules.length}`);
    }
  });

  // --- sanity pass: every fixture's bare form produces its declared `want`,
  // and every harmless fixture's bare form passes, before the wrapper matrix
  // trusts either one as a baseline.
  for (const rule of commandRules) {
    const dangerous = DANGEROUS_FIXTURES[rule.id];
    if (dangerous) {
      test(`sanity: bare "${dangerous.command}" ${dangerous.want}s under ${rule.id}`, () => {
        eq(decide(rule, ctxFor(dangerous, dangerous.command)), dangerous.want);
      });
    }
    const harmless = HARMLESS_FIXTURES[rule.id];
    if (harmless) {
      test(`sanity: bare harmless "${harmless.command}" passes under ${rule.id}`, () => {
        eq(decide(rule, ctxFor(harmless, harmless.command)), "pass");
      });
    }
  }

  // --- the matrix itself: every command-reading rule x every wrapper form,
  // for both the dangerous fixture (must match the bare action) and the
  // harmless fixture (must always pass).
  for (const rule of commandRules) {
    const dangerous = DANGEROUS_FIXTURES[rule.id];
    const harmless = HARMLESS_FIXTURES[rule.id];

    if (!dangerous && !harmless) {
      skip(`${rule.id}: wrapper matrix`, "no fixture registered in evasion-wrappers.test.js for this rule id");
      continue;
    }

    for (const wrapper of WRAPPERS) {
      if (dangerous) {
        const wrapped = wrapper.wrap(dangerous.command);
        test(`${rule.id}: ${wrapper.name} still ${dangerous.want}s ("${wrapped}")`, () => {
          eq(decide(rule, ctxFor(dangerous, wrapped)), dangerous.want);
        });
      }

      if (harmless) {
        const wrapped = wrapper.wrap(harmless.command);
        test(`${rule.id}: ${wrapper.name} still passes ("${wrapped}")`, () => {
          eq(decide(rule, ctxFor(harmless, wrapped)), "pass");
        });
      }
    }
  }
});
