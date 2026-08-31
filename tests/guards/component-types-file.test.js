"use strict";

const rule = require("../../core/guards/component-types-file");
const { suite } = require("../harness");
const { PROJECT_MINIMAL, decide, decision } = require("./_ctx");

suite("guards/component-types-file", ({ test, eq }) => {
  // --- positive: a fresh top-level type/interface, inline -----------------

  test("a new component's own .tsx declaring its own props interface denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/Widget.tsx",
        content: [
          "export interface WidgetProps {",
          "  label: string;",
          "}",
          "",
          "export const Widget = ({ label }: WidgetProps) => <div>{label}</div>;",
        ].join("\n"),
      }),
      "deny",
    );
  });

  test("a new component's own .tsx declaring a type alias for its props denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/Widget.tsx",
        content: [
          "export type WidgetProps = {",
          "  label: string;",
          "};",
          "",
          "export const Widget = ({ label }: WidgetProps) => <div>{label}</div>;",
        ].join("\n"),
      }),
      "deny",
    );
  });

  test("a new component-folder hook (.ts) declaring its own options type denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/useWidget.ts",
        content: [
          "export interface UseWidgetOptions {",
          "  enabled: boolean;",
          "}",
          "",
          "export function useWidget(options: UseWidgetOptions) {",
          "  return options.enabled;",
          "}",
        ].join("\n"),
      }),
      "deny",
    );
  });

  test("a new component-folder hook (.tsx, returns JSX) declaring its own return type denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/useWidgetSlot.tsx",
        content: [
          "type UseWidgetSlotReturn = { slot: JSX.Element };",
          "",
          "export function useWidgetSlot(): UseWidgetSlotReturn {",
          "  return { slot: <span /> };",
          "}",
        ].join("\n"),
      }),
      "deny",
    );
  });

  test("an interface with extends still denies", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/Widget.tsx",
        content: "export interface WidgetProps extends BaseProps {\n  label: string;\n}\n",
      }),
      "deny",
    );
  });

  test("the denial names the declared type and the folder's types.ts", () => {
    const result = decision(rule, {
      toolName: "Write",
      filePath: "src/components/Widget/Widget.tsx",
      content: "export interface WidgetProps {\n  label: string;\n}\n",
    });
    eq(result.action, "deny");
    eq(result.reason.includes("WidgetProps"), true);
    eq(result.fix, 'Move "WidgetProps" into "src/components/Widget/types.ts" and import it from there.');
  });

  test("a nested child component under components/ is governed the same way", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/components/WidgetRow/WidgetRow.tsx",
        content: "export interface WidgetRowProps {\n  id: string;\n}\n",
      }),
      "deny",
    );
  });

  // --- negative: the dedicated files this convention exists for -----------

  test("types.ts itself is silent", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/types.ts",
        content: "export interface WidgetProps {\n  label: string;\n}\n",
      }),
      "pass",
    );
  });

  test("a file inside a split types/ folder is silent", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/types/props.ts",
        content: "export interface WidgetProps {\n  label: string;\n}\n",
      }),
      "pass",
    );
  });

  test("constants.ts is silent", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/constants.ts",
        content: "export type WidgetDefaults = { count: number };\nexport const DEFAULTS: WidgetDefaults = { count: 0 };\n",
      }),
      "pass",
    );
  });

  // --- negative: tests -------------------------------------------------------

  test("a *.test.tsx file is silent even though it matches the .tsx extension", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/Widget.test.tsx",
        content: "interface WidgetTestProps {\n  label: string;\n}\n",
      }),
      "pass",
    );
  });

  test("a *.spec.ts hook-shaped test file is silent", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/useWidget.spec.ts",
        content: "interface UseWidgetTestOptions {\n  enabled: boolean;\n}\n",
      }),
      "pass",
    );
  });

  test("a file under the configured test folder is silent regardless of name", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/__tests__/useWidgetFixture.tsx",
        content: "interface WidgetFixtureProps {\n  label: string;\n}\n",
      }),
      "pass",
    );
  });

  // --- negative: outside the component-folders convention entirely --------

  test("a shared hooks-root file outside componentFolders is silent", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/hooks/useGlobalSetting/useGlobalSetting.ts",
        content: "export interface UseGlobalSettingOptions {\n  key: string;\n}\n",
      }),
      "pass",
    );
  });

  test("the shared contract-types root is silent", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/types/widget.ts",
        content: "export interface WidgetContract {\n  id: string;\n}\n",
      }),
      "pass",
    );
  });

  test("a services file is silent", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/services/api/widget.ts",
        content: "export interface WidgetResponse {\n  id: string;\n}\n",
      }),
      "pass",
    );
  });

  // --- negative: the barrel -------------------------------------------------

  test("a component folder's index.tsx is silent, even declaring a type inline", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/index.tsx",
        content: 'export type WidgetProps = { label: string };\nexport { Widget } from "./Widget";\n',
      }),
      "pass",
    );
  });

  // --- negative: forms that are not a declaration at all -------------------

  test("a type-only re-export is silent", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/Widget.tsx",
        content: 'export type { WidgetProps } from "./types";\n\nexport const Widget = () => null;\n',
      }),
      "pass",
    );
  });

  test("a type-only import is silent", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/Widget.tsx",
        content: 'import type { WidgetProps } from "./types";\n\nexport const Widget = (p: WidgetProps) => null;\n',
      }),
      "pass",
    );
  });

  test("a generic parameter on a function is silent", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/useWidget.ts",
        content: "export function useWidget<TItem>(items: TItem[]): TItem[] {\n  return items;\n}\n",
      }),
      "pass",
    );
  });

  test("a satisfies expression is silent", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/useWidget.ts",
        content: 'import type { WidgetConfig } from "./types";\n\nexport const config = { count: 0 } satisfies WidgetConfig;\n',
      }),
      "pass",
    );
  });

  test("an inline object type in a signature is silent", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/useWidget.ts",
        content: 'export function useWidget(): { count: number } {\n  return { count: 0 };\n}\n',
      }),
      "pass",
    );
  });

  test("a type declared inside a function body is silent", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/useWidget.ts",
        content: [
          "export function useWidget() {",
          "  type Local = { count: number };",
          "  const state: Local = { count: 0 };",
          "  return state;",
          "}",
        ].join("\n"),
      }),
      "pass",
    );
  });

  test("an interface declared inside a function body is silent", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/Widget.tsx",
        content: [
          "export const Widget = () => {",
          "  interface Local {",
          "    count: number;",
          "  }",
          "  const state: Local = { count: 0 };",
          "  return <span>{state.count}</span>;",
          "};",
        ].join("\n"),
      }),
      "pass",
    );
  });

  test("the word 'type' inside a string literal is silent", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/useWidget.ts",
        content: 'export const useWidget = () => "type is not a real declaration here";\n',
      }),
      "pass",
    );
  });

  // --- negative: a .ts helper file that is neither the view nor a hook -----

  test("a plain .ts helper beside the component is out of scope", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/widgetController.ts",
        content: "export interface WidgetControllerState {\n  count: number;\n}\n",
      }),
      "pass",
    );
  });

  // --- negative: an existing file, per newCodeOnly -------------------------

  test("editing an existing file that already declares its type inline is not relitigated", () => {
    eq(
      decide(rule, {
        toolName: "Edit",
        filePath: "src/components/Widget/Widget.tsx",
        content: "export interface WidgetProps {\n  label: string;\n  count: number;\n}\n",
        files: {
          "src/components/Widget/Widget.tsx": "export interface WidgetProps {\n  label: string;\n}\n",
        },
      }),
      "pass",
    );
  });

  // --- negative: silent when the project declares no componentFolders -----

  test("silent when the project declares no componentFolders convention", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/Widget.tsx",
        content: "export interface WidgetProps {\n  label: string;\n}\n",
        project: PROJECT_MINIMAL,
      }),
      "pass",
    );
  });

  // --- evasion ---------------------------------------------------------------

  test("a different write tool creating the same inline-typed file still denies", () => {
    eq(
      decide(rule, {
        toolName: "apply_patch",
        filePath: "src/components/Widget/Widget.tsx",
        content: "export interface WidgetProps {\n  label: string;\n}\n",
      }),
      "deny",
    );
  });

  test("backslash-separated Windows-style path still denies after normalisation", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src\\components\\Widget\\Widget.tsx",
        content: "export interface WidgetProps {\n  label: string;\n}\n",
      }),
      "deny",
    );
  });

  // --- override ----------------------------------------------------------

  test("an override can turn the rule off entirely", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/Widget.tsx",
        content: "export interface WidgetProps {\n  label: string;\n}\n",
        overrideSpec: { "component-types-file": { action: "off" } },
      }),
      "pass",
    );
  });

  test("an override can soften the denial to ask", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/Widget.tsx",
        content: "export interface WidgetProps {\n  label: string;\n}\n",
        overrideSpec: { "component-types-file": { action: "ask" } },
      }),
      "ask",
    );
  });
});
