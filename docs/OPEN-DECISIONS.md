# Open decisions

**Nothing in this file is a rule.** These are questions that are not settled.
An agent must not enforce, assume, or silently pick a side on any of them — if
a task depends on one being decided, say so and ask.

A question that gets answered is removed from this file and written up in
`docs/standards/` (or a project's own docs) with a `Status:` line. It is not
marked "resolved" and left here, so this file only ever lists what is still
open.

## Styling strategy

Co-located SCSS module per component folder, MUI's `sx` prop, or a deliberate
mix?

- The current split between `sx` and SCSS modules has never been measured.
- A previous attempt to move styles into a co-located location was later
  refactored back into the shared theme files.
- Conditional styles and values computed at runtime (sizes and positions
  derived from state) are the boundary case any rule has to account for.

## Extracting large components into services or plugins

Does the per-display-type rendering logic in the biggest components (table
editor, tab control, screen builder, the DT display-type form) move out into a
services or plugin layer first, or does the component-folder pattern come
first?

- The two tracks are currently proceeding independently and have not been
  reconciled.
- Nothing should land that conflicts with the larger refactor already being
  planned, and that plan is not documented yet.

## The `@softela` shared component library's direction

Does `@softela/basic` and its siblings stay the right dependency, and in what form?

- It wraps MUI behind a narrowed props API, so anything MUI already offers has
  to be added back by changing the library — slow enough that people have
  started using MUI directly instead.
- The consistency argument still holds if the library carries the full props
  API and a genuinely shared design system.
- The local development loop for changing it (publish, bump, reinstall) is slow
  and needs a faster path.
- A partial commitment — narrowed wrapper, no faster dev loop — is the worst
  option: it pays the wrapping cost without buying the consistency.
- The idea of a shared library is usually right; the objection tends to be to
  how the current one looks and behaves, not to the concept of having one.
  People bypassing it for the underlying framework directly is itself the
  signal worth paying attention to, more than any single complaint.
- The decision needed is binary: either the library carries a full props API
  with a design system genuinely shared across whatever depends on it, or it
  is not the right dependency going forward.
- This is ordinarily a decision owned outside the frontend team itself.

## Micro-frontends

Should larger reusable components eventually ship as separately loadable
bundles that other applications install and load at runtime, rather than being
imported as source?

- Agreed to exist on the horizon; no scope and no timeline.
- Linked to the "extraction into services" question above.

## Machine-specific configuration on the backend

`Softela.SCExpert` tracks `appsettings.Development.json` in more than fifteen
projects, so a developer's own local connection string or port lands in a
file everyone else pulls — the same failure the frontend's tracked/per-machine
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

## A wider re-architecture proposal is expected

A broader re-architecture is understood to be planned outside the frontend
team, and there is no documentation for it yet. **Its absence does not block
anything documented elsewhere in this repository** — the git flow, the
documentation standard and the per-repository notes all stand on their own.
