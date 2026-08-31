---
name: frontend-editors-sync
description: EditorsContext — how AppComponentEditor, DockEditor, and ScreenBuilder share/sync AC state via acObjectsMap + TableEditor events
metadata:
  type: reference
  source: softela-ai
---

`src/contexts/EditorsContext.tsx` (`EditorsContextProvider`, mounted once around the whole app in App.tsx) is the shared brain for three editors:
- **AppComponentEditor** (`components/appComponentEditor/AppComponentEditor.tsx`) — edits one AC's base properties (right panel form from base AC DT) + renders it; for dock ACs delegates to DockEditor.
- **DockEditor** (`components/dockEditor/DockEditor.tsx`) — edits a dock container's layout/children.
- **ScreenBuilder / Screen Editor** (`components/screenbuilder/ScreenBuilder.tsx`) — edits a whole screen's objects (only some are ACs).
Access via `useEditorsContext()`.

Shared state & helpers:
- **`acObjectsMap: Record<string, Maybe<CommonAppComponent>>`** — SOURCE OF TRUTH for loaded AC objects keyed by AC code. `undefined`=never requested (fetch ok); `null`=known missing/failed (don't refetch). Populated via `getAppComponentObject(code)` = BASE AC (no per-screen overrides; objId/screenId empty; caption=AC name).
- **`upsertAcObject(acCode, acObject, replaceCode?)`** — store a fresh AC AND rewrite stale refs inside cached dock containers (`dockComponents`/`layout`) + sync matching drillDownStore nodes. Publishes an AC change to all editors.
- **`acObjectByCodeAsync(code)`** — map entry or fetch-once-and-cache.
- **`openAcEditorAsync({acCode?, createNew?, uniqueId?})`** — opens the AC editor as a floating linked dialog on `acEditorScreenId`/`acEditorTeObjectId`; if `acCode`, filters that TE row; if `createNew`, fires `requestOpenTeInsertModal`. Computes `dialogId` from uniqueId + screen/te/acCode. (Fire-and-forget today — no return channel for the created AC.)
- **`updateStateFromObjectProperties(properties, objectType)`** — each editor calls it in an effect (deps `[obj.properties, editorsStateVersion]`) to push its object's config props into shared state (which screen/TE/object ids to use). Property key constants per editor: DockEditor `DOCK_EDITOR_PROPERTIES`, AppComponentEditor `APP_COMPONENT_EDITOR_PROPERTIES`, ScreenBuilder `SCREEN_BUILDER_PROPERTIES` (`AppComponentEditorScreenId/ObjectId/TableObjectId`).
- **`editorsStateVersion` + `clearEditorsState()`** — bumped on root-screen change (called by CustomPage's `withScreenReplaceDrillDown`); a generation ref guards stale async writes. Loading flags: `sysAcDtLoading`, `sysAcsLoading`, `acToDockMap*Loading`, `acEditorScreenLoading`, `dockEditorObjectLoading`. Plus `sysAcs`, `acToDockMaps`, base AC DTs (`baseAcDtMap`), AC/Dock editor screen ids/objects.

**Sync driver = TableEditor events** from `uiCoordinationStore`: `teRow{Inserted,Updated,Deleted}Event`, `teRowsUpdatedEvent` (each has a `nonce`, applied once via `processedTeEventNoncesRef`). EditorsContext routes events from the AC-editor TE (`isAcEditorTeEvent`) or dock-editor TE (`isDockEditorTeEvent`) into handlers that update `sysAcs`/`acToDockMaps`/`acObjectsMap` (insert/update/delete, code-rename via `replaceCode`, cascading dock-container refresh). This is how editing an AC in one editor reflects in others. AC↔Dock sync already works (both operate purely on ACs); ScreenBuilder is the harder case.
