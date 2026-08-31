---
name: code-documentation-style
description: HARD RULES for code docs and comments — frontend JSDoc with @-tags but never @example, backend XML summary, tight prose, no walls of text
metadata:
  type: project
  source: softela-ai
---

# The documentation standard (developer-authored, binding)

Everything here is agreed, developer-set standard: code in either repo that violates it is code to fix, never evidence that the standard moved. Only the developer changes what is written here.

**These are hard rules, not preferences.** Treat a violation as a defect, not a style nit. They apply to code an agent writes AND to every subagent prompt it authors — bake them in verbatim.

## Frontend (TS/TSX) — JSDoc

- **Always JSDoc `/** … */`**, never a stack of `//` lines, for exported functions, hooks, types and non-obvious members.
- **Use `@`-tags and use them fully**: `@param`, `@returns`, `@template` for every generic, `@throws`, `@deprecated`. Every positional parameter gets a tag; `@returns` is present even when it is `void`.
- **Never `@example`.**
- **The moment a block covers more than one item, it becomes a list.** Members, rules, cases, steps — enumerate them as `-` bullets or a numbered `Flow:`. Prose is only for a single continuous explanation, and then it may run long: the longest prose-only block observed in this codebase is 11 lines and is correct. Prose that is really an unlabelled enumeration is the "canvas of text" the developer rejects.
- **Every member of a type, interface or class carries its OWN inline `/** … */`, separated by a blank line:**

  ```ts
  /** comment */
  property;

  /** comment */
  property;
  ```

  The blank line is the whole point — comment-property-comment-property with no breathing room is the "porridge" the developer objects to. Listing the members in the block above the type instead is **wrong**: the IDE then shows nothing when hovering a field, only when hovering the type, and that is worse to work with. This has been tried and rejected before; do not propose it again.
- **The type's own block stays a short summary** — what the thing is, plus a why-sentence if one is needed. The members are already documented on themselves, so it must not re-list them.
- **State behavior, not usage.** Never enumerate screens/editors/cases where it matters, never "useful for X" pitches, never name a real customer screen.

**Exemplars worth reading before documenting anything non-trivial**, all in `Softela.ReactSCExpert`: `src/hooks/useAsyncMethodWrapper.ts` (per-field option docs, `@template`, bulleted feature list), `src/hooks/useFetchInterval.ts` (`@template` + `@param` + numbered `Flow:`), `src/contexts/EditorsContext.tsx` (one-line doc per context field), `src/hooks/useNonceGuardedEffect.ts` (the compact case).

## Backend (.NET) — XML doc comments

`/// <summary>` … `</summary>` with `<param>`, `<returns>`, `<typeparam>`, `<exception>`. Same brevity and same no-usage-pitch rule. Never a JSDoc-style `/** */` block in C#.

## Never reference a ticket number in code

**No ticket/work-item id anywhere inside a source file** — not in a JSDoc or XML doc block, not in an inline comment, not in a test name or a test comment, not in a string. No `#12345`, no `task_12345`, no "the 12345 regression". State the behavior or the defect itself instead: *"the authored SQL projects a literal alias over a real column, so filtering the projection matched nothing"*, not *"the #12345 regression"*.

Ticket ids belong in the PR and in the tracker, and in this knowledge base — never in the code.

**Why:** a ticket id ages into noise. Six months on, the reader has no access to what it meant, the tracker may have moved, and the number explains nothing about the code in front of them. A sentence describing the actual defect stays useful forever.

**How to apply:** when tempted to write "the #NNNNN regression", write the one-line description of the failure mode instead. Bake this into every subagent prompt alongside the rest of this file, and grep the diff for `#[0-9]{4,}|task[_ ]?[0-9]{4,}` before handing work over.

## Inline comments

Explain **why**, never what the line already says. Two or three lines is the norm and about six is the ceiling seen in this codebase (the rationale blocks in `EditorsContext.tsx`); past that it belongs in the JSDoc of the thing being called, or nowhere.

**Why:** docs that state behavior crisply stay true. Where-and-why-to-use prose rots the moment a caller changes, and long blocks push the reader away from the code instead of into it.

Partly enforced mechanically: a shared documentation guard denies `@example` and JSDoc-style blocks in `.cs`, and asks on oversized comment blocks.
