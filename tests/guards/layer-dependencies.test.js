"use strict";

/**
 * `layer-dependencies` denies a reference pointing outward through the
 * configured layer ordering. The negative cases carry the weight: every
 * inward and same-layer reference, every third-party namespace, and every
 * project that sits outside the ordering entirely must stay silent, or the
 * rule fires on ordinary work and gets switched off.
 */

const { suite } = require("../harness");
const { PROJECT_MINIMAL, decide, decision } = require("./_ctx");
const rule = require("../../core/guards/layer-dependencies");

/** The shipped backend preset's ordering, innermost first. */
const LAYERS = [
  { name: "Domain", paths: ["**/*.Domain/**"], token: "Domain" },
  { name: "Application", paths: ["**/*.Application/**"], token: "Application" },
  { name: "Infrastructure", paths: ["**/*.Infrastructure/**"], token: "Infrastructure" },
  { name: "Api", paths: ["**/*.API/**", "**/*.Api/**"], token: "API" },
];

/** A backend project carrying that ordering. */
const BACKEND = { stack: "backend", conventions: { language: "csharp", layers: LAYERS } };

const DOMAIN = "/repo/Acme.Billing.Domain/Entities/Invoice.cs";
const APPLICATION = "/repo/Acme.Billing.Application/Commands/Invoice/CreateInvoice/CreateInvoiceHandler.cs";
const INFRASTRUCTURE = "/repo/Acme.Billing.Infrastructure/Database/Repositories/InvoiceRepository.cs";

/**
 * Runs the rule with the backend ordering configured.
 *
 * @param {object} partial Context fields for this case.
 * @returns {string} `"deny"`, `"ask"` or `"pass"`.
 */
function run(partial) {
  return decide(rule, { toolName: "Write", project: BACKEND, ...partial });
}

suite("guards/layer-dependencies", ({ test, eq, ok }) => {
  // Positive — a reference that points outward, at each layer boundary.
  const denyCases = [
    {
      label: "denies Domain reaching into Application",
      filePath: DOMAIN,
      content: "using Acme.Billing.Application.Repositories;\n\nnamespace Acme.Billing.Domain.Entities;\n",
    },
    {
      label: "denies Domain reaching into Infrastructure",
      filePath: DOMAIN,
      content: "using Acme.Billing.Infrastructure.Database;\n",
    },
    {
      label: "denies Application reaching into Infrastructure",
      filePath: APPLICATION,
      content: "using Acme.Billing.Infrastructure.Database.Repositories;\n",
    },
    {
      label: "denies Application reaching into the API layer",
      filePath: APPLICATION,
      content: "using Acme.Billing.API.Middleware;\n",
    },
    {
      label: "denies Infrastructure reaching into the API layer",
      filePath: INFRASTRUCTURE,
      content: "using Acme.Billing.API.Controllers;\n",
    },
    {
      label: "denies a global using pointing outward",
      filePath: DOMAIN,
      content: "global using Acme.Billing.Application.Dtos;\n",
    },
    {
      label: "denies a static using pointing outward",
      filePath: DOMAIN,
      content: "using static Acme.Billing.Application.Core.Constants;\n",
    },
    {
      label: "denies an aliased using pointing outward",
      filePath: DOMAIN,
      content: "using Repo = Acme.Billing.Infrastructure.Database.Repositories;\n",
    },
    {
      label: "denies a ProjectReference pointing outward",
      filePath: "/repo/Acme.Billing.Domain/Acme.Billing.Domain.csproj",
      content:
        '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    <ProjectReference Include="..\\Acme.Billing.Application\\Acme.Billing.Application.csproj" />\n  </ItemGroup>\n</Project>\n',
    },
    {
      label: "denies the outermost reference when a write names several layers",
      filePath: DOMAIN,
      content: "using Acme.Billing.Domain.Enums;\nusing Acme.Billing.Infrastructure.Database;\n",
    },
  ];

  for (const c of denyCases) {
    test(c.label, () => {
      eq(run({ filePath: c.filePath, content: c.content }), "deny");
    });
  }

  const passCases = [
    // Negative — every legitimate direction. These are the ordinary writes.
    {
      label: "passes Application referencing Domain",
      filePath: APPLICATION,
      content: "using Acme.Billing.Domain.Entities;\n",
    },
    {
      label: "passes Infrastructure referencing Application",
      filePath: INFRASTRUCTURE,
      content: "using Acme.Billing.Application.Repositories;\n",
    },
    {
      label: "passes Infrastructure referencing Domain",
      filePath: INFRASTRUCTURE,
      content: "using Acme.Billing.Domain.Entities;\n",
    },
    {
      label: "passes the API layer referencing everything inward",
      filePath: "/repo/Acme.Billing.API/Controllers/InvoiceController.cs",
      content:
        "using Acme.Billing.Application.Commands.Invoice.CreateInvoice;\nusing Acme.Billing.Infrastructure.Database;\nusing Acme.Billing.Domain.Enums;\n",
    },
    {
      label: "passes a same-layer reference",
      filePath: APPLICATION,
      content: "using Acme.Billing.Application.Dtos;\n",
    },
    {
      label: "passes Domain referencing only itself",
      filePath: DOMAIN,
      content: "using Acme.Billing.Domain.Enums;\n",
    },

    // Negative — third-party and framework namespaces name no layer.
    {
      label: "passes framework usings",
      filePath: DOMAIN,
      content: "using System;\nusing System.Collections.Generic;\nusing Microsoft.Extensions.Logging;\n",
    },
    {
      label: "passes a third-party namespace that merely contains a token as a substring",
      filePath: DOMAIN,
      content: "using Microsoft.ApplicationInsights;\nusing Acme.DomainEvents.Shared;\n",
    },

    // Negative — a commented-out using is not a using.
    {
      label: "passes a commented-out outward using",
      filePath: DOMAIN,
      content: "// using Acme.Billing.Infrastructure.Database;\n",
    },
    {
      label: "passes an outward namespace named only in prose",
      filePath: DOMAIN,
      content: "// The Acme.Billing.Infrastructure layer implements this interface.\n",
    },

    // Negative — a file in no configured layer has no ordering to break.
    {
      label: "passes a file in a hosting project outside the ordering",
      filePath: "/repo/Acme.Billing.AppHost/Program.cs",
      content: "using Acme.Billing.Infrastructure.Database;\nusing Acme.Billing.API.Controllers;\n",
    },
    {
      label: "passes a file in a test project outside the ordering",
      filePath: "/repo/Acme.Billing.Tests/InvoiceTests.cs",
      content: "using Acme.Billing.Infrastructure.Database;\n",
    },

    // Negative — a non-source, non-project file is never scanned.
    {
      label: "passes a markdown file naming an outward namespace",
      filePath: "/repo/Acme.Billing.Domain/README.md",
      content: "using Acme.Billing.Infrastructure.Database;\n",
    },

    // Negative — silent without configuration, in a frontend repo, and on
    // an ordering too short to have a direction.
    { label: "stays silent for a project that declares nothing", filePath: DOMAIN, content: "using Acme.Billing.Infrastructure.X;\n", project: PROJECT_MINIMAL },
    {
      label: "stays silent when only one layer is configured",
      filePath: DOMAIN,
      content: "using Acme.Billing.Infrastructure.X;\n",
      project: { stack: "backend", conventions: { language: "csharp", layers: [LAYERS[0]] } },
    },
  ];

  for (const c of passCases) {
    test(c.label, () => {
      eq(
        decide(rule, {
          toolName: "Write",
          project: c.project !== undefined ? c.project : BACKEND,
          filePath: c.filePath,
          content: c.content,
        }),
        "pass",
      );
    });
  }

  // Stack scoping: the ordering is the backend layout's own.
  test("stays silent on a frontend stack", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        project: { stack: "frontend", conventions: { language: "typescript", layers: LAYERS } },
        filePath: DOMAIN,
        content: "using Acme.Billing.Infrastructure.Database;\n",
      }),
      "pass",
    );
  });

  test("a malformed layer entry is skipped rather than throwing", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        project: {
          stack: "backend",
          conventions: {
            language: "csharp",
            layers: [null, { name: "Domain", paths: ["**/*.Domain/**"], token: "Domain" }, { name: "Application", paths: ["**/*.Application/**"], token: "Application" }],
          },
        },
        filePath: DOMAIN,
        content: "using Acme.Billing.Application.Dtos;\n",
      }),
      "deny",
    );
  });

  test("clamps to ask under a developer override", () => {
    eq(
      run({
        filePath: DOMAIN,
        content: "using Acme.Billing.Application.Dtos;\n",
        overrideSpec: { "layer-dependencies": { action: "ask" } },
      }),
      "ask",
    );
  });

  test("names both layers and the offending reference, and suggests the inversion", () => {
    const result = decision(rule, {
      toolName: "Write",
      project: BACKEND,
      filePath: APPLICATION,
      content: "using Acme.Billing.Infrastructure.Database.Repositories;\n",
    });
    eq(result.ruleId, "layer-dependencies");
    ok(/Application must not reference Infrastructure/.test(result.reason), "reason names both layers");
    ok(/Acme\.Billing\.Infrastructure\.Database\.Repositories/.test(result.reason), "reason quotes the reference");
    ok(/abstraction/i.test(result.fix), "fix points at inverting the dependency");
  });
});
