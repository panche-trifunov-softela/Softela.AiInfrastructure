# Softela.Bugworx

The React frontend for Pest Management — the same product
[`Softela.PestManagement`](../Softela.PestManagement/README.md) serves from
the .NET side. The link is not a guess: the Keycloak realm is
`pestmanagement`, the client is `pestmanagement-webapp`, and the API base
falls back to the Aspire host's own `localhost:5250`. Read the two project
docs together; the backend one is where a contract's truth lives.

- Base branch: `master`
- Project config file: `projects/Softela.Bugworx.json`
- Stack: `frontend`, so it inherits `projects/_presets/frontend.json`

## The shape

The repository is a Bootstrap admin template with a React application inside
it. **Everything this team writes is under `react-app/`**; the repository
root holds the vendored Upcube theme, its `gulpfile.js` and its own
`package.json`, which is why every convention glob in the project config is
rooted at `react-app/src` rather than at `src`.

- **React 19 + Vite 7**, plain **JavaScript** — `.jsx` and `.js`, no
  TypeScript anywhere. See
  [`docs/standards/javascript-projects.md`](../../standards/javascript-projects.md)
  for what that changes and, mostly, what it does not.
- **Bootstrap 5** and SCSS under `react-app/src/assets/scss`. No MUI, no CSS
  modules.
- **`react-router-dom` v7**, with every route declared in `App.jsx`.
- **Keycloak** (`keycloak-js`) via `AuthContext`, which hands the token to
  the API layer through `setTokenProvider`.
- **No state library.** Three React contexts —`AuthContext`,
  `EditableFormContext`, `PageSubHeaderContext` — and `useState` in hooks.
- **`fetch` behind `services/api.js`**, a small typed-by-convention transport
  with a base URL, a bearer token and one error path. This is the project's
  `http.ts` equivalent and the boundary that already holds: nothing outside
  `services/` calls `fetch` directly.
- **`utils/localStorage.js` is the data layer for most screens.** Most
  features still read and write browser storage seeded from
  `data/mockData.js`; only customers and service addresses go through a real
  service. Treat a `localStorage` call as "this feature is not wired to the
  backend yet", not as a storage decision.

## What the standard already got right here

Worth stating, because it is the reason adopting the rest is cheap: **the
view/hook split is already the house style.** 102 of the 174 component files
sit beside a matching `use<Component>.js`, and the ones that do not are
mostly genuinely presentational — `EmptyState`, `Pagination`, `PhoneRow`.
`docs/standards/component-structure.md` is not a new direction for this
repository; it is the direction it already picked, applied consistently.

## What is true here that the standard does not say

- **There is no test suite, and `npm run test` exits 0 anyway.** No test
  script is declared, so `npm run test --if-present` — which is exactly what
  the GitHub Actions workflow runs — succeeds having run nothing. A green
  exit here is not a passing suite. The project config asks before any
  `npm test` invocation for that reason; verify with `npm run build` and
  `npm run lint` instead, and report those.
- **No path alias.** `vite.config.js` declares no `resolve.alias`, so every
  cross-folder import is relative — 428 of them climb four or more levels.
  `import-depth` is therefore **inert here on purpose**: its fix would name
  an alias nothing can resolve. Adding one is the prerequisite, and it is
  tracked in [`docs/OPEN-DECISIONS.md`](../../OPEN-DECISIONS.md).
- **No barrel files at all** — zero `index.js` in the whole tree. Imports
  reach directly at a component's own file, so `barrel-exports-only` has
  nothing to check yet and every folder's public surface is "all of it".
- **A feature is split across two mirrored trees.** A screen lives at
  `react-app/src/pages/<area>/<Feature>/`, and the dialog only that screen
  renders lives at `react-app/src/components/<Area>/<Sub>/<Feature>/` —
  hand-mirrored, and already drifting in casing (`service-inspection` on one
  side, `ServiceInspection` on the other). See
  [`docs/standards/shared-code-boundaries.md`](../../standards/shared-code-boundaries.md).
- **`EditableFormContext` instantiates 25 feature hooks at the app root** and
  hands them out as one object, alongside five slices of domain data. Every
  add/edit form in the product is mounted on every screen, and every consumer
  re-renders on any of them changing. The team has already started backing
  away from it — one commit reads "avoid usage of EditableFormContext in
  ServiceProgramTemplate and PropertyTypeTemplate" — and
  [`docs/standards/layer-boundaries.md`](../../standards/layer-boundaries.md)
  now names the pattern and how to unwind it.
- **`react-app/.env` is tracked, and carries a live Google Maps API key.**
  `_default.json` already asks before any write to a `.env`; that does not
  help with the key that is already committed and in the repository's
  history. Rotating it, untracking the file and moving the value to
  `react-app/.env.local` is outstanding work, not something a guard can do.
  The project config declares `.env`/`.env.local` as the tracked/per-machine
  pair so a *local* host — the API base and the Keycloak URL both default to
  localhost in code — cannot be added to the tracked half unnoticed.
- **Branch names carry no single convention.** Real branches read
  `feat/customers-implementation`, `feature/configuration-templates-and-defaults`,
  `implementation-Programs` and `68-homepage-redesign`. The project config
  relaxes `branchNaming` to ticket-*optional* and keeps it at `ask`, matching
  the majority `feature/…` and `feat/…` forms rather than denying on ordinary
  work.
- **Prettier is configured and only mostly applied.** `.prettierrc.json` sets
  two-space indentation and a 150-column width, and `.vscode/settings.json`
  turns on format-on-save — but 23 of 179 `.jsx` files indent with four
  spaces, 170 lines run past 150 columns, and no CI step checks any of it. Do
  not reformat a file you are not otherwise changing.
- **`npm install` needs no flags.** There is no `package-lock.json` (it is
  gitignored) and no peer-dependency conflict to work around.

## Verification

```
cd react-app
npm install
npm run build      # the real check — vite build
npm run lint       # eslint, flat config
```

`npm run test` is not a verification step here; see above.

## Related

- [`docs/standards/assembled/FRONTEND-ARCHITECTURE-STANDARD.md`](../../standards/assembled/FRONTEND-ARCHITECTURE-STANDARD.md)
  — the whole frontend rulebook. This is the one to read.
- [`docs/standards/javascript-projects.md`](../../standards/javascript-projects.md)
  — what that rulebook means without TypeScript.
- [`docs/projects/Softela.PestManagement/README.md`](../Softela.PestManagement/README.md)
  — the backend this frontend calls, and where a contract's truth lives.
- `current-state.md` — the measured snapshot behind the claims above.
