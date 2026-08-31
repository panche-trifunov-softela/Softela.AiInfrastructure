---
name: nonce-guarded-effect-hook
description: Canonical hooks useNonceGuardedEffect (+ store wrapper useNonceGuardedStoreEffect) for consuming uiCoordinationStore nonce events without reprocessing stale ones on remount
metadata:
  type: project
  source: softela-ai
---

Frontend `Softela.ReactSCExpert`. `uiCoordinationStore` broadcasts events shaped `{ nonce, ... }` (each emit bumps `nonce`); consumers subscribe via `useEffect` keyed on `event?.nonce`. Hazard: on component **remount** (linked dialog / child screen closed then reopened) a stale event still in the store gets reprocessed. Historically guarded ad-hoc with a per-consumer `initial*NonceRef` (init to mount-time nonce, skip if unchanged) — easy to forget (that omission caused a real regression in an editors-dialog flow).

**Canonical fix:** `src/hooks/useNonceGuardedEffect.ts` (exported from `src/hooks/index.ts` barrel).

```ts
useNonceGuardedEffect<TEvent extends Nonce>(event: Maybe<TEvent>, handler: (e: TEvent) => void, deps?: DependencyList)
// e.g. useNonceGuardedEffect(evt, () => { /* match storeKey/dialogId inside */ });
```

- Typing: constrain `TEvent extends Nonce` (reuse `Nonce` from `uiCoordinationStore`, `import type`), `event: Maybe<TEvent>`, ref `Nullable<number>` — `Maybe`/`Nullable` are GLOBAL ambient types (`src/types/global.d.ts`), don't import.
- Guard = **mount-baseline**: `mountNonceRef` set at mount, NEVER reassigned. Fires the handler only for a nonce different from the mount-time one; anything already in the store at mount (or replayed on remount) is skipped.
- **Two-level fresh-state model** (this is the key design point):
  1. `handlerRef` (reassigned every render) → the callback ALWAYS runs against the latest committed state at fire time, so state it merely READS need NOT be listed in deps.
  2. Optional `deps` → for state that can arrive in a LATER render than the event; passing it re-evaluates the effect so the handler RE-ATTEMPTS with the now-present state. Because the guard is mount-baseline (not process-once), re-attempts are allowed while stale-at-mount is still skipped. Handler must be idempotent when deps are passed.
- Effect deps = `[event?.nonce, ...(deps ?? [])]` with an `eslint-disable react-hooks/exhaustive-deps`.
- Deps are for state that can arrive in a LATER render than the event (e.g. `parents`/`activeRowByParent` in `CustomPage`) — both migrated `tableeditor/index.tsx` sites pass non-empty deps (see below), so treat "no-deps" as merely the degenerate case, not a distinct established style.
- **Migration gotcha:** inside the handler use the non-null `evt` PARAM the hook passes (e.g. `getStoreKey(evt)`, `evt.row`), NOT the outer nullable store variable via closure — the latter isn't narrowed once the nonce-guard early-return is gone, so `tsc` errors (`getStoreKey` wants non-null; "possibly null"). This bit an early migration and was fixed once identified.

**Generic store factory + per-store binding:** the store wrapper is a GENERIC FACTORY (not tied to any one store, since events/requests may move to other stores later).

- `src/hooks/createNonceGuardedStoreEffect.ts` (barrel-exported): `createNonceGuardedStoreEffect<TState>(useStore: UseBoundStore<StoreApi<TState>>)` → returns a hook `(selector: (s: TState) => Maybe<TEvent>, handler, deps?) => void`. Store-agnostic; typed via zustand v5 `UseBoundStore<StoreApi<TState>>`; `Nonce` imported type-only (no runtime cycle).
- `src/store/hooks/useStoreNonceGuardedEffect.ts` (barrel `src/store/hooks/index.ts` → re-exported from `src/store/index.ts`): `export const useUiCoordinationStoreNonceGuardedEffect = createNonceGuardedStoreEffect(useUiCoordinationStore);` — the ui-store binding lives WITH the store (under `store/hooks/`), not in the generic `src/hooks/`, so the factory stays decoupled. Imports the factory directly (not the barrel) to avoid cycles. File named after its single export per repo convention. The file went through a full rename chain before landing at this name and export.
- Usage: `useUiCoordinationStoreNonceGuardedEffect((s) => s.teExitViewEvent, handler)` — one-liner for BOTH a top-level event field AND a **Record-keyed** entry (`s => s.teRemoveFilterRequests[storeKey]`). For another store: `createNonceGuardedStoreEffect(useOtherStore)`.
- **Record/dictionary events** (`cardExpandRequests`, `cardCollapseRequests`, `teRemoveFilterRequests`, `teOpenSearchRequests`, `teClearAllFiltersRequests`) need NO special hook: the established pattern already selects a single entry by key (`s.record[storeKey]`, see `useReportViewerSearchSync.ts` + `selectTeRemoveReq`/`selectTeOpenReq`/`selectTeClearAllReq` memos in `tableeditor/index.tsx`), and that entry IS a single `Maybe<Nonce & …>` — exactly what the primitive consumes. Keying is resolved at the selector, not the hook.
- **Decision — typed selector, NOT a stringly-typed field name** (rejected a `findAllInTree`-style "pass field-name string" approach): a selector gives automatic `TEvent` inference, IDE-rename refactor-safety, and expresses `[key]` indexing; a string literal loses all three for zero ergonomic gain. `findAllInTree` uses config only because it works on untyped runtime trees; here we have static types.

**Design rationale (do NOT re-litigate):** the mount-relative ref guard is the RIGHT tool for the remount/reopen case; a persisted "processed by nonce" ledger is NOT equivalent and can reintroduce stale-consumption (if an event is emitted while the consumer is unmounted, a ledger has no mark → would reprocess; the mount-ref inherently skips it). If a reopened consumer needs to react, drive it with a NEW nonce from the open flow (as one dialog-reopen fix does via `setCurrentTableEditorMode`). Complementary producer-side defense already in code: `clearDialogTemporaryState(dialogId)` nulls per-dialog events on close (but can't touch global/shared events — that's exactly where the hook is the only fix). Anti-patterns rejected: mutating the event object with `processedBy` (re-render loops); any global consumed+delete (starves other legit consumers).

**Rollout status:** primitive + generic factory + ui binding all exist and are exported; tsc clean, 15/15 unit tests green, files reviewed. Two migrated sites are the LIVE EXAMPLE of the factory, both in `src/components/tableeditor/index.tsx` on `origin/dev-ng` (the separate `useUiCoordinationStore` selector line + the base-hook import were dropped; base `useNonceGuardedEffect` no longer imported there):

- around line 5448: `useUiCoordinationStoreNonceGuardedEffect((s) => s.teExitViewEvent, (event) => { ... handleExitViewMode(); ... }, [storeKey])`
- around line 5461: `useUiCoordinationStoreNonceGuardedEffect((s) => s.teTriggerEditEvent, (event) => { ... menuEdit(event.row); ... }, [obj?.objId, obj?.controlId, screenId, storeKey])`

Remaining plan (after further testing completes): migrate ALL other nonce-event consumers — top-level events + Record-keyed requests via `useUiCoordinationStoreNonceGuardedEffect((s) => s.field | s.record[storeKey], handler, [deps])`.

See the companion notes on `frontend-hooks` and `frontend-state-stores`.
