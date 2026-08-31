---
name: frontend-utils-helpers
description: Reusable frontend building blocks — generics, tree/object helpers, mappers, constants in src/utils (REUSE these, do not duplicate)
metadata:
  type: reference
  source: softela-ai
---

ALWAYS reuse these before writing new helpers (duplication has been flagged before, e.g. don't reinvent `findInTree`). Most are exported through the `../utils` barrel: `utils/index.ts` re-exports constants, drillDown, helpers, objectScope, permissionUtils, usePrefixedNavigate, mappingUtils, apiUtils, fieldMappingConstants, componentMapperUtils, appComponentUtils, filterValue — and `helpers.tsx` additionally re-exports `gridUtils, chartUtils, warehouseMapUtils, yardMapUtils, formattingUtils, columnBuilder, expressionEngine(evaluateExpression), colorUtils`. So everything below is importable from `"../utils"`.

**Global generics** (`types/global.d.ts`, ambient — no import): `Nullable<T>=T|null`, `Undefined<T>=T|undefined`, `Maybe<T>=T|null|undefined`. Also `Window.config: Config`, `Window.APP_CONFIG: AppConfig`.

**Tree / object search (`formattingUtils.tsx`)** — use these instead of hand-rolled recursion:
- `findInTree<T,K>(root|root[], { predicate, childrenKey })` → first matching node (DFS). e.g. `findInTree(objects, { childrenKey: "childControls", predicate: x => (x.controlId||x.objId)===id })`.
- `findAllInTree(root, { predicate, childrenKey })` → all matches.
- `findObjectEntry<T>(obj, candidates: (string|string[])[], { fallback?, allowNull? })` → first `{key,value}` by case-insensitive exact (string) or partial (string[]) key match.
- `findPath(root, id)`, `getFlatMenu(root)`, `mapStringPropertyToRecord(str)`, `normalizeKey(raw)`=trim+lowercase, `canShowAcHoverBorder`, `resolveSelectedRows`, `normalizeRowForContext`, `showApiResponseSnackbar`, `convertKeysToUpperCase`, `parseBracedString`, `formatTimestamp`, `fileToDataUrl`, `saveFile`, `getAppBaseUrl`.

**helpers.tsx**: `getStoreKey` **is no longer here** — it moved to `src/utils/objectScope.ts` and shipped to `dev-ng`. Do not look for the old `join("_")` scheme. Both keys are now built by one private `buildScopeKey(scope, {includeWarehouse})` over a fixed 5-slot `stableStringify` tuple (`screenId, objId, dialogId, warehouse-or-undefined, renderInstanceId`), each segment passed through `normalizeScopeSegment` so producer/consumer type drift (number vs string) cannot split one logical scope into two keys: `getStoreKey` discards the warehouse, `getFilterStoreKey` keeps it — see [[frontend-state-stores]] for why. Also exported here: `EMPTY_SEARCH_FIELDS`, the single shared empty-array constant that keeps `activeSearchFields` referentially stable (inlining `?? []` instead caused a render loop — discovered on an object-scope-core rework branch). `stableStringify(value)` (deterministic, sorted-keys, for memo/compare — used everywhere incl. effect change-detection). `safeStringify`. `resolveFormFieldValue(rawValue, dataType, allowNull?)` → scalar string|null (unwraps dropdown objects/arrays, coerces bool/number). `getObjectValueCaseInsensitive`, `getDeepObjectValueCaseInsensitive`, `getSearchDTName`, `buildFieldConfigFromDt`, `getEffectiveFieldValue`, `isAdaptiveHeightObject`, `getVisibleFieldsIds`, `getFieldValue`, search-field/url-param/filter-expression transformers.

**gridUtils.ts**: `sortByMatrix(a,b)` (row/column ordering), `groupByRows(items)`→`RowGroup[]`, `getParentScreenObjects(objs)`, `detectScreenOrientation`, `toDisplay(v)` (render-safe scalar), `extractCellValue`, `isTranslateField`, `translateRows`, `flattenRows`, `buildRglLayoutFromMatrix`, `getColSpan/getRowSpan/getGridColumnCount`, `CELL_VALUE_CANDIDATES`/`CELL_TEXT_CANDIDATES`.

**mappingUtils.ts**: `mapDataRowToType<T>(row, fieldCandidatesMap: FieldCandidatesMap<T>)` → typed object (unwraps dropdown values). Pair with **fieldMappingConstants.ts**: `SYS_AC_FIELD_CANDIDATES_MAP`, `DT_DROP_DOWN_FIELD_CANDIDATES_MAP` (+ editor-local maps `SYS_AC_DOCK_FIELD_CANDIDATES_MAP`, `AC_TO_DOCK_MAP_FIELD_CANDIDATES_MAP` in dockEditor/constants).

**appComponentUtils.ts**: `isDockContainerAcObject(ac)` (type guard → DockContainer...), `matchesAcCode(value, codes[])`, `dockContainerContainsAcCode(dockAc, codes[])`.

**drillDown.ts**: `DrillDownNodeIdBuilder` {`screenRoot`, `acChild(parentId,acCode,objectId?)`, `screenChild`, `objectChild`, `linkedDialogScreen(dialogId,screenId)`}; `isDescendantOf(store,nodeId,ancestorId)`; `getDeepestReplaceAcNode`, `getChildModalNodes`, `getDeepestTabAcNode`, `getDeepestScreenNode`, `getObjectNodes`. Modes in constants: `CHILD_APP_COMPONENT_MODE` {REPLACE, MODAL, TAB}, `DRILL_DOWN_SCREEN_MODE` {SCREEN:0, MODAL:1}.

**permissionUtils.ts**: `applyPermissionsToObjects(objects, permissions)`. **apiUtils.ts**: `extractApiErrorMessage(error, fallback)`. **componentMapperUtils.tsx**: `readMasterFieldFromObj(o)`.

**constants.ts** (heavily used): `OBJECT_TYPE`, `APP_COMPONENT_TYPE`, `DOCK_AC_TYPES`, `FLOATING_DIALOG_SOURCE`, `DRILL_DOWN_SCREEN_MODE`, `CHILD_APP_COMPONENT_MODE`, `FIELD_DISPLAY_TYPE`/`FIELD_DATE_DISPLAY_TYPE`/`FIELD_NUMERIC_RANGE_DISPLAY_TYPE`, `COMPONENT_CONTAINER_MIN_ZISE` {WIDTG,HEIGHT}, `APP_BASE_PATH`, `DEFAULT_LANGUAGE_CODE`, `INTERVAL_UNIT`, `API_BASE_URLS`, filter operator maps (`FILTER_API_OPERATOR`, `FILTERS_DRAWER_*`), chart consts (`CHART_TYPES`, `CHART_COLOR_PALETTE`, `*_NUMBER_MAP`), C#-type sets (`C_SHARP_NUMBER/CURRENCY/INTEGER/DATE_TYPES`), regex/cache-size consts. Mostly-unused-yet ones exist (e.g. some quick-report option arrays) — don't memorize details until needed.

See [[frontend-hooks]], [[frontend-types]], [[frontend-state-stores]].
