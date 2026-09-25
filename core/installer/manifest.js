"use strict";

/**
 * Reads and writes the installer's ownership manifest
 * (`<agentHome>/.softela-ai/manifest.json`, INSTALLER.md §4).
 *
 * The manifest is the installer's own memory of what it put on disk and
 * with which bytes, so an update can tell an untouched file from one the
 * developer has since edited. Nothing here decides what belongs in the
 * manifest — `plan.js` and `apply.js` do that; this module only reads and
 * writes the shape.
 */

const fs = require("fs");
const path = require("path");
const { readJson, writeJsonAtomic } = require("../lib/fs-safe");
const { manifestPath, stateDir } = require("../lib/paths");

/**
 * How long a lock directory may sit untouched before a new run treats its
 * holder as dead rather than merely slow. Read fresh on every call (never
 * cached at module load) so `SOFTELA_AI_LOCK_STALE_MS` can override it for a test
 * that cannot afford to wait out the real default, regardless of when in the
 * process's lifetime that test happens to run.
 *
 * @returns {number} The stale-lock threshold, in milliseconds.
 */
function lockStaleMs() {
  return Number(process.env.SOFTELA_AI_LOCK_STALE_MS) || 30000;
}

/**
 * How long a run waits for a live lock to be released before giving up.
 * Read fresh on every call for the same reason as {@link lockStaleMs};
 * `SOFTELA_AI_LOCK_WAIT_MS` overrides it.
 *
 * @returns {number} The wait timeout, in milliseconds.
 */
function lockWaitMs() {
  return Number(process.env.SOFTELA_AI_LOCK_WAIT_MS) || 10000;
}

/**
 * Resolves the lock directory path for an agent.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @returns {string} `<stateDir>/.lock` — a directory, not a file, because
 * `fs.mkdirSync` without `recursive` is the one primitive both Windows and
 * POSIX raise `EEXIST` from atomically when two processes race to create it.
 */
function lockPath(agent) {
  return path.join(stateDir(agent), ".lock");
}

/**
 * Blocks synchronously for a short interval, without spinning a busy loop
 * that pins a CPU core.
 *
 * @param {number} ms How long to block.
 * @returns {void}
 */
function sleepSync(ms) {
  const ia = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(ia, 0, 0, ms);
}

/**
 * Acquires the per-agent installer lock, waiting out a live holder and
 * reclaiming a dead one.
 *
 * A lock directory older than {@link lockStaleMs} is assumed to belong to
 * a run that crashed or was killed before releasing it — Ctrl+C, SIGKILL, a
 * lost machine — and is reclaimed rather than left to block every future run
 * forever.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @returns {string} The lock path, to be passed to {@link releaseLock}.
 * @throws {Error} When the lock is still held by another run once
 * {@link lockWaitMs} has elapsed.
 */
function acquireLock(agent) {
  const lp = lockPath(agent);
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  const staleMs = lockStaleMs();
  const deadline = Date.now() + lockWaitMs();

  for (;;) {
    try {
      fs.mkdirSync(lp);
      return lp;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;

      let age = staleMs + 1; // an unreadable lock is treated as reclaimable, not as freshly taken
      try {
        age = Date.now() - fs.statSync(lp).mtimeMs;
      } catch {
        // Lock vanished between the failed mkdir and this stat — another
        // run just released it; fall through and retry immediately.
      }
      if (age > staleMs) {
        try {
          fs.rmSync(lp, { recursive: true, force: true });
        } catch {
          // Someone else is reclaiming it at the same instant — retry below.
        }
        continue;
      }

      if (Date.now() > deadline) {
        throw new Error(
          `another softela-ai run is already in progress for "${agent}" (lock: ${lp}). If no other softela-ai process is running, delete that directory and retry.`,
        );
      }
      sleepSync(Math.min(50, Math.max(1, deadline - Date.now())));
    }
  }
}

/**
 * Releases a lock acquired by {@link acquireLock}. Never throws — a lock
 * that is already gone (reclaimed as stale by someone else) is not an error.
 *
 * @param {string} lp The lock path returned by {@link acquireLock}.
 * @returns {void}
 */
function releaseLock(lp) {
  try {
    fs.rmSync(lp, { recursive: true, force: true });
  } catch {
    // Fail open: nothing left to release.
  }
}

/**
 * Runs `fn` with the per-agent installer lock held, so no other `softela-ai`
 * invocation can read or write this agent's manifest, state or installed
 * files at the same time.
 *
 * @template T
 * @param {string} agent `"claude"` or `"codex"`.
 * @param {() => T} fn The critical section — every read of prior state and
 * every write of the manifest, state file and installed payload for one
 * run's target agent belongs inside here, not split across separate calls,
 * so a second run cannot interleave between "read" and "write".
 * @returns {T} Whatever `fn` returns.
 */
function withLock(agent, fn) {
  const lp = acquireLock(agent);
  try {
    return fn();
  } finally {
    releaseLock(lp);
  }
}

/**
 * Builds an empty manifest for an agent that has never been installed.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @param {string} version The version about to be installed.
 * @returns {object} A manifest with no files, settings, blocks, modules or
 * explicitly-disabled modules recorded yet.
 */
function emptyManifest(agent, version) {
  return {
    version: typeof version === "string" && version ? version : "0.0.0",
    installedAt: null,
    agent: agent === "codex" ? "codex" : "claude",
    files: {},
    settings: [],
    blocks: [],
    modules: [],
    disabledModules: [],
  };
}

/**
 * Reads and normalises the manifest for an agent.
 *
 * `disabledModules` — module ids the developer explicitly turned off via
 * `softela-ai module disable` — defaults to an empty array for a manifest
 * written before this field existed, exactly like every other field here:
 * there is no migration step, and a manifest that predates the field is
 * simply treated as recording no explicit disables yet.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @returns {object | null} The manifest with every field defaulted to its
 * expected type, or `null` when no manifest file exists yet (first
 * install). Never throws.
 */
function readManifest(agent) {
  const data = readJson(manifestPath(agent));
  if (!data || typeof data !== "object") return null;

  // `files` is this manifest's entire reason to exist — every other field is
  // informational. A `files` value present but not itself a genuine
  // per-path-hash object (an array, a string, any other JSON scalar) means
  // ownership tracking cannot be trusted at all, so the whole document is
  // treated the same as one that failed to parse in the first place: callers
  // already handle `readManifest`'s existing `null` case by recovering
  // ownership from on-disk content, and that is exactly what a manifest this
  // broken needs too, rather than a second "parsed but still garbage" case
  // every caller would otherwise have to learn separately.
  if (data.files !== undefined && (data.files === null || typeof data.files !== "object" || Array.isArray(data.files))) {
    return null;
  }

  return {
    version: typeof data.version === "string" ? data.version : "0.0.0",
    installedAt: typeof data.installedAt === "string" ? data.installedAt : null,
    agent: data.agent === "codex" ? "codex" : "claude",
    files: data.files && typeof data.files === "object" ? data.files : {},
    settings: Array.isArray(data.settings) ? data.settings : [],
    blocks: Array.isArray(data.blocks) ? data.blocks : [],
    modules: Array.isArray(data.modules) ? data.modules : [],
    disabledModules: Array.isArray(data.disabledModules) ? data.disabledModules : [],
  };
}

/**
 * Writes a manifest for an agent, atomically.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @param {object} manifest The manifest to write, as produced by
 * {@link emptyManifest} or {@link readManifest} and updated by `apply.js`.
 * @returns {void}
 */
function writeManifest(agent, manifest) {
  writeJsonAtomic(manifestPath(agent), manifest);
}

module.exports = { emptyManifest, readManifest, writeManifest, withLock, acquireLock, releaseLock };
