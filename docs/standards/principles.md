# Principles

Status: Active — binding for new code.

Everything else in this rulebook is an application of a small number of
ideas. When a rule elsewhere seems to conflict with a specific situation,
come back here first — the specific rule is almost always a consequence of
one of these, and understanding why usually resolves the conflict.

## 1. Build small, composable units

A component, a hook or a utility is rarely used only once, in only the
place its author had in mind. It gets reused in combinations nobody
enumerated in advance, next to code its author never saw. That raises the
bar: a unit that only works in its original context is a liability the
moment it is reused, because the second caller inherits every assumption
the first one silently made.

The practical test: **a part you can name, describe in one sentence and
test on its own is a part that survives being placed somewhere
unexpected.** If you cannot describe what a file does without "and", it is
probably more than one part.

## 2. One file, one job

Rendering, business logic, types, constants and utilities are different
jobs. When they share a file they cannot be read, reviewed, reused or
tested separately — a reviewer has to hold the whole file in their head to
understand any one part of it, and a test for the business logic has to
mount the rendering to reach it.

This is the principle behind the component-folder shape in
[`component-structure.md`](./component-structure.md) and the layer split in
[`layer-boundaries.md`](./layer-boundaries.md): those documents are this
idea applied consistently, not a separate rule.

## 3. The folder mirrors the root

A component's own folder uses the same vocabulary as the project
root — `components/`, `hooks/`, `types/`, `utils/`, a constants file. Learn
the layout once and it holds at every depth, whether you are looking at the
whole project or a single component three levels deep.

This is what makes promoting something cheap: moving a utility from a
component's own `utils/` to the parent's, or to the project root, is a file
move and an import update, not a rewrite, because the destination already
has the same shape as the source.

## 4. Reuse is mandatory, not a style choice

**Before writing a new helper, hook, type, service or constant, look for
what already exists and extend it.** Search the immediate folder, the
parent, the project's shared locations, and any shared package the project
depends on, in that order, before writing anything new.

Reinventing something the project already has is a defect, not a matter of
taste: a fourth `formatDate` or a third confirm-dialog controller is a
permanent tax on everyone who has to figure out which one is the real one,
and it is a tax nobody agreed to pay. Finding the existing one costs a
search; adding a duplicate costs every future reader.

This applies as much to an AI agent as to a person — see
[`agent-rules.md`](./agent-rules.md).

**A well-formed unit is usually close to extractable, and that is worth
building toward on purpose.** A component folder built the way
[`component-structure.md`](./component-structure.md) describes — view,
logic, types, constants and utilities behind a single declared entry
point — is most of the way to being publishable into a shared package as it
stands. A candidate is genuinely generic when it has no import from a
project-specific store, no project-specific type, no assumption baked in
about one particular screen, and a public surface already expressed in its
own barrel; something that meets those tests is worth proposing for
extraction rather than copying into the next place that needs it.

Where it costs nothing to do so, **build a reusable piece product-agnostic
from the start**: take a label as a prop instead of reading it from a
project's own translation store, take a callback instead of calling a
project's own API layer directly. Neither costs anything the day it is
written, and both are what let the same piece move to a shared package
later without a rewrite.

## 5. Promote on the second consumer, not the second guess

Code with exactly one consumer lives inside that consumer's own folder,
where it can be found, changed and deleted along with it. It moves up —
one level, to the parent, to the project root, to a shared package — only
when a second, real consumer needs it.

Moving something up "because it looks generic" produces a shared folder
full of single-use code, which is the same problem as an oversized file,
just spread across more locations. The trigger is a real second caller, not
a guess about future reuse.

## 6. Structure serves testing

Most of what is hard to test is hard because logic and rendering are welded
together — the only available test is to mount the whole screen and
interact with it, which is slow, brittle, and fails for reasons unrelated
to what it is meant to assert.

Split the two apart and the logic becomes a plain function or a hook,
testable without mounting anything. This is why
[`layer-boundaries.md`](./layer-boundaries.md) insists on the split even
where it looks like extra ceremony for a small component: the payoff is
not visible in that one component, it is visible in how cheap its test
turns out to be.

## What is enforced

- Reuse-before-writing (principle 4) is backed by the `reuse-before-new`
  guard rule, which can prompt when a change introduces something that
  looks like a near-duplicate of an existing helper, hook or type.
- The remaining principles are design philosophy: they are not
  independently guard-enforced. They surface as concrete, checkable rules
  in the other documents in this directory, and enforcement is described
  there.
