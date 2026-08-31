---
name: backend-architecture
description: Softela.SCExpert (.NET 10, formerly Softela.Infra.Api) solution structure, UI project layers, conventions, git workflow
metadata:
  type: reference
  source: softela-ai
---

`Softela.SCExpert` — .NET 10 multi-project solution `Softela.SCExpert.sln` (**renamed from `Softela.Infra.Api` / `Softela.Infra.Api.sln`**; the old `Softela.Infra.Api` checkout is gone from disk — this is the only backend repository). (It has root `CLAUDE.md`/`AGENTS.md` — IGNORE them as a source of truth, see the guidance on ignoring in-repo instruction files; rely on code + memory + the developer.) Domain-driven modules: **Infrastructure** (auth, users, system params, UI framework), **Warehouse** (receiving/picking/shipping/inventory), **BFF** (`SCExpert.BFF`, `SCExpert.MobileBFF` — gateway/aggregation), **Common** (shared libs/middleware), **UI** (dynamic UI framework — the part the SCExpert frontend talks to), **DTImporter** (DT import tooling), plus Reporting, TranslationService.

Per-module layering: `WebApi/` (controllers, Program.cs, middleware, Swagger), `Services/` (business logic, DI), `Data/` (EF Core models, DbContext), `Dtos/`/`Abstractions/` (contracts), `Sdk/` (typed HTTP clients), `Tests/`.

**UI project** (most relevant to the SCExpert frontend), under `UI/`:
- `UI/Web/Controllers/` — entrypoints: `AppComponentController` (`api/app-components`), `ScreenController` (`api/screens`), `ScreensEditorController` (`api/screens/editor`), `DataTemplateController`, `DataTemplateCustomizationsController`, `MenuController`, `PermissionController`, `DbConnectionsController`, `ImportExportController`, `VocabularyController`, `WarehousesController`.
- `UI/Web/Services/` — `AppComponentService` (1577 lines), `ScreenDbService` (`GetScreenByIdAsync`), `ScreenEditor/ScreenEditorService` (screen+object CRUD), `DataTemplateService`/`DataTemplateDataService`/`DataTemplateCustomizationService`, `MenuService`, `PermissionService`, `ScreenGenerator/Handlers/*` (event handlers), `ScreenMapper.cs`, `Cached/*` (cache decorators), `DataProviders/`. Extensions in `UI/Web/Extensions/` (`AppComponentExtensions`).
- `UI/Abstractions/` — interfaces + DTOs: `Screens/` (`ScreenDto`, `ScreenObj`, `Objects/ScreenObjectBase`+`GenericScreenObjectDto`+`ScreenProperties`, `Editor/` Add/Update requests, `Enums/TableEditorMode`…, `Generator/`), `AppComponents/`, `Connections/`, `Permissions/`, `DataProviders/`.
- `UI/Data/Models/` — EF models: `ScreenGenerator/SgScreen` (sg_screen), `SysAc`, `SysAcBase`, `SysAcDock`, `SysAcDockDtl`, `SysAcUserDock`, `SysAcUserDockDtl`, `Dts/*`, `SysMenu`, `SysPermission`, `Conn`/`ConnType`, `Warehouse`, etc. `UiDbContext`. Oracle + SqlServer providers (`UI/Oracle`, `UI/SqlServer`).

DB: SQL Server (primary) + Oracle via EF Core; SqlKata + DAB in places. Multiple DbContexts. JWT auth + warehouse context middleware. Serilog logging.

**Conventions:** git flow is project-wide — see the shared git-flow reference (branch off `dev`/`dev-ng`, rebase not merge, Azure DevOps squash-merge with branch delete, NO `Co-Authored-By: Claude` trailer, commit `#<workitem> - <Imperative summary>`, PR target `dev` never master). Code style (verify from code/.editorconfig, NOT the repo `CLAUDE.md`): `dotnet format` before commit; 4-space indent, file-scoped namespaces, `I`-prefixed interfaces. Build: `dotnet build Softela.SCExpert.sln -c Debug`; test: `dotnet test`.

Screens/AC/Dock business logic detailed in the backend screens/app-components reference.

## Verified detail: target framework

- `UI/Web/Softela.Infra.Ui.Web.csproj` line 4 → `<TargetFramework>net10.0</TargetFramework>`.
- `UI/Tests/Softela.Infra.Ui.Tests.csproj` line 4 → `<TargetFramework>net10.0</TargetFramework>`.
- `dotnet test` output confirms the run happens on `.NETCoreApp,Version=v10.0`.

The solution is on .NET 10, not .NET 8 as older notes may claim.
