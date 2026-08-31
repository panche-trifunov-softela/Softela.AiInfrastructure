"use strict";

/**
 * Resolves the exact token this installer substitutes for an absolute
 * filesystem path into a hook `command` line, on Windows.
 *
 * {@link resolvePathToken}, the bare-space-free-token-when-possible
 * mechanism this module exists to provide, is used only for Codex
 * (`core/installer/plan.js#pathToken`): Codex spawns a hook command by
 * splitting the whole string on whitespace and using the first token as the
 * executable directly — never through a shell (docs/internal/INSTALLER.md
 * §5). A command-shape probe against the real binary showed this bites only
 * the executable position: an executable path with a space in it never
 * runs, quoted or not — quoting the first token does not rescue it. Every
 * token after the first, by contrast, IS tokenised correctly, and a quoted
 * argument arrives at the child process with its quote characters already
 * stripped, so a quoted argument carrying a space works fine there. The
 * token that genuinely needs to be bare and space-free is the executable;
 * this module is what tries to produce that, and an honest, detectable
 * fallback when it cannot.
 *
 * Claude Code is the opposite case and does not go through
 * {@link resolvePathToken} at all: it hands the whole command string to a
 * POSIX shell, where an unquoted Windows path is corrupted outright (a bare
 * backslash is an escape character), so every path substituted for that
 * host is always quoted via {@link quotePath}, unconditionally — never a
 * short-path candidate.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/**
 * Wraps a path in double quotes for a real shell to parse as one token —
 * this repository's fallback shape for a Windows hook command path that
 * still carries a space. Codex strips the quote characters back off before
 * an argument reaches the child process, so this shape is fine there; used
 * for the executable position instead, it does not help — a quoted
 * executable with a space simply never runs (see the module doc comment
 * above).
 *
 * @param {string} p The path to quote.
 * @returns {string} `p` wrapped in double quotes.
 */
function quotePath(p) {
  return `"${p}"`;
}

/**
 * Asks `cmd.exe`'s `for` loop to resolve `absPath` to its Windows 8.3 short
 * form (`%~sI`).
 *
 * `execFileSync` was tried first and rejected: it re-quotes its own argv
 * before handing anything to `cmd.exe`, which defeats the `%I` loop-variable
 * expansion a `for`-style command needs. `execSync` with `shell: "cmd.exe"`
 * instead feeds the whole line to `cmd.exe` as one string, which is the
 * shape that actually works.
 *
 * `cmd.exe` never errors on a path that does not exist — it shortens
 * whichever leading segments of `absPath` currently exist on disk and
 * echoes back the rest unchanged, which is exactly what makes this usable
 * during a fresh install, before `<agentHome>/softela-ai` itself has been
 * created ({@link resolvePathToken} verifies that against the nearest
 * existing ancestor rather than the full path for this reason).
 *
 * @param {string} absPath An absolute filesystem path, existing or not.
 * @returns {string | null} The line `cmd.exe` printed, trimmed; `null` on
 * any failure (`cmd.exe` missing, the call erroring, or empty output).
 * Never throws.
 */
function queryShortPath(absPath) {
  try {
    const out = execSync(`for %I in ("${absPath}") do @echo %~sI`, {
      shell: "cmd.exe",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Finds the nearest ancestor of `p` that exists on disk.
 *
 * @param {string} p An absolute path.
 * @returns {{ancestor: string | null, strippedSegments: number}} `ancestor`
 * is the nearest existing directory; `null` only when nothing along `p`
 * exists, including its root (never observed in practice). `strippedSegments`
 * is how many trailing path components separate `p` from `ancestor` — the
 * count {@link resolvePathToken} strips off a short-path candidate before
 * checking it against the same ancestor.
 */
function nearestExistingAncestor(p) {
  let cur = p;
  let strippedSegments = 0;
  for (;;) {
    let exists;
    try {
      exists = fs.existsSync(cur);
    } catch {
      exists = false;
    }
    if (exists) return { ancestor: cur, strippedSegments };

    const parent = path.dirname(cur);
    if (parent === cur) return { ancestor: null, strippedSegments };
    cur = parent;
    strippedSegments += 1;
  }
}

/**
 * Strips `count` trailing path segments off `p`, via repeated `path.dirname`.
 *
 * @param {string} p A path.
 * @param {number} count How many trailing segments to remove.
 * @returns {string} `p` with `count` segments removed from its end.
 */
function stripTrailingSegments(p, count) {
  let cur = p;
  for (let i = 0; i < count; i += 1) cur = path.dirname(cur);
  return cur;
}

/**
 * Verifies a short-path candidate against the nearest existing ancestor of
 * the path it was resolved from, rather than against the full (possibly
 * not-yet-created) target — see {@link queryShortPath}'s own doc comment for
 * why a fresh install's own target directory legitimately does not exist yet
 * at planning time, and still resolves correctly.
 *
 * @param {string} absPath The original path `short` was resolved from.
 * @param {string} short The candidate short form to verify.
 * @returns {boolean} `true` when the existing portion of `short` checks out
 * on disk.
 */
function verifyShortPath(absPath, short) {
  const { ancestor, strippedSegments } = nearestExistingAncestor(absPath);
  if (ancestor === null) return false;
  const shortAncestor = stripTrailingSegments(short, strippedSegments);
  try {
    return fs.existsSync(shortAncestor);
  } catch {
    return false;
  }
}

/**
 * Resolves the exact token this installer substitutes for one absolute path
 * into a hook `command` line.
 *
 * Flow:
 * - any non-Windows platform: unchanged from what this installer has always
 *   done — quoted, exactly as {@link quotePath} produces.
 * - a Windows path carrying no space: already safe to use bare, so it is
 *   returned exactly as given — no subprocess spawned, and no 8.3 alias
 *   fabricated for a name that does not need one.
 * - a Windows path carrying a space: resolved through `shortPathResolver`,
 *   then trusted only when the result itself carries no space (8.3 name
 *   generation can be disabled per volume, in which case `cmd.exe` simply
 *   echoes the long name back unchanged) AND {@link verifyShortPath} confirms
 *   it against real, on-disk ancestors.
 * - anything else — the resolver failing, or failing verification — falls
 *   back to {@link quotePath}'s form: safe for a real shell (Claude Code),
 *   and safe for Codex too when the token lands in an argument position —
 *   but still broken when it is the executable (`NODE`) itself, which is
 *   exactly what `usedShortPath: false` on a Windows result lets a caller
 *   (`doctor` included) detect and report instead of shipping silently.
 *
 * @param {string} absPath An absolute filesystem path.
 * @param {{platform?: string, shortPathResolver?: (absPath: string) => string | null}} [options]
 * `platform` defaults to `process.platform`; `shortPathResolver` defaults to
 * {@link queryShortPath} and exists so a test can drive both the
 * short-path-succeeds and the falls-back-to-quoted branch without depending
 * on this machine's own volume settings.
 * @returns {{value: string, usedShortPath: boolean}} `value` is the token to
 * substitute into the command line; `usedShortPath` is `true` only when a
 * genuine, verified 8.3 short form is being used, bare, in its place.
 */
function resolvePathToken(absPath, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return { value: quotePath(absPath), usedShortPath: false };
  if (!/\s/.test(absPath)) return { value: absPath, usedShortPath: false };

  const resolver = options.shortPathResolver || queryShortPath;
  let short = null;
  try {
    short = resolver(absPath);
  } catch {
    short = null;
  }

  if (short && !/\s/.test(short) && verifyShortPath(absPath, short)) {
    return { value: short, usedShortPath: true };
  }
  return { value: quotePath(absPath), usedShortPath: false };
}

module.exports = { quotePath, queryShortPath, resolvePathToken, nearestExistingAncestor, stripTrailingSegments };
