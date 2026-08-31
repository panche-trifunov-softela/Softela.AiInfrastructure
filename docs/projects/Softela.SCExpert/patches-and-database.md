# Patches and database changes — Softela.SCExpert

Sourced from the organisation wiki's patch-creation and database-changes
pages. The example paths and project names below are quoted from that
source and have not been independently verified against the current
solution layout in this repository — check them against the actual project
names before relying on an exact path. The rules themselves (what a patch
manifest must contain, what a DB or DT change must be accompanied by) are
the durable part; the example paths are illustrative.

## Patch manifests

A hotfix is built from a manifest file, `patch.json`, at the repository
root. It defines exactly which files the hotfix includes — nothing is
inferred from a diff or a build output folder.

```json
{
  "patchId": "<...>",
  "files": [
    "Softela.SCExpert.API\\bin\\WMS.Logic.dll",
    "WMS.WebApplication\\bin\\WMS.WebApp.dll",
    "dt\\dt_dtsku.xml"
  ]
}
```

- `patchId` — a unique name for the patch, usually aligned with the version
  it ships as.
- `files` — every file that must be included, and nothing that does not
  need to be there.

Rules:

- Paths are **relative** to the working directory, never absolute.
- Paths must match the actual folder structure exactly.
- Paths use **double backslashes** (`\\`) as the JSON escaping requires.
- A file list may mix specific files of any kind — `.dll`, `.json`, `.xml`,
  and source files such as `.vb` or `.cs` from `WMS.WebApplication` or
  `WMS.MobileWebApp` when the change touches them — from multiple folders.
- Only files genuinely required for the patch belong in the manifest. A
  manifest is not a changelog; padding it with untouched files makes the
  hotfix larger and riskier than it needs to be.
- **`SYS-upgrade.sql` must always be included when the patch changes the
  version.** A version bump without the upgrade script is a hard error — a
  hotfix that changes version but omits it will not apply cleanly.
- **The manifest is cleaned on every hotfix.** It is not a running list
  carried forward from the previous one; each hotfix gets its own file list
  starting from nothing.

**A patch manifest missing its upgrade script when the version changes is a
hard error.** Guard: `patch-manifest`.

If a change depends on additional files beyond the obvious ones — a
dependency the manifest needs to carry along — that has to be identified and
added explicitly; nothing about the manifest format infers dependencies for
you.

## Database and DT changes

Every database-affecting change is expected to update the matching script
folder, not only the code that triggers the change at runtime. The
organisation's own methodology, quoted directly because the exact wording
of "which script for which kind of change" matters more than a paraphrase
would:

- **AppComponents** — change or update it in this folder when an app
  component changes.
- **DBscripts** — upgrade and create scripts for the databases, split by
  target:
  - **Customer Access changes** — schema script and data script.
  - **SYS** — schema script, data script, upgrade script, and both
    vocabulary create and vocabulary upgrade scripts.
  - **WH** — schema script, data script and update script.
  - **Demo** — schema script (same shape as WH) and data script.
  - **Local config for QA/dev** — a config folder for default demo data used
    only for internal testing; scripts here enable quick local setup (for
    example, enabling the Connect service and its plugin for testing) and
    are explicitly **not part of an official release**.
- **DTs** — every DT change, and every new DT, must be committed with the
  DTs. The change must be documented for delta tracking in the update log
  (the wiki page is inconsistent about the exact filename — it uses both
  `Updated.txt` and `Update.txt` in different places; confirm which one this
  repository actually uses before relying on either spelling).
- **ScreenGenerator** — a screen change is added to the `ScreenGenerator`
  folder and logged in the update file, same as a DT change.

The wiki source does not say which repository root these folders
(`AppComponents`, `DBscripts`, `DTs`, `ScreenGenerator`) live under in
`Softela.SCExpert` specifically — confirm the actual paths in this
repository rather than assuming the wiki's generic description maps
directly onto it.

The underlying rule, independent of the exact folder names: **a database,
DT or screen change is not complete until the matching script folder and,
for DTs and screens, the delta-tracking log, are updated alongside it.** A
code change to one of these areas without the accompanying script update is
a change that will not reproduce in another environment.
