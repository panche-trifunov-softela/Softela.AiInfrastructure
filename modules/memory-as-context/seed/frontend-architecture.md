---
name: frontend-architecture
description: Softela.ReactSCExpert structure — directory layout, routing/bootstrap, component families, build
metadata:
  type: reference
  source: softela-ai
---

`Softela.ReactSCExpert` — React + TypeScript + Vite, Zustand state, MUI + `@softela/basic` design system, react-router, i18next.

`src/` layout:
- `App.tsx` — bootstrap: `AppWrapper` = `<I18nextProvider><BrowserRouter><EditorsContextProvider><App/>`. Heavy auth/OIDC state machine (setup bootstrap, signin/silent/collapse), routes under base path `/${APP_BASE_PATH}/…`. `screen/:dynamicParam` → `Home` → CustomPage. APP_BASE_PATH = `window.config.APPLICATION_NAME`.
- `pages/` — Home, CustomPage (main screen renderer), Callback, LabelEditor, NoLicense, AccessDenied, NotFound.
- `components/` families: `layout/` (ComponentMapper, CardWrapper, MatrixGrid, SideBar, Layout, Breadcrumb), `tableeditor/`, `appcomponent/` (AppComponentMapper, AppComponentRenderer, DockContainer/grid), `tabcontrols/`, `screenbuilder/` (ScreenBuilder = Screen Editor), `appComponentEditor/`, `dockEditor/`, `dtbuilder/`, `mapcomponent/`, `warehousemap/`, `stimulsoft/` (reports designer/viewer), `labelEditor/` (ZPL), `appointmentScheduler/`, `quick-report/`, `form/`, `files-dropzone/`, `xsltEditor/` (fully wired via `OBJECT_TYPE.XSLT_EDITOR` in `ComponentMapper.tsx:2748`), `konva-map/`, `yardmap/`.
- `store/` Zustand (see [[frontend-state-stores]]), `contexts/` (EditorsContext, LinkedDialogContext, StepWizardContext), `services/` (Api + auth), `hooks/`, `utils/`, `types/` (see [[frontend-types]]), `translation/` (i18next).

Rendering is **metadata-driven**: CustomPage loads a `ScreenObj` and dispatches each object through `ComponentMapper` (a big `switch(type)`). Editors (ScreenBuilder/AC/Dock) render inside cards only when a TableEditor row is selected (`parentSelectedRow`). Detailed render path in [[frontend-render-tree]].

Key cross-cutting utils (`src/utils/`): `constants.ts` (OBJECT_TYPE, APP_COMPONENT_TYPE, DOCK_AC_TYPES, FLOATING_DIALOG_SOURCE, DRILL_DOWN_SCREEN_MODE), `drillDown.ts` (`DrillDownNodeIdBuilder`: `screenRoot(screenId)="screenId:<key>"`, `acChild(parentId, acCode, objectId?)`, `linkedDialogScreen(dialogId, screenId)`), `getStoreKey({objId,screenId,dialogId})` (store-key scheme used everywhere — `dialogId`/`uniqueId` scopes linked-dialog instances), `normalizeKey`, `mapDataRowToType` + `*_FIELD_CANDIDATES_MAP` (raw row → typed), `stableStringify`, `helpers.tsx`, `appComponentUtils.ts` (isDockContainerAcObject, etc.).

Build/run: Vite. Linked-dialog/drill-down system lets screens open nested screens & ACs as floating dialogs (`useFloatingDialogsStore` + `useDrillDownStore`).

Dock-layout sync: `GridItem` carries a `sourceLayoutSig` field, compared in `mergeGridItemWithDefault` (`src/components/appcomponent/index.tsx:516`) to detect when the incoming layout diverges from the default and needs merging.
