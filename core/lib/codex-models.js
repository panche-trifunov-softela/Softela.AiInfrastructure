"use strict";

/**
 * Resolves a Codex model tier (`frontier` / `balanced` / `cheap` — the same
 * names `core/lib/model-tiers.js#TIERS` uses) into the concrete versioned
 * model id Codex itself understands.
 *
 * Unlike Claude Code, where `/model = "opus"` resolves on its own, Codex has
 * no bare tier alias: the only ids it knows are fully versioned
 * (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, and their display-cased
 * forms). A module that wants to seed a tier rather than a version-pinned id
 * therefore needs this module to turn the tier into a real id before it is
 * ever written to `config.toml`.
 *
 * Full resolution order (INSTALLER's seed mechanism supplies the first step;
 * {@link resolveModelForTier} implements the second and third):
 * 1. The developer's own value wins — `mode: "seed"` already means "write
 *    only when the pointer is absent" (`settings-toml.js#planSeedKey`), so a
 *    pointer the developer has already set never reaches this module at all.
 * 2. Scan the installed Codex binary for every `gpt-<major>.<minor>-<tier>`
 *    id it embeds, and pick the highest version carrying the requested tier.
 * 3. Fall back to {@link FALLBACK_MODEL_IDS}, one named constant per tier.
 *
 * Every failure along the way — the binary cannot be found, read, or scanned
 * in time — degrades to the fallback; this module never throws for an
 * environment problem, only for a tier name it does not recognise. It also
 * never runs unbounded: every subprocess call carries a timeout, the binary
 * is size-checked before it is read into memory, and a caller-supplied clock
 * lets a wall-clock budget be enforced (and, for tests, simulated) without an
 * actual wait.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

/** Codex's alias suffix for each tier name this repository's seed settings and guards use. */
const TIER_ALIASES = Object.freeze({ frontier: "sol", balanced: "terra", cheap: "luna" });

/**
 * The fallback model id shipped for each tier, used only when the installed
 * Codex binary cannot be located, read, or scanned in time. This is the one
 * place a version is pinned by hand in this whole path — bump it when the
 * shipped fallback itself needs to move forward; every other resolution step
 * follows whatever is actually installed.
 */
const FALLBACK_MODEL_IDS = Object.freeze({
  frontier: "gpt-5.6-sol",
  balanced: "gpt-5.6-terra",
  cheap: "gpt-5.6-luna",
});

/** Every subprocess call (`where`/`which`, `npm root -g`) is bounded by this, in milliseconds, unless a caller overrides it. */
const DEFAULT_TIMEOUT_MS = 5000;

/** A file larger than this is refused rather than read into memory — a sanity check against scanning the wrong, enormous file. */
const DEFAULT_MAX_BINARY_BYTES = 2 * 1024 * 1024 * 1024;

/** A file smaller than this cannot plausibly be Codex's native binary (a real one is on the order of hundreds of MB); it is more likely an npm shim script, so it is treated as unreadable rather than scanned. */
const DEFAULT_MIN_BINARY_BYTES = 5 * 1024 * 1024;

/** How deep {@link findVendorBinaryUnder} will descend below the npm package root while looking for the platform-specific vendor binary. */
const MAX_SEARCH_DEPTH = 10;

/** How many directory entries {@link findVendorBinaryUnder} will visit in total before giving up, independent of depth — a bound against an unexpectedly wide tree. */
const MAX_SEARCH_ENTRIES = 20000;

/** The last successful binary scan, so two calls in the same process (one per tier) against the same file read and parse it only once. `null` until the first scan completes. */
let scanCache = null;

/**
 * Runs a short-lived command with a timeout, swallowing every failure — a
 * missing command, a non-zero exit, or the timeout itself all read the same
 * way to a caller that only wants "did this produce usable output".
 *
 * @param {string} command The executable to run.
 * @param {string[]} args Its arguments.
 * @param {number} timeoutMs The timeout, in milliseconds.
 * @returns {string | null} The trimmed stdout, or `null` on any failure.
 */
function runQuiet(command, args, timeoutMs) {
  try {
    const out = execFileSync(command, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
    const trimmed = out.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

/**
 * Resolves the directory `npm`'s own global `node_modules` lives in.
 *
 * @param {number} timeoutMs The subprocess timeout.
 * @returns {string | null} The path `npm root -g` reports, or `null` when
 * `npm` is not on `PATH` or the call fails for any other reason.
 */
function npmGlobalNodeModules(timeoutMs) {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  return runQuiet(npmCmd, ["root", "-g"], timeoutMs);
}

/**
 * Resolves where `codex` itself sits on `PATH`.
 *
 * @param {number} timeoutMs The subprocess timeout.
 * @returns {string | null} The first path the host's `where`/`which`
 * reports, or `null` when `codex` is not on `PATH` or the call fails.
 */
function whichCodex(timeoutMs) {
  const finder = process.platform === "win32" ? "where" : "which";
  const out = runQuiet(finder, ["codex"], timeoutMs);
  if (!out) return null;
  const first = out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return first || null;
}

/**
 * Searches a directory tree, breadth-first and depth- and count-bounded, for
 * a file that plausibly is Codex's native binary: named `codex` or
 * `codex.exe` (case-insensitively) and at least {@link DEFAULT_MIN_BINARY_BYTES}
 * large, which rules out the small JS launcher scripts npm packages often
 * also name `codex`.
 *
 * @param {string} rootDir The directory to search under (typically the
 * `@openai/codex` npm package root, or one of its ancestors).
 * @param {number} minBytes The minimum size a match must have.
 * @returns {string | null} The first matching file's absolute path, or
 * `null` when the root does not exist or nothing plausible was found within
 * the depth/entry bounds.
 */
function findVendorBinaryUnder(rootDir, minBytes) {
  let rootStat;
  try {
    rootStat = fs.statSync(rootDir);
  } catch {
    return null;
  }
  if (!rootStat.isDirectory()) return null;

  const queue = [{ dir: rootDir, depth: 0 }];
  let visited = 0;

  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visited > MAX_SEARCH_ENTRIES) return null;
      const abs = path.join(dir, entry.name);
      if (entry.isFile() && /^codex(\.exe)?$/i.test(entry.name)) {
        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch {
          continue;
        }
        if (size >= minBytes) return abs;
      } else if (entry.isDirectory() && depth < MAX_SEARCH_DEPTH) {
        queue.push({ dir: abs, depth: depth + 1 });
      }
    }
  }
  return null;
}

/**
 * Default discovery of the installed Codex binary's path, without reading
 * or scanning it: resolves `codex` on `PATH` and `npm`'s own global root,
 * then searches under each candidate npm package layout for the
 * platform-specific vendor binary (`<pkg>/node_modules/@openai/codex-<platform>-<arch>/vendor/.../bin/codex(.exe)`
 * on a real install — the exact vendor subdirectory name is not hard-coded,
 * since guessing the target-triple naming wrongly would silently defeat
 * discovery on a platform this was not tested against).
 *
 * @param {{timeoutMs: number, minBinaryBytes: number}} options Resolved
 * options (already defaulted by the caller).
 * @returns {string | null} The discovered binary's path, or `null` when
 * neither `codex` nor `npm` could be resolved, or no plausible binary was
 * found under either candidate.
 */
function defaultLocateCodexBinary(options) {
  const candidates = [];

  const shim = whichCodex(options.timeoutMs);
  if (shim) candidates.push(path.join(path.dirname(shim), "node_modules", "@openai", "codex"));

  const npmRoot = npmGlobalNodeModules(options.timeoutMs);
  if (npmRoot) candidates.push(path.join(npmRoot, "@openai", "codex"));

  for (const candidate of candidates) {
    const found = findVendorBinaryUnder(candidate, options.minBinaryBytes);
    if (found) return found;
  }
  return null;
}

/**
 * Extracts every `gpt-<major>.<minor>-<tier>` id embedded in arbitrary text.
 * Intended for a binary's raw bytes decoded as `latin1`, which maps every
 * byte value to the same-numbered code unit — so an embedded ASCII string
 * like `gpt-5.6-sol` survives unchanged regardless of what surrounds it,
 * without needing to know the binary's actual encoding.
 *
 * @param {string} text The text to scan.
 * @returns {{major: number, minor: number, tierAlias: string, id: string}[]}
 * One entry per match, in the order found. `id` is rebuilt from the parsed
 * numbers and a lowercased tier alias rather than the raw matched substring,
 * so a differently-cased match (`GPT-5.8-Sol`) still yields a canonical id.
 */
function parseModelIdsFromText(text) {
  const pattern = /gpt-(\d+)\.(\d+)-(sol|terra|luna)/gi;
  const out = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const tierAlias = match[3].toLowerCase();
    out.push({ major, minor, tierAlias, id: `gpt-${major}.${minor}-${tierAlias}` });
  }
  return out;
}

/**
 * Reduces a list of parsed model-id matches to the highest version found for
 * each tier alias, comparing `major` then `minor` numerically — never as
 * strings, since a lexical compare ranks `"5.10"` below `"5.9"`.
 *
 * @param {{major: number, minor: number, tierAlias: string, id: string}[]} matches
 * As returned by {@link parseModelIdsFromText}.
 * @returns {Record<string, {major: number, minor: number, id: string}>} One
 * entry per tier alias that had at least one match.
 */
function pickHighestPerTier(matches) {
  const best = {};
  for (const m of matches) {
    const current = best[m.tierAlias];
    if (!current || m.major > current.major || (m.major === current.major && m.minor > current.minor)) {
      best[m.tierAlias] = { major: m.major, minor: m.minor, id: m.id };
    }
  }
  return best;
}

/**
 * Scans one binary file for the highest id per tier, using {@link scanCache}
 * so a second call against the same path within the same process reads and
 * parses the file only once.
 *
 * @param {string} binPath The binary's path.
 * @param {number} maxBytes The size sanity limit; a larger file is refused.
 * @param {number} minBytes The minimum plausible size; a smaller file is
 * refused as "not really the binary".
 * @returns {{bestByTier: Record<string, {major: number, minor: number, id: string}>} | {error: string}}
 * `error` is a human-readable reason nothing was scanned.
 */
function scanBinary(binPath, maxBytes, minBytes) {
  if (scanCache && scanCache.binPath === binPath) return { bestByTier: scanCache.bestByTier };

  let stat;
  try {
    stat = fs.statSync(binPath);
  } catch {
    return { error: `"${binPath}" could not be read` };
  }
  if (!stat.isFile()) return { error: `"${binPath}" is not a regular file` };
  if (stat.size < minBytes) return { error: `"${binPath}" is smaller than expected for the real Codex binary — treated as unreadable` };
  if (stat.size > maxBytes) return { error: `"${binPath}" is larger than the ${maxBytes}-byte sanity limit — not scanned` };

  let buffer;
  try {
    buffer = fs.readFileSync(binPath);
  } catch {
    return { error: `"${binPath}" could not be read` };
  }

  const bestByTier = pickHighestPerTier(parseModelIdsFromText(buffer.toString("latin1")));
  scanCache = { binPath, bestByTier };
  return { bestByTier };
}

/**
 * Resolves a tier name to the concrete Codex model id that should be seeded
 * — the highest version the installed binary carries for that tier, or the
 * shipped fallback when the binary cannot supply an answer in time. See the
 * module doc comment for the full three-step order; this function implements
 * steps 2 and 3 only, since step 1 ("the developer's own value wins") is
 * handled by never calling this for a pointer that is already present.
 *
 * @param {"frontier" | "balanced" | "cheap"} tierName The tier to resolve.
 * @param {{
 *   codexBin?: string,
 *   locate?: (options: {timeoutMs: number, minBinaryBytes: number}) => string | null,
 *   timeoutMs?: number,
 *   maxBinaryBytes?: number,
 *   minBinaryBytes?: number,
 *   now?: () => number
 * }} [options] `codexBin` (defaulting to the `CODEX_BIN` environment
 * variable) points directly at a binary to scan, skipping discovery
 * entirely — the override this whole design promises for testing.
 * `locate` overrides discovery itself when `codexBin` is not set, primarily
 * for tests that need a deterministic "nothing found" or "found this fake
 * file" answer independent of the machine actually running the test;
 * production callers should leave it at its default
 * ({@link defaultLocateCodexBinary}). `now` is the clock the timeout budget
 * is measured against, injectable so a test can simulate the budget already
 * being exhausted without an actual wait.
 * @returns {{id: string, source: "binary" | "fallback", reason: string}}
 * `reason` is `""` for a binary-sourced id; for a fallback it explains why
 * the binary path was not used, so a caller can — and, per this design,
 * must — report it rather than stay silent.
 * @throws {Error} When `tierName` is not one of {@link TIER_ALIASES}'s keys.
 */
function resolveModelForTier(tierName, options = {}) {
  if (!Object.prototype.hasOwnProperty.call(TIER_ALIASES, tierName)) {
    throw new Error(`codex-models: unknown tier "${tierName}" — expected one of ${Object.keys(TIER_ALIASES).join(", ")}`);
  }
  const tierAlias = TIER_ALIASES[tierName];
  const fallback = { id: FALLBACK_MODEL_IDS[tierName], source: "fallback" };

  const timeoutMs = options.timeoutMs !== undefined ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxBinaryBytes = options.maxBinaryBytes !== undefined ? options.maxBinaryBytes : DEFAULT_MAX_BINARY_BYTES;
  const minBinaryBytes = options.minBinaryBytes !== undefined ? options.minBinaryBytes : DEFAULT_MIN_BINARY_BYTES;
  const now = options.now || Date.now;
  const locate = options.locate || defaultLocateCodexBinary;
  const codexBin = options.codexBin !== undefined ? options.codexBin : process.env.CODEX_BIN;

  const deadlineAt = now() + timeoutMs;

  let binPath = null;
  if (codexBin) {
    binPath = codexBin;
  } else {
    try {
      binPath = locate({ timeoutMs, minBinaryBytes });
    } catch {
      binPath = null;
    }
  }

  if (!binPath) {
    return { ...fallback, reason: "the Codex binary could not be located on this machine" };
  }
  if (now() > deadlineAt) {
    return { ...fallback, reason: "locating the Codex binary took too long" };
  }

  const scanned = scanBinary(binPath, maxBinaryBytes, minBinaryBytes);
  if (now() > deadlineAt) {
    return { ...fallback, reason: "scanning the Codex binary took too long" };
  }
  if (scanned.error) {
    return { ...fallback, reason: scanned.error };
  }

  const best = scanned.bestByTier[tierAlias];
  if (!best) {
    return { ...fallback, reason: `the Codex binary at "${binPath}" carries no "${tierAlias}"-tier model id` };
  }
  return { id: best.id, source: "binary", reason: "" };
}

module.exports = {
  TIER_ALIASES,
  FALLBACK_MODEL_IDS,
  resolveModelForTier,
  parseModelIdsFromText,
  pickHighestPerTier,
};
