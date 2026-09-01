---
name: bugworx-editable-form-context
description: "Softela.Bugworx's EditableFormContext mounts 25 feature hooks at the app root — do not add a 26th; the team is already backing out of it"
metadata:
  type: project
  source: softela-ai
---

`react-app/src/contexts/EditableFormContext.jsx` calls **25 `useAddEdit*` hooks** at the application root and hands them out as one context object, alongside five slices of domain data (`customers`, `leads`, `prospects`, `inventory`, `programs`) and their loaders. It has 28 imports and 28 consumers.

## Why this matters when adding a feature

The obvious move when adding an add/edit form is to register its hook here, because that is what the last 25 did. **Do not.**

- Every add/edit form in the product is mounted on every screen, including screens that will never render it.
- The context value is one object, so a keystroke in any one form re-renders all 28 consumers.
- The provider imports from every feature folder, so no feature is independently movable, testable or deletable — and a cycle is one import away.
- Adding an entry is one line; removing one means proving nothing reads it, across the whole app. It only grows.

## What to do instead

**The screen that renders a form calls that form's own hook.** The hook already lives beside its component (`components/…/AddEditX/useAddEditX.js`) and works perfectly well called directly — that is what a component's own hook is for.

**The team has already started doing this.** A commit on `master` reads *"avoid usage of EditableFormContext in ServiceProgramTemplate and PropertyTypeTemplate"*, and the newer configuration screens call their hooks directly. Follow the newer pattern, not the older one.

If something genuinely has to be reachable from unrelated parts of the app, that is a store's job — one concern at a time, not a directory of them.

## Unwinding an existing entry

One concern at a time, each move behaviour-preserving and separately reviewable: point the screen at the hook directly, delete the entry from the provider, confirm nothing else read it. Never mix that with a behaviour change.

The pattern and the reasoning are written up portably in `docs/standards/layer-boundaries.md` ("A provider holds one concern, not a directory of them"), which was written against this file. See also [[bugworx-architecture]].
