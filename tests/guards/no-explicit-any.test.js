"use strict";

/**
 * Table-driven suite for `no-explicit-any`.
 */

const { suite } = require("../harness");
const { PROJECT_MINIMAL, decide } = require("./_ctx");
const rule = require("../../core/guards/no-explicit-any");

const CONTRACT_FILE = "/repo/src/types/user.ts";
const ON_DISK_TWO = "export function a(x: any): any {\n  return x as any;\n}\n";

const CASES = [
  // positive
  {
    label: "a new file introducing `: any` is denied",
    ctx: { toolName: "Write", filePath: CONTRACT_FILE, content: "export function f(x: any) {}\n" },
    want: "deny",
  },
  {
    label: "raising the count above what is on disk is denied",
    ctx: {
      toolName: "Edit",
      filePath: CONTRACT_FILE,
      content: `${ON_DISK_TWO}export function b(y: any) {}\n`,
      files: { [CONTRACT_FILE]: ON_DISK_TWO },
    },
    want: "deny",
  },
  {
    label: "`<any>` is counted as an escape",
    ctx: { toolName: "Write", filePath: CONTRACT_FILE, content: "const list: Array<any> = [];\n" },
    want: "deny",
  },
  {
    label: "`as any` is counted as an escape",
    ctx: { toolName: "Write", filePath: CONTRACT_FILE, content: "const v = payload as any;\n" },
    want: "deny",
  },
  {
    label: "`any[]` is counted as an escape",
    ctx: { toolName: "Write", filePath: CONTRACT_FILE, content: "const items: any[] = [];\n" },
    want: "deny",
  },
  {
    label: "`as any` written inside a template-literal interpolation is counted",
    ctx: { toolName: "Write", filePath: CONTRACT_FILE, content: "const label = `value: ${(payload) as any}`;\n" },
    want: "deny",
  },

  // negative — ordinary daily work
  {
    label: "a contract file with no `any` at all passes",
    ctx: { toolName: "Write", filePath: CONTRACT_FILE, content: "export interface User {\n  id: string;\n}\n" },
    want: "pass",
  },
  {
    label: "keeping the same count as on disk passes",
    ctx: { toolName: "Edit", filePath: CONTRACT_FILE, content: ON_DISK_TWO, files: { [CONTRACT_FILE]: ON_DISK_TWO } },
    want: "pass",
  },
  {
    label: "lowering the count from what is on disk passes",
    ctx: {
      toolName: "Edit",
      filePath: CONTRACT_FILE,
      content: "export function a(x: unknown): unknown {\n  return x;\n}\n",
      files: { [CONTRACT_FILE]: ON_DISK_TWO },
    },
    want: "pass",
  },
  {
    label: "`any` mentioned only inside a line comment does not count",
    ctx: { toolName: "Write", filePath: CONTRACT_FILE, content: "// avoid using: any here\nexport const id = 1;\n" },
    want: "pass",
  },
  {
    label: "`any` mentioned only inside a block comment does not count",
    ctx: { toolName: "Write", filePath: CONTRACT_FILE, content: "/* legacy code used: any\n   everywhere */\nexport const id = 1;\n" },
    want: "pass",
  },
  {
    label: "`any` mentioned only inside a string literal does not count",
    ctx: { toolName: "Write", filePath: CONTRACT_FILE, content: 'export const msg = "cast as any is forbidden";\n' },
    want: "pass",
  },
  {
    label: "a file outside the contract-types boundary passes even with `any`",
    ctx: { toolName: "Write", filePath: "/repo/src/components/Widget.tsx", content: "const f = (x: any) => x;\n" },
    want: "pass",
  },
  {
    label: "a word merely containing 'any' is not an escape",
    ctx: { toolName: "Write", filePath: CONTRACT_FILE, content: "export const company: string = 'x';\n" },
    want: "pass",
  },
  {
    label: "a template literal with no interpolation still masks its body",
    ctx: { toolName: "Write", filePath: CONTRACT_FILE, content: "const msg = `type: any`;\n" },
    want: "pass",
  },
  {
    label: "a regex literal is not mistaken for an `any` type escape",
    ctx: { toolName: "Write", filePath: CONTRACT_FILE, content: "const ANY_ESCAPE = /as any/;\n" },
    want: "pass",
  },
  {
    label: "a shell command is not a file write and passes",
    ctx: { toolName: "Bash", command: "cat src/types/user.ts" },
    want: "pass",
  },
  {
    label: "no file path passes",
    ctx: { toolName: "Write", filePath: "", content: "x: any" },
    want: "pass",
  },

  // evasion
  {
    label: "spreading whitespace around the colon still counts",
    ctx: { toolName: "Write", filePath: CONTRACT_FILE, content: "export function f(x:    any) {}\n" },
    want: "deny",
  },
  {
    label: "a Codex-style apply_patch write is still ratcheted",
    ctx: {
      toolName: "apply_patch",
      filePath: CONTRACT_FILE,
      content: `${ON_DISK_TWO}export function b(y: any) {}\n`,
      files: { [CONTRACT_FILE]: ON_DISK_TWO },
    },
    want: "deny",
  },

  // R3: a decoded MultiEdit ratchets the FILE's total `any` count
  // (ctx.resultingContent), never only the count in what it inserts
  {
    label: "R3: a MultiEdit's own inserted `any`s are few, but the true resulting total exceeds what is on disk",
    ctx: {
      toolName: "MultiEdit",
      filePath: CONTRACT_FILE,
      // The write's own inserted text: only 1 new `any` — 1 <= 80 would
      // wrongly pass if this were compared against the on-disk count.
      content: "export function fresh(z: any) {}\n",
      // The true resulting file: the 80-`any` legacy content plus this
      // write's own insertion, 81 in total.
      resultingContent: `${"export const legacyAny: any = null;\n".repeat(80)}export function fresh(z: any) {}\n`,
      files: { [CONTRACT_FILE]: "export const legacyAny: any = null;\n".repeat(80) },
    },
    want: "deny",
  },
  {
    label: "R3: a MultiEdit whose own inserted text alone looks like it raises the count passes once the true resulting file is measured instead",
    ctx: {
      toolName: "MultiEdit",
      filePath: CONTRACT_FILE,
      // The write's own inserted text carries 10 `any`s — would wrongly deny
      // (10 > 3) if compared to the on-disk count directly.
      content: Array.from({ length: 10 }, (_, i) => `const scratch${i}: any = null;`).join("\n"),
      // The true resulting file is unchanged from what is already on disk —
      // this write's own insertion happens to land somewhere the rule's
      // resulting-content reconstruction shows nets out to the same count.
      resultingContent: ON_DISK_TWO,
      files: { [CONTRACT_FILE]: ON_DISK_TWO },
    },
    want: "pass",
  },
  {
    label: "a real escape after a regex literal is still counted, not swallowed by it",
    ctx: { toolName: "Write", filePath: CONTRACT_FILE, content: "const RE = /foo/;\nexport function f(x: any) {}\n" },
    want: "deny",
  },
  {
    label: "a real `as any` cast next to a division is still counted",
    ctx: { toolName: "Write", filePath: CONTRACT_FILE, content: "const v = (x as any) / 2;\n" },
    want: "deny",
  },

  // override
  {
    label: "an override softens the rule from deny to ask",
    ctx: {
      toolName: "Write",
      filePath: CONTRACT_FILE,
      content: "export function f(x: any) {}\n",
      overrideSpec: { "no-explicit-any": { action: "ask" } },
    },
    want: "ask",
  },

  // silent absent config
  {
    label: "a project with no contractTypes convention stays silent",
    ctx: { toolName: "Write", filePath: CONTRACT_FILE, content: "export function f(x: any) {}\n", project: PROJECT_MINIMAL },
    want: "pass",
  },
];

suite("guards/no-explicit-any", ({ test, eq }) => {
  for (const c of CASES) {
    test(c.label, () => {
      eq(decide(rule, c.ctx), c.want, c.label);
    });
  }
});
