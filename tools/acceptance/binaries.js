"use strict";

/**
 * Locates the real agent binaries `tools/acceptance/run.js --live` drives.
 * Never used by the non-`--live` path, and never imported by
 * `tools/acceptance/score.js` — Layer 1 stays free of any of this.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Searches `PATH` for an executable, the same shell-free resolution
 * `tests/probes/_host.js#resolveExecutable` already uses — reimplemented
 * here rather than required from a test-only file, so `tools/acceptance`
 * stays self-contained.
 *
 * @param {string} name The bare command name, e.g. `"claude"`.
 * @returns {string | null} The first matching file's absolute path, or
 * `null` when nothing on `PATH` matches.
 */
function resolveOnPath(name) {
  const pathEnv = process.env.PATH || process.env.Path || "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const isWindows = process.platform === "win32";
  const exts = isWindows ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, isWindows ? `${name}${ext}` : name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Not here — try the next candidate.
      }
    }
  }
  return null;
}

/**
 * Unwraps a Windows npm `.cmd`/`.bat` shim to the real script it invokes, so
 * the shim itself never has to be run through `cmd.exe` (this repository
 * bans a shell dependency everywhere, tests included).
 *
 * @param {string} resolvedPath An absolute path from {@link resolveOnPath}.
 * @returns {{command: string, prefixArgs: string[]} | null} A directly
 * invocable command, or `null` when `resolvedPath` is a shim whose real
 * script could not be located.
 */
function directInvocation(resolvedPath) {
  const ext = path.extname(resolvedPath).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return { command: resolvedPath, prefixArgs: [] };

  let content;
  try {
    content = fs.readFileSync(resolvedPath, "utf8");
  } catch {
    return null;
  }
  const match = content.match(/"%dp0%\\([^"]+\.js)"/i);
  if (!match) return null;
  const jsPath = path.join(path.dirname(resolvedPath), match[1]);
  return fs.existsSync(jsPath) ? { command: process.execPath, prefixArgs: [jsPath] } : null;
}

/**
 * Locates the real Claude Code CLI on this machine.
 *
 * @returns {{command: string, prefixArgs: string[]} | null} A directly
 * invocable command, or `null` when `claude` is not on `PATH` or its shim
 * could not be resolved.
 */
function locateClaudeBinary() {
  const resolved = resolveOnPath("claude");
  return resolved ? directInvocation(resolved) : null;
}

/**
 * Recursively lists every file under a directory, tolerating a missing or
 * unreadable one by returning an empty list.
 *
 * @param {string} dir The directory to walk.
 * @returns {string[]} Absolute paths to every file found.
 */
function walkFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  let files = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) files = files.concat(walkFiles(abs));
    else if (entry.isFile()) files.push(abs);
  }
  return files;
}

/**
 * Locates the real Codex standalone binary, which ships versioned and is
 * never on `PATH`: `<codexHome>/packages/standalone/releases/<version>/bin/codex.exe`.
 * Globs the releases directory rather than hardcoding a version, so a Codex
 * update does not silently break this.
 *
 * @param {string} [codexHome] The real Codex home to search under; defaults
 * to `<os.homedir()>/.codex` — deliberately independent of this
 * repository's own `SOFTELA_AI_HOME`/`core/lib/paths.js` override, the same way
 * `tests/probes/_host.js#codexRealHome` is: this locates the binary
 * actually installed on the machine, not a scratch install.
 * @returns {string | null} The newest release's `codex.exe` (or `codex` on
 * non-Windows) by directory name, lexically — release directory names are
 * dotted-numeric versions, which sort correctly this way for any release
 * series actually shipped — or `null` when no releases directory, or no
 * binary inside one, was found.
 */
function locateCodexBinary(codexHome = path.join(os.homedir(), ".codex")) {
  const releasesDir = path.join(codexHome, "packages", "standalone", "releases");
  let versions;
  try {
    versions = fs.readdirSync(releasesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return null;
  }
  versions.sort();
  const exeName = process.platform === "win32" ? "codex.exe" : "codex";
  for (let i = versions.length - 1; i >= 0; i -= 1) {
    const candidate = path.join(releasesDir, versions[i], "bin", exeName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

module.exports = { resolveOnPath, directInvocation, locateClaudeBinary, locateCodexBinary, walkFiles };
