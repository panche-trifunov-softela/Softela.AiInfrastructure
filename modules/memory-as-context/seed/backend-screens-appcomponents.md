---
name: backend-screens-appcomponents
description: Backend screen/AppComponent/Dock logic in Softela.SCExpert — endpoints, AppComponentService, the override MergeProperties rule, screen editor CRUD
metadata:
  type: reference
  source: softela-ai
---

Backend (`Softela.SCExpert`, see the backend architecture reference) logic the SCExpert frontend depends on.

**Controllers (`UI/Web/Controllers/`):**
- `AppComponentController` (`api/app-components`): `GET {code}/object?objectId=&screenId=` (objectId & screenId both-or-neither) → `GetObjectAsync`; `GET {code}/data-template/{dtName}`; `GET {code}/data`; `GET base/{type}/data-template`; `POST` Create; `PUT {code}` Update; `PUT {code}/dock-container` & `PUT dock-container/{dockCode}` UpdateDockContainer; `DELETE {code}`.
- `ScreenController` (`api/screens`): `GET {screenId}` → `GetScreenByIdAsync`→`ScreenDto`; `GET {screenId}/object` & `object/{controlId}`; TE data/DT endpoints `te/{tableEditor}/…`; object data/state endpoints; sub-object AC data.
- `ScreensEditorController` (`api/screens/editor`): `POST ""` GetScreenEditorData(AddScreenRequest); `POST {screenId}` Update; `DELETE {screenId}`; `POST {screenId}/clone`; `POST {screenId}/object` AddObject; `POST {screenId}/object/{objectId}` UpdateObject; `DELETE {screenId}/object/{objectId}` RemoveObject; `POST {screenId}/object/{objectId}/clone`; `POST update` Upsert; `GET available-controls`; `GET control/{control}/field/{fieldId}/data`. → `ScreenEditorService` methods AddAsync/UpdateAsync/DeleteAsync/CloneAsync/AddObjectAsync/RemoveObjectAsync/UpdateObjectAsync/GetAvailableControls/GetControlFieldDataAsync.

**AC object build & THE OVERRIDE RULE** (`UI/Web/Services/AppComponentService.cs` + `UI/Web/Extensions/AppComponentExtensions.cs`):
- `GetAppComponentObjectAsync(code, objectId?, screenId?, screenObject?)`: validate screen contains AC → load `SysAc` → load AC DT (`BaseAppComponents.GetDtName(code)`) → build `ScreenObjectBase` (the real screen object if given, else synthetic with `Caption=appComponent.Name`) → **`MergeProperties`** → `SetProperties` → **`MapToAppComponentObjectByType`** → for docks, load `DockComponents` + `Layout` (from `sys_ac_dock` global, overlaid per-user via `SysAcUserDocks` for current user+screen).
- **`MergeProperties`** (THE rule): result = screen object's own `Properties` (the per-screen OVERRIDES) UNION the AC DT field `DefaultValue`s, but only for field names NOT already in the screen object's Properties; `DistinctBy(PropertyName)`. ⇒ **per key: override present → use it; else use AC value.** Feeds both raw `properties` and typed `props`.
- `MapToAppComponentObjectByType`: switch on `SysAc.AcBase` → To{TableEditor,QuickChart,NumericInfoBox,DockContainer,Gauge,Button,Label,LinkList}AppComponent; `SetAppComponentBaseProperties` sets `AppComponentType, AppComponentPropertiesDTName(=GetDtName), AppComponentCode` from the SysAc.
- `ScreenMapper.cs`: `SgScreen.ToDomain()` → `ScreenObjectBase` (Caption, Row=RowNum, Column=ColumnNum, ControlId=ObjId, ParentControl=ParentObjId, FixedSize, ClassName).
- `ScreenDbService.GetScreenByIdAsync` (what `getScreen` hits): for each appcomponent object calls `appComponentService.GetObjectAsync(screenObjectDto)` ⇒ **screen objects from getScreen are ALREADY fully merged** (typed props, merged properties, caption, code, dock content).

Consequence for the frontend: a ScreenBuilder appcomponent `item` (from getScreen) is already merged; `acObjectsMap[code]` (fetched without objectId/screenId) is the BASE AC. The frontend's live-reflect merge must be field-selective for the same reason.

**Data models** (`UI/Data/Models/`): `SgScreen{ScreenId,ObjType,ObjId,ParentObjId,Caption,RowNum,ColumnNum,Classname,FixedSize,Updateddate}`, `SysAc{Code,Name,AcBase,Scope,Username}`, `SysAcDock{Code,Name,DockLayout,SysAcDockDtls,SysAcUserDocks}`, `SysAcDockDtl:BaseSysAcDockDtl`, `SysAcUserDock`/`SysAcUserDockDtl` (per-user dock layout), `SgObjectsValue`/`SgObjectsAttribute` (object property/attribute rows).
