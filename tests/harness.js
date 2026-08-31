"use strict";

/**
 * Zero-dependency test harness.
 *
 * A test file calls `suite(name, fn)` at require time; `fn` runs
 * synchronously and receives helpers bound to that suite, including
 * disposable directories that are removed once the suite finishes. Results
 * accumulate on the shared `results` array for `tests/run.js` to print and
 * summarise.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Accumulated result entries, in run order — either `{suite, label, pass,
 * message?}` from `test()`, or `{suite, label, skipped: true, reason}` from
 * `skip()`. `tests/run.js` tells the two apart on the `skipped` key.
 */
const results = [];

/**
 * Renders a value for an assertion failure message.
 *
 * @param {*} value The value to render.
 * @returns {string} A JSON rendering, or `String(value)` when it is not
 * JSON-serialisable.
 */
function describe(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Compares two values structurally.
 *
 * @param {*} a The first value.
 * @param {*} b The second value.
 * @returns {boolean} `true` when `a` and `b` are structurally equal —
 * arrays element-by-element, regexes by source and flags, plain objects
 * key-by-key, everything else by `Object.is`.
 */
function deepEqualValues(a, b) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqualValues(v, b[i]));
  }
  if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags;
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length) return false;
    return ak.every((k, i) => k === bk[i] && deepEqualValues(a[k], b[k]));
  }
  return false;
}

/**
 * Asserts strict equality.
 *
 * @param {*} actual The value produced by the code under test.
 * @param {*} expected The expected value.
 * @param {string} [message] A label prefixed to the failure message.
 * @returns {void}
 */
function eq(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message ? `${message}: ` : ""}expected ${describe(expected)}, got ${describe(actual)}`);
  }
}

/**
 * Asserts structural equality.
 *
 * @param {*} actual The value produced by the code under test.
 * @param {*} expected The expected value.
 * @param {string} [message] A label prefixed to the failure message.
 * @returns {void}
 */
function deepEq(actual, expected, message) {
  if (!deepEqualValues(actual, expected)) {
    throw new Error(`${message ? `${message}: ` : ""}expected ${describe(expected)}, got ${describe(actual)}`);
  }
}

/**
 * Asserts a truthy value.
 *
 * @param {*} value The value to check.
 * @param {string} [message] The failure message when `value` is falsy.
 * @returns {void}
 */
function ok(value, message) {
  if (!value) throw new Error(message || `expected a truthy value, got ${describe(value)}`);
}

/**
 * Asserts that a function throws.
 *
 * @param {Function} fn The function to call.
 * @param {string} [message] The failure message when `fn` does not throw.
 * @returns {void}
 */
function throwsFn(fn, message) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(message || "expected the function to throw");
}

/**
 * Asserts that a function does not throw.
 *
 * @param {Function} fn The function to call.
 * @param {string} [message] A label prefixed to the failure message.
 * @returns {void}
 */
function notThrowsFn(fn, message) {
  try {
    fn();
  } catch (error) {
    throw new Error(`${message ? `${message}: ` : ""}expected not to throw, got: ${error && error.message}`);
  }
}

/**
 * Removes a directory tree, never throwing.
 *
 * @param {string} dir The directory to remove.
 * @returns {void}
 */
function removeRecursive(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

/**
 * Runs a suite of tests.
 *
 * `fn` is called once, synchronously, with a context whose `test(label, fn)`
 * runs one case and records its outcome without letting a thrown assertion
 * abort the rest of the suite. Every directory handed out by `tmpdir()` or
 * `fakeHome()`, and every `SOFTELA_AI_HOME` override `fakeHome()` makes, is
 * undone when `fn` returns — including when `fn` itself throws, which is
 * recorded as a single failing case rather than propagated to the caller.
 *
 * @param {string} name The suite's name, used to label its test results.
 * @param {(ctx: {
 *   test: (label: string, fn: () => void) => void,
 *   skip: (label: string, reason: string) => void,
 *   eq: typeof eq,
 *   deepEq: typeof deepEq,
 *   ok: typeof ok,
 *   throws: typeof throwsFn,
 *   notThrows: typeof notThrowsFn,
 *   tmpdir: () => string,
 *   fakeHome: () => string,
 *   fixture: (relPath: string, content: string | object) => string
 * }) => void} fn The suite body.
 * @returns {void}
 */
function suite(name, fn) {
  const dirsToClean = [];
  const envRestores = [];
  let fixturesRoot = null;

  const context = {
    test(label, testFn) {
      try {
        testFn();
        results.push({ suite: name, label, pass: true });
      } catch (error) {
        results.push({
          suite: name,
          label,
          pass: false,
          message: error && error.message ? error.message : String(error),
        });
      }
    },
    skip(label, reason) {
      results.push({ suite: name, label, skipped: true, reason });
    },
    eq,
    deepEq,
    ok,
    throws: throwsFn,
    notThrows: notThrowsFn,
    tmpdir() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "softela-ai-test-"));
      dirsToClean.push(dir);
      return dir;
    },
    fakeHome() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "softela-ai-home-"));
      dirsToClean.push(dir);
      const previous = process.env.SOFTELA_AI_HOME;
      process.env.SOFTELA_AI_HOME = dir;
      envRestores.push(() => {
        if (previous === undefined) delete process.env.SOFTELA_AI_HOME;
        else process.env.SOFTELA_AI_HOME = previous;
      });
      return dir;
    },
    fixture(relPath, content) {
      if (!fixturesRoot) {
        fixturesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "softela-ai-fixtures-"));
        dirsToClean.push(fixturesRoot);
      }
      const abs = path.join(fixturesRoot, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const text = typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`;
      fs.writeFileSync(abs, text, "utf8");
      return abs;
    },
  };

  try {
    fn(context);
  } catch (error) {
    results.push({
      suite: name,
      label: "(suite body)",
      pass: false,
      message: error && error.message ? error.message : String(error),
    });
  } finally {
    for (const restore of envRestores) restore();
    for (const dir of dirsToClean) removeRecursive(dir);
  }
}

module.exports = { suite, results };
