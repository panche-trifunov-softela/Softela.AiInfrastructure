"use strict";

/**
 * The dispatch logic both host adapters share, so the two hosts cannot drift
 * apart on anything but wire-format serialisation (CONTRACTS §7).
 *
 * Reads the host payload from stdin tolerantly, loads this installation's
 * enabled module set and adapter options from local state, builds the
 * evaluation context, and runs the engine. Performs no output of its own —
 * serialising the decision into a host's wire format is each adapter's own
 * job.
 */

const path = require("path");
const { readJson } = require("../../core/lib/fs-safe");
const { stateDir } = require("../../core/lib/paths");
const { buildContext, makeReadFile, makeFileExists, makeStatFile, makeWithinReach, resolveFilePath } = require("../../core/lib/context");
const engine = require("../../core/engine");
const { severity } = require("../../core/lib/decision");
const { readStdin, parsePayload } = require("../../core/lib/hook-stdin");
const { extractOperations } = require("../../core/lib/codex-exec");
const { resolveWorkdir, extractShellWorkdir } = require("../../core/lib/workdir");
const { resolveProject } = require("../../core/lib/project-resolver");
const { gitState } = require("../../core/lib/git-state");
const { decodeWritesDetailed, isWriteToolName } = require("../../core/lib/write-decode");

/** Matches Codex's own name for the single tool call that wraps every nested operation. */
const EXEC_TOOL_NAME_RE = /^exec$/i;

/** Property names an `exec` call's `tool_input` has been observed, or is documented, to carry its JavaScript source under. */
const EXEC_SOURCE_KEYS = ["input", "script", "code", "source"];

/**
 * Loads this installation's local state: the enabled module set and the
 * adapter options a host-specific dispatcher may need (for example, Codex's
 * `askMode`, CONTRACTS §7).
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @returns {{modules: string[], adapterOptions: object}} Defaults —
 * `{modules: [], adapterOptions: {}}` — when the state file is missing,
 * unreadable, or shaped unexpectedly. Never throws.
 */
function loadState(agent) {
  try {
    const data = readJson(path.join(stateDir(agent), "state.json"));
    const modules = data && Array.isArray(data.modules) ? data.modules : [];
    const adapterOptions =
      data && data.adapterOptions && typeof data.adapterOptions === "object" ? data.adapterOptions : {};
    return { modules, adapterOptions };
  } catch {
    return { modules: [], adapterOptions: {} };
  }
}

/**
 * Writes an engine failure to stderr when `SOFTELA_AI_DEBUG=1` is set, instead
 * of swallowing it silently (CONTRACTS §7a).
 *
 * @param {string} label What was being attempted when the failure happened.
 * @param {*} error The thrown value, or diagnostics collected from the
 * engine.
 * @returns {void}
 */
function debugLog(label, error) {
  if (process.env.SOFTELA_AI_DEBUG !== "1") return;
  try {
    process.stderr.write(`softela-ai dispatch: ${label}: ${error && error.message ? error.message : String(error)}\n`);
  } catch {
    // Debug logging is best-effort only.
  }
}

/**
 * Reads a Codex `exec` call's JavaScript payload out of its tool input,
 * tolerating the field name the same way every other host-payload reader in
 * this repository tolerates a host's own naming variance.
 *
 * @param {object} ctx The evaluation context built from the raw payload.
 * @returns {string} The JavaScript source, or `""` when `ctx` is not an
 * `exec` call on Codex, or carries no readable source under any of
 * {@link EXEC_SOURCE_KEYS}.
 */
function resolveExecSource(ctx) {
  if (ctx.agent !== "codex" || !EXEC_TOOL_NAME_RE.test(String(ctx.toolName || ""))) return "";
  const input = ctx.input && typeof ctx.input === "object" ? ctx.input : {};
  for (const key of EXEC_SOURCE_KEYS) {
    if (typeof input[key] === "string" && input[key]) return input[key];
  }
  return "";
}

/**
 * Resolves the project and git state one extracted operation should be
 * judged against, re-resolving them only when the operation's own anchor —
 * a `write`'s `filePath`, a `shell`'s own `workdir` literal, or a
 * `shell`'s `command` text itself (via `extractShellWorkdir`, when no
 * `workdir` literal was captured) — names a different working directory
 * than the outer `exec` call's own `ctx.cwd`. The overwhelmingly common
 * case (no nested `cwd`/`workdir` at all, and a command naming no
 * directory) reuses `ctx.project` and `ctx.git` unchanged, so it costs no
 * extra git shell-out.
 *
 * @param {object} ctx The outer `exec` call's evaluation context.
 * @param {object} op One non-`"uninspectable"` operation from
 * `core/lib/codex-exec.js#extractOperations`.
 * @returns {{cwd: string, project: object, git: object}} The operation's own
 * resolved working directory, and the project/git resolved against it. Never
 * throws: any failure during re-resolution falls back to inheriting
 * `ctx.cwd`, `ctx.project` and `ctx.git` unchanged.
 */
function resolveOperationAnchor(ctx, op) {
  try {
    const filePath = op.kind === "write" ? op.filePath : undefined;
    const explicitOpCwd = op.kind === "shell" ? op.cwd : undefined;
    // `op.cwd` only exists when the exec source carried a `workdir` literal
    // right alongside the `command` one (`codex-exec.js#extractShellOperations`)
    // — real usage overwhelmingly does not, so the command text itself is
    // the only remaining evidence of which repository this operation
    // targets, anchored on the outer call's own `ctx.cwd`.
    const derivedOpCwd =
      op.kind === "shell" && !explicitOpCwd ? extractShellWorkdir(op.command, ctx.cwd) : null;
    const opCwd = explicitOpCwd || derivedOpCwd || undefined;
    const workdir = resolveWorkdir({ filePath, opCwd, payloadCwd: ctx.cwd });

    if (workdir === ctx.cwd) return { cwd: ctx.cwd, project: ctx.project, git: ctx.git };

    const project = resolveProject(workdir);
    const base = Array.isArray(project.baseBranches) && project.baseBranches.length ? project.baseBranches[0] : null;
    const git = gitState(workdir, { base });
    return { cwd: workdir, project, git };
  } catch {
    return { cwd: ctx.cwd, project: ctx.project, git: ctx.git };
  }
}

/**
 * Builds the context one extracted operation is judged against: the outer
 * `exec` call's own context, with the fields a rule actually reads about the
 * tool call replaced by that operation's own — exactly what `ctx` would hold
 * had this operation arrived as its own direct tool call. `cwd`, `project`
 * and `git` are re-resolved against the operation's own anchor via
 * {@link resolveOperationAnchor}, so a nested operation naming a different
 * repository than the outer call is judged against ITS repository, not the
 * outer call's. When that anchor actually moves, `readFile` is rebuilt
 * against the new boundary too — a reader still sandboxed to the outer
 * repository while every other field describes a different one would let a
 * rule read the wrong tree, or nothing at all.
 *
 * For a `"write"` operation, `op.content` is now the SAME reconstructed
 * evidence a direct `apply_patch` call's own `ctx.resultingContent` would
 * carry for the same section (`core/lib/codex-exec.js#extractPatchOperations`
 * decodes through `core/lib/write-decode.js#decodePatchBody`, the shared
 * parser both paths now go through). `resultingContent` is set here the same
 * way `buildWriteContext` sets it for the direct path, so a document-wide
 * rule (`patch-manifest`'s own pairing ratchet) sees the real reconstructed
 * file through the exec path too, not merely the section's own added lines.
 * `content` falls back to `""` on a `null` reconstruction (a delete, or a
 * hunk that could not be located) — never a guessed string.
 *
 * @param {object} ctx The outer `exec` call's evaluation context.
 * @param {object} op One non-`"uninspectable"` operation from
 * `core/lib/codex-exec.js#extractOperations`.
 * @returns {object} A frozen context, sharing `ctx`'s session, modules,
 * overrides, agent, event and raw payload untouched.
 */
function buildOperationContext(ctx, op) {
  const fields = { toolName: op.toolName, input: {}, command: "", filePath: "", content: "" };

  const anchor = resolveOperationAnchor(ctx, op);

  if (op.kind === "write") {
    // Left exactly as the patch header spelled it, which is relative to the
    // repository root rather than to any working directory. Resolving it
    // against `anchor.cwd` would be wrong the moment those two differ, and
    // `core/lib/stack-resolver.js#relativize` already handles both spellings.
    // See this function's own doc comment for `content`/`resultingContent`.
    const resultingContent = typeof op.content === "string" ? op.content : null;
    fields.input = { file_path: op.filePath, content: resultingContent };
    fields.filePath = op.filePath;
    fields.content = resultingContent !== null ? resultingContent : "";
    fields.resultingContent = resultingContent;
  } else if (op.kind === "shell") {
    fields.input = { command: op.command };
    fields.command = op.command;
  } else if (op.kind === "spawn") {
    fields.input = op.input && typeof op.input === "object" ? op.input : {};
  }

  fields.cwd = anchor.cwd;
  fields.project = anchor.project;
  fields.git = anchor.git;

  // Inheriting the outer call's reader would sandbox a rule's `ctx.readFile`
  // to the outer repository while every other field describes a different
  // one — the reader is rebuilt whenever the anchor actually moved.
  if (anchor.git !== ctx.git) fields.readFile = makeReadFile(anchor.cwd, anchor.git);

  return Object.freeze({ ...ctx, ...fields });
}

/**
 * Describes one operation for the developer, naming the nested tool call
 * that produced it so a denial reads as "this exec call did X", not merely
 * "something in this exec call was denied".
 *
 * @param {object} op The operation a decision was computed for.
 * @returns {string} A short, human-readable description.
 */
function describeOperation(op) {
  if (op.kind === "write") {
    const verb = op.action === "add" ? "adding" : op.action === "delete" ? "deleting" : "updating";
    return `its nested tools.${op.toolName} call ${verb} ${op.filePath}`;
  }
  if (op.kind === "shell") {
    const command = op.command.length > 120 ? `${op.command.slice(0, 120)}…` : op.command;
    return `its nested tools.${op.toolName} call running "${command}"`;
  }
  return `its nested tools.${op.toolName} call`;
}

/**
 * Prefixes a rule's own reason with which nested operation inside the `exec`
 * call actually triggered it, without altering the reason text itself.
 *
 * @param {string} reason The rule's own reason, verbatim.
 * @param {object} op The operation that produced the decision.
 * @returns {string} The composed reason.
 */
function composeNestedReason(reason, op) {
  return `This exec call is denied because ${describeOperation(op)} triggered the following:\n\n${reason}`;
}

/**
 * Composes the advisory note for one or more nested operations whose
 * payload could not be extracted from the `exec` call's script text.
 *
 * @param {Array<{toolName: string, category: string}>} ops The
 * `"uninspectable"` operations to report.
 * @returns {string} The advisory text, naming every affected tool.
 */
function composeUninspectableAdvisory(ops) {
  const named = Array.from(new Set(ops.map((op) => `${op.toolName} (${op.category})`)));
  return (
    `softela-ai: this exec call includes a nested ${named.join(", ")} call whose payload could not be extracted ` +
    "from the script text, so it was not checked against any rule. Review it manually before relying on this call."
  );
}

/**
 * Composes the advisory for a write this dispatcher could not decode into any
 * file — see {@link WRITE_VISIBILITY} for why this is advisory rather than a
 * decision, and what the two kinds mean.
 *
 * The text names which kind it is and what would actually fix it, so the
 * developer is not left guessing whether to look at their patch or at us.
 *
 * @param {string} kind One of {@link WRITE_VISIBILITY}'s own values.
 * @param {string} toolName The host's tool name, named so the note reads as
 * being about a specific call.
 * @returns {string} The advisory text, identical on both hosts.
 */
function composeVisibilityAdvisory(kind, toolName) {
  const detail =
    kind === WRITE_VISIBILITY.ambiguous
      ? "its patch envelope parsed but did not line up with the files on disk — a header naming a file that is not " +
        "there, or a hunk line with no legitimate reading — so the files it would write could not be reconstructed. " +
        "Check the patch against the current contents of the files it targets."
      : "its write payload is not in a shape this dispatcher recognises, so the files it would write could not be " +
        "identified at all. This is a gap in softela-ai rather than in the change itself — it usually means the host " +
        "has started sending its payload under a field name the decoder does not read yet.";
  return (
    `softela-ai (${kind}): this ${toolName} call was NOT checked against any rule, because ${detail} ` +
    "The call itself is not blocked and has already gone through — do NOT re-apply the same patch, which would " +
    "write its content a second time. Do not treat it as having passed review either: read the change back before " +
    "relying on it."
  );
}

/**
 * The two ids a write this dispatcher could not see into is reported under.
 *
 * Neither is a rule. Both name a limit of THIS decoder rather than a mistake
 * in the developer's own work, and they are kept apart because they do not
 * have the same cause and do not have the same fix:
 *
 * - `write-payload-unrecognised` — the payload's own SHAPE matched no
 *   sub-shape `core/lib/write-decode.js` knows. That means the decoder is
 *   behind the host and needs a field name adding. It is exactly what
 *   happened when Codex turned out to send its patch under `command`: every
 *   patch Codex wrote decoded to nothing.
 * - `write-payload-ambiguous` — a patch envelope parsed, but did not add up
 *   against the files on disk: a header naming a file that is not there, or
 *   a hunk line with no legitimate reading. The patch is the thing to look
 *   at, not the decoder.
 *
 * **Both are advisory on both hosts, never blocking.** They used to be
 * synthesised as an `ask`, which Claude Code turned into a prompt and Codex —
 * having no native `ask` — turned into a hard denial that told the developer
 * to run `softela-ai approve` in a second terminal. That denial could not even be
 * lifted: a synthesised decision never reaches `engine.evaluate`, and the
 * approvals gate lives inside it, so the approval was written and then never
 * read. The result was an agent stopped dead by our own blind spot, with the
 * documented way out doing nothing.
 *
 * Blocking was the wrong strength for this in the first place. A rule blocks
 * because the developer's own change needs a second look; nothing here says
 * that. What this needs is to be SEEN — so it is reported through
 * {@link composeVisibilityAdvisory} on both hosts, in the same words, where
 * the developer reads it and the agent is told not to rely on the write
 * having been checked.
 */
const WRITE_VISIBILITY = Object.freeze({
  unrecognised: "write-payload-unrecognised",
  ambiguous: "write-payload-ambiguous",
});

/**
 * Builds the context one decoded write is judged against: the outer call's
 * own context, with `input`, `filePath`, `content` and `resultingContent`
 * replaced by that write's own — exactly what `ctx` would hold had this
 * single file arrived as its own direct `Write`/`Edit` call.
 *
 * `cwd`, `project` and `git` are deliberately reused from the outer context
 * unchanged, not re-resolved: unlike a Codex `exec` call's nested shell
 * operations (`buildOperationContext`, above), every file a single `Write`,
 * `MultiEdit` or `apply_patch` call touches belongs to the one call the
 * outer context was already built for, so there is no second repository to
 * anchor against.
 *
 * `filePath` is always resolved to an absolute path, through the exact same
 * `core/lib/context.js#resolveFilePath` helper `buildContext` itself uses
 * for a direct call's own `file_path` — never a second copy of that logic,
 * and never left as the raw string `write.path` gave (that used to silently
 * break every rule comparing against the repository root the moment the
 * agent's `cwd` was a subdirectory rather than the repository root itself).
 * Which directory a relative `write.path` resolves against depends on
 * `write.pathBase` (`core/lib/write-decode.js`'s own tag): `"cwd"` for a
 * path taken straight off a tool's own payload (`Write`, `Edit`,
 * `MultiEdit`, `NotebookEdit`, and `apply_patch`'s direct `{file_path,
 * content}` shape — every one of these is exactly what a direct `Write`
 * call's own `file_path` would be, cwd-relative); `"repoRoot"` for a path
 * parsed out of a patch envelope's own text (a `*** Update File:` header, a
 * `changes` entry) — conventionally relative to the repository root
 * regardless of which directory the agent process happens to be running in,
 * falling back to `cwd` when the repository root itself is not known.
 * `ctx.input.file_path` keeps `write.path` exactly as decoded, unresolved —
 * mirroring how a direct call's own `ctx.input` always carries the host's
 * raw, unresolved payload while only the top-level `ctx.filePath` is
 * resolved.
 *
 * `content` and `resultingContent` are kept deliberately distinct — see
 * `core/lib/context.js`'s own doc block for the full reasoning. In short:
 * `content` is the text actually inserted (`write.insertedText` when the
 * decoder set one — an `Edit`/`MultiEdit` shape — otherwise the whole
 * reconstructed file, since a `Write` or an `apply_patch` add has only one
 * text to report), so no existing content rule changes what it judges
 * merely because a call arrived through a decoded envelope. `resultingContent`
 * is always the whole reconstructed file, or `null` when it could not be
 * reconstructed, for a rule that genuinely needs to see the file as it will
 * end up.
 *
 * @param {object} ctx The outer call's evaluation context.
 * @param {{path: string, content: string | null, kind: string, pathBase?: "cwd"|"repoRoot", insertedText?: string}} write
 * One decoded write from `core/lib/write-decode.js#decodeWrites`.
 * @returns {object} A frozen context, sharing every other field of `ctx`
 * untouched.
 */
function buildWriteContext(ctx, write) {
  const rawPath = typeof write.path === "string" ? write.path : "";
  const base = write.pathBase === "repoRoot" ? (ctx.git && ctx.git.repoRoot) || ctx.cwd : ctx.cwd;
  const filePath = resolveFilePath(base, rawPath);

  const resultingContent = typeof write.content === "string" ? write.content : null;
  const insertedText = typeof write.insertedText === "string" ? write.insertedText : null;
  const content = insertedText !== null ? insertedText : resultingContent !== null ? resultingContent : "";

  return Object.freeze({
    ...ctx,
    input: { file_path: rawPath, content },
    filePath,
    content,
    resultingContent,
  });
}

/**
 * Builds the pair of repository-root-anchored functions every patch-envelope
 * reconstruction path needs: a reader for a `"repoRoot"`-tagged decoded
 * path's current content, and an existence checker for
 * `core/lib/write-decode.js#parsePatchSections`'s own `Update File:`/
 * `Delete File:` header invariant. Shared by {@link evaluateDecodedWrites}
 * (the direct `apply_patch` path) and {@link evaluateExecCall} (the Codex
 * `exec`-wrapped nested `tools.apply_patch` path) so the two anchor
 * identically rather than each carrying its own copy of this resolution.
 *
 * `ctx.readFile` is anchored on `ctx.cwd` (`core/lib/context.js#makeReadFile`)
 * and is exactly right for a `"cwd"`-tagged decoded path — but a
 * `"repoRoot"`-tagged path (a patch-header path, a `changes` entry) is
 * conventionally relative to the repository root regardless of `cwd`, so
 * reconstructing it through the `cwd`-anchored reader reads the wrong file
 * the moment the agent's own `cwd` is a subdirectory of the repository and a
 * same-named file happens to exist there too. A second reader anchored on the
 * repository root (or on `cwd` itself when the root is not known, matching
 * `buildWriteContext`'s own fallback for `filePath` resolution) keeps the two
 * paths' evidence from ever getting crossed.
 *
 * The existence checker is anchored exactly the same way — the repository
 * root when it is known, `ctx.cwd` otherwise (never left unresolved: a
 * `git.repoRoot === null` session, one working outside any git repository at
 * all, still gets a real, `ctx.cwd`-anchored checker rather than one silently
 * built against `null`) — but answers existence, not content, so a header
 * naming a file that genuinely is not there is told apart from one naming a
 * file this dispatcher merely could not read (a permission failure, a path
 * outside the sandbox boundary) — see `core/lib/context.js#makeFileExists`'s
 * own doc comment for why the two must not be conflated.
 *
 * The size lookup is anchored the same way again, for the matching reason:
 * `ctx.statFile` is anchored on `ctx.cwd` (`core/lib/context.js#makeStatFile`)
 * and is exactly right for a `"cwd"`-tagged decoded path, but a
 * `"repoRoot"`-tagged path needs its OWN size answered against the
 * repository root, not `cwd`, for the same reason `readFileRepoRoot` cannot
 * be `ctx.readFile` reused — `core/lib/write-decode.js#applyHunksToFile`
 * charges this size against its reconstruction budget before reading the
 * file at all, so stat-ing the wrong directory would either miss a real
 * oversized file entirely or wrongly gate an unrelated same-named one.
 *
 * @param {object} ctx The evaluation context to anchor against — the outer
 * call's own `ctx` in both callers.
 * @returns {{readFileRepoRoot: (p: string) => string | null, pathExistsRepoRoot: (p: string) => boolean, withinReachRepoRoot: (p: string) => boolean, statFileRepoRoot: (p: string) => number | null}}
 * The four repository-root-anchored functions.
 */
function buildRepoRootReaders(ctx) {
  const readFileRepoRoot =
    ctx.git && ctx.git.repoRoot ? makeReadFile(ctx.git.repoRoot, ctx.git) : ctx.readFile;
  const pathExistsRepoRoot =
    ctx.git && ctx.git.repoRoot
      ? makeFileExists(ctx.git.repoRoot, ctx.git)
      : makeFileExists(ctx.cwd, ctx.git);
  const withinReachRepoRoot =
    ctx.git && ctx.git.repoRoot
      ? makeWithinReach(ctx.git.repoRoot, ctx.git)
      : makeWithinReach(ctx.cwd, ctx.git);
  const statFileRepoRoot =
    ctx.git && ctx.git.repoRoot ? makeStatFile(ctx.git.repoRoot, ctx.git) : ctx.statFile;
  return { readFileRepoRoot, pathExistsRepoRoot, withinReachRepoRoot, statFileRepoRoot };
}

/**
 * Evaluates a direct write tool call — `Write`, `Edit`, `MultiEdit`,
 * `NotebookEdit` on Claude Code, `apply_patch`/`write_file`/`edit_file` on
 * Codex — by decoding every file it actually writes and running the engine
 * once per file, so a content rule sees real evidence regardless of which
 * envelope the host wrapped the write in (the defect this module exists to
 * close: `apply_patch`'s several observed envelope shapes, and `MultiEdit`'s
 * `edits[]` array, both left `ctx.filePath`/`ctx.content` empty before this).
 *
 * @param {object} ctx The outer call's evaluation context.
 * @param {{diagnostics?: object[]}} options Forwarded to every
 * `engine.evaluate` call.
 * @returns {{handled: boolean, decision: null | {action: string, reason: string, fix?: string, ruleId: string}}}
 * `handled: false` when `ctx.toolName` is not a write-shaped tool at all —
 * the caller must fall back to evaluating `ctx` exactly as it always has,
 * e.g. for a shell or git tool call. `handled: true` otherwise, with
 * `decision` either the strongest decision among every decoded file (`null`
 * when every one of them passed) or, when the payload's own shape inside a
 * recognised write tool could not be decoded into any file at all, a
 * synthesised `ask` naming the tool — never a silent pass, since a write
 * shape this module cannot see into is exactly the failure it exists to end.
 */
function evaluateDecodedWrites(ctx, options) {
  const { readFileRepoRoot, pathExistsRepoRoot, withinReachRepoRoot, statFileRepoRoot } = buildRepoRootReaders(ctx);

  const { writes, ambiguous } = decodeWritesDetailed(ctx.toolName, ctx.input, {
    readFile: ctx.readFile,
    readFileRepoRoot,
    pathExistsRepoRoot,
    withinReachRepoRoot,
    statFile: ctx.statFile,
    statFileRepoRoot,
  });

  if (!Array.isArray(writes) || writes.length === 0) {
    if (!isWriteToolName(ctx.toolName)) return { handled: false, decision: null, advisory: null };
    const kind = ambiguous ? WRITE_VISIBILITY.ambiguous : WRITE_VISIBILITY.unrecognised;
    return { handled: true, decision: null, advisory: composeVisibilityAdvisory(kind, ctx.toolName) };
  }

  if (writes.length === 1) {
    return { handled: true, decision: engine.evaluate(buildWriteContext(ctx, writes[0]), options), advisory: null };
  }

  let best = null;
  for (const write of writes) {
    const decision = engine.evaluate(buildWriteContext(ctx, write), options);
    if (!decision) continue;
    if (!best || severity(decision.action) > severity(best.action)) best = decision;
  }
  return { handled: true, decision: best, advisory: null };
}

/**
 * Evaluates a Codex `exec` call by unwrapping its JavaScript payload into
 * the operations it performs and running the engine once per operation,
 * exactly as it would run once for a single direct tool call.
 *
 * @param {object} ctx The outer `exec` call's evaluation context.
 * @param {string} source The `exec` call's JavaScript source.
 * @param {{diagnostics?: object[]}} options Forwarded to every
 * `engine.evaluate` call.
 * @returns {{decision: null | {action: string, reason: string, fix?: string, ruleId: string}, advisory: null | string}}
 * `decision` is the most severe result among every extracted operation, its
 * reason naming which one produced it — ties broken by extraction order, the
 * same "earliest wins" precedence `core/engine.js` itself uses for rules.
 * `advisory` is set only when nothing denied or asked, and at least one
 * operation could not be extracted at all.
 */
function evaluateExecCall(ctx, source, options) {
  // A nested `tools.apply_patch` call's own envelope is anchored the same
  // way a direct call's is — repository-root-relative — since a write op's
  // own `filePath` is left exactly as its patch header spelled it
  // (`buildOperationContext`'s own doc comment); see {@link buildRepoRootReaders}.
  const { readFileRepoRoot, pathExistsRepoRoot, withinReachRepoRoot } = buildRepoRootReaders(ctx);
  const operations = extractOperations(source, readFileRepoRoot, pathExistsRepoRoot, withinReachRepoRoot);
  const uninspectable = [];
  let best = null;

  for (const op of operations) {
    if (op.kind === "uninspectable") {
      uninspectable.push(op);
      continue;
    }
    const opCtx = buildOperationContext(ctx, op);
    const decision = engine.evaluate(opCtx, options);
    if (!decision) continue;
    if (!best || severity(decision.action) > severity(best.decision.action)) {
      best = { decision, op };
    }
  }

  if (best) {
    return { decision: { ...best.decision, reason: composeNestedReason(best.decision.reason, best.op) }, advisory: null };
  }
  if (uninspectable.length > 0) {
    return { decision: null, advisory: composeUninspectableAdvisory(uninspectable) };
  }
  return { decision: null, advisory: null };
}

/**
 * Runs one full dispatch pass: read stdin, load local state, build the
 * evaluation context, evaluate the rule registry — once for a direct tool
 * call, or once per nested operation when the call is a Codex `exec` call
 * wrapping one or more of them (CONTRACTS §7).
 *
 * @param {{agent: string}} options `agent` is `"claude"` or `"codex"`;
 * anything else resolves to Claude's context shape.
 * @returns {Promise<{decision: null | {action: string, reason: string, fix?: string, ruleId: string}, ctx: object, advisory: null | string}>}
 * The engine's decision, the context it was computed from, and — Codex
 * `exec` calls only — an advisory note when a nested operation could not be
 * inspected but nothing else denied. Never throws — any failure surfaces as
 * a pass decision over a minimal context, per CONTRACTS §7a's fail-open
 * requirement.
 */
async function runDispatch(options) {
  const agent = options && options.agent === "codex" ? "codex" : "claude";

  try {
    const raw = await readStdin();
    const payload = parsePayload(raw);
    const state = loadState(agent);
    const ctx = buildContext(payload, { agent, modules: state.modules });

    const diagnostics = [];
    let decision = null;
    let advisory = null;
    try {
      const execSource = resolveExecSource(ctx);
      if (execSource) {
        const result = evaluateExecCall(ctx, execSource, { diagnostics });
        decision = result.decision;
        advisory = result.advisory;
      } else {
        // A direct write call is decoded and evaluated per-file before
        // falling back to the plain single-context evaluation every other
        // tool call already gets. Wrapped in its own try/catch, separate
        // from the outer one below: any failure anywhere in decoding or in
        // evaluating a decoded write must degrade to running `engine.evaluate`
        // on `ctx` exactly as it always has — today's behaviour — never to an
        // `ask` and never to a crash (CONTRACTS §7a).
        let writeResult = { handled: false, decision: null, advisory: null };
        try {
          writeResult = evaluateDecodedWrites(ctx, { diagnostics });
        } catch (error) {
          debugLog("write-decode threw", error);
          writeResult = { handled: false, decision: null, advisory: null };
        }
        decision = writeResult.handled ? writeResult.decision : engine.evaluate(ctx, { diagnostics });
        // A write this dispatcher could not see into reports through the same
        // advisory channel a nested `exec` operation already does, rather than
        // through a decision — see {@link WRITE_VISIBILITY}.
        if (writeResult.handled && !decision) advisory = writeResult.advisory || null;
      }
    } catch (error) {
      debugLog("engine threw", error);
      decision = null;
      advisory = null;
    }
    if (diagnostics.length) {
      for (const d of diagnostics) debugLog(`rule ${d.ruleId} threw`, d.error);
    }

    // Distinct from the diagnostics above: those are rules that loaded fine
    // but threw while *evaluating* this one call. This is the registry
    // itself failing to *load* one or more rule modules at all — silent
    // otherwise, since a fail-open dispatch still returns `pass` either way
    // (CONTRACTS.md §7a). `SOFTELA_AI_DEBUG=1` is the only place this ever
    // surfaces outside `softela-ai doctor`.
    const registryStatus = engine.ruleRegistryStatus();
    if (registryStatus.loadErrors.length) {
      for (const e of registryStatus.loadErrors) {
        debugLog(`rule registry: skipped ${e.file || "(directory listing itself)"}`, e.error);
      }
    }

    return { decision, ctx, advisory };
  } catch (error) {
    debugLog("dispatch failed, passing", error);
    return { decision: null, ctx: buildContext({}, { agent }), advisory: null };
  }
}

// `buildOperationContext`, `evaluateExecCall`, `buildWriteContext` and
// `evaluateDecodedWrites` are exported alongside the module's own public
// surface purely so a test can exercise a nested operation's re-resolved
// project/git, or a decoded write's per-file evaluation, directly — without
// spawning a real dispatcher process. None of the four is meant to be called
// by a host adapter.
module.exports = {
  runDispatch,
  readStdin,
  parsePayload,
  loadState,
  buildOperationContext,
  evaluateExecCall,
  buildWriteContext,
  evaluateDecodedWrites,
};
