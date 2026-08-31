---
name: session-cleanup
description: The softela-ai clean-sessions command — wipe saved session transcripts without touching project memory
metadata:
  type: reference
  source: softela-ai
---

Saved session transcripts and their side-car folders accumulate quickly and are rarely worth keeping. Where the `session-cleanup` module of this infrastructure is enabled, `softela-ai clean-sessions` prunes them.

**Always dry run first and show the list**, then re-run with `--apply` only after the developer says go. Flags: `--apply`, `--include-current`, `--all-projects`, `--project=<dir>`.

- This is a command the developer runs deliberately, not something to invoke on their behalf mid-session without being asked.
- **Dry run by default.** Without `--apply` it only lists what would go and the space it would free; it deletes nothing.

**What it refuses to delete, by construction:**

- Any directory literally named `memory` — the exclusion is enforced in code (a hardcoded set no CLI flag exposes a way to override), not by instruction, specifically so no amount of clever phrasing can talk the tool into removing project memory anyway. Never construct a delete of a `memory` directory through this or any other route.
- Anything whose name is not a session id in the host's own format.

**Layout (Claude Code):** `<agentHome>/projects/<sanitized-cwd>/` holds `<sessionId>.jsonl` plus a `<sessionId>/` side-car folder (tool results, subagent and workflow transcripts). The side-car is often far larger than the transcript itself — for one real project, of 67 MB total, 59 MB was a single session's side-car. Either half can exist alone: each resume and post-compaction start writes a new transcript, and some leave a side-car with no `.jsonl` at all. The folder name is the working directory with **every non-alphanumeric character replaced by `-`**, lower-cased — `_` and `.` included, which is easy to get wrong when matching it by hand. (Codex's equivalent session-store layout is a separate, less-verified assumption — see the tool's own documentation before relying on exact paths there.)

The live session's transcript is normally locked by the host process while it runs and cannot be deleted; its side-car folder is still removed. The tool reports per-item failures (`EBUSY`/`EPERM` on the live transcript is expected on Windows) rather than claiming success for something that did not happen — say that plainly instead of retrying.

**Cost of losing side-cars, learned the hard way:** on a real project, workflow journals under a session's side-car (`subagents/workflows/wf_*/journal.jsonl`) were the ONLY record of several multi-agent analyses, and memory files pointed at them instead of restating their conclusions. Once those folders were cleaned up, the pointers were dead. **Before running this, make sure every conclusion worth keeping is written into the memory base in full** — never leave a memory file saying "the plan is in that journal".
