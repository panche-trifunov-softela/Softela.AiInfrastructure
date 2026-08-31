#!/usr/bin/env node
"use strict";

/**
 * `PreToolUse` guard for `Write`/`Edit`, and for a shell write landing inside
 * the memory directory, on either host.
 *
 * The `Write`/`Edit` half's danger is epistemic, not mechanical: code
 * observed on some branch can be buggy, yet a session reading it may quietly
 * rewrite an agreed, developer-confirmed `## INTENT` section to match what
 * the code does. From then on every session navigates the project by a
 * design that was never actually agreed. That half never denies, it only
 * forces the change to surface as an explicit `ask` so the developer sees it
 * happening.
 *
 * The shell half is a different, mechanical danger: a shell command can land
 * bytes inside the memory directory — `cat >> ACTIVE-WORK.md <<EOF`, `sed -i`,
 * a PowerShell cmdlet — without ever calling `Write`/`Edit`, which walks
 * straight past the INTENT check above with nothing watching.
 * `core/guards/shell-file-write.js` cannot close this gap itself: it
 * deliberately excludes an absolute path outside the resolved
 * `ctx.git.repoRoot`, and the memory directory routinely lives outside
 * whatever repository that is (the agent's own home, or a per-project folder
 * under it) — see `docs/internal/RULES.md`'s `shell-file-write` entry. This
 * hook already resolves the memory directory for the running module option
 * and agent home, so the shell half denies outright whenever an extracted
 * write target lands there, naming the write tool to use instead. Unlike the
 * INTENT check, this half cannot tell whether a bypassed write would have
 * touched an INTENT section at all — a shell command carries no equivalent of
 * `old_string`/`new_string` to inspect — so it does not try; it simply
 * refuses the bypass itself.
 *
 * The memory directory is resolved per invocation rather than read once
 * from a fixed environment variable, because a project-scoped location has
 * to know which project is running; and the payload is decoded through both
 * hosts' wire formats, not only Claude Code's.
 */

const fs = require("fs");
const path = require("path");
const { parseArgs, resolveMemoryDir, UNSPECIFIED_LOCATION } = require("./memory-location");
const { readStdin } = require("./stdin");

/** Shell tool names this hook also evaluates, across both hosts. */
const SHELL_TOOLS = /^(Bash|PowerShell|shell|local_shell|exec_command|shell_command)$/;

/**
 * Resolves `core/lib/shell-write.js#shellWriteTargets` from whichever of this
 * module's two on-disk layouts is actually present, mirroring `stdin.js`'s
 * own dual-layout resolution (see its doc comment for why a hook script here
 * needs this at all: it is copied flat into one installed directory, and
 * reaching into `core/lib` from there needs a layout-aware resolution).
 *
 * Reused rather than reimplemented on purpose: `shellWriteTargets` is
 * `core/guards/shell-file-write.js`'s own mechanism-by-mechanism detection
 * engine (redirects, heredocs, `sed -i`, PowerShell cmdlets, inline
 * interpreter scripts, …), and a second, hand-copied implementation here
 * would silently drift out of sync the moment one copy gained a new
 * mechanism and the other did not.
 *
 * Fails open, unlike `stdin.js`: this is an additional protection layered
 * onto the INTENT check this hook already provides, not the one thing the
 * whole script exists to do, so a resolution failure degrades to skipping the
 * shell check rather than crashing the hook.
 *
 * @returns {null | ((command: string, options?: {powershell?: boolean}) => Array<{path: string, mechanism: string, certain: boolean}>)}
 * The function, or `null` when neither layout resolves.
 */
function resolveShellWriteTargets() {
  for (const modulePath of ["../core/lib/shell-write", "../../../core/lib/shell-write"]) {
    try {
      return require(modulePath).shellWriteTargets;
    } catch (err) {
      if (!err || err.code !== "MODULE_NOT_FOUND") return null;
    }
  }
  return null;
}

/**
 * Resolves `core/lib/write-decode.js#decodeWrites` from whichever of this
 * module's two on-disk layouts is present, exactly as
 * {@link resolveShellWriteTargets} does for its own dependency.
 *
 * Needed because Codex does not write through `Write`/`Edit` at all: its
 * write tool is `apply_patch`, carrying a V4A envelope rather than a
 * `file_path`/`content` pair. This hook filtered on Claude Code's two tool
 * names only, so on Codex the INTENT protection never ran on the one path
 * Codex actually uses — measured, not assumed: an agent appended to a real
 * `ACTIVE-WORK.md` twice without this guard saying a word.
 *
 * Reused rather than reimplemented for the same reason as the shell
 * detector: the patch grammar (hunk application, renames, CRLF handling,
 * the ambiguity rules) lives in one place, and a hand-rolled second parser
 * here would drift the moment either copy learned something new.
 *
 * Fails open: a resolution failure degrades to not checking patch writes,
 * never to crashing the hook.
 *
 * @returns {null | ((toolName: string, input: object, options: object) => Array<{path: string, content: string | null}>)}
 * The function, or `null` when neither layout resolves.
 */
function resolveDecodeWrites() {
  for (const modulePath of ["../core/lib/write-decode", "../../../core/lib/write-decode"]) {
    try {
      return require(modulePath).decodeWrites;
    } catch (err) {
      if (!err || err.code !== "MODULE_NOT_FOUND") return null;
    }
  }
  return null;
}

/**
 * Reads a file relative to a base directory, `null` on any failure.
 *
 * Deliberately unsandboxed, unlike `core/lib/context.js`'s own readers: this
 * hook's whole subject is a directory that usually sits OUTSIDE the agent's
 * working directory, and a boundary-anchored reader would refuse to read the
 * very file being protected.
 *
 * @param {string} base The directory a relative path resolves against.
 * @returns {(p: string) => string | null} The reader.
 */
function makeLocalReader(base) {
  return function readLocal(p) {
    try {
      return fs.readFileSync(path.isAbsolute(p) ? p : path.resolve(base, p), "utf8");
    } catch {
      return null;
    }
  };
}

/**
 * Names the first INTENT section present in `oldContent` that the resulting
 * content no longer carries whole.
 *
 * Extracted so the `Write` branch and the `apply_patch` branch judge a
 * resulting file by exactly the same standard — a patch is only a different
 * way of spelling the same write, and the two must not be allowed to reach
 * different verdicts on identical resulting text.
 *
 * @param {string} oldContent The file's current content.
 * @param {string} newContent The content the write would leave behind.
 * @returns {null | {heading: string}} The first section that would be lost,
 * `null` when every one of them survives.
 */
function firstLostSection(oldContent, newContent) {
  let sections;
  try {
    sections = findIntentSections(oldContent);
  } catch {
    return null;
  }
  for (const section of sections) {
    const headingPresent = newContent.includes(section.heading);
    const bodyPresent = section.body.trim() === "" || newContent.includes(section.body);
    if (!headingPresent || !bodyPresent) return section;
  }
  return null;
}

/**
 * Writes a decision and exits, or exits silently for a pass.
 *
 * Codex's `PreToolUse` has no native `ask` (CONTRACTS §7): the binary
 * rejects `permissionDecision: "ask"` outright. So on Codex a logical `ask`
 * is emitted as a `deny` whose reason states what is needed to proceed —
 * the same "block" default the shared engine's adapters use for a rule's
 * `ask` result on this host. A logical `deny` (the shell-write check) is
 * already a hard stop on both hosts and carries no such translation.
 *
 * @param {"ask" | "deny" | null} wants `"ask"` to surface an INTENT change to
 * the developer, `"deny"` to refuse a shell write into the memory directory
 * outright, or `null` to pass silently.
 * @param {"claude" | "codex"} agent Which host is running this hook.
 * @param {string} [event] The host event this decision governs; defaults to
 * `PreToolUse`.
 * @param {string} [reason] The reason shown to the developer; required when
 * `wants` is not `null`.
 * @returns {void}
 */
function decide(wants, agent, event, reason) {
  if (wants === "ask" || wants === "deny") {
    const permissionDecision = wants === "deny" ? "deny" : agent === "codex" ? "deny" : "ask";
    const permissionDecisionReason =
      wants === "ask" && agent === "codex"
        ? `${reason}\n\nCodex has no interactive "ask" here, so this is a hard stop.`
        : reason;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: event || "PreToolUse", permissionDecision, permissionDecisionReason },
      }),
    );
  }
  process.exit(0);
}

/**
 * Normalises a path for a case-insensitive, slash-insensitive comparison, so
 * the same logic works whether the host reports a POSIX or a Windows path.
 *
 * @param {string} p The path to normalise.
 * @returns {string} The absolute path, forward slashes, lower-cased.
 */
function normalizePath(p) {
  return path.resolve(p).replace(/\\/g, "/").toLowerCase();
}

/**
 * Checks whether a shell write target resolves inside the memory directory.
 *
 * @param {string} targetPath The extracted write target, absolute or
 * relative to `cwd`.
 * @param {string} cwd The shell tool call's own working directory, used to
 * resolve a relative target the same way the shell running it would.
 * @param {string} memoryDir The resolved memory directory.
 * @returns {boolean} `true` when the target equals or nests under
 * `memoryDir`; `false` on any resolution failure, never throws.
 */
function isUnderMemoryDir(targetPath, cwd, memoryDir) {
  try {
    const abs = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd || process.cwd(), targetPath);
    const t = normalizePath(abs);
    const m = normalizePath(memoryDir);
    return Boolean(m) && (t === m || t.startsWith(`${m}/`));
  } catch {
    return false;
  }
}

/**
 * Reads a shell tool call's command line, tolerating an argv array the same
 * way the host payload's other fields are tolerated elsewhere in this file —
 * joined with plain spaces, since this hook only needs to feed the text to
 * `shellWriteTargets`, never to re-run it.
 *
 * @param {object} input The normalised tool input.
 * @returns {string} The command line, or `""` when absent.
 */
function extractShellCommand(input) {
  const c = input.command !== undefined ? input.command : input.cmd !== undefined ? input.cmd : input.script;
  if (Array.isArray(c)) return c.map((x) => String(x)).join(" ");
  return typeof c === "string" ? c : "";
}

/**
 * Builds the reason shown to the developer for a shell write denied inside
 * the memory directory.
 *
 * @param {string} target The write target's own text, as extracted — a path
 * when one was found, otherwise `""`.
 * @param {string} mechanism The mechanism name `shellWriteTargets` reported.
 * @returns {string} The human-readable reason.
 */
function buildShellWriteReason(target, mechanism) {
  const targetClause = target ? ` to "${target}"` : "";
  return (
    `MEMORY GUARD: this shell command writes${targetClause} via ${mechanism}, landing inside the memory ` +
    "directory. A shell write here bypasses the INTENT-section check this hook exists to run — it never " +
    "sees whether the write would remove or reword an agreed design. " +
    "Use the write tool instead (Write/Edit on Claude Code, apply_patch on Codex) so this guard can actually check the change."
  );
}

/**
 * Evaluates a shell tool call against the resolved memory directory, exiting
 * via {@link decide} on the first certain write target found inside it.
 * Returns normally — never exits — when nothing qualifies, so `main` can
 * fall through to its own no-op tail.
 *
 * An uncertain target (a variable, a glob, a computed expression whose write
 * call carries no literal path at all) is skipped rather than guessed at:
 * this check can only act on a target it can actually place relative to the
 * memory directory.
 *
 * @param {{toolName: string, command: string, cwd: string, memoryDir: string, agent: string, event: string}} args
 * The shell call's own fields, already extracted by `main`.
 * @returns {void}
 */
function evaluateShellWrite({ toolName, command, cwd, memoryDir, agent, event }) {
  const shellWriteTargets = resolveShellWriteTargets();
  if (!shellWriteTargets || !command) return;

  let targets;
  try {
    targets = shellWriteTargets(command, { powershell: /^PowerShell$/i.test(toolName) });
  } catch {
    return;
  }

  for (const target of targets) {
    if (!target || !target.certain || !target.path) continue;
    if (isUnderMemoryDir(target.path, cwd, memoryDir)) {
      decide("deny", agent, event, buildShellWriteReason(target.path, target.mechanism));
    }
  }
}

/**
 * Finds every `## INTENT …` section in a memory file's text.
 *
 * Flow:
 * - Locate every markdown ATX heading (`#` through `######`).
 * - Keep the ones whose title starts with `INTENT`.
 * - A section's extent runs from its own heading up to (not including) the
 *   next heading of equal or shallower level, or end of file.
 *
 * @param {string} content Full text of the memory file.
 * @returns {Array<{heading: string, body: string, start: number, end: number}>}
 * One entry per INTENT section: its heading line, its body text, and the
 * character offsets of the full heading+body span in `content`.
 */
function findIntentSections(content) {
  const headingRe = /^(#{1,6})[ \t]+(.*)$/gm;
  const heads = [];
  let m;
  while ((m = headingRe.exec(content)) !== null) {
    heads.push({ level: m[1].length, title: m[2].trim(), start: m.index, lineEnd: m.index + m[0].length });
  }

  const sections = [];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    if (!/^INTENT\b/i.test(h.title)) continue;

    let end = content.length;
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j].level <= h.level) {
        end = heads[j].start;
        break;
      }
    }

    sections.push({
      heading: content.slice(h.start, h.lineEnd).trim(),
      body: content.slice(h.lineEnd, end),
      start: h.start,
      end,
    });
  }
  return sections;
}

/**
 * Finds every start offset where `needle` occurs in `haystack`, including
 * overlapping occurrences.
 *
 * @param {string} haystack The text to search.
 * @param {string} needle The substring to find.
 * @returns {number[]} Start offsets of every occurrence.
 */
function occurrences(haystack, needle) {
  if (!needle) return [];
  const idxs = [];
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    idxs.push(idx);
    from = idx + 1;
  }
  return idxs;
}

/**
 * Finds the first INTENT section whose span overlaps any occurrence of
 * `needle` in `content`.
 *
 * @param {string} content Full on-disk text the section offsets refer to.
 * @param {string} needle Text being removed or replaced by the edit.
 * @param {Array<{start: number, end: number}>} sections INTENT sections,
 * from {@link findIntentSections}.
 * @returns {object | null} The first overlapping section, or `null` when
 * none overlap.
 */
function firstOverlap(content, needle, sections) {
  for (const idx of occurrences(content, needle)) {
    const idxEnd = idx + needle.length;
    for (const section of sections) {
      if (idx < section.end && idxEnd > section.start) return section;
    }
  }
  return null;
}

/**
 * Builds the reason shown to the developer for an `ask` decision.
 *
 * @param {string} file The memory file path being written.
 * @param {string} heading The INTENT heading line at stake.
 * @returns {string} The human-readable reason.
 */
function buildReason(file, heading) {
  const title = heading.replace(/^#{1,6}\s*/, "").trim();
  return (
    `MEMORY GUARD: this edit to ${file} would remove or reword "${title}". ` +
    "INTENT records agreed, developer-confirmed design — only the developer " +
    "can overturn it; code that disagrees with it is evidence of a bug in " +
    "the code, not of stale memory. If this was triggered by code observed " +
    'to behave differently, add a new "## CONFLICT" section describing ' +
    "both sides and report it, instead of rewriting the INTENT."
  );
}

/**
 * Runs the hook body once stdin has been read.
 *
 * Mirrors the script's previous fully-synchronous top-level flow exactly —
 * only the stdin acquisition changed, from a blocking `fs.readFileSync(0)`
 * to the non-blocking {@link readStdin}. Every `decide()` call still ends
 * the process via `process.exit()`, so control never needs to `return` here
 * any more than it did at the top level before.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const agent = args.agent === "codex" ? "codex" : "claude";

  let payload;
  try {
    payload = JSON.parse((await readStdin()) || "{}");
  } catch {
    // A guard that bricks editing on a malformed payload is worse than one
    // that misses a case.
    decide(null, agent);
  }

  // JSON.parse("null") returns null without throwing, and a bare array,
  // string, number or boolean parses just as cleanly — none of those are
  // caught above, so every non-plain-object result is normalised to {} before
  // any field is read off it.
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) payload = {};

  const event = payload.hook_event_name || payload.hookEventName || "PreToolUse";
  const tool = payload.tool_name || payload.toolName || "";
  const input = payload.tool_input || payload.toolInput || payload.input || {};

  const isShellTool = SHELL_TOOLS.test(tool);
  const isPatchTool = tool === "apply_patch";
  if (tool !== "Write" && tool !== "Edit" && !isPatchTool && !isShellTool) decide(null, agent);

  const agentHome = args["agent-home"] || "";
  const location = args.location || UNSPECIFIED_LOCATION;
  if (!agentHome) decide(null, agent);

  const cwd = payload.cwd || payload.workspace || payload.working_directory || process.cwd();
  const memoryDir = resolveMemoryDir({ agentHome, cwd, location });

  if (isShellTool) {
    evaluateShellWrite({ toolName: tool, command: extractShellCommand(input), cwd, memoryDir, agent, event });
    decide(null, agent);
  }

  if (isPatchTool) {
    const decodeWrites = resolveDecodeWrites();
    if (!decodeWrites) decide(null, agent);

    const readLocal = makeLocalReader(cwd);
    let writes;
    try {
      writes = decodeWrites("apply_patch", input, {
        readFile: readLocal,
        readFileRepoRoot: readLocal,
        pathExistsRepoRoot: (p) => readLocal(p) !== null,
      });
    } catch {
      decide(null, agent);
    }

    for (const write of Array.isArray(writes) ? writes : []) {
      // A patch section this decoder could not reconstruct carries no
      // resulting content to compare against — nothing to judge, so nothing
      // to block, the same direction every other failure here takes.
      if (typeof write.content !== "string") continue;

      const target = String(write.path || "");
      if (!target) continue;

      let normTarget, normMemory;
      try {
        normTarget = normalizePath(path.isAbsolute(target) ? target : path.resolve(cwd, target));
        normMemory = normalizePath(memoryDir);
      } catch {
        continue;
      }
      if (normTarget !== normMemory && !normTarget.startsWith(`${normMemory}/`)) continue;

      const current = readLocal(target);
      if (typeof current !== "string") continue;

      const lost = firstLostSection(current, write.content);
      if (lost) decide("ask", agent, event, buildReason(target, lost.heading));
    }

    decide(null, agent);
  }

  const file = String(input.file_path || input.filePath || input.path || "");
  if (!file) decide(null, agent);

  let normFile, normRoot;
  try {
    normFile = normalizePath(file);
    normRoot = normalizePath(memoryDir);
  } catch {
    decide(null, agent);
  }
  if (normFile !== normRoot && !normFile.startsWith(`${normRoot}/`)) decide(null, agent);

  let oldContent;
  try {
    oldContent = fs.readFileSync(file, "utf8");
  } catch {
    // Missing file, unreadable path, etc. — new knowledge is never obstructed.
    decide(null, agent);
  }

  let sections;
  try {
    sections = findIntentSections(oldContent);
  } catch {
    decide(null, agent);
  }
  if (sections.length === 0) decide(null, agent);

  if (tool === "Edit") {
    const oldString = String(input.old_string || input.oldString || "");
    const newString = String(input.new_string || input.newString || "");
    if (!oldString) decide(null, agent);

    const hit = firstOverlap(oldContent, oldString, sections);
    if (hit && !newString.includes(oldString)) decide("ask", agent, event, buildReason(file, hit.heading));
    decide(null, agent);
  }

  // tool === "Write" — judged through the same helper the patch branch uses,
  // so the two spellings of one write cannot reach different verdicts.
  const lost = firstLostSection(oldContent, String(input.content || ""));
  if (lost) decide("ask", agent, event, buildReason(file, lost.heading));

  decide(null, agent);
}

main();
