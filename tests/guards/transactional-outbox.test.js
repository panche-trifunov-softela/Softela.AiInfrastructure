"use strict";

/**
 * `transactional-outbox` fires on a handler that writes a domain event
 * outside the transaction carrying the data change.
 *
 * The negative cases matter more than usual here, because the rule's whole
 * risk is judging a fragment it cannot see the context of: a plain `Edit`
 * reports only the inserted text, and denying on that would block every
 * edit to a perfectly correct handler. Those cases are exercised below
 * through `files`, which is what the rule reads to reconstruct the file.
 */

const { suite } = require("../harness");
const { PROJECT_MINIMAL, decide, decision } = require("./_ctx");
const rule = require("../../core/guards/transactional-outbox");

/** The shipped backend preset's patterns. */
const TRANSACTIONS = {
  scope: "**/Commands/**",
  outboxInsert: "_outbox\\w*\\.InsertAsync",
  beginTransaction: "\\.BeginTransactionAsync\\b",
  commit: "\\.CommitAsync\\b",
};

const BACKEND = { stack: "backend", conventions: { language: "csharp", transactions: TRANSACTIONS } };

const HANDLER = "/repo/Acme.Billing.Application/Commands/Invoice/CreateInvoice/CreateInvoiceHandler.cs";

/** A correct handler: begin, write, outbox, commit, rollback and rethrow. */
const CORRECT = [
  "public async Task<int> Handle(CreateInvoiceRequest request, CancellationToken ct)",
  "{",
  "    var now = DateTimeOffset.UtcNow;",
  "    await _unitOfWork.BeginTransactionAsync(ct);",
  "    try",
  "    {",
  "        var id = await _invoiceRepository.CreateAsync(invoice);",
  "        await _outboxRepository.InsertAsync(OutboxMessageFactory.Create(evt, now));",
  "        await _unitOfWork.CommitAsync(ct);",
  "        return id;",
  "    }",
  "    catch",
  "    {",
  "        await _unitOfWork.RollbackAsync(ct);",
  "        throw;",
  "    }",
  "}",
].join("\n");

/** The same handler with the outbox insert moved after the commit. */
const AFTER_COMMIT = CORRECT.replace(
  "        await _outboxRepository.InsertAsync(OutboxMessageFactory.Create(evt, now));\n        await _unitOfWork.CommitAsync(ct);",
  "        await _unitOfWork.CommitAsync(ct);\n        await _outboxRepository.InsertAsync(OutboxMessageFactory.Create(evt, now));",
);

/** The same handler with no transaction at all. */
const NO_TRANSACTION = [
  "public async Task<int> Handle(CreateInvoiceRequest request, CancellationToken ct)",
  "{",
  "    var id = await _invoiceRepository.CreateAsync(invoice);",
  "    await _outboxRepository.InsertAsync(OutboxMessageFactory.Create(evt, DateTimeOffset.UtcNow));",
  "    return id;",
  "}",
].join("\n");

suite("guards/transactional-outbox", ({ test, eq, ok }) => {
  // Positive — a whole-file Write is the case the rule can always judge.
  test("denies an outbox insert with no transaction anywhere", () => {
    eq(decide(rule, { toolName: "Write", project: BACKEND, filePath: HANDLER, content: NO_TRANSACTION }), "deny");
  });

  test("denies an outbox insert written after the commit", () => {
    eq(decide(rule, { toolName: "Write", project: BACKEND, filePath: HANDLER, content: AFTER_COMMIT }), "deny");
  });

  test("denies through a reconstructed multi-part write", () => {
    eq(
      decide(rule, {
        toolName: "MultiEdit",
        project: BACKEND,
        filePath: HANDLER,
        content: "await _outboxRepository.InsertAsync(OutboxMessageFactory.Create(evt, now));",
        resultingContent: NO_TRANSACTION,
      }),
      "deny",
    );
  });

  // Positive — the plain-Edit route, reconstructed from what is on disk.
  test("denies an Edit that adds an outbox insert to a handler with no transaction", () => {
    eq(
      decide(rule, {
        toolName: "Edit",
        project: BACKEND,
        filePath: HANDLER,
        content: "        await _outboxRepository.InsertAsync(OutboxMessageFactory.Create(evt, now));",
        files: { [HANDLER]: "public async Task Handle()\n{\n    await _invoiceRepository.CreateAsync(invoice);\n}\n" },
      }),
      "deny",
    );
  });

  const passCases = [
    // Negative — THE case that decides whether this rule survives real use.
    // An edit inside a handler that already has its envelope must not deny
    // merely because the fragment does not repeat the begin.
    {
      label: "passes an Edit adding an outbox insert to a handler that already opens a transaction",
      toolName: "Edit",
      content: "        await _outboxRepository.InsertAsync(OutboxMessageFactory.Create(evt, now));",
      files: { [HANDLER]: CORRECT },
    },
    {
      label: "passes a whole-file write of a correct handler",
      toolName: "Write",
      content: CORRECT,
    },

    // Negative — a write that introduces no outbox insert is not judged at
    // all, whatever the rest of the file looks like.
    {
      label: "passes an edit elsewhere in a handler that has no transaction",
      toolName: "Edit",
      content: "        var total = lines.Sum(l => l.Amount);",
      files: { [HANDLER]: NO_TRANSACTION },
    },
    {
      label: "passes a handler that opens a transaction and writes no event",
      toolName: "Write",
      content: CORRECT.replace("        await _outboxRepository.InsertAsync(OutboxMessageFactory.Create(evt, now));\n", ""),
    },

    // Negative — outside the configured scope. A query handler reads.
    {
      label: "passes a query handler outside the Commands scope",
      toolName: "Write",
      filePath: "/repo/Acme.Billing.Application/Queries/Invoice/GetInvoices/GetInvoicesHandler.cs",
      content: NO_TRANSACTION,
    },
    {
      label: "passes the outbox processor itself, which lives outside Commands",
      toolName: "Write",
      filePath: "/repo/Acme.Billing.Application/Outbox/OutboxProcessorJob.cs",
      content: NO_TRANSACTION,
    },

    // Negative — not a C# source file.
    {
      label: "passes a markdown file describing the wrong shape",
      toolName: "Write",
      filePath: "/repo/Acme.Billing.Application/Commands/README.md",
      content: NO_TRANSACTION,
    },
  ];

  for (const c of passCases) {
    test(c.label, () => {
      eq(
        decide(rule, {
          toolName: c.toolName,
          project: BACKEND,
          filePath: c.filePath || HANDLER,
          content: c.content,
          files: c.files,
        }),
        "pass",
      );
    });
  }

  // Negative — silent without configuration, and on the frontend stack.
  test("stays silent for a project that declares nothing", () => {
    eq(decide(rule, { toolName: "Write", project: PROJECT_MINIMAL, filePath: HANDLER, content: NO_TRANSACTION }), "pass");
  });

  test("stays silent when the configured patterns are invalid", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        project: { stack: "backend", conventions: { transactions: { outboxInsert: "(unterminated", beginTransaction: "x" } } },
        filePath: HANDLER,
        content: NO_TRANSACTION,
      }),
      "pass",
    );
  });

  test("stays silent on a frontend stack", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        project: { stack: "frontend", conventions: { transactions: TRANSACTIONS } },
        filePath: HANDLER,
        content: NO_TRANSACTION,
      }),
      "pass",
    );
  });

  // The ordering check needs real offsets, so it is deliberately not run
  // when the file could only be approximated by concatenation.
  test("does not report the ordering case from a concatenated Edit view", () => {
    eq(
      decide(rule, {
        toolName: "Edit",
        project: BACKEND,
        filePath: HANDLER,
        content: "        await _outboxRepository.InsertAsync(OutboxMessageFactory.Create(evt, now));",
        files: { [HANDLER]: CORRECT },
      }),
      "pass",
    );
  });

  test("clamps to ask under a developer override", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        project: BACKEND,
        filePath: HANDLER,
        content: NO_TRANSACTION,
        overrideSpec: { "transactional-outbox": { action: "ask" } },
      }),
      "ask",
    );
  });

  test("the two failures report distinguishable reasons", () => {
    const missing = decision(rule, { toolName: "Write", project: BACKEND, filePath: HANDLER, content: NO_TRANSACTION });
    const late = decision(rule, { toolName: "Write", project: BACKEND, filePath: HANDLER, content: AFTER_COMMIT });
    eq(missing.ruleId, "transactional-outbox");
    ok(/opens no transaction/.test(missing.reason), "the no-transaction case says so");
    ok(/already committed/.test(late.reason), "the after-commit case says so");
  });
});
