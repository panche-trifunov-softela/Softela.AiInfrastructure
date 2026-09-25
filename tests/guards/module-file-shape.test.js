"use strict";

const rule = require("../../core/guards/module-file-shape");
const { suite } = require("../harness");
const { PROJECT_MINIMAL, decide, decision } = require("./_ctx");

suite("guards/module-file-shape", ({ test, eq }) => {
  // --- positive: a declaration plus real logic, outside the component tree -

  test("a new store file with an inline type and hook-driven logic asks", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/store/order/useOrderStore.ts",
        content: [
          "type OrderStoreState = {",
          "  orders: string[];",
          "};",
          "",
          "export const useOrderStore = () => {",
          "  const [state, setState] = useState<OrderStoreState>({ orders: [] });",
          "  useEffect(() => {",
          "    setState({ orders: [] });",
          "  }, []);",
          "  return state;",
          "};",
        ].join("\n"),
      }),
      "ask",
    );
  });

  test("a new utility file with an inline interface and control flow asks", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/utils/withRetry.ts",
        content: [
          "export interface RetryOptions {",
          "  attempts: number;",
          "}",
          "",
          "export function withRetry(run: () => void, options: RetryOptions) {",
          "  for (let i = 0; i < options.attempts; i++) {",
          "    try {",
          "      run();",
          "      return;",
          "    } catch (error) {",
          "      if (i === options.attempts - 1) throw error;",
          "    }",
          "  }",
          "}",
        ].join("\n"),
      }),
      "ask",
    );
  });

  test("a new module with an inline enum and control flow asks", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/utils/retryStrategy.ts",
        content: [
          "enum RetryStrategy {",
          "  Fixed,",
          "  Exponential,",
          "}",
          "",
          "export function computeDelay(strategy: RetryStrategy, attempt: number): number {",
          "  if (strategy === RetryStrategy.Exponential) {",
          "    return 100 * attempt;",
          "  }",
          "  return 100;",
          "}",
        ].join("\n"),
      }),
      "ask",
    );
  });

  test("a new module exporting an UPPER_SNAKE_CASE constant alongside real logic asks", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/utils/backoff.ts",
        content: [
          "export const MAX_RETRY_ATTEMPTS = 3;",
          "",
          "export function computeBackoff(attempt: number): number {",
          "  if (attempt <= 0) return 0;",
          "  let delay = 100;",
          "  for (let i = 0; i < attempt; i++) {",
          "    delay *= 2;",
          "  }",
          "  return delay;",
          "}",
        ].join("\n"),
      }),
      "ask",
    );
  });

  test("the ask names the declared type and its possible destinations", () => {
    const result = decision(rule, {
      toolName: "Write",
      filePath: "src/utils/withRetry.ts",
      content: [
        "export interface RetryOptions {",
        "  attempts: number;",
        "}",
        "",
        "export function withRetry(options: RetryOptions) {",
        "  for (let i = 0; i < options.attempts; i++) {",
        "    if (i === 0) continue;",
        "  }",
        "}",
      ].join("\n"),
    });
    eq(result.action, "ask");
    eq(result.reason.includes("RetryOptions"), true);
    eq(
      result.fix,
      'Move "RetryOptions" into a types.ts beside "withRetry.ts". A store and an API service are the exception — their types stay at the project\'s shared types location.',
    );
  });

  test("the ask for a file matching conventions.apiLayer names only the shared types location", () => {
    const result = decision(rule, {
      toolName: "Write",
      filePath: "src/services/api/ordersApi.ts",
      content: [
        "export interface GetOrderDataResponse {",
        "  orderId: string;",
        "}",
        "",
        "export function getOrderData(orderId: string): GetOrderDataResponse {",
        '  if (!orderId) throw new Error("missing order id");',
        "  return { orderId };",
        "}",
      ].join("\n"),
    });
    eq(result.action, "ask");
    eq(result.reason.includes("GetOrderDataResponse"), true);
    eq(result.fix, 'Move "GetOrderDataResponse" into the project\'s shared types location.');
  });

  test("the ask names a declared constant and points at constants.ts", () => {
    const result = decision(rule, {
      toolName: "Write",
      filePath: "src/utils/backoff.ts",
      content: [
        "export const MAX_RETRY_ATTEMPTS = 3;",
        "",
        "export function computeBackoff(attempt: number): number {",
        "  if (attempt <= 0) return 0;",
        "  return attempt * 100;",
        "}",
      ].join("\n"),
    });
    eq(result.action, "ask");
    eq(result.reason.includes("MAX_RETRY_ATTEMPTS"), true);
    eq(result.fix, 'Move "MAX_RETRY_ATTEMPTS" into a constants.ts beside "backoff.ts".');
  });

  // --- SOFTELA: a .js/.jsx file is pointed at types.js/constants.js --------

  test("a plain-JavaScript file declaring a constant alongside real logic is pointed at constants.js, not constants.ts", () => {
    const result = decision(rule, {
      toolName: "Write",
      filePath: "src/utils/backoff.js",
      content: [
        "export const MAX_RETRY_ATTEMPTS = 3;",
        "",
        "export function computeBackoff(attempt) {",
        "  if (attempt <= 0) return 0;",
        "  return attempt * 100;",
        "}",
      ].join("\n"),
    });
    eq(result.action, "ask");
    eq(result.reason.includes("MAX_RETRY_ATTEMPTS"), true);
    eq(result.fix, 'Move "MAX_RETRY_ATTEMPTS" into a constants.js beside "backoff.js".');
  });

  test("a plain-JavaScript .jsx module with a hook-driven store shape and only a JSDoc @typedef is silent", () => {
    // A JSDoc @typedef is not detected — no type/interface/enum syntax and no
    // exported UPPER_SNAKE_CASE constant is declared here, so this is silent.
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/store/order/useOrderStore.jsx",
        content: [
          "/** @typedef {{ orders: string[] }} OrderStoreState */",
          "",
          "export const useOrderStore = () => {",
          "  const [state, setState] = useState({ orders: [] });",
          "  useEffect(() => {",
          "    setState({ orders: [] });",
          "  }, []);",
          "  return state;",
          "};",
        ].join("\n"),
      }),
      "pass",
    );
  });

  test("a plain-JavaScript file with a TypeScript-only interface declaration is still pointed at types.js beside it", () => {
    // The detection regexes are unchanged from upstream and match on text,
    // not on the file's actual language; when a .js file does contain this
    // TypeScript-only syntax (e.g. mid-migration), the destination named is
    // still the plain-JavaScript one.
    const result = decision(rule, {
      toolName: "Write",
      filePath: "src/utils/withRetry.js",
      content: [
        "export interface RetryOptions {",
        "  attempts: number;",
        "}",
        "",
        "export function withRetry(options) {",
        "  for (let i = 0; i < options.attempts; i++) {",
        "    if (i === 0) continue;",
        "  }",
        "}",
      ].join("\n"),
    });
    eq(result.action, "ask");
    eq(
      result.fix,
      'Move "RetryOptions" into a types.js beside "withRetry.js". A store and an API service are the exception — their types stay at the project\'s shared types location.',
    );
  });

  // --- positive: a constant exported through the two-part `export {}` form -

  test("a bare const later re-exported through a top-level export list asks", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/utils/backoff.ts",
        content: [
          "const MAX_RETRY_ATTEMPTS = 3;",
          "",
          "export function computeBackoff(attempt) {",
          "  if (attempt <= 0) return 0;",
          "  let delay = 100;",
          "  for (let i = 0; i < attempt; i++) {",
          "    delay *= 2;",
          "  }",
          "  return delay;",
          "}",
          "",
          "export { MAX_RETRY_ATTEMPTS };",
        ].join("\n"),
      }),
      "ask",
    );
  });

  test("a bare const re-exported under a renamed export binding still asks, naming the declared name", () => {
    const result = decision(rule, {
      toolName: "Write",
      filePath: "src/utils/backoff.ts",
      content: [
        "const MAX_RETRY_ATTEMPTS = 3;",
        "",
        "export function computeBackoff(attempt) {",
        "  if (attempt <= 0) return 0;",
        "  return attempt * 100;",
        "}",
        "",
        "export { MAX_RETRY_ATTEMPTS as DefaultRetryLimit };",
      ].join("\n"),
    });
    eq(result.action, "ask");
    eq(result.reason.includes("MAX_RETRY_ATTEMPTS"), true);
    eq(result.fix, 'Move "MAX_RETRY_ATTEMPTS" into a constants.ts beside "backoff.ts".');
  });

  test("a constant found through the two-part export form still wins the tie-break by its own const position", () => {
    const result = decision(rule, {
      toolName: "Write",
      filePath: "src/utils/backoff.ts",
      content: [
        "const MAX_RETRY_ATTEMPTS = 3;",
        "",
        "interface RetryState {",
        "  attempts: number;",
        "}",
        "",
        "export function computeBackoff(attempt) {",
        "  if (attempt <= 0) return 0;",
        "  return attempt * 100;",
        "}",
        "",
        "export { MAX_RETRY_ATTEMPTS };",
      ].join("\n"),
    });
    eq(result.action, "ask");
    eq(result.fix, 'Move "MAX_RETRY_ATTEMPTS" into a constants.ts beside "backoff.ts".');
  });

  // --- negative: an unexported constant is not this rule's concern ---------

  test("a private, non-exported UPPER_SNAKE_CASE constant is silent even alongside real logic", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/utils/backoff.ts",
        content: [
          "const MAX_RETRY_ATTEMPTS = 3;",
          "",
          "export function computeBackoff(attempt) {",
          "  if (attempt <= 0) return 0;",
          "  return attempt * MAX_RETRY_ATTEMPTS;",
          "}",
        ].join("\n"),
      }),
      "pass",
    );
  });

  // --- negative: a pure types file never fires, whatever it is named -------

  test("a file that only declares types, with no logic, is silent", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/utils/retryTypes.ts",
        content: [
          "export interface RetryOptions {",
          "  attempts: number;",
          "}",
          "",
          'export type RetryResult = "ok" | "failed";',
        ].join("\n"),
      }),
      "pass",
    );
  });

  // --- negative: a pure constants table never fires -------------------------

  test("a file that only lists constants, with no logic, is silent", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/utils/retryLimits.ts",
        content: ["export const MAX_RETRY_ATTEMPTS = 3;", "export const DEFAULT_DELAY_MS = 100;"].join("\n"),
      }),
      "pass",
    );
  });

  // --- negative: a declaration with only trivial, single-expression logic --

  test("a declared type beside a single-expression function with no control flow is silent", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/utils/formatLabel.ts",
        content: [
          "export interface FormatOptions {",
          "  uppercase: boolean;",
          "}",
          "",
          "export const formatLabel = (value: string, options: FormatOptions): string => value.trim();",
        ].join("\n"),
      }),
      "pass",
    );
  });

  // --- negative: real logic with nothing declared alongside it -------------

  test("a file with control flow but no type, interface, enum or constant declaration is silent", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/utils/plainLogic.ts",
        content: [
          "export function clampToRange(value, min, max) {",
          "  if (value < min) return min;",
          "  if (value > max) return max;",
          "  return value;",
          "}",
        ].join("\n"),
      }),
      "pass",
    );
  });

  // --- negative: inside the component tree is the component guards' territory -

  test("a file inside a component folder is silent, even with the same violating shape", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/components/Widget/useWidgetLocalState.ts",
        content: [
          "type WidgetLocalState = {",
          "  open: boolean;",
          "};",
          "",
          "export const useWidgetLocalState = () => {",
          "  const [state, setState] = useState<WidgetLocalState>({ open: false });",
          "  useEffect(() => {",
          "    setState({ open: false });",
          "  }, []);",
          "  return state;",
          "};",
        ].join("\n"),
      }),
      "pass",
    );
  });

  // --- negative: the dedicated destinations this rule points toward --------

  test("types.ts itself is silent even declaring a type alongside logic", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/store/order/types.ts",
        content: [
          "export interface OrderStoreState {",
          "  orders: string[];",
          "}",
          "",
          "export function isEmptyState(state: OrderStoreState): boolean {",
          "  if (state.orders.length === 0) return true;",
          "  return false;",
          "}",
        ].join("\n"),
      }),
      "pass",
    );
  });

  test("constants.ts itself is silent even declaring a constant alongside logic", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/store/order/constants.ts",
        content: [
          "export const MAX_RETRY_ATTEMPTS = 3;",
          "",
          "export function withinLimit(attempt) {",
          "  if (attempt > MAX_RETRY_ATTEMPTS) return false;",
          "  return true;",
          "}",
        ].join("\n"),
      }),
      "pass",
    );
  });

  test("a file under a types/ folder is silent", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/store/order/types/orderState.ts",
        content: [
          "export interface OrderStoreState {",
          "  orders: string[];",
          "}",
          "",
          "export function isEmptyState(state: OrderStoreState): boolean {",
          "  if (state.orders.length === 0) return true;",
          "  return false;",
          "}",
        ].join("\n"),
      }),
      "pass",
    );
  });

  test("a barrel index.ts is silent", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/store/order/index.ts",
        content: [
          "export type OrderStoreState = { orders: string[] };",
          "",
          'export { useOrderStore } from "./useOrderStore";',
        ].join("\n"),
      }),
      "pass",
    );
  });

  test("a test file is silent even matching the violating shape", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/utils/backoff.test.ts",
        content: [
          "export const MAX_RETRY_ATTEMPTS = 3;",
          "",
          "export function computeBackoff(attempt) {",
          "  if (attempt <= 0) return 0;",
          "  return attempt * 100;",
          "}",
        ].join("\n"),
      }),
      "pass",
    );
  });

  // --- negative: an existing file, per newCodeOnly --------------------------

  test("editing an existing file that already mixes its jobs is not relitigated", () => {
    eq(
      decide(rule, {
        toolName: "Edit",
        filePath: "src/utils/backoff.ts",
        content: [
          "export const MAX_RETRY_ATTEMPTS = 3;",
          "",
          "export function computeBackoff(attempt) {",
          "  if (attempt <= 0) return 0;",
          "  return attempt * 100;",
          "}",
        ].join("\n"),
        files: {
          "src/utils/backoff.ts": "export const MAX_RETRY_ATTEMPTS = 3;\n\nexport function computeBackoff() { return 0; }\n",
        },
      }),
      "pass",
    );
  });

  // --- negative: silent when the project declares no componentFolders ------

  test("silent when the project declares no componentFolders convention", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/utils/backoff.ts",
        content: [
          "export const MAX_RETRY_ATTEMPTS = 3;",
          "",
          "export function computeBackoff(attempt) {",
          "  if (attempt <= 0) return 0;",
          "  return attempt * 100;",
          "}",
        ].join("\n"),
        project: PROJECT_MINIMAL,
      }),
      "pass",
    );
  });

  // --- negative: a non-source extension is out of scope ---------------------

  test("a non-source frontend file (a stylesheet) is silent", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/utils/theme.scss",
        content: "if (true) { export const FOO_BAR = 1; }",
      }),
      "pass",
    );
  });

  // --- evasion ----------------------------------------------------------------

  test("a different write tool creating the same violating file still asks", () => {
    eq(
      decide(rule, {
        toolName: "apply_patch",
        filePath: "src/utils/backoff.ts",
        content: [
          "export const MAX_RETRY_ATTEMPTS = 3;",
          "",
          "export function computeBackoff(attempt) {",
          "  if (attempt <= 0) return 0;",
          "  return attempt * 100;",
          "}",
        ].join("\n"),
      }),
      "ask",
    );
  });

  test("backslash-separated Windows-style path still asks after normalisation", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src\\utils\\backoff.ts",
        content: [
          "export const MAX_RETRY_ATTEMPTS = 3;",
          "",
          "export function computeBackoff(attempt) {",
          "  if (attempt <= 0) return 0;",
          "  return attempt * 100;",
          "}",
        ].join("\n"),
      }),
      "ask",
    );
  });

  // --- override --------------------------------------------------------------

  test("an override can turn the rule off entirely", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/utils/backoff.ts",
        content: [
          "export const MAX_RETRY_ATTEMPTS = 3;",
          "",
          "export function computeBackoff(attempt) {",
          "  if (attempt <= 0) return 0;",
          "  return attempt * 100;",
          "}",
        ].join("\n"),
        overrideSpec: { "module-file-shape": { action: "off" } },
      }),
      "pass",
    );
  });
});
