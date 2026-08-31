"use strict";

/**
 * Manifest/disk integrity across `apply.js`, `index.js`, `manifest.js` and
 * `state.js`: the manifest is this installer's own record of what it put on
 * disk, and every case here is the same underlying failure — the record and
 * the disk disagreeing with nobody noticing.
 *
 * - A write that fails partway through a run must never leave an earlier,
 *   genuinely successful write in the same run unrecorded (`apply.js`'s
 *   per-action try/catch and incremental manifest checkpointing).
 * - Two `softela-ai` invocations against the same agent home running at the same
 *   time must not silently lose one side's change (`manifest.js`'s
 *   per-agent lock, held across the whole read-plan-apply-write section in
 *   `index.js`).
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { suite } = require("../harness");
const { runCli, copyRepoSubset, agentHomePath, readManifest, readState, CLI_PATH } = require("./_home");
const { sha256 } = require("../../core/lib/fs-safe");
const apply = require("../../core/installer/apply");
const manifestStore = require("../../core/installer/manifest");

/**
 * Blocks synchronously for a short interval without pinning a CPU core in a
 * spin loop.
 *
 * @param {number} ms How long to block.
 * @returns {void}
 */
function sleepSync(ms) {
  const ia = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(ia, 0, 0, Math.max(1, ms));
}

/**
 * Checks whether a process id still exists, without needing Node's own
 * child-exit event (which requires the event loop to keep turning — not
 * available while a test function blocks synchronously between polls).
 *
 * @param {number} pid The process id to check.
 * @returns {boolean} `true` when the process still exists.
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts `bin/softela-ai` as a detached, non-blocking subprocess against a fake
 * home, for a test that needs two invocations genuinely overlapping at the
 * OS level rather than run one after another.
 *
 * @param {string} home The fake home root.
 * @param {string[]} args CLI arguments.
 * @returns {{pid: number}} The started process's id.
 */
function startCli(home, args) {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    cwd: path.dirname(CLI_PATH),
    env: { ...process.env, SOFTELA_AI_HOME: home },
    stdio: "ignore",
  });
  return { pid: child.pid };
}

/**
 * Blocks until every given process id has exited, or a timeout elapses.
 *
 * @param {number[]} pids The process ids to wait for.
 * @param {number} timeoutMs The maximum time to wait.
 * @returns {void}
 * @throws {Error} When any pid is still alive once `timeoutMs` has elapsed.
 */
function waitForExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(isAlive)) {
    if (Date.now() > deadline) throw new Error(`process(es) still running after ${timeoutMs}ms: ${pids.filter(isAlive).join(", ")}`);
    sleepSync(30);
  }
}

suite("installer/integrity", ({ test, eq, deepEq, ok, throws, fakeHome, tmpdir }) => {
  // --- Finding: a write that fails partway through must not desync the manifest ---

  test("applyPlan never throws on a failed write, and the manifest ends up matching disk exactly — not the plan's intent", () => {
    const home = fakeHome();
    const agentDir = path.join(home, ".claude");
    fs.mkdirSync(agentDir, { recursive: true });

    const sourcesDir = path.join(home, "sources");
    fs.mkdirSync(sourcesDir, { recursive: true });
    const sourceA = path.join(sourcesDir, "a.txt");
    const sourceB = path.join(sourcesDir, "b.txt");
    fs.writeFileSync(sourceA, "new-A-content\n");
    fs.writeFileSync(sourceB, "new-B-content\n");

    const targetA = path.join(agentDir, "softela-ai", "a.txt");
    const targetB = path.join(agentDir, "softela-ai", "b.txt");
    fs.mkdirSync(path.dirname(targetB), { recursive: true });
    fs.writeFileSync(targetB, "old-B-content\n");
    fs.chmodSync(targetB, 0o444); // read-only: the coming write must fail with EPERM on rename

    const priorManifest = {
      version: "1.0.0",
      installedAt: "2026-01-01T00:00:00.000Z",
      agent: "claude",
      files: { "softela-ai/b.txt": sha256("old-B-content\n") },
      settings: [],
      blocks: [],
      modules: [],
    };

    const ctx = {
      agent: "claude",
      home,
      installedRoot: path.join(agentDir, "softela-ai"),
      settingsFile: path.join(agentDir, "settings.json"),
      settings: { content: {}, parseOk: true, existed: false },
      manifest: priorManifest,
      enabledModules: [],
      dispatchNeedle: path.join(agentDir, "softela-ai", "adapters", "claude", "dispatch.js"),
      version: "1.0.1",
      now: Date.now(),
    };

    const plan = [
      { kind: "copy", agent: "claude", target: targetA, source: sourceA, relPath: "softela-ai/a.txt", action: "write", state: "new" },
      { kind: "copy", agent: "claude", target: targetB, source: sourceB, relPath: "softela-ai/b.txt", action: "write", state: "current" },
    ];

    let result;
    try {
      result = apply.applyPlan(plan, ctx);
    } finally {
      fs.chmodSync(targetB, 0o666); // restore so the harness can clean up the fake home afterward
    }

    // The read-only write must be reported as an error, never thrown past
    // applyPlan and never silently swallowed.
    eq(result.report.errors.length, 1);
    ok(result.report.errors[0].includes("b.txt"), `expected the error to name b.txt, got: ${result.report.errors[0]}`);

    // A's write succeeded — bytes on disk and the manifest hash must agree.
    eq(fs.readFileSync(targetA, "utf8"), "new-A-content\n");
    ok(result.report.written.includes("softela-ai/a.txt"));
    eq(result.manifest.files["softela-ai/a.txt"], sha256("new-A-content\n"));

    // B's write failed — bytes on disk are untouched, and the manifest must
    // describe exactly those untouched bytes, not the new ones it tried and
    // failed to write.
    eq(fs.readFileSync(targetB, "utf8"), "old-B-content\n", "a failed write must leave the read-only target's bytes untouched");
    eq(result.manifest.files["softela-ai/b.txt"], sha256("old-B-content\n"), "the manifest must record what is actually on disk");
    eq(result.manifest.files["softela-ai/b.txt"], priorManifest.files["softela-ai/b.txt"], "an unchanged file's recorded hash must be unchanged");

    // The manifest was checkpointed to disk incrementally as each action
    // succeeded — not only by `index.js` after `applyPlan` returns — so the
    // on-disk manifest already matches the final result even though nothing
    // outside `apply.js` ever wrote it in this test.
    const onDisk = manifestStore.readManifest("claude");
    deepEq(onDisk.files, result.manifest.files, "manifest.json must already reflect every successfully-written file, checkpointed incrementally");
  });

  test("[claude] end to end: update crashes on a read-only file but the file it already wrote is not re-flagged as locally modified", () => {
    const home = fakeHome();
    const cloneDir = tmpdir();
    copyRepoSubset(cloneDir);
    const clonedCli = path.join(cloneDir, "bin", "softela-ai");

    const runAt = (args) => {
      const r = require("child_process").spawnSync(process.execPath, [clonedCli, ...args], {
        env: { ...process.env, SOFTELA_AI_HOME: home },
        encoding: "utf8",
        timeout: 30000,
      });
      return { code: r.status === null ? -1 : r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
    };

    eq(runAt(["install", "--agent", "claude", "--yes"]).code, 0);

    // Edit two shipped files in the CLONE only, so the next update has a
    // real change to write for both.
    const engineSrc = path.join(cloneDir, "core", "engine.js");
    fs.writeFileSync(engineSrc, `${fs.readFileSync(engineSrc, "utf8")}\n// probe marker A\n`);
    const guardSrc = path.join(cloneDir, "core", "guards", "subagent-model.js");
    fs.writeFileSync(guardSrc, `${fs.readFileSync(guardSrc, "utf8")}\n// probe marker B\n`);

    const manifestBefore = readManifest(home, "claude");
    const relA = Object.keys(manifestBefore.files).find((p) => p.endsWith("core/engine.js"));
    const relB = Object.keys(manifestBefore.files).find((p) => p.endsWith("core/guards/subagent-model.js"));
    ok(relA && relB, "expected both probe files to already be tracked by the manifest");

    const installedA = path.join(agentHomePath(home, "claude"), relA.split("/").join(path.sep));
    const installedB = path.join(agentHomePath(home, "claude"), relB.split("/").join(path.sep));
    const bBefore = fs.readFileSync(installedB, "utf8");
    fs.chmodSync(installedB, 0o444);

    let updated;
    try {
      updated = runAt(["update", "--agent", "claude", "--yes", "--verbose"]);
    } finally {
      fs.chmodSync(installedB, 0o666);
    }

    eq(updated.code, 1, `expected a reported failure, not a silent crash:\n${updated.stdout}\n${updated.stderr}`);
    // Must fail through the CLI's own error reporting, not an uncaught
    // exception's raw Node stack trace.
    ok(!/\n\s+at\s/.test(updated.stderr), `must not crash with a raw stack trace:\n${updated.stderr}`);

    const aAfter = fs.readFileSync(installedA, "utf8");
    ok(aAfter.includes("probe marker A"), "the writable file's update must still have gone through");
    const manifestAfter = readManifest(home, "claude");
    eq(manifestAfter.files[relA], sha256(aAfter), "the manifest must have learned the writable file's new hash");

    const bAfter = fs.readFileSync(installedB, "utf8");
    eq(bAfter, bBefore, "the read-only file's bytes must be untouched");
    eq(manifestAfter.files[relB], manifestBefore.files[relB], "the read-only file's recorded hash must be unchanged, matching its untouched bytes");

    // A second, unobstructed update must see A as already current — not
    // re-flag it as locally modified because of a stale manifest hash.
    const again = runAt(["update", "--agent", "claude", "--yes", "--verbose"]);
    eq(again.code, 0, `expected the retry to finish cleanly:\n${again.stdout}\n${again.stderr}`);
    ok(!again.stdout.includes(`${relA}.new`), "a correctly-recorded file must never be treated as locally modified");
  });

  // --- Finding: no locking, so a concurrent run silently loses a change ---

  test("acquireLock refuses a second run while the first still holds it", () => {
    const home = fakeHome();
    // Stale threshold generously large so only the wait-timeout path can
    // possibly fire here — an unrelated, much shorter stale threshold is
    // exercised in its own test below, deliberately never overlapped with
    // this one.
    process.env.SOFTELA_AI_LOCK_STALE_MS = "60000";
    process.env.SOFTELA_AI_LOCK_WAIT_MS = "150";
    try {
      const lp1 = manifestStore.acquireLock("claude");
      throws(() => manifestStore.acquireLock("claude"), "a live lock must block a second acquisition, not silently allow it");
      manifestStore.releaseLock(lp1);

      const lp2 = manifestStore.acquireLock("claude"); // free again once released
      manifestStore.releaseLock(lp2);
    } finally {
      delete process.env.SOFTELA_AI_LOCK_WAIT_MS;
      delete process.env.SOFTELA_AI_LOCK_STALE_MS;
    }
  });

  test("acquireLock reclaims a lock that has sat untouched past the stale threshold, as a crashed run's would", () => {
    const home = fakeHome();
    process.env.SOFTELA_AI_LOCK_STALE_MS = "20";
    process.env.SOFTELA_AI_LOCK_WAIT_MS = "5000";
    try {
      const lp1 = manifestStore.acquireLock("claude"); // never released — simulates a run that crashed mid-section
      sleepSync(80); // comfortably past the 20ms stale threshold
      const lp2 = manifestStore.acquireLock("claude"); // must reclaim, not hang until the 5s wait timeout
      eq(lp2, lp1);
      manifestStore.releaseLock(lp2);
    } finally {
      delete process.env.SOFTELA_AI_LOCK_WAIT_MS;
      delete process.env.SOFTELA_AI_LOCK_STALE_MS;
    }
  });

  test("withLock releases the lock even when the critical section throws", () => {
    const home = fakeHome();
    throws(() => manifestStore.withLock("claude", () => {
      throw new Error("boom");
    }));
    const lp = manifestStore.acquireLock("claude"); // must not still be held
    manifestStore.releaseLock(lp);
  });

  test("[claude] two concurrent `module` invocations against the same home both take effect, instead of one silently losing its change", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);

    const before = readState(home, "claude");
    ok(before.modules.includes("memory-as-context"), "expected the default install to enable memory-as-context");
    ok(!before.modules.includes("session-cleanup"), "expected session-cleanup to start disabled");

    const c1 = startCli(home, ["module", "disable", "memory-as-context", "--agent", "claude", "--yes"]);
    const c2 = startCli(home, ["module", "enable", "session-cleanup", "--agent", "claude", "--yes"]);
    waitForExit([c1.pid, c2.pid], 20000);

    const stateAfter = readState(home, "claude");
    ok(!stateAfter.modules.includes("memory-as-context"), "the disable must have taken effect");
    ok(stateAfter.modules.includes("session-cleanup"), "the enable must have taken effect too — neither run may silently lose the other's change");

    const manifestAfter = readManifest(home, "claude");
    deepEq(new Set(manifestAfter.modules), new Set(stateAfter.modules), "the manifest's own module list must agree with state.json");

    const cleanSessionsRel = Object.keys(manifestAfter.files).find((p) => p.endsWith("hooks/clean-sessions.js"));
    ok(cleanSessionsRel, "session-cleanup's file must be tracked by the manifest, not left an orphan on disk");
    const installedPath = path.join(agentHomePath(home, "claude"), cleanSessionsRel.split("/").join(path.sep));
    ok(fs.existsSync(installedPath), "session-cleanup's file must actually be on disk");
  });
});
