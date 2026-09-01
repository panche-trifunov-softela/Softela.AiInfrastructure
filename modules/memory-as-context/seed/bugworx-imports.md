---
name: bugworx-imports
description: "Softela.Bugworx has no path alias and no barrel files — 428 imports climb 4+ levels; the import-depth guard stays inert until an alias exists"
metadata:
  type: project
  source: softela-ai
---

Two facts about `Softela.Bugworx`'s module graph, both measured:

- **No path alias.** `react-app/vite.config.js` declares no `resolve.alias`, and there is no `jsconfig.json`. Every cross-folder import is relative, and **428 of them climb four or more levels** — `../../../../utils/localStorage` is the ordinary form, not the exception.
- **No barrel files.** Zero `index.js` in the whole tree. Every import reaches straight at a component's own file, so every folder's public surface is effectively all of it.

## What this means for the guards

**`import-depth` is inert here, deliberately.** It requires `conventions.pathAliases`, and the project config declares none — because a fix naming `@/utils/localStorage` when nothing can resolve `@` would be worse than no rule. The rule switches itself on the moment an alias exists in all three places:

1. `resolve.alias` in `react-app/vite.config.js`
2. `compilerOptions.paths` in a `react-app/jsconfig.json`, so the editor resolves it too
3. `conventions.pathAliases` in `projects/Softela.Bugworx.json`

That is a small, mechanical, behaviour-preserving change and it is the highest-leverage structural item available in this repository. It is tracked in `docs/OPEN-DECISIONS.md`.

**`barrel-exports-only` has nothing to check yet** — it only fires on a file named `index.*`. It will start mattering as soon as the first barrel is written, which the component-folder standard asks for on every new component.

## Until then

Write new imports the shortest correct way and **do not add a fifth level of climbing**. If a new file needs something four levels up, that is the signal that the two belong closer together — see `docs/standards/shared-code-boundaries.md` on a feature's parts living together, which is the other half of why the numbers here are what they are: a screen under `pages/<area>/<Feature>/` reaching its own dialog under `components/<Area>/<Sub>/<Feature>/` is a four-level climb by construction.

See [[bugworx-architecture]] and `docs/standards/module-imports.md`.
