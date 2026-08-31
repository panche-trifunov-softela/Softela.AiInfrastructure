# Rules for an AI coding agent

Status: Active — binding for new code, and enforced by guards in this
repository rather than left as documentation alone.

The other documents in this directory describe what the code should look
like. This one describes how an AI agent should behave while producing it —
a different, narrower question, and one worth answering explicitly, because
most of the team now writes code with agent assistance, and a convention
that only holds when a person is typing is not actually a convention.

## Why this needs to be explicit

An agent's failure mode is specific and predictable. Given too little
context, it produces something **plausible**: a utility that duplicates
one that already exists a few folders away, a call to an endpoint that
does not exist, a store field invented because the real one could not be
located, a convention guessed at from a file name. The output is
confidently, locally reasonable, and globally wrong — and an agent
produces a lot of it, quickly. Left unchecked, an agent will grow exactly
the problems the rest of this rulebook exists to remove, faster than a
person could review them away.

The fix is unglamorous: an agent follows a rule it can read and act on.
What it cannot do is infer an unwritten convention correctly, and it will
not reliably say "I don't know" instead of guessing unless that is the
explicit expectation.

## Analyse before writing

Read the surrounding code and the relevant standards before making a
change. A plausible-looking guess that does not match how the rest of the
codebase actually works is worse than pausing to check, because it looks
correct in review and fails later, somewhere the reviewer was not looking.

## Never invent a fact about the codebase

No invented endpoints, DTO or store fields, configuration keys, component
props, or file paths. If something cannot be found after a real search,
say so and ask, rather than filling the gap with something that looks
right. A stated gap costs a question; a fabricated one costs a debugging
session, and it costs it to whoever hits the mismatch later, not to the
agent that introduced it.

This includes reading the code as authority for what it currently
**does** — never inferring behaviour from a file's name, a comment, or
what a similar-looking file elsewhere happens to do.

## Reuse before writing new

The same mandatory-reuse rule that applies to any contributor in
[`principles.md`](./principles.md) applies to an agent, and matters more
for one: search the immediate location, the parent, the project's shared
folders, and any shared package, before adding a new helper, hook, type,
component or constant. An agent that is not explicitly told to search
first will not reliably do it on its own, because generating something new
is cheaper for the agent than finding something old — even when it is not
cheaper for the project.

## Retargeting the app to a local machine

Asked to point a running app at a developer's own machine — a different
API host, a different port — an agent edits the project's per-machine
configuration file, never the tracked one. See
[`local-dev-config.md`](./local-dev-config.md) for which file that is in a
project that has adopted the split, and why: the tracked file ships in
every build and reaches everyone who pulls the base branch, and a local
host committed there is exactly the mistake this rule exists to prevent.

An agent never stages or commits a tracked config file that names a local
host, whichever command does the staging — `git add` of the file
specifically, a blanket `git add -A`/`.`, or `git commit -a`. If a tracked
config file is already dirty with a local value for a reason unrelated to
the current change, that is worth surfacing to the developer rather than
committing around it.

## Delegation and model tier

Where an agent orchestrates other agents:

- **Analysis, architecture decisions and verification stay with the
  strongest model driving the session.** Routine, well-specified execution
  can be delegated to a cheaper or faster model, but deciding what is true
  about the codebase and what the right change is is never delegated —
  only the typing and mechanical execution of an already-made decision is.
- **A subagent is never silently escalated above the tier the current
  session itself is running at.** Every delegation states its model
  explicitly; there is no default that quietly inherits a stronger model
  than intended.
- **Escalating to a frontier-tier model for a subagent requires the
  developer's explicit approval for that specific task**, with a stated
  reason. An agent does not reach for the strongest available model on its
  own initiative just because a task looks hard.
- **A task's reasoning effort is never silently lowered** to finish
  faster; effort is raised for harder or higher-risk work, never dropped
  below the floor the infrastructure sets to save time.

## Never touch the agent-governance infrastructure to route around a rule

Hooks, guard configuration and settings that back this rulebook are not
something an agent edits or disables to get past a denial. A denial states
the fix; the fix is to follow the rule, not to find a way past the check
that would have caught the mistake.

## Report clearly

State what was reused versus what was written from scratch, what could
not be found, and any deliberate departure from a rule in this directory
and why. A report that only says "done" forces a reviewer to
reverse-engineer what the agent assumed; a report that names the
assumptions lets the reviewer check the one thing that actually needs
checking.

## What is enforced

- `reuse-before-new` can prompt when a change looks like a near-duplicate
  of existing code, backing the reuse-before-writing rule above.
- `subagent-model` checks that a delegated task states its model
  explicitly and does not exceed the session's own tier without approval.
- `reasoning-effort-floor` checks that a task is not dropped below the
  configured minimum reasoning effort.
- `infra-self-protection` guards the hooks, guard configuration and
  settings this rulebook is backed by, against being edited or disabled
  to bypass a denial.
