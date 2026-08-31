"use strict";

const { suite } = require("../harness");
const { TIERS, tierOf } = require("../../core/lib/model-tiers");

suite("lib/model-tiers", ({ test, eq }) => {
  /* ---------------------------------------------------------- frontier */

  test("bare opus resolves to frontier", () => {
    eq(tierOf("opus"), TIERS.FRONTIER);
  });

  test("bare fable resolves to frontier", () => {
    eq(tierOf("fable"), TIERS.FRONTIER);
  });

  test("a full claude opus model id resolves to frontier", () => {
    eq(tierOf("claude-opus-4-1-20250805"), TIERS.FRONTIER);
  });

  test("gpt-5.6-sol resolves to frontier", () => {
    eq(tierOf("gpt-5.6-sol"), TIERS.FRONTIER);
  });

  test("a sol alias with a suffix resolves to frontier", () => {
    eq(tierOf("gpt-5.6-sol-preview"), TIERS.FRONTIER);
  });

  /* ---------------------------------------------------------- balanced */

  test("bare sonnet resolves to balanced", () => {
    eq(tierOf("sonnet"), TIERS.BALANCED);
  });

  test("a full claude sonnet model id resolves to balanced", () => {
    eq(tierOf("claude-3-5-sonnet-20241022"), TIERS.BALANCED);
  });

  test("gpt-5.6-terra resolves to balanced", () => {
    eq(tierOf("gpt-5.6-terra"), TIERS.BALANCED);
  });

  /* -------------------------------------------------------------- cheap */

  test("bare haiku resolves to cheap", () => {
    eq(tierOf("haiku"), TIERS.CHEAP);
  });

  test("a full claude haiku model id resolves to cheap", () => {
    eq(tierOf("claude-3-5-haiku-20241022"), TIERS.CHEAP);
  });

  test("gpt-5.6-luna resolves to cheap", () => {
    eq(tierOf("gpt-5.6-luna"), TIERS.CHEAP);
  });

  /* ---------------------------------------------------------- unknown */

  test("an unrelated model name resolves to null, not frontier", () => {
    eq(tierOf("gpt-4"), null);
  });

  test("an empty string resolves to null", () => {
    eq(tierOf(""), null);
  });

  test("whitespace-only resolves to null", () => {
    eq(tierOf("   "), null);
  });

  test("null resolves to null", () => {
    eq(tierOf(null), null);
  });

  test("undefined resolves to null", () => {
    eq(tierOf(undefined), null);
  });

  test("a non-string value resolves to null rather than throwing", () => {
    eq(tierOf(42), null);
  });

  /* --------------------------------------------- word-boundary safety */

  test("a word that merely contains 'sol' is not frontier", () => {
    eq(tierOf("console-logger"), null);
  });

  test("a word that merely contains 'sol' as a prefix is not frontier", () => {
    eq(tierOf("solstice"), null);
  });

  test("a word that merely contains 'fable' as a prefix is not frontier", () => {
    eq(tierOf("fables"), null);
  });

  /* -------------------------------------------------------------- TIERS */

  test("TIERS exposes the three tier numbers in order", () => {
    eq(TIERS.FRONTIER, 3);
    eq(TIERS.BALANCED, 2);
    eq(TIERS.CHEAP, 1);
  });
});

/**
 * `tierOf` must keep working after every future Codex release, without
 * anyone having to come back and re-pin the version it matches — that is
 * the entire reason it matches on the tier alias word (`sol`/`terra`/`luna`)
 * rather than on any particular `gpt-<version>` prefix. This suite exists
 * specifically to catch a future edit that narrows the pattern back down to
 * today's version.
 */
suite("lib/model-tiers — version independence (never re-pin a Codex version)", ({ test, eq }) => {
  test("a future minor release still resolves to frontier", () => {
    eq(tierOf("gpt-5.7-sol"), TIERS.FRONTIER);
  });

  test("a future major release still resolves to frontier", () => {
    eq(tierOf("gpt-6.0-sol"), TIERS.FRONTIER);
  });

  test("a future release still resolves to balanced", () => {
    eq(tierOf("gpt-5.9-terra"), TIERS.BALANCED);
  });

  test("a future release still resolves to cheap", () => {
    eq(tierOf("gpt-7.1-luna"), TIERS.CHEAP);
  });

  test("display-cased future id still resolves to frontier", () => {
    eq(tierOf("GPT-5.8-Sol"), TIERS.FRONTIER);
  });

  test("a future id with a trailing suffix still resolves to frontier", () => {
    eq(tierOf("gpt-5.7-sol-preview"), TIERS.FRONTIER);
  });

  test("a version-only id with no tier token resolves to null, never assumed", () => {
    eq(tierOf("gpt-5.7"), null);
  });

  test("an unrelated word resolves to null", () => {
    eq(tierOf("console"), null);
  });

  test("a word that merely starts with a tier alias resolves to null", () => {
    eq(tierOf("solstice"), null);
  });
});
