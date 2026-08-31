#!/usr/bin/env node
"use strict";

/**
 * Test discovery and reporting.
 *
 * Discovers every `tests/**\/*.test.js` file, then runs each one — a run
 * `require()`s the file, and `suite()` (from `tests/harness.js`) executes
 * synchronously at require time. By default the files are distributed
 * across a pool of forked worker processes (see `tests/run-worker.js`),
 * each running one file at a time; `--workers 1` instead runs every file
 * serially in this process, exactly as this script always used to.
 *
 * Results stream to the console as each file finishes rather than being
 * buffered until the whole run is done:
 *
 * - A one-line progress marker per file, naming it and giving its elapsed
 *   time, so a slow file is visible immediately instead of reading as a
 *   hang. In serial mode the name prints before the file runs, since there
 *   is only ever one file in flight; in parallel mode several files are in
 *   flight at once, so a file's marker (and everything under it) is only
 *   printed once that file is fully done — never interleaved with another
 *   file's lines.
 * - That file's own `ok` / `FAIL` / `skip` case lines, in the same format
 *   as always, printed right after its marker line.
 *
 * A final summary line prints once every file has been processed. Exits 1
 * when anything failed.
 *
 * Any positional argument is treated as a substring filter against the
 * repository-relative path of each test file, so `node tests/run.js
 * guards/commit-message` runs one rule's suite. Without filters everything
 * runs. The filter exists because several people work on different rules at
 * once, and a run that also reports someone else's half-written suite
 * teaches you nothing about your own.
 *
 * Flags recognised alongside the filters:
 *
 * - `--strict-skips` turns every skipped case (`tests/probes/` when the
 *   corresponding host CLI is not on `PATH`) into a failure. Never used in
 *   CI, where a hosted agent legitimately has neither `claude` nor `codex`
 *   installed — it is for a developer who wants proof the probes actually
 *   ran against the real binaries, not that they were silently skipped.
 * - `--junit <path>` (or `--junit=<path>`) writes a JUnit-XML report to
 *   `path`, for a CI host that renders test results from that format.
 * - `--workers <n>` (or `--workers=<n>`) sets the worker pool size,
 *   overriding `SOFTELA_AI_TEST_WORKERS`, which itself overrides the default —
 *   `os.cpus().length`. `--workers 1` runs everything serially in this
 *   process, with no forked children at all.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { fork } = require("child_process");

const harness = require("./harness");
const { ROOT, relPath, requireFailureResult } = require("./run-lib");

/**
 * Recursively collects every `*.test.js` file under a directory.
 *
 * @param {string} dir The directory to walk.
 * @returns {string[]} Absolute paths to matching files.
 */
function collectTestFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  let files = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(collectTestFiles(abs));
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      files.push(abs);
    }
  }
  return files;
}

/**
 * Parses `process.argv` into path filters and this script's own flags.
 *
 * Any argument starting with `-` that is not a recognised flag is ignored
 * rather than treated as a filter or rejected, so an unrecognised future
 * flag fails soft instead of being matched against file paths.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {{filters: string[], strictSkips: boolean, junitPath: string | null,
 * workersArg: string | null}} The positional path filters, whether
 * `--strict-skips` was passed, the `--junit` output path (or `null`), and
 * the raw `--workers` value (or `null`) — left unparsed here since
 * resolving it also needs `SOFTELA_AI_TEST_WORKERS` and the CPU count.
 */
function parseArgs(argv) {
  const filters = [];
  let strictSkips = false;
  let junitPath = null;
  let workersArg = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--strict-skips") {
      strictSkips = true;
    } else if (arg === "--junit") {
      junitPath = argv[i + 1] || null;
      i += 1;
    } else if (arg.startsWith("--junit=")) {
      junitPath = arg.slice("--junit=".length);
    } else if (arg === "--workers") {
      workersArg = argv[i + 1] || null;
      i += 1;
    } else if (arg.startsWith("--workers=")) {
      workersArg = arg.slice("--workers=".length);
    } else if (!arg.startsWith("-")) {
      filters.push(arg);
    }
  }

  return { filters, strictSkips, junitPath, workersArg };
}

/**
 * Resolves how many worker processes to run test files across.
 *
 * Precedence: `--workers` (`cliValue`) beats `SOFTELA_AI_TEST_WORKERS`
 * (`envValue`) beats a default derived from the machine's CPU count. A
 * value that fails to parse as a positive integer — including `--workers 0`
 * or a non-numeric value — falls through to the next source rather than
 * erroring, the same fail-soft spirit as an unrecognised flag.
 *
 * @param {string | null} cliValue The raw `--workers` argument.
 * @param {string | undefined} envValue `process.env.SOFTELA_AI_TEST_WORKERS`.
 * @param {number} cpuCount `os.cpus().length`.
 * @returns {number} The resolved worker count, at least 1.
 */
function resolveWorkerCount(cliValue, envValue, cpuCount) {
  for (const raw of [cliValue, envValue]) {
    if (raw === null || raw === undefined || raw === "") continue;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return Math.max(1, cpuCount || 1);
}

/**
 * Escapes the characters XML forbids in text content and attribute values.
 *
 * @param {*} value The value to render — coerced to a string first, since
 * every caller passes a name, message or reason.
 * @returns {string} The escaped text, safe to place inside an attribute or
 * element body.
 */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Builds a JUnit-XML report from the harness's accumulated results, grouped
 * into one `<testsuite>` per suite name so a CI viewer can navigate by rule
 * or module the same way the console output already reads.
 *
 * Skips are rendered as `<skipped>` (never `<failure>`) unless
 * `strictSkips` already turned them into failing results before this runs —
 * this function only renders what it is given, it never reinterprets a
 * result's own `pass`/`skipped` flags.
 *
 * @param {Array<{suite: string, label: string, pass?: boolean,
 * skipped?: boolean, message?: string, reason?: string}>} results The
 * harness's result list.
 * @returns {string} A complete JUnit-XML document, ending in `\n`.
 */
function buildJunitXml(results) {
  const bySuite = new Map();
  for (const r of results) {
    if (!bySuite.has(r.suite)) bySuite.set(r.suite, []);
    bySuite.get(r.suite).push(r);
  }

  const totals = { tests: results.length, failures: 0, skipped: 0 };
  const suiteBlocks = [];

  for (const [suiteName, cases] of bySuite) {
    let failures = 0;
    let skipped = 0;
    const caseBlocks = cases.map((r) => {
      const nameAttr = escapeXml(r.label);
      const classAttr = escapeXml(suiteName);
      if (r.skipped) {
        skipped += 1;
        return (
          `    <testcase classname="${classAttr}" name="${nameAttr}">\n` +
          `      <skipped message="${escapeXml(r.reason || "")}"/>\n` +
          `    </testcase>`
        );
      }
      if (!r.pass) {
        failures += 1;
        return (
          `    <testcase classname="${classAttr}" name="${nameAttr}">\n` +
          `      <failure message="${escapeXml(r.message || "")}">${escapeXml(r.message || "")}</failure>\n` +
          `    </testcase>`
        );
      }
      return `    <testcase classname="${classAttr}" name="${nameAttr}"/>`;
    });

    totals.failures += failures;
    totals.skipped += skipped;
    suiteBlocks.push(
      `  <testsuite name="${escapeXml(suiteName)}" tests="${cases.length}" failures="${failures}" skipped="${skipped}">\n` +
        `${caseBlocks.join("\n")}\n` +
        `  </testsuite>`,
    );
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites tests="${totals.tests}" failures="${totals.failures}" skipped="${totals.skipped}">\n` +
    `${suiteBlocks.join("\n")}\n` +
    `</testsuites>\n`
  );
}

const { filters, strictSkips, junitPath, workersArg } = parseArgs(process.argv.slice(2));
const files = collectTestFiles(ROOT)
  .sort()
  .filter((f) => filters.length === 0 || filters.some((needle) => relPath(f).includes(needle)));

console.log(
  `discovered ${files.length} test file${files.length === 1 ? "" : "s"}` +
    (filters.length > 0 ? ` (filters: ${filters.join(", ")})` : ""),
);

if (filters.length > 0 && files.length === 0) {
  console.log(`no test files matched: ${filters.join(", ")}`);
  process.exit(1);
}

const workerCount = Math.max(1, Math.min(resolveWorkerCount(workersArg, process.env.SOFTELA_AI_TEST_WORKERS, os.cpus().length), files.length || 1));
console.log(workerCount > 1 ? `running with ${workerCount} workers` : "running serially (1 worker)");

// `--strict-skips` is applied per result, below, as each file's results
// arrive, so the console output and the JUnit report (built from
// `effectiveResults`) never disagree about which results are failures.
const effectiveResults = [];
let pass = 0;
let fail = 0;
const skippedCases = [];

/**
 * Folds one file's raw harness results into the running totals — applying
 * `--strict-skips` — and renders its `ok` / `FAIL` / `skip` lines. Shared by
 * both the serial and the parallel path, so a file's block reads identically
 * regardless of which process actually ran it.
 *
 * @param {Array<{suite: string, label: string, pass?: boolean, skipped?: boolean,
 * message?: string, reason?: string}>} rawResults The file's results, before
 * `--strict-skips` is applied.
 * @returns {string[]} One rendered line per result, in order.
 */
function recordFileResults(rawResults) {
  const fileResults = rawResults.map((r) => {
    if (r.skipped && strictSkips) {
      return { suite: r.suite, label: r.label, pass: false, message: `[SKIPPED] ${r.reason}` };
    }
    return r;
  });
  effectiveResults.push(...fileResults);

  return fileResults.map((r) => {
    const label = `${r.suite} :: ${r.label}`;
    if (r.skipped) {
      skippedCases.push({ label, reason: r.reason });
      return `skip ${label} -> ${r.reason}`;
    }
    if (r.pass) {
      pass += 1;
      return `ok   ${label}`;
    }
    fail += 1;
    return `FAIL ${label} -> ${r.message}`;
  });
}

/**
 * Runs every file across a pool of forked `tests/run-worker.js` processes,
 * printing each file's result block — its `-- <rel> (<ms>ms)` marker
 * followed by its case lines — the moment that file is fully done. A worker
 * handles one file at a time and reports it back as a single IPC message, so
 * two workers finishing at once can never interleave their lines: each
 * block is only ever assembled and printed once, from one message.
 *
 * A worker that dies while a file is in flight has that file recorded as a
 * single failing result, and — as long as the queue is not already empty —
 * a replacement worker is forked to keep draining it.
 *
 * @param {string[]} filesToRun Absolute paths to run.
 * @param {number} poolSize How many workers to keep alive at once; already
 * clamped to `filesToRun.length` by the caller.
 * @returns {Promise<void>} Resolves once every file has been accounted for,
 * rejects only if a worker itself fails to start.
 */
function runParallel(filesToRun, poolSize) {
  return new Promise((resolve, reject) => {
    const queue = filesToRun.slice();
    let remaining = queue.length;
    let settled = false;

    if (remaining === 0) {
      resolve();
      return;
    }

    const workerScript = path.join(ROOT, "run-worker.js");

    /** @returns {void} */
    function settleResolve() {
      if (settled) return;
      settled = true;
      resolve();
    }

    /** @param {Error} error @returns {void} */
    function settleReject(error) {
      if (settled) return;
      settled = true;
      reject(error);
    }

    /**
     * Reports one file's outcome — its result lines under its marker — and
     * folds it into the shared totals.
     *
     * @param {string} rel The file's repository-relative path.
     * @param {string} timingLabel What to print inside the marker's
     * parentheses, e.g. `"123ms"` or `"worker exited"`.
     * @param {Array<object>} rawResults The file's raw results.
     * @returns {void}
     */
    function reportFile(rel, timingLabel, rawResults) {
      process.stdout.write(`-- ${rel} `);
      console.log(`(${timingLabel})`);
      for (const line of recordFileResults(rawResults)) console.log(line);
    }

    /** @returns {void} */
    function spawnWorker() {
      const child = fork(workerScript, [], { silent: true });
      let assignedFile = null;
      let stderrTail = "";

      if (child.stdout) child.stdout.resume();
      if (child.stderr) {
        child.stderr.on("data", (chunk) => {
          stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
        });
      }

      /** @returns {void} */
      function assignNext() {
        const next = queue.shift();
        if (next === undefined) {
          child.send({ type: "shutdown" });
          return;
        }
        assignedFile = next;
        child.send({ type: "run", file: next });
      }

      child.on("message", (msg) => {
        if (settled || !msg || msg.type !== "file-done") return;
        assignedFile = null;
        reportFile(relPath(msg.file), `${msg.elapsedMs}ms`, msg.results);
        remaining -= 1;
        if (remaining === 0) settleResolve();
        assignNext();
      });

      child.on("exit", (code, signal) => {
        if (settled || !assignedFile) return;
        const rel = relPath(assignedFile);
        assignedFile = null;
        const detail = stderrTail.trim() ? ` — stderr: ${stderrTail.trim()}` : "";
        reportFile(rel, "worker exited", [
          requireFailureResult(rel, new Error(`worker exited (code=${code}, signal=${signal}) before finishing this file${detail}`)),
        ]);
        remaining -= 1;
        if (remaining === 0) {
          settleResolve();
          return;
        }
        if (queue.length > 0) spawnWorker();
      });

      child.on("error", settleReject);

      assignNext();
    }

    for (let i = 0; i < poolSize; i += 1) spawnWorker();
  });
}

/** @returns {void} */
function finish() {
  if (skippedCases.length > 0) {
    console.log("\nSkipped:");
    for (const s of skippedCases) {
      console.log(`  - ${s.label}: ${s.reason}`);
    }
  }

  console.log(`\n=== ${pass} passed, ${fail} failed, ${skippedCases.length} skipped ===`);

  if (junitPath) {
    const xml = buildJunitXml(effectiveResults);
    fs.mkdirSync(path.dirname(junitPath), { recursive: true });
    fs.writeFileSync(junitPath, xml, "utf8");
    console.log(`wrote ${junitPath}`);
  }

  process.exit(fail ? 1 : 0);
}

if (workerCount <= 1) {
  // The original, fully serial path — no child process is ever forked, so
  // this is also the escape hatch `--workers 1` promises.
  for (const file of files) {
    const rel = relPath(file);
    // Written without a trailing newline and with no case output in between,
    // so the file name is visible on the stream as soon as it starts running
    // — the marker line, in one write, spans from before the file runs to
    // after it finishes.
    process.stdout.write(`-- ${rel} `);

    const resultsBefore = harness.results.length;
    const startedAt = Date.now();
    try {
      require(file);
    } catch (error) {
      harness.results.push(requireFailureResult(rel, error));
    }
    const elapsedMs = Date.now() - startedAt;
    console.log(`(${elapsedMs}ms)`);

    for (const line of recordFileResults(harness.results.slice(resultsBefore))) console.log(line);
  }
  finish();
} else {
  runParallel(files, workerCount)
    .then(finish)
    .catch((error) => {
      console.error(error && error.stack ? error.stack : String(error));
      process.exit(1);
    });
}
