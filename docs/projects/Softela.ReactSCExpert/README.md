# Softela.ReactSCExpert

The React frontend for SCExpert. Config-driven: apart from a handful of
static pages, screens are not written in code — they are configured and
rendered through `CustomPage`, and what this repository's code provides is
the library of blocks a configuration assembles at runtime.

- Base branch: `dev-ng`
- Project config file: `projects/Softela.ReactSCExpert.json`
- Build tool: Vite
- Global state: Zustand (`src/store/`)

## In this folder

- `repository-traps.md` — the things that silently waste a day: invocations
  that look fine and are not, and which guard (if any) catches each one.
- `current-state.md` — a snapshot of what the codebase looks like today:
  size, structure, and where the known rough edges are. Says at the top how
  stale it is and how to refresh it.
- `migration-backlog.md` — the ordered list of structural work ahead of this
  codebase, and where each item currently stands.

## Related

- `docs/standards/git-flow.md` and `docs/standards/code-documentation.md` —
  the portable rules this repository follows, same as every other.
- `docs/OPEN-DECISIONS.md` — questions that touch this repository and are not
  settled yet. Nothing there is a rule; do not enforce or assume any of it.
