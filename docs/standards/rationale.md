# Why this exists

Status: Active — binding for new code.

Two observations, independent of any one project's numbers, are the actual
argument for writing this rulebook down rather than leaving it as shared
intuition. A project's own current size, largest files and adoption
progress are project-specific facts and belong in that project's own docs,
not here — see `docs/projects/<repository>/current-state.md` where this
infrastructure is installed against a real repository.

## This is rarely a green-field proposal

The component-folder pattern this rulebook describes is very often not new
to the codebase it is being proposed for. Parts of it tend to already exist,
inconsistently, in whichever areas were touched most recently or reworked
most carefully — arrived at independently, more than once, by different
people who were never coordinating with each other.

That is not a coincidence worth ignoring; it is the actual argument for
making the pattern explicit. When the same shape keeps emerging on its own,
writing it down is less an invention than a decision to finish something
that had already started, and to make it the default instead of a lucky
accident that only holds where someone happened to care.

## The largest, most tangled files are the ones nobody wants to touch

That reluctance is the real cost being paid, not an inconvenience alongside
it. A file that mixes rendering, state, business rules and data access
becomes expensive to review and risky to change precisely because nothing
in it can be reasoned about on its own — and it is nearly impossible to test
below the level of mounting the whole thing and clicking through it.

The size of such a file is a symptom worth noticing, but the actual defect
underneath it is always the same one this rulebook exists to remove: more
than one job living in one place. See
[`principles.md`](./principles.md#2-one-file-one-job) and
[`file-size.md`](./file-size.md#a-line-count-is-a-symptom-not-the-disease).
