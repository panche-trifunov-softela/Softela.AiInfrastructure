# analyze-first

Default: **on**.

Investigate, plan, confirm, then build. This module ships no prompt text of
its own — enabling it switches on the "Analyse first, then wait" section of
the base rulebook every install already carries
(`core/installer/rulebook.js#buildAnalyzeFirstSection`,
`core/installer/plan.js#planGlobalInstructions`), which tells the agent to
read before writing, to state assumptions in the open, to ask instead of
silently picking when two readings of a request would produce materially
different work, and — the part a bare "investigate, then build" instruction
leaves implicit — to wait for the developer's explicit go-ahead on a stated
plan before building it. Disabling the module removes that section from the
managed block entirely; it does not fall back to a duller version of the
same instruction living somewhere else.

## Why there is no guard

A hook that blocked, say, the first `Write`/`Edit` of a session to force a
"did you read first?" checkpoint would not actually verify that any reading
happened — it would only prove that a tool call came late enough in the
transcript, which an agent can satisfy by issuing a throwaway read it never
looks at. That is theatre: it adds friction without adding the property it
claims to enforce. Whether a request was genuinely understood before it was
acted on is a judgement call, not something a `PreToolUse` hook can observe
from tool names and file paths alone. This module says so plainly instead of
shipping a blocking hook that only looks like it is doing the job — the
reminder hook it does ship, below, never blocks anything.

## The reminder hook

`hooks/inject-plan-gate.js` is a `UserPromptSubmit` reminder, registered for
both agents, that re-states the "analyse first, then wait" gate next to every
developer prompt instead of relying solely on the rulebook section injected
once at session start — in a long session that block ends up buried under
everything that followed, and is no longer as close to the request as the
request itself. It prints only `hookSpecificOutput.additionalContext` — the
developer never sees it, unlike the base rulebook text they can read in their
own `CLAUDE.md`/`AGENTS.md` — and it never blocks, rewrites, or fails a turn:
unparseable stdin, a non-object payload, or a subagent's own prompt event
(`agent_id`/`agent_type` present) all exit silently. `agent-orchestration`'s
own `inject-delegation-mode.js` is the sibling hook doing the same thing for
the delegation rule; see that module's README.

## Files

`module.json`, this `README.md`, and the reminder hook's two scripts
(`hooks/inject-plan-gate.js` and its `core/lib` resolution shim
`hooks/analyze-first-core-lib.js`) are the only files this module ships —
there is no `prompt.md` and no setting; enabling and disabling it flips
whether `core/installer/rulebook.js` includes the section named above, and
whether the reminder hook is registered.

## Turning it off

`softela-ai module disable analyze-first` removes that section from the managed
block and unregisters the reminder hook. Nothing else to undo — the module
owns no guard, no settings, and no other files of its own.
