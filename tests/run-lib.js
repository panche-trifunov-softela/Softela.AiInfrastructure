"use strict";

/**
 * Helpers shared between `tests/run.js` (the parent process) and
 * `tests/run-worker.js` (a forked child), so both agree on exactly how a
 * test file's absolute path becomes the repository-relative, POSIX-separated
 * name used for filtering, printing, and JUnit `classname`s — and on the
 * `(require)` failure shape a file that throws while loading gets recorded
 * as, whichever process happened to run it.
 */

const path = require("path");

/**
 * This repository's `tests/` directory. Both `run.js` and `run-worker.js`
 * live directly inside it, so `__dirname` from either file resolves to the
 * same place this constant does.
 */
const ROOT = __dirname;

/**
 * Repository-relative, POSIX-separated path of a test file.
 *
 * @param {string} file Absolute path to a test file.
 * @returns {string} The relative path with forward slashes.
 */
function relPath(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

/**
 * Builds the synthetic failing result recorded when a test file throws
 * while being `require()`d, before it ever gets to register a `suite()`.
 *
 * @param {string} rel The file's repository-relative path, from
 * {@link relPath} — used as the result's `suite`, since no real suite name
 * was ever registered.
 * @param {*} error Whatever `require()` threw.
 * @returns {{suite: string, label: string, pass: false, message: string}}
 * A result shaped exactly like one `harness.js#suite`'s `test()` would push.
 */
function requireFailureResult(rel, error) {
  return {
    suite: rel,
    label: "(require)",
    pass: false,
    message: error && error.message ? error.message : String(error),
  };
}

module.exports = { ROOT, relPath, requireFailureResult };
