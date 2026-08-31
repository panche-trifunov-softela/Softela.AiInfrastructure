# Modules

Five opt-in bundles of prompt text, hooks and settings. Each is enabled or
disabled independently, at install time or afterward, without touching
anything else this repository installs. See `docs/internal/MODULES.md` for
the full specification and `docs/internal/CONTRACTS.md` §9 for what
`enforce` and `seed` mean below.

| Module | Default | Options |
|---|---|---|
| [`analyze-first`](analyze-first/) | **on** | — |
| [`memory-as-context`](memory-as-context/) | **on** | `location`: `repo` \| `infrastructure` (default) \| `global`; `checkpoint`: `on` (default) \| `off` |
| [`agent-orchestration`](agent-orchestration/) | **on** | — |
| [`session-cleanup`](session-cleanup/) | **off** | — |
| [`reply-language`](reply-language/) | **off** | `languages`: ordered list, default `["English"]` |

## What each one does

- **`analyze-first`** — read before writing, state assumptions, ask instead
  of guessing when a request is genuinely ambiguous. Prompt text only; no
  guard, and its own `README.md` explains why.
- **`memory-as-context`** — durable project knowledge on disk, injected at
  session start (and after a compaction, on Codex). Ships the mechanism
  only: an injector, an INTENT write guard, local version history, and a
  `PreCompact` checkpoint of the developer's own verbatim messages
  (`checkpoint` option, on by default) — never any content, and never a
  write into a memory directory that already exists.
- **`agent-orchestration`** — strong models analyse and decide, cheaper
  models do routine work. Activates the `subagent-model` and
  `reasoning-effort-floor` guards and seeds a matching set of model, effort
  and approval defaults, all `seed` mode.
- **`session-cleanup`** — prunes saved session transcripts. Dry run by
  default; memory directories are excluded in code, not by instruction.
- **`reply-language`** — which language, or ordered list of languages, the
  agent replies in. Conversation only — code, comments, docs, commit
  messages, test names and CLI output stay English regardless.

## Enabling and disabling

- `softela-ai install` never prompts — it is non-interactive by default, enabling
  every module whose `defaultEnabled` is `true`. `--modules a,b,c` selects an
  explicit set instead; `--memory-location` and `--reply-language` set those
  two modules' options directly from the command line. There is no
  interactive per-module prompt, and therefore no `--no-prompt` flag to
  suppress one — neither is implemented, and neither is planned. Passing
  `--no-prompt` is refused like any other flag `install` does not accept, not
  silently accepted.
- `softela-ai module enable <id>` / `disable <id>` / `list` change the enabled
  set later, through the same plan-then-apply path the installer itself
  uses — a change made this way gets the same backups and the same
  ownership tracking as an install.
- Disabling a module removes its files, its hook registrations and its
  prompt block. It leaves every `seed` setting the module wrote alone —
  those became the developer's own the moment they were written — and the
  command's output says so rather than doing it silently.
- The enabled set lives in `<agentHome>/.softela-ai/state.json` and is reported
  by `softela-ai doctor`.

## Layout

```
modules/<id>/
├── module.json          metadata and install plan
├── README.md             what it does, why, how to turn it off
├── prompt.md             the managed block injected into the agent's instructions
├── hooks/                module-specific hook entry points, where the module needs one
└── assets/               anything else copied verbatim into the agent home
```

Tests live outside each module, in `tests/modules/<id>.test.js`, so the test
runner has one home and a module cannot quietly skip itself.
