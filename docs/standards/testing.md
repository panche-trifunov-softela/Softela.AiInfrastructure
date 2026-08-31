# Testing

Status: Active — binding for new code.

## What the structure buys

Coverage tends to be lowest exactly where logic and rendering are welded
together, because there the only available test is to mount the whole
screen and interact with it — slow, brittle, and prone to failing for
reasons unrelated to what it is meant to assert.

Splitting a component the way
[`layer-boundaries.md`](./layer-boundaries.md) describes changes what a
test has to do:

| Layer | Test style | Needs a DOM? |
| --- | --- | --- |
| A utility | plain unit test, input to output | No |
| Constants | nothing to test | — |
| A component's hook | render the hook, assert state and calls | Minimal |
| The component itself | render, assert output and interaction | Yes |
| Composition of several components | integration test via a harness | Yes |

Most business rules end up in the top rows — utilities and hooks — where
tests are cheap, fast and stable. This is the practical payoff of the
whole component-structure standard: it is what makes reasonable coverage
reachable at all, rather than a target that keeps slipping.

## Tests are co-located

**Specs live inside the component's own folder**, in a `__tests__/`
subfolder next to the code they test:

```
OrderPanel/
  OrderPanel.tsx
  useOrderPanel.ts
  types.ts
  index.ts
  utils/
    canEditOrder.ts
  __tests__/
    OrderPanel.test.tsx
    useOrderPanel.test.ts
    canEditOrder.test.ts
```

This is what makes a component folder a genuinely self-contained
block — the view, its logic, its types, its utilities and the tests that
prove they all work, together in one place that can be moved, extracted or
deleted as a unit.

**A nested child component gets its own `__tests__/`, not coverage from
the parent's.** A child component is itself a component folder, following
the same recursive shape as its parent — see
[`component-structure.md`](./component-structure.md#a-grown-component-recursively) —
and that includes owning its own tests:

```
ShipmentBoard/
  __tests__/
    ShipmentBoard.test.tsx
    useShipmentBoard.test.ts
  components/
    ShipmentFilters/
      __tests__/
        ShipmentFilters.test.tsx
        useShipmentFilters.test.ts
    ShipmentRow/
      __tests__/
        ShipmentRow.test.tsx
```

Testing `ShipmentFilters` from inside `ShipmentBoard`'s spec file would
mean the child's behaviour is only exercised as a side effect of testing
the parent — it has no test of its own, and moving or extracting the child
later means untangling its coverage out of a spec file that is not about
it.

Why co-located rather than a central spec tree mirroring the project:

| Aspect | Co-located | Centralised |
| --- | --- | --- |
| Finding the test for a file | In the folder you are already in | Navigate to the mirror path |
| Moving or renaming code | Tests move with it, in one change | Two places to update; drift is easy and silent |
| Noticing a missing test | Obvious — the folder has no `__tests__` | Requires looking somewhere else |
| Extracting a component to a package | The folder is self-contained, tests included | Tests have to be located and carried separately |
| Cross-component or integration suites | No natural home | Natural home |

The one real cost — cross-component and integration suites belonging to
no single component — is accepted deliberately: those stay in a project's
central test tree. Only specs that test one component's own view, hook and
utilities move into its folder.

## What to test

- **Utilities: always.** Pure functions are cheap to test and this is
  where business rules tend to end up — there is no excuse for an
  untested one.
- **Hooks: the behaviour, not the implementation.** Assert what the
  returned state becomes and what side effects fire, not how many times
  the hook happened to render.
- **Components: what the user sees and does.** Query by role and visible
  text; do not assert on internal state or on a CSS class name, both of
  which can change without the user-visible behaviour changing at all.
- **Do not test:** constants, framework behaviour, or anything the
  compiler already guarantees.

Reuse a project's existing test infrastructure — shared render helpers,
data factories, mocks for the API layer, a store or translations — rather
than rebuilding it per spec. A hand-rolled mock of something the project
already provides is a duplicate that will drift and rot; see the
mandatory-reuse principle in [`principles.md`](./principles.md).

## One test, one behaviour

A test that validates more than one behaviour at once should be split —
one test, one thing, same as the file-level principle in
[`principles.md`](./principles.md) applied at the scale of a test.

## Test naming

Names describe **behaviour**, in plain language: `returns canEdit false
for a pending order owned by another user`, not `test1` or
`checkPermissions`. Descriptive, specific, and free of the placeholder
names that tell a reader nothing.

No convention is inherited here, because there is none to inherit: the
wider organisational material offers several competing naming *patterns*
and picks none of them. Choosing a winner on its behalf would be inventing
an agreement, so this rulebook states the principle and deliberately
leaves the literal syntax unenforced.

The patterns that material lists are aimed at test methods in a
compiled-language suite (a
`MethodUnderTest_Condition_ExpectedResult` form, a
`Should_ExpectedResult_When_Condition` form, and a scenario form). None of
those is mandated here as a literal syntax: in a frontend test runner the
description string passed to the test already states the condition and
the expected outcome in natural language, which is what those patterns are
reaching for. What carries over is the underlying principle, not the
punctuation — be descriptive, be specific, and never generic.

**Never a ticket number, and never a real customer or screen name**, in a
test name, a test file, or a comment inside one.

Spec files themselves follow [`naming.md`](./naming.md): the subject's
name plus `.test.ts` or `.test.tsx` — `useOrderPanel.test.ts`.

## Coverage

**There is a coverage expectation for newly added features and
components, scoped to new and touched code — never a repository-wide
percentage.** A whole-project threshold on a codebase with a large
untested history mostly measures the backlog rather than the work in
front of a reviewer: it sits permanently below any useful number, barely
moves when a team does everything right, and says nothing about whether
the specific change under review is tested. Scoped to new work, the same
kind of gate becomes both reachable and informative.

This requires a **per-scope coverage mechanism** — coverage computed for a
new feature, a new component, or a changed set of files, not only as one
whole-project figure. Building or configuring that mechanism, and agreeing
the actual percentage numbers and a start date, is project-specific work
and is not specified here.

**Run the full test suite locally before committing.** This is not
optional, and it is not the same thing as the pipeline gate: it catches a
failure at the point where it is cheapest to fix, before it reaches
review or a shared branch.

## What is enforced

- `colocated-tests` checks that a new spec is placed inside the folder of
  the code it tests, in `__tests__/`.
- The specific coverage percentage and its start date are project
  configuration, not something this document or its guards fix a number
  for.
