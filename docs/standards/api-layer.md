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
