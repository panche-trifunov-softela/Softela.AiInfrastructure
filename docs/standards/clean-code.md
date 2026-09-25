# Clean code, in any language

Status: Active — a standing recommendation, deliberately not enforced by a
guard, with one exception noted below.

Everything else in this directory is about frontend structure, and most of it
is mechanical: a guard can tell whether a component lives in its own folder.
This document is the part that is not mechanical and applies everywhere —
frontend, backend, tooling, tests, a one-off script. It is the reasoning a
reviewer and an AI agent are expected to apply when no rule fires.

## Why this one is not a rule

Two reasons, both practical.

**The codebase is mid-migration.** Large parts of it predate this rulebook and
mix everything in one file. A guard strict enough to catch the mixing would
fire on ordinary work in those files, and a rule that mostly fires on code
nobody is allowed to fix yet teaches everyone to route around rules.

**Judgement does not survive a regex.** "One job" is a real distinction and a
cheap thing to argue about at the margin. A rule that guesses gets it wrong
loudly; a recommendation that is read gets it right most of the time and
costs nothing when it does not apply.

So this is written to be read, by a person and by an agent, not to be
enforced. The specific cases that *can* be judged mechanically already have
their own rules elsewhere — that is the split, not an oversight.

## The principles, by their usual names

They are named here explicitly because that is how they are recognised, and
an agent that has read the names applies them without needing this document
open.

**DRY — do not repeat yourself.** The same logic in three places is three
places to fix a bug and two chances to miss one. Reach for the existing
helper before writing a fourth copy; the rulebook's own reuse-first rule is
this principle with a search path attached.

Its limit matters as much as the principle: two pieces of code that look
alike but answer to different reasons are not duplication, and merging them
couples two things that will diverge. Duplication of *knowledge* is the
defect; duplication of *characters* sometimes is not.

**SOLID — single responsibility above all.** The whole set is worth knowing;
the first letter carries most of the value in day-to-day work. A unit should
have one reason to change. The practical test is the one
[`principles.md`](./principles.md) already states for the frontend and which
holds just as well for a C# service or a shell script: **if you cannot
describe what a file does without saying "and", it is probably more than one
part.**

**KISS — keep it simple.** The simplest thing that solves the problem in
front of you, not the general mechanism that would solve the problem's whole
family. Generality bought before it is needed is guessed, and a wrong guess
is more expensive to remove than the duplication it was meant to prevent.

## Separate the parts, at every level

The component-folder shape in
[`component-structure.md`](./component-structure.md) is one application of a
general idea: **types, behaviour, constants and presentation are different
jobs, and a file that holds several of them cannot be read, reviewed, reused
or tested one job at a time.**

The same reasoning applies outside a component folder — to a shared utility, a
root-level hook, a store, a set of constants, a backend service. It applies
*as guidance* there, not as the four-file shape:

- A shared utility that has grown its own vocabulary of types is usually two
  files: the types, and the functions that use them. Both stay importable
  from the same place.
- A store, a context or a root-level hook that carries real derivation logic
  gets that logic pulled out into something pure and testable beside it —
  [`shared-code-boundaries.md`](./shared-code-boundaries.md) covers the
  frontend shape of this in detail.
- A backend service class that has grown several unrelated responsibilities
  is several classes, or at minimum several clearly separated regions with
  the shared plumbing factored out.

**Do not read this as "reproduce the component folder everywhere".** It is
not that rule. The goal is that a part can be named, described in one
sentence, tested without instantiating everything around it, and moved
somewhere else — a sibling folder, a shared root, eventually a package — as a
file move rather than a rewrite. Where a smaller split achieves that, the
smaller split is the right one.

## Whitespace is part of readability

A reviewer reads code in blocks. Code written as one unbroken run of
statements makes them find the blocks themselves, every time, in every
review.

Separate the logical steps of a method with a blank line: the guard clauses,
the data the method gathers, the work it does, what it returns. Inside a
`try`, the same — setting up state, mutating it and saving it are three
steps, not one paragraph. This costs nothing and is the single cheapest
readability improvement available in a language with C-style braces.

```csharp
// Hard to scan: every step runs into the next.
var sourceDock = await GetDockAsync(sourceCode, cancellationToken);
var targetDock = await GetDockAsync(targetCode, cancellationToken);
var sourceRows = await _dbContext.DockRows.AsNoTracking().Where(x => x.DockCode == sourceCode).ToListAsync(cancellationToken);
var targetRows = await _dbContext.DockRows.Where(x => x.DockCode == targetCode).ToListAsync(cancellationToken);
targetDock.Layout = sourceDock.Layout;
_dbContext.Update(targetDock);
_dbContext.RemoveRange(targetRows);
await _dbContext.SaveChangesAsync(cancellationToken);
```

```csharp
// The same code, with its steps separated: what is read, what is changed,
// what is saved.
var sourceDock = await GetDockAsync(sourceCode, cancellationToken);
var targetDock = await GetDockAsync(targetCode, cancellationToken);

var sourceRows = await _dbContext.DockRows
    .AsNoTracking()
    .Where(x => x.DockCode == sourceCode)
    .ToListAsync(cancellationToken);

var targetRows = await _dbContext.DockRows
    .Where(x => x.DockCode == targetCode)
    .ToListAsync(cancellationToken);

targetDock.Layout = sourceDock.Layout;
_dbContext.Update(targetDock);
_dbContext.RemoveRange(targetRows);

await _dbContext.SaveChangesAsync(cancellationToken);
```

The same idea applies in TypeScript, and this is where most of the codebase
this rulebook governs actually lives:

```ts
// Hard to scan: a derived value, a ref and an effect run together, and two
// of the three span several lines.
const orderSummary = useOrderSummary(orderId);
const visibleItems = useMemo(
  () => items.filter((item) => item.orderId === orderId),
  [items, orderId],
);
const warnedRef = useRef(false);
useEffect(() => {
  if (orderSummary || warnedRef.current) return;
  warnedRef.current = true;
}, [orderSummary]);
```

```ts
// The same declarations, each separated from the next.
const orderSummary = useOrderSummary(orderId);

const visibleItems = useMemo(
  () => items.filter((item) => item.orderId === orderId),
  [items, orderId],
);

const warnedRef = useRef(false);

useEffect(() => {
  if (orderSummary || warnedRef.current) return;
  warnedRef.current = true;
}, [orderSummary]);
```

A run of single-line declarations of the same kind is the case this does not
cover, and it needs no separation — several `useState` calls one after
another read perfectly well, because each is one line and each says the same
kind of thing:

```ts
const [open, setOpen] = useState(false);
const [value, setValue] = useState("");
const [error, setError] = useState<Maybe<string>>(undefined);
```

Two things this is *not*: a blank line between every pair of statements,
which removes the signal along with the noise; and a reason to reformat a
file you are not otherwise changing.

This one case is narrow enough to be checked mechanically, and a guard now
does: a statement spanning more than one line gets a blank line separating
it from its neighbours, while a run of single-line declarations of the same
kind needs no separation between them. This does not contradict "Why this
one is not a rule" above — whether a statement spans one line or several is
a fact a guard can read directly off the code, unlike whether two files "do
one job," so the judgement problem that keeps the rest of this document
unenforced does not arise for this one, narrower case.

## Testing is the check on all of this

A part that is hard to test is almost always a part that does more than one
job — the difficulty is the diagnosis, not the obstacle. When a test has to
render a view to reach a calculation, or stand up a database to check a
mapping, the code is telling you which seam it wants.

That is also why this document is worth following without a guard behind it:
the payoff is not tidiness, it is that the next change is small, its blast
radius is visible, and a test can pin it.

## When you are refactoring existing code

The Boy Scout rule ([`README.md`](./README.md)) applies: improve what you
already have open, and do not start a wider refactor because this document
exists. But when you *are* deliberately refactoring something, do it
properly — a half-separated file, where some of the logic moved and some
stayed, is harder to reason about than the mixed file it came from, because
now there are two places to look and no rule about which holds what.

## What is enforced

- A guard checks the one case in "Whitespace is part of readability" above
  that is a fact about line count rather than about job separation: a
  multi-line statement is separated by a blank line from its neighbours; a
  run of single-line declarations of the same kind is not required to have
  one. Everything else in this document remains a review standard — see
  "Why this one is not a rule" above for why. The check covers
  `.ts`/`.tsx`/`.js`/`.jsx` source.
