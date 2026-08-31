---
name: frontend-api
description: Frontend API surface — src/services/Api.ts barrel and src/services/api/* modules (screens, table, AC, reports, auth)
metadata:
  type: reference
  source: softela-ai
---

API layer in `src/services/`. `Api.ts` is a back-compat barrel re-exporting from `src/services/api/*` (so `import { X } from "../services/Api"` keeps working). Axios instance via `api/http.ts` (`getAxiosInstance`, `setup`). Caching via axios-cache-interceptor (`CacheRequestConfig`, `clearCacheApi`).

Modules in `src/services/api/`:
- **`screens.ts`** (the big one): `getScreen(screenId)`→ScreenDto, `getScreenTitle`, `getScreenObject(screenId, controlId)`, `getMenu`/`getDesktopMenu`/`getAppsMenu`, `getDataTemplate(name)`, `getScreenDataTemplate`, `getScreenDataTable`/`getAllScreenRowsForExport`, `getScreenObjectData`, `getScreenFieldData`/`getScreenPopupFieldData`, `getSelectOptions`/`populateSelectFieldsOptions`/`populateSelectFieldsValue` (dropdown option loading), `getScreenBuilderTypeaheadFieldData`, `getScreenAppComponent`/`getScreenObjectAppComponentData`, CRUD data: `postScreenDataTable`/`putScreenDataTable`/`putMultiScreenDataTable`/`deleteScreenDataTable`, `postExpressions`, `postButtonsHandler`, `getEditData`. **Screen editor CRUD**: `getScreenAvailableControls`, `getEditorControlFieldData`, `createScreenEditorObject`, `updateScreenEditorObject`, `deleteScreenEditorObject`, `deleteScreenEditorScreen`, user layout `getUserLayout`/`saveUserLayout`/`deleteUserLayout`, `clearCacheApi`.
- **AC API** (`services/Api.ts` re-exports; impl likely in screens or dedicated): `getAppComponentObject(code)` (no objectId/screenId → BASE AC object; optional objectId+screenId → screen-merged), `getAppComponentDataTemplate(code, dtName)`, `getBaseAppComponentDataTemplateByType(type)`, `createAppComponent(request, ignoreRequired?)`, `updateAppComponent(code, request, ignoreRequired?)`, `updateAppComponentDockContainer(code, request)`. Maps to backend `api/app-components` ([[backend-screens-appcomponents]]).
- `table.ts` (349) — table-editor data ops. `reports.ts`, `quickReports.ts`, `labelsEditorApi.ts`, `dataProvider.ts`, `notifications.ts`, `yardAppointment.ts` (79 lines, renamed from `YardAppointmentShedulerApi.ts` in commit 5a31c5a4) + sibling `yardMap.ts`, `systemParamsApi.ts`, `auth.ts` (`authParams`).
- `builderApi` (`components/screenbuilder/services/builderApi`): `builderCreateObject`, `builderClearCache` — explicit ScreenBuilder-local API.

**Two gotchas that cost real time:**
- **`getScreenObject(screenId, controlId)` returns a FLAT control — NO `childControls`.** Backend `ScreenDbService.GetScreenControl` selects one `SgScreens` row + its properties, it does not build the subtree. To reach a control's children (e.g. a TE's action-bar buttons) you MUST use `getScreen(screenId)` (`GET screens/{id}/object`), which returns the nested tree.
- **HTTP caching is OFF by default** — `setupCache(instance, { enabled: false })` in `api/http.ts`. Opt in per call with `{ cache: { enabled: true } }` as the request config (idiom used across `src/hooks/use*`); that also gives concurrent-request dedup for the same key.

Async calls are wrapped via `useAsyncMethodWrapper` (hook) which gives loading entries + `concurrentCallStrategy: "skipByFullKey"` and onSuccess/onError/finally callbacks; EditorsContext shares one wrapper instance so loading is visible across editors.
