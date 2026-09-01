# Open decisions

**Nothing in this file is a rule.** These are questions that are not settled.
An agent must not enforce, assume, or silently pick a side on any of them — if
a task depends on one being decided, say so and ask.

A question that gets answered is removed from this file and written up in
`docs/standards/` (or a project's own docs) with a `Status:` line. It is not
marked "resolved" and left here, so this file only ever lists what is still
open.

## Styling strategy

A co-located stylesheet per component folder, the UI framework's own inline
style mechanism, global stylesheets, or a deliberate mix?

- No project here has measured its own current split, so any rule would be
  written against a guess.
- Where a previous attempt to move styles into co-located files has been
  made, it has tended to be refactored back into shared theme files — worth
  understanding before repeating it.
- Conditional styles, and values computed at runtime (sizes and positions
  derived from state), are the boundary case any rule has to account for:
  they gain nothing from being forced into a stylesheet.

## Machine-specific configuration on the backend

`Softela.PestManagement` tracks `appsettings.Development.json`, so a
developer's own local connection string or port lands in a file everyone
else pulls — the same failure the frontend's tracked/per-machine
split was adopted to prevent, unaddressed on the backend.

- Whether the backend adopts an equivalent per-machine file at all is open.
- .NET's own `appsettings.Development.json` convention is to be shared and
  tracked, which cuts against simply repeating the frontend's split.
- No rule enforces anything here today; this is only a question, not a gap
  with a plan.

## A path alias for `Softela.Bugworx`

`react-app/vite.config.js` declares no `resolve.alias`, so every cross-folder
import is relative and 428 of them climb four or more levels. Adding a single
`@` → `react-app/src` alias would make those readable and would let a
component folder move without rewriting its imports.

- The change itself is mechanical and behaviour-preserving: a `resolve.alias`
  entry, a matching `jsconfig.json` for the editor, then
  `conventions.pathAliases` in `projects/Softela.Bugworx.json`.
- What is not decided is whether existing imports are rewritten at all, or
  only new ones — a sweep across 428 call sites is a large, conflict-prone
  diff for a cosmetic gain, and the same argument the naming standard makes
  against rename sweeps applies.
- **The `import-depth` rule stays inert until the alias exists**, deliberately:
  a fix naming an alias the bundler cannot resolve would be worse than no
  rule. Declaring the alias in the project config is what switches it on, so
  this decision and the rule's activation are the same act.

## Test infrastructure for `Softela.Bugworx`

There are zero spec files, no test script, and no test runner — while the CI
workflow runs `npm run test --if-present` and passes.

- Nothing here is a gap with an agreed plan; it is a question of whether the
  project takes on a runner (Vitest is the obvious fit alongside Vite) and
  when.
- Until it does, `colocated-tests` has nothing to check and no coverage
  expectation applies. The verification story is `npm run build` and
  `npm run lint` — see `docs/projects/Softela.Bugworx/README.md`.
- The same is true of `Softela.PestManagement`, which also has no test
  project. Whether the two are decided together is itself open.

## Adopting the frontend rulebook beyond the team that wrote it

A standard only part of a team follows is not a standard in practice — a
codebase converges on whatever its least-constrained contributor does. The
frontend team's own position is to propose that the rulebook applies to
everyone working in a codebase it is installed into, enforced by gates
nobody can bypass, with a possible narrow exception for whoever operates
the pipeline itself — never left voluntary, since a rule that can be
skipped is a rule that will be.

- What this repository's own guards already enforce toward that end —
  no direct push or local merge to a base branch, delivery only through a
  reviewed pull request — is documented in `git-flow.md` and is not itself
  in question.
- What is still open is whether teams beyond the one that wrote this
  rulebook actually agree to adopt it, and on what terms.
- The exact reviewer-count policy is, either way, a per-project decision,
  not something fixed by this proposal.

