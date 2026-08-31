"use strict";

/**
 * Table-driven suite for `naming-standards`.
 */

const { suite } = require("../harness");
const { PROJECT_MINIMAL, decide } = require("./_ctx");
const rule = require("../../core/guards/naming-standards");

const CASES = [
  // positive — one per convention the wiki names
  {
    label: "a component file not in PascalCase denies",
    ctx: { toolName: "Write", filePath: "/repo/src/components/widget.tsx", content: "export default function widget() { return null; }\n" },
    want: "deny",
  },
  {
    label: "a hook file without the camelCase `use` shape denies",
    ctx: { toolName: "Write", filePath: "/repo/src/hooks/UseFetch.ts", content: "export function UseFetch() {}\n" },
    want: "deny",
  },
  {
    label: "a camelCase API URL segment denies",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/api/orders.ts",
      content: "fetch('/api/userProfile');\n",
    },
    want: "deny",
  },
  {
    label: "a .NET interface without the I prefix denies",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/api/OrderService.cs",
      content: "public interface OrderService { void Run(); }\n",
      project: { conventions: { language: "csharp" } },
    },
    want: "deny",
  },
  {
    label: "a .NET type not in PascalCase denies",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/api/orderService.cs",
      content: "public class orderService { }\n",
      project: { conventions: { language: "csharp" } },
    },
    want: "deny",
  },

  // negative — ordinary daily work
  {
    label: "a correctly PascalCase component passes",
    ctx: { toolName: "Write", filePath: "/repo/src/components/Widget.tsx", content: "export default function Widget() { return null; }\n" },
    want: "pass",
  },
  {
    label: "a correctly named hook passes",
    ctx: { toolName: "Write", filePath: "/repo/src/hooks/useFetch.ts", content: "export function useFetch() {}\n" },
    want: "pass",
  },
  {
    label: "a snake_case API URL segment passes",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/api/orders.ts",
      content: "fetch('/api/user_profile');\n",
    },
    want: "pass",
  },
  {
    label: "an I-prefixed .NET interface passes",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/api/OrderService.cs",
      content: "public interface IOrderService { void Run(); }\n",
      project: { conventions: { language: "csharp" } },
    },
    want: "pass",
  },
  {
    label: "a PascalCase .NET class passes",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/api/OrderService.cs",
      content: "public class OrderService { }\n",
      project: { conventions: { language: "csharp" } },
    },
    want: "pass",
  },
  {
    label: "index.tsx inside a component folder is exempt from the PascalCase check",
    ctx: { toolName: "Write", filePath: "/repo/src/components/widget/index.tsx", content: "export * from './widget';\n" },
    want: "pass",
  },
  {
    label: "a plain utility .ts file is not judged as a component",
    ctx: { toolName: "Write", filePath: "/repo/src/components/format-date.ts", content: "export function formatDate() {}\n" },
    want: "pass",
  },
  {
    label: "a component-shaped file outside componentFolders is not judged",
    ctx: { toolName: "Write", filePath: "/repo/scripts/widget.tsx", content: "export default function widget() { return null; }\n" },
    want: "pass",
  },
  {
    label: "a service class merely starting with the substring \"use\" is not a hook",
    ctx: { toolName: "Write", filePath: "/repo/src/services/UserService.ts", content: "export class UserService {}\n" },
    want: "pass",
  },
  {
    label: "a model file named after a common domain noun is not a hook",
    ctx: { toolName: "Write", filePath: "/repo/src/models/user.ts", content: "export interface User {}\n" },
    want: "pass",
  },
  {
    label: "a repository file outside a hooks path is not a hook",
    ctx: { toolName: "Write", filePath: "/repo/src/services/userRepository.ts", content: "export function userRepository() {}\n" },
    want: "pass",
  },
  {
    label: "a colocated component test file with the right stem passes",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/components/Widget/__tests__/Widget.test.tsx",
      content: "test('renders', () => {});\n",
    },
    want: "pass",
  },
  {
    label: "a colocated component story file with the right stem passes",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/components/Widget/Widget.stories.tsx",
      content: "export default {};\n",
    },
    want: "pass",
  },
  {
    label: "a colocated hook test file with the right stem passes",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/hooks/__tests__/useFetch.test.ts",
      content: "test('fetches', () => {});\n",
    },
    want: "pass",
  },
  {
    label: "a C# name mentioned only in a comment does not trigger a rename denial",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/api/OrderService.cs",
      content: "public interface IController { }\n// TODO: rename legacy interface fooBar before merging\n",
      project: { conventions: { language: "csharp" } },
    },
    want: "pass",
  },
  {
    label: "a C# name mentioned only in a string literal does not trigger a rename denial",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/api/OrderService.cs",
      content: 'public interface IController { }\nvar s = "interface fooBar";\n',
      project: { conventions: { language: "csharp" } },
    },
    want: "pass",
  },
  {
    label: "an unrecognised language stays silent",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/components/widget.tsx",
      content: "export default function widget() { return null; }\n",
      project: { conventions: { language: "rust" } },
    },
    want: "pass",
  },
  {
    label: "a shell command is not a file write and passes",
    ctx: { toolName: "Bash", command: "cat src/components/widget.tsx" },
    want: "pass",
  },

  // evasion
  {
    label: "a Codex-style write_file call is still judged",
    ctx: { toolName: "write_file", filePath: "/repo/src/components/widget.tsx", content: "export default function widget() { return null; }\n" },
    want: "deny",
  },
  {
    label: "backtick-quoted API literals are still judged",
    ctx: { toolName: "Write", filePath: "/repo/src/services/api/orders.ts", content: "fetch(`/api/userProfile`);\n" },
    want: "deny",
  },
  {
    label: "a wrong-cased hook inside a nested hooks folder still denies",
    ctx: { toolName: "Write", filePath: "/repo/src/hooks/nested/UseFetch.ts", content: "export function UseFetch() {}\n" },
    want: "deny",
  },
  {
    label: "a genuinely misnamed colocated test file still denies",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/components/widget/__tests__/widget.test.tsx",
      content: "test('renders', () => {});\n",
    },
    want: "deny",
  },
  {
    label: "a real C# violation is still caught alongside an unrelated comment",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/services/api/OrderService.cs",
      content: "// TODO: cleanup later\npublic interface Controller { }\n",
      project: { conventions: { language: "csharp" } },
    },
    want: "deny",
  },

  // override
  {
    label: "an override softens the rule to off",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/components/widget.tsx",
      content: "export default function widget() { return null; }\n",
      overrideSpec: { "naming-standards": { action: "off" } },
    },
    want: "pass",
  },
  {
    label: "an override softens a denial to ask",
    ctx: {
      toolName: "Write",
      filePath: "/repo/src/components/widget.tsx",
      content: "export default function widget() { return null; }\n",
      overrideSpec: { "naming-standards": { action: "ask" } },
    },
    want: "ask",
  },

  // silent absent config
  {
    label: "a project with no declared language stays silent",
    ctx: { toolName: "Write", filePath: "/repo/src/components/widget.tsx", content: "export default function widget() { return null; }\n", project: PROJECT_MINIMAL },
    want: "pass",
  },
];

suite("guards/naming-standards", ({ test, eq }) => {
  for (const c of CASES) {
    test(c.label, () => {
      eq(decide(rule, c.ctx), c.want, c.label);
    });
  }
});
