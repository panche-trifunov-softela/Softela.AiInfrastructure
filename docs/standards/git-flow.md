# Git flow

Status: Active — binding

The team-wide git flow that the shared guards (`guard-shell.js` and its
Codex equivalent) may enforce, across every repository this infrastructure is
installed into. It is deliberately looser than any one person's personal
workflow — see the per-repository notes under `docs/projects/` for anything
stricter that an individual has adopted for their own work.

## Enforcement is unavoidable

This is a condition of the whole rulebook, not a detail of one section of
it: a rule here is worth having only if a project's pipeline actually
applies it. Once a gate described in this document is turned on, there is
no path that lets a change skip it, including an urgent fix. Which branch
is protected, and how that is configured, is implementation detail, project
by project; that it cannot be bypassed is not.

## Branch naming

A branch name should read as `{feature|bugfix}/<ticket>_<short_description>`,
lower-cased, where:

- the separator between the type and the description is `_` or `-` — both
  appear on real branches and neither is wrong;
- the ticket appears as `task_{number}`, `ticket_{number}`, or a bare number;
- the description is a short, lower-case, human-readable summary.

**This is enforced as ASK, never DENY.** Real branches on origin legitimately
vary — `feature/dt_editor_fundamentals`, `cleanForm` both exist and are not
mistakes.
A branch outside the preferred form makes the guard show the preferred form
and let the developer proceed deliberately. The guard exists to catch an
agent being careless, not to stop a person who has a reason.

One ticket may legitimately cover several branches; a repeated ticket number
across branches is not itself evidence of a naming error.

## Keeping a branch current

Rebasing the branch onto its base is the preferred way to keep it current,
and produces a linear history that is easier to review and to rebase again
later. Merging the base into the branch is discouraged but **not hard
forbidden** — a guard may prompt before it, not deny it.

## Reaching the base branch

- Merging locally into a base branch, and force-pushing to one, are
  **forbidden**. There is no legitimate case for either in this flow.
- Everything reaches a base branch through a pull request, merged with a
  **squash merge**. This is the hard line the guards enforce as a denial.

## Base branches are per-repository configuration

There is no single, organisation-wide base branch. `Softela.ReactSCExpert`
uses `dev-ng`; `Softela.SCExpert` uses `dev`; another repository may use
something else entirely. A guard, a skill, or a piece of documentation that
hard-codes a base branch name is wrong by construction — it must read the
base from that repository's `projects/<RepositoryName>.json`. See
`docs/projects/*/README.md` for what each repository currently uses.

## Release branches

Release branches follow the real repositories, not a generic template:
`releases/<version>`, plural — for example `releases/25.3`, `releases/25.3.4`,
`releases/26.1`, `releases/26.2`.

## Tags

Per-patch tags are not documented as practice here. At least one repository
in scope has effectively stopped tagging patches individually — do not assume
or enforce a tag-per-patch convention unless a specific repository's own
documentation says otherwise.

## Where the wiki disagrees

The organisation wiki's own `Git Workflow` page describes a different flow:
a single `dev` base with no mention of any other base branch, feature
branches named `feature/<ticket-number>-short-description`, local
`git merge` / `git rebase` kept current with `git push --force-with-lease`,
and singular `release/<version>` branch names.

None of that matches what the real repositories do today. This document
takes the repositories as the authority and treats the wiki page as pending
correction, not as a second, competing source of truth. This is not a
criticism of whoever wrote it — conventions drift, and the page has simply
not been updated to match. Until it is, an agent following this
infrastructure should follow this document, not the wiki.
