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

This module ships prompt text only. A hook that blocked, say, the first
`Write`/`Edit` of a session to force a "did you read first?" checkpoint would
not actually verify that any reading happened — it would only prove that a
tool call came late enough in the transcript, which an agent can satisfy by
issuing a throwaway read it never looks at. That is theatre: it adds friction
without adding the property it claims to enforce. Whether a request was
genuinely understood before it was acted on is a judgement call, not
something a `PreToolUse` hook can observe from tool names and file paths
alone. This module says so plainly instead of shipping a hook that only looks
like it is doing the job.

## Files

None of its own. `module.json` and this `README.md` are the only files this
module ships — there is no `prompt.md`, no hook, and no setting; enabling and
disabling it only flips whether `core/installer/rulebook.js` includes the
section named above.

## Turning it off

`softela-ai module disable analyze-first` removes that section from the managed
block. Nothing else to undo — the module owns no hooks, no settings, and no
files of its own.
