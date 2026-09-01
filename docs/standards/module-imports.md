# Module imports

Status: Active — binding for new code.

[`component-structure.md`](./component-structure.md) says what a folder
contains and [`layer-boundaries.md`](./layer-boundaries.md) says which layer
may depend on which. This document covers the line that actually expresses
both of those in the source: the import statement.

It is the most-written line in a frontend codebase and the least thought
about, and it decides two things the rest of the rulebook depends on —
whether a folder can be moved, and whether a reader can tell what a file
depends on without opening it.

## Import a folder through its barrel, not through its files

A component folder's `index` file is its public surface. Everything else in
it is private, and the import statement is where that is either honoured or
quietly ignored:

```ts
// GOOD — the folder's own barrel; the folder stays free to rearrange inside.
import { OrderRow } from "@/components/OrderPanel";

// BAD — reaching past the barrel into the folder's internals.
import { OrderRow } from "@/components/OrderPanel/components/OrderRow/OrderRow";
```

The second form makes every internal file a de facto public API. The folder
can no longer rename a child, move it a level down, or fold two of them
together without breaking a caller that was never supposed to know either
file existed.

The corollary is that a folder publishing nothing through its barrel is not
importable at all, which is the point: **add the export deliberately when
something is genuinely part of the surface**, rather than reaching around a
missing one.

## Do not climb out of the folder — use the project's path alias

```ts
// BAD — this specifier names nothing a reader can place.
import { getPestTypes } from "../../../../utils/storage";

// GOOD
import { getPestTypes } from "@/utils/storage";
```

Three separate costs, and the third is the one that matters most here:

- **It cannot be read.** Counting `../` against a mental model of the tree is
  work, and the answer changes with the importing file's own depth. The same
  module is `../../utils/storage` from one file and `../../../../` from
  another.
- **It silently retargets.** Move either file one level and the specifier
  still resolves — to something else, or to a build error at a distance from
  the change that caused it.
- **It welds the folder in place.** A component folder is supposed to be
  movable, extractable and deletable as a unit — that is what
  [`component-structure.md`](./component-structure.md) builds it for. A
  folder whose files climb four levels out cannot be moved without rewriting
  every one of them, so in practice it never is.

**One or two levels is ordinary composition** — a child component reaching
its parent's `utils/`, a view reaching the folder above it. Three is where
the specifier has left the feature it was written in, and from there the
count only ever grows.

### The alias has to exist first

An alias is a project-level decision, not a per-file one: it needs a
`resolve.alias` entry (or the bundler's equivalent), a matching
`paths` entry in `tsconfig.json` / `jsconfig.json` so the editor resolves it,
and then it needs to be declared to this rulebook as
`conventions.pathAliases`.

**A project that has not set one up is not asked to write aliased imports** —
there would be nothing for them to resolve to. The rule below stays silent
until the project declares the alias, and declaring it is the change that
switches the rule on. Setting up a single `@` → source-root alias is a small,
mechanical, behaviour-preserving change, and it is worth doing before a tree
gets deep rather than after.

Where more than one alias is declared, use the most specific one that
covers the target — `@components/Common/Table` says more than
`@/components/Common/Table` does.

## Keep the import list itself honest

- **No unused imports.** They are dead weight that survives because nothing
  fails, and they make the dependency list a worse answer to "what does this
  file actually need" every time one accumulates.
- **A type-only import says so** where the language has the form
  (`import type { … }`), so it is erased at build time and cannot be mistaken
  for a runtime dependency.
- **Do not import a module purely for its side effects** from a component or
  a hook. A module that has to run has an entry point that runs it; an import
  whose only purpose is to be evaluated makes load order load-bearing and
  invisible.

## What is enforced

- `import-depth` denies a new file's specifier that climbs at least
  `limits.relativeImportDepth` folders (default 3) and resolves under a
  declared `conventions.pathAliases` root, naming the aliased form as the
  fix. Silent for a project that declares no alias, and silent when the
  target sits under no declared root — a fix it cannot state exactly is a fix
  it does not offer.
- `api-import-boundary` denies a component importing the API layer directly
  (see [`layer-boundaries.md`](./layer-boundaries.md)), resolving aliased
  specifiers through the same `conventions.pathAliases`.
- `barrel-exports-only` keeps the barrel a barrel, in every module extension
  a project writes one in.
- Nothing enforces "import through the barrel, not around it", or the
  import-hygiene points above; those are review-enforced, guided by this
  document, and a linter is the natural home for the unused-import half.
