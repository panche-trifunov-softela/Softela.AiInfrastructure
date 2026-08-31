# Installer — implementation specification

`bin/softela-ai`, implementation under `core/installer/`. Read `CONTRACTS.md` §9 and
§11 first; this document fills in the CLI surface, the on-disk state and the
plan structure.

Two properties decide whether anyone trusts this on their machine:
**an update never destroys a local change**, and **deleting the clone breaks
nothing**. Everything below exists to make those two true.

---

## 1. What gets installed, and where

Everything is **copied** into `<agentHome>/softela-ai/`. No symlink, no path stored
that points back into the clone, nothing that resolves relative to where the
repository happened to sit.

```
<agentHome>/                      ~/.claude or ~/.codex
├── softela-ai/                       installed payload — owned by the installer
│   ├── bin/softela-ai
│   ├── core/                     engine, guards, lib, schema
│   ├── adapters/<agent>/
│   ├── projects/
│   ├── modules/<enabled ids>/
│   ├── docs/standards/
│   ├── docs/projects/
│   └── VERSION
├── .softela-ai/                      state — never owned, never overwritten
│   ├── manifest.json
│   ├── state.json
│   ├── overrides.json            written by the developer only
│   ├── approvals.json            written by `softela-ai approve` only
│   └── backups/<timestamp>/
├── hooks/                        module hook entry points, individually owned
└── settings.json | hooks.json    managed keys only
```

The split is the point: **`softela-ai/` is ours and is replaced; `.softela-ai/` is the
developer's and is not.** An uninstall removes the first and leaves the second.

`<agentHome>/softela-ai/bin/softela-ai` is a working copy of the CLI, so every command
still runs after the clone is gone. `doctor` prints the exact invocation.

---

## 2. Commands

| Command | Effect |
|---|---|
| `install` | Detect agents, resolve modules and options, plan, apply |
| `update` | Reconcile the installation against the current repository |
| `doctor` | Report state, drift, overrides, approvals, config validity |
| `test` | Run the full self-test suite against the local installation |
| `uninstall` | Remove managed artefacts only |
| `approve <ruleId>` | Grant a time-boxed approval for one rule |
| `module <list\|enable\|disable> [id]` | Change the enabled module set |
| `override <ruleId> <off\|ask\|deny> --reason "…"` | Set a local override for one rule (§9) |
| `override --list` | List every active override, with its reason and when it was set |
| `override --undo` | Restore the most recent `overrides.json` backup |

Global flags: `--dry-run`, `--agent claude|codex|all`, `--yes` (accept every
default, no prompts), `--json` (machine-readable output), `--verbose`.

`install` and `update` additionally accept `--modules a,b,c`,
`--memory-location <repo|infrastructure|global>` and
`--reply-language <list>`, so a whole install can be scripted.

Exit codes: `0` success · `1` a real failure · `2` nothing to do (already
current) · `3` refused because something would have been destroyed.

### Output

The header names the command and the agent once — `softela-ai install -> claude`,
or `softela-ai install -> claude  (dry run — nothing written)` for `--dry-run`.

The default (non-`--verbose`) body bulks every ordinary added or changed file
into a single count line, since a first install writing over a hundred of
them buries the handful of lines a developer actually needs to read. A file
kept because it was locally edited, a removal, every settings change and the
instructions block still print their own line — nothing that changes
behaviour is ever folded into the count:

```
softela-ai install -> claude
  files  118 added
  ~   settings.json    hooks.PreToolUse[softela-ai]   (enforce)
  =   settings.json    model                      (seed, present — left alone)
  !   hooks/inject-memory.js                       locally modified — keeping yours, writing .new
  -   softela-ai/core/guards/old.js                     no longer shipped

install finished - written for claude
  backup (claude): ~/.claude/.softela-ai/backups/<timestamp>/
next steps:
  softela-ai doctor    verify what is installed
  node "~/.claude/softela-ai/bin/softela-ai"    run softela-ai again - it is not on PATH unless you ran "npm link"
```

`--verbose` prints every entry individually instead — including the ones
that need no change — with no bulk count line. `--dry-run` prints the same
body (its header says so explicitly) and stops before the closing section's
backup and "run again" lines, since nothing was written to report. The plan
itself is produced by a pure function so the tests can assert it without
touching a filesystem.

A closing section always follows the per-agent block: whether anything was
written or this was only a preview, each agent's backup directory when one
was created, `softela-ai doctor` as the way to verify what landed, the command to
run `softela-ai` again now that it is not on PATH after a manual install, and —
for Codex, only once a hook was actually written — the one-time hook-trust
review as a next step.

---

## 3. Plan structure

```js
/** One filesystem or settings action the installer intends to take. */
{
  kind: "copy" | "settings" | "block" | "remove" | "skip",
  agent: "claude" | "codex",
  target: "<absolute path>",
  pointer: "/hooks/PreToolUse/0",   // settings actions only
  mode: "enforce" | "seed",         // settings actions only
  state: "new" | "current" | "modified" | "absent" | "obsolete",
  action: "write" | "keep" | "write-new" | "remove" | "none",
  reason: "…one line…"
}
```

`buildPlan(context)` is pure: it takes a description of what is on disk and what
the repository ships, and returns an array of these. `applyPlan(plan)` performs
them. Nothing decides anything inside `applyPlan`.

---

## 4. Manifest

`<agentHome>/.softela-ai/manifest.json`

```json
{
  "version": "0.1.0",
  "installedAt": "…ISO…",
  "agent": "claude",
  "files": { "softela-ai/core/engine.js": "<sha256 of the bytes written>" },
  "settings": [ { "file": "settings.json", "pointer": "/hooks/PreToolUse/2", "mode": "enforce" } ],
  "blocks":   [ { "file": "AGENTS.md", "marker": "softela-ai" } ],
  "modules":  ["memory-as-context", "agent-orchestration"]
}
```

The hash is computed on `\n`-normalised content, so a checkout with different
line endings does not read as a local modification. On a Windows team this is
the difference between an update that works and one that reports every file as
edited.

### The three cases, restated as code

```
onDisk === null            → install fresh
sha256(onDisk) === manifest → overwrite
otherwise                   → keep, write <name>.new, report
```

A file the repository no longer ships is removed **only** when it is still
untouched. A modified file that is no longer shipped is left where it is and
reported, because it is the developer's now.

---

## 5. Settings

### Claude Code — `settings.json`

Hook entries carry no id, so ownership is tracked by matching the `command`
string against the installed dispatcher path. Every entry the installer writes
invokes exactly one dispatcher, which is what makes them recognisable and
removable:

```json
{ "matcher": "Bash|PowerShell|shell|local_shell|run_command|Write|Edit|MultiEdit|NotebookEdit|apply_patch|edit_file|write_file|Agent|Task|Workflow|spawn_agent",
  "hooks": [ { "type": "command",
               "command": "node \"<agentHome>/softela-ai/adapters/claude/dispatch.js\"" } ] }
```

Registered for `PreToolUse` only — the shared rule engine's dispatcher runs
every rule as a `PreToolUse` guard. A module that needs a different event
(`PostToolUse`, `SessionStart`, `PreCompact`) registers its own separate hook
entry instead — its own script, its own matcher, declared in its own
`module.json` — never this dispatcher. Hook entries from every settings scope
are merged by the host, so the developer's own hooks continue to run
alongside — the installer must never replace the `hooks` object wholesale,
only its own entries inside it.

### Codex — `hooks.json`

Same dispatcher, same events, `~/.codex/hooks.json`. Codex verifies hook
integrity by hash and skips a modified hook until a human reviews it, so the
installer prints the trust step rather than pretending it does not exist.

`config.toml` receives only `seed` keys, and only through a minimal TOML writer
that preserves comments and key order — the developer's own configuration is
extensive and must survive verbatim. If the file cannot be parsed confidently,
**the installer skips it and says so**; it does not guess.

The file itself may not exist yet — a machine that has never launched Codex,
or never changed a default, has none — and that is treated as every seed key
being absent: the file is created and every seed key written into it, the
same as seeding into an existing, empty one. A file that **exists but cannot
be read** is a different situation and is left untouched instead, reported the
same way an unparseable one is — a file this installer cannot read is a file
it must not overwrite.

### Verified Codex hook spawn contract

Confirmed against the real `codex` binary, not inferred from documentation:
one `codex exec` run registered six `SessionStart` hooks, each a different
quoting shape of the identical script, each writing a marker file recording
its own `process.argv`.

| `command` shape | outcome |
|---|---|
| `"C:\Program Files\nodejs\node.exe" <script>` | never ran |
| `C:\Program Files\nodejs\node.exe <script>` | never ran |
| `C:\PROGRA~1\nodejs\node.exe <script>` | ran |
| `C:\PROGRA~1\nodejs\node.exe "<script>"` | ran; the child received the script path with **no quote characters at all** |
| `node "<script>"` | ran, quotes stripped |
| `node <script>` | ran |

**The operative rule, stated as measured fact:** Codex spawns a hook command
by splitting on whitespace, with no shell involved. The executable — the
command's first token — must be a single whitespace-free token; quoting it
does not help, because the quotes become literal characters in the token
Codex tries to execute, and a path containing a space can never be one token
no matter how it is quoted. Everything **after** the executable is
tokenised correctly and arrives at the child with quote characters already
stripped, so a quoted argument (the dispatch script path, in particular) is
fine and in fact necessary once it contains a space.

This is exactly why `core/lib/short-path.js` exists and why
`plan.js#baseVars` resolves `NODE` through it (§5's `pathToken`): on Windows,
the installed Node executable's path is resolved to its 8.3 short form (e.g.
`C:\PROGRA~1\nodejs\node.exe`) whenever one can be produced and verified,
specifically so the executable token stays whitespace-free regardless of
where Node is installed. The dispatch script path is left quoted, as it
always was, because arguments are unaffected.

A failure here is **near-silent**: Codex logs `hook: <Event> Failed` and
continues, so an installation with a spaced, unquoted `NODE` token looks
healthy — files written, trust presumably granted — while enforcing nothing
at all. `doctor` cannot detect this after the fact from the registration file
alone; the contract above is why the installer must never regress to writing
a literal `"<node path>"` as the executable token on a machine where Node
lives under a spaced path.

Two related facts, already established elsewhere and worth restating here
because they bear on the same spawn path:

- An **untrusted** Codex hook is skipped in complete silence — no `hook:`
  line at all, indistinguishable from a healthy run (CONTRACTS.md §7).
  Whether a currently-installed hook is the one actually trusted **cannot be
  verified** from `config.toml` — only the presence of a `trusted_hash`
  entry can be checked, not that it hashes the installed command. Do not
  claim otherwise.
- Codex has no native `ask` on `PreToolUse`; `adapters/codex/dispatch.js`
  maps a rule's `ask` onto a deny or an advisory depending on `askMode`
  (CONTRACTS.md §7, "There is no native `ask` on Codex"). The two hosts do
  not reach the same outcome for a rule that returns `ask`, independent of
  the spawn-quoting question above.

---

## 6. Per-repository pointer

`softela-ai link [--repo <path>]` writes `templates/repo-pointer/AGENTS.md` into a
product repository, substituting the placeholders and wrapping the content in
managed markers. Where Claude Code needs `CLAUDE.md`, that file is a one-line
import of `AGENTS.md`, never a second copy.

If the repository already carries conventions that contradict the shipped
standard, the installer does not pick a winner. It reports the conflict, names
both sides, and asks which applies: the global standard, the repository's own
rule, or a merge. The answer is written into the project config so it is
explicit and stable rather than re-litigated every session.

---

## 7. Backups

Before modifying anything, the file is copied to
`<agentHome>/.softela-ai/backups/<ISO timestamp>/<relative path>`. The directory is
printed at the end of any run that wrote something. Backups are never pruned
automatically — `doctor` reports their total size and leaves the decision to the
developer.

---

## 8. Doctor

Reports, in this order, and exits non-zero only for a real problem:

- which agents are installed, at which version, and whether the repository is
  newer
- files that drifted from the manifest, and files that are missing
- every active override, with its reason — a machine that has quietly disabled
  half the rule set should be obvious rather than mysterious
- every live approval and its expiry
- enabled modules and any `seed` setting a developer has since changed
- when `memory-as-context` is enabled: whether its shipped knowledge base has
  actually been seeded, its resolved `location` and directory, the real
  on-disk file count, whether `MEMORY.md`'s generated index block is present,
  and whether a seeding run is stuck on an ambiguous `MEMORY.md` — the one
  case that drives `doctor`'s own exit code non-zero, since it otherwise
  emits no error anywhere
- project config files that fail schema validation
- for Codex: whether per-spawn model overrides are still enabled
- the exact command to run the CLI now that the clone may be gone
- last, an aligned Claude/Codex **parity** table (§10 covers this repository
  exists so both agents behave identically — this is what shows a developer
  whether they actually do), produced only when both agents' reports are
  present; with one agent it is a single "cannot be assessed" line instead. A
  parity mismatch never changes `doctor`'s own exit code — it is information,
  not evidence anything is broken.

---

## 9. Overrides CLI

`<agentHome>/.softela-ai/overrides.json` is otherwise hand-edited only —
`core/lib/override-resolver.js` reads it, nothing else in this repository
writes it. The `override` command exists so an agent can change it *for* a
developer, on the developer's request or with their approval, without that
turning into silent drift: every write requires a stated reason, is backed
up first, and can be undone.

```
softela-ai override <ruleId> <off|ask|deny> --reason "<why>" [--project <id>] [--agent claude|codex]
softela-ai override --list [--agent claude|codex]
softela-ai override --undo [--agent claude|codex]
```

### Setting an override

- `--reason` is **required** and must be non-empty. A missing or blank
  reason is refused outright (exit `1`) — an override without a stated
  reason is exactly the silent drift this file otherwise invites.
- `--project <id>` scopes the override to one project id, writing it under
  `projects.<id>.rules` instead of the top-level `rules` map — the same two
  places `core/lib/override-resolver.js` already reads.
- Softening only. The engine (`core/engine.js`) clamps an override's action
  to at most as severe as the rule's own result — it can only turn a `deny`
  into an `ask` or `off`, never the reverse. The command enforces this up
  front too, refusing (exit `1`, nothing written) rather than writing
  something the engine would immediately clamp back down:
  - an unknown rule id;
  - an override on a `mandatory` rule, which the engine never consults for
    overrides at all;
  - an action more severe than the rule's own `defaultAction` (e.g. `deny`
    on a rule whose `defaultAction` is `ask`) — this would be written but
    have no effect, which is worse than refusing, since it looks like it
    worked.
- Each entry records `action`, `reason`, and `setAt` (an ISO timestamp, the
  only place in this file that reads the clock — `setAt` is metadata for
  humans and `--list`, never consulted by the engine, so evaluation stays
  deterministic).

### Backups

Every write to `overrides.json` reuses the installer's own backup mechanism
(§7): the previous bytes are copied to
`<agentHome>/.softela-ai/backups/<ISO timestamp>/.softela-ai/overrides.json` before
the new content is written. A first-ever write has nothing to back up, and
that is reported as such rather than writing an empty backup. A file that
exists but fails to parse as JSON is still backed up byte-for-byte before
being replaced — its previous content is never silently discarded, only
superseded, and `--undo` can bring it back.

### `--undo`

Restores `overrides.json` from the most recent backup generation that
actually captured this file — a generation created by `install` or `update`
for unrelated files is not a candidate. It reports which generation it
restored from and a line per rule whose override was added, removed or
changed. With no qualifying backup, it says so plainly (exit `1`) rather
than crashing or writing an empty file.

The content about to be replaced is itself backed up first, exactly like any
other write to this file — so running `--undo` a second time restores what
the first `--undo` just replaced, i.e. undo of undo is redo.

### `--list`

Reports every active override, global and per-project, in the same
`{scope, ruleId, action, allow, reason, setAt}` shape `doctor` already
reports them in (`core/installer/doctor.js#listOverridesFromRaw`) — one
source of truth for what an "active override" looks like, read by both
commands.

---

## 10. Conflict resolution

`install` and `update` detect a developer's pre-existing local infrastructure
that would collide with what this installer is about to register, and say so
before writing anything — never something a developer discovers afterwards.
This is not about literal incompatibility: both hosts merge hook entries from
every registration source, so a foreign hook and softela-ai's own would coexist
without error. The concern is governance — a developer's own hook or harness
may duplicate, or quietly disagree with, what the shared infrastructure now
provides, and letting both run side by side without a human ever having
looked at that is exactly the "quietly, at its own discretion" outcome this
flow rules out. A developer's own local harness may only ever *strengthen*
what softela-ai provides, never weaken it — a conflict is the point where that
has to be decided deliberately, not assumed.

### What counts as a conflict

Detected fresh, per agent, on every `install` and `update` run
(`core/installer/conflicts.js#detectConflicts`):

- **A foreign hook registration.** A hook entry in `<agentHome>/settings.json`
  (Claude) or `<agentHome>/hooks.json` (Codex) whose command names a script
  living under the agent's own home directory, and that does not match any
  script this installer would itself register — for any module this
  repository ships, enabled or not, not only the currently-enabled set, so a
  disabled module's own lingering registration still reads as ours, pending
  removal, rather than as foreign. Ownership is matched by needle (the same
  mechanism `settings-json.js#findHookEntryIndex` already uses), never by the
  manifest's own stored index, which drifts the moment another entry is added
  or removed ahead of it in the same event's array.
- **A managed-block ambiguity.** The global instructions file (`CLAUDE.md` /
  `AGENTS.md`) already carrying more or less than one `BEGIN`/`END` marker
  pair this installer's own block would sit alongside —
  `managed-block.js#AmbiguousBlockError`'s own case, surfaced here instead of
  crashing the run. There is no safe automated fix for this one: guessing
  which marker occurrence is real is exactly what `managed-block.js` refuses
  to do, so it stays blocking under every resolution, `replace` included —
  the developer resolves the ambiguous text by hand, then re-runs.

**Never a conflict**, regardless of resolution:

- a hook whose command resolves outside the agent home — a repo-local or
  company-wide hook the developer runs deliberately;
- anything this installer's own manifest already owns — that is an update, not
  a conflict;
- an existing `<agentHome>/memory` directory, populated or not, with or
  without its own git repository — adopted, never reported as conflicting;
- `<codexHome>/memories` — Codex's own native memory, never read, never
  written, never touched by conflict detection at all.

### The three resolutions

`--on-conflict=replace|reconcile|abort` on `install` and `update`:

- **`replace`** (the recommendation) — backs up every file it is about to
  change through the existing backup mechanism (§7), then removes the
  conflicting hook *registrations* so softela-ai's own take effect. It never
  deletes the developer's own script file. Exactly what was disabled, and
  where the backup went, is reported. Everything it does is recoverable from
  that backup.
- **`reconcile`** — never attempts an automatic merge. For each conflict it
  reports what softela-ai would install, what the developer already has, and the
  specific question the developer has to answer, then stops (non-zero exit)
  with instructions to re-run with a decision. An agent that tries to merge
  conflicting infrastructure silently, on its own judgement, is exactly what
  this mode exists to rule out — it reports and asks, it does not merge.
- **`abort`** — reports the conflicts and stops (non-zero exit), changing
  nothing.

`--dry-run` works with all three and changes nothing under any of them.

### When nothing is passed

- **Interactive** (stdin is a TTY): the conflicts are printed, one line each,
  then the developer is asked which resolution to take — `replace` presented
  as the recommendation, an empty answer taking it.
- **Non-interactive**: never prompted, never guessed. The conflicts are
  printed and the run aborts (non-zero exit) naming all three flag values, so
  a piped or CI invocation can never silently clobber a developer's own
  hooks. `--yes` does **not** imply `replace` — only `--on-conflict=replace`
  does; a conflict left unresolved blocks the whole run for that agent, not
  only the conflicting hook, since writing everything else while skipping
  just the disputed hook would still add softela-ai's own entry alongside the
  developer's un-reviewed one.

The same gate applies wherever `install`/`update`'s plan-then-apply mechanic
is reused (`module enable`/`disable` included) — enforced inside the
per-agent lock, not only in the CLI's own pre-flight prompt, so no entry
point can bypass it.
