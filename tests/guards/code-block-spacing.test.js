"use strict";

const rule = require("../../core/guards/code-block-spacing");
const { evaluate } = require("../../core/engine");
const { suite } = require("../harness");
const { PROJECT_BACKEND, decide, decision, makeCtx } = require("./_ctx");

/**
 * Builds a `classifyChange` stub that always answers the same classification,
 * the same shape `tests/guards/legacy-advisory.test.js` uses to exercise the
 * engine's `newCodeOnly` softening step without a real git repository.
 *
 * @param {"new" | "existing" | "unknown"} scope The classification to return.
 * @returns {(filePath: string, git: object) => string} The stub.
 */
function fakeClassifier(scope) {
  return () => scope;
}

/**
 * Runs the rule through the engine with an injected `classifyChange`.
 *
 * @param {object} ctxPartial Fields for `makeCtx`.
 * @param {"new" | "existing" | "unknown"} scope The classification to inject.
 * @returns {object | null} The decision, or `null`.
 */
function decideWithScope(ctxPartial, scope) {
  return evaluate(makeCtx(ctxPartial), { rules: [rule], classifyChange: fakeClassifier(scope) });
}

suite("guards/code-block-spacing", ({ test, eq, ok }) => {
  // --- positive: the developer's own reported cases -----------------------

  test("several multi-line hook calls run together, flush against each other, asks", () => {
    const content = [
      "function useLineChart(data, isFullStack, isHorizontal) {",
      "  const processedData = useProcessLineChartData(data, isFullStack);",
      "  const chartViewport = useChartViewport(",
      "    processedData.categories.length,",
      "    isHorizontal,",
      "  );",
      "  const visible = useMemo(",
      "    () => slice(processedData, chartViewport.viewport),",
      "    [chartViewport.viewport, processedData],",
      "  );",
      "}",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/useLineChart.tsx", content }), "ask");
  });

  test("a multi-line useMemo, a single-line useRef and a multi-line useEffect run together asks", () => {
    const content = [
      "function useScope(currentObject, scopeFromContext) {",
      "  const fallbackScope = useMemo(",
      "    () => buildObjectScope({ obj: currentObject }),",
      "    [currentObject],",
      "  );",
      "  const warnedRef = useRef(false);",
      "  useEffect(() => {",
      "    if (scopeFromContext || warnedRef.current) return;",
      "    warnedRef.current = true;",
      "  }, [scopeFromContext]);",
      "}",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/useScope.ts", content }), "ask");
  });

  // --- negative: the developer's own acceptable case -----------------------

  test("a run of single-line useState declarations of the same kind passes", () => {
    const content = [
      "function useDialogState() {",
      '  const [open, setOpen] = useState(false);',
      '  const [value, setValue] = useState("");',
      "  const [error, setError] = useState(undefined);",
      "}",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/useDialogState.ts", content }), "pass");
  });

  // --- positive: recursion into a nested statement block still applies ----

  test("two multi-line statements flush against each other inside a nested block still asks", () => {
    const content = [
      "function run(items) {",
      "  if (items.length > 0) {",
      "    const first = pickFirst(",
      "      items,",
      "    );",
      "    const rest = pickRest(",
      "      items,",
      "    );",
      "    return [first, rest];",
      "  }",
      "}",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/run.ts", content }), "ask");
  });

  // --- statement boundary: a statement that opens a brace, paren or bracket
  // does not end there — it ends at the terminator that follows, and that
  // terminator's own line is not a fresh statement compared against the
  // statement it closes. Each case below is an ordinary, well-formatted
  // declaration and the rule must be silent on all of them.

  test("a multi-line arrow-function const is one statement, not its own opening and closing lines compared against each other", () => {
    const content = [
      "const NotificationOutlet = () => {",
      "  return null;",
      "};",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/App.tsx", content }), "pass");
  });

  test("a multi-line arrow-function const with a typed parameter is one statement the same way", () => {
    const content = [
      "const parseOrderIndex = (z: string | undefined) => {",
      "  return Number(z);",
      "};",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/appcomponent/index.tsx", content }), "pass");
  });

  test("a type alias with a braced body is one statement ending at its own trailing semicolon", () => {
    const content = ["type DocumentBoxProps = {", "  title: string;", "  value: string;", "};", ""].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/display-type/DocumentBox.tsx", content }), "pass");
  });

  test("a multi-line parameter list before an arrow function's own block is still one statement", () => {
    const content = [
      "const readBooleanProperty = (",
      "  value: string | undefined,",
      ") => {",
      "  return Boolean(value);",
      "};",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/display-type/DateTextField.tsx", content }), "pass");
  });

  test("the real adjacency violation surrounding a block-terminated statement is still found once the statement's own boundary is read correctly", () => {
    // The same shape as the developer's own arrow-const case, but this time
    // with a genuine second statement flush against it — proving the fix
    // does not just silence the check, it reads the boundary correctly.
    const content = [
      "const NotificationOutlet = () => {",
      "  return null;",
      "};",
      "const other = doSomething();",
      "",
    ].join("\n");
    const result = decision(rule, { toolName: "Write", filePath: "src/App.tsx", content });
    eq(result.action, "ask");
    ok(result.reason.includes("const other = doSomething();"), "the real neighbor is named, not the statement's own lines");
  });

  // --- statement boundary: a comma inside a generic type argument list is
  // not a top-level statement separator. `<` and `>` are not otherwise
  // depth-tracked at all, so without this a multi-parameter generic
  // (`Record<string, string>`) reads as two statements split at its own
  // comma.

  test("a generic type argument list with more than one parameter is not split at its own comma", () => {
    const content = [
      "const mimeByExtension: Record<string, string> = {",
      "  tif: 'image/tiff',",
      "};",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/DocumentBox.tsx", content }), "pass");
  });

  test("nested multi-parameter generics are not split at either level's own comma", () => {
    const content = ["const x: Record<string, Array<number>> = {};", ""].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/a.ts", content }), "pass");
  });

  test("a generic function declaration's own type parameter list is not split at its comma", () => {
    const content = ["function pick<T, U>(a: T, b: U): T {", "  return a;", "}", ""].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/a.ts", content }), "pass");
  });

  test("a class implementing a multi-parameter generic interface is not split at the interface's own comma", () => {
    const content = ["class Foo implements Comparable<Foo, Bar> {", "  x = 1;", "}", ""].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/Foo.ts", content }), "pass");
  });

  test("an ordinary comparison operator is not mistaken for a generic's opening angle bracket", () => {
    // "<" here is a real less-than comparison, always written with a space
    // before it in formatted code — the same thing that tells a generic's
    // "<" (always glued to its identifier) apart from this one.
    const content = [
      "function f(a, b) {",
      "  if (a < b) {",
      "    return a;",
      "  }",
      "",
      "  return b;",
      "}",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/a.ts", content }), "pass");
  });

  // --- statement boundary: a regex literal's own body is not real syntax --
  //
  // A regex character class matching either quote style (`['"]`) contains a
  // lone `'` with no closing partner nearby from the mask's own point of
  // view; masking comments and strings before ever checking for a regex
  // reads that `'` as opening a real string, which does not close until an
  // unrelated quote somewhere later in the file — corrupting everything
  // in between. Checking for a regex first is what this proves.

  test("a regex literal containing a bracket character class with both quote characters does not corrupt the statements around it", () => {
    const content = [
      "const matchesQuoted = /navigate\\(\\s*(?:['\"])?.*done(?:['\"])?.*\\)\\s*$/i;",
      "const other = 1;",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/a.ts", content }), "pass");
  });

  test("two adjacent regex-literal declarations, each genuinely single-line, still pass", () => {
    const content = [
      "const navKeepRe = /^\\{?navigate\\(([^,]+)\\)\\}?$/i;",
      "const navDirectRe = /^navigate\\(([^,()]+)\\)\\s*$/i;",
      "const navSourceRe = /navigate\\(.*sourcepage.*\\)\\s*$/i;",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/a.ts", content }), "pass");
  });

  test("a real violation is still found once regex literals stop corrupting the scan around them", () => {
    const content = [
      "const matchesQuoted = /navigate\\(\\s*(?:['\"])?.*done(?:['\"])?.*\\)\\s*$/i;",
      "const built = useMemo(",
      "  () => build(matchesQuoted),",
      "  [matchesQuoted],",
      ");",
      "const after = 1;",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/a.ts", content }), "ask");
  });

  // --- exemption: the import block at the top of a file -------------------

  test("two multi-line import statements flush against each other pass", () => {
    const content = [
      "import {",
      "  Foo,",
      "  Bar,",
      '} from "./foo";',
      "import {",
      "  Baz,",
      '} from "./baz";',
      "",
      "export const value = Foo(Bar(Baz));",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/a.ts", content }), "pass");
  });

  test("a multi-line import immediately followed by a multi-line non-import statement still asks", () => {
    // Only import-to-import pairs are exempt — the import block boundary
    // itself is not, so the ordinary rule still applies right after it.
    const content = [
      "import {",
      "  Foo,",
      '} from "./foo";',
      "const result = Foo(",
      "  1,",
      ");",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/a.ts", content }), "ask");
  });

  // --- exemption: a run of re-export statements, the mirror image of the
  // import block ------------------------------------------------------------

  test("a mix of single- and multi-line re-exports, flush against each other, pass", () => {
    const content = [
      "export {",
      "  updateUIState,",
      "  clearForm,",
      '} from "./state";',
      'export { fetchDropdownFnService } from "./fetchers";',
      "export {",
      "  baseGetAllTableEditors,",
      "  createOrderPanel,",
      '} from "./orderPanel";',
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/index.ts", content }), "pass");
  });

  test("a star re-export flush against a named-list re-export passes", () => {
    const content = ['export * from "./barcode-scanner";', "export {", "  a,", '} from "./a";', ""].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/index.ts", content }), "pass");
  });

  test("a multi-line typed re-export flush against an ordinary one passes", () => {
    const content = [
      "export type {",
      "  Mode,",
      "  OrderPanelControl,",
      '} from "./types";',
      'export { initOrderPanel } from "./init";',
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/index.ts", content }), "pass");
  });

  test("a doc comment directly above a re-export, with no blank line, is still exempt", () => {
    // The import exemption skips the whole check before the comment/blank
    // line logic is even reached — the re-export exemption mirrors that.
    const content = [
      'export { a } from "./a";',
      "/** b's own doc comment */",
      "export {",
      "  b,",
      '} from "./b";',
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/index.ts", content }), "pass");
  });

  test("a re-export flush against ordinary logic is not exempt", () => {
    const content = [
      "export {",
      "  a,",
      '} from "./a";',
      "const value = compute(",
      "  a,",
      ");",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/index.ts", content }), "ask");
  });

  test("a multi-line export const declaration is a statement like any other, not a re-export", () => {
    const content = [
      "export const config = {",
      "  a: 1,",
      "};",
      "export const other = compute(",
      "  1,",
      ");",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/index.ts", content }), "ask");
  });

  test("a multi-line export function declaration is a statement like any other, not a re-export", () => {
    const content = [
      "export function first() {",
      "  return 1;",
      "}",
      "export function second(",
      "  a,",
      ") {",
      "  return a;",
      "}",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/index.ts", content }), "ask");
  });

  test("a local named export with no from clause is not a re-export, and still needs its own spacing", () => {
    const content = [
      "const helper = () => {",
      "  return 1;",
      "};",
      "export { helper };",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/index.ts", content }), "ask");
  });

  // --- exemption: anything at bracket/brace/paren depth greater than zero -

  test("multi-line object literal properties, flush against each other, pass", () => {
    const content = [
      "export const config = {",
      "  a: computeSomething(",
      "    1,",
      "    2,",
      "  ),",
      "  b: computeOther(",
      "    3,",
      "    4,",
      "  ),",
      "};",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/config.ts", content }), "pass");
  });

  test("multi-line argument list entries, flush against each other, pass", () => {
    const content = [
      "callFn(",
      "  first(",
      "    1,",
      "  ),",
      "  second(",
      "    2,",
      "  ),",
      ");",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/a.ts", content }), "pass");
  });

  test("multi-line array literal elements, flush against each other, pass", () => {
    const content = [
      "export const items = [",
      "  build(",
      "    1,",
      "  ),",
      "  build(",
      "    2,",
      "  ),",
      "];",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/a.ts", content }), "pass");
  });

  // --- exemption: the body of a type, interface, class or enum -----------

  test("multi-line interface member type references, flush against each other with no doc comments, pass", () => {
    const content = [
      "export interface Foo {",
      "  a: SomeVeryLongType<",
      "    A,",
      "    B",
      "  >;",
      "  b: AnotherType<",
      "    C,",
      "    D",
      "  >;",
      "}",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/foo.ts", content }), "pass");
  });

  test("multi-line class method signatures, flush against each other with no doc comments, pass", () => {
    const content = [
      "export class Widget {",
      "  configure(",
      "    a,",
      "    b,",
      "  ) {",
      "    return a + b;",
      "  }",
      "  reset(",
      "    c,",
      "  ) {",
      "    return c;",
      "  }",
      "}",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/Widget.ts", content }), "pass");
  });

  test("enum members, flush against each other, pass", () => {
    const content = ["export enum Status {", "  Open,", "  Closed,", "}", ""].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/status.ts", content }), "pass");
  });

  // --- exemption: an attached leading comment belongs to its statement ----

  test("a leading comment with no blank line above it still asks, pointed at the comment's own line", () => {
    const content = [
      "function run() {",
      "  const a = useThing(",
      "    1,",
      "    2,",
      "  );",
      "  // explains b",
      "  const b = useOtherThing(",
      "    3,",
      "    4,",
      "  );",
      "}",
      "",
    ].join("\n");
    const result = decision(rule, { toolName: "Write", filePath: "src/run.ts", content });
    eq(result.action, "ask");
    eq(result.fix, "Insert a blank line before line 6.");
  });

  test("a leading comment with a blank line placed above the comment itself passes", () => {
    const content = [
      "function run() {",
      "  const a = useThing(",
      "    1,",
      "    2,",
      "  );",
      "",
      "  // explains b",
      "  const b = useOtherThing(",
      "    3,",
      "    4,",
      "  );",
      "}",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/run.ts", content }), "pass");
  });

  // --- exemption: switch cases ----------------------------------------------

  test("multi-line statements flush against each other inside a switch case pass", () => {
    const content = [
      "function run(x) {",
      "  switch (x) {",
      "    case 1:",
      "      const a = doThing(",
      "        1,",
      "        2,",
      "      );",
      "      const b = doOtherThing(",
      "        3,",
      "        4,",
      "      );",
      "      break;",
      "    default:",
      "      break;",
      "  }",
      "}",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/run.ts", content }), "pass");
  });

  // --- second check: a doc-commented member needs its own blank line ------

  test("a doc-commented interface member flush against the member before it asks", () => {
    const content = ["export interface Foo {", "  a: string;", "  /** b doc */", "  b: number;", "}", ""].join("\n");
    const result = decision(rule, { toolName: "Write", filePath: "src/foo.ts", content });
    eq(result.action, "ask");
    ok(result.reason.includes("doc comment"), "the reason names the doc-comment rule");
  });

  test("a doc-commented class member flush against the member before it asks", () => {
    const content = ["export class Widget {", "  a = 1;", "  /** b doc */", "  b = 2;", "}", ""].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/Widget.ts", content }), "ask");
  });

  test("a doc-commented interface member separated by a blank line from the member before it passes", () => {
    const content = ["export interface Foo {", "  a: string;", "", "  /** b doc */", "  b: number;", "}", ""].join(
      "\n",
    );
    eq(decide(rule, { toolName: "Write", filePath: "src/foo.ts", content }), "pass");
  });

  test("the first member of a type body carries no prior neighbor to compare against, and passes", () => {
    const content = ["export interface Foo {", "  /** a doc */", "  a: string;", "}", ""].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/foo.ts", content }), "pass");
  });

  // --- reconstruction: a decoded Edit/MultiEdit's own inserted snippet -----
  //
  // A real Edit call's own `content` is only the text it inserts; the
  // statement it is inserted next to is frequently outside that snippet
  // entirely. The rule must judge adjacency against the whole reconstructed
  // file when one is available, not only the isolated inserted text.

  test("a violation visible only against the file's existing neighbor, not inside the inserted snippet alone, still asks", () => {
    const wholeFile = [
      "function useLineChart() {",
      "  const [open, setOpen] = useState(false);",
      "  const chartViewport = useChartViewport(",
      "    processedData.categories.length,",
      "    isHorizontal,",
      "  );",
      "}",
      "",
    ].join("\n");
    const insertedSnippetOnly = [
      "  const chartViewport = useChartViewport(",
      "    processedData.categories.length,",
      "    isHorizontal,",
      "  );",
      "",
    ].join("\n");
    eq(
      decide(rule, {
        toolName: "Edit",
        filePath: "src/useLineChart.ts",
        content: insertedSnippetOnly,
        resultingContent: wholeFile,
      }),
      "ask",
    );
  });

  test("with no reconstructed content available, the isolated inserted snippet is judged on its own and passes", () => {
    // Same insertion as above, but reconstruction failed (resultingContent
    // stays unset) — there is nothing to fall back to except the snippet
    // itself, which alone carries no prior neighbor to compare against.
    const insertedSnippetOnly = [
      "  const chartViewport = useChartViewport(",
      "    processedData.categories.length,",
      "    isHorizontal,",
      "  );",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Edit", filePath: "src/useLineChart.ts", content: insertedSnippetOnly }), "pass");
  });

  // --- Softela adaptation: the check covers plain JavaScript too, since
  // Bugworx is a plain-JavaScript React frontend, not only TypeScript -------

  test("a .js file with the same run-together shape asks, not only a .ts one", () => {
    const content = [
      "function run() {",
      "  const a = useThing(",
      "    1,",
      "  );",
      "  const b = useOtherThing(",
      "    2,",
      "  );",
      "}",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/run.js", content }), "ask");
  });

  test("a .jsx file with the same run-together shape asks", () => {
    const content = [
      "function OrderPanel({ orderId }) {",
      "  const summary = useOrderSummary(",
      "    orderId,",
      "  );",
      "  const total = useMemo(",
      "    () => summary.total,",
      "    [summary],",
      "  );",
      "  return <div>{total}</div>;",
      "}",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/OrderPanel.jsx", content }), "ask");
  });

  test("JSX inside a .js file does not stop the check from scanning it", () => {
    const content = [
      "function OrderPanel({ orderId }) {",
      "  const summary = useOrderSummary(",
      "    orderId,",
      "  );",
      "  const total = useMemo(",
      "    () => summary.total,",
      "    [summary],",
      "  );",
      "  return <div>{total}</div>;",
      "}",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/OrderPanel.js", content }), "ask");
  });

  // --- negative: out of scope work -----------------------------------------

  test("a non-source file with the same run-together shape passes silently", () => {
    const content = [
      "function run() {",
      "  const a = useThing(",
      "    1,",
      "  );",
      "  const b = useOtherThing(",
      "    2,",
      "  );",
      "}",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/run.py", content }), "pass");
  });

  test("a project on the backend stack passes silently even with the same run-together shape", () => {
    const content = [
      "function run() {",
      "  const a = useThing(",
      "    1,",
      "  );",
      "  const b = useOtherThing(",
      "    2,",
      "  );",
      "}",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/run.ts", content, project: PROJECT_BACKEND }), "pass");
  });

  test("empty written content passes", () => {
    eq(decide(rule, { toolName: "Write", filePath: "src/run.ts", content: "" }), "pass");
  });

  // --- fix: a parameterless catch no longer fuses the try/catch block with
  // the statement after it -------------------------------------------------

  test("a parameterless catch keeps the try/catch as its own segment instead of fusing it with the statement after it", () => {
    const content = [
      "function run() {",
      "  try {",
      "    a();",
      "  } catch {",
      "    b();",
      "  }",
      "  const result = doSomething(",
      "    item",
      "  );",
      "  const other = doSomethingElse(",
      "    item",
      "  );",
      "}",
      "",
    ].join("\n");
    const result = decision(rule, { toolName: "Write", filePath: "src/run.ts", content });
    eq(result.action, "ask");
    eq(result.fix, "Insert a blank line before line 7.");
    ok(
      result.reason.includes('"const result = doSomething("'),
      "the reported neighbor is the statement right after the catch block, not one two segments away",
    );
    ok(
      !result.reason.includes("doSomethingElse"),
      "the try/catch and the first statement after it are not fused with a second statement further down",
    );
  });

  // --- fix: a callback's own block body in argument or array-literal
  // position is scanned the same way a top-level block is ------------------

  test("a callback's own block body inside a call's argument list is scanned for spacing the same way a top-level block is", () => {
    const content = [
      "items.forEach((item) => {",
      "  const a = useThing(",
      "    item,",
      "  );",
      "  const b = useOtherThing(",
      "    item,",
      "  );",
      "});",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/run.ts", content }), "ask");
  });

  test("the same callback properly spaced passes, proving the fix checks spacing rather than always flagging a callback body", () => {
    const content = [
      "items.forEach((item) => {",
      "  const a = useThing(",
      "    item,",
      "  );",
      "",
      "  const b = useOtherThing(",
      "    item,",
      "  );",
      "});",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/run.ts", content }), "pass");
  });

  test("a callback's own block body inside an array-literal element is scanned for spacing the same way", () => {
    const content = [
      "const handlers = [",
      "  () => {",
      "    const a = useThing(",
      "      1",
      "    );",
      "    const b = useOtherThing(",
      "      2",
      "    );",
      "  },",
      "];",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/run.ts", content }), "ask");
  });

  // --- fix: an ordinary statement with no terminating semicolon is still
  // split from the next one when that next one unambiguously opens a new
  // statement ---------------------------------------------------------------

  test("two ordinary declarations with no terminating semicolons still ask, since the next line unambiguously opens a new statement", () => {
    const content = [
      "const a = doSomething(",
      "  item",
      ")",
      "const b = doSomethingElse(",
      "  item",
      ")",
      "",
    ].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/run.ts", content }), "ask");
  });

  test("a chained call continuing on the next line, with no terminating semicolon, is not mistaken for a new statement", () => {
    // The conservative side of the same fix: nothing in the whitelist of
    // unambiguous statement-starting keywords matches a leading ".", so this
    // stays one statement instead of being split at the wrong place.
    const content = ["const a = build(", "  1", ")", "  .withExtra(", "    2", "  )", ""].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/run.ts", content }), "pass");
  });

  // Three of the statement-starting keywords are equally legal in expression
  // position, so reading only the line below the newline is not enough to
  // call it a boundary: a value assigned across two lines would be split in
  // the middle of a single statement, and the rule would demand a blank line
  // there. The line above the newline is what settles it.

  test("a function expression on a continuation line is not split from the assignment it belongs to", () => {
    const content = ["const handler =", "  function () {", "    return 1;", "  };", ""].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/run.ts", content }), "pass");
  });

  test("a class expression on a continuation line is not split from the assignment it belongs to", () => {
    const content = ["const Widget =", "  class extends Base {", "    render() {}", "  };", ""].join("\n");
    eq(decide(rule, { toolName: "Write", filePath: "src/run.ts", content }), "pass");
  });

  // --- newCodeOnly softening ------------------------------------------------

  const RUN_TOGETHER_CONTENT = [
    "function run() {",
    "  const a = useThing(",
    "    1,",
    "  );",
    "  const b = useOtherThing(",
    "    2,",
    "  );",
    "}",
    "",
  ].join("\n");

  test("the same violation on a file classified existing is softened to ask, with the advice framing", () => {
    const result = decideWithScope(
      { toolName: "Write", filePath: "src/run.ts", content: RUN_TOGETHER_CONTENT },
      "existing",
    );
    eq(result.action, "ask");
    eq(result.advisory, true);
    ok(result.reason.toUpperCase().includes("ADVICE"), "the reason states this is advice, not a requirement");
  });

  test("the same violation on a file classified new is still only an ask, with no advice-framing prefix", () => {
    // The rule already ships as `ask` (see the module doc comment's own
    // "Severity" section), so `newCodeOnly` softening has nothing left to
    // clamp on a new file — the only thing it would still change, the
    // ADVICE-framed reason, is reserved for a file proven to already exist.
    const result = decideWithScope(
      { toolName: "Write", filePath: "src/run.ts", content: RUN_TOGETHER_CONTENT },
      "new",
    );
    eq(result.action, "ask");
    eq(result.advisory, true);
    ok(!result.reason.toUpperCase().includes("ADVICE"), "a new file gets the rule's own reason, not the advice framing");
  });

  // --- override --------------------------------------------------------------

  test("an override can turn the rule off entirely", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "src/run.ts",
        content: RUN_TOGETHER_CONTENT,
        overrideSpec: { "code-block-spacing": { action: "off" } },
      }),
      "pass",
    );
  });
});
