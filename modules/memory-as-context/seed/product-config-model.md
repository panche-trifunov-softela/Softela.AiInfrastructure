---
name: product-config-model
description: The PRODUCT's own model of Screen / Screen Object / App Component / Base App Component / Dock / DT (Data Template) / Display Type / Table Editor / Menu / System Parameter / Screen Generator Editor, all 13 App Component base types, and the Legacy-vs-NG split — distilled from the official product docs
metadata:
  type: reference
  source: softela-ai
---

Companion to [[softela-domain-entities]] and [[backend-screens-appcomponents]], which describe the SAME entities as verified from the codebase and database. This file is the product's own vocabulary and mental model for that entity set, as the docs present it — use it to sharpen or cross-check code knowledge, never to override it (see [[memory-authority-model]]).

## Product documentation capture

Sources read in full: all 8 `app-builder/*` pages, all 9 `rdtng-screen-development-guide/*` pages, and `warehouseexpert/navigating-the-user-interface`, from the SCExpert documentation site. No version number is stamped on the docs site itself; individual pages mention "base product version 25.3" (rdtng code-example page) and features gated "version 26.X and up" (OnBack, PreventBack in RDTNG). Treat the docs as describing the current (26.x-ish) Application Builder UI for the main SCExpert web app, and a distinctly older-style, DB/property-editor-driven model for RDTNG mobile screens.

### 1. Glossary of first-class configurable objects

**Screen** — not explicitly defined as a term anywhere, but treated throughout as the top-level configurable page: created via Screen Editor with `Screen ID`, `Title`, `Help Topic`, `Module`. "Screens and dashboards are based on data stored in the database." A screen is a container of Screen Objects (called "components" in Screen Editor UI, "screen objects" in RDTNG and Menu docs).

**Screen Object / Component** — the docs use "screen object" (RDTNG, Menu, general references like "removes any screen objects where it was placed") and "component" (Screen Editor: "Table Editor", "Tab Control", "Map", "App Component" are the four draggable component kinds) largely interchangeably for the same concept: a node placed on a screen's canvas, identified by an `Object ID` unique within the screen, with `Object Type`, optional `Parent Object ID` (for parent-child nesting), `Row`/`Column` position, `Caption`, `Class Name`. RDTNG uses the same shape (`Object`, `Type`, `Parent`, `Row/Column`, `Caption`, `Class`, `Fixed Size`).

**App Component (AC)** — explicitly and crisply defined: *"App Components are a special kind of component used throughout the SCExpert system. Unlike regular screen objects, an App Component is not tied to a specific screen — it is created and exists independently of any screen."* An AC is created once in the App Component Editor and then *referenced* by screen objects of Object Type "App Component" (or embedded in a Dock). Identified by a `Code` (unique), `Name`, `Base Component`, `Scope` (Application = global, User = private).

**Base App Component** — *"A Base App Component represents an App Component type — it defines what kind of building block you are creating (for example, a chart, a gauge, or a table) and which properties are available for it."* Configured in Base App Component Editor with `Code`, `Name`, `DLL`, `Class`. The docs state there are **13 available App Component types** (see §3) — configurable/creatable objects in their own right, not a hardcoded enum only.

**Dock (Dock Container)** — *"A Dock Container ... does not display any data of its own. Instead, it works as a layout container for other App Components ... A Dock Container can hold any App Component except another Dock Container."* It is itself an App Component (Base type `Dock`/`DOCK_NG`), with its own DT, Code, Name, and dock-specific properties (Dock Code, Column Count, Height, Width, Read Only, Adaptive Height). So Dock is not a separate first-class object family from App Component — it's an App Component type that acts as a grouping/layout construct, edited via the integrated "Dock Editor" (really a specialized view inside the App Component Editor).

**DT / Data Template** — explicitly defined: *"A Data Template (DT) defines the structure and behavior of data within the UI framework. DTs map to database tables from which the DT extracts its data."* And: *"DTs serve as the data source for screens and app components created with the Screen Editor application."* This matches the code-derived model exactly — see the note at the end of §5. A DT has mode-specific sub-variants — `SearchDT`, `GridDT`, `EditDT`, `InsertDT`, `ViewDT`, `DefaultDT` (fallback), `MultiEditDT` — each itself apparently a distinct DT record (not a mode flag on one record) referenced by name from a screen object's properties. A DT contains **DT fields**, each with Core/Validation/Display/Database/Data property groups, one of which is **Display Type** (a per-field property, e.g. checkbox, dropdown, typeahead, textbox) plus **Display Type Properties** (dynamic key/value pairs like `table`, `text_field`, `value_field`, `where`, `filter`, `order_by`, etc., specific to the chosen Display Type). A DT also has DT Field Expressions (conditional logic per field, evaluated server-side at Init or client-side on Events like `ON_CHANGE`) and a **Form Template** (a mini-DSL string like `{header:c2}Title{info:c1}...{all:c1}` that groups fields by `Display ID` into titled sections with column counts, overriding field `Ordinal`).

**Table Editor (TE)** — explicitly called out as a distinct screen-object type ("connects to one or more Data Templates (DTs) to determine which data to display") separate from the App Component "Table Editor NG" (`TE_NG`) type, which is described as read-only and "significantly less functionality" than a screen-object Table Editor ("a full table with pagination, filtering, and create/edit/delete operations"). So **"Table Editor" is used for two different things**: (a) a screen-object component type with full CRUD grid behavior, driven by up to 7 DT variants, buttons, and events; (b) an App Component type (`TE`/`TE_NG`) that is a simpler, read-only, reusable, standalone data table. See §7.

**Menu** — *"The system menu displays the screens available to users. It is configurable..."* A menu entry links a `Screen ID` to a `Label`, optional `Parent_id` (hierarchy), `Ordinal` (order), `href`, `Target`, `Postback`, `Item_id`, `Sub_menu_sql`/`Sub_menu_conn` (dynamic submenu from a SQL query), `Template_dll`/`Template_class`/`Template_data`, `Application ID`.

**System Parameter** — *"You can edit the system parameters table to define and manage the parameters implemented by the SCExpert system"* (e.g. default skin, date format). Edited as name/value pairs; the docs don't describe an underlying schema beyond Value editing.

**Screen Generator (Editor)** — a separate, more manual/low-level screen-authoring tool from the (visual, drag-and-drop) Screen Editor: *"allows you to manually create and edit screens, providing full control over screen structure and configuration."* This is also the tool RDTNG mobile screen development uses (referred to there by its internal short name **SGPR** — "Screen Generator Editor (SGPR)"). Screens created here get `Screen name` and `Module`, then components (screen objects) are added with `+ NEW` one at a time and configured via key/value Properties — no drag-and-drop canvas.

**Language** — a configurable display-language record (`Language ID`, `Short Name`, `Name`, `Direction` LTR/RTL, `Character Set`, `Font`, `Culture`) plus per-language **vocabulary phrases** (Phrase ID = English source, Phrase Translation). Not part of the "screen configuration" domain per se but lives in the same App Builder tool.

**DT Editor** — the tool for creating/editing DTs and their fields; distinct from the Screen Editor. Confirms: *"A Table Editor object connects to a Data Template to determine which data to display."*

The docs do **not** define a separate first-class object called "Screen Object" with its own editor — it is realized as the generic node type placed via Screen Editor/Screen Generator Editor, taking one of a small set of Object Types (Table Editor, Tab Control, Map, App Component, Button, Column Button — and in RDTNG, effectively just Table Editor + Button, nested).

### 2. How the objects relate

```
Application (Module)
└─ Menu entry (Screen ID, Label, Parent_id, Ordinal) ─→ references a Screen (1 Screen ID)
Screen (Screen ID, Title, Help Topic, Module)
├─ contains Screen Objects / Components (1..N), each with unique Object ID within the screen
│   ├─ Table Editor (screen object)
│   │   ├─ references up to 7 DTs by name: SearchDT, GridDT, EditDT, InsertDT, ViewDT, DefaultDT, MultiEditDT
│   │   ├─ has TE Buttons (table-level) and Column Buttons (row-level) — each with an Object Type, properties
│   │   ├─ has Events (Insert/Update/Delete/Get/Click) → Assembly DLL + Class + Method
│   │   └─ may have a Parent Object ID → nested/child Table Editor (parent-child / master-detail)
│   ├─ Tab Control (screen object) — a frame holding multiple child objects, one per tab; cannot nest another Tab Control
│   ├─ Map (screen object) — standalone, has its own property set (Center Lat/Lon, zoom, provider, etc.)
│   └─ App Component (screen object of type "App Component")
│       └─ App Component Code (required) → references one App Component by Code
├─ optional Parent Object ID chains → arbitrary object hierarchy (parent/child nesting), used for
│   master-detail tables and, in RDTNG, for step-by-step wizard flows
└─ Per-Screen Property Overrides on an App-Component screen object: Height, Width, Caption only

App Component (Code, Name, Base Component, Scope)
├─ based on exactly one Base App Component (fixed at creation; defines type + available properties)
├─ auto-generates and owns exactly one DT (name prefixed AC_), which is where its property VALUES live
│   (DT is itself derived/cloned from the Base App Component's own DT)
├─ can be placed on 0..N screens (via screen objects of type App Component) — reused, not copied
└─ if Base Component = Dock Container NG:
    └─ Dock Code (required, 1:1) → the dock's own DT/layout store
        ├─ default layout: 0..N member App Components (any type except another Dock Container)
        │   — the same physical App Component instance, referenced by the dock
        └─ per-screen override layout: show/hide/reposition/resize only, cannot add/remove membership

Drill Down (a relationship between two App Components, or an AC and a screen/screen-object):
  App Component --[Child App Component Code + Mode + Field Mapping]--> child App Component
  App Component --[Target Screen Id]--> another Screen
  App Component --[Target Screen Object Id + Field Mapping]--> a Table Editor screen object (only TE supported today)
  (chains indefinitely; no depth limit stated)

DT (Data Template)
├─ maps to Structure (Table Name) in a Connection (APP/SYS or custom)
├─ contains DT Fields (1..N), each with a Display Type + dynamic Display Type Properties
├─ each DT field may have 0..N Field Expressions (per property, e.g. Required/Format/ReadOnly), each with
│   Initialize flag (server, on load) or Events (client, e.g. ON_CHANGE)
└─ has a Form Template string that groups fields (by Display ID: header/info/all, or custom groups in RDTNG)
    into titled, column-controlled sections, overriding field Ordinal

Language
└─ contains Vocabulary Phrases (Phrase ID → Phrase Translation), reloaded via "Reload Vocabulary"
```

Cardinality notes stated explicitly in the docs:
- Dock Code ↔ Dock Container App Component: **one-to-one** ("a Dock Code can only be linked to a single Dock Container App Component").
- App Component ↔ its auto-generated DT: **one-to-one**, auto-managed, name always `AC_*`.
- App Component ↔ screens/docks that use it: **one-to-many** (same instance reused everywhere; edits propagate everywhere instantly).
- Base App Component ↔ App Component: **one-to-many**, and fixed at creation (cannot be changed after).
- A Dock Container "can hold any App Component except another Dock Container" — i.e. Dock nesting is explicitly disallowed, one level of grouping only.

### 3. Full list of App Component types (the docs' own enumeration)

The docs state there are **13 available App Component types** in the Base App Component table, listing Code / Name / Generation:

| Code | Name | Generation |
|---|---|---|
| `Dock` | Dock Container | Legacy |
| `DOCK_NG` | Dock Container NG | NG |
| `LNK` | Link List | Legacy |
| `CRT` | Quick Chart | Legacy |
| `CRT_NG` | Quick Chart NG | NG |
| `BTN` | Button | Legacy |
| `GGR` | Gauge | Legacy |
| `GGR_NG` | Gauge NG | NG |
| `LBL` | Label | Legacy |
| `NIB` | Numeric Info Box | Legacy |
| `NIB_NG` | Numeric Info Box NG | NG |
| `TE` | Table Editor | Legacy |
| `TE_NG` | Table Editor NG | NG |

That's 13 rows (6 Legacy/NG pairs + the unpaired Legacy-only `LNK` "Link List"). Docs explicitly recommend: *"Always use NG types when creating new App Components. If you still have Legacy App Components, plan to migrate (recreate) them as their NG equivalents."* Legacy `Dock`, `LNK`, `BTN`, `LBL` have **no NG replacement documented** at all (no `LNK_NG`, `BTN_NG`, `LBL_NG` mentioned, and no properties section for Link List/Button/Label as standalone App Components) — only the NG four that get detailed property docs are: Quick Chart NG, Gauge NG, Numeric Info Box NG, Table Editor NG, and Dock Container NG.

Detailed, documented NG component behavior:

- **Quick Chart NG** (`CRT_NG`) — builds charts (Bar/Stack/Full Stack/Pie/Line) from a Data Template, with aggregation (Calculate: Sum/Average/Count; Of; Group By; And By), optional custom SQL/Filter override of the default query, orientation, color palette, legend, 3-D. Shares its aggregation-property shape with the Table Editor's built-in "Quick Chart Modal" popup (a chart you can open ad hoc from any grid's menu).
- **Gauge NG** (`GGR_NG`) — a progress/percentage-ratio dial; needs a DT with 3 numeric fields (Value Field, Min Scale Field, Max Scale Field); pointer/value colors configurable.
- **Numeric Info Box NG** (`NIB_NG`) — a KPI tile: a numeric Value Field plus an optional embedded graph (own Graph Data Template, Graph Value/Category Fields, Graph Type — same chart-type set as Quick Chart, "Gauge" graph type listed as "not yet supported"), Caption Text/Title Text labels, Show Percentage Difference (trend badge), Show Border On Hover (works only when configured purely as a same-screen object filter).
- **Table Editor NG** (`TE_NG`) — read-only tabular App Component; DT + optional custom SQL/Table Name override/Filter Expression/Sort Expression/Group By/Connection Name; explicitly simpler than a screen-object Table Editor (no pagination/CRUD called out).
- **Dock Container NG** (`DOCK_NG`) — layout-only grouping container, documented in §1/§2 above. Column Count defines the grid width (default 72 if empty); pixel width per column = dock width ÷ Column Count; Read Only toggle disables per-screen layout customization for all users; Adaptive Height makes the dock ignore its fixed Height and size to content.

All four documented NG types (except Dock) share:
- **Sizing/Display properties**: Height, Width (0/empty = auto, enforced minimums 60px/80px), Hide Drawer Header, Refresh Interval (0/empty = fetch once).
- **Drill Down properties**: Child App Component Code/Mode(Replace|Modal|Tab)/Field Mapping, Target Screen Id, Target Screen Object Id, Target Screen Object Field Mapping. Object-filter drill-down ("Target Screen Object …") is explicitly stated to work **only against screen objects of type Table Editor today** ("Support for other object types will be added later").
- Per-screen overrides (set from Screen Editor, not the AC editor): **Height, Width, Caption only.**

### 4. Configuration and override mechanism

**Screen authoring paths (two distinct tools, explicitly separate in the docs):**
1. **Screen Editor** — visual drag-and-drop canvas (Application Builder → Screen Editor). Create Screen ID/Title/Help Topic/Module, then drag components (Table Editor / Tab Control / Map / App Component) onto the canvas, fill a right-sidebar property form per component (saved automatically field-by-field, no explicit Save step), link parent-child components by entering the parent's Object ID into the child's Parent Object ID, add Buttons/Events to Table Editors. Has Preview mode. Import/Export as XML.
2. **Screen Generator Editor** (a.k.a. **SGPR** in RDTNG docs) — described as "manually create and edit screens, providing full control over screen structure and configuration": Screen name + Module, then `+ NEW` one screen object at a time, each configured through a raw key/value **Properties** tab (no visual canvas, no drag-and-drop, no live preview mentioned). This is the tool used for **all RDTNG (SCExpertMobile) screen development** described in the rdtng-screen-development-guide pages.

An implementer (non-developer) can, per the docs:
- Create/edit Screens, Screen Objects, App Components, Docks, DTs, Menus, System Parameters, Languages entirely through these Application Builder tools — no code required for standard configuration.
- Attach **custom logic only via named DLL/Class/Method references** (Button `Object DLL`/`Method Name`, Event `Assembly DLL`/`Full Class name`/`Method name`, Base App Component `DLL`/`Class`) — i.e. the editors wire up calls into developer-supplied assemblies but don't contain a code editor themselves. RDTNG additionally supports pointing `ObjectDLL`/`ObjectName` at REST API routes (`api/screens/{ScreenId}/te/{TableEditorId}/data/`) for its button command backend.
- Write **expressions** (a small per-field/per-button DSL, e.g. `if('[0]'=='5'){true}else{false};FIELD:HARVEST`) directly in the DT Editor / RDTNG property values — this is configuration, not compiled code, and covers conditional Required/ReadOnly/Format/Enabled/navigation logic.

**Base-definition-plus-override mechanism, as documented:**
- **Base App Component** is the base *type* definition (DLL/Class + available property schema). An **App Component** is created from exactly one Base App Component (chosen at creation, immutable after) and gets its own DT (`AC_*`) holding the actual configured property *values*. This is a base-definition → instance override pattern. The docs' own vocabulary is "Base App Component" → "App Component" → `AC_*` DT; they never use the string "ACBase_*" for this instance-value DT — see §7 for what `ACBase_*` actually is. No mention anywhere of a customer-specific override table distinct from the instance's own DT. UNVERIFIED whether a deeper base-vs-customer-override layer (e.g., environment-specific overrides of the same App Component) exists — the docs only describe Import/Export XML (Replace Existing / Ignore Timestamp options) as the mechanism for moving/overwriting configuration between environments, which is a file-based promotion mechanism, not a live base+override resolution mechanism.
- **Per-screen overrides** are explicitly narrow and enumerated, not a general override system: for an App Component placed on a screen, only **Height, Width, Caption** can be overridden per screen object (Screen Editor); for a Dock Container's members, only show/hide + reposition/resize (never membership) can be overridden per screen, and only when the dock's `Read Only` property is off.
- **DT-level "override"**: DTs can be **user-specific** — "When the Username column is left blank, the DT applies to all users. When the username is not blank, it is a custom DT for a specific user." This is the closest documented analogue to a base-definition/override split at the DT layer, but it's a parallel per-user DT record, not a base+diff structure.
- Renaming an App Component's Code cascades automatically: renames its DT, and updates every screen object/dock reference to it system-wide. Deleting an App Component cascades: deletes its DT, removes it from every screen object and every Dock Container.

### 5. The DT Editor and display types

**What a DT is** (verbatim): *"A Data Template (DT) defines the structure and behavior of data within the UI framework. DTs map to database tables from which the DT extracts its data."* **DT = Data Template.** This is exactly what [[softela-domain-entities]] already calls it — see the confirmation note at the end of this section.

**DT record fields** (top level): Application ID (always 0 per docs), Name, Label, Structure (Table Name) — the DB table/view source, Connection (APP or SYS), Use DT Connection, Data Provider, Row Attributes, **Form Template**, Column Templates.

**DT "types" by mode** — SearchDT, GridDT, EditDT, InsertDT, ViewDT, DefaultDT (fallback), MultiEditDT — these are the seven DT roles a Table Editor screen object can bind to, each presumably a separate named DT record.

**DT Field** properties, grouped by the docs as: Core (Field Name, Label, Display ID, Application Group, **Display Type**, Data Type [.NET type, e.g. System.String/Boolean/Int32], Default Value, Ordinal), Validation (Required, Allow Null, Max Length), Display (Visible, Read Only, Hidden, Input in Grid, Label Position/Align, No Wrap, Is Sticky Field), Database (Is DB Field, Primary Key, Column Index, Column Count), Data (Default value, Format, Search Type [Exact/Range], Formula, Field Description).

**Display Type** is explicitly a field-level property (a string value like "checkbox, dropdown") — *"UI Control type (e.g., checkbox, dropdown)"* — and each Display Type carries its own **Display Type Properties**, a dynamic key/value set that "vary based on the Display Type": `table`, `text_field`, `value_field`, `where` (static filter), `order_by`, `filter` (dynamic filter expression), `IgnoreCase`, `record_limit`, `commas`, `decimals`, `min_value`, `max_value`, `translate`, `Target` (`_blank`/`_self`, for link fields), `connection`, `extra_fields`. Doc note: *"Field properties are dynamic and vary based on the Display Type and can include the following. ... this list is not exhaustive and fields can have additional type-specific properties."* — i.e. the docs do **not** give a closed enumeration of all Display Types or all their properties; dropdown/typeahead/textbox/link are the only ones named explicitly across all pages read (plus, in RDTNG, an explicit "Textbox" behaving as a validated Typeahead — the "Sticky Textbox" pattern — and dependent/filtered Typeahead fields). **Display Type is unrelated terminology from DT** — same two-letter overlap only, worth keeping sharp: DT = Data Template (the record); Display Type = a per-field property of a DT field.

**No standalone "DT Editor" object model beyond what's above** was found — i.e., the docs never describe a DT as containing anything other than its field list + Form Template + Column Templates. There is no documented concept of "Display Type" as its own first-class configurable catalog object (with its own list/editor) separate from being a per-field property value — UNVERIFIED whether such a catalog exists elsewhere in the product; these pages only show Display Type chosen per field and its Properties edited per field.

**Form Template DSL**: `{groupId:columnSpec}Optional Title` segments, e.g. `(all:r4)` (all fields, 4 per row) or `{header:c1}Line info{Info:c1}Confirm Location{all:c1}` (named field groups by shared `Display ID`, each rendered in its own titled section with a column count). This takes precedence over field Ordinal when present. RDTNG's step-4 page reiterates the same DSL but with fixed section names **Header / Info / All** (case-shown lowercase in the tag) and states Info never splits into columns ("column value is ignored").

**Confirmation vs. the code-derived model**: DT = Data Template is exactly [[softela-domain-entities]]'s own reading, and the backend/frontend agree — the backend has 265 occurrences of "Data Template" vs. 10 of "data table" (those 10 refer to an unrelated `RandomData` table, not this concept), the frontend 19 vs. 0, and the stored exports in [[softela-reference-exports]] live in a folder named `data-templates`. No correction needed here — the docs and the code-derived model use the same term for the same thing.

### 6. RDT NG screen development

The `rdtng-screen-development-guide` pages describe building/customizing **SCExpertMobile (RDT/RDT NG)** screens — i.e., the handheld/mobile workflow UI (picking, replenishment, etc.), explicitly distinct from the main desktop SCExpert web screens covered by app-builder/Screen Editor. Key points:

- Uses the **Screen Generator Editor (called SGPR here)**, not the Screen Editor — a different, more manual tool (see §4). No drag-and-drop is described anywhere in these 9 pages; every object and property is added via `+ NEW` forms.
- A new RDTNG screen = a Screen Generator Editor entry (`Screen Name`, `Module`) containing one or more **Table Editor screen objects**, each with `Object`/`Type`/`Parent`/`Row`/`Column`/`Caption`/`Class`/`Fixed Size`, and each Table Editor step configured via key/value Properties (`DefaultDT`, `DefaultMode=16` for Search, `OnBack`, `PreventBack`, `DefaultButtonId`, `FocusField`, `TaskType`, `Capture`).
- Multi-step / wizard flows are built by chaining Table Editors as parent→child via `Parent` (Object name of the previous step's Table Editor) — same generic parent-child screen-object mechanism used in the main Screen Editor, reused here specifically to model a step, not a data master-detail relationship.
- Buttons on RDTNG screens drive both navigation and backend calls: `CommandName` (action, e.g. Search/Confirm), `ObjectDLL` (backend project, e.g. `softela.infra`, `softela.warehouse`), `ObjectName` (API controller route, e.g. `api/fullpick/`), `OnSuccess` (navigation expression evaluated against the API response, supporting unconditional/conditional navigation + field clear + focus control), `RequiresValidForm`, `Init` (clean flow restart), `Enabled` (expression), `ConditionForDialog`/`ConfirmMessage`, `ViewType` (search|view, for the built-in 2-step Search→View pattern), `PreventBack`.
- A **"Search → View" 2-step pattern using a single Table Editor** is documented as not requiring any backend screen service at all — data comes automatically via SqlKata, driven purely by SearchDT/GridDT + two buttons (`SearchToGrid`/`GridToSearch`) pointed at generic `softela.infra` API routes.
- DT editing for RDTNG happens in the **same DT Editor** as the main product, using the same Form Template DSL (Header/Info/All sections), confirming RDTNG shares the DT/DT-field configuration model with the rest of SCExpert rather than having a separate one.
- RDTNG adds two field-display behaviors not mentioned in the main app-builder DT docs: **"Sticky Textbox"** (DisplayType=Textbox + `isStickeyField:true` → renders as textbox but validates like a typeahead in real time, blocking Next on invalid values) and **dependent/filtered Typeahead** (DisplayType=TypeAhead with a `Filter` Display Type Property referencing another field's live value, e.g. `SKUID ='[0]';FIELD:SKUID`).
- Menu registration for a new RDTNG screen is **not done through the App Builder Menu screen** — it's a direct DB step: *"Go to the DB. Insert a record into the MOBILESCREEN table."* This is notably lower-level/less "configured through an editor" than every other object type covered.
- Permissions are mentioned only as a stub: "function-level and object-based permissions, using object ID and function assignments to control access" — no further detail given.
- Extensibility: a documented pattern exists for extending/replacing default button behavior via an external .NET 4.8 project (`RDTNextGen.Api.Extensiblity`) — this is developer-level, code-based extensibility layered on top of the configuration model, referenced only by name/DLL from screen object properties.

**Conclusion: RDT NG is the same underlying configuration primitives (Screen, Screen Object/Table Editor, DT, DT Field, Display Type, Button, Event/API-route) as the main SCExpert UI, but authored through a different, lower-level editor (Screen Generator Editor / SGPR) with mobile-specific properties (OnBack, PreventBack, TaskType, Capture, ViewType) and a DB-direct step for menu registration.** It is not a separate configuration model, but it is a separate *authoring surface* with materially less tooling (no visual canvas, no live preview, no integrated App-Component-style editor cross-linking documented).

### 7. Differences between the docs' framing and the code-derived model

These are genuine sharpenings/additions the docs give beyond what the code-derived model already states — not corrections to it:

1. **"Table Editor (TE) is the grid component" is only half the story — there are two distinct things both called Table Editor.** (a) A screen-object component type with full CRUD/pagination/search, bound to up to 7 DT roles. (b) An App Component type, `TE`/`TE_NG` ("Table Editor NG"), which the docs explicitly say has "significantly less functionality and a simpler configuration ... a read-only representation of data rather than a full table with pagination, filtering, and create/edit/delete operations." Worth flagging so nobody assumes AC-placed "Table Editor" instances support inline CRUD.

2. **The docs count 13 Base App Component types**, of which Dock Container NG is a 5th documented-in-depth kind alongside Quick Chart NG, Gauge NG, Numeric Info Box NG, and Table Editor NG — each with its own dedicated properties section (Dock Code, Column Count, Read Only, Adaptive Height). Four more Legacy-only types (Dock legacy, Link List, Button, Label) are named with no documented NG replacement at all.

3. **Dock's constraints are more precise than a generic "grouping construct" implies**: it can hold *any* App Component *except another Dock Container* (no nested docks), it has a two-tier layout model (default layout vs. per-screen override layout) with the override tier constrained to show/hide/reposition/resize only (never add/remove membership), and its own Column Count property literally is the App Component's DT-stored config.

4. **Screens are authored through editors rather than coded, but the docs reveal two materially different editors, not one uniform experience**: the visual drag-and-drop **Screen Editor** (main desktop SCExpert) vs. the manual, form-only **Screen Generator Editor** (used for both some main-product screens and, per the rdtng guide, for *all* RDTNG mobile screens). RDTNG mobile screens are built exclusively through the more primitive Screen Generator Editor with a raw key/value Properties tab and no visual canvas or live preview described.

5. **The `ACBase_*` naming is real and not surfaced by the docs — a naming gap, not a contradiction.** The docs describe the mechanism as Base App Component → App Component → auto-generated `AC_*` DT (the instance's own value-holding DT) and never use the literal string `ACBase_*` anywhere. It is nonetheless real and verified in the captured configuration recorded in [[softela-reference-exports]] — five records exist: `ACBase_CRT_NG`, `ACBase_GGR_NG`, `ACBASE_NIB_NG`, `ACBase_TE_NG`, `ACBase_DOCK_NG` — matching precisely the five NG App Component types the docs document in depth (§3). Read as: `ACBase_<TYPE>` DTs are the base-type property DEFINITIONS (what properties exist and how they render), while `AC_<CODE>` DTs (documented) hold one concrete App Component instance's VALUES for those properties. The docs simply never name the base-definition DT.

6. **Screen Object ↔ App Component relationship is more specific than "Screen contains Screen Objects."** A screen object of Object Type "App Component" doesn't configure a component inline — it just holds an `App Component Code` pointer to an independently-existing, independently-editable App Component. This reuse/independence (*"it is created and exists independently of any screen ... you can place it on multiple screens or dashboards without recreating it"*) is a meaningfully different relationship than the other three screen-object kinds (Table Editor, Tab Control, Map), which the docs describe as configured entirely inline, on the screen, with no reusable identity elsewhere.

7. **No contradiction found for**: Screen → Screen Objects containment; Dock as grouping; DT driving field rendering (Display Type); Screen/AC/Dock/DT editors as the authoring surfaces (modulo #4 above). Where the docs are silent, the code/DB knowledge in [[softela-domain-entities]]/[[backend-screens-appcomponents]] fills the gap and vice versa.

### 8. Version and staleness signals

- No single "product version" banner appears on any of the 17 pages read. The one explicit version stamp found is in `rdtng-screen-development-guide/code-example-for-extensibility`: *"the base product version 25.3"* (for the sample project's target screen `RDTFullPick`). This suggests the docs corpus is roughly contemporaneous with a 25.3/26.x product line — consistent with [[product-integration-identity]]'s "25.3" baseline for the Web API/Identity docs.
- Two RDTNG properties are explicitly gated to a version: **`OnBack`** and **`PreventBack`** are both marked "(version 26.X and up)" — i.e. these are newer additions; screens/environments on older RDTNG builds won't have them.
- **"Recommendation: Always use NG types when creating new App Components. If you still have Legacy App Components, plan to migrate (recreate) them as their NG equivalents."** — explicit, current guidance that the Legacy generation (Dock, LNK, CRT, BTN, GGR, LBL, NIB, TE) is being phased out in favor of the `_NG` suffix generation. Anything encountered in code/screens still using a Legacy AC type code should be read as older/pre-migration configuration, not as the current recommended pattern.
- `Numeric Info Box NG`'s `Graph Type` property lists **Gauge "(not yet supported)"** as an option — a forward-looking/incomplete feature explicitly flagged as such in the docs themselves.
- Drill-down's object-filter targeting is explicitly limited today to Table Editor screen objects only, twice, both times phrased as a current limitation with future intent: *"Support for other object types will be added later."* Treat any assumption that Gauge/Chart/NIB screen objects can be filter-drill-down targets as currently false per docs, subject to change — relevant background for anyone configuring advanced App Component drill-down filters and field mapping.
- The captured corpus includes a page literally named `OLD__navigating-the-scexpert-user-interface.md` (15KB, distinct from the current `warehouseexpert__navigating-the-user-interface.md`, 22KB) — not read for this assignment since it wasn't in scope, but its filename is itself a staleness signal: the product docs site retains a superseded UI-navigation page alongside the current one. If pre-App-Builder-era UI navigation info is ever needed, that OLD page is the place — but nothing in it should be treated as current.
