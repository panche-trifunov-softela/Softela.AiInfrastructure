# Softela AI Infrastructure

Makes an AI coding agent behave the same way on every developer's machine —
Claude Code and Codex alike.

Every rule is written once, as a plain function in `core/guards/`, and runs as
a hook that can genuinely refuse a tool call. Not documentation an agent may or
may not have read: a `git push` to a base branch is **blocked**, not
discouraged. Because both agents run the same functions, they cannot quietly
drift apart.

## Install

Node.js 18 or later. Nothing else — this repository ships no dependencies, and
its own rules keep it that way.

```
git clone https://github.com/panche-trifunov-softela/Softela.AiInfrastructure.git
cd Softela.AiInfrastructure
npm run preview   # print the plan, change nothing
npm run setup     # apply it
npm run doctor    # check what landed
```

`npm run setup` asks which modules you want and how to configure them, then
writes into `~/.claude` and `~/.codex`. It touches nothing outside those two
directories, and it backs up every file it modifies first.

Everything is **copied**, never linked. You can delete this clone afterwards
and your installation keeps working.

## Getting the `softela-ai` command

The three commands above need no setup, but they only cover the common cases
and take no flags. For everything else — `override`, `approve`, `module`,
`link` — you want the real command. Run this once, from inside the clone:

```
npm link
```

From then on `softela-ai <command>` works from any directory — including the
product repo where a rule just blocked you — which is how the rest of this
document writes it. `npm unlink`, from the clone, removes it again.

[`docs/guide/cli.md`](docs/guide/cli.md) has the full detail: every flag,
alternatives to `npm link`, and how to pass flags through `npm run`.

## Day to day

| Command | What it does |
| --- | --- |
| `softela-ai install` | Set up an agent home |
| `softela-ai update` | Reconcile your installation after `git pull` |
| `softela-ai doctor` | What is installed, what drifted, Claude/Codex parity |
| `softela-ai module list` | Which modules are on |
| `softela-ai override <rule> off --reason "…"` | Soften one rule for yourself |
| `softela-ai approve <rule> --minutes 30` | A time-boxed exception, once |
| `softela-ai link` | Write the `AGENTS.md` / `CLAUDE.md` pointer into a product repo |

Add `--help` to any command for its own flags and a worked example. Run
`softela-ai` with no arguments for the full list.

One thing is deliberately **not** an `softela-ai` command. Pruning saved session
transcripts runs inside the session instead — `/clean-sessions` on Claude
Code, `$clean-sessions` on Codex — so it works whether or not you ever ran
`npm link`. It reports before it deletes, never removes the live session, and
never touches a directory named `memory`.

## What you get

**35 rules**, in three groups. Each returns one of three outcomes: **pass**
(silent), **ask** (you decide), or **deny** (blocked, always with a suggested
fix).

| Group | Covers |
| --- | --- |
| `git` | Branch protection, commit hygiene, rebase safety, protected paths, per-repository forbidden commands |
| `code` | File size, folder shape, layer boundaries on both stacks, naming, documentation style, reuse before writing something new, the transactional outbox, migrations that have already been applied |
| `agent` | Which model tier a subagent may use, a floor on reasoning effort, when to delegate a survey, keeping delegation one level deep, and protecting this infrastructure's own files |

**29 of the 35 run in a repository that has no project config at all** —
`projects/_default.json` supplies sensible stack detection, limits and
protected paths, so a rule is never silently inert just because nobody wrote a
config yet. The six that stay quiet need a repository-specific fact that
cannot be guessed: a typecheck invocation, an install flag, a patch-manifest
shape, a migration-script layout, a layer ordering, an outbox spelling. The
last two arrive for any repository that declares `"stack": "backend"`, from
`projects/_presets/backend.json`.

`_default.json` is a **floor, not a fallback**: writing a project file for a
repository layers that file on top of the defaults, so naming a repository
adds rules to it and never removes any. Protection lists are unioned and the
stronger action wins; the one way a project ends up weaker is an explicit
`off`, written down in the config where a reviewer can see it.

**5 modules**, three enabled by default:

| Module | Default | What it does |
| --- | --- | --- |
| `analyze-first` | on | Read before writing; state assumptions; ask instead of guessing |
| `memory-as-context` | on | Durable project knowledge on disk, re-injected at session start and after compaction |
| `agent-orchestration` | on | Strong models decide, cheaper models execute; enforces subagent model tier and effort floor |
| `reply-language` | opt-in | Which language the agent replies in — conversation only, never code or docs |
| `session-cleanup` | opt-in | Prunes saved session transcripts, dry run by default |

**The standards themselves**, copied into the agent home so the agent reads
them rather than guessing: `docs/standards/` (portable rules) and
`docs/projects/` (what is true about one repository).

## When a rule blocks you

A denial always names the rule and suggests the corrected command. If it is
wrong for your situation, in order of preference:

1. **`softela-ai approve <rule> --minutes 30`** — a one-off, time-boxed exception.
2. **`softela-ai override <rule> ask --reason "…"`** — soften it for yourself,
   permanently, with the reason recorded. An override may only ever make a
   rule weaker, never stronger.
3. **Change the project config** in `projects/<Repo>.json` — this is the right
   answer when the rule is wrong for the whole team, not just for you.

One rule can never be softened: `infra-self-protection`, which stops an agent
disabling its own guard rails.

Details: [`docs/guide/configuration.md`](docs/guide/configuration.md).

## If you use Codex

Two things behave differently from Claude Code:

- **Hooks stay inert until you complete Codex's own one-time hook-trust
  review.** Until you do, **nothing is enforced** — and an unapproved hook
  is skipped in complete silence, no log line, indistinguishable from a
  healthy run. Run `softela-ai doctor` after installing; it lists any hook
  still unapproved rather than reporting a healthy install.
- **Codex has no native "ask".** A rule that would ask you on Claude Code
  arrives as a block on Codex instead, naming the rule and the way past
  it: `softela-ai approve <rule>`.

## What this does not do

- It does not review your code or judge design. A rule is a mechanical check.
- It does not run in CI. These are local hooks on a developer machine; CI
  enforcement is separate — see [`docs/guide/ci.md`](docs/guide/ci.md).
- It does not stop a determined developer. The point is to make the agreed
  path the easy one, and to make an accident impossible — not to be a
  security boundary against its own user.

## Where to read more

| Document | For |
| --- | --- |
| [`docs/guide/cli.md`](docs/guide/cli.md) | Every command and flag |
| [`docs/guide/configuration.md`](docs/guide/configuration.md) | Turning rules off, per repository and per developer |
| [`docs/guide/ci.md`](docs/guide/ci.md) | Running the same checks in a pipeline |
| [`docs/standards/assembled/`](docs/standards/assembled/) | The engineering standards, assembled and whole — the ones to read |
| [`docs/standards/`](docs/standards/) | The parts those are built from, one topic per file |
| [`docs/internal/RULES.md`](docs/internal/RULES.md) | Per-rule specification: triggers, passes, evasion cases |
| [`docs/internal/CONTRACTS.md`](docs/internal/CONTRACTS.md) | How a rule, the engine and the adapters fit together |
| [`docs/OPEN-DECISIONS.md`](docs/OPEN-DECISIONS.md) | Questions not settled yet. Nothing there is a rule |

## Contributing

```
npm test                      # the whole suite
node tests/run.js guards      # one area
node tests/run.js guards/no-push-to-base   # one rule
```

A new rule is one file in `core/guards/` plus one table-driven suite in
`tests/guards/`, with **more negative cases than positive ones** — a rule that
fires on ordinary work gets switched off, and then it protects nothing.
`docs/internal/CONTRACTS.md` is the binding specification; read it first.
