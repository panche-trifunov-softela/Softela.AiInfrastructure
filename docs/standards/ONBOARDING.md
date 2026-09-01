# Onboarding

Status: Index — a reading order, not a rule; see the documents it points to
for what actually binds.

Where to start, for a person joining a project that has adopted this
rulebook. Kept to one page on purpose — depth lives in the documents this
points to, not here.

## Day one

Read [`FRONTEND-ARCHITECTURE-STANDARD.md`](./assembled/FRONTEND-ARCHITECTURE-STANDARD.md)
top to bottom once. It is the generated, complete assembly of every file in
this directory, in the order the rules build on each other — reading it
straight through gives the shape of the whole thing in one sitting, which
none of the individual parts do on their own.

## Before your first pull request

Reread, specifically:

- [`component-structure.md`](./component-structure.md) and
  [`layer-boundaries.md`](./layer-boundaries.md) — the shape every new
  component follows and what each file inside it may and may not do.
- [`naming.md`](./naming.md), [`module-imports.md`](./module-imports.md) and
  [`file-size.md`](./file-size.md) — the conventions, the import rules and
  the thresholds a reviewer will actually check against.
- If the project is JavaScript rather than TypeScript:
  [`javascript-projects.md`](./javascript-projects.md), which is short and
  says what changes (little) and what does not (everything else).
- [`code-documentation.md`](./code-documentation.md) — how comments and
  doc blocks are written here; applies to the first line you write, not
  only to a finished PR.
- [`git-flow.md`](./git-flow.md) — how a branch is named, kept current and
  gets merged.
- If you are working with AI assistance: [`agent-rules.md`](./agent-rules.md).

## As reference, once you are underway

Everything else — [`state-management.md`](./state-management.md),
[`types.md`](./types.md), [`api-layer.md`](./api-layer.md),
[`local-dev-config.md`](./local-dev-config.md),
[`testing.md`](./testing.md),
[`shared-code-boundaries.md`](./shared-code-boundaries.md) and
[`migration-approach.md`](./migration-approach.md) — is written to be
looked up when the situation it covers actually comes up, not memorised in
advance. [`README.md`](./README.md) is the index if you are not sure which
document that is; [`rationale.md`](./rationale.md) is worth a read if you
want the *why* behind the whole thing rather than any one rule in it.

## What is genuinely unsettled

`docs/OPEN-DECISIONS.md`, where a project tracks it, lists what the team
has discussed and not yet agreed — styling strategy, extracting components
into a shared library, and the like. Nothing there is a rule; do not enforce
or assume a position on any of it.
