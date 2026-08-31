# Repository traps — Softela.ReactSCExpert

Things that look fine, waste a day, and are specific to this repository.
Generic advice belongs in `docs/standards/`; this file is only what is true
because of how this particular codebase and its tooling are set up.

## `tsc --noEmit` with no project flag is a silent no-op

**What looks fine:** running `npx tsc --noEmit` at the repository root to
check for type errors before handing work over.

**What actually happens:** it always exits `0`, even on a codebase full of
errors. The root `tsconfig.json` here is a solution file with `"files": []`
— there is nothing in it for `tsc` to check, so it reports success on
whatever the codebase currently contains, including a broken build.

**What to do instead:** use `npx tsc -b`, or run `--noEmit -p` against each
real project file individually (`tsconfig.app.json`, `tsconfig.node.json`,
or whichever project files exist). Both actually type-check something.

**Guard:** `typecheck-invocation`.

## Dependencies only install cleanly with `--force`

**What looks fine:** `npm install` or `npm i`.

**What actually happens:** peer dependency conflicts in this tree break a
plain install partway through, leaving `node_modules` in an inconsistent
state that then produces confusing downstream errors that look unrelated to
the install itself.

**What to do instead:** `npm i --force`.

**Guard:** `package-install-flags`.

## Cypress is not a verification signal for frontend work

**What looks fine:** running the Cypress suite under `cypress/e2e/**` to
confirm a change did not break anything, or including it in a report of what
was verified.

**What actually happens:** `cypress/e2e/**` is owned and maintained by the
QA team, not by whoever is doing frontend development work here. Running it,
changing it, or reporting its pass/fail as a signal for a code change is out
of scope — it is neither yours to run nor yours to keep green.

**What to do instead:** use the unit test runner (`npx vitest run`) as the
actual verification signal. Leave Cypress files alone even when they appear
in an incoming diff.

**Guard:** `forbidden-commands`.

## Never symlink or copy `node_modules` into a Windows worktree

**What looks fine:** symlinking or copying an existing `node_modules` into a
freshly created worktree to skip a slow install.

**What actually happens:** on Windows, this has previously destroyed
`node_modules/.bin` in the *main* checkout — the damage is not contained to
the worktree that was set up carelessly.

**What to do instead:** run a fresh `npm i --force` inside the worktree,
same as any other checkout. There is no shortcut here that is actually
faster once the cleanup is counted.

## `public/config.js` carries a switch that must never be committed as `true`

**What looks fine:** `public/config.js` is tracked, and defines
`const USE_LOCAL_API = false;` with a comment reading "local development
only — do not commit this as true". Flipping it to `true` is how the app is
pointed at a local BFF during development.

**What actually happens:** the only thing stopping that flip from reaching a
commit is the developer remembering to flip it back. The same file also
defines its local origins as named constants that are present even when the
switch is off, so their presence in the file is not itself a signal that
anything is wrong — only the boolean's value is.

**What to do instead:** leave the flip uncommitted, and check the file
before staging. This repository has **not** adopted the per-machine config
file split that `Softela.ReactRDT` uses — see
`docs/standards/local-dev-config.md` for that split and its rationale.
Adopting it here is a change to this repository's own build, not something
this infrastructure can do for it.

**Guard:** `local-config-isolation`, configured to `ask` for this
repository, on a write that flips the switch and on a stage or commit that
would carry it.
