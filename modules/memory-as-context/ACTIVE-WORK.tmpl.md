# Active work

This file holds **live task state** — not durable knowledge. It exists so
work resumes correctly from disk after a compaction or a lost session,
instead of being reconstructed from guesswork.

Update it whenever the state it describes actually changes — not on a fixed
schedule, and not on every turn. Typical contents:

- **Branch and commit** — the branch name, and the SHA the current step
  started from.
- **The current step** — what is being worked on right now, in enough detail
  that picking it back up does not require re-reading the whole
  conversation.
- **What is verified** — what has actually been checked (a test run, a
  manual repro, a read of the real code) versus what is merely assumed.
- **What is left** — the remaining steps, in order.
- **Exactly how to resume** — the next concrete action, stated plainly
  enough that a fresh session with no other context could act on it.

## The section types

Sections in this file, and in every other file under this memory directory,
are typed, and the type decides who may overwrite them:

- **`## INTENT — <topic>`** — agreed, developer-confirmed design and
  constraints. The developer is the authority here. Code that disagrees with
  an INTENT section is evidence of a bug in the code, not of stale memory —
  never rewrite or delete an INTENT section on the strength of code observed
  to behave differently.
- **`## AS-OBSERVED <date> @ <ref>`** — what the code actually does,
  verified against a named ref. Refresh this freely, and re-date and re-ref
  it every time it is checked again.
- **`## CONFLICT <date>`** — the code contradicts an INTENT section. Record
  both sides, report it, and leave the INTENT section standing. A conflict
  is a finding to raise, never permission to overwrite.

This file itself does not need every type above — most of what it tracks is
plain live state, not a design decision. Reach for `## INTENT` here only
when the current step itself encodes a decision worth protecting the same
way.
