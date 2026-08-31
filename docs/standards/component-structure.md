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
