"use strict";

const path = require("path");
const rule = require("../../core/guards/colocated-tests");
const { evaluate } = require("../../core/engine");
const { readJson } = require("../../core/lib/fs-safe");
const { suite } = require("../harness");
const { PROJECT_MINIMAL, decide, decision, makeGit, makeOverrides } = require("./_ctx");

/**
 * The real, shipped `Softela.Bugworx.json` — loaded from disk, not a
 * hand-written fixture, so the field-test case below exercises exactly the
 * config a real session resolves, `conventions` included only through the
 * engine's own frontend-stack preset merge.
 */
const REAL_FRONTEND_PROJECT = readJson(
  path.join(__dirname, "..", "..", "projects", "Softela.Bugworx.json"),
);

/**
 * Builds a context around a project object exactly as given — no merge onto
 * the hand-written `PROJECT` fixture `_ctx.js#makeCtx` always applies — so a
 * real project file's `stack` field drives the engine's own preset
 * resolution instead of a fixture's pre-baked `conventions`.
 *
 * `statFile` always answers `null`, the same as `readFile`: this helper
 * exercises the real, disk-loaded project config, not the filesystem probe,
 * so every case built through it is expected to fall back to the unmodified
 * lexical guess.
 *
 * @param {object} project The project config to evaluate against.
 * @param {object} partial Context fields for this case.
 * @returns {object} A frozen context.
 */
function realProjectCtx(project, partial) {
  return Object.freeze({
    event: "PreToolUse",
    agent: "claude",
    toolName: partial.toolName || "Write",
    input: {},
    command: "",
    filePath: partial.filePath || "",
    content: partial.content || "",
    cwd: "/repo",
    project,
    git: makeGit(partial.git),
    session: { model: "sonnet", effort: "high" },
    modules: new Set(),
    overrides: makeOverrides({}),
    raw: {},
    readFile: () => null,
    statFile: () => null,
  });
}

/**
 * Runs the rule against a real, disk-loaded project config.
 *
 * @param {object} testRule The rule module under test.
 * @param {object} project The project config to evaluate against.
 * @param {object} partial Context fields for this case.
 * @returns {string} `"deny"`, `"ask"` or `"pass"`.
 */
function decideReal(testRule, project, partial) {
  const result = evaluate(realProjectCtx(project, partial), { rules: [testRule] });
  return result ? result.action : "pass";
}

suite("guards/colocated-tests", ({ test, eq }) => {
  // --- field test: the real regression, against the real shipped config ---

  test("the field-regression test path denies against the real, disk-loaded Softela.Bugworx.json", () => {
    eq(
      decideReal(rule, REAL_FRONTEND_PROJECT, {
        toolName: "Write",
        filePath: "react-app/src/components/Common/StatusChip.test.jsx",
      }),
      "deny",
    );
  });

  test("the field-regression denial names the real subject in the fix", () => {
    const result = evaluate(
      realProjectCtx(REAL_FRONTEND_PROJECT, {
        toolName: "Write",
        filePath: "react-app/src/components/Common/StatusChip.test.jsx",
      }),
      { rules: [rule] },
    );
    eq(result.action, "deny");
    eq(result.fix.includes("StatusChip/__tests__/StatusChip.test.jsx"), true);
  });

  // --- positive: genuinely misplaced ---------------------------------------

  test("a test file in a distant test tree denies", () => {
    eq(decide(rule, { toolName: "Write", filePath: "tests/components/Button.test.tsx" }), "deny");
  });

  test("a nested child's test sitting in the parent's __tests__ folder denies", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/components/Button/__tests__/SubPart.test.tsx" }), "deny");
  });

  test("a test colocated directly beside the component, with no __tests__ folder, denies", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/components/Button/Button.test.tsx" }), "deny");
  });

  // --- negative: ordinary, correctly placed or out-of-scope work ----------

  test("a correctly placed component test passes", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/components/Button/__tests__/Button.test.tsx" }), "pass");
  });

  test("a correctly placed nested child component test passes", () => {
    eq(
      decide(rule, { toolName: "Write", filePath: "src/components/Button/SubPart/__tests__/SubPart.test.tsx" }),
      "pass",
    );
  });

  test("a correctly placed test three levels of nesting deep passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/SubPart/DeepChild/__tests__/DeepChild.test.tsx",
      }),
      "pass",
    );
  });

  test("an ordinary non-test source file passes", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/components/Button/Button.tsx" }), "pass");
  });

  // --- what a component folder owns: its hook, its utilities --------------
  //
  // testing.md's own OrderPanel example puts all three of these in the
  // component's __tests__; only the component itself has a folder of its own
  // to sit beside.

  test("a component's own hook test in the component's __tests__ passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/OrderPanel/__tests__/useOrderPanel.test.ts",
      }),
      "pass",
    );
  });

  test("a component's own utility test in the component's __tests__ passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/OrderPanel/__tests__/canEditOrder.test.ts",
      }),
      "pass",
    );
  });

  test("a utility test in a shared utils folder's own __tests__ passes", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/utils/__tests__/formatDate.test.ts" }), "pass");
  });

  test("a utility test in a distant test tree still denies", () => {
    eq(decide(rule, { toolName: "Write", filePath: "tests/utils/formatDate.test.ts" }), "deny");
  });

  test("a utility test beside the utility, with no __tests__ folder, denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/OrderPanel/utils/canEditOrder.test.ts",
      }),
      "deny",
    );
  });

  test("a misplaced utility test is pointed at its owner, not at a folder of its own", () => {
    const result = decision(rule, {
      toolName: "Write",
      filePath: "src/components/OrderPanel/utils/canEditOrder.test.ts",
    });
    eq(result.action, "deny");
    eq(result.fix.includes("canEditOrder/__tests__"), false);
    eq(result.fix.includes("canEditOrder"), true);
  });

  // --- a context: PascalCase, but with no folder of its own ---------------
  //
  // component-structure.md gives a context no folder: one lives in the
  // component folder beside the view, several live together in `contexts/`.
  // Both are legal, so neither may be refused, and neither may be answered
  // with a fix demanding a folder the standard never creates.

  test("a context test in the component's own __tests__ passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/OrderPanel/__tests__/OrderPanelContext.test.tsx",
      }),
      "pass",
    );
  });

  test("a context test in a contexts folder's own __tests__ passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/OrderPanel/contexts/__tests__/OrderPanelContext.test.tsx",
      }),
      "pass",
    );
  });

  test("a context test beside the context, with no __tests__ folder, denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/OrderPanel/OrderPanelContext.test.tsx",
      }),
      "deny",
    );
  });

  test("a misplaced context test is pointed at its owner, not at a folder of its own", () => {
    const result = decision(rule, {
      toolName: "Write",
      filePath: "src/components/OrderPanel/OrderPanelContext.test.tsx",
    });
    eq(result.action, "deny");
    eq(result.fix.includes("OrderPanelContext/__tests__"), false);
    eq(result.fix.includes("OrderPanelContext"), true);
  });

  test("a nested child component whose name merely ends in the context suffix is not mistaken for one", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/OrderPanel/__tests__/OrderPanelContextMenu.test.tsx",
      }),
      "deny",
    );
  });

  // --- PascalCase outside the component tree: types, enums, classes -------
  //
  // The demand for a folder of one's own is a component-folder convention and
  // is scoped to `conventions.componentFolders`. A PascalCase subject outside
  // that tree is a type, an enum or a class, none of which gets a folder.

  test("a type test in its own folder's __tests__ passes", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/types/__tests__/OrderStatus.test.ts" }), "pass");
  });

  test("a type test beside the type, with no __tests__ folder, denies", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/types/OrderStatus.test.ts" }), "deny");
  });

  test("a misplaced type test is not answered with a component folder it will never have", () => {
    const result = decision(rule, { toolName: "Write", filePath: "src/types/OrderStatus.test.ts" });
    eq(result.action, "deny");
    eq(result.fix.includes("OrderStatus/__tests__"), false);
    eq(result.fix.includes("OrderStatus"), true);
  });

  test("the component check still applies everywhere when the project declares no componentFolders", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/anywhere/__tests__/SubPart.test.tsx",
        project: { conventions: { testFolder: "__tests__" } },
      }),
      "deny",
    );
  });

  // --- component folders predating the PascalCase folder convention -------

  test("a component test whose folder differs from it only in casing passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/dtEditor/__tests__/DtEditor.test.tsx",
      }),
      "pass",
    );
  });

  test("a component test in a differently named folder still denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/dtEditor/__tests__/DtFieldCard.test.tsx",
      }),
      "deny",
    );
  });

  test("a cypress spec is excluded via notOurs", () => {
    eq(decide(rule, { toolName: "Write", filePath: "cypress/e2e/login.spec.ts" }), "pass");
  });

  test("silent when the project declares no testFolder convention", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "tests/components/Button.test.tsx",
        project: PROJECT_MINIMAL,
      }),
      "pass",
    );
  });

  // --- evasion -------------------------------------------------------------

  test("the .spec. spelling variant misplaced outside __tests__ still denies", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/components/Button/Button.spec.tsx" }), "deny");
  });

  // --- qualified test names (.integration., .a11y., .snapshot., ...) -------

  test("a correctly placed qualified test name passes", () => {
    eq(
      decide(rule, { toolName: "Write", filePath: "src/components/Button/__tests__/Button.integration.test.tsx" }),
      "pass",
    );
  });

  test("a correctly placed .a11y. qualified test name passes", () => {
    eq(
      decide(rule, { toolName: "Write", filePath: "src/components/Button/__tests__/Button.a11y.test.tsx" }),
      "pass",
    );
  });

  test("a correctly placed .spec. spelling passes, mirroring the .test. shape", () => {
    eq(
      decide(rule, { toolName: "Write", filePath: "src/components/Button/__tests__/Button.spec.tsx" }),
      "pass",
    );
  });

  test("a misplaced qualified test name still denies, naming the real subject in the fix", () => {
    const result = decision(rule, {
      toolName: "Write",
      filePath: "src/components/Button/Button.snapshot.test.tsx",
    });
    eq(result.action, "deny");
    eq(result.fix.includes("Button/"), true);
  });

  test("a different write tool creating the same misplaced test still denies", () => {
    eq(decide(rule, { toolName: "NotebookEdit", filePath: "tests/Button.test.tsx" }), "deny");
  });

  // --- repo-root resolution: case, separators and prefix boundaries -------

  test("matching root and file path spelling still denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:/repo/src/components/Button/Button.test.tsx",
        git: { repoRoot: "C:/repo" },
      }),
      "deny",
    );
  });

  test("a repo root and file path differing only in drive-letter case still denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "c:/repo/src/components/Button/Button.test.tsx",
        git: { repoRoot: "C:/repo" },
      }),
      "deny",
    );
  });

  test("a backslash-spelled file path against a forward-slash root still denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:\\repo\\src\\components\\Button\\Button.test.tsx",
        git: { repoRoot: "C:/repo" },
      }),
      "deny",
    );
  });

  test("a file genuinely outside the configured folder is excluded via notOurs and passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:/repo/cypress/e2e/login.spec.ts",
        git: { repoRoot: "C:/repo" },
      }),
      "pass",
    );
  });

  test("a path that merely resembles the root as a prefix of a longer directory name still evaluates the real trailing structure and passes when correctly placed", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:/repo-other/src/components/Button/__tests__/Button.test.tsx",
        git: { repoRoot: "C:/repo" },
      }),
      "pass",
    );
  });

  test("an unknown repository root still evaluates the real trailing structure and passes when correctly placed", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:/other/src/components/Button/__tests__/Button.test.tsx",
        git: { repoRoot: null },
      }),
      "pass",
    );
  });

  // --- filesystem probe: a component still in flat-file, legacy form -------
  //
  // `hasOwnFolder` guesses "owns a folder" from spelling alone. These cases
  // give the rule a spec whose own import proves the guess wrong — the
  // subject is a single flat file, not a folder — and check that the probe,
  // and only the probe, is what changes the outcome.
  //
  // Every `files` key here is an absolute path anchored under the fixture's
  // own repository root (`/repo`, `makeGit`'s default), matching exactly what
  // the rule hands `ctx.statFile` in production: a path built from
  // `(ctx.git && ctx.git.repoRoot) || ctx.cwd`, never from `ctx.cwd` alone.

  test("a flat-file component tested from the shared central __tests__, proven flat by its own import, passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/__tests__/StatusChip.test.tsx",
        content: 'import { StatusChip } from "../StatusChip";\n',
        files: { "/repo/src/components/StatusChip.tsx": "export const StatusChip = () => null;\n" },
      }),
      "pass",
    );
  });

  test("the same shared central __tests__ case still denies once the subject's own folder-shaped file is proven to exist", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/__tests__/StatusChip.test.tsx",
        content: 'import { StatusChip } from "../StatusChip";\n',
        files: { "/repo/src/components/StatusChip/StatusChip.tsx": "export const StatusChip = () => null;\n" },
      }),
      "deny",
    );
  });

  test("a flat-file component tested beside itself, proven flat by its own import, still denies but is pointed at its owner directly", () => {
    const result = decision(rule, {
      toolName: "Write",
      filePath: "src/components/StatusChip.test.tsx",
      content: 'import { StatusChip } from "./StatusChip";\n',
      files: { "/repo/src/components/StatusChip.tsx": "export const StatusChip = () => null;\n" },
    });
    eq(result.action, "deny");
    eq(result.fix.includes("StatusChip/__tests__"), false);
    eq(result.fix.includes("StatusChip"), true);
  });

  test("with no usable import, the probe falls back to the componentFolders literal prefix and still passes for a flat file", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/__tests__/StatusChip.test.tsx",
        files: { "/repo/src/components/StatusChip.tsx": "export const StatusChip = () => null;\n" },
      }),
      "pass",
    );
  });

  test("when the probe can establish nothing at all, an otherwise-identical denial is unchanged", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/__tests__/StatusChip.test.tsx",
        content: 'import { StatusChip } from "../StatusChip";\n',
        files: { "/repo/src/utils/formatDate.ts": "export const formatDate = () => '';\n" },
      }),
      "deny",
    );
  });

  test("an existing denial case is unaffected by an unrelated files fixture present in the same context", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/Button.test.tsx",
        files: { "/repo/src/utils/formatDate.ts": "export const formatDate = () => '';\n" },
      }),
      "deny",
    );
  });

  // --- regression: the probe must anchor on the repository root -----------
  //
  // In production `ctx.cwd` is not the repository root — `resolveWorkdir`
  // prefers the write's own nearest existing ancestor directory, which for a
  // spec file is that spec's own directory. `ctx.statFile` resolves a
  // relative path against `ctx.cwd`, never against the repository root, so a
  // probe that ever goes back to handing it a bare, repo-relative path would
  // ask about a location nested under the spec's own directory instead of
  // the real one, find nothing, and silently stop loosening anything. `cwd`
  // below is deliberately the spec's own directory, a genuine subdirectory of
  // `git.repoRoot`, to pin exactly that anchor.

  test("the probe finds the subject's flat file when ctx.cwd is the spec's own subdirectory, not the repository root", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/__tests__/StatusChip.test.tsx",
        cwd: "/repo/src/components/__tests__",
        git: { repoRoot: "/repo" },
        content: 'import { StatusChip } from "../StatusChip";\n',
        files: { "/repo/src/components/StatusChip.tsx": "export const StatusChip = () => null;\n" },
      }),
      "pass",
    );
  });

  // --- deriveCandidateDir: a same-named import must not shadow the subject ---
  //
  // More than one specifier can end in a segment that spells the subject's
  // own name — a mock or a fixture imported under the same name as the real
  // module. Picking whichever comes first in the file would let a mock's own
  // import point the probe at the wrong directory; the specifier that
  // resolves inside `conventions.componentFolders` must win instead.

  test("the probe follows the import that resolves inside componentFolders even when a same-named import appears first", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/__tests__/StatusChip.test.tsx",
        content:
          'import { StatusChip } from "../../mocks/StatusChip";\n' +
          'import { StatusChip } from "../StatusChip";\n',
        files: { "/repo/src/components/StatusChip.tsx": "export const StatusChip = () => null;\n" },
      }),
      "pass",
    );
  });

  // --- override --------------------------------------------------------------

  test("an override can turn the rule off entirely", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "tests/components/Button.test.tsx",
        overrideSpec: { "colocated-tests": { action: "off" } },
      }),
      "pass",
    );
  });

  test("an override can soften the denial to ask", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "tests/components/Button.test.tsx",
        overrideSpec: { "colocated-tests": { action: "ask" } },
      }),
      "ask",
    );
  });
});
