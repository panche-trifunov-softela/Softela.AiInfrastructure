#!/usr/bin/env node
"use strict";

/**
 * `SessionStart` hook: cross-checks the configured `languages` option
 * against this module's own catalogue (`languages.json`), so a language
 * that is not in the catalogue is reported at the start of every session
 * instead of being silently accepted.
 *
 * This validates the configured *option value*, never the agent's own
 * reply — there is no tool call whose input reliably tells a hook what
 * language a reply used, which is why `reply-language` ships no
 * `PreToolUse` or `PostToolUse` guard (see the module's `README.md`).
 * Catalogue membership is a plain, deterministic lookup a `SessionStart`
 * hook can make safely, without watching conversation content.
 *
 * Deliberately self-contained, matching `memory-as-context`'s hook
 * scripts: no reach into `core/lib` or another module, so this file keeps
 * working unmodified regardless of how the installed layout evolves.
 * Fails open on any error — a malformed catalogue or a missing argument
 * produces no output at all rather than a crash.
 */

const fs = require("fs");

/**
 * Parses `--key=value` arguments, ignoring anything that does not match.
 *
 * @param {string[]} argv The raw argument list, typically `process.argv.slice(2)`.
 * @returns {Record<string, string>} Parsed key/value pairs.
 */
function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([a-zA-Z0-9-]+)=([\s\S]*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Reads and parses the language catalogue.
 *
 * @param {string} catalogueFile Absolute path to `languages.json`.
 * @returns {{code: string, name: string, endonym?: string}[]} The
 * catalogue entries, or an empty array on any read or parse failure.
 */
function readCatalogue(catalogueFile) {
  try {
    const raw = fs.readFileSync(catalogueFile, "utf8").replace(/\r\n/g, "\n");
    const data = JSON.parse(raw);
    return Array.isArray(data.languages) ? data.languages : [];
  } catch {
    return [];
  }
}

/**
 * Decides whether one configured language entry matches a catalogue entry.
 *
 * Matches case-insensitively against the entry's English name, its ISO
 * 639-1 code, or its endonym, so a developer may configure any of the
 * three without the plain comma-separated list that already worked
 * breaking.
 *
 * @param {string} configured One entry from the configured `languages` list.
 * @param {{code: string, name: string, endonym?: string}[]} catalogue The
 * full catalogue.
 * @returns {boolean} `true` when `configured` matches some entry.
 */
function isKnown(configured, catalogue) {
  const needle = configured.trim().toLowerCase();
  if (!needle) return true;
  return catalogue.some((entry) => {
    if (!entry || typeof entry.name !== "string" || typeof entry.code !== "string") return false;
    if (entry.name.toLowerCase() === needle || entry.code.toLowerCase() === needle) return true;
    return typeof entry.endonym === "string" && entry.endonym.toLowerCase() === needle;
  });
}

/**
 * Writes the `SessionStart` payload, or nothing when there is nothing to say.
 *
 * @param {string} additionalContext The context block to inject; emits no
 * output at all when empty.
 * @returns {void}
 */
function emit(additionalContext) {
  if (!additionalContext) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
    }),
  );
}

try {
  const args = parseArgs(process.argv.slice(2));
  const catalogueFile = args.catalogue || "";
  const configured = (args.languages || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (catalogueFile && configured.length > 0) {
    const catalogue = readCatalogue(catalogueFile);
    if (catalogue.length > 0) {
      const unknown = configured.filter((name) => !isKnown(name, catalogue));
      if (unknown.length > 0) {
        const list = unknown.map((n) => `"${n}"`).join(", ");
        const noun = unknown.length === 1 ? "an entry" : "entries";
        emit(
          `## reply-language: unrecognised language\n\n` +
            `The configured \`languages\` option lists ${noun} not found in this ` +
            `module's ISO 639-1 catalogue (\`modules/reply-language/languages.json\`): ` +
            `${list}. Fix the \`languages\` option to name a language from the ` +
            `catalogue — by its English name, its ISO 639-1 code, or its endonym — ` +
            `rather than leaving an unrecognised entry in place.`,
        );
      }
    }
  }
} catch {
  // Fail open: a broken catalogue or an unexpected error must never be able
  // to block a session from starting.
}
