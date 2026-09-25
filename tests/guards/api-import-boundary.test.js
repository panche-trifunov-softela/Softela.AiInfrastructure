"use strict";

const rule = require("../../core/guards/api-import-boundary");
const { suite } = require("../harness");
const { PROJECT_MINIMAL, decide } = require("./_ctx");

suite("guards/api-import-boundary", ({ test, eq }) => {
  // --- positive: the component reaches into the API layer -----------------

  test("a relative import resolving into the API layer denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/Button.tsx",
        content: 'import { getUser } from "../../services/api/userApi";',
      }),
      "deny",
    );
  });

  test("a project-rooted import of the API layer denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/Button.tsx",
        content: 'import { getUser } from "src/services/api/userApi";',
      }),
      "deny",
    );
  });

  test("a require() of the API layer denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/Button.tsx",
        content: 'const api = require("../../services/api/userApi");',
      }),
      "deny",
    );
  });

  // --- negative: ordinary imports, or out of scope -------------------------

  test("importing a hook, not the API layer, passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/Button.tsx",
        content: 'import { useUser } from "../../hooks/useUser";',
      }),
      "pass",
    );
  });

  test("importing a sibling within the same component folder passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/Button.tsx",
        content: 'import { Icon } from "./Icon";',
      }),
      "pass",
    );
  });

  test("importing a bare package passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/Button.tsx",
        content: 'import React from "react";',
      }),
      "pass",
    );
  });

  test("a hook file importing the API layer is out of scope for this rule", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/hooks/useUser.ts",
        content: 'import { getUser } from "../services/api/userApi";',
      }),
      "pass",
    );
  });

  test("an empty new file passes", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/components/Button/Button.tsx", content: "" }), "pass");
  });

  test("silent when the project declares no componentFolders convention", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/Button.tsx",
        content: 'import { getUser } from "../../services/api/userApi";',
        project: PROJECT_MINIMAL,
      }),
      "pass",
    );
  });

  test("silent when componentFolders is set but apiLayer is not", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/Button.tsx",
        content: 'import { getUser } from "../../services/api/userApi";',
        project: { conventions: { componentFolders: "src/components/**", testFolder: "__tests__" } },
      }),
      "pass",
    );
  });

  // --- type-only imports carry no runtime coupling -------------------------

  test("a type-only import of the API layer passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/Button.tsx",
        content: 'import type { UserResponse } from "../../services/api/userApi";',
      }),
      "pass",
    );
  });

  test("a type-only namespace import of the API layer passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/Button.tsx",
        content: 'import type * as UserApi from "../../services/api/userApi";',
      }),
      "pass",
    );
  });

  test("a type-only re-export of the API layer passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/Button.tsx",
        content: 'export type { UserResponse } from "../../services/api/userApi";',
      }),
      "pass",
    );
  });

  test("a partially type-only import that still pulls a runtime binding from the API layer denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/Button.tsx",
        content: 'import { type UserResponse, getUser } from "../../services/api/userApi";',
      }),
      "deny",
    );
  });

  test('a default import literally named "type" is not mistaken for the type-only keyword', () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/Button.tsx",
        content: 'import type from "../../services/api/userApi";',
      }),
      "deny",
    );
  });

  // --- path aliases ----------------------------------------------------------

  test("an alias import resolving into the API layer denies when the project declares the alias", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/Button.tsx",
        content: 'import { getUser } from "@/services/api/userApi";',
        project: {
          conventions: {
            componentFolders: "src/components/**",
            apiLayer: "src/services/api/**",
            pathAliases: { "@": "src" },
          },
        },
      }),
      "deny",
    );
  });

  test("an alias import outside the API layer passes even when aliases are configured", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/Button.tsx",
        content: 'import { useUser } from "@/hooks/useUser";',
        project: {
          conventions: {
            componentFolders: "src/components/**",
            apiLayer: "src/services/api/**",
            pathAliases: { "@": "src" },
          },
        },
      }),
      "pass",
    );
  });

  test("an alias import into the API layer passes when the project declares no aliases", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/Button.tsx",
        content: 'import { getUser } from "@/services/api/userApi";',
      }),
      "pass",
    );
  });

  // --- evasion -------------------------------------------------------------

  test("a dynamic import() of the API layer still denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/Button.tsx",
        content: 'const mod = import("../../services/api/userApi");',
      }),
      "deny",
    );
  });

  test("a different write tool writing the same forbidden import still denies", () => {
    eq(
      decide(rule, {
        toolName: "apply_patch",
        filePath: "src/components/Button/Button.tsx",
        content: 'import { getUser } from "../../services/api/userApi";',
      }),
      "deny",
    );
  });

  // --- repo-root resolution: case, separators and prefix boundaries -------

  test("matching root and file path spelling still denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:/repo/src/components/Button/Button.tsx",
        content: 'import { getUser } from "../../services/api/userApi";',
        git: { repoRoot: "C:/repo" },
      }),
      "deny",
    );
  });

  test("a repo root and file path differing only in drive-letter case still denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "c:/repo/src/components/Button/Button.tsx",
        content: 'import { getUser } from "../../services/api/userApi";',
        git: { repoRoot: "C:/repo" },
      }),
      "deny",
    );
  });

  test("a backslash-spelled file path against a forward-slash root still denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:\\repo\\src\\components\\Button\\Button.tsx",
        content: 'import { getUser } from "../../services/api/userApi";',
        git: { repoRoot: "C:/repo" },
      }),
      "deny",
    );
  });

  test("a file genuinely outside the configured folder passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:/repo/src/hooks/useUser.ts",
        content: 'import { getUser } from "../services/api/userApi";',
        git: { repoRoot: "C:/repo" },
      }),
      "pass",
    );
  });

  test("a path that merely resembles the root as a prefix of a longer directory name passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:/repo-other/src/components/Button/Button.tsx",
        content: 'import { getUser } from "../../services/api/userApi";',
        git: { repoRoot: "C:/repo" },
      }),
      "pass",
    );
  });

  test("an unknown repository root leaves an unresolvable absolute path alone and passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "C:/other/src/components/Button/Button.tsx",
        content: 'import { getUser } from "../../services/api/userApi";',
        git: { repoRoot: null },
      }),
      "pass",
    );
  });

  // --- a component's own hook is where the API call belongs -----------------

  test("a component's own hook may import the API layer", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/hooks/useUser.ts",
        content: 'import { getUser } from "../../../services/api/userApi";',
      }),
      "pass",
    );
  });

  test("a hook at the component folder's own root may import the API layer", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/useButton.ts",
        content: 'import { getUser } from "../../services/api/userApi";',
      }),
      "pass",
    );
  });

  test("a hook taking .tsx because it returns JSX may still import the API layer", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/useConfirmDialog.tsx",
        content: 'import { getUser } from "../../services/api/userApi";',
      }),
      "pass",
    );
  });

  test("a hook file taking .js may still import the API layer", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/hooks/useUser.js",
        content: 'import { getUser } from "../../../services/api/userApi";',
      }),
      "pass",
    );
  });

  test("a hook file taking .jsx may still import the API layer", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/useConfirmDialog.jsx",
        content: 'import { getUser } from "../../services/api/userApi";',
      }),
      "pass",
    );
  });

  test("the view beside that hook still may not import the API layer", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/Button.tsx",
        content: 'import { getUser } from "../../services/api/userApi";',
      }),
      "deny",
    );
  });

  // A hook is `use` followed by a capital. Without that, every view whose name
  // begins with the English words "used" or "user" reads as a hook and walks
  // straight through a boundary rule.

  test('a view merely beginning with "used" is not a hook and still denies', () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/usedFieldsPanel.tsx",
        content: 'import { getUser } from "../../services/api/userApi";',
      }),
      "deny",
    );
  });

  test('a view merely beginning with "user" is not a hook and still denies', () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/userProfileCard.tsx",
        content: 'import { getUser } from "../../services/api/userApi";',
      }),
      "deny",
    );
  });

  test("a PascalCase view name is not a hook and still denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/UserProfile.tsx",
        content: 'import { getUser } from "../../services/api/userApi";',
      }),
      "deny",
    );
  });

  // Consuming the API layer is the hook's job; handing it on under the hook's
  // own name puts it back within the view's reach, one hop further out.

  test("a hook re-exporting the whole API layer denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/hooks/useApi.ts",
        content: 'export * from "../../../services/api/userApi";',
      }),
      "deny",
    );
  });

  test("a hook re-exporting named bindings from the API layer denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/hooks/useApi.ts",
        content: 'export { getUser } from "../../../services/api/userApi";',
      }),
      "deny",
    );
  });

  test("a hook that both imports and re-exports the API layer denies on the re-export", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/hooks/useUser.ts",
        content:
          'import { getUser } from "../../../services/api/userApi";\nexport * from "../../../services/api/userApi";',
      }),
      "deny",
    );
  });

  test("a hook's type-only re-export of the API layer still passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/hooks/useUser.ts",
        content: 'export type { UserResponse } from "../../../services/api/userApi";',
      }),
      "pass",
    );
  });

  test("a hook re-exporting something that is not the API layer passes", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/hooks/useUser.ts",
        content: 'export * from "./useUserInternals";',
      }),
      "pass",
    );
  });

  test("a hook may require() the API layer", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/hooks/useUser.ts",
        content: 'const api = require("../../../services/api/userApi");',
      }),
      "pass",
    );
  });

  test("a hook may reach the API layer through a declared path alias", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/hooks/useUser.ts",
        content: 'import { getUser } from "@/services/api/userApi";',
        project: {
          conventions: {
            componentFolders: "src/components/**",
            apiLayer: "src/services/api/**",
            pathAliases: { "@": "src" },
          },
        },
      }),
      "pass",
    );
  });

  // --- override --------------------------------------------------------------

  test("an override can soften the deny to an ask", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Button/Button.tsx",
        content: 'import { getUser } from "../../services/api/userApi";',
        overrideSpec: { "api-import-boundary": { action: "ask" } },
      }),
      "ask",
    );
  });
});
