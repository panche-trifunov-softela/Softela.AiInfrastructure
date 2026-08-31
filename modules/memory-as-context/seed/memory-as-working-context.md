---
name: memory-as-working-context
description: Standing rule — keep the memory base continuously in sync with working context so any session can resume without re-deriving anything
metadata:
  type: reference
  source: softela-ai
---

**This is a default, always-on workflow, not a per-task instruction.**

The memory base must stay continuously in sync with working context. If a session hits its limit, is compacted, or is deleted and a fresh one is opened — or if several sessions run in parallel — an agent must be able to reload everything important by READING MEMORY, never by re-investigating the codebase.

**Why:** re-deriving architecture, root causes, decisions and task state burns large amounts of tokens for zero new information, and risks reaching a *different* conclusion than the one already agreed with the developer. As a side effect, the memory base then always holds current knowledge of the project's functionality and logic.

**How to apply:**

- **Write as work happens, not at the end.** The moment something durable is established — a root cause, an architectural decision, a developer constraint, a rejected approach and why — write it. Do not batch it for later; later may not exist. Treat approaching a session/context limit as an alarm, but never as the first time state gets persisted.
- **Keep a live task-state note per active piece of work**: branch and base commits, what each commit does, what is DONE vs IN PROGRESS vs PENDING, agreed decisions, open questions, current verification status (typecheck/tests), and what still needs manual QA. Update it whenever any of those change; delete it when the work ships.
- **Record decisions WITH their reasoning, and record rejected options too.** A future session that doesn't know why an option was rejected will propose it again.
- **Record the developer's constraints verbatim-ish** — they are binding and easy to lose (e.g. "no type-based discrimination", "no `feat:` prefix", "only touch tests already changed").
- **Persist pointers to long-running artifacts** — background workflow run ids, transcript locations, output files — so results can be recovered rather than recomputed if a session ends mid-flight.
- **Correct memory when it turns out wrong.** A confidently-wrong note is worse than no note. On a real project a note once asserted a root cause that later evidence overturned; it was rewritten, not appended to.
- **Index every new note in the memory index file** — one line, or a fresh session will never find it.
- **Cadence is event-driven, not clock-driven.** There is no periodic nag firing every few minutes — a wall clock cannot tell a weekend away from real drift. Write or update a note **when the state it describes actually changes** (a step completes, a decision is made, a branch ships), not on a timer. Separately, reconcile task-state notes against the real repos when a repo-state check reports drift at session start or before compaction, or when the memory sync snapshot is older than roughly 4 days — whichever comes first.
- **Re-stamp the sync snapshot after reconciling**, once the branch/SHA/base facts in memory match the repos again. Skipping this makes the next drift check repeat the same stale report.
- **"Update on drift" applies to AS-OBSERVED facts only** — branch names, SHAs, "N commits behind", file/function existence. An `## INTENT` block (agreed design, developer constraints) is never auto-rewritten because a repo moved; see the memory authority model for the full contract.
