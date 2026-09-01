---
name: bugworx-no-typescript
description: "Softela.Bugworx is plain JavaScript — the structural standard applies unchanged; write shapes as JSDoc @typedef, and no-explicit-any is inert here"
metadata:
  type: project
  source: softela-ai
---

`Softela.Bugworx` is **plain JavaScript** — `.jsx` and `.js`, no TypeScript, no `tsconfig.json`. `@types/react` is a devDependency for editor completion only.

**This changes almost nothing about the standard, and that is the point.** Do not read a laxer rulebook into the absence of a compiler.

## Unchanged, and enforced on `.js`/`.jsx` exactly as on `.ts`/`.tsx`

The component folder and its `use<Component>` hook, the view/hook/utility split, the barrel, naming, file size, colocated tests, where state belongs, how a backend call is made, import rules. The guards read both extension families: `component-folder-shape`, `component-view-logic`, `barrel-exports-only`, `hook-locality`, `colocated-tests`, `naming-standards` (the project declares `language: "javascript"`), `file-size-limit`, `api-import-boundary`.

Concretely: a `use*.jsx` file is a hook, an `index.js` is a barrel, and a `.jsx` component file is judged against PascalCase.

## What does change

- **`types.ts` becomes a JSDoc `@typedef` file** — same place, same colocation and promotion rules, just no compiler behind it. Write the props type and the hook's return type down; an editor gives real completion from `@typedef`, and it is the only place a reader can learn what a hook returns without reading the hook.
- **`component-types-file` is inert** — it looks for an inline `interface`/`type`, and JavaScript has neither. The convention still holds; it is review-enforced here.
- **`no-explicit-any` is inert** — the project declares no `conventions.contractTypes` because there are no contract-type files. This is the one place the absence of TypeScript genuinely removes a guarantee, so **contract discipline matters more here, not less**: a backend shape is still mirrored exactly, and a field invented because the UI wanted one is still the failure that reaches a user.
- **Validate at the boundary you do not control** — API responses, browser storage, URL params. Narrow once, in the hook or a utility, rather than defending against a missing field at twenty render sites.

## Do not "helpfully" introduce TypeScript

Converting a file, adding a `tsconfig.json`, or renaming `.jsx` to `.tsx` is a project-level decision nobody has made. If it comes up, note that the structure this rulebook asks for is most of the work of getting there — a component already split into a view, a hook and pure utilities converts file by file — and leave the decision to the team.

The portable version is `docs/standards/javascript-projects.md`. See also [[bugworx-architecture]].
