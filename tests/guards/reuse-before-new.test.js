"use strict";

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");
const { decide, PROJECT_MINIMAL, PROJECT_BACKEND } = require("./_ctx");
const rule = require("../../core/guards/reuse-before-new");

/**
 * Creates a source root under a disposable directory, seeded with the given
 * files, and returns the repo root plus the `conventions.sourceRoots` value
 * a project fixture would carry.
 *
 * @param {() => string} tmpdir The suite's disposable-directory factory.
 * @param {string[]} files Relative file paths to create, each with placeholder
 * content.
 * @returns {{repoRoot: string, sourceRoots: string[]}} The repo root and the
 * one source root, `"src"`, that was seeded.
 */
function seededRepo(tmpdir, files) {
  const repoRoot = tmpdir();
  for (const rel of files) {
    const abs = path.join(repoRoot, "src", rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "// placeholder\n");
  }
  return { repoRoot, sourceRoots: ["src"] };
}

suite("guards/reuse-before-new", ({ test, eq, tmpdir }) => {
  /* -------------------------------------------------------------- positive */

  test("asks when a new hook name is identical ignoring case and the use-prefix", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["hooks/FetchData.ts"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useFetchData.ts"),
        content: "export function useFetchData() {}",
        git: { repoRoot },
        project: { conventions: { sourceRoots } },
      }),
      "ask",
    );
  });

  test("asks when a new name is one edit away from an existing file", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["hooks/useFetchInterval.ts"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useFetchIntervall.ts"),
        content: "export function useFetchIntervall() {}",
        git: { repoRoot },
        project: { conventions: { sourceRoots } },
      }),
      "ask",
    );
  });

  test("asks on a near-duplicate exported type name", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["types/ObjectScope.ts"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "types", "ObjectScop.ts"),
        content: "export type ObjectScop = { id: string };",
        git: { repoRoot },
        project: { conventions: { sourceRoots } },
      }),
      "ask",
    );
  });

  test("asks when a real near-duplicate component collides with another component", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["components/Loading.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "components", "Loadin.tsx"),
        content: "export function Loadin() { return null; }",
        git: { repoRoot },
        project: { conventions: { sourceRoots } },
      }),
      "ask",
    );
  });

  /* -------------------------------------------------------------- evasion */

  test("still asks when a name declared inline is exported through a separate export list", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["hooks/useFetchData.ts"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useFetchData2.ts"),
        content: "function useFetchData() { return null; }\nexport { useFetchData };",
        git: { repoRoot },
        project: { conventions: { sourceRoots } },
      }),
      "ask",
    );
  });

  test("still asks when the export list renames to the near-duplicate name", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["hooks/useFetchData.ts"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useFetchData2.ts"),
        content: "function impl() { return null; }\nexport { impl as useFetchData };",
        git: { repoRoot },
        project: { conventions: { sourceRoots } },
      }),
      "ask",
    );
  });

  test("still asks through the Codex apply_patch tool name", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["hooks/useFetchData.ts"]);
    eq(
      decide(rule, {
        toolName: "apply_patch",
        filePath: path.join(repoRoot, "src", "hooks", "getFetchData.ts"),
        content: "export function getFetchData() {}",
        git: { repoRoot },
        project: { conventions: { sourceRoots } },
      }),
      "ask",
    );
  });

  test("still asks when the near-duplicate export is not the file's own name", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["hooks/useFetchData.ts"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "index.ts"),
        content: "export { default } from './x';\nexport function useFetchDat() {}",
        git: { repoRoot },
        project: { conventions: { sourceRoots } },
      }),
      "ask",
    );
  });

  /* -------------------------------------------------------------- negative */

  test("passes a genuinely new, unrelated name", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["hooks/useFetchData.ts"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useObjectScopeCoordination.ts"),
        content: "export function useObjectScopeCoordination() {}",
        git: { repoRoot },
        project: { conventions: { sourceRoots } },
      }),
      "pass",
    );
  });

  test("passes an edit to a file that already exists", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["hooks/useFetchData.ts"]);
    const filePath = path.join(repoRoot, "src", "hooks", "useFetchData.ts");
    eq(
      decide(rule, {
        toolName: "Edit",
        filePath,
        content: "export function useFetchData() { return 1; }",
        git: { repoRoot },
        project: { conventions: { sourceRoots } },
        files: { [filePath]: "export function useFetchData() { return 0; }" },
      }),
      "pass",
    );
  });

  test("passes a new file whose export shares no source root duplicate", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, []);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useFetchData.ts"),
        content: "export function useFetchData() {}",
        git: { repoRoot },
        project: { conventions: { sourceRoots } },
      }),
      "pass",
    );
  });

  test("passes a new file that declares no exported name", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["hooks/useFetchData.ts"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "constants.ts"),
        content: "const INTERNAL = 1;\nfunction helper() { return INTERNAL; }",
        git: { repoRoot },
        project: { conventions: { sourceRoots } },
      }),
      "pass",
    );
  });

  test("ignores an index basename as a candidate for comparison", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["components/Widget/index.ts"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "components", "Gadget", "index.ts"),
        content: "export * from './Gadget';",
        git: { repoRoot },
        project: { conventions: { sourceRoots } },
      }),
      "pass",
    );
  });

  test("passes an unrelated Bash command", () => {
    eq(decide(rule, { toolName: "Bash", command: "npm run build" }), "pass");
  });

  test("passes when the tool is a plain read", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["hooks/useFetchData.ts"]);
    eq(
      decide(rule, {
        toolName: "Read",
        filePath: path.join(repoRoot, "src", "hooks", "useFetchDat.ts"),
        content: "export function useFetchDat() {}",
        git: { repoRoot },
        project: { conventions: { sourceRoots } },
      }),
      "pass",
    );
  });

  test("passes when sourceRoots point at a directory that does not exist", () => {
    const repoRoot = tmpdir();
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useFetchData.ts"),
        content: "export function useFetchData() {}",
        git: { repoRoot },
        project: { conventions: { sourceRoots: ["src"] } },
      }),
      "pass",
    );
  });

  test("passes when the scan exceeds the default file bound", () => {
    const repoRoot = tmpdir();
    const dir = path.join(repoRoot, "src", "many");
    fs.mkdirSync(dir, { recursive: true });
    // One more file than the 24000-file default bound, so the combined scan
    // (across the loop's files plus the decoy below) is over budget.
    for (let i = 0; i < 24001; i++) fs.writeFileSync(path.join(dir, `f${i}.ts`), "");
    fs.writeFileSync(path.join(dir, "useFetchData.ts"), "");
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useFetchData.ts"),
        content: "export function useFetchData() {}",
        git: { repoRoot },
        project: { conventions: { sourceRoots: ["src"] } },
      }),
      "pass",
    );
  });

  test("reuseBeforeNew.maxScanFiles from the project config lowers the bound", () => {
    const repoRoot = tmpdir();
    const dir = path.join(repoRoot, "src", "many");
    fs.mkdirSync(dir, { recursive: true });
    // Only a handful of files, but the configured bound is smaller still, so
    // the scan must be judged incomplete well below the 24000 default.
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, `f${i}.ts`), "");
    fs.writeFileSync(path.join(dir, "useFetchData.ts"), "");
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useFetchData.ts"),
        content: "export function useFetchData() {}",
        git: { repoRoot },
        project: { conventions: { sourceRoots: ["src"] }, reuseBeforeNew: { maxScanFiles: 2 } },
      }),
      "pass",
    );
  });

  test("passes an unrelated hook that merely shares a root word with an existing component", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["components/Loading.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useLoading.ts"),
        content: "export function useLoading() { return false; }",
        git: { repoRoot },
        project: { conventions: { sourceRoots, componentFolders: "src/components/**" } },
      }),
      "pass",
    );
  });

  test("passes an unrelated predicate that merely shares a root word with an existing component", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["components/Empty.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "utils", "isEmpty.ts"),
        content: "export function isEmpty() { return true; }",
        git: { repoRoot },
        project: { conventions: { sourceRoots, componentFolders: "src/components/**" } },
      }),
      "pass",
    );
  });

  test("passes an export list that only renames an unrelated local declaration", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["hooks/useFetchData.ts"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useObjectScopeCoordination.ts"),
        content: "function impl() { return null; }\nexport { impl as useObjectScopeCoordination, impl as default };",
        git: { repoRoot },
        project: { conventions: { sourceRoots } },
      }),
      "pass",
    );
  });

  test("does not confuse two short, coincidentally close names", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["ids/Id.ts"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "ids", "If.ts"),
        content: "export const If = 1;",
        git: { repoRoot },
        project: { conventions: { sourceRoots } },
      }),
      "pass",
    );
  });

  /* ------------------------------------------------------- folder move */

  test("passes a component moving into its own matching folder, replacing the flat file it displaces", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["components/Widget.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "components", "Widget", "Widget.tsx"),
        content: "export function Widget() { return null; }",
        git: { repoRoot },
        project: { conventions: { sourceRoots } },
      }),
      "pass",
    );
  });

  test("passes the barrel a folder move creates beside the component", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["components/Widget.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "components", "Widget", "index.tsx"),
        content: 'export { Widget } from "./Widget";',
        git: { repoRoot },
        project: { conventions: { sourceRoots } },
      }),
      "pass",
    );
  });

  test("passes the colocated hook a folder move creates beside the component", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["components/Widget.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "components", "Widget", "useWidget.ts"),
        content: "export function useWidget() { return null; }",
        git: { repoRoot },
        project: { conventions: { sourceRoots } },
      }),
      "pass",
    );
  });

  test("still asks when a same-named component exists under a completely different parent", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["components/other/Widget.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "components", "layout", "Widget", "Widget.tsx"),
        content: "export function Widget() { return null; }",
        git: { repoRoot },
        project: { conventions: { sourceRoots } },
      }),
      "ask",
    );
  });

  test("still asks when a folder-shaped write is a genuine near-duplicate rather than the file's own move", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["components/Widget.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "components", "Widgat", "Widgat.tsx"),
        content: "export function Widgat() { return null; }",
        git: { repoRoot },
        project: { conventions: { sourceRoots } },
      }),
      "ask",
    );
  });

  test("passes an unrelated new component written into its own new folder", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["components/Widget.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "components", "Gadget", "Gadget.tsx"),
        content: "export function Gadget() { return null; }",
        git: { repoRoot },
        project: { conventions: { sourceRoots } },
      }),
      "pass",
    );
  });

  /* ------------------------------------------------------------ overrides */

  test("an override softens the ask to off", () => {
    const { repoRoot, sourceRoots } = seededRepo(tmpdir, ["hooks/useFetchData.ts"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "getFetchData.ts"),
        content: "export function getFetchData() {}",
        git: { repoRoot },
        project: { conventions: { sourceRoots } },
        overrideSpec: { "reuse-before-new": { action: "off" } },
      }),
      "pass",
    );
  });

  /* --------------------------------------------------- minimal project */

  test("stays silent when the project declares no source roots and no repo root or cwd is resolvable", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "/repo/src/hooks/useFetchData.ts",
        content: "export function useFetchData() {}",
        project: PROJECT_MINIMAL,
        git: { repoRoot: "" },
        cwd: "",
      }),
      "pass",
    );
  });

  /* ------------------------------------------------- root-fallback (§2a) */

  test("configured sourceRoots still scopes the scan to just that root, ignoring a same-named file elsewhere in the repo", () => {
    const repoRoot = tmpdir();
    const outsideDir = path.join(repoRoot, "other");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "ObjectScopeCoordination.ts"), "// placeholder\n");
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useObjectScopeCoordination.ts"),
        content: "export function useObjectScopeCoordination() {}",
        git: { repoRoot },
        project: { conventions: { sourceRoots: ["src"] } },
      }),
      "pass",
    );
  });

  test("falls back to the repository root and fires when the project declares no sourceRoots at all", () => {
    const repoRoot = tmpdir();
    const dir = path.join(repoRoot, "lib");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "FetchData.ts"), "// placeholder\n");
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useFetchData.ts"),
        content: "export function useFetchData() {}",
        git: { repoRoot },
        project: PROJECT_MINIMAL,
      }),
      "ask",
    );
  });

  test("falls back to the repository root and stays silent when nothing similar exists there", () => {
    const repoRoot = tmpdir();
    const dir = path.join(repoRoot, "lib");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SomethingUnrelated.ts"), "// placeholder\n");
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useObjectScopeCoordination.ts"),
        content: "export function useObjectScopeCoordination() {}",
        git: { repoRoot },
        project: PROJECT_MINIMAL,
      }),
      "pass",
    );
  });

  /* ---------------------------------------------------- C#, backend (§2c) */

  test("matches a new C# public class against an existing same-named .cs file", () => {
    const repoRoot = tmpdir();
    const dir = path.join(repoRoot, "src", "Services");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "Foo.cs"), "// placeholder\n");
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "Other", "Foo.cs"),
        content: "public class Foo {}",
        git: { repoRoot },
        project: PROJECT_BACKEND,
      }),
      "ask",
    );
  });

  test("matches a new C# public enum against an existing same-named .cs file", () => {
    const repoRoot = tmpdir();
    const dir = path.join(repoRoot, "src", "Services");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "OrderStatus.cs"), "// placeholder\n");
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "Other", "OrderStatus.cs"),
        content: "public enum OrderStatus {}",
        git: { repoRoot },
        project: PROJECT_BACKEND,
      }),
      "ask",
    );
  });

  /* --------------------------------------------- build output (§2b) */

  test("excludes a decoy basename that lives inside a build-output directory", () => {
    const repoRoot = tmpdir();
    const binDir = path.join(repoRoot, "bin", "Debug");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "GeneratedHelper.cs"), "// placeholder\n");
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "GeneratedHelper.cs"),
        content: "public class GeneratedHelper {}",
        git: { repoRoot },
        project: PROJECT_MINIMAL,
      }),
      "pass",
    );
  });

  /* -------------------------------------------- extensions filter (§2c) */

  test("excludes a decoy .csproj file from the scan", () => {
    const repoRoot = tmpdir();
    fs.writeFileSync(path.join(repoRoot, "Foo.csproj"), "// placeholder\n");
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "Foo.cs"),
        content: "public class Foo {}",
        git: { repoRoot },
        project: PROJECT_MINIMAL,
      }),
      "pass",
    );
  });

  test("conventions.language narrows the scan away from a decoy in the other family", () => {
    const repoRoot = tmpdir();
    const dir = path.join(repoRoot, "src");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "Foo.ts"), "// placeholder\n");
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "Bar.cs"),
        content: "public class Foo {}",
        git: { repoRoot },
        project: { conventions: { sourceRoots: ["src"], language: "csharp" } },
      }),
      "pass",
    );
  });

  test("an unset language compares both families and still finds the cross-family decoy", () => {
    const repoRoot = tmpdir();
    const dir = path.join(repoRoot, "src");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "Foo.ts"), "// placeholder\n");
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "Bar.cs"),
        content: "public class Foo {}",
        git: { repoRoot },
        project: { conventions: { sourceRoots: ["src"] } },
      }),
      "ask",
    );
  });

  /* --------------------------------------------- unreadable root (§2a) */

  test("resolves to silence when a configured source root cannot be read", () => {
    const repoRoot = tmpdir();
    // A file sitting where the walker expects a directory can never be
    // listed — this stands in for a source root the process cannot read.
    fs.writeFileSync(path.join(repoRoot, "src"), "not a directory");
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "elsewhere", "Foo.cs"),
        content: "public class Foo {}",
        git: { repoRoot },
        project: { conventions: { sourceRoots: ["src"] } },
      }),
      "pass",
    );
  });
});
