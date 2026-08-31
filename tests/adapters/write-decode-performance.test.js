"use strict";

/**
 * D2 regression: a large, multi-file `apply_patch` must decode and evaluate
 * well inside the `PreToolUse` hook timeout both hosts are registered with
 * silently — a hook that runs past it is treated as having enforced
 * nothing, exactly the failure `core/lib/write-decode.js` exists to end.
 *
 * Two independent causes made this slow before the fix:
 * - `findSubsequence`'s naive per-line comparison loop, O(file lines × hunk
 *   lines) in the worst case;
 * - `classifyChange` spawning one `git ls-files --error-unmatch` subprocess
 *   per file, roughly N synchronous git spawns in series for an N-file
 *   patch, at about 40ms each.
 *
 * This suite builds a real git repository with many tracked files and a
 * single `apply_patch` updating every one of them, then times the exact
 * path a real dispatch call runs: `evaluateDecodedWrites` against the real
 * `classifyChange`, forced to run via an injected `newCodeOnly` rule so the
 * git-spawn elimination is genuinely exercised, not only the hunk-matching
 * fix.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { suite } = require("../harness");
const { buildContext } = require("../../core/lib/context");
const { evaluateDecodedWrites } = require("../../adapters/shared/dispatch-core");
const { ask, pass } = require("../../core/lib/decision");

/** How many files the large patch touches. */
const FILE_COUNT = 150;

/** How many lines each of those files carries before the patch. */
const LINES_PER_FILE = 150;

/**
 * The wall-clock ceiling this suite enforces. Real measurements on a plain
 * developer machine land around 100-150ms after the fix, and around 7
 * SECONDS before it for the same input on the same machine — so this number
 * is a tripwire for a regression three orders of magnitude wide, not a
 * latency budget to tune against.
 *
 * Raised from 1 second because this suite runs inside a PARALLEL test
 * runner, and a wall-clock assertion has to survive the contention that
 * creates: the same measurement that takes ~150ms idle was observed at
 * 1415ms with the rest of the suite running beside it — the identical
 * effect measured on the hooks themselves, where a ~330ms dispatch takes
 * 2.8s under load (see `core/installer/plan.js#HOOK_TIMEOUT_SECONDS`).
 * Three seconds clears that with margin while still failing loudly on
 * anything resembling the seven-second original.
 */
const MAX_ELAPSED_MS = 3000;

/**
 * Runs a git command, tolerating CRLF-vs-LF warnings on stdout/stderr —
 * this suite only cares about the working tree state git ends up in.
 *
 * @param {string} cwd The repository to run git in.
 * @param {string[]} args The git arguments, after the identity flags.
 * @returns {void}
 */
function git(cwd, args) {
  execFileSync(
    "git",
    ["-c", "user.email=perf-test@example.invalid", "-c", "user.name=perf-test", "-c", "core.autocrlf=false", ...args],
    { cwd, stdio: ["ignore", "ignore", "ignore"] },
  );
}

/**
 * Builds a real git repository containing `FILE_COUNT` tracked TypeScript
 * files, each carrying a single line this test's own patch will target.
 *
 * @param {string} repo The (already created) directory to initialise.
 * @returns {Array<{rel: string, index: number}>} Each seeded file's
 * repository-relative path and its own index, in creation order.
 */
function seedRepo(repo) {
  git(repo, ["init", "-q"]);

  const files = [];
  for (let i = 0; i < FILE_COUNT; i += 1) {
    const rel = `src/generated/ProbeFile${i}.ts`;
    const lines = [];
    for (let l = 0; l < LINES_PER_FILE; l += 1) lines.push(`export const line${i}_${l} = ${l};`);
    lines[LINES_PER_FILE - 3] = `export const TARGET_${i} = "old";`;
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `${lines.join("\n")}\n`, "utf8");
    files.push({ rel, index: i });
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "seed"]);
  return files;
}

/**
 * Builds a single `apply_patch` envelope updating every seeded file's own
 * target line, with real matching context on both sides of the hunk.
 *
 * @param {Array<{rel: string, index: number}>} files The seeded files.
 * @returns {string} The full patch text.
 */
function buildBigPatch(files) {
  const sections = files.map(
    (f) =>
      [
        `*** Update File: ${f.rel}`,
        ` export const line${f.index}_${LINES_PER_FILE - 4} = ${LINES_PER_FILE - 4};`,
        `-export const TARGET_${f.index} = "old";`,
        `+export const TARGET_${f.index} = "new";`,
        ` export const line${f.index}_${LINES_PER_FILE - 2} = ${LINES_PER_FILE - 2};`,
      ].join("\n"),
  );
  return ["*** Begin Patch", ...sections, "*** End Patch"].join("\n");
}

/**
 * A minimal `newCodeOnly` rule that matches every `.ts` file, so evaluating
 * it forces the engine's `classifyChange` path for every decoded write —
 * the exact mechanism the git-spawn count regression lived in.
 */
const FORCE_CHANGE_SCOPE_RULE = {
  id: "probe-force-change-scope",
  title: "test-only: force the newCodeOnly classifyChange path",
  events: ["PreToolUse"],
  tools: null,
  defaultAction: "ask",
  group: "code",
  newCodeOnly: true,
  requiresConfig: [],
  evaluate(ctx) {
    return ctx.filePath.endsWith(".ts") ? ask("probe") : pass();
  },
};

/**
 * R4: how many already-large tracked files the budget test writes to disk.
 * Deliberately far fewer than the task's own 200-file reproduction (kept
 * that way as a standalone, non-persisted probe) — enough combined bytes to
 * make a hunk-bytes-only budget's failure mode obvious (reading, splitting
 * and searching every one of them) while keeping this suite fast.
 */
const R4_FILE_COUNT = 30;

/** R4: how large each of those tracked files is, before its own tiny diff. */
const R4_FILE_BYTES = 2 * 1024 * 1024;

/** R4: one filler line reused to build each large tracked file's bulk. */
const R4_FILLER_LINE = "export const filler = 1;\n";

/**
 * Builds one R4 fixture file's content: filler on both sides of a single
 * unique target line the patch's own hunk will locate and update — the
 * shape of a tiny, real diff against an already-large tracked file.
 *
 * @param {number} index This file's own index, folded into its target line
 * so every file's hunk anchors on a name unique to it.
 * @returns {string} The file's full content, roughly `R4_FILE_BYTES` long.
 */
function buildR4FileContent(index) {
  const target = `export const TARGET_${index} = "old";\n`;
  const beforeBytes = Math.floor(R4_FILE_BYTES / 2);
  const beforeCount = Math.floor(beforeBytes / R4_FILLER_LINE.length);
  const afterCount = Math.floor((R4_FILE_BYTES - beforeBytes) / R4_FILLER_LINE.length);
  return R4_FILLER_LINE.repeat(beforeCount) + target + R4_FILLER_LINE.repeat(afterCount);
}

/**
 * Builds a single `apply_patch` envelope carrying one tiny single-line
 * update per R4 fixture file.
 *
 * @param {string[]} relPaths Each fixture file's repository-relative path,
 * in index order.
 * @returns {string} The full patch text.
 */
function buildR4Patch(relPaths) {
  const sections = relPaths.map((rel, i) =>
    [
      `*** Update File: ${rel}`,
      ` ${R4_FILLER_LINE.trimEnd()}`,
      `-export const TARGET_${i} = "old";`,
      `+export const TARGET_${i} = "new";`,
      ` ${R4_FILLER_LINE.trimEnd()}`,
    ].join("\n"),
  );
  return ["*** Begin Patch", ...sections, "*** End Patch"].join("\n");
}

suite("adapters/write-decode-performance", ({ test, eq, ok, tmpdir }) => {
  test("R4: a tiny diff against many already-large tracked files decodes well inside budget, budgeted on real bytes read — not the diff's own tiny size", () => {
    // MAX_RECONSTRUCT_BYTES is documented as protection against very large
    // files, but before the fix the budget was computed from the hunk's own
    // added/removed line text (a couple of bytes per file here), never from
    // the size of the file `readFile` actually loads, splits and searches —
    // so all R4_FILE_COUNT files sailed under the ceiling while doing full
    // reconstruction work proportional to R4_FILE_COUNT * R4_FILE_BYTES.
    // With the budget instead charged on the real bytes read, the very
    // first ~2MB file already exhausts the 2,000,000-byte ceiling, so every
    // later file's own `readFile` is skipped entirely.
    const repo = tmpdir();
    const relPaths = [];
    for (let i = 0; i < R4_FILE_COUNT; i += 1) {
      const rel = `src/generated/BigProbeFile${i}.ts`;
      const abs = path.join(repo, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buildR4FileContent(i), "utf8");
      relPaths.push(rel);
    }
    const patch = buildR4Patch(relPaths);

    const ctx = buildContext(
      { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { input: patch }, cwd: repo },
      { agent: "codex", modules: [] },
    );

    const start = process.hrtime.bigint();
    // No rules at all: this isolates decode+reconstruction's own cost from
    // `classifyChange`'s git shell-outs, already covered by D2 below.
    const result = evaluateDecodedWrites(ctx, { rules: [] });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    eq(result.handled, true);
    ok(
      elapsedMs < MAX_ELAPSED_MS,
      `expected decode to finish in under ${MAX_ELAPSED_MS}ms, took ${elapsedMs.toFixed(1)}ms`,
    );
  });

  test("D2: a large multi-file apply_patch decodes and evaluates well inside the hook budget", () => {
    const repo = tmpdir();
    const files = seedRepo(repo);
    const patch = buildBigPatch(files);

    const ctx = buildContext(
      { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { input: patch }, cwd: repo },
      { agent: "claude", modules: [] },
    );

    const start = process.hrtime.bigint();
    const result = evaluateDecodedWrites(ctx, { rules: [FORCE_CHANGE_SCOPE_RULE] });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    eq(result.handled, true);
    ok(result.decision && result.decision.action === "ask", "every file is tracked ('existing'), so the ask stands");
    ok(
      elapsedMs < MAX_ELAPSED_MS,
      `expected decode+evaluate to finish in under ${MAX_ELAPSED_MS}ms, took ${elapsedMs.toFixed(1)}ms`,
    );
  });
});
