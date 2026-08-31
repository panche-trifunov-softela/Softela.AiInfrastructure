---
name: frontend-types-mirror-backend
description: Standing rule — frontend property types mirror the backend property records one-to-one; never hoist shared members into a frontend-only base
metadata:
  type: project
  source: softela-ai
---

## Rule — the frontend type must look like the backend record it mirrors

`Softela.ReactSCExpert` `src/types/appComponents/*Properties` interfaces mirror
the `Softela.SCExpert` `UI/Abstractions/AppComponents/*.cs` property records.
Keep the correspondence **literal**:

- A member declared separately on N backend records is declared separately on
  the N matching frontend interfaces — **even when that duplicates it.**
- Do **not** invent a frontend-only base interface to factor shared members out,
  however tempting the de-duplication looks.
- The backend grouping a constant under `Constants.SharedAppComponentPropertyNames`
  is **not** evidence of a shared base type. Those are property-name strings; the
  records still declare each member individually.

**Why:** the two repos are supported together, and the person changing one side
reads the other side to know what to change. A frontend-only base breaks the
one-to-one mapping, so a backend member no longer has an obvious counterpart and
the mirror stops being mechanically checkable.

**How to apply:** when a new backend property lands on several records, add it to
each matching frontend interface at the position its neighbours already occupy —
do not reorder pre-existing members while you are there. If some consumer needs
to read the member generically across those types, express that at the **consumer**
(a local union of the concrete AC types, or a cast), never by reshaping the
mirrored types.

## Precedent — a hoisting attempt was rejected

Established when a hoisting attempt was rejected during work adding
refresh-trigger support to several app components. A backend
commit (`f3672acd`) added `string[]? RefreshTriggers` to four records (Gauge,
NumericInfoBox, QuickChart, TableEditor). The frontend port hoisted it
together with the four-times-duplicated `refreshInterval` into a new
`RefreshableAppComponentProperties`; frontend types are kept matching backend
types, because that is what makes the two sides simple to support together.
Reverted: the shared type was deleted, each interface got its own
`refreshTriggers: Nullable<string[]>;`, and `AppComponentRenderer.tsx` reads
it via a local `RefreshableAppComponent` union of the four AC types.

See also [[frontend-types]] and [[frontend-code-placement]].
