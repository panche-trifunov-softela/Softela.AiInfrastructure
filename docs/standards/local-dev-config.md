# Local development configuration

Status: Active — binding for new code, once a project turns this track on.

Machine-specific configuration never goes into a tracked file. The failure
this prevents is concrete: a developer points the app at their own machine
by editing the same config file the app ships, that edit rides along with
the next unrelated commit, and a local host ends up on a base branch as if
it were a deployed one. The fix is not a stronger comment — a comment is
exactly what was already there when this happened. It is a second file: one
that is gitignored, one per machine, that the dev server prefers when it
exists and that a build never ships.

## Two files, two jobs

| File | Git tracks it | A build ships it | The dev server prefers it |
| --- | --- | --- | --- |
| The deployed config file | Yes | Yes | Only when the per-machine file is absent |
| The per-machine config file | No (gitignored) | Never | Yes, when it exists |

The deployed file is the one every build ships and the one CI runs
against. The per-machine file exists purely to be pointed at a developer's
own environment, is never bundled into build output, and falling back to
the deployed file's defaults is as simple as deleting it.

## The three rules a developer follows

1. **A local host goes in the per-machine file, never in the tracked
   one.** The tracked file is not the place to try something out, even for
   an afternoon.
2. **The tracked file holds the deployed hosts for the app that ships.**
   Changing which app that is — which environment, which deployed target —
   is a release decision, made deliberately in a reviewed change, not a
   side effect of a developer retargeting their own machine.
3. **Trust the banner the dev server prints, not your memory of what you
   last edited.** The dev server names the config file it resolved and the
   host it is using every time it starts; that line is the source of
   truth, not which file you remember touching last.

## What enforcement exists

The `local-config-isolation` rule backs this document. It is configured
per project with the pair of files above — which one is tracked, which one
is the gitignored per-machine file — and fires in two places:

- **On a file write.** Writing to the per-machine file is always allowed —
  it is the encouraged destination. Writing a local host, or switching
  local mode on, into the tracked file is blocked, unless that exact line
  was already on disk before the write; the rule stops a value being
  *introduced*, not every edit to a file that happens to already be in
  local mode.
- **On staging or committing.** `git add` of the tracked file, a blanket
  `git add -A`/`.`, `git commit` of a change that stages it, and
  `git commit -a` are all checked against the tracked file's current
  content, so a local host cannot reach a commit even if it arrived on
  disk some other way.

A project that declares no configuration for this rule sees no effect from
it at all — the rule is silent, not a hidden default, in a repository that
has not adopted the two-file split.

## Adoption

Adoption is per project, and a project that has not adopted the split is a
normal state rather than a violation. Where a tracked config file still
carries a local-mode flag and a comment asking whoever edits it not to commit
it as on, that comment and a developer's memory are what is protecting the
file — not this rule, which stays silent until the project declares its own
`localConfig` pair.
