---
name: frontend-types-mirror-backend
description: Standing rule — a frontend contract type mirrors the backend record one-to-one; never hoist shared members into a frontend-only base the backend does not have
metadata:
  type: reference
  source: softela-ai
---

## Rule — the frontend type looks like the backend record it mirrors

Where frontend interfaces mirror backend property records, keep the
correspondence **literal**:

- A member declared separately on N backend records is declared separately on
  the N matching frontend interfaces — **even when that duplicates it.**
- Do **not** invent a frontend-only base interface to factor shared members
  out, however tempting the de-duplication looks.
- A backend grouping shared property *names* under some constants class is
  **not** evidence of a shared base type. Those are strings; the records still
  declare each member individually.

This is not in tension with mirroring a real backend hierarchy with `extends`
(`docs/standards/types.md`). Mirror the inheritance the backend actually has;
do not introduce one it does not.

**Why:** the two sides are supported together, and whoever changes one reads
the other to know what to change. A frontend-only base breaks the one-to-one
mapping, so a backend member no longer has an obvious counterpart and the
mirror stops being mechanically checkable.

**How to apply:** when a new backend property lands on several records, add it
to each matching frontend interface at the position its neighbours already
occupy — and do not reorder pre-existing members while you are there. If some
consumer needs to read the member generically across those types, express that
at the **consumer** (a local union of the concrete types, or a cast), never by
reshaping the mirrored types.

## Precedent — a hoisting attempt was rejected

Established when a hoisting attempt was rejected during work adding
refresh-trigger support to several components. A backend commit added an
optional `string[]` refresh-trigger member to four records. The frontend port
hoisted it, together with an interval member already duplicated four times,
into a new shared "refreshable" base type. That was reverted: the shared type
was deleted, each interface got its own declaration back, and the one
component that needed to read the member across all four did so through a
local union of the concrete types.

The reasoning generalises past that one case, which is why it is written down
as a rule rather than as a note about four types.
