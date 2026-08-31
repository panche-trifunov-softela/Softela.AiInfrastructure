"use strict";

/**
 * Per-file isolation of the rule registry loader (`core/guards/index.js`)
 * against a directory that mixes healthy rule modules with modules that
 * cannot be loaded or validated.
 *
 * Drives the loader's own real source — copied into a scratch directory so
 * its `__dirname` resolves there — rather than a reimplementation of its
 * logic, so this suite fails the moment the loader's actual per-file
 * isolation regresses, not merely when some test-local stand-in of it does.
 */

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");

/** The real loader's source, read once and reused for every scratch directory built below. */
const LOADER_SOURCE = fs.readFileSync(path.join(__dirname, "../../core/guards/index.js"), "utf8");

/**
 * Minimal rule module source that satisfies every field
 * `core/guards/index.js#validate` checks.
 *
 * @param {string} id The rule id — must equal the filename it is written to.
 * @returns {string} A complete `module.exports = {...}` source file.
 */
function goodRuleSource(id) {
  return `"use strict";
module.exports = {
  id: ${JSON.stringify(id)},
  title: "Scratch rule ${id}",
  events: ["PreToolUse"],
  defaultAction: "ask",
  group: "code",
  evaluate() { return null; },
};
`;
}

/**
 * Populates a scratch guards directory: a copy of the real loader source,
 * `goodCount` good rule modules, and whatever broken files a test wants
 * alongside them — so the loader is exercised against a mix, exactly the
 * scenario a half-written file produces in the real directory.
 *
 * @param {string} dir An empty directory to populate.
 * @param {number} goodCount How many good rule modules to write.
 * @param {Record<string, string>} brokenFiles Filename to raw source, for
 * modules meant to fail loading or validation.
 * @returns {string[]} The good rule ids written, in file order.
 */
function buildScratchRegistry(dir, goodCount, brokenFiles) {
  fs.writeFileSync(path.join(dir, "index.js"), LOADER_SOURCE, "utf8");
  const goodIds = [];
  for (let i = 0; i < goodCount; i++) {
    const id = `good-rule-${i}`;
    fs.writeFileSync(path.join(dir, `${id}.js`), goodRuleSource(id), "utf8");
    goodIds.push(id);
  }
  for (const [file, source] of Object.entries(brokenFiles)) {
    fs.writeFileSync(path.join(dir, file), source, "utf8");
  }
  return goodIds;
}

suite("guards/index registry robustness against broken rule files", ({ test, tmpdir, eq, deepEq, ok }) => {
  test("a module that throws while merely being shape-validated is skipped, not fatal to the whole catalogue", () => {
    // The actual gap this suite exists to catch: `require()` on this file
    // succeeds (no syntax error), but reading `mod.id` during `validate()`
    // throws — exactly the class of failure that used to escape the
    // per-file `try` entirely and empty the whole registry.
    const dir = tmpdir();
    const goodIds = buildScratchRegistry(dir, 2, {
      "broken-getter.js": `"use strict";
module.exports = {
  get id() { throw new Error("boom during id access"); },
  title: "Broken",
  events: ["PreToolUse"],
  defaultAction: "ask",
  group: "code",
  evaluate() { return null; },
};
`,
    });

    const registry = require(path.join(dir, "index.js"));

    for (const id of goodIds) ok(registry.byId[id], `expected good rule "${id}" to load`);
    eq(registry.rules.length, goodIds.length, "the broken module must not suppress the good ones");
    ok(registry.rules.length > 0, "the catalogue must not be empty");
    ok(
      registry.loadErrors.some((e) => e.file === "broken-getter.js"),
      `expected loadErrors to name "broken-getter.js": ${JSON.stringify(registry.loadErrors)}`,
    );
  });

  test("a module with a syntax error is skipped, not fatal to the whole catalogue", () => {
    const dir = tmpdir();
    const goodIds = buildScratchRegistry(dir, 2, {
      // Unterminated object literal — a SyntaxError at require() time, the
      // shape a half-written file left mid-save is most likely to take.
      "broken-syntax.js": "module.exports = {\n",
    });

    const registry = require(path.join(dir, "index.js"));

    for (const id of goodIds) ok(registry.byId[id], `expected good rule "${id}" to load`);
    eq(registry.rules.length, goodIds.length);
    ok(registry.rules.length > 0, "the catalogue must not be empty");
    ok(
      registry.loadErrors.some((e) => e.file === "broken-syntax.js"),
      `expected loadErrors to name "broken-syntax.js": ${JSON.stringify(registry.loadErrors)}`,
    );
  });

  test("several different kinds of broken file alongside good ones: every good rule still loads and every broken file is named individually", () => {
    const dir = tmpdir();
    const goodIds = buildScratchRegistry(dir, 3, {
      "broken-getter.js": `"use strict";
module.exports = { get id() { throw new Error("boom"); }, title: "x", events: ["PreToolUse"], defaultAction: "ask", group: "code", evaluate() {} };
`,
      "broken-syntax.js": "this is not valid javascript {{{",
      "broken-shape.js": `"use strict";
module.exports = { id: "broken-shape", title: "x" };
`,
    });

    const registry = require(path.join(dir, "index.js"));

    for (const id of goodIds) ok(registry.byId[id], `expected good rule "${id}" to load`);
    eq(registry.rules.length, goodIds.length, "every broken file combined must still leave every good rule loaded");
    ok(registry.rules.length > 0, "the catalogue must not be empty");
    deepEq(
      registry.loadErrors.map((e) => e.file).sort(),
      ["broken-getter.js", "broken-shape.js", "broken-syntax.js"],
      `expected each broken file named individually in loadErrors: ${JSON.stringify(registry.loadErrors)}`,
    );
  });
});
