---
name: frontend-render-tree
description: Frontend render path App.tsx → CustomPage → ComponentMapper/AppComponentMapper, and which component renders each screen-object type
metadata:
  type: reference
  source: softela-ai
---

Render path (frontend, [[frontend-architecture]]):

`App.tsx` → routes → `Home` (`/screen/:dynamicParam`) → `pages/CustomPage.tsx` → `ComponentMapper` (per screen object) + `AppComponentMapper` (per AC).

- **CustomPage** (`pages/CustomPage.tsx`): exported as `withScreenReplaceDrillDown(CustomPage)`. Loads `ScreenObj` via `getScreen`, applies permissions (`applyPermissionsToObjects`), builds `parents` → `laneObjects` (lanes/rows) and renders each via `<ComponentMapper>` inside `MatrixGrid`. Manages: drill-down (`useDrillDownStore`), floating dialogs (`useFloatingDialogsStore`), TableEditor view/active rows, master→detail promotion of child cards (`childViewMode`, `activeRowByParent`, `parentViewRow`), TE-mode-driven object hiding. `uniqueId` = linked-dialog instance id, threaded everywhere → `getStoreKey({objId,screenId,dialogId:uniqueId})`. The wrapper resolves drill-down screen replacement and calls `clearEditorsState()` on root-screen navigation.
- **ComponentMapper** (`components/layout/ComponentMapper.tsx`): big `switch(type)` (lowercased) → concrete component in a `CardWrapper`. Cases: `appcomponent`→`AppComponentMapper`; `screenbuilder`→`ScreenBuilder`; `appcomponenteditor`/`appcomponentbuilder`→`AppComponentEditor`; `dtbuilder`→`DtBuilder`; `tableeditor`→`TableEditor`; `tabcontrol`→`TabControl`; `reportdesigner`/`reportviewer`, `map`, `warehousemapviewer`, `zpleditor`, `xslteditor`, `parentcontrol`, etc. `renderChildInline` handles nested children (tabs, stacked detail panels). Editors require `parentSelectedRow` to render. Legacy SYS_AC TableEditors get a virtual `appcomponentbuilder` child injected.
- **AppComponentMapper** (`components/appcomponent/AppComponentMapper.tsx`): wraps a single AC; manages drill-down node `DrillDownNodeIdBuilder.acChild(parentNodeId, appComponentCode)`; resolves deepest replace-AC node; renders `AppComponentRenderer` (DOCK types render without CardWrapper chrome). `AppComponentRenderer` dispatches by `appComponentType` to the concrete AC widget (DockContainer/grid, chart, gauge, numeric info box, table editor AC, button, label, link list).

Constants: `OBJECT_TYPE` & `APP_COMPONENT_TYPE` in `utils/constants.ts`. `OBJECT_TYPE.SCREEN_BUILDER="screenbuilder"`, `APP_COMPONENT="appcomponent"`, `APP_COMPONENT_EDITOR="appcomponenteditor"`, `DOCK_EDITOR="acdockeditor"`. The three editors share state via [[frontend-editors-sync]].
