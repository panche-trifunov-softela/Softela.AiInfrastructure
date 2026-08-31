"use strict";

/**
 * `component-view-logic` — the rule that encodes the frontend standard's
 * first and load-bearing claim: the view renders, and everything the
 * component *does* lives in its own hook.
 *
 * The negative cases matter as much as the positive one. A rule that fires
 * on legitimate rendering work gets argued with, and a rule that gets argued
 * with gets switched off — so `useMemo`, a view that merely calls its own
 * hook, and a purely presentational component all have to pass.
 */

const { suite } = require("../harness");
const rule = require("../../core/guards/component-view-logic");
const { decide, decision } = require("./_ctx");

/** The frontend conventions this rule needs before it says anything at all. */
const PROJECT = {
  conventions: { componentFolders: "src/components/**", testFolder: "__tests__" },
};

/**
 * Builds a context for one new-file write inside a component folder.
 *
 * @param {string} rel The repo-relative path being written.
 * @param {string} content The file's content.
 * @param {{existing?: string}} [options] `existing` makes the file already
 * present on disk, for the new-code-only cases.
 * @returns {object} The context fields `decide` needs.
 */
function write(rel, content, options) {
  const existing = options && typeof options.existing === "string" ? options.existing : null;
  return {
    toolName: "Write",
    filePath: `/repo/${rel}`,
    content,
    cwd: "/repo",
    git: { repoRoot: "/repo" },
    // `_ctx` builds `readFile` from this map — the same map every other guard
    // suite uses to say "this path is already on disk".
    files: existing === null ? {} : { [`/repo/${rel}`]: existing },
    project: PROJECT,
    stack: "frontend",
  };
}

/** A view carrying every marker at once — the shape this rule exists for. */
const VIEW_WITH_LOGIC = [
  'import React, { useCallback, useEffect, useState } from "react";',
  'import { postHandler } from "../../../services";',
  "const Panel = ({ id }) => {",
  "  const [open, setOpen] = useState(false);",
  "  useEffect(() => {",
  "    const onKey = () => setOpen(true);",
  '    window.addEventListener("keydown", onKey);',
  '    return () => window.removeEventListener("keydown", onKey);',
  "  }, []);",
  "  const run = useCallback(async () => { await postHandler(id); }, [id]);",
  "  return <button onClick={run}>{open ? 1 : 2}</button>;",
  "};",
  "export default Panel;",
].join("\n");

suite("guards/component-view-logic", ({ test, eq, ok }) => {
  /* ------------------------------------------------------------- fires */

  test("a new view carrying state, an effect and imperative wiring is denied", () => {
    eq(decide(rule, write("src/components/panel/Panel/Panel.tsx", VIEW_WITH_LOGIC)), "deny");
  });

  test("the denial names every marker it found and the hook file to move them to", () => {
    const d = decision(rule, write("src/components/panel/Panel/Panel.tsx", VIEW_WITH_LOGIC));
    ok(d.reason.includes("useState"), d.reason);
    ok(d.reason.includes("useEffect"), d.reason);
    ok(d.reason.includes("addEventListener"), d.reason);
    ok(d.fix.includes("src/components/panel/Panel/usePanel.ts"), d.fix);
    // The escape hatch has to be stated, or the rule reads as "no logic in a
    // component at all" and gets worked around instead of followed.
    ok(d.fix.includes("Rendering-only work"), d.fix);
  });

  test("each marker is enough on its own", () => {
    const cases = {
      useState: 'import {useState} from "react";\nconst C=()=>{const [a,s]=useState(0);return <b>{a}</b>;};',
      useReducer: 'import {useReducer} from "react";\nconst C=()=>{const [a]=useReducer(f,0);return <b>{a}</b>;};',
      useEffect: 'import {useEffect} from "react";\nconst C=()=>{useEffect(()=>{},[]);return <b/>;};',
      useLayoutEffect: 'import {useLayoutEffect} from "react";\nconst C=()=>{useLayoutEffect(()=>{},[]);return <b/>;};',
      addEventListener: 'const C=()=>{window.addEventListener("x",f);return <b/>;};',
      await: "const C=()=>{const go=async()=>{await load();};return <b onClick={go}/>;};",
      then: "const C=()=>{const go=()=>{load().then(x=>x);};return <b onClick={go}/>;};",
    };
    for (const [label, content] of Object.entries(cases)) {
      eq(decide(rule, write("src/components/x/C/C.tsx", content)), "deny", `${label} alone must be enough`);
    }
  });

  /* ----------------------------------------------------------- stays quiet */

  test("a purely presentational view passes", () => {
    const content = 'import React from "react";\nconst Card = ({ t, on }) => <div className={on ? "a" : "b"}>{t}</div>;\nexport default Card;';
    eq(decide(rule, write("src/components/x/Card/Card.tsx", content)), "pass");
  });

  test("useMemo and useCallback alone are rendering work, not logic", () => {
    // The standard explicitly allows the view "a conditional class, a mapped
    // list, a small piece of formatting". Firing here would make the rule
    // wrong often enough to be argued with.
    const content =
      'import { useCallback, useMemo } from "react";\n' +
      "const List = ({ rows, onPick }) => {\n" +
      "  const ids = useMemo(() => rows.map((r) => r.id), [rows]);\n" +
      "  const pick = useCallback((r) => onPick(r), [onPick]);\n" +
      "  return <ul>{ids.map((i) => <li key={i} onClick={pick}>{i}</li>)}</ul>;\n" +
      "};";
    eq(decide(rule, write("src/components/x/List/List.tsx", content)), "pass");
  });

  test("a view that calls its own hook passes — that is the whole point", () => {
    const content = 'import { useCard } from "./useCard";\nconst Card = () => {\n  const { title, onPick } = useCard();\n  return <b onClick={onPick}>{title}</b>;\n};';
    eq(decide(rule, write("src/components/x/Card/Card.tsx", content)), "pass");
  });

  test("the component's own hook file is exempt, in both extensions", () => {
    const content = 'import {useState,useEffect} from "react";\nexport const useCard=()=>{const [a,s]=useState(0);useEffect(()=>{},[]);return {a};};';
    eq(decide(rule, write("src/components/x/Card/useCard.ts", content)), "pass");
    eq(decide(rule, write("src/components/x/Card/useCard.tsx", content)), "pass");
  });

  test("a test file is exempt", () => {
    const content = 'import {useState} from "react";\nuseState(1);';
    eq(decide(rule, write("src/components/x/Card/__tests__/Card.test.tsx", content)), "pass");
  });

  test("the barrel is exempt", () => {
    eq(decide(rule, write("src/components/x/Card/index.tsx", 'export { default } from "./Card";')), "pass");
  });

  test("a marker that only appears in a comment or a string does not count", () => {
    const content =
      "// useState is intentionally not used here; the hook owns it.\n" +
      'const NOTE = "call useEffect from the hook, never here";\n' +
      "const Card = () => <b>{NOTE}</b>;";
    eq(decide(rule, write("src/components/x/Card/Card.tsx", content)), "pass");
  });

  test("an import of the marker without calling it does not count", () => {
    // Importing without using is dead code, not a layering violation, and it
    // is not this rule's business to say so.
    const content = 'import { useState } from "react";\nconst Card = ({ t }) => <b>{t}</b>;';
    eq(decide(rule, write("src/components/x/Card/Card.tsx", content)), "pass");
  });

  /* -------------------------------------------------------------- scope */

  test("an existing view is not relitigated — extracting its logic is a refactor", () => {
    eq(
      decide(rule, write("src/components/x/Card/Card.tsx", VIEW_WITH_LOGIC, { existing: "old content" })),
      "pass",
    );
  });

  test("a file outside the component folders is none of this rule's business", () => {
    eq(decide(rule, write("src/pages/Home.tsx", VIEW_WITH_LOGIC)), "pass");
  });

  test("without the componentFolders convention the rule says nothing at all", () => {
    const ctx = write("src/components/x/Card/Card.tsx", VIEW_WITH_LOGIC);
    ctx.project = { conventions: {} };
    eq(decide(rule, ctx), "pass");
  });

  test("a .ts file that is not a view is out of scope", () => {
    const content = 'import {useState} from "react";\nexport const helper=()=>useState(0);';
    eq(decide(rule, write("src/components/x/Card/helpers.ts", content)), "pass");
  });
});
