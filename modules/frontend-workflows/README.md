# frontend-workflows

Default: **on**. No options. Ships no hook and activates no guard — it is
three documents.

Repeatable procedures for the three frontend jobs an agent gets wrong the
same way every time.

| Claude Code | Codex | For |
|---|---|---|
| `/new-component` | `$new-component` | Scaffolding a component folder |
| `/split-component` | `$split-component` | Decomposing an oversized one |
| `/new-endpoint` | `$new-endpoint` | Adding a backend call |

## Why these three, and why as commands

The frontend standard asks for exactly this
(`docs/standards/assembled/FRONTEND-ARCHITECTURE-STANDARD.md`, the agent
section): reusable instructions for recurring workflows, "so 'add a new API
method' or 'split this component' runs the same steps every time rather than
being re-derived — badly — on each attempt."

The guards already cover the mechanical half. What they cannot cover is the
part that decides whether the change was any good, and it is always the same
part:

- **Before scaffolding** — whether the component should exist at all. A
  guard sees where a file sits; it cannot see that the component duplicates
  one three folders away. Nothing in review catches it either, because the
  new file looks fine on its own.
- **Before splitting** — where the seams are. Splitting along the wrong ones
  produces more files with the same coupling, which is worse than one big
  file, and every guard passes.
- **Before calling an endpoint** — whether the endpoint and the shape are
  real. This is the highest-hallucination workflow of the three, and both
  failure modes (an endpoint that does not exist, a response shape that is
  close but wrong) are invisible until a user opens the screen.

Each document therefore front-loads the step that cannot be checked and
makes the answer a report, not a silent decision: what was searched for,
what was found, what could not be found and was therefore *not* written.

## Why a command rather than more prompt text

The rulebook is loaded into every session and is already near its own line
ceiling (`core/installer/rulebook.js`). A procedure that matters at the
moment of one specific task, three times a week, does not earn permanent
context — it earns being reachable by name when that task starts. That is
what a command is for.

It also means the developer chooses to run it, which is the honest framing:
these are procedures, not rules. Nothing here denies anything.

## The two hosts get two documents, not one file copied twice

Same requirement as `session-cleanup`, same reason (`docs/internal/MODULES.md`):

- A **Claude Code command** carries `description` / `argument-hint` /
  `allowed-tools` front matter, and its body is the instruction. It gets
  `$ARGUMENTS`, so `/new-component OrderPanel under the shipments screen`
  passes the detail straight through.
- A **Codex skill** carries `name` / `description`, and that description is
  what decides whether the skill loads at all — so it has to say when *not*
  to use it as well as when to. Each one names the sibling it is most likely
  to be confused with.

The procedure body is the same document in both. When one changes, change
both — a workflow that differs by host is a workflow nobody can rely on.

## Turning it off

`softela-ai module disable frontend-workflows` removes all six files. They
are manifest-tracked like anything else, so nothing is left behind.

A backend-only developer loses nothing by disabling it; the commands are
frontend procedures and say so. It is on by default because the cost of an
unused command is one file, and the cost of not having it is a component
folder that has to be rewritten in review.
