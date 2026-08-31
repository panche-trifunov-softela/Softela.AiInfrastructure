---
name: keep-memory-synced-with-code
description: Standing rule — when reading the codebase, detect drift from memory and proactively update the memory base so knowledge stays current
metadata:
  type: reference
  source: softela-ai
---

**Standing rule:** whenever the memory base is found to disagree with the real repos — changed logic, new/renamed types, services, stores, components, moved files, altered business rules or flows — the agent must **proactively update the AS-OBSERVED content** (edit the relevant file, fix stale facts, add new ones, update the memory index) without waiting to be asked. Goal: memory always reflects the real current project. **This applies to AS-OBSERVED facts only** — see the qualification below and the memory authority model for what happens when the drift is against an `## INTENT` block instead.

**Scope — only trust what's landed on the mainline dev branches (`dev` / `dev-ng`).** Treat as new truth only changes already committed/merged into the project's shared dev branches (see the project's git flow rules). Do NOT auto-update memory from in-progress work on the developer's own feature branch — it is often just being edited or debugged there and may be reverted or reworked; that would only cause confusion. **Exception:** if the developer explicitly asks for changes made on the current branch to be remembered as the new truth, then do update memory from them.

**Why:** one always-current knowledge base means opening either repo starts an agent already correctly oriented. Stale memory is worse than none — it makes the agent recommend files/functions/flags that no longer exist. This extends a general "keep it current" habit into an active, automatic behavior rather than a passive one.

**How to apply:**

- **Cadence is event-driven against git, not a per-turn or clock-based check.** There is no timer forcing a re-check. Reconcile when a repo-state check reports drift — **hard** drift (a memory-named branch/SHA no longer exists) or **soft** drift (branch/HEAD/base moved, or the memory snapshot is more than roughly 4 days old) — or when the snapshot alone crosses that age threshold even absent an explicit drift report.
- **Re-stamp the sync snapshot after reconciling**, using whatever sync-state helper the local setup provides. Without this the next check re-reports the same drift forever, since nothing else records that reconciliation happened.
- Prefer editing the existing relevant memory file over creating duplicates; delete AS-OBSERVED facts proven wrong.
- Record only what's actually used in the project; note the change concisely.
- Verify before trusting a recalled fact — if a memory file names a file/function/flag, confirm it still exists in code before acting on or recommending it.
- Save new durable knowledge into the shared memory base, never into a scratch or per-task location.
- **Auto-update on drift is qualified: it covers `## AS-OBSERVED` content only.** If the drift instead contradicts an agreed `## INTENT — <topic>` block, do not touch the INTENT — add a `## CONFLICT <date>` section recording both sides and report it to the developer. Full contract: see the companion note on memory authority.
