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
