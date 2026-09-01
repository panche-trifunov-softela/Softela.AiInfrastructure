# Architecture standards

Status: Index — see [Status and provenance](#status-and-provenance) below;
each document also carries its own status line.

This is the portable rulebook for how code is structured, on both stacks:
how a component or a use case is laid out on disk, where state lives, how
things are typed, tested and reused. It applies to any project this
infrastructure is installed into, not to one specific repository — there are
no real paths, store names or file names in it, only shapes
(`src/components/**`, `*.Application/**`) that any project can match against
its own root.

The directory grew up frontend-first, and most of it below still is. The
three backend documents are newer and carry their own table — see
[The backend documents](#the-backend-documents). Everything outside those
two tables ([`git-flow.md`](./git-flow.md),
[`code-documentation.md`](./code-documentation.md),
[`clean-code.md`](./clean-code.md)) applies to both stacks.

It grew out of an architecture sync where a frontend team reviewed and agreed
a draft standard. What follows is the part of that draft which is (a) true
for any project and (b) settled rather than still being argued about.
Project-specific facts — current file sizes, real folder names, a migration
backlog — belong in that project's own `docs/projects/<name>/` folder, never
here. See [`ONBOARDING.md`](./ONBOARDING.md) for where to start reading.

## Status and provenance

**This rulebook is the agreed position of the offshore frontend team that
wrote it, reached at the frontend architecture sync that reviewed it, and
generalised here for reuse beyond the one repository it was written
against.** The rules in this directory — except
[`git-flow.md`](./git-flow.md), which documents this infrastructure's own
guard behaviour rather than the frontend team's proposal — are the frontend
team's own, reviewed and settled position: for new code, the team already
follows this standard; existing code is brought up to it a piece at a time,
as it is touched, rather than in one sweep. Where the source material
records a decision, that decision is what these documents carry forward as
a rule; nothing here is a rule this repository's authors invented on the
team's behalf. The deliberation behind a settled decision — the
alternatives weighed, the reasoning for rejecting them — is not carried
forward once the decision itself is captured as a rule here; what a
question is still genuinely unsettled is tracked in
`docs/OPEN-DECISIONS.md` instead, see
[What is open, and out of scope here](#what-is-open-and-out-of-scope-here)
below.

**It is binding wherever a project adopts it.** Adoption is a per-project
decision, made when a project installs this infrastructure and turns a
given track on — see [`docs/guide/configuration.md`](../guide/configuration.md).
From that point the rules are binding for new code in *that* project, some
of them mechanically enforced by the guards named in each document's "What
is enforced" section.

## How to read a rule

Every rule in these documents is written as **MUST**, **SHOULD** or **MAY**:

- **MUST** — required. A reviewer should reject a change without it.
- **SHOULD** — required unless there is a stated reason not to, given in the
  pull request.
- **MAY** — allowed, at the author's judgement.

## Scope of enforcement

Once a project adopts this rulebook, it applies to three different slices of
that project's code, and not in the same way:

1. **All new code** — from the day the project adopts it.
2. **Code already open for another reason** — bring the parts you actually
   touch up to the standard as you go (the Boy Scout rule, below). This is
   not a mandate to refactor beyond what the change already touches.
3. **Existing code nobody is touching** — nothing changes until it is
   scheduled. Adopting this rulebook is not an instruction to stop feature
   work and refactor the codebase.

## Status labels

Each document opens with one of these:

- **Active — binding for new code.** Agreed by the frontend team, and either
  already enforced by a guard or ready to be. Applies to new code from the
  day a project adopts this rulebook; existing code is expected to move
  toward it as it is touched (the Boy Scout rule, above), not all at once.
- **Agreed, deferred — low priority.** Agreed in principle, deliberately
  scheduled after the higher-priority work. Not a rejection and not
  optional forever — just not now. Only [`api-layer.md`](./api-layer.md)
  carries this label.
- Anything still under real disagreement — styling strategy, for one — is
  **not** in this directory at all. It is being tracked in `docs/OPEN-DECISIONS.md`, and
  nothing here should be read as a ruling on it.

## The documents

| Document | Status | Covers |
| --- | --- | --- |
| [`rationale.md`](./rationale.md) | Active | Why this rulebook exists at all — the general argument, independent of any one project's numbers. |
| [`principles.md`](./principles.md) | Active | The handful of ideas everything else follows from, including that reuse is mandatory. |
| [`shared-code-boundaries.md`](./shared-code-boundaries.md) | Active | What belongs at a project's shared root versus inside one consumer's own folder, and how the same folder split applies to a store, a context or a root-level hook once it outgrows one file. |
| [`component-structure.md`](./component-structure.md) | Active | One component, one folder; required and optional contents; how a folder grows and how code is promoted out of it. |
| [`layer-boundaries.md`](./layer-boundaries.md) | Active | What the view, the hook, context and utilities are each allowed to do, and which layer may import which. |
| [`naming.md`](./naming.md) | Active | File, folder, hook, constant and spec naming conventions, grouping folders included. |
| [`module-imports.md`](./module-imports.md) | Active | The import statement: through a folder’s barrel rather than around it, the project path alias instead of a climbing relative specifier, and keeping the import list honest. |
| [`file-size.md`](./file-size.md) | Active | The line-count thresholds, the exception mechanism, and how to split a file that has grown too large. |
| [`state-management.md`](./state-management.md) | Active | Where a given piece of state belongs, server data versus reference data, prop drilling, cross-component signalling. |
| [`types.md`](./types.md) | Active | Frontend-only type design **and** backend-contract typing and filing — matching the backend exactly, one DTO per file, the nullability generics. Contract typing is binding now; only the API layer's own file organisation is deferred, see `api-layer.md`. |
| [`api-layer.md`](./api-layer.md) | **Agreed, deferred** | Organising the API layer by backend controller and the `any` cleanup. Binding for new endpoints only, once the project turns this track on. Does not cover contract typing itself — see `types.md`. |
| [`local-dev-config.md`](./local-dev-config.md) | Active | Machine-specific configuration never lands in a tracked file: the deployed-config file versus the gitignored per-machine one, and what the `local-config-isolation` rule enforces on a write, a stage and a commit. |
| [`code-documentation.md`](./code-documentation.md) | Active | How comments and doc blocks are written, for humans and AI agents alike. |
| [`testing.md`](./testing.md) | Active | Co-located tests, what to test at each layer, one test per behaviour, test naming, coverage expectations. |
| [`agent-rules.md`](./agent-rules.md) | Active | Rules for an AI agent working in the repository, as distinct from rules about the code it writes. |
| [`migration-approach.md`](./migration-approach.md) | Active | The general shape of a no-big-bang rollout: phases, the Boy Scout rule, gating new work — without any one project's own backlog. |
| [`javascript-projects.md`](./javascript-projects.md) | Active | What this rulebook means for a project whose source is JavaScript: what is unchanged (almost all of it), and how a shape is written down without a compiler behind it. |

## The backend documents

The .NET counterpart to the table above. Same contract: portable shapes, no
repository's own project names, binding for new code once a project adopts
them by declaring `"stack": "backend"`.

| Document | Status | Covers |
| --- | --- | --- |
| [`backend-architecture.md`](./backend-architecture.md) | Active | The four projects (Domain, Application, Infrastructure, Api), what belongs in each, and the dependency rule: nothing inner references anything outer. Why the repository interfaces live inward. |
| [`backend-use-cases.md`](./backend-use-cases.md) | Active | One folder per use case and what has to be in it; the command handler's transaction envelope; why the domain event goes inside the transaction; tenant scoping and soft deletes. |
| [`backend-data-access.md`](./backend-data-access.md) | Active | The repository boundary, calling database functions, snake_case identifiers, offset-carrying timestamps, and versioned versus repeatable migrations. |

Three things the frontend table has no equivalent of, and one it does:

- **File-size thresholds are deliberately unset for the backend.**
  `file-size-limit` stays frontend-only until a number is actually agreed
  rather than invented — see `docs/OPEN-DECISIONS.md`.
- **Co-located tests are a frontend convention.** The backend keeps separate
  test projects, and `test-structure`'s Arrange-Act-Assert expectation is
  the backend's own.
- **`code-documentation.md` already covers both stacks** — its "Backend
  (.NET)" section is the `/// <summary>` rule, and has been there all along.

Git workflow — branch naming, rebasing, how a change reaches a base
branch — is covered by [`git-flow.md`](./git-flow.md) in this same
directory. Unlike the rest of this directory, it documents this
infrastructure's own guard behaviour directly, rather than the frontend
team's proposal — see [Status and provenance](#status-and-provenance).

[`clean-code.md`](./clean-code.md) sits outside the table for a different
reason: it is not frontend-specific and it is not enforced. It states the
named principles — DRY, SOLID, KISS — the separation of concerns that the
component-folder shape is one instance of, and the whitespace conventions
that make any language's code readable, as a standing recommendation for
**all** code in any repository this rulebook reaches. It is deliberately
guard-free; the document itself explains why.

## Generated documents

Three whole documents are assembled from the files above by
[`tools/build-standard.js`](../../tools/build-standard.js) — nobody edits
any of them by hand, and running the script (or its `--check` flag) is how
drift between a split file and an output is caught:

- [`FRONTEND-ARCHITECTURE-STANDARD.md`](./assembled/FRONTEND-ARCHITECTURE-STANDARD.md)
  — every document in the frontend table above, in reading order: the full
  portable frontend rulebook.
- [`BACKEND-ARCHITECTURE-STANDARD.md`](./assembled/BACKEND-ARCHITECTURE-STANDARD.md)
  — the same for the backend table: the project layout and the dependency
  rule, the use-case shape, data access and migrations, plus the shared
  documentation and git-flow parts.
- [`CODE-DOCUMENTATION-STANDARD.md`](./assembled/CODE-DOCUMENTATION-STANDARD.md) — a
  standalone document assembled from [`code-documentation.md`](./code-documentation.md)
  alone, meant to be handed to a team, a project, or another organisation's
  AI agent that needs only the comment and doc-block rules, without pulling
  in the rest of this rulebook.

A part feeding more than one output never holds a second copy of itself.
`code-documentation.md` is a section of both architecture standards *and*
the whole of the documentation standard; `README.md` (this file),
`principles.md` and `git-flow.md` are shared between the two architecture
documents the same way. Editing the part once updates every output that
carries it.

## The convention this directory follows

Standards and rules that bind a developer or an AI agent working in either
product repository live **centrally, here** — not scattered across
per-repository README files, inline comments, or a wiki page only some
agents will ever read. They **must stay readable for a human**: a rulebook
nobody can read start to finish stops being a rulebook.

That readability requirement is what the split above is for, generalised:

- A standard that has grown too large to maintain as one file MAY be split
  into parts, the way this directory splits the frontend architecture
  standard into `principles.md`, `naming.md`, `file-size.md` and the rest.
- A split standard MUST still be assembled back into one composed document a
  human can read top to bottom, the way
  [`FRONTEND-ARCHITECTURE-STANDARD.md`](./assembled/FRONTEND-ARCHITECTURE-STANDARD.md)
  and [`CODE-DOCUMENTATION-STANDARD.md`](./assembled/CODE-DOCUMENTATION-STANDARD.md)
  are assembled from the parts above (see
  [Generated documents](#generated-documents)).
- The parts are the source of truth; the assembled document is **generated**,
  never hand-maintained. Edit the part that covers what changed, then run
  [`tools/build-standard.js`](../../tools/build-standard.js) to regenerate —
  never edit a generated output file directly, because that edit is
  overwritten the next time the script runs and never reaches the part
  anyone else actually reads.

## What is Active today

Binding for new code, effective immediately on adoption:

- The component-folder structure ([`component-structure.md`](./component-structure.md)
  and [`layer-boundaries.md`](./layer-boundaries.md)).
- Test coverage expectations for new and touched code, and running the full
  test suite locally before committing ([`testing.md`](./testing.md)).
- The file-size thresholds, including the hard limit at which a build fails
  ([`file-size.md`](./file-size.md)).
- Delivery only through a pull request, with mandatory reviewer approval and
  no direct push to a base branch — enforced at the git level, see
  [`git-flow.md`](./git-flow.md).
- **The Boy Scout rule**: code you already have open gets improved as you
  touch it — extract the logic you are modifying, give a type you are
  changing a proper home, add a test for what you extracted. This is not a
  licence to restructure code you are not otherwise changing in the same
  change set; that buries the real diff and makes review impossible.

## What is deferred

[`api-layer.md`](./api-layer.md) — organising the API layer by backend
controller, and reducing the existing use of `any`. Agreed in principle,
scheduled after the structure and testing work because that work is what
makes components testable, which is the higher priority. New endpoints
follow it from the day a project turns this track on; existing API code is
not refactored to match it until there is a reason and the time.

**Filing and typing a backend-contract type itself is not part of this
deferral.** A new contract type still MUST be filed in the shared,
service-organised location, matched to the backend exactly and never typed
`any`, from the day a project adopts this rulebook — see
[`types.md`](./types.md). What is deferred is only reorganising the API
layer's own files by controller and cleaning up the existing backlog of
untyped calls.

## What is open, and out of scope here

Not settled, and therefore not a rule in any of these documents:

- Styling strategy — a single co-located stylesheet convention versus
  whatever mix a project currently has.

These are tracked in `docs/OPEN-DECISIONS.md`. If a document in this
directory appears to take a position on one of them, that is a defect in the
document, not a ruling — report it.
