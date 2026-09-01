# Frontend Architecture Standard

> **Generated file — do not edit directly.** Produced by `tools/build-standard.js`
> from the individual files in `docs/standards/`. Edit one of those and run
> `node tools/build-standard.js` to regenerate this file, or
> `node tools/build-standard.js --check` to verify it still matches without
> writing anything.

## Contents

1. [Architecture standards](#architecture-standards)
2. [Why this exists](#why-this-exists)
3. [Principles](#principles)
4. [Shared code boundaries](#shared-code-boundaries)
5. [Component structure](#component-structure)
6. [Layer boundaries](#layer-boundaries)
7. [Naming conventions](#naming-conventions)
8. [Module imports](#module-imports)
9. [File size and decomposition](#file-size-and-decomposition)
10. [State and communication](#state-and-communication)
11. [Types](#types)
12. [The API layer](#the-api-layer)
13. [Local development configuration](#local-development-configuration)
14. [Code documentation](#code-documentation)
15. [Testing](#testing)
16. [Rules for an AI coding agent](#rules-for-an-ai-coding-agent)
17. [Git flow](#git-flow)
18. [Projects without TypeScript](#projects-without-typescript)
19. [Migration approach](#migration-approach)

---

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

---

# Why this exists

Status: Active — binding for new code.

Two observations, independent of any one project's numbers, are the actual
argument for writing this rulebook down rather than leaving it as shared
intuition. A project's own current size, largest files and adoption
progress are project-specific facts and belong in that project's own docs,
not here — see `docs/projects/<repository>/current-state.md` where this
infrastructure is installed against a real repository.

## This is rarely a green-field proposal

The component-folder pattern this rulebook describes is very often not new
to the codebase it is being proposed for. Parts of it tend to already exist,
inconsistently, in whichever areas were touched most recently or reworked
most carefully — arrived at independently, more than once, by different
people who were never coordinating with each other.

That is not a coincidence worth ignoring; it is the actual argument for
making the pattern explicit. When the same shape keeps emerging on its own,
writing it down is less an invention than a decision to finish something
that had already started, and to make it the default instead of a lucky
accident that only holds where someone happened to care.

## The largest, most tangled files are the ones nobody wants to touch

That reluctance is the real cost being paid, not an inconvenience alongside
it. A file that mixes rendering, state, business rules and data access
becomes expensive to review and risky to change precisely because nothing
in it can be reasoned about on its own — and it is nearly impossible to test
below the level of mounting the whole thing and clicking through it.

The size of such a file is a symptom worth noticing, but the actual defect
underneath it is always the same one this rulebook exists to remove: more
than one job living in one place. See
[`principles.md`](./principles.md#2-one-file-one-job) and
[`file-size.md`](./file-size.md#a-line-count-is-a-symptom-not-the-disease).

---

# Principles

Status: Active — binding for new code.

Everything else in this rulebook is an application of a small number of
ideas. When a rule elsewhere seems to conflict with a specific situation,
come back here first — the specific rule is almost always a consequence of
one of these, and understanding why usually resolves the conflict.

## 1. Build small, composable units

A component, a hook or a utility is rarely used only once, in only the
place its author had in mind. It gets reused in combinations nobody
enumerated in advance, next to code its author never saw. That raises the
bar: a unit that only works in its original context is a liability the
moment it is reused, because the second caller inherits every assumption
the first one silently made.

The practical test: **a part you can name, describe in one sentence and
test on its own is a part that survives being placed somewhere
unexpected.** If you cannot describe what a file does without "and", it is
probably more than one part.

## 2. One file, one job

Rendering, business logic, types, constants and utilities are different
jobs. When they share a file they cannot be read, reviewed, reused or
tested separately — a reviewer has to hold the whole file in their head to
understand any one part of it, and a test for the business logic has to
mount the rendering to reach it.

This is the principle behind the component-folder shape in
[`component-structure.md`](./component-structure.md) and the layer split in
[`layer-boundaries.md`](./layer-boundaries.md): those documents are this
idea applied consistently, not a separate rule.

## 3. The folder mirrors the root

A component's own folder uses the same vocabulary as the project
root — `components/`, `hooks/`, `types/`, `utils/`, a constants file. Learn
the layout once and it holds at every depth, whether you are looking at the
whole project or a single component three levels deep.

This is what makes promoting something cheap: moving a utility from a
component's own `utils/` to the parent's, or to the project root, is a file
move and an import update, not a rewrite, because the destination already
has the same shape as the source.

## 4. Reuse is mandatory, not a style choice

**Before writing a new helper, hook, type, service or constant, look for
what already exists and extend it.** Search the immediate folder, the
parent, the project's shared locations, and any shared package the project
depends on, in that order, before writing anything new.

Reinventing something the project already has is a defect, not a matter of
taste: a fourth `formatDate` or a third confirm-dialog controller is a
permanent tax on everyone who has to figure out which one is the real one,
and it is a tax nobody agreed to pay. Finding the existing one costs a
search; adding a duplicate costs every future reader.

This applies as much to an AI agent as to a person — see
[`agent-rules.md`](./agent-rules.md).

**A well-formed unit is usually close to extractable, and that is worth
building toward on purpose.** A component folder built the way
[`component-structure.md`](./component-structure.md) describes — view,
logic, types, constants and utilities behind a single declared entry
point — is most of the way to being publishable into a shared package as it
stands. A candidate is genuinely generic when it has no import from a
project-specific store, no project-specific type, no assumption baked in
about one particular screen, and a public surface already expressed in its
own barrel; something that meets those tests is worth proposing for
extraction rather than copying into the next place that needs it.

Where it costs nothing to do so, **build a reusable piece product-agnostic
from the start**: take a label as a prop instead of reading it from a
project's own translation store, take a callback instead of calling a
project's own API layer directly. Neither costs anything the day it is
written, and both are what let the same piece move to a shared package
later without a rewrite.

## 5. Promote on the second consumer, not the second guess

Code with exactly one consumer lives inside that consumer's own folder,
where it can be found, changed and deleted along with it. It moves up —
one level, to the parent, to the project root, to a shared package — only
when a second, real consumer needs it.

Moving something up "because it looks generic" produces a shared folder
full of single-use code, which is the same problem as an oversized file,
just spread across more locations. The trigger is a real second caller, not
a guess about future reuse.

## 6. Structure serves testing

Most of what is hard to test is hard because logic and rendering are welded
together — the only available test is to mount the whole screen and
interact with it, which is slow, brittle, and fails for reasons unrelated
to what it is meant to assert.

Split the two apart and the logic becomes a plain function or a hook,
testable without mounting anything. This is why
[`layer-boundaries.md`](./layer-boundaries.md) insists on the split even
where it looks like extra ceremony for a small component: the payoff is
not visible in that one component, it is visible in how cheap its test
turns out to be.

## What is enforced

- Reuse-before-writing (principle 4) is backed by the `reuse-before-new`
  guard rule, which can prompt when a change introduces something that
  looks like a near-duplicate of an existing helper, hook or type.
- The remaining principles are design philosophy: they are not
  independently guard-enforced. They surface as concrete, checkable rules
  in the other documents in this directory, and enforcement is described
  there.

---

# Shared code boundaries

Status: Active — binding for new code.

[`component-structure.md`](./component-structure.md) describes one
component's own folder. This document describes the boundary one level up —
what belongs at a project's shared root versus inside a single consumer's
own folder — and the same question applied to a store, a context or a
root-level hook once one of those outgrows a single file. Real top-level
folder names are project-specific and are not listed here; see a project's
own docs for what its root actually contains.

## The root is for shared code

There are two ways something legitimately belongs at a project's shared
root, at `src/utils/`, `src/hooks/` or `src/types/` rather than inside one
component's own folder.

**It is shared by nature.** Cross-cutting infrastructure — the API layer,
translation setup, global stores, backend-contract types, genuinely
universal utilities — starts at the root and never lived anywhere else.
Nobody needs to wait for a second consumer to know that an API client is
shared. This is not a licence to start everything at the root; it applies to
genuine infrastructure, not to anything that merely feels reusable one day.

**It grew into it.** Something written for a single component gains a
second consumer and moves up — see
[`component-structure.md`](./component-structure.md#promotion-when-something-outgrows-its-folder).

For everything else the converse holds: **code with exactly one consumer
belongs inside that consumer's own folder**, where it can be found, changed
and deleted along with it. A shared root full of single-use code is the same
problem as an oversized file, just spread out across more locations.

## A feature's parts live together

A route-level screen and the pieces only that screen renders are one
feature. Splitting them across two parallel trees — the screen under a
`pages/` root, its dialogs and panels under a mirrored path in a
`components/` root — is a common shape and a costly one:

```
BAD — one feature, two trees, mirrored by hand
  src/pages/configuration/service-inspection/PestTypes/PestTypes.jsx
  src/components/Configuration/ServiceInspection/PestTypes/AddEditPestType.jsx
```

```
GOOD — one feature, one folder
  src/pages/PestTypes/
    PestTypes.jsx
    usePestTypes.js
    index.js
    components/
      AddEditPestType/
        AddEditPestType.jsx
        useAddEditPestType.js
        index.js
```

The mirrored form has to be kept in step by hand, in two places, forever. It
guarantees a long climbing import in one direction (see
[`module-imports.md`](./module-imports.md)), it lets the two halves drift
apart in naming — which is how the same concept ends up spelled two ways —
and it means nothing about the feature can be moved, extracted or deleted as
a unit, because half of it is somewhere else.

**A component with exactly one consumer belongs inside that consumer's own
folder**, and a route-level screen is a consumer like any other. This is not
a new rule; it is "the root is for shared code" applied to a screen rather
than to a utility. The `components/` root is for what more than one screen
renders — promoted there on the second consumer, like everything else.

`pages/` (or `routes/`, or whatever a project calls it) stays what it is: the
route-level entry points, each one a component folder of the ordinary shape.
Nesting the route hierarchy inside it is fine; duplicating that hierarchy in
a second tree is what this section is against.

## A folder that has shrunk to one occupant

A top-level folder sometimes ends up holding exactly one thing after the
rest of what used to live there moved out or was deleted — and its name,
chosen for what it used to hold, no longer describes what is actually in
it.

**Delete the folder and move its one remaining occupant to wherever it
actually belongs**, rather than keeping the folder for its own sake or
inventing a new purpose for it to justify keeping it. A folder that exists
only because deleting it feels like a bigger change than it is costs more
in confusion than it saves in tidiness.

## The same pattern applies beyond components

Components are the largest, most common case of something that outgrows a
single file — not a special one. The same folder split applies wherever a
unit has grown past one file, with one deliberate exception, below.

**Stores.** A large store — state shape, actions, types and derivation all
in one file — gets the pure parts pulled out, the same way an oversized
component does:

```
store/
  <domain>/
    <domain>Store.ts   # store definition and actions
    utils.ts           # pure derivations and reducers used by actions
    selectors.ts        # reusable selectors
    index.ts            # re-exports
```

`utils.ts` and `selectors.ts` are then pure and testable without
instantiating the store or rendering anything.

**Contexts.** A context that owns real coordination logic gets the same
treatment: the context and its provider stay in one file, its derivations
move to a `utils.ts` beside it.

**Root-level hooks.** A hook living at the project's shared root that needs
its own types and utilities gets a folder of its own, rather than growing
sideways inside one file.

## Stores and API services keep their types at the root

The colocation rule in [`component-structure.md`](./component-structure.md)
and [`types.md`](./types.md) — a type lives with what it describes, and
moves up only on a second consumer — stops at stores and API services.
**Their types stay at the project's shared types location**, never in a
colocated `types.ts` next to the store or service file.

The reason follows directly from "the root is for shared code" above: a
store and an API contract are shared by nature. A store exists precisely
because unrelated parts of the app read it, and a backend contract is
consumed by whoever calls the endpoint — there is no version of either that
is "local to one place", so the question colocation answers does not arise
for them. A backend-contract type in particular is global data used across
the whole project; it belongs wherever else a project's global types live.

Splitting a large store into a store, its utils and its selectors, as above,
is still worth doing. Moving its types out of the shared types location into
a colocated file is not — it would add a second place to look for a type in
exchange for nothing.

## What is enforced

- Nothing in this repository's guard set independently enforces the
  root-versus-local boundary described here; it is review-enforced, guided
  by this document and by `reuse-before-new` (see
  [`principles.md`](./principles.md#what-is-enforced)), which can catch a
  near-duplicate landing at the wrong level.

---

# Component structure

Status: Active — binding for new code.

## Every component MUST live in its own folder

A bare `Component.tsx` sitting directly among other components' folders is
not acceptable for new code, because it has nowhere to grow: the first
type, the first utility and the first hook all end up inside the view file,
and the next person to touch it inherits the mess.

**The folder name and the main file name MUST match**: `OrderPanel/` holds
`OrderPanel.tsx`, not `View.tsx` or `index.tsx`. Anyone who knows the folder
name can find the view without opening anything.

## Required contents

Four files, minimum:

```
OrderPanel/
  OrderPanel.tsx      # view
  useOrderPanel.ts    # logic and state
  types.ts            # types, including OrderPanelProps
  index.ts             # public surface
```

- **`OrderPanel.tsx` — the view.** Renders. See
  [`layer-boundaries.md`](./layer-boundaries.md) for exactly what it may
  and may not hold.
- **`useOrderPanel.ts` — the logic.** Owns state, effects, data access,
  validation and event handling. Returns a plain object the view consumes.
  Takes a `.tsx` extension only if it genuinely returns JSX.
- **`types.ts` — the types.** Every type the component and its internals
  need, including its props type. This is what lets a caller — or a
  test — import a type without importing the component.
- **`index.ts` — the public surface.** Re-exports only, nothing else. This
  is the file everyone else imports from, and it is the boundary of the
  component: what is not exported here is private to the folder.

## Optional contents, added when needed

Not created preemptively — added the first time the component actually
needs them.

| Path | When |
| --- | --- |
| `ComponentContext.tsx` | Shared state, events or coordination between the component and its children. |
| `contexts/` | More than one context is needed. |
| `components/` | Child components. Each one repeats this same layout, recursively. |
| `hooks/` | Hooks reused by the component and its children, or a hook the folder publishes for outside callers — see below. |
| `types/` | `types.ts` has grown enough to warrant splitting; `types/index.ts` keeps the import path stable. |
| `utils/` | Pure functions reused by the component and its children. Always named `utils/`, never `helpers/` — one name for the same thing at every level, so nobody has to decide which word a function deserves. |
| `constants.ts` | Shared constants: keys, defaults, limits, option lists. |
| A co-located stylesheet | Styling strategy is not settled — see `docs/OPEN-DECISIONS.md`. Not a rule in this document either way. |

## A grown component, recursively

```
ShipmentBoard/
  ShipmentBoard.tsx
  useShipmentBoard.ts
  ShipmentBoardContext.tsx
  constants.ts
  types.ts
  index.ts
  components/
    ShipmentFilters/
      ShipmentFilters.tsx
      useShipmentFilters.ts
      types.ts
      index.ts
    ShipmentRow/
      ShipmentRow.tsx
      types.ts
      index.ts
  hooks/
    useShipmentSelection.ts
    useShipmentSorting.ts
    index.ts
  utils/
    buildShipmentQuery.ts
    formatShipmentStatus.ts
    index.ts
```

`ShipmentRow` has no `useShipmentRow.ts`: it is a genuinely presentational
component with nothing to manage. **The hook is required only when there is
logic to hold.** Creating an empty one to satisfy the pattern is noise, not
compliance.

A well-formed `ShipmentBoard.tsx` stays small even though the feature is
large — that is the point of the exercise, not an accident of the example.

## `index.ts` re-exports. It never implements

```ts
// GOOD — OrderPanel/index.ts
export { OrderPanel, OrderPanel as default } from "./OrderPanel";
export { useOrderPanel } from "./useOrderPanel";

export * from "./constants";
export type * from "./types";
```

- `index.ts` MUST contain re-exports only. No component, no hook, no
  utility, no logic. An index file holding an implementation is invisible
  in a stack trace, a tab bar, a file search and a diff — every one of
  those shows `index.tsx`, indistinguishable from a real barrel.
- Other modules MUST import a component through its `index.ts`, never by
  reaching into its internal files: `import { OrderRow } from
  "@/components/OrderPanel"`, never
  `from "@/components/OrderPanel/components/OrderRow/OrderRow"`.
- Export types with `export type *` so they are erased at build time.
- Do not re-export a child component or a hook that is genuinely internal.
  The barrel **is** the API; keeping it small is how the folder stays free
  to change inside without breaking a caller.

## Promotion: when something outgrows its folder

Because every level uses the same names (principle 3 in
[`principles.md`](./principles.md)), moving code up is a file move plus an
import update:

```
ComponentA/utils/formatStatus.ts        # used by ComponentA only
  a sibling component needs it
components/shared/utils/formatStatus.ts
  several feature areas need it
src/utils/formatStatus.ts
  another project needs it
a shared package
```

**Promote on the second consumer, not the second guess.** Promotion is also
the moment to check for a duplicate that already exists at the destination
before writing anything new — see principle 4.

## A component's own hook is not its public API

`useOrderPanel.ts` is written for exactly one caller: `OrderPanel.tsx`. Its
shape follows the view, and that is fine while the view is the only thing
reading it. It stops being fine the moment a second component calls it: the
hook is now a contract with an outside caller, and the component can no
longer reorganise its own logic without breaking someone.

So `use<Component>` stays the component's own, and anything a consumer
needs is published separately, from `hooks/`:

```
ConfirmDialog/
  ConfirmDialog.tsx                # view — renders
  useConfirmDialog.ts              # the view's own logic; not exported
  types.ts
  index.ts                         # the view + the consumer hook
  hooks/
    useConfirmDialogController.ts  # what a consumer calls
    index.ts
```

- A hook meant for consumers MUST live in `hooks/`, and MUST NOT be called
  `use<Component>` — that name is taken, and the two are not
  interchangeable. Name it for what it does.
- `hooks/index.ts` re-exports, and the component's own barrel re-exports
  from it, so a consumer still imports from the component's `index.ts` and
  never reaches into the folder.
- A second component MUST NOT be pointed at `use<Component>`. If a
  consumer needs what it already does, that behaviour moves into a hook
  under `hooks/`, and the view's own hook calls it too.

This is not a reason to create `hooks/` up front. Most components never
gain an outside caller, and for them the private hook is the whole story —
the folder appears when the second caller does.

## The shared hooks root is for hooks with more than one consumer

The global `src/hooks/` root is reserved for a hook genuinely reused by more
than one component. A hook written for exactly one component is not a shared
hook yet, however general its logic looks — it belongs in that component's
own folder as `<Component>/use<Component>.ts`, same as any other component
internal.

Writing it into the global root instead loses the one thing a component
folder gives a hook for free: a single place that moves, renames and deletes
together with its one caller. Promote it to `src/hooks/` on the second
consumer, not the second guess — the same rule as any other promotion in this
document.

## What is enforced

- `component-folder-shape` checks that a new component has its own folder
  with the required files and that folder and main-file names match.
- `barrel-exports-only` checks that `index.ts` contains only re-export
  statements.
- `component-types-file` checks that a new component view file, or its own
  `use<Component>` hook, declares no `interface`/`type` of its own — the
  declaration belongs in `types.ts` instead.
- `hook-locality` checks that a new hook file in the global `src/hooks/`
  root does not correspond, by name, to a component that already has its
  own folder — that hook belongs beside the component instead.

---

# Layer boundaries

Status: Active — binding for new code.

[`component-structure.md`](./component-structure.md) describes the shape of
a component folder. This document describes what each file in that folder
is allowed to do, and which layer may depend on which. The folder shape is
free to copy; the boundaries are what makes it worth copying — a folder
that looks right but mixes the jobs inside it is the same problem as one
big file, just wearing the right file names.

## The view renders. That is all

The typical starting point mixes state, fetching, business rules and
markup in one component:

```tsx
// BAD
export const OrderPanel = ({ orderId }: { orderId: string }) => {
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get(`/orders/${orderId}`).then((r) => setOrder(r.data));
  }, [orderId]);

  // A business rule, buried inside a render function.
  const canEdit =
    order?.status === "DRAFT" ||
    (order?.status === "PENDING" && order.ownerId === currentUser.id);

  return <Card>{/* … */}</Card>;
};
```

Nothing here is testable in isolation. To assert `canEdit` is correct for a
pending order owned by someone else, the whole component has to be mounted
and the HTTP layer mocked along with it.

Split, the same feature becomes a pure function, a hook and a view:

```ts
// GOOD — a pure utility, five-line test, no mounting
export const canEditOrder = (order: Maybe<Order>, userId: string): boolean =>
  order?.status === OrderStatus.Draft ||
  (order?.status === OrderStatus.Pending && order.ownerId === userId);
```

```ts
// GOOD — the hook owns state and wires the utility in
export const useOrderPanel = (orderId: string): UseOrderPanelResult => {
  const currentUserId = useCurrentUserId();
  const { data: order, isLoading } = useOrder(orderId);
  const canEdit = useMemo(
    () => canEditOrder(order, currentUserId),
    [order, currentUserId],
  );
  return { order, isLoading, canEdit };
};
```

```tsx
// GOOD — the view is now short enough to read in one screen
export const OrderPanel = ({ orderId }: OrderPanelProps) => {
  const { order, isLoading, canEdit } = useOrderPanel(orderId);
  if (isLoading) return <Spinner />;
  if (!order) return null;
  return (
    <Card>
      <OrderSummary order={order} />
      {canEdit && <OrderForm order={order} />}
    </Card>
  );
};
```

**Where the line sits.** Rendering-only logic stays in the view — a
conditional class, a mapped list, formatting that exists solely for
display and is not worth extracting:

```tsx
// Fine in the view.
const ShipmentList = ({ items }: ShipmentListProps) => (
  <Card>
    {items.map((item) => (
      <ShipmentRow key={item.id} item={item} />
    ))}
  </Card>
);
```

Anything that would still be true if the UI were replaced belongs in the
hook or a utility instead — a business rule wearing a ternary is still a
business rule:

```tsx
// NOT fine in the view.
<Chip
  className={
    order.status === "PENDING" && order.dueDate < today && !order.isException
      ? "chip--warning"
      : "chip--default"
  }
/>
```

The view:

- MAY contain rendering-only logic.
- MUST NOT contain state management, data fetching, or business logic.

## The hook holds the logic

- **MUST NOT return JSX** unless that is its actual purpose (a render
  prop, a column renderer). If it does, it is a component, not a hook.
- **SHOULD return a flat, named object.** A tuple stops being readable
  past two entries.
- **Is the seam for testing.** If something is awkward to test through the
  hook, that is a signal it belongs in a pure utility the hook calls
  instead.
- **Deep logic goes into a utility.** The hook wires things together; it
  is not where a long algorithm lives.
- **Answers to its own view, not to the folder's outside callers.** What a
  consumer is allowed to call is a separate, published hook — see
  [`component-structure.md`](./component-structure.md#a-components-own-hook-is-not-its-public-api).

## Context is for sharing downward, not for everything

Add a context file when the component and its descendants need shared
state, coordinated events or a shared API — and only then. Two components
passing one prop do not need a context.

- The context file owns the context, its provider and its access hook.
- The access hook MUST throw outside the provider, so a misplaced consumer
  fails immediately and clearly rather than silently reading a default
  value.
- Context is for state scoped to **one subtree**. State that outlives the
  subtree, or that unrelated parts of the app must read, belongs in a
  store — see [`state-management.md`](./state-management.md).

### A provider holds one concern, not a directory of them

The failure mode worth naming, because it arrives gradually and is painful
to unwind: a single provider near the root that calls every feature's hook
and hands the results out as one object.

```jsx
// BAD — one provider, every feature's hook, all mounted at all times.
export const FormProvider = ({ children }) => {
  const addEditCustomer = useAddEditCustomer();
  const addEditInvoice = useAddEditInvoice();
  const addEditVehicle = useAddEditVehicle();
  // …twenty more…
  const value = { addEditCustomer, addEditInvoice, addEditVehicle /* … */ };
  return <FormContext.Provider value={value}>{children}</FormContext.Provider>;
};
```

It starts as a convenience — one import, one hook, everything reachable —
and it is genuinely easier than threading state for about the first five
entries. What it costs:

- **Everything is mounted always.** Every feature's state, effects and
  fetches are live on every screen, including the screens that will never
  render that feature.
- **Every consumer re-renders on every unrelated change.** The context value
  is one object; a keystroke in one feature's form invalidates it for all of
  them.
- **The dependency graph inverts.** The provider imports from every feature
  folder, so nothing is independently movable, testable or deletable — the
  exact property [`component-structure.md`](./component-structure.md) builds
  the folder to give it. A cycle is one import away.
- **It never shrinks.** Adding an entry is one line; removing one means
  proving nothing reads it, across the whole app.

The fix is not a bigger provider or a memoised value — it is that **each
feature owns its own state and mounts it where it is used.** The screen that
renders a form calls that form's own hook. Where a feature genuinely does
need to be reachable from unrelated parts of the app, that is what a store
is for, one concern at a time — see
[`state-management.md`](./state-management.md).

A context that already looks like this is unwound the same way as any other
oversized module: one concern out at a time, each move behaviour-preserving
and separately reviewable — see
[`migration-approach.md`](./migration-approach.md).

## Constants and utilities

- **Constants.** No magic strings or numbers in a view or a hook. Keys,
  limits, defaults, debounce intervals and option lists go into a
  constants file.
- **Utilities MUST be pure.** Same input, same output, no store access, no
  network call, no hidden state. That purity is what makes them trivially
  testable, and it is why extracting deep logic is worth doing even when
  only one caller currently exists. Something that needs React state or
  effects is not a utility — it is a hook.

## The direction of dependency

The point of splitting view, hook and utility is defeated if any of them
is free to reach past the next layer:

- **A component calls its own hook or a published hook; it does not call
  the network directly.** All data access goes through a hook, which goes
  through the project's API layer. This is what keeps a view testable
  without a network mock — see [`api-layer.md`](./api-layer.md) for how
  that layer itself is organised.
- **A shared type never imports from a component.** If a shape used by a
  service or another module currently lives inside a component file, the
  shape belongs in a shared types location, not the other way around — see
  [`types.md`](./types.md).
- **The API layer never imports from a component.** The dependency points
  one way: component depends on hook, hook depends on API layer and
  shared types. A service importing from a component means the service
  cannot be understood or reused without that component, which defeats the
  purpose of separating them.

This boundary is independent of how the API layer's own files happen to be
organised internally, which is deferred work — see
[`api-layer.md`](./api-layer.md). Whatever shape the API layer is in, a
component still MUST NOT bypass its hook to reach it directly.

## What is enforced

- `api-import-boundary` checks the direction of dependency between
  components, hooks, the API layer and shared types.
- The view/hook split itself and the "utilities MUST be pure" rule are not
  independently guarded today; a violation is expected to be caught in
  review, guided by this document.

---

# Naming conventions

Status: Active — binding for new code.

Consistent naming is what lets someone guess a path instead of searching
for it. Inconsistency is a small cost paid constantly: three conventions
side by side in the same project mean every import starts with a "where is
this, actually" detour.

## File and folder naming

| Kind | Convention | Example |
| --- | --- | --- |
| Component folder | `PascalCase` | `OrderPanel/` |
| Component file | `PascalCase.tsx` | `OrderPanel.tsx` |
| Hook file | `camelCase.ts`, `use` prefix | `useOrderPanel.ts` |
| Context file | `PascalCase` + `Context` | `OrderPanelContext.tsx` |
| Utility file | `camelCase.ts` | `buildOrderQuery.ts` |
| Types / constants / barrel | lowercase | `types.ts`, `constants.ts`, `index.ts` |
| Style module | matches the component | `OrderPanel.module.scss` |
| Store | `camelCase.ts`, `use` prefix | `useOrderStore.ts` |
| Spec file | subject name + `.test.ts(x)` | `useOrderPanel.test.ts` |

**Folder name and main file name MUST match**: `OrderPanel/OrderPanel.tsx`,
never `OrderPanel/View.tsx`.

### Grouping folders

A folder that holds no component of its own and exists only to group others
— a feature area, a route section — is **`PascalCase` too**, so a path reads
in one convention from end to end:

```
GOOD   src/pages/Configuration/ServiceInspection/PestTypes/PestTypes.jsx
BAD    src/pages/configuration/service-inspection/PestTypes/PestTypes.jsx
```

One convention per tree matters more than which one: the cost being avoided
is a project where the same concept is spelled `ServiceInspection` in one
tree and `service-inspection` in another, and nobody can type a path without
first checking which half they are in.

**A URL is not a folder name.** Route paths are kebab-case because that is
the convention for URLs; that says nothing about the folder the component
lives in, and matching one to the other is not a reason to break the
convention above.

## Identifier naming

These are the conventions this rulebook binds. They are stated here on
their own authority — no wider organisational naming reference is claimed
for them:

- **Components**: `PascalCase` — `UserProfile`, `OrderList`.
- **Hooks**: `camelCase` with a `use` prefix — `useFetchData`, `useAuth`.
- **Props and local state**: `camelCase` — `isLoggedIn`, `userName`.
- **Functions and variables**: `camelCase` — `handleSubmit`, `fetchOrders`.
- **Constants**: `UPPER_SNAKE_CASE` for a genuinely constant, exported
  value — `API_ROUTES`, `DEFAULT_PAGE_SIZE`. A `let`-style local that
  merely never gets reassigned in one function is not what this covers;
  this is for values that are constants by design, not by accident.

## Existing code and renames

**Existing folders and files are renamed only as part of the work that
already touches them.** A rename-only change is a large, conflict-prone
diff on a fast-moving branch for a purely cosmetic gain; doing a sweep of
renames costs more than living with the inconsistency a while longer.
Rename when you are already restructuring the folder for another reason.

## Abbreviations

**Use an abbreviation the team already shares, and use it
consistently** — the same shortening in every file, not one spelling in one
file and a different one in the next.

**Do not invent a new abbreviation for something that does not already
have one.** A shortening only pays for itself once the whole team reads it
without pausing; before that point it is a private code every reader has
to decode. If a term is new, write it out in full and let an abbreviation
emerge only once it is used enough to deserve one.

## What is enforced

- `naming-standards` checks file and folder naming against the table
  above for new files.

---

# Module imports

Status: Active — binding for new code.

[`component-structure.md`](./component-structure.md) says what a folder
contains and [`layer-boundaries.md`](./layer-boundaries.md) says which layer
may depend on which. This document covers the line that actually expresses
both of those in the source: the import statement.

It is the most-written line in a frontend codebase and the least thought
about, and it decides two things the rest of the rulebook depends on —
whether a folder can be moved, and whether a reader can tell what a file
depends on without opening it.

## Import a folder through its barrel, not through its files

A component folder's `index` file is its public surface. Everything else in
it is private, and the import statement is where that is either honoured or
quietly ignored:

```ts
// GOOD — the folder's own barrel; the folder stays free to rearrange inside.
import { OrderRow } from "@/components/OrderPanel";

// BAD — reaching past the barrel into the folder's internals.
import { OrderRow } from "@/components/OrderPanel/components/OrderRow/OrderRow";
```

The second form makes every internal file a de facto public API. The folder
can no longer rename a child, move it a level down, or fold two of them
together without breaking a caller that was never supposed to know either
file existed.

The corollary is that a folder publishing nothing through its barrel is not
importable at all, which is the point: **add the export deliberately when
something is genuinely part of the surface**, rather than reaching around a
missing one.

## Do not climb out of the folder — use the project's path alias

```ts
// BAD — this specifier names nothing a reader can place.
import { getPestTypes } from "../../../../utils/storage";

// GOOD
import { getPestTypes } from "@/utils/storage";
```

Three separate costs, and the third is the one that matters most here:

- **It cannot be read.** Counting `../` against a mental model of the tree is
  work, and the answer changes with the importing file's own depth. The same
  module is `../../utils/storage` from one file and `../../../../` from
  another.
- **It silently retargets.** Move either file one level and the specifier
  still resolves — to something else, or to a build error at a distance from
  the change that caused it.
- **It welds the folder in place.** A component folder is supposed to be
  movable, extractable and deletable as a unit — that is what
  [`component-structure.md`](./component-structure.md) builds it for. A
  folder whose files climb four levels out cannot be moved without rewriting
  every one of them, so in practice it never is.

**One or two levels is ordinary composition** — a child component reaching
its parent's `utils/`, a view reaching the folder above it. Three is where
the specifier has left the feature it was written in, and from there the
count only ever grows.

### The alias has to exist first

An alias is a project-level decision, not a per-file one: it needs a
`resolve.alias` entry (or the bundler's equivalent), a matching
`paths` entry in `tsconfig.json` / `jsconfig.json` so the editor resolves it,
and then it needs to be declared to this rulebook as
`conventions.pathAliases`.

**A project that has not set one up is not asked to write aliased imports** —
there would be nothing for them to resolve to. The rule below stays silent
until the project declares the alias, and declaring it is the change that
switches the rule on. Setting up a single `@` → source-root alias is a small,
mechanical, behaviour-preserving change, and it is worth doing before a tree
gets deep rather than after.

Where more than one alias is declared, use the most specific one that
covers the target — `@components/Common/Table` says more than
`@/components/Common/Table` does.

## Keep the import list itself honest

- **No unused imports.** They are dead weight that survives because nothing
  fails, and they make the dependency list a worse answer to "what does this
  file actually need" every time one accumulates.
- **A type-only import says so** where the language has the form
  (`import type { … }`), so it is erased at build time and cannot be mistaken
  for a runtime dependency.
- **Do not import a module purely for its side effects** from a component or
  a hook. A module that has to run has an entry point that runs it; an import
  whose only purpose is to be evaluated makes load order load-bearing and
  invisible.

## What is enforced

- `import-depth` denies a new file's specifier that climbs at least
  `limits.relativeImportDepth` folders (default 3) and resolves under a
  declared `conventions.pathAliases` root, naming the aliased form as the
  fix. Silent for a project that declares no alias, and silent when the
  target sits under no declared root — a fix it cannot state exactly is a fix
  it does not offer.
- `api-import-boundary` denies a component importing the API layer directly
  (see [`layer-boundaries.md`](./layer-boundaries.md)), resolving aliased
  specifiers through the same `conventions.pathAliases`.
- `barrel-exports-only` keeps the barrel a barrel, in every module extension
  a project writes one in.
- Nothing enforces "import through the barrel, not around it", or the
  import-hygiene points above; those are review-enforced, guided by this
  document, and a linter is the natural home for the unused-import half.

---

# File size and decomposition

Status: Active — binding for new code.

## The thresholds

| Threshold | Level | What it means |
| --- | --- | --- |
| 1,000 lines | Warning | Decomposition is overdue. Raise it in review; splitting may become a separate follow-up task. |
| 1,500 lines | Critical | The build fails. Split the file, or add it to the project's documented exception list with a reason. |

**1,500 lines is a hard limit, enforced by the pipeline, with an explicit
escape hatch.** A limit that is only a suggestion gets ignored under
deadline pressure — exactly when it matters. A limit with no way out at all
turns the first legitimate exception into an argument for dropping the
rule entirely. The combination of "strict" and "has an exception process"
is what keeps it both followed and honest.

Thresholds MAY be refined per file kind by a project applying this
standard: a view component is unreadable long before a generated mapping
table or a declaration table is, so one number is generous to the first
and harsh to the second.

## Exceptions are per file, listed and justified

An exception is not granted ad hoc in a review comment. A file that
genuinely should not be split is added to a documented exception list with
a one-line reason, and that list is reviewed like any other change. The
cost of an exception is that somebody has to write down why — enough
friction to keep the list honest, little enough to keep the rule usable.

Legitimate categories for an exception:

- A generated file.
- An exhaustive mapping or configuration table, where splitting by line
  count alone would move the same declarations into more files without
  making any of them easier to understand.
- A third-party integration adapter whose shape is dictated externally,
  not by this project's own design choices.

## A line count is a symptom, not the disease

The real rule is the one in [`principles.md`](./principles.md): one file,
one job. A 1,400-line component that does four unrelated things is worse
than a 1,600-line table of static data. Use the number as a prompt to look
at the file, not as the verdict on its own.

Ask instead:

- Can you describe the file in one sentence without "and"?
- Does it hold more than one piece of state that nothing else in it reads?
- Does it render more than one visually independent region?
- Would a test for one part of it have to set up the other parts too?

Any "yes" means there is a split waiting, whatever the line count says.

## How to split, in order

Doing this in the wrong order — cutting JSX into fragments while the logic
underneath stays tangled — produces more files with exactly the same
coupling, which is worse than the one big file it replaced.

1. **Pull the logic out first.** Move state and rules into the component's
   own hook, and pure functions into a utility file. On the largest files
   this alone removes most of the volume and requires no change to what is
   actually rendered.
2. **Then extract child components**, along the seams the UI already
   has — a toolbar, a list, a detail panel, a set of dialogs.
3. **Then extract shared hooks**, where two of the new child components
   need the same behaviour.
4. **Only then consider splitting the view itself further**, if it is
   still large after the above.

## What is enforced

- `file-size-limit` fails the build at the critical threshold, and honours
  a project's documented exception list.

---

# State and communication

Status: Active — binding for new code.

## Where state belongs

| Scope | Mechanism |
| --- | --- |
| Used by one component only | `useState` inside its own hook |
| Passed to a child the parent directly configures | props |
| Shared by a component and its descendants | a component context |
| Read or written by unrelated parts of the app | a global store |
| Fetched reference data several unrelated areas need | a global store — see below |
| One-off request data used in one place | the calling hook, via the API layer |

The table is a default, not a law. The question to ask is always **who
needs to see this, and for how long** — the mechanism follows from the
answer, not the other way round.

## Server data: reference data versus screen data

Not every project has a dedicated data-fetching and caching layer — some
have something like React Query and a normalised cache; many have plain
HTTP calls wrapped by a couple of hooks and nothing more. Where there is no
such layer, the advice "never put server data in a store" does not
transfer unchanged, because the store is the only thing available to stop
the same reference data being fetched again for every consumer.

So the rule is about **which** server data goes in a store, not whether
server data belongs there at all:

- **Reference data belongs in a store.** Fetched once, needed by unrelated
  parts of the app, rarely changing — things like a list of facilities, a
  list of supported languages, system-wide configuration. The store is the
  single place that holds it, precisely so it is not reloaded per
  consumer.
- **Screen and request data does not.** Grid rows, search results, the
  record currently open — these belong to the hook that requested them and
  die with it. Putting them in a store makes them outlive their relevance,
  and the stale copy is what the next screen renders.
- **One owner per data set, whichever mechanism holds it.** The problem is
  never "data in a store"; it is a *second* copy somewhere else. Two
  components each fetching the same list into their own state produce two
  versions of the truth that drift apart, and the drift surfaces as a bug
  nobody can reproduce.
- **Fetch in one place, read in many.** Where reference data is loaded,
  load it once at a known point and have every other consumer read the
  store, rather than triggering a fetch from each one.

If a project later adopts a real data layer — a thin caching and
invalidation wrapper, or a library — most of this becomes automatic. Until
then, the boundary above is not a stopgap; it is the actual mechanism, and
it holds only because people apply it consistently.

## Prop drilling is a defect, not a style preference

Passing a value through several components that do not use it themselves
is a defect: each intermediate component gains a prop it does not need,
becomes harder to reuse and to test on its own, and becomes one more place
the value can be dropped or altered on its way down.

```tsx
// BAD — three components carry a value only to hand it on.
const Screen = ({ selectedLocation }: ScreenProps) => (
  <Layout selectedLocation={selectedLocation}>
    <Content selectedLocation={selectedLocation}>
      <Toolbar selectedLocation={selectedLocation}>
        {/* only this one actually reads it */}
        <LocationPicker selectedLocation={selectedLocation} />
      </Toolbar>
    </Content>
  </Layout>
);
```

```tsx
// GOOD — the consumer reads what it needs; the chain carries nothing.
const selectedLocation = useStore((state) => state.selectedLocation);
```

Three things to keep in mind while applying this:

- **Props are still the right answer for local composition.** A parent
  configuring the child it directly renders is exactly what props are
  for, and a component that takes what it needs as props is more reusable
  than one that reaches into a store on its own. The defect is the
  **pass-through chain**, not the prop itself.
- **Keep the chain short.** One or two levels is ordinary composition.
  Beyond that, ask whether the value is really local — and if it is,
  whether a context around that subtree says it better than several
  signatures carrying the same value do.
- **Select narrowly from a store.** `useStore((state) => state.value)`,
  never `const store = useStore()`. Subscribing to the whole store
  re-renders the component on every unrelated change, trading a
  structural problem for a performance one.

## Cross-component communication

For coordination between components that have no natural parent-child
relationship — one component publishing something, another reacting to
it — use a single store as the one mechanism, rather than several ad hoc
event buses, or a callback threaded through several unrelated levels. No
shared parent, no implicit ordering, and exactly one place to look for "how
do two components talk to each other".

When a signal is a fire-once event or a request rather than steady state,
mark its payload with a monotonically increasing identifier (a nonce) so a
newly mounted consumer can tell a fresh signal apart from one that was
already sitting there when it mounted, and does not react to stale state
on mount or on remount.

New cross-component signalling in a project follows whatever single
pattern that project has already established for this, rather than
introducing a second, competing one. If a project has more than one such
mechanism, that is worth folding into one deliberately, not left to grow.

## Avoiding duplicated state

Before adding a new piece of state, check whether it already exists
somewhere reachable. The same flag held in two places will eventually
disagree, and which version the user sees is decided by render order —
which is to say, by accident.

- One owner per piece of state; everything else reads it.
- Derive rather than store: if a value can be computed from existing
  state, compute it in a selector or a memoised calculation. A stored
  derived value is a cache with no invalidation.
- Do not mirror a prop into local state unless you deliberately need an
  uncontrolled copy — and if you do, say so in a comment, because it is
  not obvious from the code alone that the duplication is intentional.

## What is enforced

- Nothing in this repository's guard set enforces state placement or
  prop-drilling depth yet; these are review-enforced, guided by this
  document.

---

# Types

Status: Active — binding for new code, with one exception noted below.

The type system is the main cross-boundary check most frontend projects
have. It is worth exactly as much as the types are accurate, and no more —
a type that lies is worse than no type, because it looks like a guarantee.

## Two kinds of types

The distinction that matters is **where a type's truth comes from**:

- **Backend contracts** — anything sent to or received from an API. Their
  source of truth is the backend; a frontend project does not get to
  design them, only mirror them.
- **Frontend-only types** — view models, UI state, component props,
  configuration shapes, rendering models. Their source of truth is the
  frontend itself.

Both are legitimate, and the most common typing mistake is treating them
as one kind. A UI-only field added to something that is supposed to mirror
a backend shape stops it mirroring anything, and nobody can tell
afterwards which fields the backend actually sends.

**Contracts and frontend-only types live in separate files.** Not separate
worlds — a view model may well be built from a contract type — but a
single file is either mirroring the backend or it is not.

This document covers both: frontend-only type design, and how a
backend-contract type is filed and kept accurate. Both are binding today.
**What is deferred is a different thing** — reorganising the existing API
layer's own files by backend controller, and sweeping the codebase's
existing backlog of `any`. See [`api-layer.md`](./api-layer.md) and
[What is mandatory now, and what is deferred](#what-is-mandatory-now-and-what-is-deferred)
below for exactly where that line sits.

## Frontend-only types: design them properly

A contract type is copied from the backend; a frontend-only type is
designed, because here the frontend is the source of truth. That freedom
is worth using deliberately:

- **Component and module props are a named, exported type** in the
  component's own `types.ts`, not an inline object literal. An inline
  props type cannot be imported by a test or a wrapper that needs it.
- **Prefer a discriminated union over a pile of optional fields** when a
  shape has real modes:

  ```ts
  type LoadState =
    | { status: "loaded"; data: Order }
    | { status: "error"; message: string };
  ```

  This makes the impossible states unrepresentable. Four optional fields
  covering the same cases do not — they let a caller construct a
  combination that was never meant to occur.

- **Derive rather than duplicate.** When a new shape is a variation of an
  existing one — a frontend-only type included — express the relationship
  instead of copying fields by hand:

  ```ts
  export type OrderSummary = Pick<Order, "id" | "code">;
  export type OrderDraft = Omit<Order, "id" | "createdAt" | "modifiedAt">;
  export type OrderPatch = Partial<OrderDraft>;
  ```

  `Pick`, `Omit`, `Partial`, `Required`, `Record`, `ReturnType`,
  `Parameters` and `keyof typeof` exist for exactly this. Reach for them
  before writing a second interface by hand — the derived version survives
  a change to the source type; a hand copy silently stops matching it.

- **Types are colocated with what they describe**, and promoted to a
  shared location on the second consumer — exactly the same rule as for
  utilities and hooks, see
  [`component-structure.md`](./component-structure.md#promotion-when-something-outgrows-its-folder).

## Backend contracts: match them exactly, and file them by service

A contract type is not designed — it is mirrored. The rules below apply from
the day a project adopts this rulebook; they are not part of the deferred
API-layer work, see
[What is mandatory now, and what is deferred](#what-is-mandatory-now-and-what-is-deferred).

- **Filed in a shared, service-organised location**, not colocated with the
  API layer and not colocated with a component. A backend shape is data the
  whole project consumes; it is never "local" to whichever module happens to
  fetch or render it first. Where the backend is split into more than one
  service, file contracts by service, then by domain concept, so a
  project's own API documentation and its type files line up without
  translation.
- **One DTO per file**, named as the backend names it.
- **Match the backend exactly** — field names, casing, optionality,
  nullability, enum values. Do not "improve" a shape on the way in: if the
  backend can return nothing for a field, the type says so; if a field is
  optional there, it is optional here. A type that is nicer than reality is
  a type that lies precisely where the runtime will disagree with it.
- **Prefer a project's shared nullability helper types to a hand-written
  union**, where one exists — a `Nullable<T>`, `Undefined<T>` or similarly
  named globally declared generic reads as intent ("the backend can send
  null here") more clearly than `T | null` does, and is shorter at every
  call site. Pick the one that says what is actually true: a value that can
  be missing is a different fact from one that can be explicitly cleared,
  and collapsing both into one catch-all generic is the wrong answer when
  only one of the two actually occurs.
- **Do not redeclare a contract locally.** A response shape copied into a
  component stops matching the API silently; nothing fails until a user
  opens the screen that depends on the mismatch.
- **Never `any` in a contract type.** This is the single worst place for
  it — it disables the only check that the two sides still agree with each
  other.
- **No `as` to silence the compiler on a contract type.** A cast asserts
  something the type system cannot see; if you cannot state what that is,
  the type is wrong, and the fix is to correct the type, not to assert past
  it.
- **Mirror a backend hierarchy with `extends`**, rather than flattening it
  into repeated fields on each type, so a change to the shared base lands in
  one place and the type checker reports every affected type.
- **Never add a UI-only field to a contract type.** It is tempting — the
  data is right there — and it is exactly how a DTO stops describing what
  the backend actually sends. Extend it into a new, frontend-only type
  instead, as described above.

## No catch-all types file

An undifferentiated "misc types" file attracts more of the same by
existing: its name describes nothing, so nothing in it is findable by
someone who does not already know it is there, and it never shrinks on its
own. **Distribute its contents into named-by-concept files and delete
it**, rather than leaving a default destination that every future type
nobody wants to place can fall into.

## Reuse before you declare

Search before writing a new type, in the same order as for any other
reusable code: the module's own `types.ts`, the parent folder, the
project's shared types location, then any shared package the project
depends on. See [`principles.md`](./principles.md) — this is the same
mandatory-reuse rule, applied to types.

**Use the types a library already exports** instead of hand-rolling an
approximation of them. A UI framework, a table library, a form library and
an HTTP client all export the shapes of their own options, column
definitions, style props and configuration values. A local re-declaration
of one of those is wrong the day the library is upgraded, and it is wrong
silently — nothing points at the mismatch until a field the library
renamed stops working.

## What is mandatory now, and what is deferred

Three different things get called "typing a contract," and keeping them
apart is the point of this section:

- **A new endpoint is typed properly, full stop.** The rules above apply to
  any contract type added for a new endpoint from the day a project adopts
  this rulebook — no exception, no deferral.
- **Code already being touched for another reason gets its connected
  contract types typed properly as part of that change** — the Boy Scout
  rule from
  [`migration-approach.md`](./migration-approach.md#phase-2-the-boy-scout-rule-on-touched-code),
  applied to types. The same limit that phase states applies here without
  exception: typing what the change already touches is not a licence to open
  a wider refactor in the same change set.
- **Sweeping the existing backlog** of untyped or loosely typed calls that
  predate this rulebook is its own, separate, deferred track — agreed in
  principle but scheduled after the component-structure and testing work.
  See [`api-layer.md`](./api-layer.md).

Reorganising the API layer's **own files** by backend controller is deferred
the same way; see [`api-layer.md`](./api-layer.md) for that too. A new
contract type, or one on a piece of code already being touched, is typed
properly the day it is written; it is the cleanup of what already existed
that waits its turn.

## What is enforced

- Nothing in this repository's guard set enforces frontend-only type
  design (discriminated unions, deriving with `Pick`/`Omit`, named prop
  types) yet; it is review-enforced, guided by this document.
- `no-explicit-any` checks for a bare `any` in a contract-type file,
  including a newly added one — this is active now, not part of the
  deferred work in [`api-layer.md`](./api-layer.md).

---

# The API layer

Status: Agreed, deferred — low priority. This file covers the API layer's
own organisation only — filing and typing a backend-contract type itself is
not deferred, see [`types.md`](./types.md).

This is agreed in principle, and it is deliberately scheduled after the
component-structure and testing work, not rejected on the merits. The
priority of the overall standard is making components testable, and the
API layer is not what decides that. There is rarely capacity to rework an
entire existing API layer in one pass, so the position is: **new endpoints
follow this document from the day a project turns this track on; existing
endpoints are left alone until there is a reason and the time to revisit
them.** This applies at every subsection below, restated rather than said
once, because a rule read out of context tends to get applied out of
context too.

Nothing here blocks or is required for the component-structure and
testing work in the other documents in this directory, and a project may
adopt those without adopting this.

## One place, organised like the backend

**Every backend call lives in one API layer, organised by backend
controller** — the same grouping a project's API documentation (Swagger or
equivalent) shows — not by whichever frontend feature happens to call it.

Organising by frontend feature instead has a real, recurring cost:

- Finding a call requires knowing which feature uses it, not which
  controller serves it — the API documentation cannot help, because the
  two are cut along different lines.
- Two features calling the same controller each end up writing their own
  version of the call.
- When a controller changes, there is no single file to open; the change
  is found by searching.

Target shape:

```
src/services/api/
  http.ts             # transport only: instance, interceptors, errors
  endpoints.ts         # controller and route constants
  ordersApi.ts         # one file per backend controller
  usersApi.ts
  index.ts             # re-exports
```

New controller files are created in this shape as endpoints are added.
Nothing is required to move out of an existing, differently organised API
layer as part of adopting this — that convergence happens only if and
when the deferred restructuring itself is picked up as its own piece of
work.

## Controllers and routes are constants

**No string literal URLs in a new API method.**

```ts
// BAD — a typo here is a 404 at runtime, and a renamed endpoint becomes a
// repository-wide search-and-replace.
const response = await axios.get(`/orders/${orderId}/data`);
```

```ts
// GOOD
export const API_CONTROLLERS = {
  orders: "orders",
} as const;

export const API_ROUTES = {
  orders: {
    byId: (orderId: string) => `${API_CONTROLLERS.orders}/${orderId}`,
    data: (orderId: string) => `${API_CONTROLLERS.orders}/${orderId}/data`,
  },
} as const;
```

Why it earns the extra ceremony:

- A renamed endpoint is one edit, and every call site updates with it.
- A typo becomes a compile error instead of a runtime failure on one
  screen.
- The file becomes a readable inventory of what the frontend actually
  consumes from the backend.

**Casing follows the backend exactly.** Do not normalise a controller name
into a different casing convention in the constant string — the string is
not the frontend's to restyle.

## Every method is typed end to end

```ts
// BAD — this compiles and checks nothing. `response.data` is untyped, so
// every field read from it downstream is unchecked too.
export const getOrderData = async (orderId: string, body: any): Promise<any> => {
  const response = await axios.post(`/orders/${orderId}/data`, body);
  return response.data;
};
```

```ts
// GOOD
export const getOrderData = async (
  orderId: string,
  request: GetOrderDataRequest,
): Promise<ApiResponse<GetOrderDataResponse>> =>
  postData<ApiResponse<GetOrderDataResponse>>(
    API_ROUTES.orders.data(orderId),
    request,
  );
```

Rules for every new API method:

- **Explicit parameter and return types, always.** Inferring from the
  HTTP client's own return shape yields an effectively untyped result and
  quietly un-types everything downstream of the call.
- **Request and response types come from the project's contract-type
  location** — the same shapes the backend defines — not a local
  interface and not an inline object literal.
- **All calls go through the project's shared transport module.** No bare
  HTTP client call in feature code: base URL, auth, caching, error
  handling and cancellation are centralised for a reason, and a direct
  call silently opts out of all of them.
- **No business logic and no UI concern inside an API method.** Request
  in, typed response out. Mapping a response into something the UI wants
  is the job of a hook or a utility, not the API method itself.
- **No API call from a component.** Components call hooks; hooks call the
  API layer — see
  [`layer-boundaries.md`](./layer-boundaries.md#the-direction-of-dependency).
- **The API layer never imports from a component.** A service depending
  on a component means the service cannot be understood or reused without
  it; a shared shape used by both belongs in the project's shared types
  location instead.

## The backend is the source of truth

When adding or changing a call, take the route, the DTO names and the
exact shapes **from the backend** — not from another frontend file that
"does something similar", which only propagates whatever was already
wrong with that other file.

**API documentation first, backend source when the documentation is not
enough.** Generated API documentation is usually right and is the fastest
way in, but it is generated: nullability is often wider or narrower than
the endpoint actually behaves, polymorphic or inherited shapes can
flatten, and a field documented as always present may in practice be
conditional. When the documentation is ambiguous, or looks too convenient,
read the actual backend controller and its DTO. When the two disagree, the
code wins, and the discrepancy is worth reporting back to whoever owns the
backend.

The payoff arrives when the backend changes. If a contract lives in one
typed DTO, the change is one edit and the type checker lists every
affected call site. If it is spread across feature files as loosely typed
data, the change is found by a user instead.

## Backend contract types are covered in `types.md`, and are not deferred

Filing and typing a backend-contract type — one DTO per file, filed by
service, matching the backend exactly, mirroring its hierarchy, never
`any` — is a rule about the **type**, not about the API layer's own file
organisation, and it applies from the day a project adopts this rulebook.
See [`types.md`](./types.md#backend-contracts-match-them-exactly-and-file-them-by-service).
Only the API layer's own files (this document) and the existing backlog of
loosely typed calls are what wait their turn.

## The `any` cleanup

Reducing existing `any` usage is part of ordinary migration, not a
separate campaign: remove it in code you are already touching for another
reason, rather than sweeping the codebase. That said, the deferred timing
applies to the **backlog**, not to new code — a brand-new contract type or
a brand-new exported signature still MUST NOT use `any`. Where `any` is
genuinely unavoidable at a boundary a project does not control, prefer
`unknown` and narrow it with a type guard, and if `any` is truly the only
option, keep it local, narrow, and carry a comment saying why.

Generating types, or a whole client, from a project's API documentation
tooling removes most contract drift by construction, at the cost of a
build step and generated files appearing in review. This was considered
and explicitly not ruled out — it is low priority rather than rejected,
and worth revisiting once the API layer itself is being actively worked
on. Until then, the manual mirroring described above is what stands
between a project and drift, and it depends entirely on discipline.

## What is enforced

- `api-import-boundary` checks the direction of dependency described in
  [`layer-boundaries.md`](./layer-boundaries.md) and above.
- `no-explicit-any` checks for a bare `any`, including on a contract type
  or an exported API method signature.
- The controller-by-controller file organisation and the route-constants
  convention are not independently guarded; they are review-enforced once
  a project turns this track on.

---

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

---

# Code documentation

Status: Active — binding

How code is commented, across every repository this infrastructure is
installed into. Part of it is mechanically enforced by a guard
(`core/guards/doc-comment-style.js` and its Codex equivalent); the rest is a
review standard an agent is expected to hold itself to without being asked
each time. This
document is meant to stand on its own — it is what `docs/internal/
CONTRACTS.md` §12 points at, and a reader should not need anything else to
follow it.

## The short version

- A doc block is a **short summary plus `@`-tags**, not an essay.
- **`@example` is forbidden** — the tests and the signature already show how
  something is called, and the guard in this repository denies it outright.
- **Every member of a type gets its own inline doc block**, with a blank line
  between each comment-member pair.
- **A block that covers more than one item becomes a list**, not a paragraph.
- Documentation states **what the code does and why**, never where to use it.
- Inline `//` comments explain **why**, never what the line already says.

## What gets documented

Document something when a reader cannot get the answer from its signature
alone:

- every exported function, hook, component and type;
- every member of an exported type, interface or class;
- a module-level constant whose meaning is not obvious from its name;
- a non-obvious decision inside a function, as an inline comment.

Do not document what the name already says. A wrapper whose signature tells
the whole story needs nothing added to it:

```ts
export const isEmpty = (value: string) => value.trim().length === 0;
```

## Frontend (TypeScript / TSX)

A doc block leads with a short summary, adds a second short paragraph only
when there is a genuine *why*, and closes with the tags the signature needs:

```ts
/**
 * Resolves a display label for an entity, falling back through its optional
 * naming fields.
 *
 * The fallback order matters: a caller-supplied override wins over stored
 * values so a renamed entity shows its new name before the store catches up.
 *
 * @param entity Entity to label.
 * @param override Label to prefer when provided.
 * @returns The resolved label, or an empty string when nothing is set.
 */
```

A block documenting more than one rule, case or step is a list, not a
paragraph:

```ts
/**
 * Applies a pending change to the store.
 *
 * - a partial write keeps the fields it omits
 * - writing the tracked field bumps its revision, and nothing else does
 * - a change with no target is discarded rather than queued
 */
```

- **Always JSDoc `/** ... */`**, never a stack of `//` lines, for exported
  functions, hooks, types and non-obvious members.
- **Use the `@`-tags, and use them fully:**
  - `@param` for every positional parameter;
  - `@returns`, present even when the return type is `void`;
  - `@template` for every generic parameter;
  - `@throws` and `@deprecated` where they apply.
- **`@example` is forbidden.** A guard denies it outright.
- **A block covering more than one item must be a list, not a paragraph.**
  Members, rules, cases and steps go in `-` bullets or a numbered `Flow:`.
  Continuous prose is only for a single, genuinely continuous explanation,
  and it may run long in that case — prose that is really an unlabelled
  enumeration is what this rule rejects.
- **Every member of a type, interface or class carries its own inline
  `/** ... */`, with a blank line between each comment and its member:**

  ```ts
  /** comment */
  property;

  /** comment */
  property;
  ```

  The blank line is not cosmetic — a comment block glued directly to the
  next member reads as porridge. Listing the members in the block above the
  type instead of on themselves is wrong: an IDE shows nothing when hovering
  a field that way, only when hovering the type.
- **The type's own block stays a short summary** — what the thing is, and a
  why-sentence if one is needed. It must not re-list members that are
  already documented on themselves.
- **State behaviour, not usage.** No "useful for X" pitches, and no
  enumerating the screens, editors or cases where something happens to
  matter.
- **The same applies to a plain object exported as a namespace of
  helpers**: each key carries its own inline block, and the object itself
  gets a short summary rather than a re-listing of its keys.

## Backend (.NET)

- **`/// <summary>`**, with `<param>`, `<returns>`, `<typeparam>` and
  `<exception>` as they apply.
- **A JSDoc-style `/** ... */` block in a `.cs` file is wrong.** A guard
  denies it.
- The same brevity and the same no-usage-pitch rule as the frontend side
  apply — state what the member does, not where it happens to be called
  from.

## Never reference a ticket number in a source file

No ticket or work-item id anywhere inside a source file: not in a doc block,
not in an inline comment, not in a test name or a test comment, not in a
string. Not a `#`-prefixed number, not a `task_`-prefixed number, not a
sentence that names the regression by its tracker id.

Describe the actual behaviour or defect instead — a sentence describing what
the code does, or what actually went wrong, stays useful long after the
ticket has been closed and forgotten; the ticket id does not. Ticket ids
belong in the pull request and in the tracker, never in the code.

## Inline comments

Explain **why**, never restate what the line already says. Two or three
lines is the norm; about six lines is the ceiling. Anything longer belongs
in the JSDoc or XML doc of the thing being called, or does not belong in the
comment at all.

```ts
// Bad — restates the code.
// Increment the counter by one.
counter += 1;

// Good — explains a decision the code cannot show.
// The server counts a retry as a separate attempt, so the local counter has to
// advance before the request goes out or the two drift apart.
counter += 1;
```

**Delete commented-out code rather than leaving it behind** — version
control already remembers it, and a comment is not the place to keep it "just
in case".

**Never name a specific customer, screen or environment** in a comment or a
doc block, in either language. It leaks context that belongs outside the
source tree into shared code, and it goes stale the moment the screen is
renamed or the customer no longer matters — describe the behaviour instead.

## Anti-patterns

| Anti-pattern | Why it is rejected |
| --- | --- |
| A routine `@example` block | Rots fastest, duplicates the tests — this repository's guard denies it outright |
| A wall of prose describing several members or rules | Should be a list; unreadable as a paragraph |
| Listing a type's members in the block above the type | The IDE then shows nothing when hovering a member |
| Doc blocks packed with no blank line between members | Turns into a solid grey block |
| "Useful for the X screen", "use this when building Y" | Usage advice rots when callers change; describe behavior |
| Naming a specific customer, screen or environment | Leaks context into shared code, and it goes stale |
| Restating the code in words | Adds volume, not information |
| A summary that describes the file's history or a past bug | Belongs in the commit message |

## Where the load falls in a well-split component

Following [`component-structure.md`](./component-structure.md) changes
where documentation is worth writing, not just how it looks:

- **A component's own `types.ts` carries most of it** — every member of
  every exported type gets its own block, blank line between pairs.
- **The hook documents what it manages and what it returns.**
- **A utility documents its behaviour and its edge cases.**
- **The view usually needs only a one-line summary**, because by the time
  a component is well split there is little left in it that a reader
  cannot already see from the markup and the props it takes.

A well-split component needs *less* prose than a tangled one — the file
names, the types and the function signatures already carry information
that would otherwise have to be spelled out in a comment.

## Instructions for AI agents

If you are an AI coding assistant working in a repository this document
applies to, treat this document as binding and apply it without being asked
again in each prompt.

- Follow this document for every file created or modified. When modifying
  an existing file, bring the parts actually touched up to this standard —
  do not rewrite the documentation of untouched code in the same change,
  which buries the real diff.
- When the surrounding file already follows an older style, match this
  document, not the file.
- Prefer deleting a stale comment over updating it into something vague. A
  missing comment costs a reader one lookup; a wrong one costs a bug.
- If an instruction elsewhere genuinely conflicts with this document, the
  other instruction wins — but say plainly, in whatever reports the work,
  that this standard was departed from and why.

## Review checklist

Before requesting review:

- [ ] Every exported symbol has a doc block.
- [ ] Every parameter has `@param`; `@returns` is present.
- [ ] No `@example` the signature, the tags and the tests already cover.
- [ ] Every member of a changed type has its own doc block, separated by
      blank lines.
- [ ] No doc block is a paragraph where it should be a list.
- [ ] Inline comments explain why, and none exceeds a few lines.
- [ ] No commented-out code, no customer, screen or environment names.

## What is mechanically enforced

`core/guards/doc-comment-style.js` (and the equivalent Codex hook) denies
`@example`, a JSDoc-style `/** ... */` block in a `.cs` file, and a ticket or
work-item id anywhere in newly written content, outright. It asks for
confirmation on a prose-only doc block over roughly 18 lines, more than 6
consecutive `//` lines, or a `.cs` member that takes parameters or returns a
value whose XML doc block is missing `<param>` or `<returns>`. The length
checks are a deliberate backstop, not a substitute for judgement — a guard
cannot tell a genuine long explanation from an unlabelled enumeration by
line count alone, so the list-vs-prose call always stays with whoever is
writing or reviewing the code.

Not mechanically enforced: the blank line between a type's members, that a
type's own block does not re-list its members, `@param`/`@returns`
completeness on the frontend side (only the backend's `<param>`/`<returns>`
tags are checked), and the "state behaviour, not usage" rule. These stay a
review standard the guard cannot judge from written text alone.

---

# Testing

Status: Active — binding for new code.

## What the structure buys

Coverage tends to be lowest exactly where logic and rendering are welded
together, because there the only available test is to mount the whole
screen and interact with it — slow, brittle, and prone to failing for
reasons unrelated to what it is meant to assert.

Splitting a component the way
[`layer-boundaries.md`](./layer-boundaries.md) describes changes what a
test has to do:

| Layer | Test style | Needs a DOM? |
| --- | --- | --- |
| A utility | plain unit test, input to output | No |
| Constants | nothing to test | — |
| A component's hook | render the hook, assert state and calls | Minimal |
| The component itself | render, assert output and interaction | Yes |
| Composition of several components | integration test via a harness | Yes |

Most business rules end up in the top rows — utilities and hooks — where
tests are cheap, fast and stable. This is the practical payoff of the
whole component-structure standard: it is what makes reasonable coverage
reachable at all, rather than a target that keeps slipping.

## Tests are co-located

**Specs live inside the component's own folder**, in a `__tests__/`
subfolder next to the code they test:

```
OrderPanel/
  OrderPanel.tsx
  useOrderPanel.ts
  types.ts
  index.ts
  utils/
    canEditOrder.ts
  __tests__/
    OrderPanel.test.tsx
    useOrderPanel.test.ts
    canEditOrder.test.ts
```

This is what makes a component folder a genuinely self-contained
block — the view, its logic, its types, its utilities and the tests that
prove they all work, together in one place that can be moved, extracted or
deleted as a unit.

**A nested child component gets its own `__tests__/`, not coverage from
the parent's.** A child component is itself a component folder, following
the same recursive shape as its parent — see
[`component-structure.md`](./component-structure.md#a-grown-component-recursively) —
and that includes owning its own tests:

```
ShipmentBoard/
  __tests__/
    ShipmentBoard.test.tsx
    useShipmentBoard.test.ts
  components/
    ShipmentFilters/
      __tests__/
        ShipmentFilters.test.tsx
        useShipmentFilters.test.ts
    ShipmentRow/
      __tests__/
        ShipmentRow.test.tsx
```

Testing `ShipmentFilters` from inside `ShipmentBoard`'s spec file would
mean the child's behaviour is only exercised as a side effect of testing
the parent — it has no test of its own, and moving or extracting the child
later means untangling its coverage out of a spec file that is not about
it.

Why co-located rather than a central spec tree mirroring the project:

| Aspect | Co-located | Centralised |
| --- | --- | --- |
| Finding the test for a file | In the folder you are already in | Navigate to the mirror path |
| Moving or renaming code | Tests move with it, in one change | Two places to update; drift is easy and silent |
| Noticing a missing test | Obvious — the folder has no `__tests__` | Requires looking somewhere else |
| Extracting a component to a package | The folder is self-contained, tests included | Tests have to be located and carried separately |
| Cross-component or integration suites | No natural home | Natural home |

The one real cost — cross-component and integration suites belonging to
no single component — is accepted deliberately: those stay in a project's
central test tree. Only specs that test one component's own view, hook and
utilities move into its folder.

## What to test

- **Utilities: always.** Pure functions are cheap to test and this is
  where business rules tend to end up — there is no excuse for an
  untested one.
- **Hooks: the behaviour, not the implementation.** Assert what the
  returned state becomes and what side effects fire, not how many times
  the hook happened to render.
- **Components: what the user sees and does.** Query by role and visible
  text; do not assert on internal state or on a CSS class name, both of
  which can change without the user-visible behaviour changing at all.
- **Do not test:** constants, framework behaviour, or anything the
  compiler already guarantees.

Reuse a project's existing test infrastructure — shared render helpers,
data factories, mocks for the API layer, a store or translations — rather
than rebuilding it per spec. A hand-rolled mock of something the project
already provides is a duplicate that will drift and rot; see the
mandatory-reuse principle in [`principles.md`](./principles.md).

## One test, one behaviour

A test that validates more than one behaviour at once should be split —
one test, one thing, same as the file-level principle in
[`principles.md`](./principles.md) applied at the scale of a test.

## Test naming

Names describe **behaviour**, in plain language: `returns canEdit false
for a pending order owned by another user`, not `test1` or
`checkPermissions`. Descriptive, specific, and free of the placeholder
names that tell a reader nothing.

No convention is inherited here, because there is none to inherit: the
wider organisational material offers several competing naming *patterns*
and picks none of them. Choosing a winner on its behalf would be inventing
an agreement, so this rulebook states the principle and deliberately
leaves the literal syntax unenforced.

The patterns that material lists are aimed at test methods in a
compiled-language suite (a
`MethodUnderTest_Condition_ExpectedResult` form, a
`Should_ExpectedResult_When_Condition` form, and a scenario form). None of
those is mandated here as a literal syntax: in a frontend test runner the
description string passed to the test already states the condition and
the expected outcome in natural language, which is what those patterns are
reaching for. What carries over is the underlying principle, not the
punctuation — be descriptive, be specific, and never generic.

**Never a ticket number, and never a real customer or screen name**, in a
test name, a test file, or a comment inside one.

Spec files themselves follow [`naming.md`](./naming.md): the subject's
name plus `.test.ts` or `.test.tsx` — `useOrderPanel.test.ts`.

## Coverage

**There is a coverage expectation for newly added features and
components, scoped to new and touched code — never a repository-wide
percentage.** A whole-project threshold on a codebase with a large
untested history mostly measures the backlog rather than the work in
front of a reviewer: it sits permanently below any useful number, barely
moves when a team does everything right, and says nothing about whether
the specific change under review is tested. Scoped to new work, the same
kind of gate becomes both reachable and informative.

This requires a **per-scope coverage mechanism** — coverage computed for a
new feature, a new component, or a changed set of files, not only as one
whole-project figure. Building or configuring that mechanism, and agreeing
the actual percentage numbers and a start date, is project-specific work
and is not specified here.

**Run the full test suite locally before committing.** This is not
optional, and it is not the same thing as the pipeline gate: it catches a
failure at the point where it is cheapest to fix, before it reaches
review or a shared branch.

## What is enforced

- `colocated-tests` checks that a new spec is placed inside the folder of
  the code it tests, in `__tests__/`.
- The specific coverage percentage and its start date are project
  configuration, not something this document or its guards fix a number
  for.

---

# Rules for an AI coding agent

Status: Active — binding for new code, and enforced by guards in this
repository rather than left as documentation alone.

The other documents in this directory describe what the code should look
like. This one describes how an AI agent should behave while producing it —
a different, narrower question, and one worth answering explicitly, because
most of the team now writes code with agent assistance, and a convention
that only holds when a person is typing is not actually a convention.

## Why this needs to be explicit

An agent's failure mode is specific and predictable. Given too little
context, it produces something **plausible**: a utility that duplicates
one that already exists a few folders away, a call to an endpoint that
does not exist, a store field invented because the real one could not be
located, a convention guessed at from a file name. The output is
confidently, locally reasonable, and globally wrong — and an agent
produces a lot of it, quickly. Left unchecked, an agent will grow exactly
the problems the rest of this rulebook exists to remove, faster than a
person could review them away.

The fix is unglamorous: an agent follows a rule it can read and act on.
What it cannot do is infer an unwritten convention correctly, and it will
not reliably say "I don't know" instead of guessing unless that is the
explicit expectation.

## Analyse before writing

Read the surrounding code and the relevant standards before making a
change. A plausible-looking guess that does not match how the rest of the
codebase actually works is worse than pausing to check, because it looks
correct in review and fails later, somewhere the reviewer was not looking.

## Never invent a fact about the codebase

No invented endpoints, DTO or store fields, configuration keys, component
props, or file paths. If something cannot be found after a real search,
say so and ask, rather than filling the gap with something that looks
right. A stated gap costs a question; a fabricated one costs a debugging
session, and it costs it to whoever hits the mismatch later, not to the
agent that introduced it.

This includes reading the code as authority for what it currently
**does** — never inferring behaviour from a file's name, a comment, or
what a similar-looking file elsewhere happens to do.

## Reuse before writing new

The same mandatory-reuse rule that applies to any contributor in
[`principles.md`](./principles.md) applies to an agent, and matters more
for one: search the immediate location, the parent, the project's shared
folders, and any shared package, before adding a new helper, hook, type,
component or constant. An agent that is not explicitly told to search
first will not reliably do it on its own, because generating something new
is cheaper for the agent than finding something old — even when it is not
cheaper for the project.

## Retargeting the app to a local machine

Asked to point a running app at a developer's own machine — a different
API host, a different port — an agent edits the project's per-machine
configuration file, never the tracked one. See
[`local-dev-config.md`](./local-dev-config.md) for which file that is in a
project that has adopted the split, and why: the tracked file ships in
every build and reaches everyone who pulls the base branch, and a local
host committed there is exactly the mistake this rule exists to prevent.

An agent never stages or commits a tracked config file that names a local
host, whichever command does the staging — `git add` of the file
specifically, a blanket `git add -A`/`.`, or `git commit -a`. If a tracked
config file is already dirty with a local value for a reason unrelated to
the current change, that is worth surfacing to the developer rather than
committing around it.

## Delegation and model tier

Where an agent orchestrates other agents:

- **Analysis, architecture decisions and verification stay with the
  strongest model driving the session.** Routine, well-specified execution
  can be delegated to a cheaper or faster model, but deciding what is true
  about the codebase and what the right change is is never delegated —
  only the typing and mechanical execution of an already-made decision is.
- **A subagent is never silently escalated above the tier the current
  session itself is running at.** Every delegation states its model
  explicitly; there is no default that quietly inherits a stronger model
  than intended.
- **Escalating to a frontier-tier model for a subagent requires the
  developer's explicit approval for that specific task**, with a stated
  reason. An agent does not reach for the strongest available model on its
  own initiative just because a task looks hard.
- **A task's reasoning effort is never silently lowered** to finish
  faster; effort is raised for harder or higher-risk work, never dropped
  below the floor the infrastructure sets to save time.

## Never touch the agent-governance infrastructure to route around a rule

Hooks, guard configuration and settings that back this rulebook are not
something an agent edits or disables to get past a denial. A denial states
the fix; the fix is to follow the rule, not to find a way past the check
that would have caught the mistake.

## Report clearly

State what was reused versus what was written from scratch, what could
not be found, and any deliberate departure from a rule in this directory
and why. A report that only says "done" forces a reviewer to
reverse-engineer what the agent assumed; a report that names the
assumptions lets the reviewer check the one thing that actually needs
checking.

## What is enforced

- `reuse-before-new` can prompt when a change looks like a near-duplicate
  of existing code, backing the reuse-before-writing rule above.
- `subagent-model` checks that a delegated task states its model
  explicitly and does not exceed the session's own tier without approval.
- `reasoning-effort-floor` checks that a task is not dropped below the
  configured minimum reasoning effort.
- `infra-self-protection` guards the hooks, guard configuration and
  settings this rulebook is backed by, against being edited or disabled
  to bypass a denial.

---

# Git flow

Status: Active — binding

The team-wide git flow that the shared guards (`guard-shell.js` and its
Codex equivalent) may enforce, across every repository this infrastructure is
installed into. It is deliberately looser than any one person's personal
workflow — see the per-repository notes under `docs/projects/` for anything
stricter that an individual has adopted for their own work.

## Enforcement is unavoidable

This is a condition of the whole rulebook, not a detail of one section of
it: a rule here is worth having only if a project's pipeline actually
applies it. Once a gate described in this document is turned on, there is
no path that lets a change skip it, including an urgent fix. Which branch
is protected, and how that is configured, is implementation detail, project
by project; that it cannot be bypassed is not.

## Branch naming

A branch name should read as `{feature|bugfix}/<ticket>_<short_description>`,
lower-cased, where:

- the separator between the type and the description is `_` or `-` — both
  appear on real branches and neither is wrong;
- the ticket appears as `task_{number}`, `ticket_{number}`, or a bare number;
- the description is a short, lower-case, human-readable summary.

**This is enforced as ASK, never DENY.** Real branches on origin legitimately
vary — `feature/dt_editor_fundamentals`, `cleanForm` both exist and are not
mistakes.
A branch outside the preferred form makes the guard show the preferred form
and let the developer proceed deliberately. The guard exists to catch an
agent being careless, not to stop a person who has a reason.

One ticket may legitimately cover several branches; a repeated ticket number
across branches is not itself evidence of a naming error.

## Keeping a branch current

Rebasing the branch onto its base is the preferred way to keep it current,
and produces a linear history that is easier to review and to rebase again
later. Merging the base into the branch is discouraged but **not hard
forbidden** — a guard may prompt before it, not deny it.

## Reaching the base branch

- Merging locally into a base branch, and force-pushing to one, are
  **forbidden**. There is no legitimate case for either in this flow.
- Everything reaches a base branch through a pull request, merged with a
  **squash merge**. This is the hard line the guards enforce as a denial.

## Base branches are per-repository configuration

There is no single, organisation-wide base branch. One repository uses
`master`; another may use `main`, `dev`, or something else entirely. A guard, a skill, or a piece of documentation that
hard-codes a base branch name is wrong by construction — it must read the
base from that repository's `projects/<RepositoryName>.json`. See
`docs/projects/*/README.md` for what each repository currently uses.

## Release branches

Release branches follow the real repositories, not a generic template:
`releases/<version>`, plural — for example `releases/25.3`, `releases/25.3.4`,
`releases/26.1`, `releases/26.2`.

## Tags

Per-patch tags are not documented as practice here. At least one repository
in scope has effectively stopped tagging patches individually — do not assume
or enforce a tag-per-patch convention unless a specific repository's own
documentation says otherwise.

## Where the wiki disagrees

The organisation wiki's own `Git Workflow` page describes a different flow:
a single `dev` base with no mention of any other base branch, feature
branches named `feature/<ticket-number>-short-description`, local
`git merge` / `git rebase` kept current with `git push --force-with-lease`,
and singular `release/<version>` branch names.

None of that matches what the real repositories do today. This document
takes the repositories as the authority and treats the wiki page as pending
correction, not as a second, competing source of truth. This is not a
criticism of whoever wrote it — conventions drift, and the page has simply
not been updated to match. Until it is, an agent following this
infrastructure should follow this document, not the wiki.

---

# Projects without TypeScript

Status: Active — binding for new code in a project whose source is
JavaScript.

The rest of this rulebook is written in TypeScript, because most of the
projects it was written against are. That is a choice of example, not a
precondition: **every structural rule here applies unchanged to a JavaScript
project**, and this document says what changes for the handful that lean on
the type system, so nobody has to decide it per file.

Read it alongside [`types.md`](./types.md), which stays the reference for
what a contract is and why it has to be accurate. Nothing below relaxes
that; it only says how it is expressed when the compiler is not there to
check it.

## What is unchanged

Almost all of it, and this is the important half:

- The component folder — its own directory, the view, its `use<Component>`
  hook, its barrel — see
  [`component-structure.md`](./component-structure.md).
- The view/hook/utility split and every layer boundary — see
  [`layer-boundaries.md`](./layer-boundaries.md).
- Naming, file size, promotion on the second consumer, colocated tests,
  where state belongs, how a backend call is made, the import rules in
  [`module-imports.md`](./module-imports.md).

The guards enforce these on `.js` and `.jsx` exactly as they do on `.ts` and
`.tsx`. A `use*.jsx` file is a hook; an `index.js` is a barrel; a `.jsx`
component file is judged against PascalCase. There is no second, laxer
standard for a JavaScript project, and a project should not read one into
the absence of a compiler.

## What changes: `types.ts` becomes documentation, not enforcement

TypeScript's `types.ts` does two jobs at once — it tells a reader the shape
and it stops the compiler accepting a wrong one. Without the compiler only
the first job is available, and it is still worth doing.

**A JavaScript project writes the shape down in a JSDoc `@typedef`**, in the
same file the rulebook would have put `types.ts` in, colocated with what it
describes and promoted on the second consumer like anything else:

```js
// OrderPanel/types.js

/**
 * Props accepted by the order panel.
 *
 * @typedef {object} OrderPanelProps
 * @property {string} orderId Identifier of the order to display.
 * @property {(order: Order) => void} [onSaved] Called after a successful save.
 */

/**
 * State and handlers the order panel view renders from.
 *
 * @typedef {object} UseOrderPanelResult
 * @property {Order | null} order Loaded order, or `null` until the request resolves.
 * @property {boolean} isLoading Whether the order request is in flight.
 * @property {boolean} canEdit Whether the current user may edit this order.
 * @property {(values: OrderFormValues) => Promise<void>} save Persists the edited values.
 */

export {};
```

This is not ceremony for its own sake. An editor reads `@typedef` and gives
real completion and real go-to-definition from it, `// @ts-check` turns it
into an actual check without adopting TypeScript, and — the part that
matters most in practice — it is the only place a reader can find out what a
hook returns without reading the hook.

Two things follow:

- **The contract rules in [`types.md`](./types.md) still bind.** A backend
  shape is still mirrored exactly, still filed centrally by service, still
  one DTO per file, still never carries a UI-only field. What it loses is
  the compiler telling you when it drifts — which makes the discipline more
  important, not less.
- **`no-explicit-any` has nothing to check** and stays silent. A project
  with no contract-type files declares no `conventions.contractTypes`, and
  the rule is inert by design rather than by accident. This is the one place
  the absence of TypeScript genuinely removes a guarantee, and it is worth
  being honest that nothing replaces it.

## What changes: props have no compiler behind them

An inline destructured signature — `({ orderId, onSaved }) => …` — is
readable but says nothing about what those are or whether either is
required. Since nothing checks it:

- **Document the props type as a `@typedef` and reference it** with
  `@param {OrderPanelProps} props` on the component, so the shape has one
  named home a test or a wrapper can point at. This is the JavaScript form
  of the rule in [`types.md`](./types.md) that props are a named, exported
  type rather than an inline literal.
- **Validate at the boundary you do not control**, not everywhere. Data
  arriving from an API, from storage, or from a URL is unchecked in a
  JavaScript project in a way it is not in a TypeScript one. Narrow it once,
  where it enters — in the hook or a utility — rather than defending against
  a missing field at twenty render sites.

## What changes: the barrel exports values only

`export type *` has no JavaScript equivalent, so a barrel re-exports values
and nothing else. A `@typedef` is reachable through the file that declares
it (`import('./types').OrderPanelProps`), which is the closest available
form and needs no barrel entry.

Everything else about the barrel is unchanged: re-exports only, no logic,
and it is still the folder's public surface —
[`component-structure.md`](./component-structure.md).

## Adopting TypeScript later

Nothing here is an argument against doing so, and the structure this
rulebook asks for is most of the work of getting there: a project whose
components are already split into a view, a hook and pure utilities, with
shapes already written as `@typedef`, converts file by file. A project whose
logic is welded into 1,000-line views does not, whatever its file
extensions.

If a project does adopt it, `types.js` becomes `types.ts`, the `@typedef`
blocks become real declarations, and nothing else in this rulebook changes —
which is the point of writing the structural rules independently of the
language in the first place.

## What is enforced

- Every frontend guard reads `.js` and `.jsx` alongside `.ts` and `.tsx`:
  `component-folder-shape`, `component-view-logic`, `barrel-exports-only`,
  `hook-locality`, `colocated-tests`, `naming-standards` (under
  `conventions.language: "javascript"`), `file-size-limit`, `import-depth`
  and `api-import-boundary`.
- `component-types-file` is TypeScript-only by nature — it looks for an
  inline `interface`/`type` declaration, and JavaScript has neither. The
  convention it encodes (shapes belong in the folder's own types file) still
  holds; it is review-enforced here.
- `no-explicit-any` is inert, as described above.

---

# Migration approach

Status: Active — binding for new code.

The general shape of how a project moves toward this rulebook, independent
of any one project's own backlog. A project's actual scheduled work — which
files, in what order, on what evidence — is project-specific and belongs in
that project's own docs (for example
`docs/projects/<repository>/migration-backlog.md`), not here.

## No big-bang refactor

Rewriting the largest, most tangled part of a codebase in one pass produces
a diff nobody can meaningfully review, on a branch that cannot be kept
current against a fast-moving base, with a regression surface covering
whatever that part does. The approach instead is incremental, and it is not
allowed to block feature work — a team does not stop shipping to adopt this
rulebook.

## Phase 0 — Agree and record

Publish the rulebook a project is adopting, add that project's own agent
rulebook and pointer file (see [`agent-rules.md`](./agent-rules.md)), and the
shared agent configuration. No application code changes in this phase.

## Phase 1 — New code only

Every new component, store, hook and service that needs more than one file
follows the pattern from day one. This is the cheapest phase: it costs
nothing beyond what would be written anyway, and it stops the problem
growing while the rest of the plan catches up.

## Phase 2 — The Boy Scout rule on touched code

When a file that predates the rulebook is opened for unrelated work, the
part actually touched is brought up to it: the logic being modified moves
into a hook or a utility, a type being changed gets a proper home, a test is
added for what was extracted, an `index.ts` is added if the folder is
missing one.

Two things this phase explicitly does **not** allow:

- **Restructuring code that is not otherwise being changed does not belong
  in the same change.** It buries the real diff and makes review
  impossible.
- **A behaviour-preserving refactor and a behaviour change must not share a
  change.** A bug found while refactoring gets its own, separate change.

## Phase 3 — Scheduled refactors

The largest, highest-risk, highest-change-frequency files get their own
scheduled work, estimated and prioritised like any other feature, rather
than left to whoever happens to open them next. Order of extraction within
each one, in order of preference:

1. **Pull the logic out first** — state and rules into a hook, pure
   functions into a utility. On the largest files this alone removes most
   of the volume and requires no change to what is actually rendered.
2. **Then extract child components**, along the seams the UI already has.
3. **Then extract shared hooks**, where two of the new child components
   need the same behaviour.
4. **Only then consider splitting the view itself further**, if it is still
   large after the above.

Doing this in the reverse order — cutting markup into fragments while the
logic underneath stays tangled — produces more files with exactly the same
coupling, which is worse than the one large file it replaced.

A refactor in this phase is done when: the folder follows the agreed
pattern with a barrel that only re-exports; no file in it is above the
agreed size threshold, or is on the documented exception list with a
reason; extracted utilities and hooks have tests; public behaviour is
unchanged; and any existing specs for the file have moved to the agreed
location and still pass.

## Phase 4 — Gate the new work

Build a per-scope (per-feature, per-changed-file) coverage mechanism, then
switch on a pipeline coverage gate for newly added features and components
only. There is deliberately no repository-wide coverage threshold and no
ratchet planned — a whole-codebase percentage on a tree with a large
untested history mostly measures the backlog rather than the work in front
of a reviewer. Numbers and a start date are project-specific decisions, not
fixed here — see [`testing.md`](./testing.md#coverage).

## What is enforced

- Nothing in this repository's guard set enforces the phase a project is
  in; the phases are a planning tool, not a checkable rule. The rules each
  phase eventually turns on — file size, colocated tests, the coverage gate
  itself — are enforced as described in the documents that define them.
