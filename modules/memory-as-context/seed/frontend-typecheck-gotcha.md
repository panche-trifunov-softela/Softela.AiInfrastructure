---
name: frontend-typecheck-gotcha
description: "`npx tsc --noEmit` checks NOTHING in Softela.ReactSCExpert — the root tsconfig is a solution file; use -p tsconfig.app.json"
metadata:
  type: project
  source: softela-ai
---

**`npx tsc --noEmit` in `Softela.ReactSCExpert` is a NO-OP and always exits 0.** The root `tsconfig.json` is a solution-style file:

```json
{ "files": [], "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }] }
```

With `files: []` and no `-b`, tsc type-checks zero files. It reports success on a codebase full of `TS2304: Cannot find name` errors.

**Always typecheck with one of:**

- `npx tsc --noEmit -p tsconfig.app.json` (app sources — the one that matters) **and** `-p tsconfig.node.json`, or
- `npx tsc -b` (build mode follows project references — this is what `npm run build` uses).

**Cost of not knowing this:** an entire session's worth of "tsc clean" claims turned out void. A rebase resolution left three dangling identifiers (`parentViewRow`, `currentTableEditorModes`, `getStoreKeyByObjId`) plus four missing imports; the no-op tsc reported clean and the full vitest suite stayed green too — because no test rendered those code paths. Only the real project-scoped check found the 9 errors. **A green suite plus a no-op typecheck can look identical to a healthy branch.**

Related: `npm run validate:pre-push` runs `npx tsc --noEmit && npm run build && npm run test:run` — the first command is the same no-op, but `npm run build` (`tsc -b && vite build`) does catch it.
