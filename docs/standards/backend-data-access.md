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
