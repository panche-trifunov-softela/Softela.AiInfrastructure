#!/usr/bin/env node
"use strict";

/**
 * Deletes saved session transcripts and their side-car folders for an
 * installed agent.
 *
 * Two rules hold whatever the arguments say. The live session is never
 * deleted — it is not a flag, so no wording can ask for it. And nothing
 * under a directory named `memory` is ever touched: that is project
 * knowledge, not session data, and losing it is unrecoverable.
 *
 * The two hosts store sessions differently, and this tool has to know both.
 * Claude Code groups by project; Codex groups by date, with no project
 * dimension at all:
 *
 *   claude   <home>/projects/<sanitized cwd>/<uuid>.jsonl  (+ <uuid>/ side-car)
 *   codex    <home>/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<uuid>.jsonl
 *
 * Both layouts are verified against the real hosts. The difference is why
 * the default scope differs per agent: "the sessions near the ones you are
 * working with" means the current project on one host and today on the
 * other, because that is the only grouping each host actually has.
 *
 * Usage:
 *   node clean-sessions.js --agent-home=<path> [options]
 *
 * Options a developer sees:
 *   --all                 Every session except the live one. Without it,
 *                         Claude Code sweeps the current directory's project
 *                         and Codex sweeps today. Also widens the sweep to
 *                         this host's guard-activity logs, which have no
 *                         project of their own to scope a plain run to;
 *                         today's log is always kept, the same as the live
 *                         session.
 *   --apply               Actually delete. Without it, report only.
 *
 * Options the installed command may pass for itself, all optional:
 *   --agent=claude|codex  Which host's session store to sweep.
 *   --agent-home=<path>   The agent home to sweep.
 *   --current=<id>        Session id of the live session, when the caller
 *                         already knows it. Beats the newest-activity guess.
 *
 * Neither `--agent` nor `--agent-home` normally needs passing. Installed,
 * this file sits at `<agent home>/softela-ai/hooks/clean-sessions.js`, so it
 * derives both from its own location — which is what lets the installed
 * command be a fixed line of text that needs no path substituted into it.
 */

const fs = require("fs");
const path = require("path");

/** Session transcripts and side-car folders are named by uuid; nothing else is. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Codex names a transcript `rollout-<ISO-ish timestamp>-<uuid>.jsonl`. The
 * uuid is the session identity; the timestamp only orders them.
 */
const CODEX_TRANSCRIPT = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * Directory names that are never read into a sweep and never deleted,
 * hardcoded rather than configured so that no flag, prompt or argument can
 * reach them. A `memory` directory beside session transcripts holds project
 * memory, not session data.
 */
const NEVER_DELETE = new Set(["memory"]);

/** Where each host keeps its session store, relative to the agent home. */
const SESSIONS_DIR_NAME = { claude: "projects", codex: "sessions" };

/**
 * Where guard-activity logs live, relative to the agent home: one file per
 * calendar day, shared across every project on the host rather than filed
 * per-project the way a session is. This literal is hardcoded rather than
 * `require`d from `core/lib/paths.js#guardLogPath` — this script stays
 * self-contained, dependent on nothing else in the repository, exactly as
 * its own README promises. `tests/modules/session-cleanup.test.js` pins this
 * literal against `guardLogPath` directly, so the two can never silently
 * drift apart.
 */
const GUARD_LOG_DIR_NAME = path.join(".softela-ai", "logs");

/** Only a real guard-activity log file name matches; anything else under the log directory is left alone. */
const GUARD_LOG_NAME = /^guard-activity-\d{4}-\d{2}-\d{2}\.jsonl$/;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

/**
 * The agent home this file was installed into.
 *
 * Installed, this script lives at `<agent home>/softela-ai/hooks/`, so two
 * levels up is the home itself. Deriving it rather than requiring it as an
 * argument is what keeps the installed command a fixed line of text: no
 * absolute path has to be substituted into a markdown file at install time,
 * and the command keeps working if the home is ever moved or copied.
 *
 * `--agent-home` still wins when given, which is what the tests use to point
 * this at a fixture instead of a real home.
 *
 * @returns {string} The absolute path of the agent home.
 */
function resolveAgentHome() {
  const explicit = value("agent-home");
  if (explicit) return explicit;
  return path.resolve(__dirname, "..", "..");
}

/**
 * Which host's store to sweep.
 *
 * Derived from the home's own directory name when not stated, so the
 * installed command does not have to carry it either. Anything that is not
 * recognisably a Codex home is treated as Claude Code's, which is the
 * layout that existed first.
 *
 * @param {string} home The resolved agent home.
 * @returns {"claude" | "codex"} The host.
 */
function resolveAgent(home) {
  const explicit = value("agent");
  if (explicit === "codex" || explicit === "claude") return explicit;
  return path.basename(home).toLowerCase().includes("codex") ? "codex" : "claude";
}

const agentHome = resolveAgentHome();
const agent = resolveAgent(agentHome);
const SESSIONS_DIR = path.join(agentHome, SESSIONS_DIR_NAME[agent]);
const sweepAll = flag("all");
const apply = flag("apply");

// Guard logs are touched only under `--all` — collected here, once, so a
// plain per-project run never so much as lists the shared log directory.
const guardLogs = sweepAll ? collectGuardLogs() : [];

/**
 * Checks whether a path passes through a directory this tool must never
 * touch.
 *
 * Enforced at the point of deletion as well as at the point of discovery.
 * The discovery filter is what normally keeps a memory directory out of a
 * sweep; this is the backstop that holds even if some future change to
 * discovery lets one through.
 *
 * @param {string} target An absolute path.
 * @returns {boolean} `true` when any segment of the path is protected.
 */
function isProtectedPath(target) {
  return String(target)
    .split(/[/\\]+/)
    .some((segment) => NEVER_DELETE.has(segment.toLowerCase()));
}

/**
 * Today's date, formatted the way `core/lib/paths.js#formatLogDate` names a
 * guard-activity log file: local time, not UTC, matching the process that
 * writes the log so the two can never disagree about which file is today's.
 *
 * @returns {string} Today's date as `YYYY-MM-DD`.
 */
function todaysGuardLogDate() {
  const now = new Date();
  const two = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

/**
 * Collects the guard-activity logs eligible for this sweep: every file under
 * `<agentHome>/.softela-ai/logs/` matching the log's own naming pattern,
 * except today's — kept unconditionally, the equivalent for this shared,
 * per-day log of never deleting the live session.
 *
 * @returns {{path: string, bytes: number}[]} The eligible logs.
 */
function collectGuardLogs() {
  const dir = path.join(agentHome, GUARD_LOG_DIR_NAME);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const today = `guard-activity-${todaysGuardLogDate()}.jsonl`;
  return entries
    .filter((e) => e.isFile() && GUARD_LOG_NAME.test(e.name) && e.name !== today)
    .map((e) => {
      const full = path.join(dir, e.name);
      return { path: full, bytes: sizeOf(full) };
    });
}

/**
 * Maps a working directory to the folder name Claude Code's session store
 * uses, mirroring the host's own convention: every non-alphanumeric
 * character becomes `-`, lower-cased.
 *
 * @param {string} cwd The absolute path of the project.
 * @returns {string} The sanitized folder name.
 */
function sanitizeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
}

/**
 * Lists the immediate subdirectories of a directory, skipping any this tool
 * must never enter.
 *
 * @param {string} dir The directory to list.
 * @returns {string[]} Absolute paths, possibly empty.
 */
function subdirectories(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !NEVER_DELETE.has(e.name.toLowerCase()))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * Today's date folder under Codex's session store, as the host spells it.
 *
 * @returns {string} The absolute path, whether or not it exists.
 */
function codexTodayDir() {
  const now = new Date();
  const two = (n) => String(n).padStart(2, "0");
  return path.join(SESSIONS_DIR, String(now.getFullYear()), two(now.getMonth() + 1), two(now.getDate()));
}

/**
 * Every date folder under Codex's store, at whatever depth the host nests
 * them. Walking rather than assuming three levels keeps this working if the
 * host ever changes the nesting.
 *
 * @param {string} dir The directory to walk.
 * @param {string[]} [out] Accumulator.
 * @returns {string[]} Absolute paths of every directory holding transcripts.
 */
function codexAllDateDirs(dir, out = []) {
  const children = subdirectories(dir);
  const holdsTranscripts = (() => {
    try {
      return fs.readdirSync(dir).some((name) => CODEX_TRANSCRIPT.test(name));
    } catch {
      return false;
    }
  })();

  if (holdsTranscripts) out.push(dir);
  for (const child of children) codexAllDateDirs(child, out);
  return out;
}

/**
 * Resolves which folders this run sweeps.
 *
 * @returns {{dirs: string[], scope: string}} The folders, and a short label
 * naming the scope for the report.
 */
function resolveScope() {
  if (agent === "codex") {
    if (sweepAll) return { dirs: codexAllDateDirs(SESSIONS_DIR), scope: "every day" };
    const today = codexTodayDir();
    return { dirs: fs.existsSync(today) ? [today] : [], scope: "today" };
  }

  const all = subdirectories(SESSIONS_DIR);
  if (sweepAll) return { dirs: all, scope: "every project" };

  const wanted = sanitizeCwd(process.cwd());
  return { dirs: all.filter((d) => path.basename(d).toLowerCase() === wanted), scope: "this project" };
}

/**
 * Computes the total size of a file or folder tree.
 *
 * @param {string} target The path to measure.
 * @returns {number} The total size in bytes; `0` when it cannot be read.
 */
function sizeOf(target) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;

  let entries;
  try {
    entries = fs.readdirSync(target);
  } catch {
    return 0;
  }
  return entries.reduce((sum, entry) => sum + sizeOf(path.join(target, entry)), 0);
}

/**
 * Finds the most recent modification time anywhere in a file or folder
 * tree.
 *
 * A folder's own mtime is not enough: on Windows it moves when entries are
 * added or removed, but not when an existing file is rewritten.
 *
 * @param {string} target The path to inspect.
 * @returns {number} The newest mtime in milliseconds since epoch; `0` when
 * it cannot be read.
 */
function newestMtime(target) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.mtimeMs;

  let entries;
  try {
    entries = fs.readdirSync(target);
  } catch {
    return stat.mtimeMs;
  }
  return entries.reduce((newest, entry) => Math.max(newest, newestMtime(path.join(target, entry))), stat.mtimeMs);
}

/**
 * Collects every session in one folder, pairing each transcript with its
 * side-car where the host has one.
 *
 * Either half may be missing on Claude Code: a resumed or compacted session
 * can leave a side-car behind with no transcript of its own. Codex has no
 * side-car at all, so a Codex session is always exactly one file.
 *
 * @param {string} dir The absolute path of the folder to read.
 * @returns {Array<{id: string, transcript: string | null, sideCar: string | null}>}
 * One entry per session id found, before sizing.
 */
function collectSessions(dir) {
  const sessions = new Map();
  const at = (id) => sessions.get(id) ?? { id, transcript: null, sideCar: null };

  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (NEVER_DELETE.has(entry.name.toLowerCase())) continue;
    const full = path.join(dir, entry.name);

    if (entry.isFile() && agent === "codex") {
      const match = entry.name.match(CODEX_TRANSCRIPT);
      if (match) sessions.set(match[1], { ...at(match[1]), transcript: full });
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const id = entry.name.slice(0, -".jsonl".length);
      if (SESSION_ID.test(id)) sessions.set(id, { ...at(id), transcript: full });
    }

    if (entry.isDirectory() && SESSION_ID.test(entry.name)) {
      sessions.set(entry.name, { ...at(entry.name), sideCar: full });
    }
  }

  return [...sessions.values()];
}

/**
 * Removes a file or folder tree, collecting any failure rather than
 * throwing. Refuses outright to touch a protected path.
 *
 * @param {string} target The path to remove.
 * @param {string[]} failures Accumulator for failure descriptions.
 * @returns {void}
 */
function remove(target, failures) {
  if (isProtectedPath(target)) {
    failures.push(`${path.basename(target)}: refused — project memory is never session data`);
    return;
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    failures.push(`${path.basename(target)}: ${error.code || error.message}`);
  }
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

/**
 * Formats how long ago a timestamp was, informational only.
 *
 * @param {number} mtimeMs The timestamp in ms since epoch, as returned by
 * {@link newestMtime}.
 * @returns {string} A short `"Xd ago"` / `"Xh ago"` / `"Xm ago"` string.
 */
function formatAge(mtimeMs) {
  const minutes = Math.max(0, Math.floor((Date.now() - mtimeMs) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Reports guard-activity logs on their own labelled line, separate from the
 * session report, and deletes them once `--apply` is given.
 *
 * A no-op whenever `sweepAll` is false: guard logs are per-day and shared
 * across every project on the host, so the plain, per-project run must
 * neither report nor delete them — there is no flag that reaches them
 * outside `--all`.
 *
 * @param {{path: string, bytes: number}[]} logs Every eligible log, already
 * excluding today's (see {@link collectGuardLogs}).
 * @returns {void}
 */
function reportGuardLogs(logs) {
  if (!sweepAll) return;

  console.log(
    `\nGuard activity logs: ${apply ? "DELETING" : "WOULD DELETE"} ${logs.length} file(s), ` +
      `${mb(logs.reduce((n, l) => n + l.bytes, 0))} MB (today's log is always kept).`,
  );
  if (!apply) return;

  const failures = [];
  for (const log of logs) remove(log.path, failures);
  if (failures.length) {
    console.log(`Guard activity logs: ${failures.length} item(s) refused:`);
    failures.forEach((f) => console.log(`  ${f}`));
  }
}

const { dirs, scope } = resolveScope();
if (!dirs.length) {
  const widen = sweepAll ? "" : "\nPass --all to sweep every session instead.";
  console.log(`No sessions found for ${scope} under ${SESSIONS_DIR}.${widen}`);
  reportGuardLogs(guardLogs);
  process.exit(0);
}

const sessions = dirs.flatMap(collectSessions).map((s) => {
  const targets = [s.transcript, s.sideCar].filter(Boolean);
  return {
    ...s,
    bytes: targets.reduce((n, t) => n + sizeOf(t), 0),
    // Activity spans both halves: a session resumed moments ago has a
    // side-car but no transcript of its own yet, so judging by the
    // transcript alone would call the PREVIOUS session the live one.
    mtime: targets.reduce((newest, t) => Math.max(newest, newestMtime(t)), 0),
  };
});

if (!sessions.length) {
  console.log(`No saved sessions found for ${scope}.`);
  reportGuardLogs(guardLogs);
  process.exit(0);
}

// The live session is the one still being written to, transcript or
// side-car, so it is the most recently touched. `--current` pins it when the
// caller already knows the id, which beats any guess.
const pinned = value("current");
const newest = sessions.reduce((max, s) => Math.max(max, s.mtime), 0);
const current = pinned ? sessions.find((s) => s.id === pinned) : sessions.find((s) => s.mtime === newest);

// Compare by id, not by object reference: the same session id can show up as
// a separate entry per folder, and `s !== current` would only shield the one
// object `.find` happened to return.
const doomed = sessions.filter((s) => !current || s.id !== current.id);
const freed = doomed.reduce((sum, s) => sum + s.bytes, 0);

console.log(
  `${dirs.length} folder(s) for ${scope}, ${sessions.length} session(s), ` +
    `${mb(sessions.reduce((n, s) => n + s.bytes, 0))} MB total.\n`,
);

if (current) {
  console.log(`KEEPING the live session ${current.id} (${mb(current.bytes)} MB, ${formatAge(current.mtime).trim()}) — always, never optional.`);
}
console.log("KEEPING every 'memory' folder — that is project memory, never session data.\n");

console.log(apply ? "DELETING:" : "WOULD DELETE:");
if (!doomed.length) console.log("  (nothing)");
for (const s of doomed.sort((a, b) => b.bytes - a.bytes)) {
  const parts = [s.transcript && "transcript", s.sideCar && "side-car"].filter(Boolean).join(" + ");
  console.log(`  ${s.id}  ${mb(s.bytes).padStart(7)} MB  ${formatAge(s.mtime).padStart(8)}  (${parts})`);
}
console.log(`\nTotal: ${mb(freed)} MB across ${doomed.length} session(s).`);

reportGuardLogs(guardLogs);

if (!apply) {
  console.log("\nDry run. Nothing has been deleted.");
  process.exit(0);
}

const failures = [];
for (const s of doomed) {
  if (s.sideCar) remove(s.sideCar, failures);
  if (s.transcript) remove(s.transcript, failures);
}

if (!failures.length) {
  console.log(`\nDone. Freed ${mb(freed)} MB.`);
  process.exit(0);
}

console.log(`\nFreed what it could. ${failures.length} item(s) refused:`);
failures.forEach((f) => console.log(`  ${f}`));
console.log("\nEBUSY/EPERM is expected on a transcript the host still holds open.");
