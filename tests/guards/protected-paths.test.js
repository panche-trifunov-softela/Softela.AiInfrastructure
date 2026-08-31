"use strict";

const path = require("path");
const { suite } = require("../harness");
const { PROJECT_MINIMAL, decide } = require("./_ctx");
const { readJson } = require("../../core/lib/fs-safe");
const rule = require("../../core/guards/protected-paths");

const CUSTOM_PROTECTED = {
  protectedPaths: [
    { path: "src/pages/Home.tsx", action: "ask", reason: "may hold local debug logging" },
    { path: "secrets/config.json", action: "deny", reason: "contains real credentials" },
  ],
};

/** A protected-path entry using a glob rather than a literal file. */
const GLOB_PROTECTED = {
  protectedPaths: [{ path: "projects/**.json", action: "ask", reason: "a checked-out project config" }],
};

/** The real, shipped `Softela.AiInfrastructure.json` — D-C's own fixture. */
const REAL_INFRA_PROJECT = readJson(
  path.join(__dirname, "..", "..", "projects", "Softela.AiInfrastructure.json"),
);

suite("guards/protected-paths", ({ test, eq }) => {
  const cases = [
    // --- positive: a direct write, every file-tool spelling
    { label: "Write to a protected path asks", toolName: "Write", filePath: "/repo/src/pages/Home.tsx", want: "ask" },
    { label: "Edit on a protected path asks", toolName: "Edit", filePath: "/repo/src/pages/Home.tsx", want: "ask" },
    {
      label: "a protected entry configured to deny does so",
      toolName: "Write",
      filePath: "/repo/secrets/config.json",
      project: CUSTOM_PROTECTED,
      want: "deny",
    },

    // --- positive: blanket staging, every shape
    { label: "git add -A asks", command: "git add -A", want: "ask" },
    { label: "git add --all asks", command: "git add --all", want: "ask" },
    { label: "git add . asks", command: "git add .", want: "ask" },
    { label: "git add ./ asks", command: "git add ./", want: "ask" },
    { label: "git add ./. asks", command: "git add ./.", want: "ask" },
    { label: 'git add "." asks, a quoted dot is the same pathspec', command: 'git add "."', want: "ask" },
    { label: "git add '.' asks, single-quoted", command: "git add '.'", want: "ask" },

    // --- negative: ordinary daily writes and stages
    { label: "writing an unrelated file passes", toolName: "Write", filePath: "/repo/src/components/Button.tsx", want: "pass" },
    {
      label: "git add ./src is not the literal blanket-add pathspec, but it is still a directory ancestor of src/pages/Home.tsx, so it asks (GAP 2)",
      command: "git add ./src",
      want: "ask",
    },
    {
      label: "a write to another package's own Home.tsx, outside the protected root, passes",
      toolName: "Write",
      filePath: "/repo/packages/app-b/src/pages/Home.tsx",
      git: { repoRoot: "/repo" },
      want: "pass",
    },
    {
      label: "a commit message merely quoting git add \".\" in prose is not a blanket add",
      command: 'git commit -m "run git add \\".\\" before committing"',
      want: "pass",
    },
    { label: "staging one explicit file passes", command: "git add src/components/Button.tsx", want: "pass" },
    { label: "staging a dotfile is not a blanket add", command: "git add .env", want: "pass" },
    { label: "an unrelated shell command passes", command: "git status", want: "pass" },
    { label: "a Write with no file path passes", toolName: "Write", filePath: "", want: "pass" },
    {
      label: "a read-only tool is not in scope for either route",
      toolName: "Read",
      filePath: "/repo/src/pages/Home.tsx",
      want: "pass",
    },
    {
      label: "a blanket add stays silent when the repo declares no protected path",
      command: "git add -A",
      project: PROJECT_MINIMAL,
      want: "pass",
    },
    {
      label: "a direct write stays silent when the repo declares no protected path",
      toolName: "Write",
      filePath: "/repo/src/pages/Home.tsx",
      project: PROJECT_MINIMAL,
      want: "pass",
    },

    {
      label: "a protected-path suffix match is honored when the repo root cannot be resolved",
      toolName: "Write",
      filePath: "/unresolved/mount/src/pages/Home.tsx",
      git: { repoRoot: null },
      want: "ask",
    },

    // --- evasion
    { label: "compound statement: cd then a blanket add", command: "cd repo && git add -A", want: "ask" },
    { label: "a global git flag before add", command: "git -c core.autocrlf=true add --all", want: "ask" },
    { label: "semicolon-separated statements", command: "git status; git add .", want: "ask" },
    {
      label: "evasion: a blanket add hidden inside a sh -c nested shell",
      command: "sh -c 'git add -A'",
      want: "ask",
    },
    {
      label: "evasion: a blanket add hidden inside a PowerShell -Command nested shell",
      command: 'powershell -Command "git add --all"',
      want: "ask",
    },
    {
      label: "a nested shell staging one explicit file is not a blanket add",
      command: "bash -c 'git add src/components/Button.tsx'",
      want: "pass",
    },

    // --- evasion: a quoted, IFS-joined, backslash-continued, or ANSI-C
    //     quoted command word must not defeat the blanket-add check either
    { label: "a single-quoted git add -A still asks", command: "'git' add -A", want: "ask" },
    { label: "a double-quoted git add -A still asks", command: '"git" add -A', want: "ask" },
    { label: "an ANSI-C quoted git add -A still asks", command: "$'git' add -A", want: "ask" },
    { label: "a ${IFS}-joined git add -A still asks", command: "git${IFS}add${IFS}-A", want: "ask" },
    {
      label: "a backslash-newline continuation between git and add still asks",
      command: "git\\\nadd -A",
      want: "ask",
    },
    {
      label: "a quoted git add of one explicit file is still not a blanket add",
      command: "'git' add src/components/Button.tsx",
      want: "pass",
    },

    // --- GAP 1: `git commit -a`/`-am`/a bundled `-a…`/`--all` is exactly as
    //     blanket as `git add -A` — it stages every already-tracked modified
    //     file and commits it in the same step.
    { label: "git commit -a asks", command: "git commit -a", want: "ask" },
    { label: "git commit -am wip asks", command: "git commit -am wip", want: "ask" },
    { label: "git commit -amv wip asks, a combined short flag containing a", command: "git commit -amv wip", want: "ask" },
    { label: "git commit -avm wip asks, the letters in a different order", command: "git commit -avm wip", want: "ask" },
    { label: "git commit --all -m wip asks, the long form", command: "git commit --all -m wip", want: "ask" },

    // --- GAP 1: negatives outnumber positives on purpose — this is the shape
    //     most likely to misfire on ordinary daily commits.
    { label: "git commit -m wip passes, no -a at all", command: "git commit -m wip", want: "pass" },
    { label: "git commit --amend passes on its own", command: "git commit --amend", want: "pass" },
    {
      label: "git commit --amend -m wip passes, --amend never reads as a bundled -a flag",
      command: "git commit --amend -m wip",
      want: "pass",
    },
    {
      label: "a commit message merely mentioning -am in prose is not a blanket commit",
      command: "git commit -m \"remember to use git commit -am next time\"",
      want: "pass",
    },
    { label: "git commit with no flags at all passes", command: "git commit", want: "pass" },

    // --- GAP 2: `git add <directory>` sweeps in every protected entry nested
    //     under that directory, even though the directory itself is never
    //     named in BLANKET_TARGETS.
    {
      label: "git add projects/ asks, it covers the real projects/**.json glob entry (GAP 2)",
      command: "git add projects/",
      project: REAL_INFRA_PROJECT,
      want: "ask",
    },
    {
      label: "git add projects (no trailing slash) still asks, the same directory either way",
      command: "git add projects",
      project: REAL_INFRA_PROJECT,
      want: "ask",
    },
    {
      label: "git add docs/ asks, it covers docs/internal/CONTRACTS.md",
      command: "git add docs/",
      project: REAL_INFRA_PROJECT,
      want: "ask",
    },

    // --- GAP 2: negatives outnumber positives here too.
    {
      label: "git add docs/internal/CONTRACTS.md stays a pass, naming the protected file explicitly is deliberate",
      command: "git add docs/internal/CONTRACTS.md",
      project: REAL_INFRA_PROJECT,
      want: "pass",
    },
    {
      label: "git add src/ passes, no protected entry sits under it",
      command: "git add src/",
      project: REAL_INFRA_PROJECT,
      want: "pass",
    },
    {
      label: "git add docs-old/ passes, a same-prefix sibling directory is not an ancestor of docs/internal/CONTRACTS.md",
      command: "git add docs-old/",
      project: REAL_INFRA_PROJECT,
      want: "pass",
    },
    { label: "git status passes", command: "git status", project: REAL_INFRA_PROJECT, want: "pass" },
    { label: "an unrelated npm command passes", command: "npm test", project: REAL_INFRA_PROJECT, want: "pass" },

    // --- override clamp
    {
      label: "an ask override softens a configured deny",
      toolName: "Write",
      filePath: "/repo/secrets/config.json",
      project: CUSTOM_PROTECTED,
      want: "ask",
      overrideSpec: { "protected-paths": { action: "ask" } },
    },

    // --- glob entries (D-C: a checked-out projects/*.json is protected)
    {
      label: "a glob protected-path entry catches a matching file",
      toolName: "Write",
      filePath: "/repo/projects/Softela.SCExpert.json",
      git: { repoRoot: "/repo" },
      project: GLOB_PROTECTED,
      want: "ask",
    },
    {
      label: "a glob protected-path entry catches a nested match too",
      toolName: "Write",
      filePath: "/repo/projects/_presets/frontend.json",
      git: { repoRoot: "/repo" },
      project: GLOB_PROTECTED,
      want: "ask",
    },
    {
      label: "a glob protected-path entry does not catch an unrelated file merely sharing the extension",
      toolName: "Write",
      filePath: "/repo/docs/internal/CONTRACTS.md",
      git: { repoRoot: "/repo" },
      project: GLOB_PROTECTED,
      want: "pass",
    },
    {
      label: "a glob entry is not matched when the repository root cannot be resolved",
      toolName: "Write",
      filePath: "/unresolved/mount/projects/Softela.SCExpert.json",
      git: { repoRoot: null },
      project: GLOB_PROTECTED,
      want: "pass",
    },
  ];

  for (const c of cases) {
    test(c.label, () => {
      const got = decide(rule, {
        toolName: c.toolName,
        command: c.command,
        filePath: c.filePath,
        project: c.project,
        git: c.git,
        overrideSpec: c.overrideSpec,
      });
      eq(got, c.want, c.label);
    });
  }

  // --- D-C: the real shipped Softela.AiInfrastructure.json now protects
  //     every checked-out project config, including its own.

  test("the shipped Softela.AiInfrastructure.json protects a checked-out project config from a direct edit", () => {
    const got = decide(rule, {
      toolName: "Edit",
      filePath: "/repo/projects/Softela.AiInfrastructure.json",
      git: { repoRoot: "/repo" },
      project: REAL_INFRA_PROJECT,
    });
    eq(got, "ask");
  });

  test("the shipped Softela.AiInfrastructure.json still protects docs/internal/CONTRACTS.md directly", () => {
    const got = decide(rule, {
      toolName: "Edit",
      filePath: "/repo/docs/internal/CONTRACTS.md",
      git: { repoRoot: "/repo" },
      project: REAL_INFRA_PROJECT,
    });
    eq(got, "ask");
  });
});
