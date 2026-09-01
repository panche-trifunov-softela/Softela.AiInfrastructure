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
