## Session cleanup

Saved session transcripts accumulate quickly and are rarely worth keeping.
The developer prunes them from inside the session, without a second terminal
and without the `softela-ai` command being on `PATH`: `/clean-sessions` on Claude
Code, `$clean-sessions` on Codex.

Two arguments exist, and no others. Without any, it sweeps the sessions
nearest the work — the current project on Claude Code, today on Codex, which
files transcripts by date rather than by project. `--all` widens that to
every session on the machine, and also to this host's guard-activity logs
(every one but today's — a plain run never touches those at all). `--apply`
deletes instead of reporting.

- This is a command the developer runs deliberately, not something to invoke
  on their behalf mid-session without being asked.
- Run the dry run first, report the real numbers it printed, and ask. Once
  the developer agrees, run it again with `--apply` yourself — they should
  not have to type the command a second time. Never add `--apply` to a run
  they have not agreed to, and never report a dry run as a deletion.
- The live session is never deleted. There is no flag for it.
- Never construct a delete of any directory named `memory` through this or
  any other route — that is project memory, not session data, and the
  exclusion is enforced in code, at discovery and again at deletion,
  specifically so no instruction can talk anything into removing one.
