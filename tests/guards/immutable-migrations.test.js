"use strict";

/**
 * `immutable-migrations` fires on exactly one combination: a write, to a
 * path a project declared immutable, to a file that already existed. Every
 * other combination is ordinary work, so the negative cases below carry the
 * weight — above all "writing the NEXT versioned script", which shares a
 * glob with every script already applied and must never be blocked.
 *
 * `classifyChange` is injected throughout, the same way
 * `legacy-advisory.test.js` injects it, so none of this needs a real git
 * repository — `tests/lib/change-scope.test.js` covers the real resolution.
 */

const { suite } = require("../harness");
const { evaluate } = require("../../core/engine");
const { makeCtx, PROJECT_MINIMAL } = require("./_ctx");
const rule = require("../../core/guards/immutable-migrations");

/** The shipped shape: Evolve's versioned scripts, denied; repeatables absent. */
const MIGRATIONS = [
  {
    path: "**/Database/Scripts/V*__*.sql",
    action: "deny",
    reason: "Evolve checksums a versioned script once it has run",
  },
];

/** An existing versioned script — the one file this rule exists to protect. */
const APPLIED = "/repo/Softela.PestManagement.Infrastructure/Database/Scripts/V1_0_0_05__add_modified_by.sql";

/**
 * Runs the rule through the engine with an injected change classification.
 *
 * @param {"new" | "existing" | "unknown"} scope What `classifyChange` answers.
 * @param {object} [partial] Context fields for `makeCtx`.
 * @returns {string} `"deny"`, `"ask"` or `"pass"`.
 */
function decideWith(scope, partial = {}) {
  const ctx = makeCtx({
    toolName: "Write",
    project: { immutableMigrations: MIGRATIONS },
    ...partial,
  });
  const result = evaluate(ctx, { rules: [rule], classifyChange: () => scope });
  return result ? result.action : "pass";
}

suite("guards/immutable-migrations", ({ test, eq, ok }) => {
  // Positive — the whole point of the rule.
  const denyCases = [
    { label: "denies a Write over an existing versioned script", toolName: "Write" },
    { label: "denies an Edit of an existing versioned script", toolName: "Edit" },
    { label: "denies a MultiEdit of an existing versioned script", toolName: "MultiEdit" },
    { label: "denies through the Codex apply_patch tool name", toolName: "apply_patch" },
    { label: "denies through the Codex write_file tool name", toolName: "write_file" },
  ];

  for (const c of denyCases) {
    test(c.label, () => {
      eq(decideWith("existing", { toolName: c.toolName, filePath: APPLIED }), "deny");
    });
  }

  const passCases = [
    // Negative — THE case that decides whether this rule survives contact
    // with real work. The next migration is a new file matching the same
    // glob as every applied one; blocking it would make the rule useless.
    {
      label: "passes writing the next versioned script, which does not yet exist",
      scope: "new",
      filePath: "/repo/Softela.PestManagement.Infrastructure/Database/Scripts/V1_0_0_28__create_ops_visits.sql",
    },
    {
      label: "passes a brand-new script even at a version below existing ones",
      scope: "new",
      filePath: "/repo/Softela.PestManagement.Infrastructure/Database/Scripts/V1_0_0_02__create_customers.sql",
    },

    // Negative — a repeatable script is meant to be edited in place, and is
    // outside the configured glob however often it is rewritten.
    {
      label: "passes editing an existing repeatable script",
      scope: "existing",
      filePath: "/repo/Softela.PestManagement.Infrastructure/Database/Scripts/R__GetCustomerById.sql",
    },
    {
      label: "passes editing an existing repeatable upsert script",
      scope: "existing",
      filePath: "/repo/Softela.PestManagement.Infrastructure/Database/Scripts/R__UpsertCustomer.sql",
    },

    // Negative — a file whose pre-existence was never established. Both
    // answers mean "not proved to pre-exist" and must not block a write.
    { label: "passes when the change scope is unknown", scope: "unknown", filePath: APPLIED },

    // Negative — ordinary source files that happen to sit near migrations.
    {
      label: "passes an existing repository class",
      scope: "existing",
      filePath: "/repo/Softela.PestManagement.Infrastructure/Database/Repositories/CustomerRepository.cs",
    },
    {
      label: "passes an existing handler",
      scope: "existing",
      filePath: "/repo/Softela.PestManagement.Application/Commands/Customer/CreateCustomer/CreateCustomerHandler.cs",
    },
    {
      label: "passes a .sql file outside the configured scripts directory",
      scope: "existing",
      filePath: "/repo/docs/examples/V1_0_0_01__example.sql",
    },
    {
      label: "passes a file whose name only starts like a version prefix",
      scope: "existing",
      filePath: "/repo/Softela.PestManagement.Infrastructure/Database/Scripts/Validate.sql",
    },

    // Negative — no file path at all, the shape a shell tool call arrives in.
    { label: "passes a write with no file path", scope: "existing", filePath: "" },
  ];

  for (const c of passCases) {
    test(c.label, () => {
      eq(decideWith(c.scope, { filePath: c.filePath }), "pass");
    });
  }

  // Negative — silent in a repository nobody has configured, which is what
  // makes this rule safe to ship to every repository at once.
  test("stays silent for a project that declares nothing", () => {
    const ctx = makeCtx({ toolName: "Write", filePath: APPLIED, project: PROJECT_MINIMAL });
    eq(evaluate(ctx, { rules: [rule], classifyChange: () => "existing" }), null);
  });

  test("stays silent when immutableMigrations is an empty list", () => {
    eq(decideWith("existing", { filePath: APPLIED, project: { immutableMigrations: [] } }), "pass");
  });

  test("stays silent when an entry is switched off", () => {
    eq(
      decideWith("existing", {
        filePath: APPLIED,
        project: { immutableMigrations: [{ path: "**/Database/Scripts/V*__*.sql", action: "off" }] },
      }),
      "pass",
    );
  });

  test("a malformed entry is skipped rather than throwing", () => {
    eq(
      decideWith("existing", {
        filePath: APPLIED,
        project: { immutableMigrations: [null, { path: 42 }, MIGRATIONS[0]] },
      }),
      "deny",
    );
  });

  // The configured action is honoured, not just its strongest setting.
  test("honours an entry configured to ask", () => {
    eq(
      decideWith("existing", {
        filePath: APPLIED,
        project: { immutableMigrations: [{ path: "**/Database/Scripts/V*__*.sql", action: "ask" }] },
      }),
      "ask",
    );
  });

  test("clamps to ask under a developer override", () => {
    eq(
      decideWith("existing", {
        filePath: APPLIED,
        overrideSpec: { "immutable-migrations": { action: "ask" } },
      }),
      "ask",
    );
  });

  test("reports the configured reason and a fix that names the way forward", () => {
    const ctx = makeCtx({
      toolName: "Edit",
      filePath: APPLIED,
      project: { immutableMigrations: MIGRATIONS },
    });
    const result = evaluate(ctx, { rules: [rule], classifyChange: () => "existing" });
    eq(result.ruleId, "immutable-migrations");
    eq(result.reason, "Evolve checksums a versioned script once it has run");
    ok(/new versioned migration/i.test(result.fix), "fix points at adding a new script");
  });

  // The engine only computes changeScope when a candidate rule asks for it;
  // this rule asks through `readsChangeScope`, never `newCodeOnly` — which
  // would soften in the opposite direction.
  test("declares readsChangeScope and not newCodeOnly", () => {
    eq(rule.readsChangeScope, true);
    eq(rule.newCodeOnly, undefined);
  });

  test("the engine classifies the change for this rule", () => {
    const calls = [];
    const ctx = makeCtx({ toolName: "Write", filePath: APPLIED, project: { immutableMigrations: MIGRATIONS } });
    evaluate(ctx, {
      rules: [rule],
      classifyChange: (filePath) => {
        calls.push(filePath);
        return "existing";
      },
    });
    eq(calls.length, 1);
    eq(calls[0], APPLIED);
  });

  // Stack-agnostic by construction: a .sql path resolves to no stack under
  // the default extension lists, so any `stacks` field would silence this.
  test("declares no stacks, so a .sql path is never filtered out", () => {
    eq(rule.stacks, undefined);
  });
});
