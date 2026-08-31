"use strict";

const { suite } = require("../harness");
const { PROJECT_MINIMAL, decide, decision } = require("./_ctx");
const rule = require("../../core/guards/forbidden-commands");

suite("guards/forbidden-commands", ({ test, eq, ok }) => {
  const cases = [
    // Positive — the fixture's declared forbidden pattern.
    { label: "denies the declared cypress run pattern", command: "cypress run" },
    { label: "denies cypress open reached through npx", command: "npx cypress open" },
    { label: "denies inside a compound statement", command: "cd apps/web && npx cypress run --spec foo" },
    { label: "denies through a PowerShell tool call", command: "cypress run", toolName: "PowerShell" },
    { label: "denies with irregular spacing", command: "cypress    run" },
    { label: "denies mixed case", command: "CYPRESS RUN" },
    { label: "denies as the second half of a `;` compound statement", command: "npm ci ; cypress open" },

    // Positive — the notOurs backstop, generic across test runners.
    { label: "denies a test runner invoked against a notOurs path", command: "npx vitest run cypress/e2e/smoke.cy.ts" },
    { label: "denies dotnet test invoked against a notOurs path", command: "dotnet test cypress/e2e/Project.csproj" },
    { label: "denies when the notOurs path is quoted", command: 'npx vitest run "cypress/e2e/smoke.cy.ts"' },

    // Positive — a runtime launcher executes the notOurs path even when
    // neither the launcher nor the runner's own name mentions "test".
    { label: "denies mocha reached through npx, no \"test\" in the command at all", command: "npx mocha cypress/e2e/smoke.cy.ts" },
    { label: "denies node executing a notOurs file directly", command: "node cypress/e2e/smoke.cy.ts" },
    { label: "denies ava reached through npx", command: "npx ava cypress/e2e/smoke.cy.ts" },

    // Positive — the same statement hidden behind a shell wrapper's -c /
    // -Command argument, which the outer shell actually executes verbatim.
    { label: "denies cypress run wrapped in sh -c", command: 'sh -c "cypress run"' },
    { label: "denies the notOurs test-runner trap wrapped in bash -c", command: "bash -c 'npx vitest run cypress/e2e/smoke.cy.ts'" },
    { label: "denies cypress run wrapped in a PowerShell -Command argument", command: 'powershell -Command "cypress run"' },
  ];

  for (const c of cases) {
    test(c.label, () => {
      eq(decide(rule, { command: c.command, toolName: c.toolName }), "deny");
    });
  }

  const passCases = [
    // Negative — ordinary daily commands unrelated to anything configured.
    { label: "passes an unrelated git command", command: "git status" },
    { label: "passes an unrelated build command", command: "npm run build" },
    { label: "passes an empty command", command: "" },
    { label: "passes a plain directory listing", command: "ls -la" },

    // Negative — this project's own tests, never notOurs.
    { label: "passes the project's own tests", command: "npx vitest run src/components/Foo.test.tsx" },
    { label: "passes an unrelated lint command", command: "npx eslint src" },
    { label: "passes starting the dev server", command: "npm start" },
    { label: "passes creating an ordinary feature branch", command: "git checkout -b feature/task_1_thing" },
    { label: "passes plain git history", command: "git log --oneline" },
    {
      label: "passes a pipeline whose second stage merely mentions cypress",
      command: "git log --oneline | grep cypress",
    },
    {
      label: "passes entirely for a non-shell tool call",
      command: "cypress run",
      toolName: "Write",
    },

    // Negative — touching a notOurs path without running anything. Each of
    // these arguments merely contains the substring "test" or "tests"
    // somewhere in a word or a path segment, which must not be confused
    // with actually executing something.
    { label: "passes reading a notOurs file without running it", command: "cat cypress/e2e/smoke.cy.ts" },
    { label: "passes listing a notOurs directory", command: "ls cypress/e2e" },
    { label: "passes reading a notOurs file whose name merely contains \"test\"", command: "cat cypress/e2e/latest-results.json" },
    { label: "passes grepping a notOurs path for a word that merely contains \"test\"", command: "grep -r contest cypress/e2e" },
    { label: "passes counting lines of a notOurs spec file named *.test.ts", command: "wc -l cypress/e2e/login.test.ts" },
    { label: "passes listing a notOurs subdirectory literally named tests", command: "ls cypress/e2e/tests" },
    {
      label: "passes reading a notOurs spec file through PowerShell Get-Content",
      command: "Get-Content cypress/e2e/login.test.ts",
      toolName: "PowerShell",
    },

    // Negative — a runtime launcher or a shell wrapper that never targets a
    // notOurs path at all; recognizing launchers and wrappers must not, on
    // its own, start denying ordinary work that has nothing to do with them.
    { label: "passes node running an ordinary script outside notOurs", command: "node scripts/build.js" },
    { label: "passes npx running an ordinary tool outside notOurs", command: "npx eslint src" },
    { label: "passes an ordinary bash -c wrapper with no forbidden content", command: "bash -c 'echo hello'" },
    { label: "passes a PowerShell -Command wrapper reading an unrelated file", command: 'powershell -Command "Get-Content README.md"' },

    // Negative — a git command whose message merely mentions the forbidden
    // words; quote-masking (forbidden list) and the git exemption (notOurs)
    // must both hold.
    {
      label: "passes a commit message that mentions cypress run in prose",
      command: 'git commit -m "document why cypress run flakes"',
    },
    {
      label: "passes a commit message mentioning tests under a notOurs path",
      command: 'git commit -m "adds tests under cypress/e2e/smoke.cy.ts"',
    },

    // Negative — silent when the project declares nothing at all.
    { label: "stays silent for a project that declares nothing", command: "cypress run", project: PROJECT_MINIMAL },

    // Negative — an invalid configured pattern degrades to silent, not a throw.
    {
      label: "stays silent when the configured forbidden pattern is invalid",
      command: "cypress run",
      project: { commands: { forbidden: [{ pattern: "(unterminated", action: "deny", reason: "x" }] } },
    },
  ];

  for (const c of passCases) {
    test(c.label, () => {
      eq(decide(rule, { command: c.command, project: c.project, toolName: c.toolName }), "pass");
    });
  }

  // Evasion — same forbidden verb, reached through a different shell tool
  // name rather than a different spelling of the command itself.
  test("evasion: same statement through a generic shell tool name", () => {
    eq(decide(rule, { command: "cypress run", toolName: "shell" }), "deny");
  });

  test("evasion: the notOurs trap reached through a different runner", () => {
    eq(decide(rule, { command: "npx playwright test --config cypress/e2e/playwright.config.ts" }), "deny");
  });

  test("clamps to ask under an override", () => {
    eq(
      decide(rule, {
        command: "cypress run",
        overrideSpec: { "forbidden-commands": { action: "ask" } },
      }),
      "ask",
    );
  });

  test("an ask-configured entry asks instead of denying", () => {
    const project = {
      commands: {
        forbidden: [{ pattern: "\\bnpm\\s+publish\\b", action: "ask", reason: "publishing needs a second pair of eyes" }],
      },
    };
    eq(decide(rule, { command: "npm publish", project }), "ask");
  });

  test("an off-configured entry stays silent", () => {
    const project = {
      commands: {
        forbidden: [{ pattern: "\\bnpm\\s+publish\\b", action: "off", reason: "not enforced here" }],
      },
    };
    eq(decide(rule, { command: "npm publish", project }), "pass");
  });

  test("reports the owning glob in the notOurs reason and its fix", () => {
    const result = decision(rule, { command: "npx vitest run cypress/e2e/smoke.cy.ts" });
    ok(result && result.reason.includes("cypress/**"), "reason should name the owning glob");
    ok(result && typeof result.fix === "string" && result.fix.length > 0, "should carry a fix");
  });

  test("reports the configured reason for a declared forbidden entry", () => {
    const result = decision(rule, { command: "cypress run" });
    eq(result.reason, "owned by the QA team");
    eq(result.ruleId, "forbidden-commands");
  });
});
