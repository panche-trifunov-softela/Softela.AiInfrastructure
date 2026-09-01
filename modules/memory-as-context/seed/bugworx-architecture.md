---
name: bugworx-architecture
description: "Softela.Bugworx (github.com/trifunov/Bugworx) — the React frontend for Pest Management: everything lives under react-app/, plain JavaScript, Bootstrap, Keycloak, localStorage standing in for most of the backend"
metadata:
  type: reference
  source: softela-ai
---

`Softela.Bugworx` is the React frontend for **Pest Management** — the same product [[softela-domain-entities]]' .NET side, `Softela.PestManagement`, serves. The link is verifiable, not inferred: Keycloak realm `pestmanagement`, client `pestmanagement-webapp`, API base defaulting to the Aspire host's `localhost:5250`.

**Everything the team writes is under `react-app/`.** The repository root is a vendored Bootstrap admin template (Upcube) with its own `package.json` and `gulpfile.js`; ignore it. Every convention glob in `projects/Softela.Bugworx.json` is rooted at `react-app/src` for that reason.

## The stack

- **React 19 + Vite 7, plain JavaScript.** `.jsx` and `.js`, no TypeScript anywhere — see [[bugworx-no-typescript]].
- **Bootstrap 5**, SCSS under `src/assets/scss`. No MUI, no CSS modules. (Unlike `Softela.ReactSCExpert`, which is MUI — do not carry patterns across.)
- **`react-router-dom` v7**, all 90 routes declared inline in `App.jsx`.
- **Keycloak** via `contexts/AuthContext.jsx`, which pushes the token into the API layer with `setTokenProvider`.
- **No state library.** Three contexts (`AuthContext`, `EditableFormContext`, `PageSubHeaderContext`) plus `useState` in hooks. No Zustand, no Redux, no React Query.

## `src/` layout

- `components/` — shared (`Common/`: Table, SearchBar, AdvancedFilter, ContactFields) and feature folders mirroring the configuration tree.
- `pages/` — route-level screens; newer ones are folders (`pages/<area>/<Feature>/<Feature>.jsx` + `use<Feature>.js`), older ones are flat files.
- `layouts/` — MainLayout, Header, Footer, Sidebar, SidebarConfiguration, EditableForms.
- `hooks/`, `utils/`, `services/`, `contexts/`, `config/`, `data/`.

## Data access — read this before wiring anything

- **`services/api.js` is the transport.** A small `fetch` wrapper: base URL from `VITE_API_URL`, bearer token from a provider, one `handleResponse` error path. Nothing outside `services/` calls `fetch` directly, and that boundary is worth keeping.
- **`utils/localStorage.js` (1,840 lines) is the data layer for most screens**, seeded from `data/mockData.js`. A `localStorage` call means **"this feature is not wired to the backend yet"** — it is not a storage decision, and it is not a pattern to copy into new work.
- **Only customers and service addresses have real services** (`customerService.js`, `serviceAddressService.js`).
- Routes are inline string literals; there is no endpoints-constants file yet.

## The two things to be careful around

- **`EditableFormContext` instantiates 25 feature hooks at the app root** and hands them out as one object — see [[bugworx-editable-form-context]].
- **No path aliases and no barrels.** 428 imports climb four or more levels. See [[bugworx-imports]].

## Git flow is NOT the SCExpert one

[[softela-git-flow]] is scoped to `Softela.ReactSCExpert` and `Softela.SCExpert` — do not apply it here. Bugworx differs on every point that matters:

- **Base branch is `master`**, not `dev`/`dev-ng`. "PR target is dev, never master" is an SCExpert rule and is wrong here.
- **GitHub, not Azure DevOps.** Pull requests are merged on GitHub; several carry GitHub Copilot review commits.
- **Branch names have no single convention** — real ones read `feat/customers-implementation`, `feature/configuration-templates-and-defaults`, `implementation-Programs`, `68-homepage-redesign`. The project config keeps `branchNaming` at `ask` with the ticket number optional, matching the majority `feature/…` / `feat/…` forms rather than firing on ordinary work.

What still applies from the portable rules: rebase rather than merge the base into a branch, and keep commit messages short. See `docs/standards/git-flow.md`.

The measured snapshot lives in `docs/projects/Softela.Bugworx/current-state.md`; the rulebook it is judged against is `docs/standards/assembled/FRONTEND-ARCHITECTURE-STANDARD.md`.
