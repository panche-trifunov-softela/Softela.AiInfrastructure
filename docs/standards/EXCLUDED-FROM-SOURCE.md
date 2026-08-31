# Excluded from the source documents

`docs/standards/` is a portable rulebook: no real paths, file names, line
counts or screen names. The two source documents it was split from —
`FRONTEND_ARCHITECTURE_STANDARD.md` (2106 lines) and its companion
`CODE_DOCUMENTATION_STANDARD.md` (194 lines) — are not portable; they were
written against one specific codebase, at one point in time. Every section
of either document not carried into this directory is listed below, with
where (if anywhere) it went instead, so the exclusion can be checked rather
than taken on trust. Nothing below is a judgement that the excluded content
was wrong — only that it does not belong in a document meant to apply to any
project.

## `FRONTEND_ARCHITECTURE_STANDARD.md`

**§1, "Status and How to Read This" — the wider-team-approval framing.**
The source document's own text describes itself as "submitted for approval
at the wider-team level" and "not yet a joint decision." That framing was
accurate when the document was circulated, but it is now superseded: the
frontend architecture sync that reviewed the document settled it — for new
code, the team already follows it; existing code moves toward it a piece at
a time as it is touched, not in one sweep (see the sync's own recording and
`docs/standards/README.md#status-and-provenance`). Carrying the stale "not
yet a joint decision" sentence forward as if it were still current would
misstate where things actually stand. The two genuinely portable parts of
§1 — the MUST/SHOULD/MAY requirement levels, and the three-point scope of
enforcement (new code, touched code, untouched code) — were *not* excluded
and are restored in `README.md`.

**§2, "Where We Are Today."** The numbers (802 files, the ten largest
files, files over each threshold) and the specific existing folders named
as partial precedent (`appComponentEditor`, `dockEditor`, and the rest) are
one repository's snapshot at one point in time; they belong in
`docs/projects/<repository>/current-state.md`, not in a document meant to
outlive any single measurement. The two general observations this section
makes — that the pattern tends to already exist independently before it is
written down, and that the largest files are the ones nobody wants to
touch — are portable and are restored, generalised, in
[`rationale.md`](./rationale.md).

**§4, "Top-Level Structure" — the table of real folder names**
(`assets/`, `services/`, `store/`, and the rest) and the specific note that
`providers/` is being removed. The table names one project's actual root
layout; the `providers/` item names a real folder in that project that no
longer fits its own name. Both are project-specific — a real instance of
the `providers/`-style decision belongs in a project's own migration
backlog. The general rule this table exists to state — the root is for
code that is shared by nature or that has grown into being shared, and
single-consumer code belongs with its one consumer — did **not** have a
portable home anywhere in the original split; it is restored in
[`shared-code-boundaries.md`](./shared-code-boundaries.md), including the
general form of the "one-occupant folder" rule — delete a folder that has
shrunk to one occupant no longer matching its name, and move that occupant
to wherever it actually belongs.

**§6.6, "Styles: No Rule Yet" — the specific `sx` vs. SCSS-module
measurement.** Whether styling in one particular project leans toward one
approach or the other is a fact about that project, not a portable rule.
The decision itself (`MAY`, not `SHOULD`, until measured) is carried in
`component-structure.md`; the two prerequisites for revisiting it, and the
genuinely open question itself, are tracked per-project in that project's
own `docs/OPEN-DECISIONS.md`.

**§8, "Size Limits" — `src/theme.ts` (2,809 lines) and the "30 files at
warning, 17 at critical" count.** A real file and a real measurement,
excluded as repository-bound; `file-size.md` uses a generic "declaration
table" example instead, which carries the same point without the name.

**§9, "The Same Pattern Beyond Components" — `uiCoordinationStore.ts`
(876 lines), `useExportDataToFile`, `konva-map`.** Real store and hook
names from one project, used as worked examples. The pattern they
illustrate — a store, a context or a root-level hook gets the same
store/utils/selectors split a component does once it outgrows one file,
and stores and API services keep their types at the shared root rather
than colocating them — had no portable home in the original split; it is
restored in [`shared-code-boundaries.md`](./shared-code-boundaries.md)
without the real names.

**§10.4, the nonce-based coordination store's real type and hook names**
(`Nonce`, `BaseUiRequest`, `UiEvent<T>`, `useNonceGuardedEffect`, and the
rest) and the `utils/eventBus` / `mitt` fold-in. Real identifiers, excluded
as repository-bound and covered concretely in a project's own migration
backlog. The general pattern — mark a fire-once signal's payload with a
monotonically increasing identifier so a newly mounted consumer can tell a
fresh signal from a stale one, and fold a second signalling mechanism into
the first one a project has already agreed on — is carried in
`state-management.md` and was not excluded.

**§11.1, the concrete type-folder tree** (`src/types/<service>/request/`,
`response/`, `enums/`) and **§11.2's `Nullable<T>` / `Undefined<T>` /
`Maybe<T>` generics declared in `src/types/global.d.ts`.** The literal
paths and generic names are repository-specific; the shape they describe
(contracts filed per backend service, then by domain concept; a project's
own globally declared nullability helper types preferred over hand-written
unions) is portable and is restored, generalised, in `types.md`.

**§12.1, the literal file inventory** (`src/services/Api.ts`,
`src/services/api/screens.ts` at 893 lines, `table.ts`, and the rest) and
**§12.2's `urlConsts.ts`.** Real files in one project's API layer, excluded
as repository-bound; the target shape they justify (one file per
controller, route constants, no bare HTTP client in feature code) is
carried in `api-layer.md` using placeholder names.

**§13, "Documentation" — "In this structure the load falls where it is
cheapest."** This paragraph (which file in a component folder carries most
of the documentation burden, and why a well-split component needs less
prose) named no repository-specific fact; it was **missed** in the original
split rather than deliberately excluded, and has now been restored in
`code-documentation.md` under "Where the load falls in a well-split
component."

**§14.2, "The Current Situation" — `src/tests/` vs. `src/__tests__/`, and
the 123-spec-file count.** Two real folder names and a real count, excluded
as repository-bound; a project's own instance lives in
`docs/projects/<repository>/current-state.md`. The decision this section
records (co-located specs, not a central mirrored tree) is carried in
`testing.md` without the real names.

**§15, "Reuse and the `@softela` Packages" — the specific package names**
(`@softela/basic`, `@softela/common`, `@softela/display-type`). Real dependencies of
one project, excluded as repository-bound and tracked, where their future
is unsettled, in that project's own `docs/OPEN-DECISIONS.md`. The portable
rule this section states — before writing something new, search the
component's own folder, its parent, the shared root, then any shared
package; a well-formed unit is usually close to extractable, and it is
worth building product-agnostic where that costs nothing — is restored in
`principles.md`.

**§16, "AI Coding Agents" — the `AGENTS.md`/`CLAUDE.md` setup narrative
and "Instructions files alone are not enough."** These two subsections
argue for creating a single agent rulebook, a pointer file, committed
settings, skills and hooks, and project memory, checked into the
repository rather than left to individual laptops. That argument is not
restated here because this infrastructure repository **is** that outcome,
already built and installed rather than merely proposed —
`templates/repo-pointer/AGENTS.md` is the pointer file the source document
argues for, and `core/guards/`, `modules/` and this repository's own
memory conventions are the committed settings, hooks and skills it asks
for. Restating the argument for building something that already exists
would be narrative, not a rule. The behavioural rules this section states
for an agent itself (never invent, reuse before writing, report clearly,
delegation and model-tier discipline) are carried in `agent-rules.md`.

**§17, "Migration Plan" — the real Phase 3 priority table** (the ten
largest files, by name, with a suggested order) **and the "endpoints.ts
early if capacity appears" note.** Both name real files in one project;
they live in `docs/projects/<repository>/migration-backlog.md`. The
general shape of the plan — no big-bang refactor, four phases, the Boy
Scout rule's two explicit limits, how a scheduled refactor is defined as
done — did not have a portable home in the original split; it is restored
in [`migration-approach.md`](./migration-approach.md).

**§18, "Open Questions."** This section mixed two different things: a
question the team had already settled, with its reasoning for rejecting
the alternative, and a question the team had explicitly deferred or left
open. Both kinds also carried repository-specific specifics inside several
answers (real folder and file names in questions 4, 5, 7, 13; the real
package name in question 15), excluded as repository-bound the same way as
elsewhere in this document.

For a settled question, the outcome is now folded directly into the part
of the standard it belongs to, as a rule in that document's own voice —
question 7's folder-hygiene rule is in `shared-code-boundaries.md`,
question 8's `MAY` decision is in `component-structure.md`, and so on
through the rest. **The deliberation behind each — the alternatives
considered, why the losing option lost — is deliberately not carried
forward**: a rule earns its place by being followed, not by having its
history attached, and keeping the history would have meant maintaining a
second, parallel document nobody but this one referenced. For a question
that was still genuinely open, or answered only with a current, revisable
position rather than a settled rule, the question itself — not the
now-discarded reasoning that used to sit beside it — moved to
`docs/OPEN-DECISIONS.md`.

## `CODE_DOCUMENTATION_STANDARD.md`

Nothing in this document is repository-bound — it names no real file,
folder, store or screen, so a section-by-section coverage audit against
`code-documentation.md` found nothing to exclude as project-specific.
Everything the source states is now carried in `code-documentation.md`: the
condensed "short version" (§1), the illustrative JSDoc and inline-comment
examples (§3, §5), the anti-patterns table (§6), and the explicit "treat
this as binding" framing addressed to an AI agent (§8, now its own
"Instructions for AI agents" heading rather than folded into "Applying this
as you touch code"). Every gap that existed before this pass was a coverage
miss, not a deliberate exclusion.

One piece of wording was **deliberately not carried over verbatim**: the
source's §3 says to "avoid" `@example`, reaching for one "only when the
signature genuinely does not carry the call" — implying a rare exception is
allowed. `core/guards/doc-comment-style.js` denies `@example` outright, with
no exception, in every project that has this guard active. Restating the
source's softer "avoid, with an exception" language would describe a rule
this repository does not actually enforce, so `code-documentation.md` keeps
its stronger, pre-existing "forbidden" phrasing instead — the more accurate
statement of what this repository does, not a rejection of the source's
substance. This is a disagreement for a human to confirm, not a silent
overwrite.
