---
description: Add a backend call the agreed way — shape taken from the backend, route from a constant, typed end to end, reached only through a hook.
argument-hint: "<what the call does> [controller or endpoint]"
allowed-tools: Read, Write, Edit, Glob, Grep
---

Add a backend call, following `docs/standards/api-layer.md` and
`docs/standards/types.md`.

$ARGUMENTS

This is the workflow with the highest hallucination rate of the three, and
the failures are always the same two: an endpoint that does not exist, and a
response shape that is close but wrong. Both look completely plausible in
review and neither fails until a user opens the screen.

## 1. Take the shape from the backend. Never from another frontend file

**The backend is the source of truth.** Not a nearby frontend service that
"does something similar" — copying that only propagates whatever was already
wrong with it.

In order:

1. **The API documentation** — swagger or its equivalent. Fastest, and right
   most of the time.
2. **The backend's own controller and DTO**, when the document is ambiguous,
   when a shape looks too convenient, or when nullability matters. Generated
   documentation routinely gets nullability wider or narrower than the
   controller behaves, flattens inherited shapes, and prints a bare object
   where a real type exists.

Where the two disagree, **the code wins**, and the discrepancy is worth
reporting to the backend team.

**If you cannot find the endpoint, stop and say so.** Do not infer a route
from a naming pattern, do not invent a field because the UI needs one, and
do not guess at an enum's values. A stated gap costs one question; a
fabricated one costs a debugging session, and the person paying for it will
not be you.

## 2. Route as a constant

No string-literal URL in a new API method. Add it to the project's endpoint
constants file, grouped by controller, and **spell the segment exactly as
the backend exposes it** — casing included. The string is not ours to
normalise.

The payoff: a rename is one edit, a typo is a build error instead of a
runtime 404 on one screen, and the file becomes a readable inventory of what
the frontend actually consumes.

## 3. One file per controller, in the API layer

Named after the backend controller, not after the screen that happens to
call it. Organising by feature is what makes the same controller get two
half-implementations by two different features.

Check first whether the controller already has a file, and whether the call
you are about to add already exists there under another name.

## 4. Type it end to end

- **Explicit parameter and return types.** Inferring from the HTTP client
  yields `any` and quietly un-types everything downstream of the call.
- **Request and response types come from the project's contract-type
  location**, filed by service — not a local interface, not an inline object
  literal (`docs/standards/types.md`).
- **Mirror the contract exactly**: field names, casing, optionality,
  nullability, enum values. A type nicer than reality lies precisely where
  the runtime will disagree with it.
- **Never `any` in a contract type.** It disables the only check that the
  two sides still agree.
- On a JavaScript project the shape is a `@typedef` and the discipline is
  identical — there is simply nothing checking it, which makes it matter
  more (`docs/standards/javascript-projects.md`).

## 5. Keep the layers straight

- **Everything goes through the shared transport.** No bare HTTP client in
  feature code: base URL, auth, caching, error handling and cancellation are
  centralised, and a direct call silently opts out of all of them.
- **No business logic and no UI concern inside an API method.** Request in,
  typed response out. Mapping a DTO into something the UI wants is the job
  of a hook or a utility.
- **No API call from a component.** Components call hooks; hooks call the
  API layer. This is what keeps the view testable without a network mock,
  and `api-import-boundary` denies the shortcut.
- **The API layer never imports from a component.** If a shape is needed on
  both sides, it moves to the shared types location.

## 6. Report

- Where you got the contract from — the document, the controller, or both —
  and any place the two disagreed.
- Anything you could not find and therefore did not write.
- The files you changed.
