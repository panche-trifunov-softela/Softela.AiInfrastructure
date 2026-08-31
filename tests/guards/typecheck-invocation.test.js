"use strict";

const { suite } = require("../harness");
const { PROJECT_MINIMAL, decide, decision } = require("./_ctx");
const rule = require("../../core/guards/typecheck-invocation");

suite("guards/typecheck-invocation", ({ test, eq, ok }) => {
  const denyCases = [
    { label: "denies a bare tsc --noEmit", command: "tsc --noEmit" },
    { label: "denies npx tsc --noEmit", command: "npx tsc --noEmit" },
    { label: "denies inside a compound statement", command: "cd frontend && npx tsc --noEmit" },
    { label: "denies through a PowerShell tool call", command: "npx tsc --noEmit", toolName: "PowerShell" },
    { label: "denies mixed case", command: "NPX TSC --NOEMIT" },
    { label: "denies as the second half of a `;` compound statement", command: "npm run lint ; npx tsc --noEmit" },

    // Positive — the same known-trap invocation wrapped in a shell's -c /
    // -Command argument, which the outer shell actually executes verbatim.
    { label: "denies npx tsc --noEmit wrapped in sh -c", command: 'sh -c "npx tsc --noEmit"' },
    { label: "denies npx tsc --noEmit wrapped in bash -c", command: "bash -c 'npx tsc --noEmit'" },
    { label: "denies npx tsc --noEmit wrapped in a PowerShell -Command argument", command: 'powershell -Command "npx tsc --noEmit"' },
  ];

  for (const c of denyCases) {
    test(c.label, () => {
      eq(decide(rule, { command: c.command, toolName: c.toolName }), "deny");
    });
  }

  const passCases = [
    // Negative — the escape hatches this whole trap exists to steer toward.
    { label: "passes npx tsc --noEmit -p tsconfig.app.json", command: "npx tsc --noEmit -p tsconfig.app.json" },
    { label: "passes npx tsc --noEmit -p tsconfig.node.json", command: "npx tsc --noEmit -p tsconfig.node.json" },
    { label: "passes npx tsc --noEmit --project tsconfig.app.json", command: "npx tsc --noEmit --project tsconfig.app.json" },
    { label: "passes npx tsc -b", command: "npx tsc -b" },

    // Negative — ordinary daily commands the pattern was never about.
    { label: "passes an unrelated git command", command: "git status" },
    { label: "passes an unrelated build command", command: "npm run build" },
    { label: "passes running the actual test suite", command: "npx vitest run" },
    { label: "passes an empty command", command: "" },
    { label: "passes the trap phrase mentioned only inside a quoted string", command: 'git commit -m "document why tsc --noEmit alone checks nothing"' },

    // Negative — silent when the project declares nothing.
    { label: "stays silent for a project that declares nothing", command: "tsc --noEmit", project: PROJECT_MINIMAL },

    // Negative — an invalid configured pattern degrades to silent, not a throw.
    {
      label: "stays silent when the configured pattern is invalid",
      command: "tsc --noEmit",
      project: { commands: { typecheck: { deny: "(unterminated", fix: "x", reason: "y" } } },
    },

    // Negative — the project declares other commands but not typecheck.
    {
      label: "stays silent when commands.typecheck itself is absent",
      command: "tsc --noEmit",
      project: { commands: { install: { deny: "\\bnpm\\s+install\\b" } } },
    },

    // Negative — a shell wrapper whose payload never trips the pattern at
    // all; unwrapping it must not, on its own, start denying ordinary work.
    { label: "passes an ordinary bash -c wrapper with no typecheck command", command: "bash -c 'echo hello'" },
    { label: "passes npx tsc --noEmit -p wrapped in sh -c", command: 'sh -c "npx tsc --noEmit -p tsconfig.app.json"' },
  ];

  for (const c of passCases) {
    test(c.label, () => {
      eq(decide(rule, { command: c.command, project: c.project }), "pass");
    });
  }

  // Evasion — a different shell tool name carrying the same forbidden shape.
  test("evasion: same statement through a generic shell tool name", () => {
    eq(decide(rule, { command: "npx tsc --noEmit", toolName: "shell" }), "deny");
  });

  test("evasion: -p appears before --noEmit rather than after", () => {
    // The configured pattern's negative lookahead scans the rest of the
    // statement, so a flag order the pattern's author did not anticipate
    // still passes — this is a property of the shipped fixture pattern, not
    // of this guard, and is worth pinning down explicitly.
    eq(decide(rule, { command: "npx tsc -p tsconfig.app.json --noEmit" }), "pass");
  });

  test("clamps to ask under an override", () => {
    eq(
      decide(rule, {
        command: "npx tsc --noEmit",
        overrideSpec: { "typecheck-invocation": { action: "ask" } },
      }),
      "ask",
    );
  });

  test("reports the configured reason and fix", () => {
    const result = decision(rule, { command: "npx tsc --noEmit" });
    eq(result.reason, "the root tsconfig is a solution file, so a bare --noEmit checks nothing");
    eq(result.fix, "npx tsc -b");
    eq(result.ruleId, "typecheck-invocation");
  });
});
