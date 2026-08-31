"use strict";

/**
 * CONTRACTS §7 requires the installer itself — not only `softela-ai doctor` — to
 * tell a developer that Codex hooks are installed but inert until the
 * one-time hook-trust review. Before this was fixed, only `doctor` ever
 * said this; grepping install/update output in every render mode found no
 * mention of trust, review, or "one-time" at all.
 */

const { suite } = require("../harness");
const { runCli, seedForeign } = require("./_home");
const doctor = require("../../core/installer/doctor");

suite("installer/codex-trust-notice", ({ test, eq, ok, fakeHome }) => {
  test("[codex] install states the hook-trust caveat once, in plain text output", () => {
    const home = fakeHome();
    seedForeign(home, "codex");
    const installed = runCli(home, ["install", "--agent", "codex", "--yes"]);
    eq(installed.code, 0, `install stdout:\n${installed.stdout}\n${installed.stderr}`);
    ok(
      installed.stdout.includes(doctor.CODEX_TRUST_CAVEAT),
      "install must state the exact same caveat doctor composes, so the two can never drift apart",
    );
  });

  test("[codex] install states the same caveat in --json output too", () => {
    const home = fakeHome();
    seedForeign(home, "codex");
    const installed = runCli(home, ["install", "--agent", "codex", "--yes", "--json"]);
    eq(installed.code, 0, `install stdout:\n${installed.stdout}\n${installed.stderr}`);
    const out = JSON.parse(installed.stdout);
    eq(out.agents[0].codexTrustCaveat, doctor.CODEX_TRUST_CAVEAT);
  });

  test("[codex] an update with nothing to register states no caveat, since no hook was actually written", () => {
    const home = fakeHome();
    seedForeign(home, "codex");
    eq(runCli(home, ["install", "--agent", "codex", "--yes"]).code, 0);

    const updated = runCli(home, ["update", "--agent", "codex", "--yes", "--json"]);
    eq(updated.code, 2, "a second run with nothing changed reports nothing to do");
    const out = JSON.parse(updated.stdout);
    eq(out.agents[0].codexTrustCaveat, null);
  });

  test("[claude] install never mentions the Codex trust caveat", () => {
    const home = fakeHome();
    seedForeign(home, "claude");
    const installed = runCli(home, ["install", "--agent", "claude", "--yes"]);
    eq(installed.code, 0, `install stdout:\n${installed.stdout}\n${installed.stderr}`);
    ok(!installed.stdout.toLowerCase().includes("hook-trust"), "Claude Code has no such review step, so nothing should claim it does");
  });
});
