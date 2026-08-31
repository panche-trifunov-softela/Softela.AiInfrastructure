---
name: softela-reference-exports
description: What exported SCExpert screens and base AC data templates look like, why they matter, and the rule that externally-provided files are read-only
metadata:
  type: reference
  source: softela-ai
---

SCExpert screens and Data Templates (DTs) can be exported to XML, and a developer's own exported copies are worth keeping as real configuration examples — so a question like "how could this be configured / what does it look like" can be answered by reading a file instead of guessing at a property's shape or a config string's format.

## What an exported screen looks like

Exported screens use the naming pattern `SG_<screen-id>.xml`. Two useful categories to keep on hand:

- The product's own built-in configuration screens — the tooling by which everything else is configured. This set typically includes: a Screen Editor (a.k.a. Screen Builder); a legacy Screen Generator Editor (the older approach to editing screens and their objects, still useful for adding custom objects and properties the newer editor does not expose); a Data Templates screen (the only place DTs are created, edited and deleted); an AC Editor; and a Dock Editor.
- Ordinary business screens with varied configuration, kept as a testbed for features and fixes.

Exactly which screen id maps to which of these varies by deployment and is not reproduced here — treat any specific short screen code as something to confirm in the running system, not as a fixed fact to memorize.

## What an exported base Data Template looks like

The **base** DTs define the property set of each AC type. Each concrete App Component gets its own DT with an `AC_` prefix derived from one of these (see the domain-entities reference; the naming rule is `BaseAppComponents.GetDtName` / `GetDtBaseName`):

- `DT_ACBase_TE_NG.xml` — Table Editor
- `DT_ACBase_CRT_NG.xml` — Quick Chart
- `DT_ACBase_GGR_NG.xml` — Gauge
- `DT_ACBASE_NIB_NG.xml` — Numeric Info Box
- `DT_ACBase_DOCK_NG.xml` — Dock Container

**These are where AC property metadata actually lives** — `Label`, `DisplayType`, `MaxLength`, `DtFieldHelp`, `Ordinal`, and the `value_list` option strings. None of it exists in the backend source repository, so an exported base DT is the only readable record of it. When reading one of these files for separator conventions inside a field's option strings, verify the exact delimiter directly from the file rather than assuming a convention.

## STANDING RULE — externally-provided files are READ-ONLY

**Why:** unless a developer says otherwise, a file they hand over is for familiarisation only — it must not be modified until they separately ask for a change.

**How to apply:**
- Modify only your own memory and files inside the project repositories. Nothing else.
- Anything a developer hands over from outside those locations — a downloads folder, an exported XML file, a spec document — is reference material. Read it, and if you keep durable notes about it, save your own notes; never edit the provided file in place.
- If the file's original location is likely to be cleared or is otherwise temporary (a downloads folder, a scratch directory), copy anything worth keeping into durable storage promptly — an uncopied file living only in a temporary location is easily lost.
- This does not bar writing *about* the provided files — updating memory, or updating documentation that lives inside a repository, stays fine.
