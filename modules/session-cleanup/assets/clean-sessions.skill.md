---
name: "clean-sessions"
description: "Prune saved session transcripts to free disk space. Runs a dry run first, reports what would go, and deletes only once the developer agrees. Use when the developer asks to clean up sessions, prune transcripts, or reclaim the space old sessions are using. Never use it for anything under a directory named memory: that is project memory, not session data, and it is never a target."
---

# Session cleanup

Saved session transcripts accumulate quickly and are rarely worth keeping.
This skill prunes them.

```
node "$HOME/.codex/softela-ai/hooks/clean-sessions.js"
```

## What the two arguments mean

- **no arguments** — sweeps today's sessions. Codex files its transcripts by
  date rather than by project, so today is the equivalent of "the ones you
  are working with".
- **`--all`** — every session on this machine except the live one.
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
the request is phrased. This skill is the only route.
