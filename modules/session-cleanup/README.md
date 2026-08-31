# session-cleanup

Default: **off**. No options.

Prunes saved session transcripts and their side-car folders, which accumulate
quickly and are rarely worth keeping.

## What it does

`assets/clean-sessions.js` is the whole implementation. It is installed to
`<agentHome>/softela-ai/hooks/clean-sessions.js` and reached from inside a
session, which is where a developer actually is when they notice the disk
filling up: **`/clean-sessions` on Claude Code, `$clean-sessions` on Codex.**

It is deliberately **not** an `softela-ai` subcommand. The CLI only exists on a
machine where somebody ran `npm link` from a clone, and most developer
machines are not in that state; a cleanup command that depends on it is a
cleanup command that silently does not work. The installed script derives its
own agent home from its own location (`path.resolve(__dirname, "..", "..")`),
so the installed command is a fixed line of text with no absolute path
substituted into it at install time.

Two arguments, and no others:

| Flag | What it does |
|---|---|
| *(none)* | Sweeps the sessions nearest the work — see the layout note below. |
| `--all` | Every session on the machine except the live one. |
| `--apply` | Actually delete. Without it, report only. |

## The two hosts store sessions differently

Both layouts are verified against the real hosts:

```
claude   <home>/projects/<sanitized cwd>/<uuid>.jsonl  (+ <uuid>/ side-car)
codex    <home>/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<uuid>.jsonl
```

Codex has no project dimension at all and no side-car; a Codex session is one
file, filed by date. That is why the default scope differs per host: "the
sessions near the ones you are working with" can only mean the current
project on one host and today on the other, because that is the only grouping
each host actually offers.

An earlier version of this module assumed Claude Code's shape on both hosts.
It found nothing on Codex — not an error, just an empty report — which is the
failure mode a wrong layout guess produces, and the reason both are now read
from the real stores rather than assumed.

## The two guarantees

- **The live session is never deleted.** Not with `--all`, not with
  `--apply`, not on request. There is no flag for it, so no wording can reach
  it. The live session is the most recently written one, or the id the caller
  pins with `--current`.
- **Nothing under a directory named `memory` is ever touched.** A hardcoded
  `NEVER_DELETE` set skips it during discovery, and `remove()` refuses any
  path with a `memory` segment even if discovery ever let one through. No
  prompt wording — the block in `prompt.md` included — can talk this tool
  into removing one; the exclusion does not depend on the prompt being
  followed at all.

The live transcript is also normally locked by the host process. The tool
reports per-item failures (`EBUSY`/`EPERM` is expected there) rather than
claiming success for something that did not happen.

## How the command itself is installed

A command is the one thing a module ships that does NOT land under
`<agentHome>/softela-ai/`: each host only discovers commands at a fixed location
of its own — `<agentHome>/commands/<name>.md` for Claude Code,
`<agentHome>/skills/<name>/SKILL.md` for Codex — so a command's `to` is
resolved against the agent home rather than the installed root (see
`core/installer/detect.js#moduleCommandsFor`).

The two are separate documents per host, not one file copied twice, because
the formats genuinely differ: a Claude Code command carries
`description`/`argument-hint`/`allowed-tools` front matter and the body is
the instruction; a Codex skill carries `name`/`description` front matter, and
its description is what decides whether the skill is loaded at all, so it has
to state when NOT to use it too. Uninstalling, or disabling the module,
removes both — they are manifest-tracked like every other shipped file.

## Turning it on

`softela-ai module enable session-cleanup` installs the script, both command
documents and the prompt block. Nothing runs automatically — the command
still has to be invoked, and still defaults to a dry run even then.
