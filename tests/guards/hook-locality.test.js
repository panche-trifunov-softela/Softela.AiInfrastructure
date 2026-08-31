"use strict";

const fs = require("fs");
const path = require("path");
const rule = require("../../core/guards/hook-locality");
const { suite } = require("../harness");
const { decide, decision, PROJECT_MINIMAL, PROJECT_BACKEND } = require("./_ctx");

/** Conventions shared by every case in this suite. */
const CONVENTIONS = Object.freeze({
  componentFolders: "src/components/**",
  sharedHooks: "src/hooks/**",
  testFolder: "__tests__",
  sourceRoots: ["src"],
  language: "typescript",
});

/**
 * Creates a disposable repository seeded with the given files, each holding
 * placeholder content.
 *
 * @param {() => string} tmpdir The suite's disposable-directory factory.
 * @param {string[]} files Repo-relative paths to create (POSIX-separated).
 * @returns {string} The repository root.
 */
function seededRepo(tmpdir, files) {
  const repoRoot = tmpdir();
  for (const rel of files) {
    const abs = path.join(repoRoot, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "// placeholder\n");
  }
  return repoRoot;
}

suite("guards/hook-locality", ({ test, eq, tmpdir }) => {
  // --- positive: a new hook file corresponds to an existing component -----

  test("a flat hook file matching an existing component folder denies", () => {
    const repoRoot = seededRepo(tmpdir, ["src/components/Widget/Widget.tsx", "src/components/Widget/index.ts"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useWidget.ts"),
        git: { repoRoot },
        project: { conventions: CONVENTIONS },
      }),
      "deny",
    );
  });

  test("the component's own nested hook-folder shape still denies", () => {
    const repoRoot = seededRepo(tmpdir, ["src/components/Widget/Widget.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useWidget", "useWidget.ts"),
        git: { repoRoot },
        project: { conventions: CONVENTIONS },
      }),
      "deny",
    );
  });

  test("a component that is a flat file with no folder of its own still denies", () => {
    const repoRoot = seededRepo(tmpdir, ["src/components/Widget.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useWidget.ts"),
        git: { repoRoot },
        project: { conventions: CONVENTIONS },
      }),
      "deny",
    );
  });

  test("the denial names the concrete destination beside the component", () => {
    const repoRoot = seededRepo(tmpdir, ["src/components/Widget/Widget.tsx"]);
    const result = decision(rule, {
      toolName: "Write",
      filePath: path.join(repoRoot, "src", "hooks", "useWidget.ts"),
      git: { repoRoot },
      project: { conventions: CONVENTIONS },
    });
    eq(result.action, "deny");
    eq(result.fix, 'Move it beside the component it belongs to: "src/components/Widget/useWidget.ts".');
  });

  // --- negative: ordinary shared-hook work, or nothing to correspond to ---

  test("no matching component anywhere passes — that is exactly what the shared root is for", () => {
    const repoRoot = seededRepo(tmpdir, ["src/components/Gadget/Gadget.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useWidget.ts"),
        git: { repoRoot },
        project: { conventions: CONVENTIONS },
      }),
      "pass",
    );
  });

  test("a hook already inside its own component folder passes", () => {
    const repoRoot = seededRepo(tmpdir, ["src/components/Widget/Widget.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "components", "Widget", "useWidget.ts"),
        git: { repoRoot },
        project: { conventions: CONVENTIONS },
      }),
      "pass",
    );
  });

  test("editing a file that already exists on disk is not relitigated", () => {
    const repoRoot = seededRepo(tmpdir, [
      "src/components/Widget/Widget.tsx",
      "src/hooks/useWidget.ts",
    ]);
    eq(
      decide(rule, {
        toolName: "Edit",
        filePath: path.join(repoRoot, "src", "hooks", "useWidget.ts"),
        git: { repoRoot },
        project: { conventions: CONVENTIONS },
        files: { [path.join(repoRoot, "src", "hooks", "useWidget.ts")]: "export function useWidget() {}\n" },
      }),
      "pass",
    );
  });

  test("the shared-hooks barrel passes", () => {
    const repoRoot = seededRepo(tmpdir, ["src/components/Widget/Widget.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "index.ts"),
        git: { repoRoot },
        project: { conventions: CONVENTIONS },
      }),
      "pass",
    );
  });

  test("a dot-qualified test file passes even though the component exists", () => {
    const repoRoot = seededRepo(tmpdir, ["src/components/Widget/Widget.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useWidget.test.ts"),
        git: { repoRoot },
        project: { conventions: CONVENTIONS },
      }),
      "pass",
    );
  });

  test("a file inside the configured test folder passes", () => {
    const repoRoot = seededRepo(tmpdir, ["src/components/Widget/Widget.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "__tests__", "useWidget.ts"),
        git: { repoRoot },
        project: { conventions: CONVENTIONS },
      }),
      "pass",
    );
  });

  test("a hook name that only shares a prefix with a shorter component name passes", () => {
    // Only "Widget" exists; the hook corresponds to "WidgetPanel", a different name.
    const repoRoot = seededRepo(tmpdir, ["src/components/Widget/Widget.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useWidgetPanel.ts"),
        git: { repoRoot },
        project: { conventions: CONVENTIONS },
      }),
      "pass",
    );
  });

  test("a hook name that is only a prefix of a longer component name passes", () => {
    // Only "WidgetPanel" exists; the hook corresponds to "Widget", a different name.
    const repoRoot = seededRepo(tmpdir, ["src/components/WidgetPanel/WidgetPanel.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useWidget.ts"),
        git: { repoRoot },
        project: { conventions: CONVENTIONS },
      }),
      "pass",
    );
  });

  test("silent when the project declares componentFolders but no sharedHooks", () => {
    const repoRoot = seededRepo(tmpdir, ["src/components/Widget/Widget.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useWidget.ts"),
        git: { repoRoot },
        project: { conventions: { componentFolders: "src/components/**", sourceRoots: ["src"] } },
      }),
      "pass",
    );
  });

  test("silent when the project declares sharedHooks but no componentFolders", () => {
    const repoRoot = seededRepo(tmpdir, ["src/components/Widget/Widget.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useWidget.ts"),
        git: { repoRoot },
        project: { conventions: { sharedHooks: "src/hooks/**", sourceRoots: ["src"] } },
      }),
      "pass",
    );
  });

  test("silent when the project declares neither convention", () => {
    const repoRoot = seededRepo(tmpdir, ["src/components/Widget/Widget.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useWidget.ts"),
        git: { repoRoot },
        project: PROJECT_MINIMAL,
      }),
      "pass",
    );
  });

  test("a hook file written outside the shared-hooks root passes", () => {
    const repoRoot = seededRepo(tmpdir, ["src/components/Widget/Widget.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "utils", "useWidget.ts"),
        git: { repoRoot },
        project: { conventions: CONVENTIONS },
      }),
      "pass",
    );
  });

  test("a matching name with a non-hook extension passes", () => {
    const repoRoot = seededRepo(tmpdir, ["src/components/Widget/Widget.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useWidget.json"),
        git: { repoRoot },
        project: { conventions: CONVENTIONS },
      }),
      "pass",
    );
  });

  test("a file in the shared root with no use-prefix is not a hook at all", () => {
    const repoRoot = seededRepo(tmpdir, ["src/components/Widget/Widget.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "widgetHelpers.ts"),
        git: { repoRoot },
        project: { conventions: CONVENTIONS },
      }),
      "pass",
    );
  });

  test("a name only accidentally starting with 'use' (word boundary) is not treated as a hook", () => {
    const repoRoot = seededRepo(tmpdir, ["src/components/RProfile/RProfile.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "userProfile.ts"),
        git: { repoRoot },
        project: { conventions: CONVENTIONS },
      }),
      "pass",
    );
  });

  test("silent on the backend stack even with an otherwise matching layout", () => {
    const repoRoot = seededRepo(tmpdir, ["src/components/Widget/Widget.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useWidget.ts"),
        git: { repoRoot },
        project: Object.assign({}, PROJECT_BACKEND, { conventions: CONVENTIONS }),
      }),
      "pass",
    );
  });

  // --- evasion --------------------------------------------------------------

  test("the same misplacement reached through a different write tool still denies", () => {
    const repoRoot = seededRepo(tmpdir, ["src/components/Widget/Widget.tsx"]);
    eq(
      decide(rule, {
        toolName: "apply_patch",
        filePath: path.join(repoRoot, "src", "hooks", "useWidget.ts"),
        git: { repoRoot },
        project: { conventions: CONVENTIONS },
      }),
      "deny",
    );
  });

  test("a forward-slash file path against a backslash-spelled repo root still denies", () => {
    const repoRoot = seededRepo(tmpdir, ["src/components/Widget/Widget.tsx"]);
    const forwardSlashRoot = repoRoot.replace(/\\/g, "/");
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: `${forwardSlashRoot}/src/hooks/useWidget.ts`,
        git: { repoRoot },
        project: { conventions: CONVENTIONS },
      }),
      "deny",
    );
  });

  // --- override ---------------------------------------------------------------

  test("an override can turn the rule off entirely", () => {
    const repoRoot = seededRepo(tmpdir, ["src/components/Widget/Widget.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useWidget.ts"),
        git: { repoRoot },
        project: { conventions: CONVENTIONS },
        overrideSpec: { "hook-locality": { action: "off" } },
      }),
      "pass",
    );
  });

  test("an override can soften the denial to ask", () => {
    const repoRoot = seededRepo(tmpdir, ["src/components/Widget/Widget.tsx"]);
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: path.join(repoRoot, "src", "hooks", "useWidget.ts"),
        git: { repoRoot },
        project: { conventions: CONVENTIONS },
        overrideSpec: { "hook-locality": { action: "ask" } },
      }),
      "ask",
    );
  });
});
