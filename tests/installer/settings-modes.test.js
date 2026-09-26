"use strict";

/**
 * `enforce` versus `seed` (CONTRACTS §9, INSTALLER.md §5): hook
 * registrations and shipped permission entries are rewritten on every
 * update; everything that is a developer preference is written only when
 * the key is absent, so a developer running a stronger model is never
 * quietly downgraded.
 */

const path = require("path");
const { suite } = require("../harness");
const { runCli, seedForeign, agentHomePath, readSettingsJson, readText, findHookEntries } = require("./_home");
const { writeJsonAtomic: writeJson } = require("../../core/lib/fs-safe");

suite("installer/settings-modes", ({ test, eq, deepEq, ok, fakeHome }) => {
  test("[claude] a seed setting already present before install is never overwritten by the shipped default", () => {
    const home = fakeHome();
    seedForeign(home, "claude"); // sets model: "opus-4-custom"
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);
    eq(readSettingsJson(home, "claude").model, "opus-4-custom");

    eq(runCli(home, ["update", "--agent", "claude", "--yes"]).code, 2);
    eq(readSettingsJson(home, "claude").model, "opus-4-custom", "an update must never downgrade a developer's own stronger model");
  });

  test("[claude] a seed setting absent before install is seeded with the shipped default", () => {
    const home = fakeHome();
    const foreign = seedForeign(home, "claude");
    const before = JSON.parse(readText(foreign.settingsPath));
    delete before.model;
    writeJson(foreign.settingsPath, before);

    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);
    eq(readSettingsJson(home, "claude").model, "opus", "the shipped default seeds in only when nothing was there before");
  });

  test("[claude] the enforce dispatcher registration is rewritten on update even after being tampered with", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    const settingsPath = path.join(agentHomePath(home, "claude"), "settings.json");
    const settings = JSON.parse(readText(settingsPath));
    const dispatchNeedle = path.join("adapters", "claude", "dispatch.js");
    const entries = findHookEntries(settings, dispatchNeedle);
    ok(entries.length >= 1);
    const { event, index } = entries[0];
    // Tamper with the entry's matcher while leaving the command (and
    // therefore ownership) intact, simulating a developer who edited it by
    // hand.
    settings.hooks[event][index].matcher = "TamperedMatcher";
    writeJson(settingsPath, settings);

    const updated = runCli(home, ["update", "--agent", "claude", "--yes"]);
    eq(updated.code, 0, `update stdout:\n${updated.stdout}\n${updated.stderr}`);

    const after = JSON.parse(readText(settingsPath));
    const stillFound = findHookEntries(after, dispatchNeedle);
    ok(stillFound.length >= 1);
    ok(after.hooks[stillFound[0].event][stillFound[0].index].matcher !== "TamperedMatcher", "enforce keys must be rewritten to the shipped fragment on update, unlike a seed setting");
  });

  test("[codex] a seed key already present in config.toml is never overwritten", () => {
    const home = fakeHome();
    const foreign = seedForeign(home, "codex"); // sets model = "gpt-6-titan", model_reasoning_effort = "low"
    eq(runCli(home, ["install", "--agent", "codex", "--yes"]).code, 0);

    const configAfter = readText(foreign.configPath);
    ok(configAfter.includes('model = "gpt-6-titan"'), configAfter);
    ok(configAfter.includes('model_reasoning_effort = "low"'), configAfter);
    ok(
      !configAfter.includes("gpt-5.6-sol"),
      "the shipped seed value must not appear when the developer's own value is already present",
    );
  });

  test("[codex] hooks.json's own top-level description is a seed value too — present, it is left alone", () => {
    const home = fakeHome();
    const foreign = seedForeign(home, "codex");
    const before = JSON.parse(readText(foreign.settingsPath));
    before.description = "my own custom description";
    writeJson(foreign.settingsPath, before);

    eq(runCli(home, ["install", "--agent", "codex", "--yes"]).code, 0);
    eq(
      readSettingsJson(home, "codex").description,
      "my own custom description",
      "a scalar metadata field is licensed only as seed (CONTRACTS §9) — it must never be overwritten, unlike a hook registration",
    );
  });

  test("[codex] hooks.json's own description is seeded with the shipped default when absent", () => {
    const home = fakeHome();
    const foreign = seedForeign(home, "codex");
    const before = JSON.parse(readText(foreign.settingsPath));
    delete before.description;
    writeJson(foreign.settingsPath, before);

    eq(runCli(home, ["install", "--agent", "codex", "--yes"]).code, 0);
    const after = readSettingsJson(home, "codex");
    ok(typeof after.description === "string" && after.description.length > 0, "an absent description must be seeded, not left missing");
  });

  test("[claude] attribution is absent before install and is seeded off (git-flow.md / softela-git-flow.md: no AI-attribution trailer)", () => {
    const home = fakeHome();
    const foreign = seedForeign(home, "claude");
    const before = JSON.parse(readText(foreign.settingsPath));
    ok(!("attribution" in before), "the fixture must start without an attribution key for this to test anything");

    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);
    deepEq(readSettingsJson(home, "claude").attribution, { commitTrailers: false, pr: "", sessionUrl: false });
  });

  test("[claude] a developer's own attribution value is never overwritten by the shipped default", () => {
    const home = fakeHome();
    const foreign = seedForeign(home, "claude");
    const before = JSON.parse(readText(foreign.settingsPath));
    before.attribution = { commitTrailers: true };
    writeJson(foreign.settingsPath, before);

    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);
    deepEq(
      readSettingsJson(home, "claude").attribution,
      { commitTrailers: true },
      "a developer who deliberately kept attribution on must keep it — seed mode never overwrites a present key",
    );

    eq(runCli(home, ["update", "--agent", "claude", "--yes"]).code, 2);
    deepEq(readSettingsJson(home, "claude").attribution, { commitTrailers: true }, "an update must not downgrade this either");
  });

  test("[codex] nothing is written for attribution — Codex adds no such trailer, so there is no host switch to seed", () => {
    const home = fakeHome();
    const foreign = seedForeign(home, "codex");

    eq(runCli(home, ["install", "--agent", "codex", "--yes"]).code, 0);
    ok(!("attribution" in readSettingsJson(home, "codex")), "hooks.json must not gain an attribution key on Codex");
    ok(!readText(foreign.configPath).includes("attribution"), "config.toml must not gain an attribution key on Codex");
  });

  test("[codex] seed keys absent in config.toml are added, preserving comments and key order", () => {
    const home = fakeHome();
    const foreign = seedForeign(home, "codex");
    eq(runCli(home, ["install", "--agent", "codex", "--yes"]).code, 0);

    const configAfter = readText(foreign.configPath);
    ok(configAfter.includes("# personal config, hand maintained"), "hand-written comments must survive verbatim");
    ok(configAfter.includes('model_provider = "custom-provider"'));
    ok(configAfter.includes('approval_policy = "on-request"'), "an absent seed key must be added");
    ok(configAfter.includes("[sandbox]"));
    const modelProviderIdx = configAfter.indexOf('model_provider = "custom-provider"');
    const sandboxIdx = configAfter.indexOf("[sandbox]");
    ok(modelProviderIdx > -1 && modelProviderIdx < sandboxIdx, "pre-existing key order must not be disturbed");
  });
});
