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
