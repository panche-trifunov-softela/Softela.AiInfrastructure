# Softela.SCExpert

The .NET backend for SCExpert.

- Base branch: `dev`
- Project config file: `projects/Softela.SCExpert.json`

## In this folder

- `patches-and-database.md` — how a hotfix patch manifest is built, and what
  has to be updated alongside a database or DT change.
- `debugging.md` — how to get a local backend and frontend running against
  each other for debugging, including the relevant repositories, Swagger
  auth details and breakpoint locations.

## Related

- `docs/standards/git-flow.md` and `docs/standards/code-documentation.md` —
  the portable rules this repository follows, same as every other. The
  backend documentation rule is `/// <summary>` XML doc comments, never a
  JSDoc-style block.
- `docs/OPEN-DECISIONS.md` — questions that are not settled yet. Nothing
  there is a rule; do not enforce or assume any of it.
