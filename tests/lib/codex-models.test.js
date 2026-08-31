"use strict";

/**
 * `core/lib/codex-models.js` — resolves a cost tier into the concrete
 * versioned Codex model id to seed, since Codex (unlike Claude Code) has no
 * bare tier alias. Every scenario here is driven through the public
 * `resolveModelForTier` API with its test-only injection seams
 * (`codexBin`, `locate`, `now`) rather than by mocking the real machine's
 * `PATH` or npm install, so the suite is deterministic on any machine,
 * with or without Codex actually installed.
 */

const fs = require("fs");
const path = require("path");
const { suite } = require("../harness");
const { TIER_ALIASES, FALLBACK_MODEL_IDS, resolveModelForTier, parseModelIdsFromText, pickHighestPerTier } = require("../../core/lib/codex-models");

suite("lib/codex-models", ({ test, eq, ok, throws, tmpdir }) => {
  /* --------------------------------------------------- pure parsing */

  test("parseModelIdsFromText extracts every gpt-<major>.<minor>-<tier> id, case-insensitively", () => {
    const matches = parseModelIdsFromText("noise GPT-5.8-Sol more gpt-5.6-terra and gpt-5.6-luna end");
    eq(matches.length, 3);
    eq(matches[0].id, "gpt-5.8-sol");
    eq(matches[1].id, "gpt-5.6-terra");
    eq(matches[2].id, "gpt-5.6-luna");
  });

  test("pickHighestPerTier compares major and minor numerically, never lexically — 5.10 outranks 5.9", () => {
    const best = pickHighestPerTier(parseModelIdsFromText("gpt-5.9-sol gpt-5.10-sol gpt-5.2-sol"));
    eq(best.sol.id, "gpt-5.10-sol");
  });

  test("pickHighestPerTier tracks each tier independently", () => {
    const best = pickHighestPerTier(parseModelIdsFromText("gpt-5.6-sol gpt-6.0-terra gpt-7.1-luna"));
    eq(best.sol.id, "gpt-5.6-sol");
    eq(best.terra.id, "gpt-6.0-terra");
    eq(best.luna.id, "gpt-7.1-luna");
  });

  /* --------------------------------------------- resolution: binary */

  test("resolves the highest binary-embedded id for the requested tier — version ordering", () => {
    const binPath = path.join(tmpdir(), "codex.exe");
    fs.writeFileSync(binPath, "noise gpt-5.9-sol noise gpt-5.10-sol noise gpt-5.2-luna", "utf8");
    const result = resolveModelForTier("frontier", { codexBin: binPath, minBinaryBytes: 1 });
    eq(result.id, "gpt-5.10-sol");
    eq(result.source, "binary");
    eq(result.reason, "");
  });

  test("tier selection: the same binary resolves a different id per tier", () => {
    const binPath = path.join(tmpdir(), "codex.exe");
    fs.writeFileSync(binPath, "gpt-5.6-sol gpt-5.6-terra gpt-5.6-luna", "utf8");
    eq(resolveModelForTier("frontier", { codexBin: binPath, minBinaryBytes: 1 }).id, "gpt-5.6-sol");
    eq(resolveModelForTier("balanced", { codexBin: binPath, minBinaryBytes: 1 }).id, "gpt-5.6-terra");
    eq(resolveModelForTier("cheap", { codexBin: binPath, minBinaryBytes: 1 }).id, "gpt-5.6-luna");
  });

  /* -------------------------------------------- resolution: fallback */

  test("falls back to the shipped default when no binary can be located, and says why", () => {
    const result = resolveModelForTier("frontier", { locate: () => null });
    eq(result.id, FALLBACK_MODEL_IDS.frontier);
    eq(result.source, "fallback");
    ok(typeof result.reason === "string" && result.reason.length > 0, "a fallback must always report why, never silently");
  });

  test("falls back when the binary path cannot be read", () => {
    const missing = path.join(tmpdir(), "does-not-exist.exe");
    const result = resolveModelForTier("cheap", { codexBin: missing });
    eq(result.id, FALLBACK_MODEL_IDS.cheap);
    eq(result.source, "fallback");
    ok(result.reason.includes("could not be read"), result.reason);
  });

  test("falls back when the binary is too small to be plausible", () => {
    const binPath = path.join(tmpdir(), "codex.exe");
    fs.writeFileSync(binPath, "tiny", "utf8"); // far below the default size sanity floor
    const result = resolveModelForTier("balanced", { codexBin: binPath });
    eq(result.source, "fallback");
    ok(result.reason.includes("smaller than expected"), result.reason);
  });

  test("falls back when the resolution budget is already exhausted", () => {
    let calls = 0;
    const now = () => (calls++ === 0 ? 0 : 999999);
    const result = resolveModelForTier("frontier", { codexBin: "does-not-matter-budget-check-fires-first", now, timeoutMs: 5 });
    eq(result.source, "fallback");
    ok(result.reason.includes("took too long"), result.reason);
  });

  /* --------------------------------------------------------- misc */

  test("throws for a tier name this module does not recognise", () => {
    throws(() => resolveModelForTier("legendary"));
  });

  test("TIER_ALIASES names exactly the tiers this repository's seed settings use", () => {
    eq(Object.keys(TIER_ALIASES).sort().join(","), "balanced,cheap,frontier");
  });

  test("FALLBACK_MODEL_IDS carries exactly one id per tier", () => {
    eq(Object.keys(FALLBACK_MODEL_IDS).sort().join(","), "balanced,cheap,frontier");
  });
});
