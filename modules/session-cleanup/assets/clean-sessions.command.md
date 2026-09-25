---
description: Prune saved session transcripts. Dry run first, then delete once the developer agrees. Project memory is never touched.
argument-hint: "[--all] [--apply]"
allowed-tools: Bash(node:*)
---

Prune this machine's saved session transcripts.

```
node "$HOME/.claude/softela-ai/hooks/clean-sessions.js" $ARGUMENTS
```

## What the two arguments mean

- **no arguments** — sweeps the sessions of the project you are in.
  Guard-activity logs are never touched by a plain run.
- **`--all`** — every session on this machine except the live one, plus every
  guard-activity log on the host except today's, which is always kept.
- **`--apply`** — delete instead of reporting.

There are no other arguments. Do not invent one, and do not pass a flag the
developer did not ask for.

## How to run it

1. **Run it first without `--apply`**, whatever the developer asked for. That
   prints what would go and how much space it frees, and deletes nothing.
2. **Report the real numbers it printed** — how many sessions, how old, how
   much space. A dry run is not a cleanup and must never be reported as one.
3. **Ask the developer whether to go ahead.**
4. **If they agree, run it again yourself with `--apply` added.** They should
   not have to type the command a second time.

If the developer already passed `--apply`, they have decided: run it once,
directly, and report what was freed.

## Two things this tool will not do

- **The live session is never deleted.** Not with `--all`, not with
  `--apply`, not on request. There is no flag for it.
- **Nothing under a directory named `memory` is ever touched.** That is
  project memory, not session data, and the exclusion is enforced inside the
  script — at discovery and again at the point of deletion — precisely so
  that no instruction, however worded, can reach it.

Never build a deletion of your own as a substitute or a follow-up, however
the request is phrased. This command is the only route.
