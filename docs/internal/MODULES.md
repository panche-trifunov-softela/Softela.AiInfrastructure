# Modules — implementation specification

A module is an opt-in bundle: some prompt text, some hooks, sometimes a CLI
subcommand, and always its own tests. It can be enabled at install time, and
enabled or disabled later without reinstalling anything else.

Read `CONTRACTS.md` first. §9 governs how a module's files and settings reach
the agent home, including the **`enforce` versus `seed`** distinction, which
matters here: every model, effort and approval setting a module ships is
`seed`, never `enforce`.

A module either demonstrably works or is not shipped. There is no third state.

---

## Layout

```
modules/<id>/
├── module.json          metadata and install plan
├── README.md            what it does, why, how to turn it off
├── prompt.md            the managed block injected into the agent's instructions
├── hooks/               module-specific hook entry points, if any
└── assets/              anything copied verbatim into the agent home
```

Tests live outside the module, in `tests/modules/<id>.test.js`, so the test
runner has one home and modules cannot quietly skip themselves.

### module.json

```json
{
  "id": "memory-as-context",
  "title": "Memory as context",
  "summary": "One line, shown in the installer prompt.",
  "defaultEnabled": true,
  "requires": [],
  "guards": ["…rule ids this module activates…"],
  "prompt": "prompt.md",
  "files": [
    { "from": "assets/inject-memory.js", "to": "hooks/inject-memory.js" }
  ],
  "commands": [
    { "agent": "claude", "from": "assets/thing.command.md", "to": "commands/thing.md" },
    { "agent": "codex",  "from": "assets/thing.skill.md",   "to": "skills/thing/SKILL.md" }
  ],
  "hooks": [
    { "agent": "claude", "event": "SessionStart", "matcher": null,
      "command": "{{NODE}} {{INSTALLED}}/hooks/inject-memory.js" },
    { "agent": "codex",  "event": "SessionStart", "matcher": null,
      "command": "{{NODE}} {{INSTALLED}}/hooks/inject-memory.js" }
  ],
  "settings": [
    { "agent": "codex", "mode": "seed", "pointer": "/agents/default_subagent_model",
      "tier": "cheap" }
  ],
  "options": {
    "location": { "type": "enum", "values": ["repo", "infrastructure", "global"],
                  "default": "infrastructure", "prompt": "Where should memory live?" }
  }
}
```

Substitutions available in `command` and in `prompt.md`: `{{NODE}}`,
`{{INSTALLED}}`, `{{AGENT_HOME}}`, `{{STATE_DIR}}`, `{{VERSION}}`, and any
option value as `{{OPT_<NAME>}}`.

`commands` is the one declaration whose `to` is resolved against the **agent
home**, not against `{{INSTALLED}}`. Each host discovers commands only at a
fixed location of its own — `<agentHome>/commands/<name>.md` for Claude Code's
`/name`, `<agentHome>/skills/<name>/SKILL.md` for Codex's `$name` — so a
command placed under `softela-ai/` like every other shipped file is simply never
found. Entries are agent-scoped because the two formats are genuinely
different documents, not one file copied twice: a Claude Code command carries
`description` / `argument-hint` / `allowed-tools` front matter and its body is
the instruction; a Codex skill carries `name` / `description`, and its
description is what decides whether the skill loads at all, so it has to say
when NOT to use it as well as when to. Both are manifest-tracked, so disabling
the module or uninstalling takes them away again.

A `settings` entry declares exactly one of `value` (a literal, written as-is
— every agent) or `tier` (`"frontier"` / `"balanced"` / `"cheap"`, resolved
into a concrete model id at install time via
`core/lib/codex-models.js#resolveModelForTier` — Codex only, since Codex has
no bare tier alias the way Claude Code's `/model = "opus"` already is one).
Declaring both, or neither, is a configuration error the installer reports
rather than guesses past.

A module that declares `guards` activates rules whose `requiresModule` names it.
Disabling the module deactivates those rules — no other mechanism turns a rule
off, because a rule that can be silently disabled from two directions is a rule
nobody can reason about.

---

## The five modules

Two of the five — `analyze-first` and `agent-orchestration` — ship no
`prompt.md` of their own. `core/installer/rulebook.js` generates a base
rulebook every install always carries, live at plan time
(`core/installer/detect.js#gather` calls it, `plan.js#planGlobalInstructions`
places its result first), and that rulebook already carries the concrete
form of both instructions in its own "Analyse first, then wait" and
"Delegation and model tier" sections. Each of those two sections is
conditional on the matching module being enabled
(`buildRulebookBody`'s own `enabledModuleIds` option), so the instruction
exists in exactly one place — never duplicated across a module's generic
`prompt.md` and the rulebook's concrete section, and never left behind under
the rulebook's heading once the module that owns it is disabled. Enabling or
disabling either module is purely a switch on that section; see
`core/installer/rulebook.js` for the generated text itself, not this file.

### `analyze-first` — default **on**

Investigate, plan, confirm, then build. The failure it addresses is the
expensive one: an agent that confidently builds the wrong thing, having guessed
at a detail nobody asked it to guess at.

- Prompt contribution: none of its own — see the note above "The five
  modules". Enabling it switches on the rulebook's "Analyse first, then
  wait" section: read before writing; state assumptions explicitly; when two
  readings of the request would produce materially different work, ask
  instead of picking; propose a concrete plan and wait for the developer's
  explicit go-ahead before building it.
- No guard. This one is genuinely behavioural, and pretending otherwise by
  bolting on a hook that blocks the first write of a session would be theatre.
- Tests: the rulebook's section appears while the module is enabled, and is
  gone from the managed block once it is disabled.

### `memory-as-context` — default **on**

Durable project knowledge on disk, injected at session start, so context
survives compaction and session loss.

**Ships a starter knowledge base, and never writes into a memory directory's
own top-level content — only ever into a subdirectory it owns outright.**
That second half is the single most important property and it gets its own
test: installing the module never adds or removes anything at the top level
of an already-existing memory directory.

Six parts:

- **Seeder** — runs before the injector below reads anything, on every
  `SessionStart` (and Codex's `PostCompact`). Lands this module's own shipped
  knowledge base — the Softela SCExpert knowledge base this repository is
  built for, shipped so every developer starts from the same facts, not a
  generic, host-agnostic starter set — at `<memoryDir>/softela/<slug>.md`, a
  subdirectory the tool owns outright and freely rewrites, plus regenerates a
  managed index block inside `MEMORY.md` and writes `ACTIVE-WORK.md` from a
  shipped template when absent. A developer's own top-level file with the
  same slug always wins — its shipped twin is skipped, never overwritten. An
  organisation forking this tool replaces the module's own `seed/` directory
  with its own. Idempotent and cheap in steady state: a marker file
  short-circuits every run after the first to a single file read. On a
  `MEMORY.md` `locateBlock` judges ambiguous (a duplicated managed block, or
  an `END` before its own `BEGIN`), the index write is left untouched and the
  version marker is withheld — never stamped for a partial run — so the next
  session retries automatically once the developer fixes the file by hand;
  the ambiguity itself is surfaced once, in `additionalContext`, and stays
  checkable afterward via `softela-ai doctor`, which reports the module's seed
  state (landed or not, file count, index present, stuck or not) as its own
  section.
- **Injector** — a `SessionStart` hook (both agents) and Codex's `PostCompact`
  emitting the memory index, the live work-state file and, when one exists for
  the session, the compaction checkpoint below, as additional context. Silent
  when none of the three is present.
- **Authority model** — memory sections are typed, and the type decides who may
  overwrite them:
  - `## INTENT — <topic>` — agreed design. **The developer is the authority.**
    Code that disagrees is evidence of a defect in the code, not of stale
    memory.
  - `## AS-OBSERVED <date> @ <ref>` — what the code actually does, verified
    against a named ref. Refreshed freely; re-dated every time.
  - `## CONFLICT <date>` — the code contradicts an INTENT block. Record both
    sides, report it, leave the INTENT standing. A conflict is a finding, not
    permission to overwrite.
- **Write guard** — intercepts `Write` and `Edit` on memory files, asking before
  any change removes or rewords an `## INTENT` block. Never denies: the
  developer may change their mind, and the guard only makes it deliberate.
  **Appending to an INTENT block passes silently.** Also watches for shell
  commands that would write directly to the memory directory (outside the
  write-tool contract), denying the bypass and directing to the write tool.
- **Version history** — every `Write` or `Edit` under the memory directory is
  recorded as a commit into that directory's own local git repository, with no
  remote configured, so a bad edit is always diffable and revertable. Lazily
  initialises the repository the first time there is something to commit
  (never before, and never touching files outside the write operation itself),
  and leaves any pre-existing repository history untouched. Silent, and never
  pushes.
- **Compaction checkpoint** — a `PreCompact` hook (both agents) extracting
  every message the developer themselves typed, verbatim and in order, plus a
  small mechanical state snapshot (cwd, git branch, short HEAD sha, dirty
  count), written to `<memoryDir>/checkpoints/<session-id>.md`. A hook cannot
  judge which of the *agent's* own conclusions matter — that stays
  `ACTIVE-WORK.md`'s job — but it can losslessly preserve the developer's own
  words, which is exactly what summarisation is most likely to damage. Never
  makes an existing checkpoint worse: an unreadable transcript, or an
  extraction yielding fewer turns than what is already on disk, leaves the
  existing file untouched. Retains the 20 most recently modified checkpoints.

Options: `location` — `global` (the default: the agent's own global memory
directory, `<agentHome>/memory` — the one each agent already loads by
convention, shared with whatever the developer already keeps there) ·
`infrastructure` (a per-project folder inside this tool's own directory,
keeping the product repo clean while staying project-scoped) · `repo` (inside
the product repository, git-ignored, never committed). `checkpoint` — `on`
(default, the compaction checkpoint above runs) · `off` (the `PreCompact`
hook exits without doing anything).

### `agent-orchestration` — default **on**

Strong models analyse, plan, decide and talk to the developer; cheaper models
read files, write code and do the routine work.

Prompt contribution: none of its own — see the note above "The five
modules". Enabling it switches on the rulebook's "Delegation and model tier"
section, naming that host's own concrete tier ids.

Activates `subagent-model`, `reasoning-effort-floor`, `delegate-bulk-reading`
and `no-nested-delegation` (see `RULES.md`).

Shipped defaults, **all `seed` mode** — an update never downgrades a developer
who has chosen something stronger:

| Setting | Claude Code | Codex |
|---|---|---|
| Main model — analysis, planning, decisions, conversation | Opus | tier `frontier` (resolves to whatever the installed binary reports for that tier today — see below) |
| Subagent model — parallel reading, code, routine work | *(chosen per spawn)* | *(chosen per spawn)* |
| Reasoning effort | `auto` | `high` |
| Default subagent reasoning effort | — (no equivalent seed target) | `medium` |
| Delegation available at all | *(built in)* | `features.multi_agent_v2 = true` |
| Per-spawn model choice | *(built in)* | `multi_agent_v2.expose_spawn_agent_model_overrides = true` |
| Permission mode | `auto` | "Approve for me" |

**No default subagent tier is pinned, on either host.** Which of the two
non-frontier tiers a task needs is a judgement the orchestrating session makes
per spawn, from that task's own size and difficulty — a pinned default would
send work that needs care to the cheap tier automatically and make the
balanced tier something a spawn has to remember to opt into. `subagent-model`
denies a spawn that names no model at all, which is what makes the choice
happen every time rather than being inherited.

The two Codex feature flags are not optional extras: without
`multi_agent_v2` the host offers **no spawn tool whatsoever**, and without
`expose_spawn_agent_model_overrides` a spawn carries no model and the
subagent silently runs on the session's own frontier model. Both were
established by running the binary — see CONTRACTS.md §7.

`default_subagent_reasoning_effort` seeds the floor a Codex subagent starts at.
It is a **top-level** `ConfigToml` field; there is no `[agents]` section on
this host, and a value written into one is parsed as an unknown table and read
by nothing. Measured, it is also already Codex's own default — a session at
`low` still spawns subagents at `medium` — so seeding it states the floor
explicitly rather than depending on a default that could move. The
`reasoning-effort-floor` guard reads a spawn's own effort under every spelling
Codex actually sends (`reasoning_effort`, `model_reasoning_effort`, and their
camelCase forms) alongside Claude Code's `effort`, so a Codex-side spawn is
judged the same way a Claude Code one is. Raising effort above the floor is
the orchestrating session's call; lowering it is nobody's.

Three things to get right in the implementation:

- **Codex's model settings seed a tier, not a version-pinned id.** Codex has
  no bare tier alias, unlike Claude Code's `/model = "opus"` — the ids it
  actually understands are always fully versioned (`gpt-5.6-sol`, and its
  successors as Codex releases new ones). `codex-models.js#resolveModelForTier`
  resolves the tier into a concrete id at install time — from the installed
  binary when it can, falling back to a shipped default (reported, never
  silently) when it cannot. The concrete ids (`gpt-5.6-sol`, `gpt-5.6-terra`,
  `gpt-5.6-luna`) are what resolves *today* from the installed binary — not a
  published contract, and not a value this module hard-codes; they can move
  the moment Codex ships a new version.
- **Codex has no `auto` reasoning effort.** Left unset it falls back to each
  model's own default, which for the frontier model is `low` — the opposite of
  what is wanted from the model that does the thinking. So it is pinned
  explicitly.
- **"Approve for me" is `approval_policy = "on-request"` together with
  `approvals_reviewer = "auto_review"`.** It is a reviewer swap, not a
  permission grant: writable roots, network access and protected paths are
  unchanged. The installer must not touch `sandbox_mode`.
- Per-spawn model and effort overrides on Codex sit behind a feature flag that
  is off by default. The installer enables it as a `seed` setting, and `doctor`
  reports when it has been turned back off, because the tier rule depends on it.

### `session-cleanup` — default **off**

Prunes saved session transcripts and their side-car folders, which accumulate
quickly and are rarely worth keeping.

- Reached **only** through this module's `commands` block, from inside a
  session: **`/clean-sessions` on Claude Code and `$clean-sessions` on
  Codex**. Deliberately not an `softela-ai` subcommand — that CLI only exists on
  a machine where somebody ran `npm link`, and a cleanup command that depends
  on it silently does nothing everywhere else. The installed script derives
  its own agent home from its own location, so neither command document has
  to carry an absolute path. A developer notices the disk filling up while
  they are in a session, and having to leave it for a second terminal is how
  a tool goes unused.
- **Two arguments, `--all` and `--apply`.** Without either it sweeps the
  sessions nearest the work — the current project on Claude Code, today on
  Codex, which files transcripts by date rather than by project.
- **Dry run by default.** Without `--apply` it lists what would go and the
  space it would free, and deletes nothing. The command runs the dry run,
  reports the numbers, asks, and only then applies — it never adds `--apply`
  to a run the developer has not agreed to.
- **The live session is never deleted.** There is no flag for it.
- **Memory directories are excluded in code, not by instruction**, alongside
  anything whose name is not a session identifier. No prompt wording can talk it
  into removing them, and the test proves it by pointing the cleaner at a
  directory containing a memory folder and asserting the folder survives.
- The live session's transcript is normally locked by the host; the side-car
  folder is still removed. Report what actually happened rather than what was
  attempted.

### `reply-language` — default **off**, default value English

Sets the language, or languages, the agent uses when talking to this developer.

**Conversation only.** Code, comments, documentation, commit messages, test
names, CLI output and every other artefact stay English regardless of the
setting. The prompt block says so explicitly, and
`tests/modules/reply-language.test.js` asserts that the generated block contains
that carve-out for every configured language — the one thing that must not be
possible to get wrong.

Option `languages`: an ordered list, default `["English"]`.

---

## Enabling and disabling

- `softela-ai install` enables every module whose `defaultEnabled` is `true`.
  `--modules a,b,c` selects an explicit set instead.
- **On an interactive terminal, which modules are enabled is asked, not only
  defaulted.** On a first install (no module selection stored yet for the
  agent), a multi-select shows every shipped module — its `title` as the
  label, its `summary` as the hint, each `defaultEnabled` one pre-checked and
  marked — and the developer's own selection, with any `requires` dependency
  it implies auto-enabled and reported, is what gets stored. On any later
  interactive run (`install` or `update`, once a module selection is already
  stored), the developer instead sees the currently stored configuration —
  enabled modules and each one's own option values — and is asked to
  continue with it or change it; continuing is the default, so pressing
  Enter behaves exactly as a routine re-run always has. Changing it re-runs
  the module multi-select and every option question, each pre-seeded with
  the *current stored value* as its default rather than the module's shipped
  default, so changing one thing never requires re-typing the others.
- **Each enabled module's own declared `options`** are asked the same way
  they always have been — with the option's own `prompt` text, an `enum`
  offered as a numbered/arrow-key choice and `reply-language`'s `languages`
  offered against its shipped catalogue, so a value the module needs is
  chosen by the developer rather than defaulted behind their back. Both the
  module-selection question and the per-option questions are skipped
  entirely when any of these holds:
  - stdin is not an interactive TTY, so a piped or CI run can never hang;
  - `--yes` was passed;
  - `--modules` was passed (the module-selection question specifically —
    each option question for the modules it names is still asked);
  - the value came from its own flag (`--memory-location`, `--reply-language`);
  - a value is already stored in state and this is not a "change it" answer,
    so a routine re-run does not re-ask.
- There is no dedicated flag to force or suppress the module-selection
  question — it follows automatically from whether a module selection is
  already stored, exactly like the option questions already did. Passing
  `--no-prompt` is still refused like any other flag `install` does not
  accept: `softela-ai: unknown flag "--no-prompt" for "install"`, with the closest
  accepted flag suggested — see
  [`docs/guide/cli.md`](../guide/cli.md#getting-help-without-this-document).
- `softela-ai module enable <id>` / `disable <id>` / `list` change it later,
  never prompting either question regardless of stdin, and
  each writes through the same plan-then-apply path the installer uses, so
  ownership and backups behave identically.
- Disabling removes the module's files, its hook registrations and its prompt
  block. It leaves `seed` settings alone — those are the developer's now — and
  says so in the output rather than silently.
- The enabled set lives in `<agentHome>/.softela-ai/state.json` and is reported by
  `doctor`.
