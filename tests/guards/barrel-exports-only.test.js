"use strict";

const rule = require("../../core/guards/barrel-exports-only");
const { suite } = require("../harness");
const { PROJECT_MINIMAL, decide } = require("./_ctx");

suite("guards/barrel-exports-only", ({ test, eq }) => {
  // --- positive: real logic in the barrel ----------------------------------

  test("a value declaration in an index.ts denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/index.ts",
        content: 'export const x = 1;\nexport { Button } from "./Button";\n',
      }),
      "deny",
    );
  });

  test("a side-effecting call in an index.ts denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/index.ts",
        content: 'import { Button } from "./Button";\nconsole.log("loaded");\n',
      }),
      "deny",
    );
  });

  test("an export default function declaration in an index.tsx denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/index.tsx",
        content: "export default function Button() { return null; }",
      }),
      "deny",
    );
  });

  test("a bare side-effect-only import with no binding denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/index.ts",
        content: 'import "./sideEffectInit";\nexport { Button } from "./Button";\n',
      }),
      "deny",
    );
  });

  test("a bare dynamic import() call used as a statement denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/index.ts",
        content: 'import("./sideEffectInit");\nexport { Button } from "./Button";\n',
      }),
      "deny",
    );
  });

  // --- negative: legitimate barrel content, or out of scope ---------------

  test("imports, re-exports, export type and comments pass", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/index.ts",
        content: [
          "// Public surface of the Button component.",
          'export { Button } from "./Button";',
          'export type { ButtonProps } from "./Button.types";',
          'export * from "./constants";',
        ].join("\n"),
      }),
      "pass",
    );
  });

  test("a re-export path containing a semicolon and a brace does not confuse the check", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/index.ts",
        content: 'export { Button } from "./weird;path{withBraces}/Button";',
      }),
      "pass",
    );
  });

  test("a default import bound to a name, followed by a re-export, passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/index.ts",
        content: 'import Button from "./Button";\nexport { Button };\n',
      }),
      "pass",
    );
  });

  test("a type-only import used only for a re-export passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/index.ts",
        content: 'import type { ButtonProps } from "./Button.types";\nexport type { ButtonProps };\n',
      }),
      "pass",
    );
  });

  test("a multi-line import spanning several lines passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/index.ts",
        content: ["import {", "  Button,", "  ButtonProps,", '} from "./Button";', "export { Button };"].join("\n"),
      }),
      "pass",
    );
  });

  test("a non-index file with executable code is out of scope for this rule", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/Button.tsx",
        content: "export const x = 1;",
      }),
      "pass",
    );
  });

  test("an index.ts outside the componentFolders convention is out of scope", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/services/api/index.ts",
        content: "export const x = 1;",
      }),
      "pass",
    );
  });

  test("an empty new index.ts passes", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/components/Button/index.ts", content: "" }), "pass");
  });

  test("silent when the project declares no componentFolders convention", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/index.ts",
        content: "export const x = 1;",
        project: PROJECT_MINIMAL,
      }),
      "pass",
    );
  });

  // --- evasion -------------------------------------------------------------

  test("removing whitespace around the illegal statement does not evade the check", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/index.ts",
        content: 'export const x=1;export{Button}from"./Button";',
      }),
      "deny",
    );
  });

  test("a different write tool writing the same executable barrel still denies", () => {
    eq(
      decide(rule, {
        toolName: "apply_patch",
        filePath: "src/components/Button/index.tsx",
        content: "const secret = computeSecret();",
      }),
      "deny",
    );
  });

  // --- repo-root resolution: case, separators and prefix boundaries -------

  test("matching root and file path spelling still denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:/repo/src/components/Button/index.ts",
        content: 'export const x = 1;\nexport { Button } from "./Button";\n',
        git: { repoRoot: "C:/repo" },
      }),
      "deny",
    );
  });

  test("a repo root and file path differing only in drive-letter case still denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "c:/repo/src/components/Button/index.ts",
        content: 'export const x = 1;\nexport { Button } from "./Button";\n',
        git: { repoRoot: "C:/repo" },
      }),
      "deny",
    );
  });

  test("a backslash-spelled file path against a forward-slash root still denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:\\repo\\src\\components\\Button\\index.ts",
        content: 'export const x = 1;\nexport { Button } from "./Button";\n',
        git: { repoRoot: "C:/repo" },
      }),
      "deny",
    );
  });

  test("a file genuinely outside the configured folder passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:/repo/src/services/api/index.ts",
        content: "export const x = 1;",
        git: { repoRoot: "C:/repo" },
      }),
      "pass",
    );
  });

  test("a path that merely resembles the root as a prefix of a longer directory name passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:/repo-other/src/components/Button/index.ts",
        content: "export const x = 1;",
        git: { repoRoot: "C:/repo" },
      }),
      "pass",
    );
  });

  test("an unknown repository root leaves an unresolvable absolute path alone and passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:/other/src/components/Button/index.ts",
        content: "export const x = 1;",
        git: { repoRoot: null },
      }),
      "pass",
    );
  });

  // --- R3: a decoded MultiEdit judges the whole reconstructed barrel file,
  // never only what it inserts -----------------------------------------------

  test("R3: a MultiEdit's own inserted line is a clean re-export, but the true resulting file still holds executable logic elsewhere", () => {
    eq(
      decide(rule, {
        toolName: "MultiEdit",
        filePath: "src/components/Button/index.ts",
        // The write's own inserted text alone is a legitimate barrel line —
        // would wrongly pass if judged on its own.
        content: 'export { Icon } from "./Icon";',
        // The true resulting file still carries an executable statement
        // this write did not touch.
        resultingContent: 'export const x = 1;\nexport { Button } from "./Button";\nexport { Icon } from "./Icon";\n',
      }),
      "deny",
    );
  });

  test("R3: a MultiEdit's own inserted text looks like it introduces logic, but the true resulting barrel file is clean", () => {
    eq(
      decide(rule, {
        toolName: "MultiEdit",
        filePath: "src/components/Button/index.ts",
        // On its own this looks like a violation — would wrongly deny if
        // judged without the surrounding reconstructed file.
        content: 'export const x = 1;\nexport { Button } from "./Button";',
        // The true resulting file (after every edit in this MultiEdit is
        // applied) is a clean barrel.
        resultingContent: 'export { Button } from "./Button";\n',
      }),
      "pass",
    );
  });

  // --- override --------------------------------------------------------------

  test("an override can soften the deny to an ask", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/index.ts",
        content: "export const x = 1;",
        overrideSpec: { "barrel-exports-only": { action: "ask" } },
      }),
      "ask",
    );
  });
});
