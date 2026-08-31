# Migration approach

Status: Active — binding for new code.

The general shape of how a project moves toward this rulebook, independent
of any one project's own backlog. A project's actual scheduled work — which
files, in what order, on what evidence — is project-specific and belongs in
that project's own docs (for example
`docs/projects/<repository>/migration-backlog.md`), not here.

## No big-bang refactor

Rewriting the largest, most tangled part of a codebase in one pass produces
a diff nobody can meaningfully review, on a branch that cannot be kept
current against a fast-moving base, with a regression surface covering
whatever that part does. The approach instead is incremental, and it is not
allowed to block feature work — a team does not stop shipping to adopt this
rulebook.

## Phase 0 — Agree and record

Publish the rulebook a project is adopting, add that project's own agent
rulebook and pointer file (see [`agent-rules.md`](./agent-rules.md)), and the
shared agent configuration. No application code changes in this phase.

## Phase 1 — New code only

Every new component, store, hook and service that needs more than one file
follows the pattern from day one. This is the cheapest phase: it costs
nothing beyond what would be written anyway, and it stops the problem
growing while the rest of the plan catches up.

## Phase 2 — The Boy Scout rule on touched code

When a file that predates the rulebook is opened for unrelated work, the
part actually touched is brought up to it: the logic being modified moves
into a hook or a utility, a type being changed gets a proper home, a test is
added for what was extracted, an `index.ts` is added if the folder is
missing one.

Two things this phase explicitly does **not** allow:

- **Restructuring code that is not otherwise being changed does not belong
  in the same change.** It buries the real diff and makes review
  impossible.
- **A behaviour-preserving refactor and a behaviour change must not share a
  change.** A bug found while refactoring gets its own, separate change.

## Phase 3 — Scheduled refactors

The largest, highest-risk, highest-change-frequency files get their own
scheduled work, estimated and prioritised like any other feature, rather
than left to whoever happens to open them next. Order of extraction within
each one, in order of preference:

1. **Pull the logic out first** — state and rules into a hook, pure
   functions into a utility. On the largest files this alone removes most
   of the volume and requires no change to what is actually rendered.
2. **Then extract child components**, along the seams the UI already has.
3. **Then extract shared hooks**, where two of the new child components
   need the same behaviour.
4. **Only then consider splitting the view itself further**, if it is still
   large after the above.

Doing this in the reverse order — cutting markup into fragments while the
logic underneath stays tangled — produces more files with exactly the same
coupling, which is worse than the one large file it replaced.

A refactor in this phase is done when: the folder follows the agreed
pattern with a barrel that only re-exports; no file in it is above the
agreed size threshold, or is on the documented exception list with a
reason; extracted utilities and hooks have tests; public behaviour is
unchanged; and any existing specs for the file have moved to the agreed
location and still pass.

## Phase 4 — Gate the new work

Build a per-scope (per-feature, per-changed-file) coverage mechanism, then
switch on a pipeline coverage gate for newly added features and components
only. There is deliberately no repository-wide coverage threshold and no
ratchet planned — a whole-codebase percentage on a tree with a large
untested history mostly measures the backlog rather than the work in front
of a reviewer. Numbers and a start date are project-specific decisions, not
fixed here — see [`testing.md`](./testing.md#coverage).

## What is enforced

- Nothing in this repository's guard set enforces the phase a project is
  in; the phases are a planning tool, not a checkable rule. The rules each
  phase eventually turns on — file size, colocated tests, the coverage gate
  itself — are enforced as described in the documents that define them.
