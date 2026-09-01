"use strict";

/**
 * `core/lib/config-merge.js` — the layer that puts `projects/_default.json`
 * underneath a matched project instead of leaving it as a fallback nobody
 * named reaches.
 *
 * The property this suite exists to hold: **a project config adds
 * protections and never silently loses one.** The failure it guards against
 * is invisible from the outside — a repository that looks configured, reads
 * as configured, and has quietly stopped protecting `.env` because somebody
 * wrote a project file for it. Most cases below are therefore negative: the
 * keys that must NOT be inherited, and the shapes that must NOT be unioned.
 */

const path = require("path");
const { suite } = require("../harness");
const { readJson } = require("../../core/lib/fs-safe");
const { mergeConfigLayer, strongerAction } = require("../../core/lib/config-merge");
const { loadDefaultProject } = require("../../core/lib/project-resolver");

const REPO_ROOT = path.join(__dirname, "..", "..");
const PROJECTS_DIR = path.join(REPO_ROOT, "projects");

/** Paths of a merged config's `protectedPaths`, for order-sensitive assertions. */
function paths(config) {
  return (config.protectedPaths || []).map((entry) => entry.path);
}

/** The action a merged config carries for one protected path. */
function actionFor(config, target) {
  const found = (config.protectedPaths || []).find((entry) => entry.path === target);
  return found ? found.action : undefined;
}

suite("lib/config-merge", ({ test, eq, deepEq }) => {
  /* ------------------------------------------------------------ additive */

  test("a project declaring its own protected path still inherits the base layer's", () => {
    const merged = mergeConfigLayer(
      { protectedPaths: [{ path: "**/.env", action: "ask" }] },
      { id: "P", protectedPaths: [{ path: "docs/SPEC.md", action: "ask" }] },
    );
    deepEq(paths(merged), ["docs/SPEC.md", "**/.env"]);
  });

  test("a project declaring no protected paths at all inherits the base layer's whole list", () => {
    const merged = mergeConfigLayer({ protectedPaths: [{ path: "**/.env", action: "ask" }] }, { id: "P" });
    deepEq(paths(merged), ["**/.env"]);
  });

  test("the project's own entry keeps its reason, which is what a denial actually shows", () => {
    const merged = mergeConfigLayer(
      { protectedPaths: [{ path: "**/.env", action: "ask", reason: "inherited" }] },
      { id: "P", protectedPaths: [{ path: "**/.env", action: "ask", reason: "this repository's own wording" }] },
    );
    eq(paths(merged).length, 1);
    eq(merged.protectedPaths[0].reason, "this repository's own wording");
  });

  test("baseBranches union rather than replace, so naming one base does not unprotect the others", () => {
    const merged = mergeConfigLayer({ baseBranches: ["dev", "main"] }, { id: "P", baseBranches: ["dev-ng"] });
    deepEq(merged.baseBranches, ["dev-ng", "dev", "main"]);
  });

  test("a duplicate string in both layers appears once", () => {
    const merged = mergeConfigLayer({ baseBranches: ["dev", "main"] }, { id: "P", baseBranches: ["main"] });
    deepEq(merged.baseBranches, ["main", "dev"]);
  });

  test("commands.forbidden unions while the project keeps its own typecheck", () => {
    const merged = mergeConfigLayer(
      { commands: { forbidden: [{ pattern: "\\brm -rf\\b", action: "deny" }] } },
      { id: "P", commands: { typecheck: { deny: "x", fix: "y" }, forbidden: [{ pattern: "\\bcypress\\b", action: "deny" }] } },
    );
    deepEq(merged.commands.forbidden.map((f) => f.pattern), ["\\bcypress\\b", "\\brm -rf\\b"]);
    eq(merged.commands.typecheck.fix, "y");
  });

  test("a project declaring commands but no forbidden list still inherits the base layer's", () => {
    const merged = mergeConfigLayer(
      { commands: { forbidden: [{ pattern: "\\brm -rf\\b", action: "deny" }] } },
      { id: "P", commands: { typecheck: { deny: "x" } } },
    );
    deepEq(merged.commands.forbidden.map((f) => f.pattern), ["\\brm -rf\\b"]);
  });

  /* ------------------------------------------------------- never weaker */

  test("a project restating an inherited protection more weakly is raised back to the stronger action", () => {
    const merged = mergeConfigLayer(
      { protectedPaths: [{ path: "**/.env", action: "deny" }] },
      { id: "P", protectedPaths: [{ path: "**/.env", action: "ask" }] },
    );
    eq(actionFor(merged, "**/.env"), "deny");
  });

  test("a project tightening an inherited protection keeps its own stronger action", () => {
    const merged = mergeConfigLayer(
      { protectedPaths: [{ path: "**/.env", action: "ask" }] },
      { id: "P", protectedPaths: [{ path: "**/.env", action: "deny" }] },
    );
    eq(actionFor(merged, "**/.env"), "deny");
  });

  test("an entry naming no action keeps naming none, so the rule's own default still decides", () => {
    const merged = mergeConfigLayer(
      { localConfig: [{ tracked: "public/config.js", action: "ask" }] },
      { id: "P", localConfig: [{ tracked: "public/config.js" }] },
    );
    eq(merged.localConfig[0].action, undefined);
  });

  test("an explicit off is the one deliberate way out, and survives the merge", () => {
    const merged = mergeConfigLayer(
      { protectedPaths: [{ path: "**/.env", action: "deny" }] },
      { id: "P", protectedPaths: [{ path: "**/.env", action: "off" }] },
    );
    eq(actionFor(merged, "**/.env"), "off");
  });

  test("strongerAction ranks the real action vocabulary, and an unknown value never wins", () => {
    eq(strongerAction("ask", "deny"), "deny");
    eq(strongerAction("deny", "ask"), "deny");
    eq(strongerAction("off", "ask"), "ask");
    eq(strongerAction("ask", "nonsense"), "ask");
    eq(strongerAction("nonsense", "ask"), "ask");
  });

  /* -------------------------------------------------------- not inherited */

  test("id is never inherited — a merged project keeps its own identity and its own overrides", () => {
    const merged = mergeConfigLayer({ id: "_default" }, { id: "Softela.PestManagement" });
    eq(merged.id, "Softela.PestManagement");
  });

  test("match is never inherited — otherwise every repository would match every project file", () => {
    const merged = mergeConfigLayer({ id: "_default", match: { remotes: ["*"] } }, { id: "P", match: { remotes: ["*/P"] } });
    deepEq(merged.match.remotes, ["*/P"]);
  });

  test("stacks is never inherited, because it outranks a project's own stack in the resolver", () => {
    const merged = mergeConfigLayer({ stacks: [{ paths: ["**.cs"], stack: "backend" }] }, { id: "P", stack: "frontend" });
    eq(merged.stacks, undefined);
    eq(merged.stack, "frontend");
  });

  test("a project with no stack of its own still does not inherit stack detection", () => {
    const merged = mergeConfigLayer({ stacks: [{ paths: ["**.cs"], stack: "backend" }] }, { id: "P" });
    eq(merged.stacks, undefined);
  });

  test("branchNaming is replaced wholesale, not merged field by field — it is one pattern, not a set", () => {
    const merged = mergeConfigLayer(
      { branchNaming: { pattern: "^base$", action: "deny", preferred: "base" } },
      { id: "P", branchNaming: { pattern: "^own$" } },
    );
    deepEq(merged.branchNaming, { pattern: "^own$" });
  });

  test("limits are replaced wholesale, so a stack preset's threshold is not unioned with the default's", () => {
    const merged = mergeConfigLayer({ limits: { fileLines: { ask: 500 } } }, { id: "P", limits: { fileLines: { ask: 1500 } } });
    deepEq(merged.limits, { fileLines: { ask: 1500 } });
  });

  /* -------------------------------------------------------------- safety */

  test("a malformed base layer contributes nothing rather than taking the project away", () => {
    deepEq(mergeConfigLayer(null, { id: "P", baseBranches: ["dev"] }), { id: "P", baseBranches: ["dev"] });
    deepEq(mergeConfigLayer("nonsense", { id: "P" }), { id: "P" });
  });

  test("a missing top layer degrades to the base rather than to nothing", () => {
    deepEq(mergeConfigLayer({ id: "_default", baseBranches: ["dev"] }, null), { id: "_default", baseBranches: ["dev"] });
    deepEq(mergeConfigLayer(null, null), {});
  });

  test("a non-array on either side of an additive key is left to the project rather than unioned", () => {
    eq(mergeConfigLayer({ protectedPaths: [{ path: "a" }] }, { id: "P", protectedPaths: "nonsense" }).protectedPaths, "nonsense");
    deepEq(mergeConfigLayer({ protectedPaths: "nonsense" }, { id: "P", protectedPaths: [{ path: "a" }] }).protectedPaths, [{ path: "a" }]);
  });

  test("a non-object entry inside an additive list is carried through untouched", () => {
    const merged = mergeConfigLayer({ protectedPaths: [{ path: "**/.env" }] }, { id: "P", protectedPaths: [null, "junk"] });
    deepEq(merged.protectedPaths, [null, "junk", { path: "**/.env" }]);
  });

  /* ------------------------------------------------------ the real files */

  test("every shipped project inherits the default credential protections", () => {
    const defaults = loadDefaultProject({ projectsDir: PROJECTS_DIR });
    const inherited = defaults.protectedPaths.map((entry) => entry.path);

    for (const file of ["Softela.PestManagement", "Softela.Bugworx", "Softela.AiInfrastructure"]) {
      const merged = mergeConfigLayer(defaults, readJson(path.join(PROJECTS_DIR, `${file}.json`)));
      for (const target of inherited) {
        eq(paths(merged).includes(target), true, `${file} lost the inherited protection for ${target}`);
      }
    }
  });

  test("no shipped project config protects src/pages/Home.tsx — the rule that reached every session by mistake", () => {
    const defaults = loadDefaultProject({ projectsDir: PROJECTS_DIR });
    for (const file of ["Softela.PestManagement", "Softela.Bugworx", "Softela.AiInfrastructure"]) {
      const merged = mergeConfigLayer(defaults, readJson(path.join(PROJECTS_DIR, `${file}.json`)));
      eq(paths(merged).includes("src/pages/Home.tsx"), false, `${file} still carries it`);
    }
  });
});
