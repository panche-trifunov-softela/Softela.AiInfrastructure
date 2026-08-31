# Current state — Softela.ReactSCExpert

**This is a snapshot, not a rule, and it decays.** The numbers below were
captured from the `dev-ng` working tree during the frontend architecture
review. To refresh it: re-run a line-count / file-count sweep
over `src/`, re-check the folders named below still hold the shape described,
and update this file in the same change that changes the facts. Do not carry
a stale number forward silently.

**A caution on sourcing.** Some of what circulated alongside the review that
produced these numbers was a worked example — a proposed refactor of a
specific component, shown as a "before / after" during a walkthrough — rather
than a description of what most of the codebase actually looks like today.
Nothing in this file is drawn from that kind of example unless it is
independently confirmed by the numbers or by a directly quoted line count.
Where the source material only said "here is how this could look," it is
described in `migration-backlog.md` as a target, not repeated here as fact.

## Size, at the time of capture

| Metric                            | Value    |
| ---------------------------------- | -------- |
| TypeScript/TSX files under `src/` | 802      |
| Total lines under `src/`          | ~203,000 |
| Files over 500 lines              | 88       |
| Files over 1,000 lines            | 30       |
| Files over 1,500 lines            | 17       |
| Files over 2,000 lines            | 11       |
| Spec files                        | 123      |

The largest files, in order:

| File                                          | Lines |
| ---------------------------------------------- | ----- |
| `components/screenbuilder/ScreenBuilder.tsx`  | 9,122 |
| `components/tableeditor/index.tsx`            | 8,727 |
| `components/mapcomponent/MapComponent.tsx`    | 4,275 |
| `components/layout/Header.tsx`                | 4,098 |
| `components/mapcomponent/index.tsx`           | 3,872 |
| `components/labelEditor/labelDesigner.ts`     | 3,034 |
| `components/layout/ComponentMapper.tsx`       | 2,816 |
| `components/dtbuilder/DtBuilder.tsx`          | 2,753 |
| `components/form/Form.tsx`                    | 2,506 |
| `pages/CustomPage.tsx`                        | 2,240 |
| `theme.ts`                                    | 2,809 |

`theme.ts` is mostly a declaration table (colours, typography, component
overrides), which is why it sits near the top of the size list without being
a decomposition candidate in the same sense as the others.

## Top-level layout

`src/` is organised as `assets/`, `components/`, `contexts/`, `hooks/`,
`pages/`, `providers/`, `services/`, `store/`, `translation/`, `types/`,
`utils/`. `pages/` is route-level entry points; almost everything that is
not a static page opens through `CustomPage`, which reads a configuration
rather than being written per screen.

`providers/` currently holds a single entry — a notification hook that does
not use React context in any way that requires the folder to exist. Whether
and how it moves is a backlog item, not something already done — see
`migration-backlog.md`.

## Component folder pattern — partially adopted, not universal

The one-component-one-folder pattern (`Component.tsx`, `types.ts`,
`constants.ts`, a logic file, `hooks/`, `index.ts`) is not new — it already
exists, inconsistently, in parts of the tree. `src/components/
appComponentEditor` and `src/components/dockEditor` are laid out along these
lines, though the separation is not carried through consistently and
`appComponentEditor/types.ts` is currently empty. `xsltEditor`,
`warehousemap`, `yardmap` and `screenbuilder` each already have their own
`hooks/` folder.

Naming for component folders is not consistent across the tree today:
`appComponentEditor`, `tableeditor`, `files-dropzone`, `quick-report`,
`konva-map`, `screenbuilder`, `labelEditor` and `xsltEditor` show at least
three different casing/separator conventions side by side. Both `helpers/`
and `utils/` appear as the name for the same kind of folder.

Do not assume any specific component beyond `appComponentEditor` and
`dockEditor` already follows the full pattern — check the folder before
relying on its shape.

## State

- Global state lives in Zustand stores under `src/store/`, read with
  `useStore((state) => state.someField)` — narrow selectors, not the whole
  store.
- `src/store/uiCoordinationStore.ts` (876 lines at capture) is the single
  cross-component signalling mechanism in active use, read from more than
  thirty modules across the table editor, screen builder, warehouse map,
  layout, editors and `CustomPage`. It is nonce-based (`Nonce`,
  `BaseUiRequest`, `UiEvent<T>`), consumed through `useNonceGuardedEffect`,
  `useStoreNonceGuardedEffect` and `createNonceGuardedStoreEffect`. Several
  of its payload types are still `any`.
- `src/utils/eventBus` (built on `mitt`) is a leftover from before the
  coordination store existed. It carries exactly one event
  (`popoverToggle`) with two consumers today. Folding it into
  `uiCoordinationStore` and dropping `mitt` is an agreed but not-yet-done
  backlog item — see `migration-backlog.md`.
- There is no dedicated server-data layer — no React Query or equivalent.
  Fetching is `axios` calls in `src/services/api`, wrapped by
  `useAsyncMethodWrapper` (call orchestration, per-key loading state,
  concurrency strategies) and `useFetchInterval` (polling). `http.ts`
  configures `axios-cache-interceptor` for a transport-level HTTP cache;
  nothing above that coordinates who has already requested what, which is
  why reference data (warehouses, languages, system parameters) is kept in
  a store rather than refetched per consumer.

## API layer

Backend calls are split across two locations today:

```
src/services/Api.ts            172 lines
src/services/api/
  screens.ts                   893 lines
  table.ts                     357 lines
  yardMap.ts, geodata.ts, reports.ts, quickReports.ts, ...
```

`screens.ts` alone covers screen structure, data templates, field data,
screen CRUD, the screen editor, user layout state, import/export and the
navigation menu API — several backend controllers in one file, organised by
frontend feature rather than by the backend controller that serves it.

`src/services/api/urlConsts.ts` exists and holds a handful of route
constants in inconsistent casing; most call sites still write the URL
inline rather than using it.

Every backend service call in `src/services/api/screens.ts` currently
imports the `Field` type from `src/components/form/Form` — a dependency
that points from the API layer into a component, the wrong direction.

## Types

- `src/types/request` and `src/types/response` hold backend-contract types,
  one DTO per file, named as the backend names it. The convention is
  correct; coverage is the gap — most of what the frontend actually
  exchanges with the backend is still typed loosely or as `any`.
- `src/types/types.ts` (189 lines at capture) is an undifferentiated
  dumping ground for types that were not given a more specific home.
- Frontend-only types are otherwise grouped by concept — `labels.ts`,
  `reports.ts`, `notifications.ts`, `chart.ts`, `appComponents/`,
  `quick-reports/` and similar.
- The backend is not a single service: runtime config names Infra,
  Warehouse and Mapper (`INFRA_API_URL`, `WAREHOUSE_API_URL`,
  `MAPPER_API_URL`), each with its own swagger document.

## Tests

Two folders, doing different jobs:

- `src/tests/` — test **infrastructure**: `setup.ts`, `test-utils.tsx`,
  `factories/`, `mocks/`, `tableeditor/{builders,fixtures,harnesses}`.
  Referenced by `vitest.config.ts` (`setupFiles`) and excluded from
  coverage. The name is misleading (it sounds like it holds tests, not
  infrastructure), and a rename was considered and declined — see
  `migration-backlog.md`.
- `src/__tests__/` — the actual spec files, 123 of them at capture, in
  subfolders mirroring `src/`.

`vitest.config.ts` declares coverage thresholds (80% lines/statements, 75%
functions, 70% branches), but `npm run test:ci` runs without `--coverage`,
so nothing is currently measured against them.

## Styling

Mixed, and not yet measured. Most components style through MUI's `sx` prop;
SCSS modules appear mainly in areas that have already been reworked. There
is no current count of the actual split between the two. See
`docs/OPEN-DECISIONS.md` — the styling direction is explicitly unsettled.

## Third-party component library

The project consumes `@softela/basic`, `@softela/common` and `@softela/display-type`
today. Their future is an open question, not a settled fact about the
architecture — see `docs/OPEN-DECISIONS.md`.
