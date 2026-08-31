"use strict";

/**
 * Safe regular expression compilation.
 *
 * Every regex built from data that did not ship with this repository — an
 * override pattern above all — must go through here instead of `new RegExp`
 * directly, so a malformed pattern degrades to "the rule does not match"
 * rather than crashing the guard that evaluates it.
 */

/** Patterns longer than this are rejected outright, never compiled. */
const MAX_PATTERN_LENGTH = 500;

/**
 * Compiles a pattern, never throwing.
 *
 * @param {string} pattern The regular expression source.
 * @param {string} [flags] The regular expression flags.
 * @returns {RegExp | null} The compiled regex, or `null` when the pattern is
 * not a string, is too long, or fails to compile.
 */
function compile(pattern, flags = "i") {
  if (typeof pattern !== "string") return null;
  if (pattern.length > MAX_PATTERN_LENGTH) return null;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/**
 * Compiles a list of patterns, separating the ones that succeeded from the
 * ones that did not.
 *
 * @param {string[]} patterns The regular expression sources.
 * @param {string} [flags] The regular expression flags applied to each.
 * @returns {{regexps: RegExp[], invalid: string[]}} The compiled regexes,
 * and the source patterns that failed to compile.
 */
function compileAll(patterns, flags = "i") {
  const regexps = [];
  const invalid = [];
  for (const pattern of Array.isArray(patterns) ? patterns : []) {
    const re = compile(pattern, flags);
    if (re) regexps.push(re);
    else invalid.push(pattern);
  }
  return { regexps, invalid };
}

module.exports = { compile, compileAll, MAX_PATTERN_LENGTH };
