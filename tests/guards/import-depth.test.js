"use strict";

/**
 * `import-depth` — the rule that turns `../../../../utils/storage` into
 * `@/utils/storage`.
 *
 * The negative cases carry the weight here, as they do for every structural
 * rule. This one sits on the single most common statement in a frontend
 * file, so anything short of a genuinely unreadable specifier has to pass:
 * one and two levels up, a bare package, a project with no alias configured
 * at all, an existing file, and a climb that lands outside every declared
 * root.
 */

const { suite } = require("../harness");
const rule = require("../../core/guards/import-depth");
const { decide, decision, PROJECT_MINIMAL } = require("./_ctx");

/** A project that has adopted a single `@` alias pointing at its source root. */
const PROJECT = {
  conventions: {
    componentFolders: "src/components/**",
    sourceRoots: ["src"],
    language: "javascript",
    pathAliases: { "@": "src" },
  },
};

/**
 * Builds a context for one write.
 *
 * @param {string} rel The repo-relative path being written.
 * @param {string} content The file's content.
 * @param {{existing?: string, project?: object}} [options] `existing` makes
 * the file already present on disk; `project` overrides the fixture above.
 * @returns {object} The context fields `decide` needs.
 */
function write(rel, content, options) {
  const opts = options || {};
  const existing = typeof opts.existing === "string" ? opts.existing : null;
  return {
    toolName: "Write",
    filePath: `/repo/${rel}`,
    content,
    cwd: "/repo",
    git: { repoRoot: "/repo" },
    files: existing === null ? {} : { [`/repo/${rel}`]: existing },
    project: opts.project || PROJECT,
    stack: "frontend",
  };
}

/** The path a deeply nested component actually sits at in a real tree. */
const NESTED = "src/components/Configuration/ServiceInspection/PestTypes/AddEditPestType.jsx";

suite("guards/import-depth", ({ test, eq, ok }) => {
  /* ------------------------------------------------------------- positive */

  test("a specifier climbing four folders denies", () => {
    const content = 'import { getPestTypes } from "../../../../utils/storage";';
    eq(decide(rule, write(NESTED, content)), "deny");
  });

  test("the denial names the aliased replacement", () => {
    const content = 'import { getPestTypes } from "../../../../utils/storage";';
    const d = decision(rule, write(NESTED, content));
    ok(d.fix.includes('"@/utils/storage"'), `fix should name the aliased form, got: ${d.fix}`);
  });

  test("the denial names the offending specifier and how far it climbs", () => {
    const content = 'import { getPestTypes } from "../../../../utils/storage";';
    const d = decision(rule, write(NESTED, content));
    ok(d.reason.includes("../../../../utils/storage"), "reason should quote the specifier");
    ok(d.reason.includes("4 folders"), `reason should give the climb count, got: ${d.reason}`);
  });

  test("exactly the threshold — three levels — denies", () => {
    const content = 'import { Table } from "../../../components/Common/Table";';
    eq(decide(rule, write("src/pages/configuration/PestTypes/PestTypes.jsx", content)), "deny");
  });

  test("a deep re-export denies the same way an import does", () => {
    const content = 'export { formatStatus } from "../../../../utils/format";';
    eq(decide(rule, write(NESTED, content)), "deny");
  });

  test("a deep require() denies", () => {
    const content = 'const storage = require("../../../../utils/storage");';
    eq(decide(rule, write(NESTED, content)), "deny");
  });

  test("a deep dynamic import() denies", () => {
    const content = 'const load = () => import("../../../../utils/storage");';
    eq(decide(rule, write(NESTED, content)), "deny");
  });

  test("a deep side-effect import denies", () => {
    const content = 'import "../../../../assets/styles.css";';
    eq(decide(rule, write(NESTED, content)), "deny");
  });

  test("a deep type-only import denies — it is just as unreadable", () => {
    const content = 'import type { PestType } from "../../../../types/pest";';
    eq(decide(rule, write("src/components/a/b/c/Card.tsx", content)), "deny");
  });

  test("a .ts file is judged the same as a .jsx one", () => {
    const content = 'import { storage } from "../../../../utils/storage";';
    eq(decide(rule, write("src/components/a/b/c/useCard.ts", content)), "deny");
  });

  test("the longest matching alias root wins", () => {
    const project = {
      conventions: {
        pathAliases: { "@": "src", "@components": "src/components" },
      },
    };
    const content = 'import { Table } from "../../../Common/Table";';
    const d = decision(rule, write("src/components/a/b/c/Card.jsx", content, { project }));
    eq(d.action, "deny");
    ok(d.fix.includes('"@components/Common/Table"'), `expected the specific alias, got: ${d.fix}`);
  });

  /* ------------------------------------------------------------- negative */

  test("one level up is ordinary composition", () => {
    const content = 'import { Row } from "../Row";';
    eq(decide(rule, write(NESTED, content)), "pass");
  });

  test("two levels up is still ordinary composition", () => {
    const content = 'import { formatStatus } from "../../utils/format";';
    eq(decide(rule, write(NESTED, content)), "pass");
  });

  test("a same-folder specifier passes", () => {
    const content = 'import useAddEditPestType from "./useAddEditPestType";';
    eq(decide(rule, write(NESTED, content)), "pass");
  });

  test("an already-aliased specifier passes", () => {
    const content = 'import { storage } from "@/utils/storage";';
    eq(decide(rule, write(NESTED, content)), "pass");
  });

  test("a bare package specifier passes", () => {
    const content = 'import { useState } from "react";';
    eq(decide(rule, write(NESTED, content)), "pass");
  });

  test("a project declaring no path alias never hears from this rule", () => {
    const project = { conventions: { componentFolders: "src/components/**", language: "javascript" } };
    const content = 'import { storage } from "../../../../utils/storage";';
    eq(decide(rule, write(NESTED, content, { project })), "pass");
  });

  test("an empty pathAliases map is the same as none", () => {
    const project = { conventions: { pathAliases: {} } };
    const content = 'import { storage } from "../../../../utils/storage";';
    eq(decide(rule, write(NESTED, content, { project })), "pass");
  });

  test("a project with no config at all stays silent", () => {
    const content = 'import { storage } from "../../../../utils/storage";';
    eq(decide(rule, write(NESTED, content, { project: PROJECT_MINIMAL })), "pass");
  });

  test("an existing file is not relitigated — rewriting its imports is a refactor", () => {
    const content = 'import { storage } from "../../../../utils/storage";';
    eq(decide(rule, write(NESTED, content, { existing: "old content" })), "pass");
  });

  test("a climb landing clear of every declared root has no aliased form to ask for", () => {
    const content = 'import { config } from "../../../../../shared/config";';
    eq(decide(rule, write(NESTED, content)), "pass");
  });

  test("a climb reaching a repo-root folder beside the alias root passes", () => {
    const content = 'import { helper } from "../../../../../scripts/helper";';
    eq(decide(rule, write(NESTED, content)), "pass");
  });

  test("a deep climb that still lands inside the alias root denies, however it is spelled", () => {
    // Four levels up from this folder is `src/`, so `src/scripts/helper` is
    // still aliasable — the climb count is not what decides it, the target is.
    const content = 'import { helper } from "../../../../scripts/helper";';
    const d = decision(rule, write(NESTED, content));
    eq(d.action, "deny");
    ok(d.fix.includes('"@/scripts/helper"'), `fix should name the aliased form, got: ${d.fix}`);
  });

  test("a spec file is left alone — its fixtures reach where they must", () => {
    const content = 'import { storage } from "../../../../utils/storage";';
    eq(decide(rule, write("src/components/a/b/__tests__/Card.test.jsx", content)), "pass");
  });

  test("a non-module file is out of scope", () => {
    const content = '@import "../../../../assets/scss/app";';
    eq(decide(rule, write("src/components/a/b/c/Card.module.scss", content)), "pass");
  });

  test("a deep specifier written only in a line comment is not an import", () => {
    const content = '// was: import { storage } from "../../../../utils/storage";\nexport const x = 1;';
    eq(decide(rule, write(NESTED, content)), "pass");
  });

  test("a deep specifier written only in a block comment is not an import", () => {
    const content = '/* import { storage } from "../../../../utils/storage"; */\nexport const x = 1;';
    eq(decide(rule, write(NESTED, content)), "pass");
  });

  test("empty content passes", () => {
    eq(decide(rule, write(NESTED, "   \n")), "pass");
  });

  test("an inner .. that is only a normalisation artefact does not count as a climb", () => {
    const content = 'import { Row } from "../Row/../Row";';
    eq(decide(rule, write(NESTED, content)), "pass");
  });

  test("a project raising its own threshold silences a three-level climb", () => {
    const project = {
      conventions: { pathAliases: { "@": "src" } },
      limits: { relativeImportDepth: 5 },
    };
    const content = 'import { formatStatus } from "../../../utils/format";';
    eq(decide(rule, write("src/components/a/b/c/Card.jsx", content, { project })), "pass");
  });

  test("a project lowering its own threshold catches a two-level climb", () => {
    const project = {
      conventions: { pathAliases: { "@": "src" } },
      limits: { relativeImportDepth: 2 },
    };
    const content = 'import { formatStatus } from "../../utils/format";';
    eq(decide(rule, write("src/components/a/b/Card.jsx", content, { project })), "deny");
  });

  test("a nonsensical configured threshold falls back to the default rather than firing on everything", () => {
    const project = {
      conventions: { pathAliases: { "@": "src" } },
      limits: { relativeImportDepth: 0 },
    };
    const content = 'import { Row } from "./Row";';
    eq(decide(rule, write("src/components/a/b/Card.jsx", content, { project })), "pass");
  });

  /* ------------------------------------------------------------- override */

  test("an override can soften the deny to an ask", () => {
    const content = 'import { storage } from "../../../../utils/storage";';
    const ctx = write(NESTED, content);
    ctx.overrideSpec = { "import-depth": { action: "ask" } };
    eq(decide(rule, ctx), "ask");
  });

  test("an override can switch it off entirely", () => {
    const content = 'import { storage } from "../../../../utils/storage";';
    const ctx = write(NESTED, content);
    ctx.overrideSpec = { "import-depth": { action: "off" } };
    eq(decide(rule, ctx), "pass");
  });
});
