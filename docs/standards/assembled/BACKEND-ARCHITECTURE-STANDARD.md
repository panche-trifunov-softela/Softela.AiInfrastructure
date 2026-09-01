# Backend Architecture Standard

> **Generated file — do not edit directly.** Produced by `tools/build-standard.js`
> from the individual files in `docs/standards/`. Edit one of those and run
> `node tools/build-standard.js` to regenerate this file, or
> `node tools/build-standard.js --check` to verify it still matches without
> writing anything.

## Contents

1. [Architecture standards](#architecture-standards)
2. [Principles](#principles)
3. [Backend architecture](#backend-architecture)
4. [Backend use cases](#backend-use-cases)
5. [Backend data access](#backend-data-access)
6. [Code documentation](#code-documentation)
7. [Git flow](#git-flow)

---

# Architecture standards

Status: Index — see [Status and provenance](#status-and-provenance) below;
each document also carries its own status line.

This is the portable rulebook for how code is structured, on both stacks:
how a component or a use case is laid out on disk, where state lives, how
things are typed, tested and reused. It applies to any project this
infrastructure is installed into, not to one specific repository — there are
no real paths, store names or file names in it, only shapes
(`src/components/**`, `*.Application/**`) that any project can match against
its own root.

The directory grew up frontend-first, and most of it below still is. The
three backend documents are newer and carry their own table — see
[The backend documents](#the-backend-documents). Everything outside those
two tables ([`git-flow.md`](./git-flow.md),
[`code-documentation.md`](./code-documentation.md),
[`clean-code.md`](./clean-code.md)) applies to both stacks.

It grew out of an architecture sync where a frontend team reviewed and agreed
a draft standard. What follows is the part of that draft which is (a) true
for any project and (b) settled rather than still being argued about. A
second, repository-bound document, written separately, carries the
project-specific facts — current file sizes, real folder names, a migration
backlog — that do not belong here. See
[`EXCLUDED-FROM-SOURCE.md`](./EXCLUDED-FROM-SOURCE.md) for exactly what was
left out of this portable version, and why, and
[`ONBOARDING.md`](./ONBOARDING.md) for where to start reading.

## Status and provenance

**This rulebook is the agreed position of the offshore frontend team that
wrote it, reached at the frontend architecture sync that reviewed it, and
generalised here for reuse beyond the one repository it was written
against.** The rules in this directory — except
[`git-flow.md`](./git-flow.md), which documents this infrastructure's own
guard behaviour rather than the frontend team's proposal — are the frontend
team's own, reviewed and settled position: for new code, the team already
follows this standard; existing code is brought up to it a piece at a time,
as it is touched, rather than in one sweep. Where the source material
records a decision, that decision is what these documents carry forward as
a rule; nothing here is a rule this repository's authors invented on the
team's behalf. The deliberation behind a settled decision — the
alternatives weighed, the reasoning for rejecting them — is not carried
forward once the decision itself is captured as a rule here; what a
question is still genuinely unsettled is tracked in
`docs/OPEN-DECISIONS.md` instead, see
[What is open, and out of scope here](#what-is-open-and-out-of-scope-here)
below.

**It is binding wherever a project adopts it.** Adoption is a per-project
decision, made when a project installs this infrastructure and turns a
given track on — see [`docs/guide/configuration.md`](../guide/configuration.md).
From that point the rules are binding for new code in *that* project, some
of them mechanically enforced by the guards named in each document's "What
is enforced" section.

## How to read a rule

Every rule in these documents is written as **MUST**, **SHOULD** or **MAY**:

- **MUST** — required. A reviewer should reject a change without it.
- **SHOULD** — required unless there is a stated reason not to, given in the
  pull request.
- **MAY** — allowed, at the author's judgement.

## Scope of enforcement

Once a project adopts this rulebook, it applies to three different slices of
that project's code, and not in the same way:

1. **All new code** — from the day the project adopts it.
2. **Code already open for another reason** — bring the parts you actually
   touch up to the standard as you go (the Boy Scout rule, below). This is
   not a mandate to refactor beyond what the change already touches.
3. **Existing code nobody is touching** — nothing changes until it is
   scheduled. Adopting this rulebook is not an instruction to stop feature
   work and refactor the codebase.

## Status labels

Each document opens with one of these:

- **Active — binding for new code.** Agreed by the frontend team, and either
  already enforced by a guard or ready to be. Applies to new code from the
  day a project adopts this rulebook; existing code is expected to move
  toward it as it is touched (the Boy Scout rule, above), not all at once.
- **Agreed, deferred — low priority.** Agreed in principle, deliberately
  scheduled after the higher-priority work. Not a rejection and not
  optional forever — just not now. Only [`api-layer.md`](./api-layer.md)
  carries this label.
- Anything still under real disagreement — styling strategy, extracting
  services into a shared library, micro-frontends — is **not** in this
  directory at all. It is being tracked in `docs/OPEN-DECISIONS.md`, and
  nothing here should be read as a ruling on it.

## The documents

| Document | Status | Covers |
| --- | --- | --- |
| [`rationale.md`](./rationale.md) | Active | Why this rulebook exists at all — the general argument, independent of any one project's numbers. |
| [`principles.md`](./principles.md) | Active | The handful of ideas everything else follows from, including that reuse is mandatory. |
| [`shared-code-boundaries.md`](./shared-code-boundaries.md) | Active | What belongs at a project's shared root versus inside one consumer's own folder, and how the same folder split applies to a store, a context or a root-level hook once it outgrows one file. |
| [`component-structure.md`](./component-structure.md) | Active | One component, one folder; required and optional contents; how a folder grows and how code is promoted out of it. |
| [`layer-boundaries.md`](./layer-boundaries.md) | Active | What the view, the hook, context and utilities are each allowed to do, and which layer may import which. |
| [`naming.md`](./naming.md) | Active | File, folder, hook, constant and spec naming conventions. |
| [`file-size.md`](./file-size.md) | Active | The line-count thresholds, the exception mechanism, and how to split a file that has grown too large. |
| [`state-management.md`](./state-management.md) | Active | Where a given piece of state belongs, server data versus reference data, prop drilling, cross-component signalling. |
| [`types.md`](./types.md) | Active | Frontend-only type design **and** backend-contract typing and filing — matching the backend exactly, one DTO per file, the nullability generics. Contract typing is binding now; only the API layer's own file organisation is deferred, see `api-layer.md`. |
| [`api-layer.md`](./api-layer.md) | **Agreed, deferred** | Organising the API layer by backend controller and the `any` cleanup. Binding for new endpoints only, once the project turns this track on. Does not cover contract typing itself — see `types.md`. |
| [`local-dev-config.md`](./local-dev-config.md) | Active | Machine-specific configuration never lands in a tracked file: the deployed-config file versus the gitignored per-machine one, and what the `local-config-isolation` rule enforces on a write, a stage and a commit. |
| [`code-documentation.md`](./code-documentation.md) | Active | How comments and doc blocks are written, for humans and AI agents alike. |
| [`testing.md`](./testing.md) | Active | Co-located tests, what to test at each layer, one test per behaviour, test naming, coverage expectations. |
| [`agent-rules.md`](./agent-rules.md) | Active | Rules for an AI agent working in the repository, as distinct from rules about the code it writes. |
| [`migration-approach.md`](./migration-approach.md) | Active | The general shape of a no-big-bang rollout: phases, the Boy Scout rule, gating new work — without any one project's own backlog. |

## The backend documents

The .NET counterpart to the table above. Same contract: portable shapes, no
repository's own project names, binding for new code once a project adopts
them by declaring `"stack": "backend"`.

| Document | Status | Covers |
| --- | --- | --- |
| [`backend-architecture.md`](./backend-architecture.md) | Active | The four projects (Domain, Application, Infrastructure, Api), what belongs in each, and the dependency rule: nothing inner references anything outer. Why the repository interfaces live inward. |
| [`backend-use-cases.md`](./backend-use-cases.md) | Active | One folder per use case and what has to be in it; the command handler's transaction envelope; why the domain event goes inside the transaction; tenant scoping and soft deletes. |
| [`backend-data-access.md`](./backend-data-access.md) | Active | The repository boundary, calling database functions, snake_case identifiers, offset-carrying timestamps, and versioned versus repeatable migrations. |

Three things the frontend table has no equivalent of, and one it does:

- **File-size thresholds are deliberately unset for the backend.**
  `file-size-limit` stays frontend-only until a number is actually agreed
  rather than invented — see `docs/OPEN-DECISIONS.md`.
- **Co-located tests are a frontend convention.** The backend keeps separate
  test projects, and `test-structure`'s Arrange-Act-Assert expectation is
  the backend's own.
- **`code-documentation.md` already covers both stacks** — its "Backend
  (.NET)" section is the `/// <summary>` rule, and has been there all along.

Git workflow — branch naming, rebasing, how a change reaches a base
branch — is covered by [`git-flow.md`](./git-flow.md) in this same
directory. Unlike the rest of this directory, it documents this
infrastructure's own guard behaviour directly, rather than the frontend
team's proposal — see [Status and provenance](#status-and-provenance).

[`clean-code.md`](./clean-code.md) sits outside the table for a different
reason: it is not frontend-specific and it is not enforced. It states the
named principles — DRY, SOLID, KISS — the separation of concerns that the
component-folder shape is one instance of, and the whitespace conventions
that make any language's code readable, as a standing recommendation for
**all** code in any repository this rulebook reaches. It is deliberately
guard-free; the document itself explains why.

## Generated documents

Three whole documents are assembled from the files above by
[`tools/build-standard.js`](../../tools/build-standard.js) — nobody edits
any of them by hand, and running the script (or its `--check` flag) is how
drift between a split file and an output is caught:

- [`FRONTEND-ARCHITECTURE-STANDARD.md`](./assembled/FRONTEND-ARCHITECTURE-STANDARD.md)
  — every document in the frontend table above, in reading order: the full
  portable frontend rulebook.
- [`BACKEND-ARCHITECTURE-STANDARD.md`](./assembled/BACKEND-ARCHITECTURE-STANDARD.md)
  — the same for the backend table: the project layout and the dependency
  rule, the use-case shape, data access and migrations, plus the shared
  documentation and git-flow parts.
- [`CODE-DOCUMENTATION-STANDARD.md`](./assembled/CODE-DOCUMENTATION-STANDARD.md) — a
  standalone document assembled from [`code-documentation.md`](./code-documentation.md)
  alone, meant to be handed to a team, a project, or another organisation's
  AI agent that needs only the comment and doc-block rules, without pulling
  in the rest of this rulebook.

A part feeding more than one output never holds a second copy of itself.
`code-documentation.md` is a section of both architecture standards *and*
the whole of the documentation standard; `README.md` (this file),
`principles.md` and `git-flow.md` are shared between the two architecture
documents the same way. Editing the part once updates every output that
carries it.

## The convention this directory follows

Standards and rules that bind a developer or an AI agent working in either
product repository live **centrally, here** — not scattered across
per-repository README files, inline comments, or a wiki page only some
agents will ever read. They **must stay readable for a human**: a rulebook
nobody can read start to finish stops being a rulebook.

That readability requirement is what the split above is for, generalised:

- A standard that has grown too large to maintain as one file MAY be split
  into parts, the way this directory splits the frontend architecture
  standard into `principles.md`, `naming.md`, `file-size.md` and the rest.
- A split standard MUST still be assembled back into one composed document a
  human can read top to bottom, the way
  [`FRONTEND-ARCHITECTURE-STANDARD.md`](./assembled/FRONTEND-ARCHITECTURE-STANDARD.md)
  and [`CODE-DOCUMENTATION-STANDARD.md`](./assembled/CODE-DOCUMENTATION-STANDARD.md)
  are assembled from the parts above (see
  [Generated documents](#generated-documents)).
- The parts are the source of truth; the assembled document is **generated**,
  never hand-maintained. Edit the part that covers what changed, then run
  [`tools/build-standard.js`](../../tools/build-standard.js) to regenerate —
  never edit a generated output file directly, because that edit is
  overwritten the next time the script runs and never reaches the part
  anyone else actually reads.

## What is Active today

Binding for new code, effective immediately on adoption:

- The component-folder structure ([`component-structure.md`](./component-structure.md)
  and [`layer-boundaries.md`](./layer-boundaries.md)).
- Test coverage expectations for new and touched code, and running the full
  test suite locally before committing ([`testing.md`](./testing.md)).
- The file-size thresholds, including the hard limit at which a build fails
  ([`file-size.md`](./file-size.md)).
- Delivery only through a pull request, with mandatory reviewer approval and
  no direct push to a base branch — enforced at the git level, see
  [`git-flow.md`](./git-flow.md).
- **The Boy Scout rule**: code you already have open gets improved as you
  touch it — extract the logic you are modifying, give a type you are
  changing a proper home, add a test for what you extracted. This is not a
  licence to restructure code you are not otherwise changing in the same
  change set; that buries the real diff and makes review impossible.

## What is deferred

[`api-layer.md`](./api-layer.md) — organising the API layer by backend
controller, and reducing the existing use of `any`. Agreed in principle,
scheduled after the structure and testing work because that work is what
makes components testable, which is the higher priority. New endpoints
follow it from the day a project turns this track on; existing API code is
not refactored to match it until there is a reason and the time.

**Filing and typing a backend-contract type itself is not part of this
deferral.** A new contract type still MUST be filed in the shared,
service-organised location, matched to the backend exactly and never typed
`any`, from the day a project adopts this rulebook — see
[`types.md`](./types.md). What is deferred is only reorganising the API
layer's own files by controller and cleaning up the existing backlog of
untyped calls.

## What is open, and out of scope here

Not settled, and therefore not a rule in any of these documents:

- Styling strategy — a single co-located stylesheet convention versus the
  current mixed approach.
- Extracting components or services into a shared library, and how that
  library's API should be shaped.
- Micro-frontends.

These are tracked in `docs/OPEN-DECISIONS.md`. If a document in this
directory appears to take a position on one of them, that is a defect in the
document, not a ruling — report it.

---

# Principles

Status: Active — binding for new code.

Everything else in this rulebook is an application of a small number of
ideas. When a rule elsewhere seems to conflict with a specific situation,
come back here first — the specific rule is almost always a consequence of
one of these, and understanding why usually resolves the conflict.

## 1. Build small, composable units

A component, a hook or a utility is rarely used only once, in only the
place its author had in mind. It gets reused in combinations nobody
enumerated in advance, next to code its author never saw. That raises the
bar: a unit that only works in its original context is a liability the
moment it is reused, because the second caller inherits every assumption
the first one silently made.

The practical test: **a part you can name, describe in one sentence and
test on its own is a part that survives being placed somewhere
unexpected.** If you cannot describe what a file does without "and", it is
probably more than one part.

## 2. One file, one job

Rendering, business logic, types, constants and utilities are different
jobs. When they share a file they cannot be read, reviewed, reused or
tested separately — a reviewer has to hold the whole file in their head to
understand any one part of it, and a test for the business logic has to
mount the rendering to reach it.

This is the principle behind the component-folder shape in
[`component-structure.md`](./component-structure.md) and the layer split in
[`layer-boundaries.md`](./layer-boundaries.md): those documents are this
idea applied consistently, not a separate rule.

## 3. The folder mirrors the root

A component's own folder uses the same vocabulary as the project
root — `components/`, `hooks/`, `types/`, `utils/`, a constants file. Learn
the layout once and it holds at every depth, whether you are looking at the
whole project or a single component three levels deep.

This is what makes promoting something cheap: moving a utility from a
component's own `utils/` to the parent's, or to the project root, is a file
move and an import update, not a rewrite, because the destination already
has the same shape as the source.

## 4. Reuse is mandatory, not a style choice

**Before writing a new helper, hook, type, service or constant, look for
what already exists and extend it.** Search the immediate folder, the
parent, the project's shared locations, and any shared package the project
depends on, in that order, before writing anything new.

Reinventing something the project already has is a defect, not a matter of
taste: a fourth `formatDate` or a third confirm-dialog controller is a
permanent tax on everyone who has to figure out which one is the real one,
and it is a tax nobody agreed to pay. Finding the existing one costs a
search; adding a duplicate costs every future reader.

This applies as much to an AI agent as to a person — see
[`agent-rules.md`](./agent-rules.md).

**A well-formed unit is usually close to extractable, and that is worth
building toward on purpose.** A component folder built the way
[`component-structure.md`](./component-structure.md) describes — view,
logic, types, constants and utilities behind a single declared entry
point — is most of the way to being publishable into a shared package as it
stands. A candidate is genuinely generic when it has no import from a
project-specific store, no project-specific type, no assumption baked in
about one particular screen, and a public surface already expressed in its
own barrel; something that meets those tests is worth proposing for
extraction rather than copying into the next place that needs it.

Where it costs nothing to do so, **build a reusable piece product-agnostic
from the start**: take a label as a prop instead of reading it from a
project's own translation store, take a callback instead of calling a
project's own API layer directly. Neither costs anything the day it is
written, and both are what let the same piece move to a shared package
later without a rewrite.

## 5. Promote on the second consumer, not the second guess

Code with exactly one consumer lives inside that consumer's own folder,
where it can be found, changed and deleted along with it. It moves up —
one level, to the parent, to the project root, to a shared package — only
when a second, real consumer needs it.

Moving something up "because it looks generic" produces a shared folder
full of single-use code, which is the same problem as an oversized file,
just spread across more locations. The trigger is a real second caller, not
a guess about future reuse.

## 6. Structure serves testing

Most of what is hard to test is hard because logic and rendering are welded
together — the only available test is to mount the whole screen and
interact with it, which is slow, brittle, and fails for reasons unrelated
to what it is meant to assert.

Split the two apart and the logic becomes a plain function or a hook,
testable without mounting anything. This is why
[`layer-boundaries.md`](./layer-boundaries.md) insists on the split even
where it looks like extra ceremony for a small component: the payoff is
not visible in that one component, it is visible in how cheap its test
turns out to be.

## What is enforced

- Reuse-before-writing (principle 4) is backed by the `reuse-before-new`
  guard rule, which can prompt when a change introduces something that
  looks like a near-duplicate of an existing helper, hook or type.
- The remaining principles are design philosophy: they are not
  independently guard-enforced. They surface as concrete, checkable rules
  in the other documents in this directory, and enforcement is described
  there.

---

# Backend architecture

Status: Active — binding for new code.

How a .NET backend service is split into projects, which project may
reference which, and what belongs in each. This is the backend counterpart
to [`component-structure.md`](./component-structure.md) and
[`layer-boundaries.md`](./layer-boundaries.md) on the frontend side: the
project layout is free to copy, and the dependency direction is what makes
it worth copying.

Like the rest of this directory, this document is portable. It names
shapes — `*.Domain`, `*.Application` — never one repository's own project
names, so any service can match its own layout against it.

## The four projects

A service is four projects, plus whatever hosting and shared-defaults
projects the platform adds:

| Project | Holds | May reference |
| --- | --- | --- |
| `*.Domain` | Entities, enums, value objects, domain constants | **Nothing** |
| `*.Application` | Use cases, DTOs, domain events, repository *interfaces*, dispatchers, outbox contracts | `*.Domain` |
| `*.Infrastructure` | Repository *implementations*, data context, migrator, SQL scripts, external clients | `*.Application`, `*.Domain` |
| `*.Api` | Controllers, middleware, the composition root | `*.Application`, `*.Infrastructure` |

Hosting projects (an orchestrator app host, a shared service-defaults
project) sit outside this table. They are composition, not architecture,
and this document says nothing about them.

## The dependency rule

**Nothing inner may reference anything outer.** That is the whole rule, and
it is the one thing in this document that is mechanically enforced:

- `*.Domain` MUST NOT reference `*.Application`, `*.Infrastructure` or
  `*.Api`.
- `*.Application` MUST NOT reference `*.Infrastructure` or `*.Api`.
- `*.Infrastructure` MUST NOT reference `*.Api`.

It binds both ways it can be broken: a `ProjectReference` in a `.csproj`,
and a `using` directive in a source file. The second is the one that
actually happens — a project reference is a deliberate act somebody notices
in review, while a `using` gets added by an IDE quick-fix nobody reads.

### Why the interfaces live inward

The direction above is only interesting because of where repository
interfaces live. `*.Application` owns them:

```
*.Application/Repositories/ICustomerRepository.cs      ← the interface
*.Infrastructure/Database/Repositories/CustomerRepository.cs   ← the implementation
```

A use case depends on `ICustomerRepository`, which it owns, and never on
the class that implements it. `*.Infrastructure` references `*.Application`
in order to implement that interface — the reference points inward, and the
*dependency* points inward with it. This is what lets the data-access
technology change without the use cases noticing, and it is why the
interface must not be moved next to its implementation for convenience.

### What this buys, concretely

A use case can be read, reasoned about and tested without a database,
because nothing it references knows one exists. The moment
`*.Application` reaches into `*.Infrastructure` that stops being true, and
it stops being true permanently — the first violation is the expensive one,
every later one is free.

## Inside `*.Domain`

- Entities are plain classes. No data-access attributes, no framework
  types, no serialisation concerns.
- A common `BaseEntity` carries identity and audit columns — an id, and
  created/modified stamps naming both the actor and the instant.
- A `TenantScopedEntity` extends it with the tenant discriminator and the
  soft-delete flag. Every entity belonging to a tenant extends this one,
  not `BaseEntity` directly — see
  [`backend-use-cases.md`](./backend-use-cases.md).
- Enums live in their own folder and are referenced by entities. A field
  with a fixed, known set of values is an enum, not a loose `string` or
  `int`.

## Inside `*.Application`

- `Commands/` and `Queries/`, one folder per use case — the shape is
  [`backend-use-cases.md`](./backend-use-cases.md)'s subject.
- `Dtos/` — one DTO per file, the contract shape returned outward.
- `Events/` — domain events, one file per aggregate's events.
- `Repositories/` — the interfaces, as above.
- `Core/` — the dispatchers and the cross-cutting abstractions (tenancy,
  feature flags) the use cases depend on.
- `Outbox/` — the outbox contracts and the processor.

## Inside `*.Infrastructure`

- `Database/Repositories/` — one implementation per interface.
- `Database/Scripts/` — the SQL, versioned and repeatable, covered by
  [`backend-data-access.md`](./backend-data-access.md).
- `Database/` — the data context, connection handling, the migrator, the
  unit of work.

## Inside `*.Api`

- `Controllers/` — thin. A controller resolves the request into a use-case
  request, dispatches it, and turns the result into an HTTP response. It
  holds no business rules and reaches no repository.
- `Middleware/` — cross-cutting request concerns, such as resolving the
  tenant from the incoming request.
- The composition root — where interfaces are bound to implementations.
  This is the one place that legitimately knows about every layer at once.

## A controller does not think

The failure this prevents is the controller that grows a business rule,
because a rule there is unreachable from a test and invisible to every
other entry point:

```csharp
// BAD — the rule lives in the controller, and only the controller has it.
[HttpPost]
public async Task<IActionResult> Create([FromBody] CreateCustomerRequest request, CancellationToken ct)
{
    if (request.Type == CustomerType.Commercial && string.IsNullOrEmpty(request.TaxId))
        return BadRequest("Commercial customers need a tax id.");

    var id = await _commandDispatcher.SendAsync<int, CreateCustomerRequest>(request, ct);
    return Created(string.Empty, new { id });
}
```

```csharp
// GOOD — the controller dispatches; the rule belongs to the use case.
[HttpPost]
public async Task<IActionResult> Create([FromBody] CreateCustomerRequest request, CancellationToken ct)
{
    var id = await _commandDispatcher.SendAsync<int, CreateCustomerRequest>(request, ct);
    return Created(string.Empty, new { id });
}
```

## What is enforced

- `layer-dependencies` denies a `using` directive or a `ProjectReference`
  that points outward, in either direction it can be written. The layer
  order is project configuration (`conventions.layers`), not a constant in
  the guard, so a service that names its projects differently states its
  own order once.
- `naming-standards` covers `I`-prefixed interfaces and PascalCase types.
- `doc-comment-style` covers `/// <summary>` and its tags, and denies a
  JSDoc-style block in a `.cs` file.

Not mechanically enforced, and left to review: that a controller holds no
business rules, that an entity carries no framework types, and the internal
folder layout of each project above. A guard cannot tell a business rule
from a guard clause by reading text.

File-size thresholds are deliberately **not** set for the backend — see
`docs/OPEN-DECISIONS.md`. `file-size-limit` stays frontend-only until a
backend number is actually agreed rather than invented here.

---

# Backend use cases

Status: Active — binding for new code.

One folder per use case, and what has to be inside it. This is the backend
counterpart to [`component-structure.md`](./component-structure.md): the
same idea that a unit of work gets a folder rather than being scattered
across four shared files organised by file *type*.

## One use case, one folder

```
*.Application/
  Commands/<Aggregate>/<UseCase>/
    <UseCase>Request.cs       ← required
    <UseCase>Handler.cs       ← required
    <UseCase>Mapper.cs        ← when the handler builds an entity
  Queries/<Aggregate>/<UseCase>/
    <UseCase>Request.cs       ← required
    <UseCase>Response.cs      ← required
    <UseCase>Handler.cs       ← required
    <UseCase>Mapper.cs        ← when the handler shapes a DTO
```

- Every file in the folder is prefixed with the use-case name. `Handler.cs`
  and `Request.cs` alone are wrong: with thirty use cases open in an editor,
  thirty identical tab labels is a real cost, and it is free to avoid.
- **A command needs no `Response`.** It returns the identifier it created,
  or nothing. A command that returns a projection of what it just wrote is
  a query wearing a command's clothes, and the read belongs in its own
  query.
- **A query MUST have a `Response`.** Returning a DTO directly from the
  handler makes every later addition — a total count, a paging cursor — a
  breaking change to every caller.
- **A `Mapper` is a static class**, named `<UseCase>Mapper`, holding pure
  translation and nothing else. No repository call, no clock read, no
  tenant lookup: everything it needs arrives as a parameter. That is what
  keeps it testable without any of them.

## The handler

A handler implements the dispatcher's handler interface, takes its
dependencies through the constructor, and does one thing.

```csharp
public class CreateCustomerHandler : IRequestHandler<CreateCustomerRequest, int>
{
    private readonly ICustomerRepository _customerRepository;
    private readonly IOutboxRepository _outboxRepository;
    private readonly IUnitOfWork _unitOfWork;
    private readonly ITenantContext _tenantContext;

    // constructor assigns the four fields

    public async Task<int> Handle(CreateCustomerRequest request, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var customer = CreateCustomerMapper.ToDomainEntity(
            request, now, _tenantContext.UserId, _tenantContext.TenantId);

        await _unitOfWork.BeginTransactionAsync(cancellationToken);
        try
        {
            var id = await _customerRepository.CreateAsync(customer);
            await _outboxRepository.InsertAsync(
                OutboxMessageFactory.Create(new CustomerCreatedEvent(id, customer.TenantId), now));
            await _unitOfWork.CommitAsync(cancellationToken);
            return id;
        }
        catch
        {
            await _unitOfWork.RollbackAsync(cancellationToken);
            throw;
        }
    }
}
```

Four things in that shape are binding.

### The transaction envelope

**Every command handler that writes MUST wrap its writes in
begin/commit/rollback**, in exactly the shape above. The `catch` rolls back
and **rethrows** — it never swallows, never logs-and-continues, and never
returns a default. A handler that swallows turns a failed write into a
successful-looking response, which is the single worst outcome available.

A query handler opens no transaction. It reads.

### The event goes inside the transaction

**A domain event MUST be written to the outbox inside the same transaction
as the data change it describes.** This is the whole point of an outbox,
and putting the insert after `CommitAsync` quietly discards it:

```csharp
// BAD — the commit succeeded, then the process died. The write happened
// and the event never will. Nothing downstream ever learns about it.
await _unitOfWork.CommitAsync(cancellationToken);
await _outboxRepository.InsertAsync(OutboxMessageFactory.Create(evt, now));
```

Inside the transaction, the row and the event commit together or neither
does. Outside it, there is a window in which they disagree, and the window
is exactly where the failures live.

### One timestamp per handler

Read the clock **once**, into a local, and use that value for the entity
stamps and the event alike. Calling `DateTimeOffset.UtcNow` three times in
one handler produces three different instants for what is one atomic
change, and the resulting rows cannot be correlated afterwards.

### Tenant scoping is not optional

**A handler touching tenant-scoped data MUST inject the tenant context**
and use it for both jobs:

- **Scoping** — every read and every write is filtered by the tenant
  identifier. A repository method that takes no tenant id is a
  cross-tenant data leak waiting for its first bug report.
- **Audit** — the created/modified actor is the tenant context's user, never
  a value taken from the request body. A client that can name its own
  author can forge one.

## Soft deletes

Tenant-scoped entities are deleted by setting the soft-delete flag and
stamping the modified columns, never by removing the row. Every read
excludes the flagged rows. A hard delete of tenant data breaks the audit
trail and anything already referencing the row.

## Requests and responses are contracts

- One request type per use case, and it is not shared between two of them.
  Two use cases that happen to take the same fields today will not tomorrow,
  and the shared type is what makes that a breaking change instead of an
  edit.
- A DTO belongs in the shared `Dtos/` folder, one per file, when more than
  one use case returns it. A projection used by exactly one query may stay
  in that query's own `Response`.

## What is enforced

- `transactional-outbox` denies an outbox insert in a handler that opens no
  transaction, and denies one written after the commit. Both patterns are
  project configuration (`conventions.transactions`), not constants in the
  guard.
- `naming-standards` covers the type-naming conventions the file names
  above depend on.

Not mechanically enforced, and left to review: that a mapper stays pure,
that the clock is read once, that tenant scoping is actually applied inside
a repository call, and that a command does not secretly return a
projection. These need to know what the code *means*, which a text-matching
guard cannot.

The required-file list (a query folder carrying its `Response`, a use-case
folder carrying its `Request`) is **not** guarded today. It is the obvious
next rule, and the frontend's `component-folder-shape` is the template for
it — see `docs/OPEN-DECISIONS.md`.

---

# Backend data access

Status: Active — binding for new code.

Repositories, the SQL they call, and how the schema changes over time.

## The repository boundary

- The interface lives in `*.Application/Repositories/`, the implementation
  in `*.Infrastructure/`. [`backend-architecture.md`](./backend-architecture.md)
  covers why that direction is load-bearing.
- **A repository returns domain entities, never DTOs.** Shaping a DTO is
  the use case's job, through its mapper. A repository that returns the
  shape one caller happens to want cannot be reused by the next one.
- **A repository holds no business rules.** It reads and writes. A
  conditional about what the data *means* belongs in the handler.
- Every method touching tenant-scoped data takes the tenant identifier as a
  parameter. Not as ambient state, not read from a static — a parameter, so
  the call site cannot forget it and the signature makes that visible.

## Calling the database

Where the project uses a micro-ORM over database functions, the shape is:

- **`CommandType.Text`**, always. Never `CommandType.StoredProcedure` — the
  call is a `SELECT` against a function, and the two command types are not
  interchangeable.
- Writes call an insert/update function returning the affected id:
  `SELECT insert_customer(@p_tenant_id, …)`.
- Reads select from a function: `SELECT * FROM get_customer_by_id(@p_id, @p_tenant_id)`.
- Deletes call a delete function: `SELECT delete_customer(@p_id, …)` — which
  performs the soft delete, per
  [`backend-use-cases.md`](./backend-use-cases.md).
- **Every parameter is added explicitly, with its `DbType`.** Letting the
  driver infer types is where a date silently loses its offset and a
  decimal silently loses precision.
- **Every call passes the ambient transaction.** A repository call that
  omits it runs outside the handler's transaction, which means it neither
  rolls back nor commits with everything else — the exact failure the
  transaction envelope exists to prevent.

```csharp
return await _dapperDataContext.Connection!.QuerySingleAsync<int>(
    sql: "SELECT insert_customer(@p_tenant_id, @p_name, @p_created_at, @p_created_by)",
    param: parameters,
    commandType: CommandType.Text,
    transaction: _dapperDataContext.Transaction   // ← never omitted
).ConfigureAwait(false);
```

## Identifiers are snake_case

**Every database identifier is `snake_case`**: tables, columns, functions,
constraints, indexes, and the `p_`-prefixed function parameters. Mixed
casing in PostgreSQL means quoted identifiers forever after, and one
unquoted reference to a camelCase name resolves to something else entirely
without erroring.

This applies to the SQL, not to C#. An entity property stays PascalCase; the
mapping between the two belongs in the parameter list, spelled out.

## Timestamps carry their offset

Stored date/time columns use the offset-carrying type
(`timestamptz`), and the C# side uses `DateTimeOffset`. A naive timestamp
column is a bug that only appears when two machines are in different zones
— which is to say, in production and not on the developer's laptop.

## Migrations

Two kinds of script, and the difference is the whole point:

| Kind | Named | Re-run when | Editable |
| --- | --- | --- | --- |
| **Versioned** | `V<version>__<description>.sql` | Once, ever | **No** |
| **Repeatable** | `R__<Name>.sql` | Whenever its content changes | Yes |

- **A versioned script is immutable once it exists.** The migration tool
  records it by version and checksum after it runs. Editing one that has
  already been applied makes the next run fail against every database that
  has it, while still passing against a fresh one — so whoever made the edit
  sees green and somebody else gets the failure. To correct an applied
  script, add a new versioned script that fixes it.
- **A repeatable script is the normal home for a function definition.** The
  insert/update/get/delete functions above live here, so a change to one is
  an ordinary edit and a readable diff, not a new file each time.
- A versioned script does structure: create a table, add a column, add an
  index, backfill. A repeatable script does the functions.
- Both are checked in and travel with the code that needs them. A schema
  change and the use case that depends on it belong in the same change.

## What is enforced

- `immutable-migrations` denies rewriting a versioned script that already
  exists in the repository, and stays silent for a brand-new one and for
  every repeatable script. The globs that tell the two apart are project
  configuration (`immutableMigrations`), because the naming convention
  belongs to a repository, not to guard code.
- `protected-paths` covers configuration files carrying connection strings
  and secrets.

Not mechanically enforced, and left to review: `CommandType.Text`, the
explicit `DbType` on each parameter, passing the ambient transaction,
snake_case identifiers, and that a repository returns entities rather than
DTOs. Each is a real rule; each needs to read intent out of a SQL string or
a call site, which text matching does badly enough that the guard would fire
on correct code — and a rule that fires on correct code gets switched off.

---

# Code documentation

Status: Active — binding

How code is commented, across every repository this infrastructure is
installed into. Part of it is mechanically enforced by a guard
(`core/guards/doc-comment-style.js` and its Codex equivalent); the rest is a
review standard an agent is expected to hold itself to without being asked
each time. This
document is meant to stand on its own — it is what `docs/internal/
CONTRACTS.md` §12 points at, and a reader should not need anything else to
follow it.

## The short version

- A doc block is a **short summary plus `@`-tags**, not an essay.
- **`@example` is forbidden** — the tests and the signature already show how
  something is called, and the guard in this repository denies it outright.
- **Every member of a type gets its own inline doc block**, with a blank line
  between each comment-member pair.
- **A block that covers more than one item becomes a list**, not a paragraph.
- Documentation states **what the code does and why**, never where to use it.
- Inline `//` comments explain **why**, never what the line already says.

## What gets documented

Document something when a reader cannot get the answer from its signature
alone:

- every exported function, hook, component and type;
- every member of an exported type, interface or class;
- a module-level constant whose meaning is not obvious from its name;
- a non-obvious decision inside a function, as an inline comment.

Do not document what the name already says. A wrapper whose signature tells
the whole story needs nothing added to it:

```ts
export const isEmpty = (value: string) => value.trim().length === 0;
```

## Frontend (TypeScript / TSX)

A doc block leads with a short summary, adds a second short paragraph only
when there is a genuine *why*, and closes with the tags the signature needs:

```ts
/**
 * Resolves a display label for an entity, falling back through its optional
 * naming fields.
 *
 * The fallback order matters: a caller-supplied override wins over stored
 * values so a renamed entity shows its new name before the store catches up.
 *
 * @param entity Entity to label.
 * @param override Label to prefer when provided.
 * @returns The resolved label, or an empty string when nothing is set.
 */
```

A block documenting more than one rule, case or step is a list, not a
paragraph:

```ts
/**
 * Applies a pending change to the store.
 *
 * - a partial write keeps the fields it omits
 * - writing the tracked field bumps its revision, and nothing else does
 * - a change with no target is discarded rather than queued
 */
```

- **Always JSDoc `/** ... */`**, never a stack of `//` lines, for exported
  functions, hooks, types and non-obvious members.
- **Use the `@`-tags, and use them fully:**
  - `@param` for every positional parameter;
  - `@returns`, present even when the return type is `void`;
  - `@template` for every generic parameter;
  - `@throws` and `@deprecated` where they apply.
- **`@example` is forbidden.** A guard denies it outright.
- **A block covering more than one item must be a list, not a paragraph.**
  Members, rules, cases and steps go in `-` bullets or a numbered `Flow:`.
  Continuous prose is only for a single, genuinely continuous explanation,
  and it may run long in that case — prose that is really an unlabelled
  enumeration is what this rule rejects.
- **Every member of a type, interface or class carries its own inline
  `/** ... */`, with a blank line between each comment and its member:**

  ```ts
  /** comment */
  property;

  /** comment */
  property;
  ```

  The blank line is not cosmetic — a comment block glued directly to the
  next member reads as porridge. Listing the members in the block above the
  type instead of on themselves is wrong: an IDE shows nothing when hovering
  a field that way, only when hovering the type.
- **The type's own block stays a short summary** — what the thing is, and a
  why-sentence if one is needed. It must not re-list members that are
  already documented on themselves.
- **State behaviour, not usage.** No "useful for X" pitches, and no
  enumerating the screens, editors or cases where something happens to
  matter.
- **The same applies to a plain object exported as a namespace of
  helpers**: each key carries its own inline block, and the object itself
  gets a short summary rather than a re-listing of its keys.

## Backend (.NET)

- **`/// <summary>`**, with `<param>`, `<returns>`, `<typeparam>` and
  `<exception>` as they apply.
- **A JSDoc-style `/** ... */` block in a `.cs` file is wrong.** A guard
  denies it.
- The same brevity and the same no-usage-pitch rule as the frontend side
  apply — state what the member does, not where it happens to be called
  from.

## Never reference a ticket number in a source file

No ticket or work-item id anywhere inside a source file: not in a doc block,
not in an inline comment, not in a test name or a test comment, not in a
string. Not a `#`-prefixed number, not a `task_`-prefixed number, not a
sentence that names the regression by its tracker id.

Describe the actual behaviour or defect instead — a sentence describing what
the code does, or what actually went wrong, stays useful long after the
ticket has been closed and forgotten; the ticket id does not. Ticket ids
belong in the pull request and in the tracker, never in the code.

## Inline comments

Explain **why**, never restate what the line already says. Two or three
lines is the norm; about six lines is the ceiling. Anything longer belongs
in the JSDoc or XML doc of the thing being called, or does not belong in the
comment at all.

```ts
// Bad — restates the code.
// Increment the counter by one.
counter += 1;

// Good — explains a decision the code cannot show.
// The server counts a retry as a separate attempt, so the local counter has to
// advance before the request goes out or the two drift apart.
counter += 1;
```

**Delete commented-out code rather than leaving it behind** — version
control already remembers it, and a comment is not the place to keep it "just
in case".

**Never name a specific customer, screen or environment** in a comment or a
doc block, in either language. It leaks context that belongs outside the
source tree into shared code, and it goes stale the moment the screen is
renamed or the customer no longer matters — describe the behaviour instead.

## Anti-patterns

| Anti-pattern | Why it is rejected |
| --- | --- |
| A routine `@example` block | Rots fastest, duplicates the tests — this repository's guard denies it outright |
| A wall of prose describing several members or rules | Should be a list; unreadable as a paragraph |
| Listing a type's members in the block above the type | The IDE then shows nothing when hovering a member |
| Doc blocks packed with no blank line between members | Turns into a solid grey block |
| "Useful for the X screen", "use this when building Y" | Usage advice rots when callers change; describe behavior |
| Naming a specific customer, screen or environment | Leaks context into shared code, and it goes stale |
| Restating the code in words | Adds volume, not information |
| A summary that describes the file's history or a past bug | Belongs in the commit message |

## Where the load falls in a well-split component

Following [`component-structure.md`](./component-structure.md) changes
where documentation is worth writing, not just how it looks:

- **A component's own `types.ts` carries most of it** — every member of
  every exported type gets its own block, blank line between pairs.
- **The hook documents what it manages and what it returns.**
- **A utility documents its behaviour and its edge cases.**
- **The view usually needs only a one-line summary**, because by the time
  a component is well split there is little left in it that a reader
  cannot already see from the markup and the props it takes.

A well-split component needs *less* prose than a tangled one — the file
names, the types and the function signatures already carry information
that would otherwise have to be spelled out in a comment.

## Instructions for AI agents

If you are an AI coding assistant working in a repository this document
applies to, treat this document as binding and apply it without being asked
again in each prompt.

- Follow this document for every file created or modified. When modifying
  an existing file, bring the parts actually touched up to this standard —
  do not rewrite the documentation of untouched code in the same change,
  which buries the real diff.
- When the surrounding file already follows an older style, match this
  document, not the file.
- Prefer deleting a stale comment over updating it into something vague. A
  missing comment costs a reader one lookup; a wrong one costs a bug.
- If an instruction elsewhere genuinely conflicts with this document, the
  other instruction wins — but say plainly, in whatever reports the work,
  that this standard was departed from and why.

## Review checklist

Before requesting review:

- [ ] Every exported symbol has a doc block.
- [ ] Every parameter has `@param`; `@returns` is present.
- [ ] No `@example` the signature, the tags and the tests already cover.
- [ ] Every member of a changed type has its own doc block, separated by
      blank lines.
- [ ] No doc block is a paragraph where it should be a list.
- [ ] Inline comments explain why, and none exceeds a few lines.
- [ ] No commented-out code, no customer, screen or environment names.

## What is mechanically enforced

`core/guards/doc-comment-style.js` (and the equivalent Codex hook) denies
`@example`, a JSDoc-style `/** ... */` block in a `.cs` file, and a ticket or
work-item id anywhere in newly written content, outright. It asks for
confirmation on a prose-only doc block over roughly 18 lines, more than 6
consecutive `//` lines, or a `.cs` member that takes parameters or returns a
value whose XML doc block is missing `<param>` or `<returns>`. The length
checks are a deliberate backstop, not a substitute for judgement — a guard
cannot tell a genuine long explanation from an unlabelled enumeration by
line count alone, so the list-vs-prose call always stays with whoever is
writing or reviewing the code.

Not mechanically enforced: the blank line between a type's members, that a
type's own block does not re-list its members, `@param`/`@returns`
completeness on the frontend side (only the backend's `<param>`/`<returns>`
tags are checked), and the "state behaviour, not usage" rule. These stay a
review standard the guard cannot judge from written text alone.

---

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
