"use strict";

const { suite } = require("../harness");
const { compile, compileAll, MAX_PATTERN_LENGTH } = require("../../core/lib/safe-regexp");

suite("lib/safe-regexp", ({ test, eq, ok }) => {
  test("compiles a valid pattern", () => {
    const re = compile("^git\\s+push$");
    ok(re instanceof RegExp);
    ok(re.test("git push"));
  });

  test("defaults to case-insensitive flags", () => {
    const re = compile("push");
    ok(re.test("PUSH"));
  });

  test("an explicit flags argument is honoured", () => {
    const re = compile("push", "");
    eq(re.test("PUSH"), false);
  });

  test("an invalid pattern returns null instead of throwing", () => {
    eq(compile("(unclosed"), null);
  });

  test("a non-string pattern returns null", () => {
    eq(compile(42), null);
    eq(compile(null), null);
    eq(compile(undefined), null);
  });

  test("a pattern longer than the maximum is rejected", () => {
    const long = "a".repeat(MAX_PATTERN_LENGTH + 1);
    eq(compile(long), null);
  });

  test("a pattern at the maximum length still compiles", () => {
    const atMax = "a".repeat(MAX_PATTERN_LENGTH);
    ok(compile(atMax) instanceof RegExp);
  });

  test("compileAll separates valid from invalid patterns", () => {
    const { regexps, invalid } = compileAll(["push", "(unclosed", "\\bpull\\b"]);
    eq(regexps.length, 2);
    eq(invalid.length, 1);
    eq(invalid[0], "(unclosed");
  });

  test("compileAll on a non-array returns everything empty", () => {
    const { regexps, invalid } = compileAll(undefined);
    eq(regexps.length, 0);
    eq(invalid.length, 0);
  });
});
