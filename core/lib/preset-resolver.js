"use strict";

/**
 * Loads a stack's preset config and merges it under a project's own config.
 *
 * A preset holds the conventions common to every project of one stack —
 * frontend architecture/structure rules, or the backend equivalent — so a
 * project file only has to restate what is genuinely specific to it
 * (CONTRACTS.md §8a). Reading a preset never throws: a missing or malformed
 * preset file simply contributes nothing, the same fail-open contract every
 * other config read in this repository follows.
 */

const path = require("path");
const { readJson } = require("./fs-safe");
const { repoRoot: infraRoot } = require("./paths");

/** Stacks a preset file may exist for. */
const KNOWN_STACKS = new Set(["frontend", "backend"]);

/**
 * Reads the preset file for a stack.
 *
 * @param {string} stack The resolved stack, expected to be `"frontend"` or
 * `"backend"`.
 * @param {{presetsDir?: string}} [options] `presetsDir` overrides the
 * default `<repoRoot>/projects/_presets` location, mainly for tests.
 * @returns {object | null} The parsed preset, or `null` when the stack is
 * unrecognised, the file is absent, or it fails to parse.
 */
function loadPreset(stack, options = {}) {
  if (!KNOWN_STACKS.has(stack)) return null;
  const presetsDir = options.presetsDir || path.join(infraRoot(), "projects", "_presets");
  return readJson(path.join(presetsDir, `${stack}.json`));
}

/**
 * Merges a stack preset under a project's own configuration.
 *
 * The merge is shallow, one top-level key at a time: a key the project
 * declares replaces the preset's key of the same name wholesale — nothing
 * inside a shared object such as `conventions` or `limits` is merged field
 * by field. A project that wants to change one nested field restates the
 * whole object; that is the one rule stated here rather than left to be
 * guessed at per key, which is what an ambiguous merge would invite.
 *
 * @param {object | null} preset The stack preset, or `null`/absent.
 * @param {object} project The resolved project config, `ctx.project`.
 * @returns {object} The effective config: every key `project` declares wins
 * outright; the preset fills in whatever `project` does not declare.
 */
function mergeProjectWithPreset(preset, project) {
  if (!preset || typeof preset !== "object") return project;
  if (!project || typeof project !== "object") return project;
  return Object.assign({}, preset, project);
}

module.exports = { loadPreset, mergeProjectWithPreset };
