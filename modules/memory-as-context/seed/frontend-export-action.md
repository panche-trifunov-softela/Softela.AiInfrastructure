---
name: frontend-export-action
description: Shared XML export pipeline (teExportAction) reused by the TE action bar, Screen Editor and AC editor toolbars
metadata:
  type: reference
  source: softela-ai
---

`src/components/tableeditor/teExportAction.ts` is the single implementation of "export as XML" in the frontend. Three call sites share it: the TE action bar (`SearchToolbar.tsx`), the Screen Editor toolbar (`ScreenBuilder.tsx` → `handleExportCurrentScreen`) and the AC editor toolbar (`AppComponentEditor.tsx` → `handleExportAppComponent`).

- **`executeActionBarButtonExport({ button, screenId, selectedRows, parentSelectedRow, parentDtData, t, setSnackbar, debugSource? })`** — builds `contextParams` (`selectedRows.map(normalizeRowForContext)`), adds `filters` from the parent DT primary keys only when a `parentSelectedRow` is passed, derives `eventData` (`HandlerType/AssemblyDll/FullClassName/MethodName`) from the button's `click` event, POSTs `postButtonsHandler(screenId, button.objId, "click", payload)` → `screens/{screenId}/object/{objId}/event/click/handle`, then names the file with `resolveExportFilePrefix` (supports the `if (length > 1) {…} else {…}` + `{token}` template language) and `saveFile`.
- **`findActionBarExportButton(root)`** — `findInTree` over `childControls`, matching `properties.ImageName === "ActionBarButtonExport"` OR `objId === "btn_export"`. Use it instead of re-walking the tree.

**The button control is the config** — its `events[0]` and `FilePrefix` are what make the export work, so a toolbar that is not itself a TE button must RESOLVE the real control rather than fake one. ScreenBuilder still keeps a hardcoded fallback (it would post without `eventData`); the AC editor deliberately hides its button when the control cannot be resolved.

AC editor specifics (`src/components/appComponentEditor/hooks/useAcExportButton.ts` — co-located with the editor, NOT in the shared `src/hooks` barrel; exported via the local `./hooks` index): the AC screen's TE (`acEditorTeObjectId`, e.g. the AC master TE) owns `BTN_EXPORT`; the hook takes the screen from `acEditorScreen` in [[frontend-editors-sync]] when it matches, else fetches `getScreen(screenId, true, { cache: { enabled: true } })` — `getScreenObject` is useless here because it returns no children ([[frontend-api]]). `contextParams` is the selected SYS_AC row itself (`CODE/NAME/AC_BASE/SCOPE/USERNAME`), so the payload is byte-identical to exporting that AC from the TE grid.
