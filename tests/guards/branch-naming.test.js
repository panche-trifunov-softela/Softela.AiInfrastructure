"use strict";

const { suite } = require("../harness");
const { PROJECT_MINIMAL, decide } = require("./_ctx");
const rule = require("../../core/guards/branch-naming");

suite("guards/branch-naming", ({ test, eq }) => {
  const cases = [
    // --- positive: every branch-creating shape, with a name that misses the pattern
    { label: "git checkout -b with a bad name asks", command: 'git checkout -b badname', want: "ask" },
    { label: "git switch -c with a bad name asks", command: "git switch -c badname", want: "ask" },
    { label: "git branch <name> with a bad name asks", command: "git branch badname", want: "ask" },

    // --- negative: ordinary daily commands that must stay silent
    { label: "a name matching the pattern passes", command: "git checkout -b feature/task_1_do_the_thing", want: "pass" },
    { label: "checkout of an existing branch has no -b", command: "git checkout dev-ng", want: "pass" },
    { label: "switch onto an existing branch has no -c", command: "git switch dev-ng", want: "pass" },
    { label: "git branch with no argument lists branches", command: "git branch", want: "pass" },
    { label: "git branch -d deletes, it does not create", command: "git branch -d badname", want: "pass" },
    { label: "git branch -D force-deletes, it does not create", command: "git branch -D badname", want: "pass" },
    { label: "git branch -a lists all branches, it does not create", command: "git branch -a", want: "pass" },
    { label: "git branch -m renames, it does not create", command: "git branch -m badname", want: "pass" },
    { label: "an unrelated git verb passes", command: "git status", want: "pass" },
    { label: "pushing an existing branch passes", command: "git push origin feature/task_1_thing", want: "pass" },
    { label: "branchNaming.action off silences the rule", command: "git checkout -b badname", want: "pass", project: { branchNaming: { pattern: "^(feature|bugfix)/\\d+[_-].+$", action: "off", preferred: "feature/1_x" } } },
    {
      label: "a commit message that only mentions git branch syntax in prose passes",
      command: 'git commit -m "Add note: run git branch cleanup before merging"',
      want: "pass",
    },
    {
      label: "a commit message documenting the checkout -b convention passes",
      command: 'git commit -m "docs: explain git checkout -b <name> convention in README"',
      want: "pass",
    },

    // --- evasion
    { label: "compound statement: cd then checkout -b", command: "cd repo && git checkout -b badname", want: "ask" },
    { label: "a global git flag before checkout -b", command: "git -c user.name=x checkout -b badname", want: "ask" },
    { label: "semicolon-separated statements", command: "git status; git switch -c badname", want: "ask" },
    { label: "a short flag before checkout -b", command: "git checkout -q -b badname", want: "ask" },
    { label: "git branch -f force-creates, a real creation form", command: "git branch -f badname", want: "ask" },
    { label: "git branch --force force-creates, a real creation form", command: "git branch --force badname", want: "ask" },
    {
      label: "evasion: checkout -b with a bad name hidden inside a bash -c nested shell",
      command: 'bash -c "git checkout -b badname"',
      want: "ask",
    },
    {
      label: "evasion: switch -c with a bad name hidden inside a PowerShell -Command nested shell",
      command: 'powershell -Command "git switch -c badname"',
      want: "ask",
    },
    {
      label: "a nested shell running an unrelated command does not create a branch",
      command: 'bash -c "npm test"',
      want: "pass",
    },
    {
      label: "evasion: a quoted git word still creates a branch",
      command: "'git' checkout -b badname",
      want: "ask",
    },
    {
      label: "evasion: an IFS-joined checkout -b still creates a branch",
      command: "git${IFS}checkout${IFS}-b${IFS}badname",
      want: "ask",
    },

    // --- override clamp
    {
      label: "an off override silences an otherwise-flagged branch",
      command: "git checkout -b badname",
      want: "pass",
      overrideSpec: { "branch-naming": { action: "off" } },
    },

    // --- silent when project config is absent
    { label: "no branchNaming config at all stays silent", command: "git checkout -b badname", want: "pass", project: PROJECT_MINIMAL },
  ];

  for (const c of cases) {
    test(c.label, () => {
      const got = decide(rule, {
        command: c.command,
        project: c.project,
        overrideSpec: c.overrideSpec,
      });
      eq(got, c.want, c.label);
    });
  }
});
