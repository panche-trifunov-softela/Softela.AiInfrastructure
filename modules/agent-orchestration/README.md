# agent-orchestration

Default: **on**. No options.

Strong models analyse, plan, decide and talk to the developer; cheaper
models read files, write code and do the routine work. This module activates
two already-built guards, seeds a matching set of model/effort/approval
defaults, and switches on the "Delegation and model tier" section of the
base rulebook every install already carries
(`core/installer/rulebook.js#buildDelegationSection`,
`core/installer/plan.js#planGlobalInstructions`), naming that host's own
concrete tier ids rather than shipping a second, generic copy of the same
instruction in a `prompt.md` of its own. It also registers a `UserPromptSubmit`
reminder hook — see "The reminder hook" below — so the rule stays live for the
whole session, not only for the first few turns. Disabling the module removes
the rulebook section and unregisters the hook; the seed settings below are
untouched (see "Turning it off").

## What it activates

`guards: ["subagent-model", "reasoning-effort-floor"]` — both rules already
live in `core/guards/` with `requiresModule: "agent-orchestration"`. Enabling
this module is what turns them on; disabling it turns them back off. No new
hook registration is needed for either guard specifically — both rules run
inside the dispatcher every project already registers for `PreToolUse`,
gated by whether `agent-orchestration` is in the enabled module set. (The
module does register one hook of its own, for the reminder below — that
registration has nothing to do with either guard.)

- **`subagent-model`** — denies a spawn with no explicit model; asks on a
  spawn more expensive than the session's own tier, or on a frontier-tier
  spawn regardless of the session.
- **`reasoning-effort-floor`** — denies a spawn whose reasoning effort is set
  explicitly below `medium`.

## The reminder hook

`hooks/inject-delegation-mode.js` is a `UserPromptSubmit` reminder,
registered for both agents, that re-states the "you are the orchestrator"
rule next to every developer prompt instead of relying solely on the
rulebook section injected once at session start — in a long session that
block ends up buried under everything that followed. It prints only
`hookSpecificOutput.additionalContext` — the developer never sees it — and
never blocks, rewrites, or fails a turn: unparseable stdin, a non-object
payload, or a subagent's own prompt event (`agent_id`/`agent_type` present)
all exit silently, and a failed log append (below) never stops the reminder
from printing.

It also appends one task-boundary marker line — `{ts, agent, event:
"UserPromptSubmit", sessionId}` — to the same day's guard-activity log on
every main-session prompt, via `paths.guardLogPath`/`fs-safe.appendLineSafe`.
A prompt is the only reliable boundary between one task and the next in
either host's event stream, and a guard reading the log back needs that
boundary to tell "the agent did this itself" apart from "the agent
delegated it" for the task actually in front of it right now, not a
previous one that already finished — see `delegate-bulk-reading`.
`analyze-first`'s own `inject-plan-gate.js` is the sibling hook doing the
same reminder-only job for the plan-first gate, minus the marker; see that
module's README.

## What it seeds

Every entry below is `mode: "seed"` — written only when the key is absent, so
enabling this module never downgrades a developer already running something
stronger. See "Judgement calls" for how confident each key name is.

| Setting | Claude Code | Codex |
|---|---|---|
| Main model | `/model` = `"opus"` | `/model` = tier `"frontier"` |
| Session reasoning effort | *(none seeded — see below)* | `/model_reasoning_effort` = `"high"` |
| Subagent reasoning effort | *(none seeded — see below)* | `/default_subagent_reasoning_effort` = `"medium"` |
| Delegation available at all | *(built in)* | `/features/multi_agent_v2` = `true` |
| Per-spawn model choice | *(built in)* | `/multi_agent_v2/expose_spawn_agent_model_overrides` = `true` |
| Approval policy | *(none seeded — see below)* | `/approval_policy` = `"on-request"`, `/approvals_reviewer` = `"auto_review"` |

`sandbox_mode` is deliberately never touched, on either host, per
`MODULES.md`.

### The two Codex keys that make delegation work at all

Both were established by running the real binary (0.149.1, Windows), not read
from documentation, and both replace an earlier guess that did nothing:

- **`features.multi_agent_v2 = true`.** Without it Codex exposes **no spawn
  tool whatsoever** — asked to list its own tools, a session reports `exec`,
  `apply_patch`, `exec_command`, `update_plan` and friends, and nothing that
  could delegate. With it, `collaboration.spawn_agent`, `wait_agent`,
  `send_message`, `followup_task`, `interrupt_agent` and `list_agents` appear.
  The flag ships `stable` but **off** upstream, so an install that does not
  set it leaves this module's whole premise unavailable on that host.
- **`multi_agent_v2.expose_spawn_agent_model_overrides = true`.** Without it
  the spawn payload carries `task_name`, `fork_turns`, `message` — and no
  model — and the subagent runs on the SESSION's model: both threads' rollout
  records show the same frontier id. With it, the payload carries `model`, and
  the subagent's own rollout records the requested tier instead. This is the
  difference between "delegation exists" and "delegation saves anything", and
  it is also what gives `subagent-model` a field to enforce against on this
  host.

**`agents.default_subagent_model` was removed, not moved.** It was seeded into
an `[agents]` section that does not exist in Codex's `ConfigToml` at all; the
real field sits at the top level, alongside `model` and `review_model`. But
moving it there changes nothing measurable either: with
`default_subagent_model = "gpt-5.6-luna"` set at the top level and the session
on `gpt-5.6-sol`, both the session's and the subagent's rollout records still
read `gpt-5.6-sol`. Rather than ship a key that reads as a guarantee and
provides none, tier selection is left where it is actually enforced — the
per-spawn `model` parameter above, checked by `subagent-model` on every spawn.

**`features.per_spawn_model_override` was removed outright.** No such flag
exists: `codex features list` enumerates every known feature on the installed
binary and does not contain it. It was an invented pointer, flagged as such in
this file's own earlier "judgement calls", and it was seeding a key nothing
ever read.

**`default_subagent_reasoning_effort = "medium"` is a floor, not a change.**
Measured: a session running at `low` already spawns subagents at `medium` —
Codex does not propagate a low session effort downward. Seeding it states the
floor explicitly rather than depending on a default that could move, and it
matches the same floor `reasoning-effort-floor` enforces on the other host.
Effort ABOVE the floor stays the orchestrating session's call, per task.

**Codex's model entry declares a `tier`, not a version-pinned `value`.**
Claude Code already resolves a bare tier alias itself (`/model = "opus"`), but
Codex has no such alias — the only ids it knows are fully versioned
(`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, and their display-cased
forms), so a new Codex release rotating those ids (`gpt-5.7-*`, `gpt-6.0-*`,
…) would silently strand a hard-coded `value` at the version this module
happened to ship with. `core/lib/codex-models.js#resolveModelForTier` turns
`tier` into a concrete id at install time instead: it scans the installed
Codex binary for the highest version carrying the requested tier, and falls
back to a small set of named constants (currently the `gpt-5.6-*` family)
only when the binary cannot be found, read, or scanned in time — always
reporting which of the two happened, never silently. A setting must declare
exactly one of `value` or `tier`; the installer refuses to guess when a
setting declares both or neither.

## Judgement calls made in this implementation

- **Claude Code seeds only `/model`.** The spec's own table lists Claude's
  reasoning effort and permission mode as `"auto"` — read here as "already
  the platform default, nothing to pin", by contrast with Codex, where the
  spec states explicitly *why* a seed is needed (`"left unset it falls back
  to … low"`). No equivalent problem is stated for Claude, so no key is
  invented to solve one. Claude Code also has no documented "default
  subagent model" setting distinct from the main model — subagent tiering
  is enforced entirely by `subagent-model` on each spawn, plus the prompt
  block's guidance to default routine work to the cheaper tier — so no
  pointer is written for it.
- **The Codex key names are now measured, not guessed.** They used to be a
  best effort — `MODULES.md` names `approval_policy` and `approvals_reviewer`
  in prose and nothing else, and the rest were taken from a worked example or
  invented. Every key in the table above has since been checked against the
  installed binary: enumerated through `codex features list` for the feature
  flags, and confirmed by behaviour for the rest (which tools a session is
  offered, what the spawn payload carries, what each thread's rollout record
  says its model and effort were). The two that turned out not to exist, and
  the one that exists but does nothing, were removed rather than relocated —
  see "The two Codex keys that make delegation work at all".
- **Nothing pins a default subagent TIER, on either host.** Not because it
  could not be written, but because it should not be: which of the two
  non-frontier tiers fits is a judgement the orchestrating session makes per
  task, from that task's own size and difficulty. A pinned default is exactly
  the "always the cheapest" behaviour this module is not asking for — it would
  send work that needs care to the cheap tier by default and make the
  balanced tier something a spawn has to remember to opt into. The tier is
  therefore chosen at every spawn, and `subagent-model` denies a spawn that
  names none.
- **`sandbox_mode` and `approval_policy` are not delegation settings.**
  `sandbox_mode` is never touched at all per `MODULES.md`. `approval_policy`
  is seeded because Codex's own approval surface is what a `PermissionRequest`
  hook would ever be able to reach; nothing in this module depends on it
  today.

## Turning it off

`softela-ai module disable agent-orchestration` deactivates both guards (a spawn
with no model, or with a low effort, is no longer blocked), removes the
"Delegation and model tier" section from the managed block, and unregisters
the reminder hook. Every `seed` setting above is left exactly as it is —
those became the developer's own the moment they were written, and disabling
the module says so rather than reverting them silently.
