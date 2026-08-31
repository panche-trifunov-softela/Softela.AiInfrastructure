"use strict";

const { suite } = require("../harness");
const { PROJECT_MINIMAL, decide, decision } = require("./_ctx");
const rule = require("../../core/guards/package-install-flags");

suite("guards/package-install-flags", ({ test, eq, ok }) => {
  const denyCases = [
    { label: "denies a bare npm install", command: "npm install" },
    { label: "denies the short npm i alias", command: "npm i" },
    { label: "denies npm add", command: "npm add lodash" },
    { label: "denies inside a compound statement", command: "cd apps/web && npm install" },
    { label: "denies through a PowerShell tool call", command: "npm install", toolName: "PowerShell" },
    { label: "denies mixed case", command: "NPM INSTALL" },
    { label: "denies as the second half of a `;` compound statement", command: "npm run lint ; npm install" },

    // Positive — the same bare install wrapped in a shell's -c / -Command
    // argument, which the outer shell actually executes verbatim.
    { label: "denies npm install wrapped in sh -c", command: 'sh -c "npm install"' },
    { label: "denies npm install wrapped in bash -c", command: "bash -c 'npm install'" },
    { label: "denies npm install wrapped in a PowerShell -Command argument", command: 'powershell -Command "npm install"' },
    { label: "denies npm install wrapped in cmd /c", command: 'cmd /c "npm install"' },
  ];

  for (const c of denyCases) {
    test(c.label, () => {
      eq(decide(rule, { command: c.command, toolName: c.toolName }), "deny");
    });
  }

  const passCases = [
    // Negative — the required flag is present, exactly the escape hatch.
    { label: "passes npm i --force", command: "npm i --force" },
    { label: "passes npm install --legacy-peer-deps", command: "npm install --legacy-peer-deps" },
    { label: "passes npm add with --force", command: "npm add lodash --force" },

    // Negative — ordinary daily commands the pattern was never about.
    { label: "passes an unrelated git command", command: "git status" },
    { label: "passes npm run build", command: "npm run build" },
    { label: "passes npm test", command: "npm test" },
    { label: "passes yarn install (a different pattern, not this one)", command: "yarn install" },
    { label: "passes an empty command", command: "" },
    { label: "passes npm install mentioned only inside a quoted string", command: 'git commit -m "document npm install --force requirement"' },

    // Negative — silent when the project declares nothing.
    { label: "stays silent for a project that declares nothing", command: "npm install", project: PROJECT_MINIMAL },

    // Negative — an invalid configured pattern degrades to silent, not a throw.
    {
      label: "stays silent when the configured pattern is invalid",
      command: "npm install",
      project: { commands: { install: { deny: "(unterminated", fix: "x", reason: "y" } } },
    },

    // Negative — the project declares other commands but not install.
    {
      label: "stays silent when commands.install itself is absent",
      command: "npm install",
      project: { commands: { typecheck: { deny: "\\btsc\\b" } } },
    },

    // Negative — a shell wrapper whose payload never trips the pattern at
    // all; unwrapping it must not, on its own, start denying ordinary work.
    { label: "passes an ordinary bash -c wrapper with no install command", command: "bash -c 'echo hello'" },
    { label: "passes npm install --force wrapped in sh -c", command: 'sh -c "npm install --force"' },

    // Negative — a wrapper word appearing mid-statement, in the second half
    // of a compound line, is not a real invocation: the quoted text it
    // precedes must stay masked, not re-emitted as its own statement.
    {
      label: "passes a quoted npm install mentioned after eval mid-statement",
      command: 'git commit -m subject && echo eval "npm install"',
    },
  ];

  for (const c of passCases) {
    test(c.label, () => {
      eq(decide(rule, { command: c.command, project: c.project }), "pass");
    });
  }

  // Evasion — a different shell tool name carrying the same forbidden shape.
  test("evasion: same statement through a generic shell tool name", () => {
    eq(decide(rule, { command: "npm install", toolName: "shell" }), "deny");
  });

  test("evasion: npx-prefixed invocation still trips the pattern", () => {
    eq(decide(rule, { command: "npx npm install" }), "deny");
  });

  test("clamps to ask under an override", () => {
    eq(
      decide(rule, {
        command: "npm install",
        overrideSpec: { "package-install-flags": { action: "ask" } },
      }),
      "ask",
    );
  });

  test("reports the configured reason and fix", () => {
    const result = decision(rule, { command: "npm install" });
    eq(result.reason, "peer conflicts break the install otherwise");
    eq(result.fix, "npm i --force");
    eq(result.ruleId, "package-install-flags");
  });

  test("an allow override for this exact command drops the decision", () => {
    eq(
      decide(rule, {
        command: "npm install",
        overrideSpec: { "package-install-flags": { allow: ["\\bnpm\\s+install\\b"] } },
      }),
      "pass",
    );
    ok(true);
  });
});
