---
name: frontend-types
description: Frontend TypeScript type system — ScreenObjectBase / AppComponent hierarchy / SysAc / Dock, and global Maybe/Nullable aliases
metadata:
  type: reference
  source: softela-ai
---

Types in `src/types/` (barrel `index.ts` re-exports appComponents, enums, request, response, chart, dataTemplate, menu, screen, screenObject, tableEditor, etc.). Global aliases (`global.d.ts`): `Maybe<T>=T|undefined|null`-ish, `Nullable<T>`, `Undefined<T>`.

- **`ScreenObjectBase`** (`screenObject.ts`): base of every screen object — `screenId, objId, screenCode, type, controlId, parentControl, caption, row, column, className, fixedSize, childControls, properties: Record<string,Nullable<string>>, attributes, events, updatedDate, serialization_type`.
- **`ScreenObjectDto<T extends ScreenPropertiesBase>` extends ScreenObjectBase** adds `props: T` (`ScreenPropertiesBase={ values: Record<string,string> }`). `ScreenObject` is the common alias.
- **AC hierarchy** (`appComponents/`): `AppComponentBaseScreenControl extends ScreenObjectBase` adds `appComponentType, appComponentPropertiesDTName, appComponentCode`. `AppComponentBaseScreenControlWithProps<T>` adds `props:T`. **`CommonAppComponent = AppComponentBaseScreenControlWithProps<CommonAppComponentProperties>`** (`{values, height, width}`) — the type stored in `acObjectsMap`. Typed variants: ButtonAppComponent, LabelAppComponent, GaugeAppComponent, QuickChartAppComponent, NumericInfoBoxAppComponent, TableEditorAppComponent, LinkListAppComponent, **DockContainerAppComponentBaseScreenControl** (adds `layout: DockItem[]`, `dockComponents: AppComponentDockListItem[]` each `{code,name,visible,expanded,zoneId,ordinal,base,appComponent}`; props add `dockCode, columnCount, readOnly, adaptiveHeight`).
- **`SysAc`** = `{code, name, acBase, scope, username}`. **`SysAcDock`** = `{code, name, dockLayout}`. (`appComponents/sys.ts`.)
- `dataTemplate.ts`: `DataTemplateDto` (dtName, recordId, fields[], structureName…) and `DataFieldDto` (dtFieldName, displayType, defaultValue, label, ordinal, readOnly, required, properties[]); `FieldDefinition` (`screen.ts`) extends `DataFieldDto` with fieldId/caption/options. (`DTField` is not a type — it's an unrelated string literal in `DtBuilder.tsx`.) `tableEditor.ts`, `screen.ts` (`ScreenObj`, `ScreenObject`, `FieldDefinition`), `menu.ts` (`MenuItem`), enums (`TableEditorMode`, etc.).

Bridge note: an `appcomponent` Screen Object IS a `ScreenObjectBase` whose runtime shape overlaps `AppComponentBaseScreenControl` (carries `appComponentCode`); code bridges via double cast `x as ScreenObjectBase as CommonAppComponent`. Field mapping from raw rows uses `mapDataRowToType<T>(row, FIELD_CANDIDATES_MAP)` (maps in `utils/fieldMappingConstants.ts` + editor `constants.ts`: `SYS_AC_FIELD_CANDIDATES_MAP`, `SYS_AC_DOCK_FIELD_CANDIDATES_MAP`, `AC_TO_DOCK_MAP_FIELD_CANDIDATES_MAP`).
