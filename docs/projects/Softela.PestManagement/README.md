# Softela.PestManagement

The .NET backend for Pest Management, and the first repository to adopt the
backend architecture standard.

- Base branch: `master`
- Project config file: `projects/Softela.PestManagement.json`
- Stack: `backend`, so it inherits `projects/_presets/backend.json`

## The shape

.NET 10, orchestrated by a .NET Aspire app host. Four architecture projects
(`.Domain`, `.Application`, `.Infrastructure`, `.API`) plus `.AppHost` and
`.ServiceDefaults`, which sit outside the layer ordering.

- **PostgreSQL** through Npgsql and Dapper. There is no EF model, and no EF
  migrations — `dotnet ef` is a denied command in the project config for
  that reason.
- **Evolve** owns the schema, from `Softela.PestManagement.Infrastructure/Database/Scripts`:
  versioned `V1_0_0_NN__*.sql` applied once and checksummed, repeatable
  `R__*.sql` holding the insert/update/get/delete functions.
- **MediatR** plus hand-rolled command and query dispatchers.
- **Keycloak** for authentication; multi-tenant, with the tenant resolved in
  middleware and carried through `ITenantContext`.
- **Transactional outbox** for domain events.

## What is true here that the standard does not say

- **There is no test project.** `test-structure` therefore has nothing to
  check, and neither does any coverage expectation. Adding one is outstanding
  work, not a rule this repository currently meets.
- **Branch names carry no ticket number.** Real branches read
  `feature/impl-Technicians`, `feature/outbox-pattern-initial-setup`. The
  project config relaxes `branchNaming` to ticket-*optional* to match; the
  default pattern would have asked on every branch, and a rule that fires on
  ordinary work gets switched off.
- **The repository does not check out on Windows without long paths.** The
  CQRS folder nesting (`Commands/CfgProgramEventCadence/UpdateCfgProgramEventCadence/…`)
  exceeds `MAX_PATH`, and a plain `git clone` reports "unable to checkout
  working tree" while leaving the index behind. Clone or repair with
  `git -c core.longpaths=true`, or set it globally.
- **`README.md` and `next-steps.md` in the repository are stale.** The README
  says .NET 9 and SQL Server; it is .NET 10 and PostgreSQL. `next-steps.md`
  is unedited `azd init` scaffolding. `.github/copilot-instructions.md` is
  correct but nearly empty. Treat all three the way
  `docs/standards/agent-rules.md` says to treat in-repo instruction files:
  as evidence, not authority.

## The rulebook lives partly outside this infrastructure

`.github/scripts/claude_review.py` carries a `SYSTEM_PROMPT` with the
repository's architecture conventions, applied by a model at pull-request
time. Most of what it lists is now in
[`docs/standards/backend-architecture.md`](../../standards/backend-architecture.md)
and its two companions, which is where
[`docs/standards/README.md`](../../standards/README.md) says such rules
belong — centrally, not in one repository's CI script.

What that prompt still carries and this rulebook does not, because it is
either unenforceable by a text-matching guard or genuinely repository-local:
the Dapper call conventions in detail, the `INT`-returning upsert functions,
and the feature-flag model. When the two disagree, the standard here is the
one to change first.

## Open, not decided

- `appsettings.Development.json` is tracked and has carried a live
  connection string with a plaintext password. `_default.json` now asks
  before a write to any `appsettings*.json`, but whether the backend adopts
  a per-machine settings file at all is still the open question recorded in
  [`docs/OPEN-DECISIONS.md`](../../OPEN-DECISIONS.md).
- No backend file-size threshold is set. See the same document.

## Related

- [`docs/standards/assembled/BACKEND-ARCHITECTURE-STANDARD.md`](../../standards/assembled/BACKEND-ARCHITECTURE-STANDARD.md)
  — the whole backend rulebook, top to bottom. This is the one to read.
- [`docs/standards/git-flow.md`](../../standards/git-flow.md) — the portable
  git rules, same as every other repository.
