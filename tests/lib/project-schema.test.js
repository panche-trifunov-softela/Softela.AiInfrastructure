"use strict";

/**
 * `core/schema/project.schema.json` — the shape a committed
 * `projects/<Repo>.json` file must satisfy.
 *
 * Reuses `validateAgainst` from `core/installer/doctor.js` (the same
 * function `softela-ai doctor` and CI run every shipped project file through)
 * rather than reimplementing schema validation here, so this suite proves
 * the same thing `doctor` actually checks.
 */

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");
const { readJson } = require("../../core/lib/fs-safe");
const { validateAgainst } = require("../../core/installer/doctor");

const REPO_ROOT = path.join(__dirname, "..", "..");
const PROJECTS_DIR = path.join(REPO_ROOT, "projects");
const SCHEMA = readJson(path.join(REPO_ROOT, "core", "schema", "project.schema.json"));

/**
 * Every committed project file, read from disk rather than restated here.
 *
 * `_presets/` is a directory, not a `.json` file, so the extension filter
 * excludes the stack presets — which answer to a different shape and are
 * covered by their own cases further down.
 */
const SHIPPED_PROJECT_FILES = fs
  .readdirSync(PROJECTS_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort();

/**
 * Builds a minimal valid project object, so a case only has to override the
 * one field it is testing.
 *
 * @param {object} [extra] Fields merged over the minimal base.
 * @returns {object} A project object.
 */
function project(extra = {}) {
  return { id: "TestProject", ...extra };
}

suite("schema/project.schema.json", ({ test, eq }) => {
  test("the schema file itself parses as JSON", () => {
    eq(SCHEMA && typeof SCHEMA === "object", true);
  });

  /* -------------------------------------------------------- shipped files */

  // Enumerated from the directory rather than listed by hand: a hand-written
  // list means a project file added later is never validated by anything, and
  // the omission looks exactly like a passing suite.
  test("the shipped project files were actually found, so the loop below is not empty", () => {
    eq(SHIPPED_PROJECT_FILES.includes("_default.json"), true, `found: ${SHIPPED_PROJECT_FILES.join(", ")}`);
    eq(SHIPPED_PROJECT_FILES.length >= 4, true, `found only: ${SHIPPED_PROJECT_FILES.join(", ")}`);
  });

  for (const file of SHIPPED_PROJECT_FILES) {
    test(`projects/${file} validates cleanly against the shipped schema`, () => {
      const data = readJson(path.join(PROJECTS_DIR, file));
      const errors = validateAgainst(SCHEMA, data, file);
      eq(errors.length, 0, `unexpected schema errors: ${JSON.stringify(errors)}`);
    });
  }

  test("the backend project declares no file-size limit at all", () => {
    const data = readJson(path.join(REPO_ROOT, "projects", "Softela.PestManagement.json"));
    eq(data.limits === undefined, true, "the team has not agreed a backend threshold yet");
  });

  /* -------------------------------------------------------------- commitMessage */

  test("commitMessage.conventionalPrefix accepts a recognised action", () => {
    const errors = validateAgainst(SCHEMA, project({ commitMessage: { conventionalPrefix: "ask" } }), "x");
    eq(errors.length, 0, JSON.stringify(errors));
  });

  test("commitMessage.conventionalPrefix rejects an unrecognised action", () => {
    const errors = validateAgainst(SCHEMA, project({ commitMessage: { conventionalPrefix: "sometimes" } }), "x");
    eq(errors.length > 0, true);
  });

  test("commitMessage rejects an unknown sibling key", () => {
    const errors = validateAgainst(SCHEMA, project({ commitMessage: { conventionalPrefix: "off", ticketPrefix: "ask" } }), "x");
    eq(errors.length > 0, true);
  });

  /* -------------------------------------------------------------- patchManifest */

  test("patchManifest accepts its three configured strings", () => {
    const errors = validateAgainst(
      SCHEMA,
      project({ patchManifest: { filePattern: "patch\\.xml$", databasePattern: "<Database", requiredEntry: "UpgradeScript" } }),
      "x",
    );
    eq(errors.length, 0, JSON.stringify(errors));
  });

  test("patchManifest rejects an unknown key", () => {
    const errors = validateAgainst(SCHEMA, project({ patchManifest: { filePattern: "x", extra: true } }), "x");
    eq(errors.length > 0, true);
  });

  /* -------------------------------------------------------------- reuseBeforeNew */

  test("reuseBeforeNew.maxScanFiles accepts a positive integer", () => {
    const errors = validateAgainst(SCHEMA, project({ reuseBeforeNew: { maxScanFiles: 6000 } }), "x");
    eq(errors.length, 0, JSON.stringify(errors));
  });

  test("reuseBeforeNew.maxScanFiles rejects a non-integer", () => {
    const errors = validateAgainst(SCHEMA, project({ reuseBeforeNew: { maxScanFiles: 1.5 } }), "x");
    eq(errors.length > 0, true);
  });

  test("reuseBeforeNew.maxScanFiles rejects zero", () => {
    const errors = validateAgainst(SCHEMA, project({ reuseBeforeNew: { maxScanFiles: 0 } }), "x");
    eq(errors.length > 0, true);
  });

  test("reuseBeforeNew rejects an unknown sibling key", () => {
    const errors = validateAgainst(SCHEMA, project({ reuseBeforeNew: { maxScanFiles: 100, extra: true } }), "x");
    eq(errors.length > 0, true);
  });

  /* -------------------------------------------------------------- conventions.pathAliases */

  test("conventions.pathAliases accepts a map of string to string", () => {
    const errors = validateAgainst(SCHEMA, project({ conventions: { pathAliases: { "@": "src" } } }), "x");
    eq(errors.length, 0, JSON.stringify(errors));
  });

  /* -------------------------------------------------------------- rules: {groups, byId} */

  test("rules.groups accepts the bare action-string shorthand", () => {
    const errors = validateAgainst(SCHEMA, project({ rules: { groups: { code: "off" } } }), "x");
    eq(errors.length, 0, JSON.stringify(errors));
  });

  test("rules.byId accepts the {action, reason} object shape", () => {
    const errors = validateAgainst(
      SCHEMA,
      project({ rules: { byId: { "branch-naming": { action: "off", reason: "no shared convention yet" } } } }),
      "x",
    );
    eq(errors.length, 0, JSON.stringify(errors));
  });

  test("rules.groups rejects a group name outside git/code/agent", () => {
    const errors = validateAgainst(SCHEMA, project({ rules: { groups: { frontend: "off" } } }), "x");
    eq(errors.length > 0, true);
  });

  test("rules rejects the old dead per-rule-id shape at its own top level", () => {
    // The shape §8 replaced: a bare rule id directly under "rules", with
    // neither "groups" nor "byId" wrapping it.
    const errors = validateAgainst(SCHEMA, project({ rules: { "file-size-limit": { action: "off" } } }), "x");
    eq(errors.length > 0, true);
  });

  test("rules.byId accepts the bare action-string shorthand for a real rule id, without crashing", () => {
    const errors = validateAgainst(SCHEMA, project({ rules: { byId: { "branch-naming": "off" } } }), "x");
    eq(errors.length, 0, JSON.stringify(errors));
  });

  test("rules.byId rejects a key that is not a registered rule id, naming the path", () => {
    // A typo'd rule id here is not a shape problem the {action, reason}
    // oneOf branch can catch — it is a silent no-op forever (the intended
    // switch never reaches the real rule), which is exactly what
    // propertyNames + the registry-derived enum below must now catch.
    const errors = validateAgainst(SCHEMA, project({ rules: { byId: { "some-rule": "off" } } }), "x");
    eq(errors.length > 0, true, "an unregistered rule id must be rejected, not silently accepted");
    eq(errors.some((e) => e.includes("x.rules.byId.some-rule")), true, JSON.stringify(errors));
  });

  /* ------------------------------------------------------------- stack(s) */

  test("stack accepts frontend", () => {
    const errors = validateAgainst(SCHEMA, project({ stack: "frontend" }), "x");
    eq(errors.length, 0, JSON.stringify(errors));
  });

  test("stack accepts backend", () => {
    const errors = validateAgainst(SCHEMA, project({ stack: "backend" }), "x");
    eq(errors.length, 0, JSON.stringify(errors));
  });

  test("stack rejects a value outside frontend/backend", () => {
    const errors = validateAgainst(SCHEMA, project({ stack: "mobile" }), "x");
    eq(errors.length > 0, true);
  });

  test("stacks accepts an ordered list of {paths, stack}", () => {
    const errors = validateAgainst(
      SCHEMA,
      project({
        stacks: [
          { paths: ["src/Web/ClientApp/**"], stack: "frontend" },
          { paths: ["src/**"], stack: "backend" },
        ],
      }),
      "x",
    );
    eq(errors.length, 0, JSON.stringify(errors));
  });

  test("stacks rejects an entry missing paths", () => {
    const errors = validateAgainst(SCHEMA, project({ stacks: [{ stack: "backend" }] }), "x");
    eq(errors.length > 0, true);
  });

  test("stacks rejects an entry missing stack", () => {
    const errors = validateAgainst(SCHEMA, project({ stacks: [{ paths: ["src/**"] }] }), "x");
    eq(errors.length > 0, true);
  });

  test("stacks rejects an entry naming an unrecognised stack", () => {
    const errors = validateAgainst(SCHEMA, project({ stacks: [{ paths: ["src/**"], stack: "mobile" }] }), "x");
    eq(errors.length > 0, true);
  });

  test("a project may declare stack and stacks together — precedence is the engine's concern, not the schema's", () => {
    const errors = validateAgainst(
      SCHEMA,
      project({ stack: "frontend", stacks: [{ paths: ["src/Server/**"], stack: "backend" }] }),
      "x",
    );
    eq(errors.length, 0, JSON.stringify(errors));
  });

  /* --------------------------------------------------------------- presets */

  for (const stack of ["frontend", "backend"]) {
    test(`projects/_presets/${stack}.json parses as JSON`, () => {
      const data = readJson(path.join(REPO_ROOT, "projects", "_presets", `${stack}.json`));
      eq(data && typeof data === "object", true);
    });
  }
});
