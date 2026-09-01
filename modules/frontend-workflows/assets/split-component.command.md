---
description: Decompose an oversized component in the agreed order — logic out first, then children — as a sequence of behaviour-preserving steps.
argument-hint: "<path to the file> [which part to start with]"
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

Split an oversized component, following `docs/standards/file-size.md`.

$ARGUMENTS

## The one rule that makes this safe

**Behaviour does not change.** Not a fixed bug, not a renamed prop, not a
tidied-up conditional, not an improved loading state. If you find a bug
while splitting, write it down and report it — do not fix it in the same
change. A refactor whose diff also changes behaviour cannot be reviewed,
because there is no way to tell the two apart.

## 1. Read it first, and say what it does

Read the whole file before moving a line of it. Then write down, for the
developer:

- What the component does, in sentences. If you need "and" more than twice,
  those are the seams.
- Every piece of state, and what reads it.
- Every visually independent region it renders.
- The line count, and which of the project's thresholds it is over.

**Stop here and get agreement on the plan** before editing. A split is
mechanical only once the seams are agreed; guessing at them produces more
files with the same coupling, which is worse than one big file.

## 2. Split in this order — it is not arbitrary

1. **Pull the logic out first.** State, effects, data access and event
   handlers into `use<Component>`; pure functions into `utils/`. On the
   largest files this alone removes most of the volume, and it changes
   nothing about what renders.
2. **Then extract child components**, along the seams the UI already has —
   toolbar, list, row, detail panel, dialog. Each one gets a full folder of
   its own, recursively.
3. **Then extract shared hooks**, where two of those children turn out to
   need the same behaviour.
4. **Only then consider splitting the view itself**, if it is still large.

Doing it in the other order — cutting JSX into fragments while the logic
stays tangled — produces more files with the same coupling and no gain.

## 3. Work in reviewable steps

One step at a time. After each, the app builds and behaves identically.
Do not do the whole thing in one edit and present it as a fait accompli;
say what the next step is and let the developer decide whether to continue.

Per step:

- Move the code; do not rewrite it while it is in flight.
- Update imports to the project's alias form, not a longer relative climb
  (`docs/standards/module-imports.md`).
- Add a test for each pure utility you extracted — this is the payoff, and
  the point where it is cheapest.
- Run the project's own build and test commands and report the real output.
  Check the project's documentation for the traps first: a command that
  exits 0 having checked nothing is not a passing verification, and
  reporting it as one is the worst outcome available here.

## 4. Where it stops

A file the standard genuinely exempts — a generated file, an exhaustive
mapping or declaration table, an adapter whose shape is dictated
externally — is not split by line count. Say so and leave it; that is what
the exception list is for, with the reason written down.

## 5. Report

- Before and after line counts, per file.
- Every file created, and what moved into it.
- Tests added, and the verification output you actually got.
- **Anything you noticed but did not change** — bugs, dead code, duplicated
  logic. That list is the most valuable half of this report.
