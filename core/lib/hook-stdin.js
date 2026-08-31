"use strict";

/**
 * The canonical, non-blocking way every hook and dispatcher script in this
 * repository reads its host payload from stdin.
 *
 * A bare synchronous `fs.readFileSync(0, "utf8")` blocks forever against a
 * host that opens a stdin pipe but never writes to it or closes it — this
 * was measured directly against a Claude Code hook under exactly that
 * condition. This module is the single implementation of the fix, so every
 * caller — `adapters/shared/dispatch-core.js` and every module hook script
 * that reads stdin — shares one place that can never drift out of sync with
 * itself.
 */

/**
 * How long stdin is given to arrive before a read proceeds with whatever
 * showed up. A synchronous `readFileSync(0)` can block forever against an
 * open, unwritten pipe, so this is the ceiling on that failure mode.
 */
const STDIN_TIMEOUT_MS = 500;

/**
 * Reads stdin to completion without risking an indefinite hang.
 *
 * Flow:
 * 1. Resolves immediately with `""` when stdin is a TTY — there is nothing
 *    to read and nothing will ever arrive.
 * 2. Otherwise collects `data` events and resolves on `end` or `error` with
 *    whatever text was collected.
 * 3. Races an `unref()`'d timeout of {@link STDIN_TIMEOUT_MS} that resolves
 *    with whatever arrived so far — the timeout can never by itself keep the
 *    process alive, so a host that never closes the pipe cannot hang the
 *    caller.
 *
 * @returns {Promise<string>} The bytes read from stdin, or `""` when nothing
 * arrived in time.
 */
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }

    let data = "";
    let settled = false;

    const finish = (text) => {
      if (settled) return;
      settled = true;
      try {
        process.stdin.pause();
        if (typeof process.stdin.unref === "function") process.stdin.unref();
      } catch {
        // Best-effort release only — resolving must never wait on cleanup.
      }
      resolve(text);
    };

    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        data += chunk;
      });
      process.stdin.once("end", () => finish(data));
      process.stdin.once("error", () => finish(data));
    } catch {
      finish(data);
      return;
    }

    const timer = setTimeout(() => finish(data), STDIN_TIMEOUT_MS);
    timer.unref();
  });
}

/**
 * Parses a JSON payload tolerantly.
 *
 * @param {string} text The raw text read from stdin.
 * @returns {object} The parsed payload, or `{}` when it is empty, not valid
 * JSON, or does not parse to an object.
 */
function parsePayload(text) {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

module.exports = { STDIN_TIMEOUT_MS, readStdin, parsePayload };
