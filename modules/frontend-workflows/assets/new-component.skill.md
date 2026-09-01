---
name: "new-component"
description: "Create a new frontend component folder to the team's architecture standard — the view, its own hook, its types file and its barrel — starting with a mandatory search for what already exists. Use when asked to add, create or scaffold a React component, screen, panel, dialog or page. Do not use it to modify an existing component, to split one that has grown too large (that is split-component), or on a backend project."
---

# New component

Create a new component folder, following `docs/standards/component-structure.md`.

The guards will refuse a folder shaped wrongly, so the point of this
procedure is not to satisfy them — it is the two steps before the shape,
which nothing can check for you.

## 1. Find out whether it should exist

**Do this before writing anything.** The single most common failure here is
a component that duplicates one three folders away, and it is invisible in
review because the new file looks fine on its own.

Search, in this order, and report what you found:

1. The parent folder's own `components/`.
2. The project's shared components root, by name **and by what it does** —
   a `SearchBar` may already exist as `TableSearch`.
3. `utils/` and `hooks/` at both levels, for the logic you were about to
   write.
4. Any shared package the project depends on.

If something close already exists, **stop and say so.** Extending it, or
lifting it one level per `docs/standards/component-structure.md`'s promotion
rule, is nearly always the right answer, and it is the developer's call —
not yours to make silently by writing a second one.

## 2. Decide where it goes

- **One consumer → inside that consumer's folder**, under its
  `components/`. A screen is a consumer like any other; do not put a
  screen's only dialog in a parallel tree
  (`docs/standards/shared-code-boundaries.md`).
- **Two or more consumers → the shared components root**, at the lowest
  level that covers them all.

Ask the developer if the answer is genuinely unclear. Do not default to the
shared root because it might be reused one day — that is the "second guess"
the promotion rule exists to rule out.

## 3. Write the folder

```
OrderPanel/
  OrderPanel.tsx      # the view: renders, nothing else
  useOrderPanel.ts    # state, effects, data access, event handling
  types.ts            # every type, including OrderPanelProps
  index.ts            # re-exports only
```

Match the project's own extensions — `.jsx`/`.js` on a JavaScript project,
where `types.ts` becomes a `@typedef` file
(`docs/standards/javascript-projects.md`).

Rules that decide whether this passes review:

- **The view renders.** No `useState`, no `useEffect`, no `await`, no
  `addEventListener`, no data access. A conditional class and a mapped list
  are fine; a business rule wearing a ternary is not.
- **The hook is required only when there is logic to hold.** A genuinely
  presentational component gets no hook — an empty one is noise, not
  compliance.
- **`index` re-exports and never implements.**
- **Constants go in `constants.ts`**, not at the top of the view.
- **Deep logic goes in `utils/`** as a pure function, and it is the thing
  most worth testing.
- **Import through a barrel and through the project's path alias**, never
  by climbing out of the folder (`docs/standards/module-imports.md`).
- **Documentation follows `docs/standards/code-documentation.md`** — the
  types file carries most of it.

Add `constants.ts`, `hooks/`, `utils/`, `components/` or a context file
**only when this component actually needs them now.** Creating them empty is
the failure this list is trying to prevent, not the goal.

## 4. Write the test

`__tests__/` inside the folder, beside the code
(`docs/standards/testing.md`). At minimum, a test for every pure utility you
extracted — those are cheap, they need no DOM, and they are where the
business rules ended up.

If the project has no test infrastructure at all, say so plainly rather than
inventing a framework for it.

## 5. Report

- What you searched for and what you found — especially anything close that
  you decided not to reuse, and why.
- The files you created.
- Anything you could not determine and assumed.
