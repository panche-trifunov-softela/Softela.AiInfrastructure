# memory-as-context

Default: **on**. Options: `location` — `global` (default) | `infrastructure` |
`repo`. `checkpoint` — `on` (default) | `off`.

Durable project knowledge on disk, injected at session start, so context
survives compaction and session loss. Three hooks carry it —
`inject-memory.js` reads the directory in, `guard-memory.js` protects what
is already recorded there, and `memory-autocommit.js` versions every change
— all host-agnostic and project-scoped.

Also captures a **compaction checkpoint**: right before a manual `/compact`
or an automatic compaction drops conversation history, a `PreCompact` hook
extracts every message the developer themselves typed — verbatim, in
order — plus a small mechanical state snapshot, so the substance of the
conversation is not lost to summarisation. See "Compaction checkpoint" below.

**Ships real content, not only the mechanism.** `inject-memory.js` seeds the
memory directory from this module's own shipped knowledge base
(`hooks/seed-memory.js`) before it reads, so a fresh install injects
something real on the very first session instead of nothing. That seeding
never overwrites anything the developer already manages: every shipped file
lands under `<memoryDir>/softela/`, a subdirectory this tool owns outright and
may freely rewrite on every run; a seed file whose slug already exists as a
top-level `<memoryDir>/<name>.md` is skipped outright, since the developer's
own copy wins; `ACTIVE-WORK.md` is written from a shipped template only when
the file is absent, and never touched again once it exists. "Never writes
into a memory directory that already exists" — the property the rest of this
module is built around — narrows accordingly, from "never writes into it at
all" to "never touches anything outside `softela/` that was not already
absent". See "Seeding" below.

## The nine parts

1. **`hooks/inject-memory.js`** — `SessionStart` (both agents), and Codex's
   `PostCompact`. Seeds the memory directory (`seed-memory.js`, see
   "Seeding" below) before reading anything, then reads `MEMORY.md` and
   `ACTIVE-WORK.md` from the resolved memory directory and injects them as
   additional context, together with a short statement of the authority
   model below, plus the current session's compaction checkpoint when one
   exists (see "Compaction checkpoint"). Emits a valid, minimal JSON payload
   even when there is nothing to inject — `additionalContext` is omitted
   rather than sent as an empty string — since Codex's `PostCompact` and
   `SessionStart` unconditionally parse stdout as JSON, and empty stdout is
   not valid JSON.
2. **`hooks/guard-memory.js`** — `PreToolUse` on `Write`/`Edit`. Asks before
   a write would remove or reword a `## INTENT — <topic>` section anywhere
   under the memory directory. Never denies on Claude Code — the developer
   may change their mind, and the guard only makes the change deliberate.
   Appending to an INTENT block, or writing anywhere else in the file, passes
   silently. Also runs on the shell tools (`Bash`, `PowerShell`, and Codex's
   equivalents): a shell command whose extracted write target lands inside
   the resolved memory directory is denied outright, on both hosts, naming
   the write tool to use instead. `core/guards/shell-file-write.js` cannot
   cover this itself — it deliberately excludes a target outside
   `ctx.git.repoRoot`, and the memory directory routinely lives outside
   whatever repository that is — so this hook, which already resolves the
   memory location, covers the shell case directly instead.
3. **`hooks/memory-autocommit.js`** — `PostToolUse` on `Write`/`Edit`.
   Records every change under the memory directory into that directory's own
   local git repository — initialising it lazily, on the first commit, never
   before there is real content to version. No remote, never pushed, never
   touches any other repository.
4. **`hooks/compact-checkpoint.js`** — `PreCompact` (both agents). Extracts
   the developer's own transcript turns and writes the compaction checkpoint.
   See "Compaction checkpoint" below.
5. **`hooks/transcript.js`** — the parser library `compact-checkpoint.js` and
   `inject-memory.js` share: extracting developer turns from a raw
   transcript (Claude Code's own JSONL shape or Codex's "rollout" shape,
   detected by the shape of each line, never by file path or which agent is
   running), and rendering the checkpoint markdown.
6. **`hooks/memory-location.js`** — shared by every script above, required
   only as a sibling (`./memory-location`), never reaching into `core/lib`.
   Resolves the memory directory for the current invocation (see "Where
   memory lives" below) and, for a directory this tool owns outright, excludes
   it from whatever git repository happens to enclose it, via that
   repository's own `.git/info/exclude` — never the developer's own tracked
   `.gitignore`. Also exports `isSharedMemoryDir`, the single source of truth
   every other hook consults before doing anything destructive or structural
   to a resolved memory directory — see "Adoption" below.
7. **`hooks/stdin.js`** — required by `inject-memory.js`, `guard-memory.js`,
   `memory-autocommit.js`, `compact-checkpoint.js` and `seed-memory.js` in
   place of a bare synchronous `fs.readFileSync(0)`, which blocks forever
   against a host that opens a stdin pipe but never writes to it or closes
   it. A narrow, deliberate exception to this module's own "siblings only,
   never `core/lib`" rule (see "Judgement calls" below): it resolves and
   re-exports `core/lib/hook-stdin.js` — the same non-blocking read
   `adapters/shared/dispatch-core.js` already used — across this module's
   two on-disk layouts, so the read itself has exactly one implementation
   anywhere in the repository.
8. **`hooks/seed-memory.js`** — the seeder `inject-memory.js` calls before it
   reads (see "Seeding" below). Also independently runnable as its own
   subprocess, the same way every other script here is. Locates this
   module's own installed catalogue directory (the `seed/` files and
   `ACTIVE-WORK.tmpl.md` this repository ships alongside the module, a
   different on-disk location from the flat `hooks/` copy this file itself
   is installed into — same two-layout split `stdin.js` already handles for
   the same underlying reason), parses each seed file's YAML frontmatter for
   its `name` and `description` with a small dedicated parser rather than a
   general YAML library (this project ships no dependencies), and gates the
   whole scan behind a one-file marker read once a seed version has already
   been applied, so a session start after the first costs a single file read
   rather than a rescan of every shipped file.
9. **`hooks/git-commit.js`** — the guarded `git init` / `git add -A` /
   `git commit` sequence `memory-autocommit.js` and `seed-memory.js` both
   need, pulled out as a shared sibling so neither re-derives it. Same
   "never nests a fresh repository into a shared directory that already sits
   inside some other enclosing one" guarantee either caller relied on before
   the two were unified.

## Seeding

`seed-memory.js` is what makes "ships the mechanism" also ship real content.
Every `.md` file under this module's own `seed/` directory carries YAML
frontmatter with a `name` and a `description`; both are read, everything
else in the file is opaque to the seeder.

- **Lands under `<memoryDir>/softela/<name>.md`** — a subdirectory this tool owns
  outright and may freely rewrite on every run. Nothing outside `softela/` is
  ever overwritten.
- **A top-level override wins.** A seed file whose slug already exists as
  `<memoryDir>/<name>.md` is skipped outright — no log, just silence — since
  the developer already keeps that topic under their own management.
- **The index is generated, never hand-maintained.** One line per successfully
  seeded file, `- [<name>](softela/<name>.md) — <description>`, inside a managed
  block in `<memoryDir>/MEMORY.md`, delimited by the exact same marker
  strings `core/installer/managed-block.js` uses (duplicated as literals,
  not `require`d, per this module's own "siblings only" rule — a dedicated
  test asserts the two stay byte-identical). Everything outside the block is
  the developer's own and is never touched; the block itself is regenerated
  in full on every reseed.
- **A seed file with malformed frontmatter — no fence, a missing field, or a
  `name` that is not a plain slug — is skipped**, never crashes the hook.
- **`ACTIVE-WORK.md`** is written from `ACTIVE-WORK.tmpl.md` only when the
  file is absent; once it exists, it is never touched again.
- **Idempotent**, and cheap in steady state: a marker file under `softela/`
  records the seed version last applied, and a matching marker short-circuits
  the entire run to a single file read — no directory scan, no file writes.
  Measured cold-start cost seeding 37 files end to end (including the two
  `git` child processes for the commit) is well under a second; steady-state
  cost is dominated entirely by Node's own process-startup time.
- **Committed** into the memory directory's own local git repository via
  `git-commit.js`, under the exact same guards `memory-autocommit.js` uses —
  never initialising a fresh repository inside a shared (`global`) directory
  that is not already one.
- **Fails open, always.** An unreadable seed catalogue, an unwritable memory
  directory, or malformed frontmatter never stops a session — worst case,
  less (or none) of the seed content lands on a given run.

## Compaction checkpoint

A hook cannot judge which of the *agent's* own conclusions matter — that is
what `ACTIVE-WORK.md` is for, kept current by the agent itself. What a hook
**can** do losslessly, needing no interpretation, is preserve the one thing
summarisation damages most: **every message the developer themselves
typed**, verbatim and in order — the requirements, the corrections, the
rulings, the agreements. `compact-checkpoint.js` does exactly that and
nothing more:

- **Captures**: every genuine developer turn from the transcript, in order,
  plus a small mechanical state snapshot (cwd, git branch, short HEAD sha,
  count of dirty paths). Machine traffic logged under the developer's own
  role — slash-command envelopes, captured shell output, injected reminders,
  the compaction-continuation block itself — is filtered out, never treated
  as something the developer said.
- **Does not capture**: any conclusion, summary, decision or plan the agent
  reached — those live in `ACTIVE-WORK.md`, and stay the agent's own job to
  keep current. The checkpoint and `ACTIVE-WORK.md` are complementary: one
  is the raw verbatim record, the other is the agent's own distilled state.
- **Where it lands**: `<memoryDir>/checkpoints/<session-id>.md`. Selected on
  the next `SessionStart` (or Codex's `PostCompact`) by session id when
  known, otherwise the most recently modified file in `checkpoints/`.
- **Retention**: the 20 most recently modified checkpoint files survive each
  write; older ones are pruned.
- **Never makes it worse.** If the transcript cannot be read, or a pass
  extracts fewer developer turns than the checkpoint already on disk
  records, the existing file is left exactly as it was and the failure is
  noted in the hook's `systemMessage` — never silently. Every other
  successful run rewrites the file in full: the transcript is cumulative, so
  a full rewrite is idempotent.
- **Option `checkpoint`**: `on` (default) | `off`. Turning it off makes the
  hook exit silently, doing nothing, on every `PreCompact` call.
- Fires on both a manual `/compact` and an automatic compaction, and never
  blocks or delays either — a bug in this hook degrades to doing nothing,
  never to breaking compaction.

## Where memory lives

- `global` (default) — the agent's own global memory directory:
  `<agentHome>/memory`. This is the one directory each agent already loads by
  convention, and it may already exist, already hold a developer's own
  hand-maintained content, and already be its own git repository. This tool
  shares that directory rather than owning it — see "Adoption" below.
- `infrastructure` — a per-project folder inside this tool's own directory:
  `<agentHome>/softela-ai/memory/<sanitized repo basename>`, keeping the product
  repository clean while staying project-scoped. Unlike `global`, this
  directory is owned outright by the tool.
- `repo` — inside the product repository itself: `<repoRoot>/.softela-ai-memory`,
  excluded from that repository via its own `.git/info/exclude`. Falls back
  to `global` when the working directory is not inside a git repository.

The resolved agent home is baked into each hook's registered command at
install time (`--agent-home={{AGENT_HOME}}`); the working directory is read
per invocation from the host payload, so a project-scoped location is
resolved freshly for whichever repository the current tool call is actually
running against.

On Codex, `global` resolves to `<codexHome>/memory` — singular, distinct from
Codex's own native `<codexHome>/memories` (plural). The two are never the
same path and no hook in this module ever reads, writes, creates or scans
`memories`.

## Adoption

`global` is the only location a developer may already be using by hand
before this module ever runs, so it gets a stronger guarantee than "ships no
content": when the resolved directory already exists, this module never
deletes, moves, renames, truncates or rewrites anything it finds there — it
only adds files.

- **`memory-autocommit.js`** never re-initialises, reconfigures, adds a
  remote to, or pushes a `global` directory that is already its own git
  repository — the developer's own history is left exactly as found. When
  that directory is not yet its own repository but already sits inside some
  other enclosing one (a dotfiles repo rooted at the home directory, say), it
  declines outright rather than nesting a fresh, historyless repo into
  existing tracked content. Nesting only ever happens for a directory the
  tool owns outright (`repo` / `infrastructure`), or for a `global` directory
  with no enclosing repository at all — both unchanged from before.
- **`compact-checkpoint.js`** only ever creates its own `checkpoints/`
  subdirectory, never touching anything else already in the directory.
- **`inject-memory.js`** reads `MEMORY.md` and `ACTIVE-WORK.md`, but no
  longer without side effects: it seeds first (see "Seeding" above). That
  seeding is itself scoped by the same rule as everything else in this
  section — `softela/` only, plus `MEMORY.md`'s own managed block, plus
  `ACTIVE-WORK.md` only when it was absent — never a rewrite of anything the
  developer already had.
- The `.git/info/exclude` exclusion described above never runs for a `global`
  directory at all (`isSharedMemoryDir`, in `memory-location.js`) — writing
  into an enclosing repository's exclude file on behalf of content the tool
  did not create and may not even end up versioning is exactly the kind of
  structural side effect adoption must avoid.

## Turning it off

`softela-ai module disable memory-as-context` removes every one of this module's
hook registrations and the prompt block. **The memory directory itself is
left exactly where it is** — it holds the developer's own knowledge, not this
module's, so disabling the mechanism does not touch the content it was
reading and writing, including any checkpoint already written under
`checkpoints/`.

## Judgement calls made in this implementation

- **`core/schema/project.schema.json` already declares a per-project
  `memoryLocation` field**, and `core/lib/project-resolver.js` already
  resolves it. This module's runtime scripts do not read it: every module
  hook script here is deliberately self-contained (siblings only, no
  `core/lib` require, with the single, narrow exception of `hooks/stdin.js`
  — see part 7 above, added to fix every hook's stdin read hanging forever
  against a host that never closes the pipe), which avoids depending on
  exactly where `core/` ends up relative to an installed hook script — a
  relationship
  `INSTALLER.md` and this module's own `module.json` example do not pin down
  identically (the tree diagram in `INSTALLER.md` places hook entry points at
  `<agentHome>/hooks/`, while the worked example in `MODULES.md` sources them
  from the module's own `assets/`; this module treats `{{INSTALLED}}/hooks/`
  as the destination for both `from` and `to`, per the literal `module.json`
  example, and does not attempt to resolve the discrepancy on its own).
  Reconciling per-project `memoryLocation` with this module's own `location`
  option — which should win — is unresolved and worth a decision before
  either is relied upon in a repository that sets both.
- **Autocommit initialises the git repository itself**, lazily, on the first
  commit. The alternative is a separate one-time setup step, which this
  module deliberately does not have: a step a developer can forget is a
  memory directory that silently never gets versioned. Shipping "mechanism
  only" without seeding content still
  allows shipping the *versioning* mechanism itself; the alternative — never
  initialising, and leaving memory permanently unversioned until a developer
  manually runs `git init` in a directory this module otherwise manages
  invisibly — seemed like the worse default. This lazy init still never runs
  for a `global` directory that sits, un-versioned, inside some other
  enclosing repository — see "Adoption" above.
- **Codex's `PreToolUse` has no native `ask`.** `guard-memory.js` follows
  CONTRACTS §7's `askMode: "block"` default: what would be an `ask` on Claude
  Code becomes a `deny` on Codex, with a reason stating that Codex has no
  interactive `ask` here. There is no `softela-ai approve` wiring for this
  specific guard, since it is a standalone script outside the
  `core/guards/` rule registry — a developer who hits it edits the file
  directly outside the agent, or adds a `## CONFLICT` section instead of
  rewriting the INTENT.
