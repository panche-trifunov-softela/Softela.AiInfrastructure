"use strict";

/**
 * Filesystem access that never throws and never leaves a half-written file
 * behind.
 *
 * Every read here returns `null` on any failure instead of propagating an
 * exception, and every write goes through a temp-file-then-rename sequence,
 * so a crash mid-write cannot corrupt a file this repository manages.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/**
 * Normalises line endings to `\n`.
 *
 * @param {string} text The text to normalise.
 * @returns {string} The text with every `\r\n` replaced by `\n`.
 */
function normalise(text) {
  return text.replace(/\r\n/g, "\n");
}

/**
 * Reads a text file, never throwing.
 *
 * @param {string} p The file path.
 * @returns {string | null} The file's contents with line endings normalised
 * to `\n`, or `null` when the file cannot be read.
 */
function readText(p) {
  try {
    return normalise(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Reads and parses a JSON file, never throwing.
 *
 * @param {string} p The file path.
 * @returns {object | null} The parsed value, or `null` when the file cannot
 * be read or does not contain valid JSON.
 */
function readJson(p) {
  const text = readText(p);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Ensures a directory exists, creating it and any missing parents.
 *
 * @param {string} d The directory path.
 * @returns {void}
 */
function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

/**
 * Writes text to a file atomically: the new content is written to a
 * temporary sibling file, then renamed over the destination.
 *
 * @param {string} p The destination file path.
 * @param {string} text The content to write; always written with `\n` line
 * endings.
 * @returns {void}
 */
function writeTextAtomic(p, text) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, normalise(text), "utf8");
  fs.renameSync(tmp, p);
}

/**
 * Writes a value as formatted JSON, atomically.
 *
 * @param {string} p The destination file path.
 * @param {object} obj The value to serialise.
 * @returns {void}
 */
function writeJsonAtomic(p, obj) {
  writeTextAtomic(p, `${JSON.stringify(obj, null, 2)}\n`);
}

/**
 * Computes the SHA-256 of a text's content after line-ending normalisation,
 * so a CRLF checkout is never read as a local modification.
 *
 * @param {string} text The text to hash.
 * @returns {string} The hex-encoded digest.
 */
function sha256(text) {
  return crypto.createHash("sha256").update(normalise(text), "utf8").digest("hex");
}

/**
 * Copies a file, never throwing.
 *
 * @param {string} src The source path.
 * @param {string} dest The destination path.
 * @returns {boolean} `true` on success, `false` on any failure.
 */
function copyFileSafe(src, dest) {
  try {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes a file or directory if it exists, never throwing.
 *
 * @param {string} p The path to remove.
 * @returns {void}
 */
function removeIfExists(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // Fail open: nothing left to remove, or it could not be removed.
  }
}

/**
 * Lists every file under a directory, recursively.
 *
 * Calling this with no second argument is byte-for-byte identical to the
 * original, unparameterised behaviour — that shape is relied on by
 * `core/installer/detect.js`, which enumerates every file this product
 * ships (including its own CLI entry point, `bin/softela-ai`) and must never see
 * its result silently change shape.
 *
 * @param {string} dir The directory to walk.
 * @param {{skipDirs?: string[], extensions?: string[], limit?: number}} [options]
 * `skipDirs` names additional directory names to skip, merged with the
 * built-in `.git`/`node_modules` skip set. `extensions` restricts the result
 * to files whose extension (lower-cased, leading dot, e.g. `".cs"`) is in the
 * list; omitted or empty means no filtering. `limit` bails out of the walk as
 * soon as more than `limit` matching files have been found, so a
 * pathological tree is never walked to completion just to discover it is
 * over budget.
 * @returns {string[] | {files: string[], complete: boolean}} When `limit` is
 * not supplied: paths relative to `dir`, POSIX-separated and sorted; an empty
 * array when `dir` cannot be read — exactly the original return shape. When
 * `limit` IS supplied: `{files, complete}`, where `complete` is `false` when
 * the walk was cut short by the limit (in which case `files` is always `[]`
 * and must not be trusted as a partial listing) and `true` otherwise, with
 * `files` sorted the same way — this explicit flag is what lets a caller tell
 * "hit the limit" apart from "there were exactly that many files".
 */
function listFilesRecursive(dir, options) {
  const opts = options || {};
  const skip = new Set([".git", "node_modules", ...(Array.isArray(opts.skipDirs) ? opts.skipDirs : [])]);
  const extensions =
    Array.isArray(opts.extensions) && opts.extensions.length > 0
      ? new Set(opts.extensions.map((e) => String(e).toLowerCase()))
      : null;
  const hasLimit = typeof opts.limit === "number";

  const results = [];
  let overLimit = false;

  function walk(current, rel) {
    if (overLimit) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (overLimit) return;
      if (skip.has(entry.name)) continue;
      const abs = path.join(current, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, relPath);
      } else if (entry.isFile()) {
        if (extensions && !extensions.has(path.extname(entry.name).toLowerCase())) continue;
        results.push(relPath);
        if (hasLimit && results.length > opts.limit) {
          overLimit = true;
          return;
        }
      }
    }
  }

  walk(dir, "");

  if (!hasLimit) return results.sort();
  return overLimit ? { files: [], complete: false } : { files: results.sort(), complete: true };
}

module.exports = {
  readText,
  readJson,
  writeTextAtomic,
  writeJsonAtomic,
  sha256,
  copyFileSafe,
  ensureDir,
  removeIfExists,
  listFilesRecursive,
};
