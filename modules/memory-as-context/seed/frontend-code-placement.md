---
name: frontend-code-placement
description: Where code belongs in Softela.ReactSCExpert — generic goes to the global folders, feature-specific stays next to its feature; never pile everything into one file
metadata:
  type: project
  source: softela-ai
---

## Rule — code placement and decomposition

Standing rule for `Softela.ReactSCExpert`, given after reviewing app-component
field-mapping work.

**The split:**

- **Generic / reusable anywhere → the global infrastructure folders.**
  `src/hooks/`, `src/contexts/`, `src/store/`, `src/types/`, `src/utils/`.
  That is also where to LOOK for existing infrastructure before writing any —
  see [[frontend-utils-helpers]] and [[frontend-hooks]].
- **Task-, domain- or feature-specific → next to the component/hook it serves.**
  Do not promote something to a global folder just because it is new.

**`src/utils/helpers.tsx` is not a dumping ground.** It is a compatibility
barrel plus genuinely generic helpers. `src/utils/` already has one file per
domain or action group (`filterExpression`, `filterValue`, `gridUtils`,
`chartUtils`, `columnBuilder`, `mappingUtils`, `drillDown`…). Find the fitting
file; if none fits, **create a new one** rather than inflating `helpers.tsx`.

**Reusable constants go to `src/utils/constants.ts`** — regexes, operator sets,
lookup maps. A regex declared privately in a hook is invisible to everyone else
and gets re-invented.

**Decompose instead of accumulating.** The team's legacy pattern — one
component with everything mixed in, 2500+ lines — is hard to read, debug and
maintain. Split into hooks, helpers, constants, stores and contexts.

**Use the global type aliases** from `src/types/global.d.ts`: `Maybe<T>`,
`Nullable<T>`, `Undefined<T>`. Never hand-write `X | null | undefined`.

**Never log to the console directly in shipped code paths.** Dev logging goes
through `devConsole` in `src/utils/devLogger.ts` — a `Proxy` typed as `Console`
that mirrors the whole console API (`warn`, `table`, `group`, anything a browser
adds later) and gates every call on `isDevLoggingEnabled()`: `import.meta.env.DEV`
plus an `ENABLE_DEV_LOGS` switch reserved for `public/config.js` (omitted or
`true` = on, explicit `false` = silent; production is always silent). A first
version that hand-wrote one wrapper per console method was rejected —
**do not add per-method wrappers**, the proxy needs no maintenance. A production
console full of debug output is unprofessional and can leak information about
the system.

**Why:** whoever maintains this after the original author is gone has to read,
debug and extend it. Code buried in the wrong file is code nobody finds — so it
gets duplicated, and the duplicate drifts. This is the same reasoning behind
[[code-documentation-style]]: the compiler never complains about bad structure,
so only a written rule holds it.

**How to apply:** before writing a helper, constant, type or hook, ask whether
anything outside the current feature could use it. If yes, it goes global — and
check first that it does not already exist there. If no, keep it local. Bake
this into every subagent prompt that writes frontend code; a fresh subagent
defaults to appending to whatever file it already has open.
