"use strict";

const { suite } = require("../harness");
const { PROJECT_MINIMAL, decide } = require("./_ctx");
const rule = require("../../core/guards/no-push-to-base");

suite("guards/no-push-to-base", ({ test, eq }) => {
  const cases = [
    // --- positive: direct push to a base branch -------------------------
    {
      label: "push to base branch by name",
      ctx: { command: "git push origin dev-ng" },
      want: "deny",
    },
    {
      label: "force-push to a release branch",
      ctx: { command: "git push --force origin releases/26.2" },
      want: "deny",
    },
    {
      label: "bare push while checked out on a base branch",
      ctx: { command: "git push", git: { branch: "dev-ng" } },
      want: "deny",
    },
    {
      label: "git with a global -c flag pushing to a base branch",
      ctx: { command: "git -c http.sslVerify=false push origin dev-ng" },
      want: "deny",
    },
    {
      label: "dry-run push to a base branch still denies",
      ctx: { command: "git push --dry-run origin dev-ng" },
      want: "deny",
    },
    {
      label: "push origin with no refspec while on a base branch",
      ctx: { command: "git push origin", git: { branch: "dev-ng" } },
      want: "deny",
    },
    {
      label: "bare push on a feature branch tracking a base branch as upstream",
      ctx: {
        command: "git push",
        git: { branch: "feature/task_1_x", upstreamBranch: "dev-ng" },
      },
      want: "deny",
    },
    {
      label: "push origin with no refspec on a feature branch tracking a base branch as upstream",
      ctx: {
        command: "git push origin",
        git: { branch: "feature/task_1_x", upstreamBranch: "dev-ng" },
      },
      want: "deny",
    },

    // --- negative: routine feature-branch work ----------------------------
    {
      label: "push a feature branch by name",
      ctx: { command: "git push origin feature/task_1_x" },
      want: "pass",
    },
    {
      label: "push HEAD upstream while on a feature branch",
      ctx: { command: "git push -u origin HEAD", git: { branch: "feature/task_1_x" } },
      want: "pass",
    },
    {
      label: "force-with-lease on the developer's own feature branch",
      ctx: { command: "git push --force-with-lease origin feature/task_1_x" },
      want: "pass",
    },
    {
      label: "bare push while on a feature branch",
      ctx: { command: "git push", git: { branch: "feature/task_1_x" } },
      want: "pass",
    },
    {
      label: "bare push on a feature branch tracking another feature branch as upstream",
      ctx: {
        command: "git push",
        git: { branch: "feature/task_1_x", upstreamBranch: "feature/task_2_other" },
      },
      want: "pass",
    },
    {
      label: "bare push on a feature branch with no upstream configured at all",
      ctx: {
        command: "git push",
        git: { branch: "feature/task_1_x", upstreamBranch: null },
      },
      want: "pass",
    },
    {
      label: "fetch is not a push",
      ctx: { command: "git fetch origin" },
      want: "pass",
    },
    {
      label: "log piped through grep for the word push",
      ctx: { command: "git log --oneline | grep push" },
      want: "pass",
    },
    {
      label: "commit message that merely mentions pushing",
      ctx: { command: 'git commit -m "document how to push safely"' },
      want: "pass",
    },
    {
      label: "push a branch whose name only resembles a base branch",
      ctx: { command: "git push origin dev-ng-spike" },
      want: "pass",
    },
    {
      label: "status on a base branch is not a push",
      ctx: { command: "git status", git: { branch: "dev-ng" } },
      want: "pass",
    },

    // --- evasion ------------------------------------------------------------
    {
      label: "evasion: cd into a subdirectory before pushing to base",
      ctx: { command: "cd sub && git push origin dev-ng" },
      want: "deny",
    },
    {
      label: "evasion: refspec form hides the base branch after the colon",
      ctx: { command: "git push origin HEAD:dev-ng" },
      want: "deny",
    },
    {
      label: "evasion: '+' refspec shorthand for a per-ref force-push to base, no --force flag present",
      ctx: { command: "git push origin +dev-ng" },
      want: "deny",
    },
    {
      label: "evasion: '+' refspec shorthand for a per-ref force-push to a release branch",
      ctx: { command: "git push origin +releases/26.2" },
      want: "deny",
    },
    {
      label: "evasion: push to base hidden inside a nested shell invocation",
      ctx: { command: 'bash -c "git push origin dev-ng"' },
      want: "deny",
    },
    {
      label: "evasion: sh -c with single quotes still opens its own statement",
      ctx: { command: "sh -c 'git push origin dev-ng'" },
      want: "deny",
    },
    {
      label: "evasion: powershell -Command still opens its own statement",
      ctx: { command: 'powershell -Command "git push origin dev-ng"' },
      want: "deny",
    },
    {
      label: "evasion: cmd /c still opens its own statement",
      ctx: { command: 'cmd /c "git push origin dev-ng"' },
      want: "deny",
    },
    {
      label: "evasion: cmd /c as the second half of a compound line still opens its own statement",
      ctx: { command: 'ls && cmd /c "git push origin dev-ng"' },
      want: "deny",
    },

    // --- negative: the '+' shorthand and nested shells on ordinary work -------
    {
      label: "'+' refspec force-push of the developer's own feature branch",
      ctx: { command: "git push origin +feature/task_1_x" },
      want: "pass",
    },
    {
      label: "a nested shell running an unrelated command is not a push",
      ctx: { command: 'bash -c "npm test"' },
      want: "pass",
    },

    // --- negative: a wrapper word appearing mid-statement is not a wrapper ----
    {
      label: "a quoted push mentioned after eval mid-statement is not a real invocation",
      ctx: { command: 'echo do not eval "git push origin dev-ng"' },
      want: "pass",
    },
    {
      label: "a quoted push mentioned after bash -c mid-statement is not a real invocation",
      ctx: { command: 'echo never run bash -c "git push origin dev-ng"' },
      want: "pass",
    },
    {
      label: "a quoted push mentioned after a non-leading eval token is not a real invocation",
      ctx: { command: 'printf %s eval "git push origin dev-ng"' },
      want: "pass",
    },
    {
      label: "a quoted push mentioned after eval inside a parenthesised expression is not a real invocation",
      ctx: { command: 'node -e console.log( eval "git push origin dev-ng" )' },
      want: "pass",
    },

    // --- negative: a heredoc body merely mentioning a push is data, not a command
    {
      label: "a heredoc body that merely mentions a push is inert data",
      ctx: { command: "cat <<EOF\nrun: git push origin dev-ng\nEOF" },
      want: "pass",
    },

    // --- size bound: the guard path still runs cleanly on an oversized command
    {
      label: "a direct push still denies when the command exceeds the nested-shell size threshold",
      ctx: { command: `echo "${"a".repeat(300 * 1024)}"; git push origin dev-ng` },
      want: "deny",
    },

    // --- override & config absence -------------------------------------
    {
      label: "override softens the rule to ask",
      ctx: {
        command: "git push origin dev-ng",
        overrideSpec: { "no-push-to-base": { action: "ask" } },
      },
      want: "ask",
    },
    {
      label: "silent when the project declares no base branches",
      ctx: { command: "git push origin dev-ng", project: PROJECT_MINIMAL },
      want: "pass",
    },
  ];

  for (const c of cases) {
    test(c.label, () => {
      eq(decide(rule, c.ctx), c.want, c.label);
    });
  }
});
