"use strict";

/**
 * Builds the frozen evaluation context every rule reads from.
 *
 * Host payload shapes are not identical between Claude Code and Codex, and
 * the Codex shape is not fully documented, so every field is read through a
 * tolerant list of alternative keys. Nothing here ever throws — a garbage
 * payload produces a minimal, harmless context instead of an exception.
 *
 * `cwd` is resolved through `core/lib/workdir.js`, not read verbatim off the
 * payload, so the whole engine works the same regardless of which directory
 * the agent process itself was launched from — see `buildContext`'s own doc
 * comment for the resolution order.
 *
 * `ctx.content` vs `ctx.resultingContent`: for a direct single-string-payload
 * call (`Write`, a plain `Edit`) the two never disagree, so `buildContext`
 * only ever sets `content` — a rule reading either sees the same text. The
 * distinction matters once `adapters/shared/dispatch-core.js#buildWriteContext`
 * decodes a multi-part write (`MultiEdit`'s `edits[]`, an `apply_patch`
 * hunk-based update) into the two separately:
 *
 * - `content` is always the text the write actually *inserts* — `new_string`
 *   for `Edit`, every edit's `new_string` joined in order for `MultiEdit` —
 *   exactly what a direct `Edit` call has always put there, so no existing
 *   content rule changes what it judges just because the call arrived
 *   through a decoded envelope instead of directly.
 * - `resultingContent` is the reconstructed whole file after the write is
 *   applied, or `null` when it could not be reconstructed. A rule that
 *   genuinely needs to see the file as it will end up — not only the text
 *   just added — reads this instead.
 *
 * For a brand-new file (`Write`, an `apply_patch` add) there is only one
 * text to report, so both fields hold it and neither can disagree.
 *
 * `ctx.agentId`/`ctx.agentType`: a Claude Code `PreToolUse` payload carries
 * `agent_id` (plus `agent_type`, the agent's own name, e.g. `"Explore"`) only
 * when the hook fires from inside a subagent call — a main-thread tool call
 * never carries either field. A non-null `ctx.agentId` is therefore the
 * signal that the current tool call is happening inside a delegated agent,
 * not from the orchestrator itself. This is a Claude Code payload field;
 * Codex is not known to send an equivalent one, so a rule keying on it is
 * silent on Codex rather than wrong.
 *
 * `ctx.sessionId`: Codex's `PreToolUse` payload carries `session_id`
 * (`docs/internal/CONTRACTS.md`'s own "Verified Codex payload shape"), and a
 * real Claude Code `PreToolUse` payload was measured to carry it as well —
 * every record in a real guard-activity log carried a non-null value. It is
 * still a host-supplied field, not a guaranteed one, so it may be absent on a
 * payload shape nobody has measured yet; every consumer treats `null` as
 * "unknown" and behaves safely rather than assuming the field is always set.
 */

const fs = require("fs");
const path = require("path");
const { readText } = require("./fs-safe");
const { gitState } = require("./git-state");
const { resolveProject } = require("./project-resolver");
const { resolveOverrides } = require("./override-resolver");
const { resolveWorkdir, extractShellWorkdir } = require("./workdir");
const { isWriteToolName } = require("./write-decode");

/**
 * Picks the first non-empty string among candidates.
 *
 * @param {...*} vals Candidate values.
 * @returns {string} The first non-empty string, or `""` when none qualify.
 */
function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.length) return v;
  }
  return "";
}

/**
 * Picks the first non-empty string among candidates, or `null`.
 *
 * @param {...*} vals Candidate values.
 * @returns {string | null} The first non-empty string, or `null`.
 */
function firstStringOrNull(...vals) {
  const s = firstString(...vals);
  return s.length ? s : null;
}

/**
 * Reads a dotted path out of an object without throwing.
 *
 * @param {object} obj The object to read from.
 * @param {string} dotted A dotted key path, e.g. `"session.model"`.
 * @returns {*} The resolved value, or `undefined` when any segment is
 * missing.
 */
function readPath(obj, dotted) {
  return dotted.split(".").reduce((acc, key) => {
    return acc && typeof acc === "object" ? acc[key] : undefined;
  }, obj);
}

/**
 * Normalises the host's tool-input field, tolerating a JSON string in place
 * of an object — the Codex `local_shell` shape passes argv as an array
 * inside a stringified payload in some builds.
 *
 * @param {object} payload The raw host payload.
 * @returns {object} The tool input as a plain object; `{}` when absent or
 * unparseable.
 */
function pickInput(payload) {
  const candidates = [payload.tool_input, payload.toolInput, payload.input, payload.arguments, payload.params];
  for (const c of candidates) {
    if (c === undefined || c === null) continue;
    if (typeof c === "string") {
      try {
        const parsed = JSON.parse(c);
        if (parsed && typeof parsed === "object") return parsed;
      } catch {
        // Not JSON — try the next candidate.
      }
      continue;
    }
    if (typeof c === "object") return c;
  }
  return {};
}

/**
 * Argv elements matching this pattern need no quoting at all when rejoined
 * into a command line — they carry nothing `core/lib/shell-parse.js` treats
 * as a separator, a quote, or an escape.
 */
const SAFE_BAREWORD = /^[A-Za-z0-9_./:@%+,=~^-]+$/;

/**
 * Quotes a single argv element for the rejoined command line so that
 * `core/lib/shell-parse.js`'s parsing (statement splitting, flag/verb
 * matching, quoted-value extraction) reads it back with the same argument
 * boundary the host's argv array gave it — never fewer, never more.
 *
 * An element made only of characters {@link SAFE_BAREWORD} allows is left
 * bare, matching the pre-existing join for the common case (`git`, `push`,
 * `--force`, a bare path). Anything else — whitespace, a newline, a quote
 * character, or a shell metacharacter such as `; & | > \` $ ( )` that could
 * otherwise be read as a second statement — is wrapped in double quotes,
 * with `\` and `"` backslash-escaped, mirroring the double-quote escaping
 * `maskQuoted`/`extractQuoted` already understand.
 *
 * @param {string} raw The argv element, already stringified.
 * @returns {string} The element as it should appear in the rejoined command
 * line.
 */
function quoteArgvElement(raw) {
  if (SAFE_BAREWORD.test(raw)) return raw;
  return `"${raw.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;
}

/**
 * Normalises the shell command line, joining an argv array when the host
 * passes one instead of a single string. Each element is re-quoted so the
 * rejoined string parses back to the same argument boundaries the array
 * described — see {@link quoteArgvElement}.
 *
 * A write tool never carries a shell command, and one of them — Codex's
 * `apply_patch` — carries its whole patch envelope under the very field this
 * function reads (`command`; measured off a live payload, see
 * `core/lib/write-decode.js#pickPatchCommand`). Left unguarded, `ctx.command`
 * for such a call became the patch's own text, and every command-matching
 * rule then judged the FILE CONTENT as if it were a command line: a patch
 * merely adding a line that mentions `npm install` or `git push origin main`
 * read exactly like running it. `toolName` is what tells the two apart, so it
 * is required rather than optional — a caller that cannot say which tool it
 * has cannot safely be given a command either.
 *
 * @param {object} input The normalised tool input.
 * @param {string} toolName The host's own tool name, from the same payload.
 * @returns {string} The command line, or `""` when this is not a shell call.
 */
function pickCommand(input, toolName) {
  if (isWriteToolName(toolName)) return "";
  const c = input.command !== undefined ? input.command : input.cmd !== undefined ? input.cmd : input.script;
  if (Array.isArray(c)) return c.map((x) => quoteArgvElement(String(x))).join(" ");
  return typeof c === "string" ? c : "";
}

/**
 * Tests whether `target` resolves to somewhere inside `boundary`.
 *
 * @param {string} target An absolute path.
 * @param {string} boundary An absolute directory the target must stay under.
 * @returns {boolean} `true` when `target` is `boundary` itself or a
 * descendant of it.
 */
function withinBoundary(target, boundary) {
  const rel = path.relative(boundary, target);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolves a path through every symlink/junction on it, falling back to the
 * path unchanged when resolution fails (the path does not exist yet, or a
 * component of it cannot be stat'd) — the same fail-toward-"treat it as
 * given" direction the rest of this module already takes, since a path that
 * cannot be resolved is caught by {@link withinBoundary}'s own textual check
 * either way.
 *
 * Deliberately `fs.realpathSync`, not `.native`: on this repository's own
 * Windows dev environment `os.tmpdir()` itself resolves through an 8.3
 * short-name component (`VOLODY~1`) that `.native` rewrites to the long form
 * while plain `realpathSync` leaves alone — every existing fixture anchors
 * `cwd`/`repoRoot` on that same short-form tmpdir, so `.native` would
 * introduce a spurious short/long mismatch on every ordinary (non-symlinked)
 * path this module resolves, while plain `realpathSync` still resolves a
 * genuine reparse point correctly (verified directly: a directory junction
 * inside a short-form tmp path resolves to its real, short-form target).
 *
 * @param {string} p An absolute path.
 * @returns {string} The resolved path, or `p` unchanged when resolution
 * fails.
 */
function realOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Confirms a path stays inside a boundary even after every symlink/junction
 * on it is resolved — a reparse point whose OWN path lives inside the
 * boundary can still point somewhere else entirely, and a plain textual
 * `path.relative` check (this module's first, cheaper check) cannot tell the
 * difference. Both sides are resolved through {@link realOrSelf} before
 * comparing, so a repository root that itself sits behind a symlink still
 * compares consistently against a target reached through one.
 *
 * @param {string} target An absolute path, already confirmed inside
 * `boundary` textually.
 * @param {string} boundary An absolute directory the target must stay under.
 * @returns {boolean} `true` when the RESOLVED target still stays under the
 * RESOLVED boundary.
 */
function withinBoundaryResolved(target, boundary) {
  return withinBoundary(realOrSelf(target), realOrSelf(boundary));
}

/**
 * Builds a sandboxed file reader bound to a working directory and, when
 * known, a git repository root.
 *
 * The repository root is read from the lazy `git` object only when a read
 * actually happens, so building a reader never forces a `git` shell-out by
 * itself.
 *
 * @param {string} cwd The working directory a relative path resolves
 * against.
 * @param {{repoRoot: string | null}} git The lazy git state; only its
 * `repoRoot` getter is touched, and only on an actual read.
 * @returns {(p: string) => string | null} A reader that refuses to escape
 * the boundary — including through a symlink or directory junction whose own
 * path lives inside the boundary but resolves outside it — and returns
 * `null` on any failure.
 */
function makeReadFile(cwd, git) {
  return function readFile(p) {
    try {
      if (typeof p !== "string" || !p) return null;
      const target = path.isAbsolute(p) ? p : path.resolve(cwd, p);
      const boundary = git.repoRoot || cwd;
      if (!withinBoundary(target, boundary)) return null;
      if (!withinBoundaryResolved(target, boundary)) return null;
      return readText(target);
    } catch {
      return null;
    }
  };
}

/**
 * Builds a sandboxed file-size lookup bound to a working directory and, when
 * known, a git repository root — the same boundary {@link makeReadFile}
 * anchors on, but answering "how many bytes is this file" without reading its
 * content at all.
 *
 * `core/lib/write-decode.js`'s reconstruction budget used to learn a file's
 * size only after `readFile` had already read the whole thing into memory, so
 * a single existing tracked file far larger than the whole budget (a
 * generated lockfile, a bundled asset, a large fixture) was read in full
 * regardless of its own size — nothing could ask "how big is this" without
 * paying for the read first. This answers exactly that question, with a
 * plain `fs.statSync` rather than a full read, so a reconstruction path can
 * charge a file's own size against the budget BEFORE deciding whether to read
 * it at all.
 *
 * @param {string} cwd The working directory a relative path resolves
 * against.
 * @param {{repoRoot: string | null}} git The lazy git state; only its
 * `repoRoot` getter is touched, and only on an actual stat.
 * @returns {(p: string) => number | null} A stat that refuses to escape the
 * boundary — including through a symlink or directory junction whose own path
 * lives inside the boundary but resolves outside it — and returns `null`
 * rather than throwing for a missing path, a directory, a path that cannot be
 * stat'd, or an escape attempt, mirroring {@link makeReadFile}'s own
 * fail-toward-"cannot answer" behaviour exactly rather than a second, looser
 * path resolution.
 */
function makeStatFile(cwd, git) {
  return function statFile(p) {
    try {
      if (typeof p !== "string" || !p) return null;
      const target = path.isAbsolute(p) ? p : path.resolve(cwd, p);
      const boundary = git.repoRoot || cwd;
      if (!withinBoundary(target, boundary)) return null;
      if (!withinBoundaryResolved(target, boundary)) return null;
      const stat = fs.statSync(target);
      if (!stat.isFile()) return null;
      return stat.size;
    } catch {
      return null;
    }
  };
}

/**
 * Builds a sandboxed existence check bound to a working directory and, when
 * known, a git repository root — the same boundary {@link makeReadFile}
 * anchors on, but answering "is anything there at all" instead of "what does
 * it contain".
 *
 * The two questions are deliberately kept apart: `fs.existsSync` only stats a
 * path, so it answers `true` for a file that exists but cannot actually be
 * read (a permission failure, in the ordinary case) — exactly the case a
 * `readFile(p) !== null` check would misreport as "absent" if it were reused
 * for existence. `core/lib/write-decode.js#parsePatchSections`'s own header
 * invariant needs that distinction: a genuine `Update File:`/`Delete File:`
 * header naming a file the dispatcher merely cannot read must not be treated
 * the same as one naming a file that was never there at all.
 *
 * @param {string} cwd The working directory a relative path resolves
 * against.
 * @param {{repoRoot: string | null}} git The lazy git state; only its
 * `repoRoot` getter is touched, and only on an actual check.
 * @returns {(p: string) => boolean} A checker that refuses to escape the
 * boundary — including through a symlink or directory junction whose own
 * path lives inside the boundary but resolves outside it — and answers
 * `false` on any failure, including an escape attempt — the same
 * fail-toward-"cannot verify" direction {@link makeReadFile} takes.
 */
function makeFileExists(cwd, git) {
  return function fileExists(p) {
    try {
      if (typeof p !== "string" || !p) return false;
      const target = path.isAbsolute(p) ? p : path.resolve(cwd, p);
      const boundary = git.repoRoot || cwd;
      if (!withinBoundary(target, boundary)) return false;
      if (!fs.existsSync(target)) return false;
      return withinBoundaryResolved(target, boundary);
    } catch {
      return false;
    }
  };
}

/**
 * Builds a reach check bound to the same boundary {@link makeFileExists}
 * anchors on, answering "could this dispatcher have looked at all" rather
 * than "is anything there".
 *
 * {@link makeFileExists} answers `false` to two different questions at once:
 * the path is genuinely absent, and the path lies outside the boundary so
 * nothing can be said about it. Its own doc comment already insists those
 * two must not be conflated, and for reading they are not — but the boolean
 * it returns collapses them anyway, and
 * `core/lib/write-decode.js#parsePatchSections` read that collapsed `false`
 * as "genuinely absent" and declared the whole patch ambiguous.
 *
 * The measured consequence: an agent whose working directory sits outside
 * any repository (or beside one) writing to a legitimate path elsewhere —
 * the memory directory being the everyday case — had every such patch
 * declared undecidable, checked against no rule at all, and reported through
 * the visibility advisory. Worse, an agent reading that advisory as failure
 * re-applied the same patch, appending the content twice.
 *
 * Absence is only evidence of anything when the file could have been seen.
 * This is that precondition, on its own: a purely lexical containment test,
 * with no `existsSync` in it, so it answers for a path that is not there
 * either.
 *
 * @param {string} cwd The working directory a relative path resolves
 * against.
 * @param {{repoRoot: string | null}} git The lazy git state; only its
 * `repoRoot` getter is touched, and only on an actual check.
 * @returns {(p: string) => boolean} `true` when the path resolves inside the
 * boundary, `false` when it escapes it or cannot be resolved at all.
 */
function makeWithinReach(cwd, git) {
  return function withinReach(p) {
    try {
      if (typeof p !== "string" || !p) return false;
      const target = path.isAbsolute(p) ? p : path.resolve(cwd, p);
      return withinBoundary(target, git.repoRoot || cwd);
    } catch {
      return false;
    }
  };
}

/**
 * Resolves a file path to absolute form against a given anchor base,
 * tolerating an already-absolute path (returned unchanged) and any failure
 * (falls back to the raw path).
 *
 * The single place that does this resolution — both `buildContext` itself,
 * for a direct tool call's own `file_path`, and
 * `adapters/shared/dispatch-core.js#buildWriteContext`, for a decoded
 * write's own path, call through here rather than each re-running
 * `path.resolve` on its own. The two callers differ only in which directory
 * they anchor a relative path against: `buildContext` always anchors on
 * `cwd`, while a decoded write anchors on `cwd` or the repository root
 * depending on which envelope shape it came from (`core/lib/write-decode.js`'s
 * own `pathBase` tag) — this function itself is agnostic to that choice, it
 * only ever resolves against whatever `base` it is given.
 *
 * @param {string} base The absolute directory a relative path resolves
 * against.
 * @param {string} rawFilePath The path to resolve, absolute or relative.
 * @returns {string} The absolute path, or `rawFilePath` unchanged when it is
 * falsy or resolution itself throws.
 */
function resolveFilePath(base, rawFilePath) {
  if (!rawFilePath) return rawFilePath;
  try {
    return path.isAbsolute(rawFilePath) ? rawFilePath : path.resolve(base, rawFilePath);
  } catch {
    return rawFilePath;
  }
}

/**
 * Builds the minimal, harmless context returned when construction fails.
 *
 * @returns {object} A frozen context whose fields are all empty, so the
 * engine simply finds nothing to say.
 */
function emptyContext() {
  return Object.freeze({
    event: "",
    agent: "claude",
    toolName: "",
    input: {},
    command: "",
    filePath: "",
    content: "",
    resultingContent: null,
    cwd: "",
    project: { id: "_default", baseBranches: [] },
    git: {
      repoRoot: null,
      branch: null,
      remote: null,
      base: null,
      rebaseInProgress: false,
      staged: () => [],
    },
    session: { model: null, effort: null },
    agentId: null,
    agentType: null,
    sessionId: null,
    modules: new Set(),
    overrides: { forRule: () => ({ action: undefined, allow: [], reason: undefined }), invalid: [], raw: null },
    raw: {},
    readFile: () => null,
    statFile: () => null,
  });
}

/**
 * Builds the frozen evaluation context rules read from.
 *
 * `ctx.cwd` is never simply the host payload's own `cwd` field: it is
 * resolved through `core/lib/workdir.js#resolveWorkdir`, which prefers an
 * absolute `file_path`'s own directory over the payload's `cwd` — so a tool
 * call editing a file in one repository is judged against that repository
 * even when the payload's `cwd` names a different one, or names no
 * repository at all. `ctx.filePath` is always absolute, resolved against
 * that same `ctx.cwd` when the host sent a relative path.
 *
 * A shell command gets the same treatment: when no host field already names
 * an explicit per-call working directory, `core/lib/workdir.js#extractShellWorkdir`
 * is tried against `ctx.command` — anchored on the payload's own `cwd` — and
 * its answer, when it resolves to exactly one directory, is fed in as the
 * same `opCwd` candidate. This is what makes `cd <repo> && <command>` (and
 * the other recognised forms) resolve `project` and `git` against the
 * repository the command actually targets, even from a multi-repository
 * session whose own launch directory is the parent of several repositories
 * and not a repository itself.
 *
 * @param {object} payload The raw host payload.
 * @param {{
 *   agent?: string,
 *   projectsDir?: string,
 *   modules?: string[],
 *   overridesFile?: string
 * }} [options] `agent` names the host (`"claude"` or `"codex"`, default
 * `"claude"`); `projectsDir` and `overridesFile` override the default
 * locations, mainly for tests; `modules` lists enabled module ids.
 * @returns {object} The frozen context. Never throws.
 */
function buildContext(payload, options = {}) {
  try {
    const p = payload && typeof payload === "object" ? payload : {};
    const agent = options.agent === "codex" ? "codex" : "claude";

    const event = firstString(p.hook_event_name, p.hookEventName, p.event, p.event_name);
    const toolName = firstString(p.tool_name, p.toolName, p.tool, p.name);
    const input = pickInput(p);

    const command = pickCommand(input, toolName);
    const rawFilePath = firstString(input.file_path, input.filePath, input.path, input.target_file);
    const content = firstString(input.content, input.new_string, input.newString, input.new_str);

    const payloadCwd = firstString(p.cwd, p.workspace, p.working_directory);
    const explicitOpCwd = firstString(input.workdir, input.cwd, input.working_directory);
    // No host field names the target repository for a shell command — the
    // command text is the only place it is actually written down (a
    // multi-repository session's own launch directory is the parent of
    // several repositories, not one itself). `extractShellWorkdir` is tried
    // only once no explicit host-provided workdir already answers the
    // question, and is anchored on the payload's own cwd — wherever the
    // shell itself actually runs — not on `process.cwd()`, which is this
    // hook process's own directory and unrelated to either.
    const derivedOpCwd = explicitOpCwd ? null : extractShellWorkdir(command, payloadCwd || process.cwd());
    const opCwd = explicitOpCwd || derivedOpCwd || "";
    const cwd = resolveWorkdir({ filePath: rawFilePath, opCwd, payloadCwd });

    // A relative file_path resolves against the anchor `cwd` above, not
    // against the hook process's own inherited directory — the whole point
    // of resolving `cwd` this way is to make that resolution correct even
    // when the host sent no cwd, or sent the wrong repository's cwd.
    const filePath = resolveFilePath(cwd, rawFilePath);

    const project = resolveProject(cwd, { projectsDir: options.projectsDir });
    const base = Array.isArray(project.baseBranches) && project.baseBranches.length ? project.baseBranches[0] : null;
    const git = gitState(cwd, { base });

    const model = firstStringOrNull(
      p.model,
      readPath(p, "session.model"),
      p.session_model,
      process.env.SOFTELA_AI_SESSION_MODEL,
    );
    const effort = firstStringOrNull(
      p.effort,
      p.reasoning_effort,
      readPath(p, "session.effort"),
      readPath(p, "session.reasoning_effort"),
      p.session_effort,
      p.session_reasoning_effort,
      process.env.SOFTELA_AI_SESSION_EFFORT,
    );

    const agentId = firstStringOrNull(p.agent_id, p.agentId);
    const agentType = firstStringOrNull(p.agent_type, p.agentType);
    const sessionId = firstStringOrNull(p.session_id, p.sessionId);

    const modules = new Set(Array.isArray(options.modules) ? options.modules : []);
    const overrides = resolveOverrides(agent, project.id, { file: options.overridesFile });

    return Object.freeze({
      event,
      agent,
      toolName,
      input,
      command,
      filePath,
      content,
      resultingContent: null,
      cwd,
      project,
      git,
      session: { model, effort },
      agentId,
      agentType,
      sessionId,
      modules,
      overrides,
      raw: p,
      readFile: makeReadFile(cwd, git),
      statFile: makeStatFile(cwd, git),
    });
  } catch {
    return emptyContext();
  }
}

// `makeReadFile` is exported alongside `buildContext` because a nested Codex
// `exec` operation resolved against a different repository needs a reader
// bound to THAT repository's boundary, not the outer call's — see
// `adapters/shared/dispatch-core.js#buildOperationContext`. `makeFileExists`
// is exported for the matching reason, one level up: `adapters/shared/
// dispatch-core.js#evaluateDecodedWrites` builds a repo-root-anchored
// existence checker the same way it already builds a repo-root-anchored
// reader, for `core/lib/write-decode.js`'s own header-path invariant.
// `makeStatFile` is exported for the same reason again, one level further:
// `evaluateDecodedWrites` builds a repo-root-anchored size lookup the same
// way, so `core/lib/write-decode.js#applyHunksToFile` can charge a file's own
// size against its reconstruction budget before reading it at all.
// `resolveFilePath` is exported for the matching reason: `buildWriteContext`
// resolves a decoded write's own path against the right anchor without a
// second copy of this logic.
module.exports = { buildContext, makeReadFile, makeFileExists, makeStatFile, makeWithinReach, resolveFilePath };
