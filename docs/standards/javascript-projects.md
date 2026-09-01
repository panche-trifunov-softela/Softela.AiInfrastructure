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
