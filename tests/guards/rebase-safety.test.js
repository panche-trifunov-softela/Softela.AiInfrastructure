"use strict";

const { suite } = require("../harness");
const { PROJECT_MINIMAL, decide } = require("./_ctx");
const rule = require("../../core/guards/rebase-safety");

suite("guards/rebase-safety", ({ test, eq }) => {
  const cases = [
    // --- positive, while rebasing --------------------------------------
    {
      label: "abort while rebasing",
      ctx: { command: "git rebase --abort", git: { rebaseInProgress: true } },
      want: "ask",
    },
    {
      label: "skip while rebasing",
      ctx: { command: "git rebase --skip", git: { rebaseInProgress: true } },
      want: "ask",
    },
    {
      label: "reset --hard while rebasing",
      ctx: { command: "git reset --hard", git: { rebaseInProgress: true } },
      want: "ask",
    },
    {
      label: "reset --merge while rebasing",
      ctx: { command: "git reset --merge", git: { rebaseInProgress: true } },
      want: "ask",
    },
    {
      label: "checkout while rebasing",
      ctx: { command: "git checkout main", git: { rebaseInProgress: true } },
      want: "ask",
    },
    {
      label: "switch while rebasing",
      ctx: { command: "git switch feature/task_2_y", git: { rebaseInProgress: true } },
      want: "ask",
    },
    {
      label: "stash while rebasing",
      ctx: { command: "git stash", git: { rebaseInProgress: true } },
      want: "ask",
    },
    {
      label: "clean -fd while rebasing",
      ctx: { command: "git clean -fd", git: { rebaseInProgress: true } },
      want: "ask",
    },
    {
      label: "clean -x while rebasing",
      ctx: { command: "git clean -x", git: { rebaseInProgress: true } },
      want: "ask",
    },

    // --- negative: same commands while rebasing but harmless ---------------
    {
      label: "rebase --continue while rebasing",
      ctx: { command: "git rebase --continue", git: { rebaseInProgress: true } },
      want: "pass",
    },
    {
      label: "status while rebasing",
      ctx: { command: "git status", git: { rebaseInProgress: true } },
      want: "pass",
    },
    {
      label: "add a path while rebasing",
      ctx: { command: "git add src/index.ts", git: { rebaseInProgress: true } },
      want: "pass",
    },
    {
      label: "diff while rebasing",
      ctx: { command: "git diff", git: { rebaseInProgress: true } },
      want: "pass",
    },

    // --- negative: the same commands when NOT rebasing ----------------------
    {
      label: "abort when not rebasing",
      ctx: { command: "git rebase --abort", git: { rebaseInProgress: false } },
      want: "pass",
    },
    {
      label: "reset --hard when not rebasing",
      ctx: { command: "git reset --hard", git: { rebaseInProgress: false } },
      want: "pass",
    },
    {
      label: "checkout when not rebasing",
      ctx: { command: "git checkout main", git: { rebaseInProgress: false } },
      want: "pass",
    },
    {
      label: "switch when not rebasing",
      ctx: { command: "git switch feature/task_2_y", git: { rebaseInProgress: false } },
      want: "pass",
    },
    {
      label: "stash when not rebasing",
      ctx: { command: "git stash", git: { rebaseInProgress: false } },
      want: "pass",
    },
    {
      label: "clean -fd when not rebasing",
      ctx: { command: "git clean -fd", git: { rebaseInProgress: false } },
      want: "pass",
    },
    {
      label: "ordinary commit when not rebasing",
      ctx: { command: 'git commit -m "Add missing null check"', git: { rebaseInProgress: false } },
      want: "pass",
    },

    // --- evasion -------------------------------------------------------------
    {
      label: "evasion: compound statement hides an abort after a cd",
      ctx: { command: "cd sub && git rebase --abort", git: { rebaseInProgress: true } },
      want: "ask",
    },
    {
      label: "evasion: global -c flag before checkout while rebasing",
      ctx: { command: "git -c core.pager=cat checkout main", git: { rebaseInProgress: true } },
      want: "ask",
    },
    {
      label: "evasion: abort hidden inside a nested shell invocation while rebasing",
      ctx: { command: 'bash -c "git rebase --abort"', git: { rebaseInProgress: true } },
      want: "ask",
    },

    // --- negative: a nested shell running something harmless while rebasing ---
    {
      label: "a nested shell running an unrelated command while rebasing",
      ctx: { command: 'bash -c "git status"', git: { rebaseInProgress: true } },
      want: "pass",
    },

    // --- override & config absence -------------------------------------
    {
      label: "override softens the rule to off",
      ctx: {
        command: "git rebase --abort",
        git: { rebaseInProgress: true },
        overrideSpec: { "rebase-safety": { action: "off" } },
      },
      want: "pass",
    },
    {
      label: "rule fires the same regardless of project config, since it has none",
      ctx: {
        command: "git rebase --abort",
        git: { rebaseInProgress: true },
        project: PROJECT_MINIMAL,
      },
      want: "ask",
    },
  ];

  for (const c of cases) {
    test(c.label, () => {
      eq(decide(rule, c.ctx), c.want, c.label);
    });
  }
});
