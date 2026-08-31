#!/usr/bin/env node
"use strict";

/**
 * `PostToolUse` hook: records every `Write` / `Edit` under the memory
 * directory into that directory's own local git repository, so no memory
 * content is ever irrecoverably overwritten by a wrong edit — with history,
 * every version is diffable and revertable.
 *
 * This hook git-inits the memory directory itself, the first time there is
 * something to commit — never before, and never rewriting any file it did
 * not itself just write. That is deliberate: the module ships no separate
 * one-time setup step a developer could forget to run, so a memory
 * directory that has never been a repository must still end up versioned.
 *
 * That lazy init never runs for the `"global"` location's shared directory
 * (`isSharedMemoryDir`, `memory-location.js`) when it already is its own
 * git repository — the developer's own history is left exactly as found —
 * and it declines outright, doing nothing, when that shared directory sits
 * inside some other enclosing repository without yet being its own: nesting
 * a fresh repo there would silently detach the developer's own files from
 * whatever history already tracks them.
 *
 * Ignores everything outside the resolved memory directory, ignores every
 * tool that writes no file, and swallows every possible failure — this must
 * never block or slow down a turn.
 */

const fs = require("fs");
const path = require("path");
const { parseArgs, resolveMemoryDir, ensureSelfIgnored, UNSPECIFIED_LOCATION } = require("./memory-location");
const { readStdin } = require("./stdin");
const { commitAll, canonical } = require("./git-commit");

/**
 * Exits the process, optionally emitting a hook payload first.
 *
 * @param {object | null} payload The JSON payload to write to stdout, or
 * `null` for none.
 * @returns {void}
 */
function finish(payload) {
  try {
    if (payload) process.stdout.write(JSON.stringify(payload));
  } catch {
    // Never let output serialisation keep the hook from exiting.
  }
  process.exit(0);
}

/**
 * Resolves `core/lib/write-decode.js#decodeWrites` from whichever of this
 * module's two on-disk layouts is present, exactly as `guard-memory.js` does
 * for the same dependency and for its own shell detector.
 *
 * @returns {null | ((toolName: string, input: object, options: object) => Array<{path: string}>)}
 * The function, or `null` when neither layout resolves.
 */
function resolveDecodeWrites() {
  for (const modulePath of ["../core/lib/write-decode", "../../../core/lib/write-decode"]) {
    try {
      return require(modulePath).decodeWrites;
    } catch (err) {
      if (!err || err.code !== "MODULE_NOT_FOUND") return null;
    }
  }
  return null;
}

/**
 * Names every absolute path a write tool call would land content on.
 *
 * `Write`/`Edit` carry their target in the payload, so it is read straight
 * off. `apply_patch` — Codex's only write tool — carries a V4A envelope
 * instead, and this hook used to filter it out by name: on Codex the whole
 * autocommit was therefore dead, and nothing the agent recorded in memory
 * was ever versioned. Measured against the real host, not inferred.
 *
 * @param {string} toolName The tool that produced this write.
 * @param {object} toolInput The tool's own input payload.
 * @param {string} cwd The directory a relative path resolves against.
 * @returns {string[]} Absolute paths; empty when nothing could be resolved,
 * which the caller treats as "nothing to commit".
 */
function writtenPaths(toolName, toolInput, cwd) {
  if (toolName !== "apply_patch") {
    const filePath = toolInput.file_path || toolInput.filePath || toolInput.path;
    if (!filePath || typeof filePath !== "string") return [];
    return [path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)];
  }

  const decodeWrites = resolveDecodeWrites();
  if (!decodeWrites) return [];

  const readLocal = (p) => {
    try {
      return fs.readFileSync(path.isAbsolute(p) ? p : path.resolve(cwd, p), "utf8");
    } catch {
      return null;
    }
  };

  try {
    const writes = decodeWrites("apply_patch", toolInput, {
      readFile: readLocal,
      readFileRepoRoot: readLocal,
      pathExistsRepoRoot: (p) => readLocal(p) !== null,
    });
    return (Array.isArray(writes) ? writes : [])
      .map((w) => String(w.path || ""))
      .filter(Boolean)
      .map((p) => (path.isAbsolute(p) ? p : path.resolve(cwd, p)));
  } catch {
    return [];
  }
}

/**
 * Runs the hook body once stdin has been read.
 *
 * Mirrors the script's previous fully-synchronous top-level flow exactly —
 * only the stdin acquisition changed, from a blocking `fs.readFileSync(0)`
 * to the non-blocking {@link readStdin}. Every `finish()` call still ends
 * the process via `process.exit()`, so control never needs to `return` here
 * any more than it did at the top level before.
 *
 * @returns {Promise<void>}
 */
async function main() {
  let input;
  try {
    input = JSON.parse((await readStdin()) || "{}");
  } catch {
    finish(null);
  }

  const toolName = input && (input.tool_name || input.toolName);
  if (toolName !== "Write" && toolName !== "Edit" && toolName !== "apply_patch") finish(null);

  const toolInput = (input && (input.tool_input || input.toolInput || input.input)) || {};

  const args = parseArgs(process.argv.slice(2));
  const agentHome = args["agent-home"] || "";
  const location = args.location || UNSPECIFIED_LOCATION;
  if (!agentHome) finish(null);

  const cwd = input.cwd || input.workspace || input.working_directory || process.cwd();
  const memoryDir = resolveMemoryDir({ agentHome, cwd, location });

  const written = writtenPaths(toolName, toolInput, cwd);
  if (written.length === 0) finish(null);

  const memoryPrefix = `${canonical(memoryDir)}/`;
  const touchedMemory = written.some((p) => {
    try {
      return canonical(p).startsWith(memoryPrefix);
    } catch {
      return false;
    }
  });
  if (!touchedMemory) finish(null);

  // Confirmed the write actually landed inside the memory directory, so this
  // exclusion is a consequence of a memory write that already happened —
  // never a side effect of an unrelated Write/Edit elsewhere. Excludes the
  // memory directory from whatever repository happens to enclose it (see
  // memory-location.js for why this writes to that repository's own
  // `.git/info/exclude` rather than a `.gitignore` anywhere). No-ops for a
  // shared directory (see `isSharedMemoryDir` below).
  ensureSelfIgnored(memoryDir, agentHome);

  // Only proceed once the write already succeeded and left real content
  // behind — `commitAll` initialises the git repo lazily, on the first
  // commit, never ahead of there being something to version, and declines
  // outright (never touched further) for a shared directory that already
  // sits, un-versioned, inside some other enclosing repository.
  const result = commitAll({
    memoryDir,
    agentHome,
    // Subject-only, deliberately not prefixed with a conventional-commit type.
    buildSubject: (changedFiles) => {
      const basenames = changedFiles.map((f) => path.basename(f));
      const first = basenames[0];
      return basenames.length > 1 ? `Update ${first} (+${basenames.length - 1} more)` : `Update ${first}`;
    },
    // Whole-directory, explicitly — this hook's own trigger is a Write/Edit
    // the developer's agent just made inside the memory directory, so
    // staging everything is the right scope here, unlike `seed-memory.js`'s
    // own `SessionStart` trigger (see `git-commit.js#commitAll`'s own doc
    // comment on `paths`).
    paths: ["."],
  });

  if (result.status === "declined") finish(null);

  // "clean" (nothing staged, e.g. a Write with identical content) and
  // "attempted" (a commit was tried, whether or not it actually succeeded)
  // both mean success from this hook's own point of view.
  finish({ suppressOutput: true });
}

main();
