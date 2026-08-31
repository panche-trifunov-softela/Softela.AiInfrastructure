---
name: softela-domain-entities
description: SCExpert core domain model — Data Template (DT), Screen, Screen Object, App Component (AC), Dock Container — and their DB tables
metadata:
  type: reference
  source: softela-ai
---

Metadata-driven entity model (shared concept across the frontend architecture reference and the backend screens/app-components reference):

- **Data Template (DT)** — the base building block. Defines fields (`DTField`) each with a `DisplayType` (textbox, dropdown, numeric_textbox, date_box, typeahead, multi_select…) and per-display-type `Properties` (e.g. a `dropdown` field carries `connection`, `table`, `text_field`, `value_field`, `where`, `order_by`, `value_list`). System/base DTs are derived into DTs for components, DB tables, search, etc. Entities import/export as **XML** (`<DataTemplates><DataTemplate>…<DTFields>`). Example: `dtScreenGeneratorAppcomponent` drives the AC properties panel; its `AppComponentCode` field is a DB-backed dropdown over table `sys_ac` (connection `SoftelaSchema`, value_field `code`, text_field `name`). Backend DT name for an AC = `BaseAppComponents.GetDtName(code)`.
- **Screen** — hosts components ("objects"). Can be added to nav menu, have permissions. DB: `sg_screen` rows (one per object) → model `SgScreen` {ScreenId, ObjType, ObjId, ParentObjId, Caption, RowNum, ColumnNum, Classname, FixedSize, Updateddate}. Fetched via `getScreen` → `ScreenDto`.
- **Screen Object** (= "object"/item on a screen) — a placed component. Many `type`s (see the frontend `OBJECT_TYPE`): `tableeditor`, `tabcontrol`, `appcomponent`, `screenbuilder`, `appcomponenteditor`, `acdockeditor`, `map`, `reportdesigner`, etc. Identity/layout fields (screenId, objId, row, column, parentControl) are screen-specific. An object can carry per-screen **override** properties.
- **App Component (AC)** — components created globally (system-wide), reusable on any screen. Types based on different ACBase DTs. DB: `sys_ac` rows → model `SysAc` {Code, Name, AcBase, Scope, Username} + a per-AC DT. Base types in `SysAcBase`; frontend `APP_COMPONENT_TYPE` (DOCK/DOCK_NG, GGR, NIB, CRT, TE, BTN, LBL, LNK …, `_NG` = next-gen).
- **Dock Container (Dock)** — a special AC that contains other ACs with a configurable layout (no data of its own). DB beyond `sys_ac`+DT: `sys_ac_dock` (model `SysAcDock` {Code, Name, DockLayout, SysAcDockDtls, SysAcUserDocks}) + `sys_ac_dock_dtl` (global layout detail) + `sys_ac_user_dock`/`sys_ac_user_dock_dtl` (per-user layout). Layout is split **global vs per-user**.

**Override rule (critical):** a screen object placing an AC has per-screen override properties; the effective object = per-key (override wins, else AC default), applied to both raw `properties` and typed `props`. Identity/layout fields stay screen-specific. Full backend mechanics are in the backend screens/app-components reference.
