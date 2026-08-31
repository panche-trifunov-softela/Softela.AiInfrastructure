"use strict";

const { suite } = require("../harness");
const { PROJECT_MINIMAL, decide } = require("./_ctx");
const rule = require("../../core/guards/no-local-merge-to-base");

suite("guards/no-local-merge-to-base", ({ test, eq }) => {
  const cases = [
    // --- positive -----------------------------------------------------------
    {
      label: "merge while already on a base branch",
      ctx: { command: "git merge feature/task_1_x", git: { branch: "dev-ng" } },
      want: "deny",
    },
    {
      label: "checkout to base then merge in one command line",
      ctx: {
        command: "git checkout dev-ng && git merge feature/task_1_x",
        git: { branch: "feature/task_1_x" },
      },
      want: "deny",
    },
    {
      label: "force-push to a base branch belongs to the same failure",
      ctx: { command: "git push --force origin dev-ng" },
      want: "deny",
    },
    {
      label: "force-with-lease push to a base branch",
      ctx: { command: "git push --force-with-lease origin dev-ng" },
      want: "deny",
    },
    {
      label: "switch to base then merge in one command line",
      ctx: {
        command: "git switch dev-ng && git merge feature/task_1_x",
        git: { branch: "feature/task_1_x" },
      },
      want: "deny",
    },

    // --- negative: routine daily work ---------------------------------------
    {
      label: "merge a feature branch into another feature branch",
      ctx: { command: "git merge feature/task_2_y", git: { branch: "feature/task_1_x" } },
      want: "pass",
    },
    {
      label: "checking out a base branch without merging",
      ctx: { command: "git checkout dev-ng", git: { branch: "feature/task_1_x" } },
      want: "pass",
    },
    {
      label: "ordinary push of a feature branch",
      ctx: { command: "git push origin feature/task_1_x" },
      want: "pass",
    },
    {
      label: "force-with-lease on the developer's own feature branch",
      ctx: { command: "git push --force-with-lease origin feature/task_1_x" },
      want: "pass",
    },
    {
      label: "force-push of the developer's own feature branch via the '+' refspec shorthand",
      ctx: { command: "git push --force origin +feature/task_1_x" },
      want: "pass",
    },
    {
      label: "rebase onto the base is a different verb entirely",
      ctx: { command: "git rebase dev-ng", git: { branch: "feature/task_1_x" } },
      want: "pass",
    },
    {
      label: "checkout a feature branch then merge another feature branch",
      ctx: {
        command: "git checkout feature/task_1_x && git merge feature/task_2_y",
        git: { branch: "dev-ng" },
      },
      want: "pass",
    },
    {
      label: "log mentioning merge and a base branch name in prose",
      ctx: { command: 'git log --grep="merge dev-ng"', git: { branch: "feature/task_1_x" } },
      want: "pass",
    },

    // --- evasion --------------------------------------------------------------
    {
      label: "evasion: switch to base then merge via a different verb spelling",
      ctx: {
        command: "git switch dev-ng ; git merge feature/task_1_x",
        git: { branch: "feature/task_1_x" },
      },
      want: "deny",
    },
    {
      label: "evasion: global -c flag before merge on a base branch",
      ctx: { command: "git -c core.pager=cat merge feature/task_1_x", git: { branch: "dev-ng" } },
      want: "deny",
    },
    {
      label: "evasion: force-push to base via the '+' refspec shorthand, no --force flag needed to reach it",
      ctx: { command: "git push --force origin +dev-ng" },
      want: "deny",
    },
    {
      label: "evasion: merge hidden inside a nested shell invocation",
      ctx: { command: "sh -c 'git merge feature/x'", git: { branch: "dev-ng" } },
      want: "deny",
    },
    {
      label: "evasion: checkout to base hidden inside a nested shell, merge follows on the outer line",
      ctx: {
        command: "bash -c \"git checkout dev-ng\" && git merge feature/task_1_x",
        git: { branch: "feature/task_1_x" },
      },
      want: "deny",
    },
    {
      label: "evasion: a quoted git word still switches to base before merging",
      ctx: {
        command: "'git' checkout dev-ng && git merge feature/task_1_x",
        git: { branch: "feature/task_1_x" },
      },
      want: "deny",
    },

    // --- negative: quoted text that merely resembles a switch or a nested shell ---
    {
      label: "a switch-to-base phrase inside a commit message is not an actual switch",
      ctx: {
        command:
          'git commit -m "please git checkout dev-ng first" && git merge feature/task_2_y',
        git: { branch: "feature/task_1_x" },
      },
      want: "pass",
    },
    {
      label: "'git' as a bare substring of another word is not a command start",
      ctx: {
        command: "somefunc_digit checkout dev-ng ; git merge feature/task_2_y",
        git: { branch: "feature/task_1_x" },
      },
      want: "pass",
    },
    {
      label: "a nested shell running an unrelated command is not a merge",
      ctx: { command: 'bash -c "npm test"', git: { branch: "dev-ng" } },
      want: "pass",
    },
    {
      label: "a checkout-to-base phrase quoted elsewhere does not mask a real switch later on the line",
      ctx: {
        command: "git commit -m 'checkout dev-ng' && git checkout dev-ng && git merge feature/x",
        git: { branch: "feature/task_1_x" },
      },
      want: "deny",
    },

    // --- override & config absence -------------------------------------
    {
      label: "override softens the rule to ask",
      ctx: {
        command: "git merge feature/task_1_x",
        git: { branch: "dev-ng" },
        overrideSpec: { "no-local-merge-to-base": { action: "ask" } },
      },
      want: "ask",
    },
    {
      label: "silent when the project declares no base branches",
      ctx: {
        command: "git merge feature/task_1_x",
        git: { branch: "dev-ng" },
        project: PROJECT_MINIMAL,
      },
      want: "pass",
    },
  ];

  for (const c of cases) {
    test(c.label, () => {
      eq(decide(rule, c.ctx), c.want, c.label);
    });
  }
});
