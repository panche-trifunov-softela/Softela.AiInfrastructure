## Memory as context

A memory directory holds durable project knowledge on disk. Its content is
injected as additional context at the start of every session, so it survives
compaction and a lost session — read it from there instead of re-deriving
facts that are already recorded.

- **`MEMORY.md`** is the index. Keep it short; link out to the topic files it
  indexes rather than growing it into the knowledge itself.
- **`ACTIVE-WORK.md`** holds live task state — the current step, what is
  verified, what is left, exactly how to resume. Update it when the state it
  describes actually changes, not on a fixed schedule.
- Sections inside any memory file are **typed**, and the type decides who may
  overwrite them:
  - `## INTENT — <topic>` — agreed, developer-confirmed design and
    constraints. **The developer is the authority.** Code that disagrees
    with an INTENT block is evidence of a bug in the code, not of stale
    memory — never rewrite or delete an INTENT section because the code was
    observed to behave differently.
  - `## AS-OBSERVED <date> @ <ref>` — what the code actually does, verified
    against a named ref. Refresh this freely, and re-date and re-ref it every
    time it is checked again.
  - `## CONFLICT <date>` — the code contradicts an INTENT block. Record both
    sides, report it, and leave the INTENT standing. A conflict is a
    finding to raise, never permission to overwrite.
- A write that would remove or reword an INTENT section is intercepted and
  surfaces as a question rather than proceeding silently — appending to an
  INTENT block, or adding a new section elsewhere, is never affected.
- This module seeds a starter knowledge base — the Softela SCExpert
  knowledge base this repository is built for, shipped so every developer
  starts from the same facts instead of re-deriving them — under
  `<memoryDir>/softela/` on first use, plus an `ACTIVE-WORK.md` stub when none
  exists yet. A file the developer already keeps at the top level under the
  same name always wins: its shipped twin under `softela/` is skipped. An
  organisation forking this tool replaces the module's own `seed/` directory
  with its own knowledge base. Keeping everything accurate over time is
  still the ongoing work this block exists to support.
- After a compaction, a checkpoint of the developer's own messages —
  verbatim, in order — is injected back automatically. It outranks any
  summary of those same messages. It cannot capture your own conclusions
  though, so keeping `ACTIVE-WORK.md` current is still your job.
