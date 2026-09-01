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
