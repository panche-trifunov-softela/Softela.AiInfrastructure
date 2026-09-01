"use strict";

const { suite } = require("../harness");
const { PROJECT_MINIMAL, decide } = require("./_ctx");
const rule = require("../../core/guards/local-config-isolation");

/** A tracked file offending with a bare literal host string. */
const OFFENDING_CONTENT = 'export const API_HOST = "http://localhost:5000";\n';

/** A tracked file pointing at a genuinely deployed host. */
const DEPLOYED_CONTENT = 'export const API_HOST = "https://config.example.invalid";\n';

/** The default entry: no `action`, so it falls back to `"deny"`. */
const LOCAL_CONFIG_PROJECT = {
  localConfig: [{ tracked: "public/config.js", perMachine: "public/config.development.js" }],
};

/** Same pair of files, explicitly set to `"ask"`. */
const ASK_ENTRY = {
  localConfig: [
    { tracked: "public/config.js", perMachine: "public/config.development.js", action: "ask" },
  ],
};

/** Same pair of files, explicitly set to `"deny"`. */
const DENY_ENTRY = {
  localConfig: [
    { tracked: "public/config.js", perMachine: "public/config.development.js", action: "deny" },
  ],
};

/** Same pair of files, switched off — the entry must stay silent. */
const OFF_ENTRY = {
  localConfig: [
    { tracked: "public/config.js", perMachine: "public/config.development.js", action: "off" },
  ],
};

/** An entry that tolerates one named line while local mode is off. */
const WITH_ALLOWED_LINES = {
  localConfig: [
    {
      tracked: "public/config.js",
      perMachine: "public/config.development.js",
      allowedLines: ["LOCAL_HOST_CONST"],
    },
  ],
};

/** An entry whose local mode is toggled by a flag, not a host string. */
const WITH_SWITCHES = {
  localConfig: [
    {
      tracked: "public/config.js",
      perMachine: "public/config.development.js",
      switches: ["USE_LOCAL\\s*=\\s*true"],
    },
  ],
};

/**
 * The tracked-config shape this rule was built for: a named
 * local-host constant that `allowedLines` deliberately tolerates, next to a
 * boolean flag that is the actual local/deployed switch.
 */
const REACT_SCEXPERT_ENTRY = {
  localConfig: [
    {
      tracked: "src/config/env.ts",
      perMachine: "src/config/env.local.ts",
      allowedLines: ["^\\s*const\\s+LOCAL_[A-Z_]+_ORIGIN\\s*="],
      switches: ["\\bUSE_LOCAL_API\\s*=\\s*true\\b"],
    },
  ],
};

/** The tolerated constant present, but the switch left at its deployed value. */
const REACT_SCEXPERT_CLEAN_CONTENT = [
  'const LOCAL_BFF_ORIGIN = "https://localhost:7240";',
  "const USE_LOCAL_API = false;",
  "",
].join("\n");

/** The same file with the switch flipped to local mode. */
const REACT_SCEXPERT_OFFENDING_CONTENT = [
  'const LOCAL_BFF_ORIGIN = "https://localhost:7240";',
  "const USE_LOCAL_API = true;",
  "",
].join("\n");

suite("guards/local-config-isolation", ({ test, eq }) => {
  const cases = [
    // ============================================================
    // Route A — a Write/Edit introduces the value into the tracked file.
    // Untouched by the Route B rewrite; kept exactly as before.
    // ============================================================

    // --- positive
    {
      label: "Write introducing a local host into the tracked file denies (default action)",
      toolName: "Write",
      filePath: "/repo/public/config.js",
      content: OFFENDING_CONTENT,
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: "/repo" },
      want: "deny",
    },
    {
      label: "Edit introducing a local host into the tracked file denies",
      toolName: "Edit",
      filePath: "/repo/public/config.js",
      content: OFFENDING_CONTENT,
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: "/repo" },
      want: "deny",
    },
    {
      label: "a configured switches pattern fires with no host string at all",
      toolName: "Write",
      filePath: "/repo/public/config.js",
      content: "export const USE_LOCAL = true;\n",
      project: WITH_SWITCHES,
      git: { repoRoot: "/repo" },
      want: "deny",
    },
    {
      label: "an entry configured to ask produces ask",
      toolName: "Write",
      filePath: "/repo/public/config.js",
      content: 'export const API_HOST = "http://127.0.0.1:5000";\n',
      project: ASK_ENTRY,
      git: { repoRoot: "/repo" },
      want: "ask",
    },
    {
      label: "an entry configured to deny produces deny",
      toolName: "Write",
      filePath: "/repo/public/config.js",
      content: OFFENDING_CONTENT,
      project: DENY_ENTRY,
      git: { repoRoot: "/repo" },
      want: "deny",
    },
    {
      label: "the bracketed IPv6 loopback form is caught",
      toolName: "Write",
      filePath: "/repo/public/config.js",
      content: 'export const API_HOST = "https://[::1]:7237";\n',
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: "/repo" },
      want: "deny",
    },

    // --- negative
    {
      label: "a repository with no localConfig entry stays silent",
      toolName: "Write",
      filePath: "/repo/public/config.js",
      content: OFFENDING_CONTENT,
      project: PROJECT_MINIMAL,
      git: { repoRoot: "/repo" },
      want: "pass",
    },
    {
      label: "an entry set to off stays silent on an otherwise offending write",
      toolName: "Write",
      filePath: "/repo/public/config.js",
      content: OFFENDING_CONTENT,
      project: OFF_ENTRY,
      git: { repoRoot: "/repo" },
      want: "pass",
    },
    {
      label: "writing a local host into the per-machine file itself is always fine",
      toolName: "Write",
      filePath: "/repo/public/config.development.js",
      content: OFFENDING_CONTENT,
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: "/repo" },
      want: "pass",
    },
    {
      label: "a local host written into an unrelated file passes",
      toolName: "Write",
      filePath: "/repo/src/components/Button.tsx",
      content: OFFENDING_CONTENT,
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: "/repo" },
      want: "pass",
    },
    {
      label: "a line matching allowedLines does not fire",
      toolName: "Write",
      filePath: "/repo/public/config.js",
      content: 'export const LOCAL_HOST_CONST = "http://localhost:5000";\n',
      project: WITH_ALLOWED_LINES,
      git: { repoRoot: "/repo" },
      want: "pass",
    },
    {
      label: "an offending line already present on disk does not fire again",
      toolName: "Write",
      filePath: "/repo/public/config.js",
      content: OFFENDING_CONTENT,
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: "/repo" },
      want: "pass",
    },
    {
      label: "a Read of the tracked file passes, it is in scope for neither route",
      toolName: "Read",
      filePath: "/repo/public/config.js",
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: "/repo" },
      want: "pass",
    },
    {
      label: "a Write with an empty file path passes",
      toolName: "Write",
      filePath: "",
      content: OFFENDING_CONTENT,
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: "/repo" },
      want: "pass",
    },
    {
      label: "an ordinary sentence merely resembling a marker is not mangled into a false positive",
      toolName: "Write",
      filePath: "/repo/public/config.js",
      content: "// Point this at your local host machine, never the shared server.\n",
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: "/repo" },
      want: "pass",
    },

    // ============================================================
    // Route B — rebuilt on the tracked file's own on-disk content.
    // Every case below is keyed to a row of the behaviour table: the tracked
    // file's on-disk state ("offending" or "clean") is stated in each
    // label, since that is the fact the whole route now turns on.
    // ============================================================

    // --- positive: offending on disk, a commit in the line ships it

    {
      label: "[offending] git commit fires when the tracked file is already staged",
      command: 'git commit -m "wip"',
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: "/repo", staged: ["public/config.js"] },
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      want: "deny",
    },
    {
      label: "[offending] git add public/ && git commit -m wip denies — an add is present in the line",
      command: "git add public/ && git commit -m wip",
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: "/repo", staged: [] },
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      want: "deny",
    },
    {
      label: "[offending] git add . && git commit -m wip denies",
      command: "git add . && git commit -m wip",
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: "/repo", staged: [] },
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      want: "deny",
    },
    {
      label: "[offending] a parenthesised cd/add subshell ahead of a commit still denies — no cwd is ever resolved",
      command: "(cd public && git add config.js) && git commit -m wip",
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: "/repo", staged: [] },
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      want: "deny",
    },
    {
      label: "[offending] cd .. && git add x && git commit -m wip denies — an unrelated add still counts, deliberately",
      command: "cd .. && git add x && git commit -m wip",
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: "/repo", staged: [] },
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      want: "deny",
    },
    {
      label: "[offending] an unrelated git add earlier in the line still makes the commit fire — the deliberate trade-off",
      command: 'git add src/x.ts && git commit -m "x"',
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: "/repo", staged: [] },
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      want: "deny",
    },
    {
      label: "[offending] git commit -am wip denies — stages everything",
      command: "git commit -am wip",
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: "/repo", staged: [] },
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      want: "deny",
    },
    {
      label: "[offending] git commit -a -m wip denies",
      command: "git commit -a -m wip",
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: "/repo", staged: [] },
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      want: "deny",
    },
    {
      label: "[offending] git -c x=y commit -am wip still denies through a global git flag",
      command: "git -c x=y commit -am wip",
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: "/repo", staged: [] },
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      want: "deny",
    },

    // --- positive: offending on disk, no commit — a blanket add still warns

    {
      label: "[offending] a blanket git add -A with no commit asks, not denies — nothing has shipped yet",
      command: "git add -A",
      project: LOCAL_CONFIG_PROJECT,
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      want: "ask",
    },
    {
      label: "[offending] git add . with no commit asks",
      command: "git add .",
      project: LOCAL_CONFIG_PROJECT,
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      want: "ask",
    },
    {
      label: "[offending] a blanket add still asks from inside a subdirectory — the cwd is never consulted",
      command: "cd public && git add -A",
      project: LOCAL_CONFIG_PROJECT,
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      want: "ask",
    },
    {
      label: "[offending] a blanket-add ask is clamped silent when the entry itself is off",
      command: "git add -A",
      project: OFF_ENTRY,
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      want: "pass",
    },

    // --- negative: offending on disk, but the command never ships it

    {
      label: "[offending] git add public/config.js alone passes — no commit, so nothing has shipped yet",
      command: "git add public/config.js",
      project: LOCAL_CONFIG_PROJECT,
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      want: "pass",
    },
    {
      label: "[offending] git add src/x.ts alone passes",
      command: "git add src/x.ts",
      project: LOCAL_CONFIG_PROJECT,
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      want: "pass",
    },
    {
      label: "[offending] two cd hops and a non-blanket add, with no commit at all, still passes",
      command: "cd public && cd .. && git add public/config.js",
      project: LOCAL_CONFIG_PROJECT,
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      want: "pass",
    },
    {
      label: "[offending] git commit alone passes when nothing is staged, added, or -a",
      command: 'git commit -m "wip"',
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: "/repo", staged: [] },
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      want: "pass",
    },
    {
      label: "[offending] git status passes",
      command: "git status",
      project: LOCAL_CONFIG_PROJECT,
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      want: "pass",
    },
    {
      label: "[offending] git diff passes",
      command: "git diff",
      project: LOCAL_CONFIG_PROJECT,
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      want: "pass",
    },
    {
      label: "[offending] git log --oneline | grep localhost passes — the marker never reaches this rule's parsing",
      command: "git log --oneline | grep localhost",
      project: LOCAL_CONFIG_PROJECT,
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      want: "pass",
    },
    {
      label: '[offending] a commit message merely mentioning localhost in prose does not fire when nothing is staged',
      command: 'git commit -m "fix the localhost redirect bug"',
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: "/repo", staged: [] },
      files: { "/repo/public/config.js": DEPLOYED_CONTENT },
      want: "pass",
    },
    {
      label: "[offending] git commit passes when only an unrelated file is staged and nothing was added or -a",
      command: 'git commit -m "small fix"',
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: "/repo", staged: ["src/components/Button.tsx"] },
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      want: "pass",
    },

    // --- negative: the tracked file is clean on disk — every one of these
    // would have shipped it under Route A's old shell-parsing logic, and
    // every one now passes regardless, which is the property that makes
    // this rule safe to leave switched on

    {
      label: "[clean] git commit fires nothing, even with the tracked file staged",
      command: 'git commit -m "wip"',
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: "/repo", staged: ["public/config.js"] },
      files: { "/repo/public/config.js": DEPLOYED_CONTENT },
      want: "pass",
    },
    {
      label: "[clean] git add . && git commit -m wip passes",
      command: "git add . && git commit -m wip",
      project: LOCAL_CONFIG_PROJECT,
      files: { "/repo/public/config.js": DEPLOYED_CONTENT },
      want: "pass",
    },
    {
      label: "[clean] a blanket git add -A passes",
      command: "git add -A",
      project: LOCAL_CONFIG_PROJECT,
      files: { "/repo/public/config.js": DEPLOYED_CONTENT },
      want: "pass",
    },
    {
      label: "[clean] cd .. && git add public/config.js passes",
      command: "cd .. && git add public/config.js",
      project: LOCAL_CONFIG_PROJECT,
      files: { "/repo/public/config.js": DEPLOYED_CONTENT },
      want: "pass",
    },
    {
      label: "[clean] a parenthesised cd/add subshell passes",
      command: "(cd public && git add config.js)",
      project: LOCAL_CONFIG_PROJECT,
      files: { "/repo/public/config.js": DEPLOYED_CONTENT },
      want: "pass",
    },
    {
      label: "[clean] git commit -am wip passes",
      command: "git commit -am wip",
      project: LOCAL_CONFIG_PROJECT,
      files: { "/repo/public/config.js": DEPLOYED_CONTENT },
      want: "pass",
    },

    // --- negative: fail open when the tracked file cannot be read at all

    {
      label: "an unreadable tracked file passes even a command that would otherwise deny",
      command: "git commit -am wip",
      project: LOCAL_CONFIG_PROJECT,
      files: {},
      want: "pass",
    },

    // --- negative: an entry switched off stays silent on Route B too

    {
      label: "an entry set to off stays silent even on git commit -am wip",
      command: "git commit -am wip",
      project: OFF_ENTRY,
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      want: "pass",
    },

    // --- negative: a repoRoot of null never throws and never produces a
    // false positive when the tracked file cannot actually be located

    {
      label: "a repoRoot of null does not throw and passes when the tracked file cannot be located at all",
      command: "git commit -am wip",
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: null },
      files: { "/repo/public/config.js": OFFENDING_CONTENT },
      want: "pass",
    },

    // --- positive: a repoRoot of null still finds the file by its bare
    // relative path and does not throw doing so

    {
      label: "a repoRoot of null still asks on a blanket add once the tracked file resolves and offends",
      command: "git add -A",
      project: LOCAL_CONFIG_PROJECT,
      git: { repoRoot: null },
      files: { "public/config.js": OFFENDING_CONTENT },
      want: "ask",
    },

    // --- positive: switches and allowedLines still apply on the shell route

    {
      label: "[switches] a configured switches pattern counts as offending on Route B too",
      command: "git commit -am wip",
      project: WITH_SWITCHES,
      files: { "/repo/public/config.js": "export const USE_LOCAL = true;\n" },
      want: "deny",
    },
    {
      label: "[allowedLines] a line matching allowedLines is tolerated on Route B too",
      command: "git commit -am wip",
      project: WITH_ALLOWED_LINES,
      files: { "/repo/public/config.js": 'export const LOCAL_HOST_CONST = "http://localhost:5000";\n' },
      want: "pass",
    },

    // --- the tracked-config shape: a tolerated local-host
    // constant next to a boolean local/deployed switch

    {
      label: "[tracked-config shape] the tolerated LOCAL_*_ORIGIN constant with USE_LOCAL_API false is clean",
      command: "git commit -am wip",
      project: REACT_SCEXPERT_ENTRY,
      files: { "/repo/src/config/env.ts": REACT_SCEXPERT_CLEAN_CONTENT },
      want: "pass",
    },
    {
      label: "[tracked-config shape] flipping USE_LOCAL_API to true offends and denies",
      command: "git commit -am wip",
      project: REACT_SCEXPERT_ENTRY,
      files: { "/repo/src/config/env.ts": REACT_SCEXPERT_OFFENDING_CONTENT },
      want: "deny",
    },
  ];

  for (const c of cases) {
    test(c.label, () => {
      const got = decide(rule, {
        toolName: c.toolName,
        command: c.command,
        filePath: c.filePath,
        content: c.content,
        project: c.project,
        git: c.git,
        files: c.files,
      });
      eq(got, c.want, c.label);
    });
  }
});
