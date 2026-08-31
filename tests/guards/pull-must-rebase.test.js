"use strict";

const { suite } = require("../harness");
const { PROJECT_MINIMAL, decide } = require("./_ctx");
const rule = require("../../core/guards/pull-must-rebase");

suite("guards/pull-must-rebase", ({ test, eq }) => {
  const cases = [
    // --- positive -------------------------------------------------------
    {
      label: "bare pull with no flags at all",
      ctx: { command: "git pull" },
      want: "deny",
    },
    {
      label: "pull with a remote and branch but no --rebase",
      ctx: { command: "git pull origin dev-ng" },
      want: "deny",
    },
    {
      label: "pull with --no-rebase explicit opt-out",
      ctx: { command: "git pull --no-rebase" },
      want: "deny",
    },

    // --- negative: routine daily work ------------------------------------
    {
      label: "pull with --rebase and a remote",
      ctx: { command: "git pull --rebase origin dev-ng" },
      want: "pass",
    },
    {
      label: "pull with the short -r rebase flag",
      ctx: { command: "git pull -r origin dev-ng" },
      want: "pass",
    },
    {
      label: "pull with the explicit --rebase=true mode",
      ctx: { command: "git pull --rebase=true origin dev-ng" },
      want: "pass",
    },
    {
      label: "pull with the --rebase=merges mode",
      ctx: { command: "git pull --rebase=merges origin dev-ng" },
      want: "pass",
    },
    {
      label: "fetch is not a pull",
      ctx: { command: "git fetch origin" },
      want: "pass",
    },
    {
      label: "status command entirely unrelated",
      ctx: { command: "git status" },
      want: "pass",
    },
    {
      label: "log mentioning pull in a pipeline argument",
      ctx: { command: "git log --oneline | grep pull" },
      want: "pass",
    },
    {
      label: "commit message that merely mentions pulling",
      ctx: { command: 'git commit -m "note: remember to pull before starting"' },
      want: "pass",
    },
    {
      label: "npm pull-like script name is not git pull",
      ctx: { command: "npm run pull-assets" },
      want: "pass",
    },

    // --- evasion -----------------------------------------------------------
    {
      label: "evasion: compound statement hides a bare pull after cd",
      ctx: { command: "cd sub && git pull" },
      want: "deny",
    },
    {
      label: "evasion: global -c flag before pull with no rebase",
      ctx: { command: "git -c color.ui=always pull origin dev-ng" },
      want: "deny",
    },
    {
      label: "evasion: --rebase=false is equivalent to not rebasing",
      ctx: { command: "git pull --rebase=false origin dev-ng" },
      want: "deny",
    },
    {
      label: "evasion: a bare pull hidden inside a nested shell invocation",
      ctx: { command: 'powershell -Command "git pull"' },
      want: "deny",
    },

    // --- negative: nested shells on ordinary work ---------------------------
    {
      label: "a nested shell running an unrelated command is not a pull",
      ctx: { command: 'powershell -Command "git status"' },
      want: "pass",
    },

    // --- override & config absence -------------------------------------
    {
      label: "override softens the rule to ask",
      ctx: { command: "git pull", overrideSpec: { "pull-must-rebase": { action: "ask" } } },
      want: "ask",
    },
    {
      label: "still evaluates on the command line alone when the project declares nothing",
      ctx: { command: "git pull", project: PROJECT_MINIMAL },
      want: "deny",
    },
  ];

  for (const c of cases) {
    test(c.label, () => {
      eq(decide(rule, c.ctx), c.want, c.label);
    });
  }
});
