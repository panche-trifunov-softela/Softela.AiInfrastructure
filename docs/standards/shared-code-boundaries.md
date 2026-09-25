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

## The trigger is one file, one job — not a size crossed later

Every example above is phrased as something a module "gets" once it has
grown: a store's pure parts pulled out after the fact, a hook's own
vocabulary of types split off once it exists. Read on its own, that reads
as permission to wait for the growth before splitting anything.

It is not. The trigger is the same one-file-one-job question, asked at the
moment a store, a context or a root-level hook is created — does the first
version already mix state, derivation and types in one place — not a line
count crossed afterwards.
[`migration-approach.md`](./migration-approach.md#phase-1-new-code-only)
already states this directly: every new component, store, hook and service
that needs more than one file follows the pattern from day one. A module
written flat and split apart later is a rewrite of something that could
have been shaped correctly on its first pass, at no extra cost.

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
