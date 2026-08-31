"use strict";

const { PATCH_BLOCK_RE, decodePatchBody, createReconstructBudget } = require("./write-decode");

/**
 * Unwraps a Codex `exec` tool call's JavaScript payload into the individual
 * nested-tool operations it performs.
 *
 * Codex never sends one tool call per operation: it sends a single `exec`
 * call whose input is JavaScript invoking nested tools on a global `tools`
 * object (`tools.shell_command(...)`, `tools.apply_patch(...)`, …). A rule
 * engine that only sees the outer `exec` call never sees any of that, so a
 * rule scoped to a shell command or a file write goes silently inert on this
 * host; this module turns the text back into operations `core/engine.js`
 * already knows how to judge.
 *
 * There is no JavaScript parser among this repository's zero dependencies,
 * so every extraction here is conservative text scanning, in the spirit of
 * `core/lib/shell-parse.js`. A nested tool whose payload cannot be located is
 * reported as `kind: "uninspectable"` rather than dropped — silence there
 * would recreate the exact hole this module closes.
 *
 * A nested `tools.apply_patch(...)` call's own patch envelope is decoded
 * through `core/lib/write-decode.js#decodePatchBody` — the SAME grammar and
 * reconstruction logic a direct `apply_patch` tool call is decoded through
 * (`core/lib/write-decode.js#decodePatchText`), not a second, independent
 * parser. This module's own job is only to locate an envelope's body inside
 * a Codex `exec` call's JavaScript source and unescape it out of whichever JS
 * string literal carries it — everything about what the patch grammar itself
 * means (which header is real, whether an `Update File:`/`Delete File:`
 * header's path actually exists, how a hunk applies) is `write-decode.js`'s
 * call, made once, in one place, for both hosts' indirection paths.
 */

/**
 * Matches a `tools.<identifier>(` call anywhere in the source, capturing the
 * nested tool's own name — the normalised JavaScript identifier Codex
 * exposes each of its real tools under.
 */
const TOOL_CALL_RE = /\btools\.([A-Za-z_$][\w$]*)\s*\(/g;

/**
 * Nested tool identifiers that run a shell command — both the verified
 * `ToolCallKind` serde tag (`exec_command`) and the spelling actually
 * observed in real transcripts (`shell_command`), plus the two host-level
 * names already recognised elsewhere in this repository.
 */
const SHELL_TOOL_NAME_RE = /^(exec_command|shell_command|local_shell|write_stdin)$/i;

/** Nested tool identifiers that write, patch or delete a file. */
const WRITE_TOOL_NAME_RE = /^(apply_patch|edit_file|write_file)$/i;

/**
 * Nested tool identifiers that read as a subagent spawn or an agent-lifecycle
 * operation — the same convention `core/guards/subagent-model.js` and
 * `core/guards/reasoning-effort-floor.js` already use against a host's own
 * `toolName`, reused here against a nested identifier instead.
 */
const SPAWN_TOOL_NAME_RE = /agent|subagent|spawn|delegate/i;

/**
 * Matches a nested `tools.exec(` call site — Codex re-exposing its own
 * indirection tool one level down. Every other category this module
 * recognises is text-scanned across the WHOLE source regardless of nesting
 * depth, so a nested exec's own payload is already picked up for free
 * whenever it is literal text inside the outer source (a string or template
 * literal assigned to a variable, exactly like every other pattern this
 * module already tolerates) — but when the nested call's own argument is
 * itself an opaque expression (built by a function call, read off a
 * variable assigned elsewhere with no literal text in this source at all),
 * nothing about it is visible to text-scanning at all, the same fundamental
 * limit `extractShellOperations` already hits for a dynamically-built shell
 * command. {@link extractOperations} always reports a nested exec call site
 * as `"uninspectable"`, regardless of whether other operations were already
 * found elsewhere in the source — a redundant advisory when the nested
 * payload's own text was already fully visible costs nothing (the advisory
 * is only ever shown when nothing else denied), while omitting it would
 * silently drop the one case that genuinely cannot be inspected.
 */
const NESTED_EXEC_NAME_RE = /^exec$/i;

/**
 * Reverses the small set of backslash escapes a JS string or template
 * literal can carry for the characters this module cares about, so a span
 * sliced straight out of the source text reads the same characters the
 * literal would actually hold at runtime.
 *
 * A real newline already present in the source (inside a template literal
 * spanning several physical lines) passes through unchanged — only an
 * encoded two-character escape sequence is collapsed.
 *
 * @param {string} text A span of raw JavaScript source, still carrying its
 * own escape sequences.
 * @returns {string} The span with `\n`, `\t`, `\r`, `\"`, `\'`, `` \` `` and
 * `\\` resolved to the single character they represent.
 */
function unescapeJsStringSpan(text) {
  return String(text).replace(/\\(n|t|r|"|'|`|\\)/g, (_, ch) => {
    if (ch === "n") return "\n";
    if (ch === "t") return "\t";
    if (ch === "r") return "\r";
    return ch;
  });
}

/**
 * Picks whichever capture group a three-way quote-style alternation
 * (double-quoted, single-quoted, template literal) actually matched.
 *
 * @param {RegExpMatchArray} m A match against a regex built with three
 * parallel capture groups for the three quote styles.
 * @returns {string} The matched literal's raw (still-escaped) content.
 */
function pickQuotedCapture(m) {
  if (m[1] !== undefined) return m[1];
  if (m[2] !== undefined) return m[2];
  return m[3];
}

/**
 * Builds a regex matching a `key: <literal>` object-literal property, in any
 * of the three JS quote styles.
 *
 * @param {string} key The property name, already safe to embed in a regex.
 * @returns {RegExp} A global regex whose capture groups are the double-,
 * single- and backtick-quoted forms in that order.
 */
function colonLiteralRegex(key) {
  return new RegExp(
    `[{,]\\s*${key}\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)'|\`([\\s\\S]*?)\`)`,
    "g",
  );
}

/**
 * Counts how many times a property name appears in an object-literal key
 * position anywhere in the source, regardless of what follows it — the
 * broadest possible signal that a property was mentioned at all, used to
 * detect a value this module could not resolve to a literal.
 *
 * @param {string} source The whole exec call's JavaScript source.
 * @param {string} key The property name, already safe to embed in a regex.
 * @returns {number} How many times the key appears in that position.
 */
function totalKeyMentions(source, key) {
  const m = source.match(new RegExp(`[{,]\\s*${key}\\b`, "g"));
  return m ? m.length : 0;
}

/**
 * Extracts every literal value a property was set to, anywhere in the
 * source — both the direct `key: "value"` object-literal form, and the
 * indirect form a real capture shows: a shorthand property (`{ key, ... }`)
 * referring to a `const key = "value"` declared earlier. Scanning the whole
 * source rather than one call's own arguments is deliberate: this module has
 * no parser to tell which declaration a given call site actually reads, so it
 * takes the same conservative, whole-source approach `shell-parse.js` takes
 * for shell text.
 *
 * @param {string} source The whole exec call's JavaScript source.
 * @param {string} key The property name to look for, already safe to embed
 * in a regex.
 * @returns {string[]} The resolved literal values, unescaped, in the order
 * their occurrences (colon form first, then shorthand) were found. Shorter
 * than {@link totalKeyMentions}'s count whenever a mention could not be
 * resolved to a literal — that gap is what signals an unresolved property.
 */
function extractPropertyLiterals(source, key) {
  const values = [];
  const colonRe = colonLiteralRegex(key);
  let m;
  while ((m = colonRe.exec(source))) {
    values.push(unescapeJsStringSpan(pickQuotedCapture(m)));
  }

  const shorthandCount = (source.match(new RegExp(`[{,]\\s*${key}\\s*[,}]`, "g")) || []).length;
  if (shorthandCount > 0) {
    const declRe = new RegExp(
      `\\b(?:const|let|var)\\s+${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)'|\`([\\s\\S]*?)\`)`,
    );
    const dm = source.match(declRe);
    if (dm) {
      const literal = unescapeJsStringSpan(pickQuotedCapture(dm));
      for (let i = 0; i < shorthandCount; i += 1) values.push(literal);
    }
  }

  return values;
}

/**
 * Collects every `tools.<name>(` call site in the source.
 *
 * @param {string} source The whole exec call's JavaScript source.
 * @returns {string[]} The nested tool identifiers, in call order, one entry
 * per call site (a name invoked twice appears twice).
 */
function findToolCalls(source) {
  const names = [];
  let m;
  TOOL_CALL_RE.lastIndex = 0;
  while ((m = TOOL_CALL_RE.exec(source))) names.push(m[1]);
  return names;
}

/**
 * Extracts one file-write operation per file section found inside every
 * `*** Begin Patch` … `*** End Patch` envelope in the source, wherever it
 * appears — assigned to a variable first and applied indirectly, piped into
 * a shell command, or passed straight to `tools.apply_patch`. The block's
 * marker lines are plain ASCII, so the span between them is located before
 * any unescaping; only the body of one matched block is unescaped, and only
 * once that body is isolated — `write-decode.js#decodePatchBody` itself never
 * sees the raw, still-escaped source.
 *
 * Every isolated body is decoded through the SAME
 * `core/lib/write-decode.js#decodePatchBody` a direct `apply_patch` call's
 * own patch text is decoded through (`write-decode.js#decodePatchText` calls
 * it too), sharing one reconstruction budget across every body found in this
 * source. A body whose own parse comes back ambiguous — an unrecognised
 * `*** `-prefixed line, or an `Update File:`/`Delete File:` header naming a
 * path `pathExists` reports as not actually there — escalates the WHOLE
 * extraction to `{ops: [], ambiguous: true}` rather than trusting a
 * truncated prefix, the same "abort, never guess" rule `decodePatchText`
 * already enforces for a direct call: a phantom header buried anywhere in
 * this source can no longer silently reassign content away from the file it
 * actually belongs to.
 *
 * @param {string} source The whole exec call's JavaScript source.
 * @param {(p: string) => string | null} readFile Reads a file's current
 * content, repo-root-anchored, `null` when it cannot be read.
 * @param {(p: string) => boolean} pathExists Checks whether a path exists on
 * disk, repo-root-anchored — forwarded to every body's own
 * `parsePatchSections` call for its `Update File:`/`Delete File:` existence
 * invariant.
 * @returns {{
 *   ops: Array<{kind: "write", toolName: "apply_patch", filePath: string, content: string | null, action: "add"|"update"|"delete"}>,
 *   ambiguous: boolean,
 * }} `ops` has one entry per named file, in the order its section appears in
 * the envelope; `content` is the reconstructed file — the whole resulting
 * text for an add or an applied update, `null` for a delete or an update
 * whose hunk could not be located — exactly what a direct `apply_patch`
 * call's own `ctx.resultingContent` would hold for the same section (see
 * `write-decode.js#reconstructSection`). `ambiguous` is `true` the moment
 * any body's own parse is ambiguous, in which case `ops` is always `[]` — the
 * caller ({@link extractOperations}) turns that into an `"uninspectable"`
 * file-write operation, never a silent, partial result.
 */
function extractPatchOperations(source, readFile, pathExists, withinReach) {
  const ops = [];
  const budget = createReconstructBudget();
  let blockMatch;
  PATCH_BLOCK_RE.lastIndex = 0;
  while ((blockMatch = PATCH_BLOCK_RE.exec(source))) {
    const body = unescapeJsStringSpan(blockMatch[1]);
    const { ambiguous, entries } = decodePatchBody(body, readFile, pathExists, budget, withinReach);
    if (ambiguous) return { ops: [], ambiguous: true };
    for (const entry of entries) {
      ops.push({ kind: "write", toolName: "apply_patch", filePath: entry.path, content: entry.content, action: entry.kind });
    }
  }
  return { ops, ambiguous: false };
}

/**
 * Extracts one shell operation per `command` literal found in the source,
 * pairing each with the `workdir` literal at the same position when one was
 * found — the working directory that operation actually runs in, and better
 * evidence than the exec call's own outer `cwd`.
 *
 * @param {string} source The whole exec call's JavaScript source.
 * @param {string[]} callNames Every nested tool identifier invoked, from
 * {@link findToolCalls} — used only to label the extracted operations with a
 * real nested tool name.
 * @returns {Array<{kind: "shell", toolName: string, command: string, cwd?: string}>}
 * One operation per resolved `command` literal.
 */
function extractShellOperations(source, callNames) {
  const commands = extractPropertyLiterals(source, "command");
  if (commands.length === 0) return [];
  const workdirs = extractPropertyLiterals(source, "workdir");
  const toolName = callNames.find((n) => SHELL_TOOL_NAME_RE.test(n)) || "shell_command";
  return commands.map((command, i) => {
    const op = { kind: "shell", toolName, command };
    if (workdirs[i] !== undefined) op.cwd = workdirs[i];
    return op;
  });
}

/**
 * Extracts one spawn operation per nested spawn-like call site, carrying
 * whichever of `model`, `reasoning_effort` and `model_reasoning_effort` were
 * resolved to a literal at that position, and reports whether any of those
 * three properties were mentioned somewhere without resolving to one — the
 * signal that a spawn's model or effort could not actually be read, as
 * opposed to a spawn that simply never set one (which is a normal, already
 * meaningful state a subagent-spawn rule handles on its own).
 *
 * @param {string} source The whole exec call's JavaScript source.
 * @param {string[]} callNames Every nested tool identifier invoked, from
 * {@link findToolCalls}.
 * @returns {{ops: Array<{kind: "spawn", toolName: string, input: object}>, unresolved: boolean}}
 * `ops` has one entry per spawn-like call site; `unresolved` is `true` when
 * `model`, `reasoning_effort` or `model_reasoning_effort` was mentioned more
 * often than it could be resolved to a literal.
 */
function extractSpawnOperations(source, callNames) {
  const spawnNames = callNames.filter((n) => SPAWN_TOOL_NAME_RE.test(n));
  if (spawnNames.length === 0) return { ops: [], unresolved: false };

  const models = extractPropertyLiterals(source, "model");
  const efforts = extractPropertyLiterals(source, "reasoning_effort");
  const modelEfforts = extractPropertyLiterals(source, "model_reasoning_effort");

  const unresolved =
    totalKeyMentions(source, "model") > models.length ||
    totalKeyMentions(source, "reasoning_effort") > efforts.length ||
    totalKeyMentions(source, "model_reasoning_effort") > modelEfforts.length;

  const ops = spawnNames.map((toolName, i) => {
    const input = {};
    if (models[i] !== undefined) input.model = models[i];
    if (efforts[i] !== undefined) input.reasoning_effort = efforts[i];
    if (modelEfforts[i] !== undefined) input.model_reasoning_effort = modelEfforts[i];
    return { kind: "spawn", toolName, input };
  });

  return { ops, unresolved };
}

/**
 * Unwraps a Codex `exec` call's JavaScript payload into the operations it
 * performs.
 *
 * Flow:
 * 1. Collect every `tools.<name>(` call site, to know which kinds of nested
 *    tool this call invokes even when its arguments are indirect.
 * 2. Extract every patch envelope into one file-write operation per named
 *    file, every resolvable `command` literal into one shell operation, and
 *    every spawn-like call site into one spawn operation, carrying whatever
 *    of its model/effort could be resolved.
 * 3. For each of the three categories, add one `"uninspectable"` operation
 *    when the source shows unambiguous evidence of that category (a call
 *    site for a shell or write tool, or a `model`/`reasoning_effort`/
 *    `model_reasoning_effort` property mentioned more often than it could be
 *    resolved) but nothing could actually be extracted for it — so a
 *    payload this module cannot see into is reported, never silently
 *    dropped.
 *
 * @param {string} source The raw JavaScript source from an `exec` call's
 * `tool_input`.
 * @param {(p: string) => string | null} [readFile] Reads a file's current
 * content, repo-root-anchored, for reconstructing an `Update File:` section
 * or a rename's destination — forwarded to {@link extractPatchOperations}.
 * Defaults to a reader that always answers `null`, so a caller that never
 * wires up a real one (every unit test exercising the non-patch categories)
 * keeps working; a real `apply_patch` update decoded with no real reader
 * simply reconstructs to `content: null`, never a guess.
 * @param {(p: string) => boolean} [pathExists] Checks whether a path exists
 * on disk, repo-root-anchored, for {@link extractPatchOperations}'s own
 * `Update File:`/`Delete File:` existence invariant. Defaults to a checker
 * that always answers `false` — the fail-safe direction: an `Update File:`/
 * `Delete File:` header this module cannot actually verify is treated as
 * unverifiable, not as verified, so the whole envelope escalates to
 * `"uninspectable"` rather than being silently trusted (`decodePatchBody`'s
 * own ambiguity handling). The real caller
 * (`adapters/shared/dispatch-core.js#evaluateExecCall`) always supplies a
 * real checker instead, built the same way `evaluateDecodedWrites` builds one
 * for the direct `apply_patch` path.
 * @returns {Array<
 *   | {kind: "write", toolName: "apply_patch", filePath: string, content: string | null, action: "add"|"update"|"delete"}
 *   | {kind: "shell", toolName: string, command: string, cwd?: string}
 *   | {kind: "spawn", toolName: string, input: object}
 *   | {kind: "uninspectable", toolName: string, category: "file write"|"shell command"|"subagent spawn"|"nested exec call"}
 * >} The extracted operations, in extraction order: file writes, then shell
 * commands, then spawns, then any uninspectable entries. An empty array when
 * `source` is not a string, is empty, or names no mutating nested tool at
 * all — e.g. a call that only invokes `tools.update_plan`.
 */
function extractOperations(source, readFile, pathExists, withinReach) {
  const src = typeof source === "string" ? source : "";
  if (!src) return [];

  const readFileFn = typeof readFile === "function" ? readFile : () => null;
  const pathExistsFn = typeof pathExists === "function" ? pathExists : () => false;
  // Same default `parsePatchSections` itself takes when a caller passes
  // nothing: everything is in reach, so the existence invariant behaves
  // exactly as it did before this precondition existed.
  const withinReachFn = typeof withinReach === "function" ? withinReach : () => true;

  const callNames = findToolCalls(src);
  const { ops: writeOps } = extractPatchOperations(src, readFileFn, pathExistsFn, withinReachFn);
  const shellOps = extractShellOperations(src, callNames);
  const { ops: spawnOps, unresolved: spawnUnresolved } = extractSpawnOperations(src, callNames);

  const operations = [...writeOps, ...shellOps, ...spawnOps];

  const writeCallNames = callNames.filter((n) => WRITE_TOOL_NAME_RE.test(n));
  if (writeCallNames.length > 0 && writeOps.length === 0) {
    operations.push({ kind: "uninspectable", toolName: writeCallNames[0], category: "file write" });
  }

  const shellCallNames = callNames.filter((n) => SHELL_TOOL_NAME_RE.test(n));
  if (shellCallNames.length > 0 && shellOps.length === 0) {
    operations.push({ kind: "uninspectable", toolName: shellCallNames[0], category: "shell command" });
  }

  if (spawnUnresolved) {
    const spawnName = callNames.find((n) => SPAWN_TOOL_NAME_RE.test(n)) || "spawn_agent";
    operations.push({ kind: "uninspectable", toolName: spawnName, category: "subagent spawn" });
  }

  if (callNames.some((n) => NESTED_EXEC_NAME_RE.test(n))) {
    operations.push({ kind: "uninspectable", toolName: "exec", category: "nested exec call" });
  }

  return operations;
}

module.exports = { extractOperations };
