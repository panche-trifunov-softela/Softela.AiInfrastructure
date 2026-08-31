# Migration backlog — Softela.ReactSCExpert

The structural work ahead of this codebase, in the order it was proposed by
the frontend team's architecture review. **This backlog itself
had not yet been accepted by the wider team at the time this file was
written** — treat items here as the direction under discussion, not as
already-binding rules, until `docs/OPEN-DECISIONS.md` or a repository's own
`AGENTS.md` says otherwise for a given item. See `docs/OPEN-DECISIONS.md`
for the parts of this that are genuinely contested, not merely pending
sign-off.

No big-bang refactor is planned. Rewriting the largest files in one pass
would produce a diff nobody can review, on a branch that cannot be kept
current against a fast-moving base, with a regression surface covering
entire screens. The plan is incremental and is not meant to block feature
work.

## Phase 0 — Agree and record

Publish the standard, add the repository's own `AGENTS.md` (installed from
`templates/repo-pointer/`) and the shared agent configuration. No
application code changes in this phase.

## Phase 1 — New code only

Every new component, store, hook and service that needs more than one file
follows the agreed component-folder pattern from day one. This is the
cheapest phase — it costs nothing beyond what would be written anyway, and
stops the problem from growing while the rest of the plan catches up.

## Phase 2 — Boy-scout rule on touched code

When a file that predates the standard is opened for unrelated work, the
part actually touched is brought up to it: the logic being modified moves
into a hook or a utility, the types being changed get a proper home, tests
are added for what was extracted, an `index.ts` is added if the folder is
missing one.

Restructuring code that is not otherwise being changed does not belong in
the same change — it buries the real diff and makes review impossible.
Behaviour-preserving refactors and behaviour changes must not share a
change either; a bug found mid-refactor gets its own change.

## Phase 3 — Scheduled refactors

The largest, highest-risk, highest-change-frequency files get their own
scheduled work, in this proposed order:

| Priority | File                                          | Lines | Note                                                       |
| -------- | ---------------------------------------------- | ----- | ----------------------------------------------------------- |
| 1        | `components/tableeditor/index.tsx`            | 8,727 | Also violates the barrel/`index` rule; used across many screens. |
| 2        | `components/screenbuilder/ScreenBuilder.tsx`  | 9,122 | Largest file; already has a `hooks/` folder to extend.      |
| 3        | `components/mapcomponent/index.tsx`           | 3,872 | Barrel/`index` rule; splits naturally with `MapComponent.tsx`. |
| 4        | `components/mapcomponent/MapComponent.tsx`    | 4,275 | Do together with the above.                                  |
| 5        | `components/layout/Header.tsx`                | 4,098 | Loaded on every screen; regressions are global.              |
| 6        | `components/layout/ComponentMapper.tsx`       | 2,816 | Central dispatch point for rendered screens.                 |
| 7        | `pages/CustomPage.tsx`                        | 2,240 | Entry point for every configured screen.                     |
| 8        | `components/form/Form.tsx`                    | 2,506 | Heavily reused; good extraction candidate afterwards.        |
| 9        | `components/dtbuilder/DtBuilder.tsx`          | 2,753 | Shares logic with `screenbuilder`; check for duplication.    |
| 10       | `components/labelEditor/labelDesigner.ts`     | 3,034 | Not a component — split as logic modules.                    |

Order of extraction within each item: pull the logic out first (state and
rules into a hook, pure functions into utilities); then extract child
components along seams the UI already has; then extract shared hooks where
siblings need the same behaviour; only then split the view itself if it is
still large. Doing it in the reverse order — cutting JSX apart while the
logic stays tangled — produces more files with the same coupling.

A refactor in this phase is done when: the folder follows the agreed
pattern with `index.ts` re-exporting only; no file in it is above the
agreed size threshold or is on the documented exception list with a reason;
extracted utilities and hooks have tests; public behaviour is unchanged;
any existing specs for the file have moved to the agreed location and still
pass.

## Phase 3b — Types

Independent of the component-folder work, and comparatively cheap because
most of it is mechanical and compiler-checked:

1. Separate backend-contract types from frontend-only types; empty
   `src/types/types.ts` into named files, then delete it.
2. Type the contracts that new work touches — every method that gains a
   real DTO removes a cluster of `any` downstream. Existing untyped calls
   are typed when they are touched for another reason, not swept.
3. Fix inverted dependencies — types currently imported by a service from a
   component file (for example `Field` from `src/components/form/Form`,
   imported by `src/services/api/screens.ts`) move to `src/types/`.

`endpoints.ts` — consolidating `src/services/api/urlConsts.ts` and the
inline route strings scattered across call sites into one file of
controller and route constants — is separable from the rest and can start
whenever there is capacity, independent of everything else here.

## Phase 4 — Gate the new work

Build a per-scope (per-feature / per-changed-file) coverage mechanism, then
switch on a pipeline coverage gate for newly added features and components
only. There is deliberately no repository-wide coverage threshold and no
ratchet planned — a whole-codebase percentage on a tree this size would
mostly measure the backlog rather than the work in front of a reviewer.
Numbers and a start date are not yet set.

## Deferred, not scheduled

- **Restructuring the existing API layer** (`src/services/Api.ts` and
  `src/services/api/`, converged into one location organised by backend
  controller) — deferred. The priority is component testability, which the
  API layer does not decide. New endpoints follow the target shape; nothing
  existing is moved as a task of its own.
- **Generating types from swagger** — considered, not rejected, just low
  priority while the API layer itself is deferred. Contracts are mirrored
  by hand in the meantime.
- **Renaming `src/tests/`** to something less misleading — declined. The
  gain is cosmetic; the rename touches `vitest.config.ts` and the imports
  in all 123 existing spec files, and this refactor has enough moving parts
  without it.
- **A real server-data layer** (a thin caching/invalidation wrapper, or a
  library) — not for now. The current boundary (reference data in a store,
  screen/request data in the hook that asked for it) works as long as it is
  applied, and the effort is going into component testability instead.

## Already agreed, not yet done

- **Fold `src/utils/eventBus` (`mitt`) into `uiCoordinationStore`.** The
  bus carries exactly one event today; moving it removes a second answer
  to "how do two components talk" and lets the `mitt` dependency be
  dropped.
- **Remove `providers/`.** Its single occupant is a notification hook, not
  a provider or a context; it moves to `src/hooks/` and the folder is
  deleted.
- **Co-locate new spec files** in a `__tests__/` subfolder of the component
  they test, rather than in the central `src/__tests__/` tree. Existing
  specs move only when their subject is refactored — not as a sweep.

## Explicitly not decided yet

See `docs/OPEN-DECISIONS.md` for the styling strategy, the direction for
extracting large components into shared services or plugins, the future of
the `@softela` component library, and micro-frontends. None of those belong in
this backlog as scheduled work until they are settled.
