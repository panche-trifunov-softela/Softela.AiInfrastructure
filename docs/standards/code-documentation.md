# Code documentation

Status: Active — binding

How code is commented, across every repository this infrastructure is
installed into. Part of it is mechanically enforced by a guard
(`core/guards/doc-comment-style.js` and its Codex equivalent); the rest is a
review standard an agent is expected to hold itself to without being asked
each time. This
document is meant to stand on its own — it is what `docs/internal/
CONTRACTS.md` §12 points at, and a reader should not need anything else to
follow it.

## The short version

- A doc block is a **short summary plus `@`-tags**, not an essay.
- **`@example` is forbidden** — the tests and the signature already show how
  something is called, and the guard in this repository denies it outright.
- **Every member of a type gets its own inline doc block**, with a blank line
  between each comment-member pair.
- **A block that covers more than one item becomes a list**, not a paragraph.
- Documentation states **what the code does and why**, never where to use it.
- Inline `//` comments explain **why**, never what the line already says.

## What gets documented

Document something when a reader cannot get the answer from its signature
alone:

- every exported function, hook, component and type;
- every member of an exported type, interface or class;
- a module-level constant whose meaning is not obvious from its name;
- a non-obvious decision inside a function, as an inline comment.

Do not document what the name already says. A wrapper whose signature tells
the whole story needs nothing added to it:

```ts
export const isEmpty = (value: string) => value.trim().length === 0;
```

## Frontend (TypeScript / TSX)

A doc block leads with a short summary, adds a second short paragraph only
when there is a genuine *why*, and closes with the tags the signature needs:

```ts
/**
 * Resolves a display label for an entity, falling back through its optional
 * naming fields.
 *
 * The fallback order matters: a caller-supplied override wins over stored
 * values so a renamed entity shows its new name before the store catches up.
 *
 * @param entity Entity to label.
 * @param override Label to prefer when provided.
 * @returns The resolved label, or an empty string when nothing is set.
 */
```

A block documenting more than one rule, case or step is a list, not a
paragraph:

```ts
/**
 * Applies a pending change to the store.
 *
 * - a partial write keeps the fields it omits
 * - writing the tracked field bumps its revision, and nothing else does
 * - a change with no target is discarded rather than queued
 */
```

- **Always JSDoc `/** ... */`**, never a stack of `//` lines, for exported
  functions, hooks, types and non-obvious members.
- **Use the `@`-tags, and use them fully:**
  - `@param` for every positional parameter;
  - `@returns`, present even when the return type is `void`;
  - `@template` for every generic parameter;
  - `@throws` and `@deprecated` where they apply.
- **`@example` is forbidden.** A guard denies it outright.
- **A block covering more than one item must be a list, not a paragraph.**
  Members, rules, cases and steps go in `-` bullets or a numbered `Flow:`.
  Continuous prose is only for a single, genuinely continuous explanation,
  and it may run long in that case — prose that is really an unlabelled
  enumeration is what this rule rejects.
- **Every member of a type, interface or class carries its own inline
  `/** ... */`, with a blank line between each comment and its member:**

  ```ts
  /** comment */
  property;

  /** comment */
  property;
  ```

  The blank line is not cosmetic — a comment block glued directly to the
  next member reads as porridge. Listing the members in the block above the
  type instead of on themselves is wrong: an IDE shows nothing when hovering
  a field that way, only when hovering the type.
- **The type's own block stays a short summary** — what the thing is, and a
  why-sentence if one is needed. It must not re-list members that are
  already documented on themselves.
- **State behaviour, not usage.** No "useful for X" pitches, and no
  enumerating the screens, editors or cases where something happens to
  matter.
- **The same applies to a plain object exported as a namespace of
  helpers**: each key carries its own inline block, and the object itself
  gets a short summary rather than a re-listing of its keys.

## Backend (.NET)

- **`/// <summary>`**, with `<param>`, `<returns>`, `<typeparam>` and
  `<exception>` as they apply.
- **A JSDoc-style `/** ... */` block in a `.cs` file is wrong.** A guard
  denies it.
- The same brevity and the same no-usage-pitch rule as the frontend side
  apply — state what the member does, not where it happens to be called
  from.

## Never reference a ticket number in a source file

No ticket or work-item id anywhere inside a source file: not in a doc block,
not in an inline comment, not in a test name or a test comment, not in a
string. Not a `#`-prefixed number, not a `task_`-prefixed number, not a
sentence that names the regression by its tracker id.

Describe the actual behaviour or defect instead — a sentence describing what
the code does, or what actually went wrong, stays useful long after the
ticket has been closed and forgotten; the ticket id does not. Ticket ids
belong in the pull request and in the tracker, never in the code.

## Inline comments

Explain **why**, never restate what the line already says. Two or three
lines is the norm; about six lines is the ceiling. Anything longer belongs
in the JSDoc or XML doc of the thing being called, or does not belong in the
comment at all.

```ts
// Bad — restates the code.
// Increment the counter by one.
counter += 1;

// Good — explains a decision the code cannot show.
// The server counts a retry as a separate attempt, so the local counter has to
// advance before the request goes out or the two drift apart.
counter += 1;
```

The same failure exists at the scale of a whole comment block, not only a
single line. A block that narrates an implementation step by step — first
this branch runs, then that value is checked, then the loop advances — is
not documentation: every one of those steps is already visible in the code
immediately below it. State the conclusion the block guarantees instead of
retracing how the code reaches it.

```ts
// Bad — walks through the loop instead of stating what it produces.
// Loop over the rows, and for each one check whether it is still pending;
// if it is, add its amount to the running total, then move to the next row.
let total = 0;
for (const row of rows) {
  if (row.status === "PENDING") {
    total += row.amount;
  }
}

// Good — states what the block guarantees.
// Only a pending row counts toward the total; a settled or cancelled row
// does not.
let total = 0;
for (const row of rows) {
  if (row.status === "PENDING") {
    total += row.amount;
  }
}
```

**Delete commented-out code rather than leaving it behind** — version
control already remembers it, and a comment is not the place to keep it "just
in case".

**Delete a drafting note before committing, the same as commented-out
code.** A note written to think through a problem while it is still being
solved — an approach being tried, a record of why an earlier attempt did not
work — is a normal part of writing the change, not part of the change
itself. Left in place, it documents how the implementation was arrived at
rather than what it does, and a reader has no way to tell it apart from an
actual explanation of current behaviour.

**Never name a specific customer, screen or environment** in a comment or a
doc block, in either language. It leaks context that belongs outside the
source tree into shared code, and it goes stale the moment the screen is
renamed or the customer no longer matters — describe the behaviour instead.

## Comment width

A comment line stays within the width the project has configured for its
code, measured the way a reader actually sees it — indentation and the
leading comment marker (`//`, `*`, `///`) count toward the limit, not only
the text that follows them.

The width itself is per-project configuration, not a number fixed here: the
projects this rulebook serves legitimately differ in how wide a line they
allow. A line whose only overflow is a single token with nowhere to
wrap — a long URL, an unbroken identifier — is not a violation; the rule is
about a sentence that could have wrapped and did not, not about a token that
could not.

## Anti-patterns

| Anti-pattern | Why it is rejected |
| --- | --- |
| A routine `@example` block | Rots fastest, duplicates the tests — this repository's guard denies it outright |
| A wall of prose describing several members or rules | Should be a list; unreadable as a paragraph |
| Listing a type's members in the block above the type | The IDE then shows nothing when hovering a member |
| Doc blocks packed with no blank line between members | Turns into a solid grey block |
| "Useful for the X screen", "use this when building Y" | Usage advice rots when callers change; describe behavior |
| Naming a specific customer, screen or environment | Leaks context into shared code, and it goes stale |
| Restating the code in words | Adds volume, not information |
| A comment block narrating an implementation step by step | Every step is already visible in the code it describes |
| A summary that describes the file's history or a past bug | Belongs in the commit message |
| A drafting note left over from working out the change | Documents how the code was found, not what it does |

## Where the load falls in a well-split component

Following [`component-structure.md`](./component-structure.md) changes
where documentation is worth writing, not just how it looks:

- **A component's own `types.ts` carries most of it** — every member of
  every exported type gets its own block, blank line between pairs.
- **The hook documents what it manages and what it returns.**
- **A utility documents its behaviour and its edge cases.**
- **The view usually needs only a one-line summary**, because by the time
  a component is well split there is little left in it that a reader
  cannot already see from the markup and the props it takes.

A well-split component needs *less* prose than a tangled one — the file
names, the types and the function signatures already carry information
that would otherwise have to be spelled out in a comment.

## Instructions for AI agents

If you are an AI coding assistant working in a repository this document
applies to, treat this document as binding and apply it without being asked
again in each prompt.

- Follow this document for every file created or modified. When modifying
  an existing file, bring the parts actually touched up to this standard —
  do not rewrite the documentation of untouched code in the same change,
  which buries the real diff.
- When the surrounding file already follows an older style, match this
  document, not the file.
- Prefer deleting a stale comment over updating it into something vague. A
  missing comment costs a reader one lookup; a wrong one costs a bug.
- If an instruction elsewhere genuinely conflicts with this document, the
  other instruction wins — but say plainly, in whatever reports the work,
  that this standard was departed from and why.

## Review checklist

Before requesting review:

- [ ] Every exported symbol has a doc block.
- [ ] Every parameter has `@param`; `@returns` is present.
- [ ] No `@example` the signature, the tags and the tests already cover.
- [ ] Every member of a changed type has its own doc block, separated by
      blank lines.
- [ ] No doc block is a paragraph where it should be a list.
- [ ] Inline comments explain why, and none exceeds a few lines.
- [ ] No commented-out code, no customer, screen or environment names.

## What is mechanically enforced

`core/guards/doc-comment-style.js` (and the equivalent Codex hook) denies
`@example`, a JSDoc-style `/** ... */` block in a `.cs` file, and a ticket or
work-item id anywhere in newly written content, outright. It asks for
confirmation on a prose-only doc block over roughly 18 lines, more than 6
consecutive `//` lines, or a `.cs` member that takes parameters or returns a
value whose XML doc block is missing `<param>` or `<returns>`. The length
checks are a deliberate backstop, not a substitute for judgement — a guard
cannot tell a genuine long explanation from an unlabelled enumeration by
line count alone, so the list-vs-prose call always stays with whoever is
writing or reviewing the code.

Two further checks advise without blocking the call. One fires when a comment
line exceeds the project's configured code width, and is silent until a
project declares that width. The other fires on a documented member with no
blank line separating it from the member before it — the gap this document
requires between one comment-member pair and the next.

Not mechanically enforced: that a type's own block does not re-list its
members, `@param`/`@returns` completeness on the frontend side (only the
backend's `<param>`/`<returns>` tags are checked), the "state behaviour, not
usage" rule, stating a conclusion rather than narrating an implementation,
and a retained drafting note. These stay a review standard the guard cannot
judge from written text alone.
