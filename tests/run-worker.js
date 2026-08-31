"use strict";

/**
 * Worker process for the parallel test runner.
 *
 * `tests/run.js` forks one of these per pool slot whenever it is asked to
 * run with more than one worker. A worker does nothing on its own — it sits
 * on its parent's IPC channel and, for each `"run"` message, `require()`s
 * exactly one test file, the same way `tests/run.js` itself does when run
 * with `--workers 1`:
 *
 * - `suite()` (from `tests/harness.js`) runs synchronously at require time
 *   and pushes onto the shared, per-process `harness.results` array, so the
 *   slice of it produced by one file is `harness.results` before minus after.
 * - A file that throws while loading (before any suite even registers) is
 *   recorded as a single failing `"(require)"` result, exactly as the
 *   serial runner records it.
 *
 * The file's elapsed time and its slice of results are sent back to the
 * parent as one message, never printed here — printing happens in the
 * parent once a file is fully done, so two workers finishing at once can
 * never interleave their lines.
 */

const harness = require("./harness");
const { relPath, requireFailureResult } = require("./run-lib");

process.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "shutdown") {
    process.exit(0);
    return;
  }

  if (msg.type === "run" && typeof msg.file === "string") {
    const rel = relPath(msg.file);
    const resultsBefore = harness.results.length;
    const startedAt = Date.now();
    try {
      require(msg.file);
    } catch (error) {
      harness.results.push(requireFailureResult(rel, error));
    }
    const elapsedMs = Date.now() - startedAt;
    const results = harness.results.slice(resultsBefore);
    process.send({ type: "file-done", file: msg.file, elapsedMs, results });
  }
});
