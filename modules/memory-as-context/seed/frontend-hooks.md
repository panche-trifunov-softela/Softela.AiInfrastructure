---
name: frontend-hooks
description: Frontend reusable hooks (src/hooks) — useAsyncMethodWrapper (central), data/report/quick-report hooks
metadata:
  type: reference
  source: softela-ai
---

Hooks in `src/hooks/` (barrel `index.ts`; import from `"../hooks"`). REUSE before writing new data-fetching/loading logic.

**`useAsyncMethodWrapper()`** — the central async/loading utility, used by EditorsContext and most editors. Returns `UseAsyncMethodWrapperReturn`:
- `wrapAsyncMethod(method, defaultOptions?)` → a `(args:T[], options?) => Promise<Maybe<R>>` wrapper (define at top level for stable ref). `invokeAsyncMethod(method, argsArray, options?)` runs it directly.
- Per-call `options` (`InvokeAsyncMethodOptions`): `concurrentCallStrategy: "allow"|"skipByMethod"|"skipByFullKey"` (dedupe in-flight calls — `skipByFullKey` keys on method+args), `onSuccessCallback(data)`, `onErrorCallback(error)`, `finallyCallback()`, `rethrowError`, `keepFinishedEntry`, custom `methodKey`/`argsKey`/`fullKey`.
- Loading introspection (all stable refs, safe in deps): `getIsLoadingByKey(key|selector)`, `findLoadingEntry(filter)`, `getLoadingEntries(filter)`, `isAnyLoading`, `isAllLoading`, `setLoading`/`setBulkLoading`. Entries keyed by `fullKey = methodKey::argsKey` (methodKey defaults to `method.name`, argsKey to `stableStringify(args)`). Loading is reference-counted (no flicker). EditorsContext shares ONE instance so loading is visible across editors; editors detect a method's loading via `findLoadingEntry(x => x.methodKey === someApiFn.name && (x.args??[]).some(a => a === someId))`.

Other hooks (names/purpose; reuse rather than re-fetch): `useDataTemplate`, `useDataProvider`, `useTableData`, `useGetDataChart`, `useDrillDown`, `useSearchDtFields`, `useDebounce`, `useThrottleFn`, `useFetchInterval`, `useAutoColumnWidths`, `useExportDataToFile`, `useTranslatedRows`, `useSystemParams`, `useInactivityLogout`, `useImage`, `useNotification` (NotificationProvider/useAppNotification), `useCellContextMenu`, `useCssVariableColorValues`, `useLabelTemplate`. Large report/quick-report family: `useReport*` (Report/Data/DataTemplate/Source/Param(s)/Save/Localization/Printers/ExportToPdf/DefaultReportPrinter) and `useQuickReport*` / `useSaveQuickReport(Source)` / `useDeleteQuickReport` / `usePublishQuickReport` / `useQuickReportsList`. Note: `useDrillDown` (hook) is distinct from `useDrillDownStore` (zustand) and `useDrillDownNodeId`/`DrillDownNodeProvider` (services/DrillDownNodeContext). **None of `useCellContextMenu`, `useCssVariableColorValues`, `useImage`, `useNotification`, `useLabelTemplate`, `useSystemParams`, `useThrottleFn`, `useAppointmentYards`, `useDropdownOptions` are in the `src/hooks/index.ts` barrel** (unlike the async/report/quick-report hooks above) — import them by direct file path, e.g. `import { useNotification } from "../hooks/useNotification"`.

See [[frontend-utils-helpers]], [[frontend-api]], [[frontend-state-stores]].
