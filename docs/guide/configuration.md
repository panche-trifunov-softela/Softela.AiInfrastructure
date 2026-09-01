# Configuring the ruleset

How to turn a rule down for your repository, how to soften one for
yourself, and why those are two different files. For the full rule
catalogue see `docs/internal/RULES.md`; for the exact mechanics see
`docs/internal/CONTRACTS.md`.

## What a project config is

Every repository this infrastructure runs in is described by one file:
`projects/<RepositoryName>.json`, matched automatically by git remote (or,
if that fails, by folder name). A repository nobody has written a file for
gets `projects/_default.json` instead — an unconfigured repository still
runs the agreed rules, it does not go quiet.

A project file does three things: names the repository's base branches and
branch-naming pattern; fills in the facts a rule needs to be meaningful
(`limits.fileLines`, `conventions.componentFolders`, and so on — a rule
with none of the config it needs simply never runs, it never invents a
number); and optionally switches rules or whole rule **groups** on or off
(below). It also declares the repository's stack (frontend/backend/both)
and any local-config isolation it needs — see `docs/internal/CONTRACTS.md`
§8a for exactly how those resolve.

It is a file in this repository, reviewed like any other change here — not
something you edit locally.

## Three rule groups

Every rule belongs to exactly one group:

- **`git`** — branch protection, commit hygiene, rebase safety
- **`code`** — file size, folder shape, naming, reuse
- **`agent`** — subagent model tier, reasoning effort, protecting this
  infrastructure's own files

## Switching a rule or a group off, for one repository

Add a `rules` section to the project file:

```json
"rules": {
  "groups": { "code": { "action": "off", "reason": "backend code standards are not agreed with the team yet" } },
  "byId":   { "branch-naming": { "action": "off", "reason": "no shared branch convention here yet" } }
}
```

- `groups` switches an entire group at once. `byId` targets one rule, and
  **`byId` beats `groups`** — you can turn a group off and re-enable (or
  even escalate) one rule inside it.
- Each entry is either a bare string (`"off"`, `"ask"`, `"deny"`) or
  `{"action": ..., "reason": ...}`. Always write the `reason` — it is the
  only place a teammate reading the file learns *why*, not only *that*.
- This tier can move a rule's action in **either** direction: off, or
  stronger than its own default. It is committed and team-reviewed, so
  escalating is fine.

Two worked examples, taken from this repository's own `projects/`:

| File | What it does | Why |
|---|---|---|
| `Softela.PestManagement.json` | `"stack": "backend"`, no `rules` section | The stack alone keeps frontend-only rules out; no blunt switch needed. An earlier version used `rules.groups.code = off`, which was too blunt — it also silenced the stack-agnostic code rules the team agreed apply here too. |
| `Softela.AiInfrastructure.json` | `rules.groups.code = off` | This repository is developer infrastructure, not a product — there is no component tree or API layer for those rules to check. `git`, `agent`, and every protected path stay on: those protect *this* repository from an agent editing it. |

## Softening a rule for yourself only

Your own machine, never reviewed by anyone: `<agentHome>/.softela-ai/overrides.json`.

```json
{
  "rules": {
    "forbidden-commands": { "allow": ["\\bkubectl\\b"], "reason": "DevOps tooling" },
    "no-explicit-any":    { "action": "ask" },
    "colocated-tests":    { "action": "off" }
  },
  "projects": {
    "Softela.Bugworx": { "rules": { "file-size-limit": { "action": "off" } } }
  }
}
```

- `rules.<id>` applies everywhere; `projects.<id>.rules.<id>` scopes it to
  one repository.
- `action` clamps — it can only make the result *less* severe than what the
  rule (after the project config) already produced. Writing `"deny"` here
  on a rule that resolves to `ask` still gets you `ask`.
- `allow` is a list of regexes; a matching command or path drops the
  decision entirely, for one specific case rather than the whole rule.
- `softela-ai doctor` prints every override that is currently active, so a
  machine that has quietly softened half the ruleset is never invisible.

There is also a short-lived third option that is neither file: `softela-ai
approve <ruleId> [--minutes 60]`, run in your own terminal, grants a
time-boxed pass (default 60 minutes) for one rule. It never persists — a
permanent change belongs in `overrides.json`, where it stays visible. On
Codex this is also the only way past a rule that would only *ask* on
Claude Code — see [`README.md`](../../README.md#if-you-use-codex).

## Why these are two different files

| | project config (`projects/*.json`) | your `overrides.json` |
|---|---|---|
| who reviews it | the team, like any other change to this repository | nobody — it is yours |
| can it turn a rule **up**? | yes | no, soften-only |
| can it turn a rule **off**? | yes, by group or by id | yes, per rule, per id |
| where does it live | committed here | on your own machine, never installed or read by anyone else |

The project config is the team's agreement about what this repository
needs. Your overrides file is *your* workaround for *your* machine — it
can never be stronger than what the team agreed, only weaker, and only for
you. That asymmetry is what makes it safe to let you edit it without
review: the worst it can do is make your own session quieter, never the
team's.

## The one rule that can never be softened

`infra-self-protection` ignores the project config's `rules` switch **and**
`overrides.json`, unconditionally — the only rule in the whole set marked
this way.

It guards the infrastructure's own files: writes into `<agentHome>/softela-ai/`,
`~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.codex/config.toml`,
and any attempt to grant an approval or edit `overrides.json` from inside a
tool call.

The reason it stays unsoftenable: every other rule's softening — a project
config's `off`, an override's clamp, an approval — is *itself* an action
this infrastructure has to trust. If an agent could edit the file that
grants that trust, or approve its own exception, "a person decided this"
would stop being true. `infra-self-protection` is what keeps that decision
a human act, on every machine, for both agents, always.
