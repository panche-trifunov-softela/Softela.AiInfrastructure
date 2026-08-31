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
