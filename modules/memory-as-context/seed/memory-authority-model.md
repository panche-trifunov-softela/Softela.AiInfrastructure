---
name: memory-authority-model
description: Standing rule — memory sections are typed INTENT / AS-OBSERVED / CONFLICT, so buggy code read as truth can never silently overwrite agreed design
metadata:
  type: reference
  source: softela-ai
---

**The failure this prevents:** buggy code lands in a shared branch (`dev` / `dev-ng`), gets read during ordinary work, and — under a naive "keep memory synced with code" rule, where any drift triggers an auto-update — gets written into memory as if it were the agreed design. The next session then designs and recommends from a bug, not from what the developer actually decided.

**Why:** memory has to hold two different kinds of truth that are easy to conflate — what was agreed the system *should* do, and what the code *currently* does — and only one of those is allowed to change automatically just because the code changed.

**How to apply:**

- Every memory section is typed by its heading; the type decides who holds authority over it and how it may change.
  - `## INTENT — <topic>` — agreed, developer-confirmed design: decisions, constraints, business rules. Authority: **the developer**. Code that disagrees is evidence of a bug in the code, not of stale memory. Never rewritten to match code.
  - `## AS-OBSERVED <date> @ <ref>` — what the code does right now, verified against a named ref (branch or SHA). Freely refreshable: re-date and re-ref it every time it's re-checked. Authority: **the code**, as of that ref.
  - `## CONFLICT <date>` — code contradicts an INTENT block. Records both sides — what INTENT says, what the code at `<ref>` actually does — and what changed in git to cause the divergence. Reported to the developer; never resolved by rewriting the INTENT.
- **The one-line rule: code is authority for WHAT IT DOES, never for WHAT IT SHOULD DO.**
- On a contradiction: add a `## CONFLICT` section next to the disputed `## INTENT` block, report it to the developer, and stop there. Do not "fix" the INTENT to match the code, even when the code looks newer, more thorough, or more plausible.
- A shared memory guard enforces this mechanically on `Write`/`Edit` under the memory directory: it **asks — never denies** — before any edit that removes or rewords an `## INTENT` block. Clicking through that prompt is a decision to override a previously agreed design, not a formality to dismiss on autopilot; read what the edit actually changes before approving.
- The memory directory is itself a local git repository (no remote, never pushed; an autocommit hook commits after every write with a subject-only `Update <basename>` message — no `word:` prefix, since that reads as a conventional-commit type this project rejects). Nothing here is irrecoverable — go get an earlier version directly:
  - `git -C <memory-dir> log --oneline -- <file>.md` — see the history of one file.
  - `git -C <memory-dir> diff <sha> -- <file>.md` — see exactly what a past edit changed.
  - `git -C <memory-dir> checkout <sha> -- <file>.md` — restore an earlier version of that file.
