"use strict";

/**
 * Builds the `softela-ai doctor` report (INSTALLER.md §8).
 *
 * Reads, never writes. Every section is best-effort: a piece that cannot be
 * read is reported as unknown rather than making the whole command fail —
 * `doctor`'s entire job is to be trustworthy when something else on the
 * machine is not.
 */

const fs = require("fs");
const path = require("path");
const { readJson, readText } = require("../lib/fs-safe");
const paths = require("../lib/paths");
const approvals = require("../lib/approvals");
const detect = require("./detect");
const sj = require("./settings-json");
const st = require("./settings-toml");
const { tierOf, TIERS } = require("../lib/model-tiers");
const { FALLBACK_MODEL_IDS } = require("../lib/codex-models");
const { classifyOverrideEntry } = require("../lib/override-resolver");
const tty = require("./tty");
const engine = require("../engine");

/**
 * The Codex hook-trust caveat, stated verbatim by both the install/update
 * printer (IMPORTANT I2) and `doctor` — except where `doctor`'s own
 * "hooks awaiting approval" finding already said the same thing, so a
 * developer reading the unapproved-hooks case is not told it twice. A single
 * source of truth so the two printers can never drift apart into
 * contradicting each other.
 *
 * Per-hook trust is recorded in plain, readable TOML — `~/.codex/config.toml`,
 * under a `[hooks.state]` table, one entry per `<hooks.json path>:<event in
 * snake_case>:<matcher-group index>:<hook index>`, each carrying
 * `trusted_hash = "sha256:..."` — not an opaque state database. What remains
 * genuinely unasserted is narrower: an entry only proves a hook at *some*
 * hash was once trusted; confirming it is the *currently installed* hook
 * would mean reproducing Codex's own hashing function over the hook entry,
 * which has not been done.
 */
const CODEX_TRUST_CAVEAT =
  "hooks are installed but Codex will not run them until a human completes the one-time hook-trust review; per-hook trust is recorded in ~/.codex/config.toml's [hooks.state] table, but confirming the currently installed hook matches a trusted entry there would require reproducing Codex's own hashing function, which has not been done — so trust is not asserted either way.";

/**
 * JSON Schema keywords `validateAgainst` implements: `type`, `required`,
 * `properties`, `additionalProperties` (boolean or nested schema),
 * `propertyNames`, `items`, `enum`, `minLength`, `minimum`, `minItems`,
 * `$ref`, `oneOf`. There is no schema library among this repository's zero
 * dependencies; this is the exact set `project.schema.json` and
 * `overrides.schema.json` currently use.
 */
const HANDLED_SCHEMA_KEYWORDS = new Set([
  "type",
  "required",
  "properties",
  "additionalProperties",
  "propertyNames",
  "items",
  "enum",
  "minLength",
  "minimum",
  "minItems",
  "$ref",
  "oneOf",
]);

/**
 * JSON Schema keywords that describe a schema without constraining any
 * value they sit next to, so `findUnhandledSchemaKeywords` treats them as
 * safely skippable rather than reporting a validation gap.
 */
const NON_CONSTRAINING_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "$defs",
  "definitions",
]);

/**
 * JSON Schema keywords that nest further subschemas, and how to reach the
 * nested schema value(s) from the keyword's own value — used only by
 * `findUnhandledSchemaKeywords` to keep walking the schema tree past a
 * keyword it does not otherwise recognize (e.g. `patternProperties`, which
 * `validateAgainst` does not implement but which still nests schemas worth
 * walking into).
 */
const SCHEMA_CONTAINER_KEYWORDS = {
  properties: (v) => (v && typeof v === "object" ? Object.values(v) : []),
  patternProperties: (v) => (v && typeof v === "object" ? Object.values(v) : []),
  definitions: (v) => (v && typeof v === "object" ? Object.values(v) : []),
  $defs: (v) => (v && typeof v === "object" ? Object.values(v) : []),
  additionalProperties: (v) => (v && typeof v === "object" ? [v] : []),
  additionalItems: (v) => (v && typeof v === "object" ? [v] : []),
  propertyNames: (v) => (v && typeof v === "object" ? [v] : []),
  items: (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : []),
  oneOf: (v) => (Array.isArray(v) ? v : []),
  anyOf: (v) => (Array.isArray(v) ? v : []),
  allOf: (v) => (Array.isArray(v) ? v : []),
  not: (v) => (v && typeof v === "object" ? [v] : []),
};

/**
 * Walks an entire schema document (not a value being validated) and reports
 * every JSON Schema keyword it uses that `validateAgainst` neither
 * implements nor treats as non-constraining metadata — so a keyword this
 * validator cannot check is surfaced in `doctor`'s own output instead of
 * silently passing everything nested under it. Chosen over implementing
 * every keyword speculatively: this repository's schema does not currently
 * use `anyOf`, `allOf`, `not`, `patternProperties`, `additionalItems`,
 * `const`, `maximum`, `maxLength`, `pattern`, `format`, or `uniqueItems`, so
 * adding validation logic for them now would be untested against any real
 * shipped schema; visibility now, implementation when the schema actually
 * needs it.
 *
 * Flow:
 * - Only descends through a key listed in `SCHEMA_CONTAINER_KEYWORDS`, so an
 *   arbitrary property NAME a schema author defined (e.g. this schema's own
 *   `"pattern"` property under `commands.forbidden.items.properties`) is
 *   never mistaken for a schema keyword — only schema VALUES reached
 *   through a known container keyword are walked.
 * - Never resolves `$ref` pointers; it walks the schema's own literal JSON
 *   structure, which is finite by construction (unlike a `$ref` chain), so
 *   no cycle guard is needed here.
 *
 * @param {*} schema Any JSON value reachable while walking the schema tree.
 * @param {Set<string>} [found] Accumulator, mutated in place across the walk.
 * @returns {string[]} Sorted, de-duplicated keyword names found unhandled.
 */
function findUnhandledSchemaKeywords(schema, found = new Set()) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [...found].sort();

  for (const key of Object.keys(schema)) {
    if (!HANDLED_SCHEMA_KEYWORDS.has(key) && !NON_CONSTRAINING_SCHEMA_KEYWORDS.has(key)) {
      found.add(key);
    }
    const getNested = SCHEMA_CONTAINER_KEYWORDS[key];
    if (getNested) for (const sub of getNested(schema[key])) findUnhandledSchemaKeywords(sub, found);
  }
  return [...found].sort();
}

/**
 * Resolves a local (same-document) JSON-Pointer `$ref` against a root
 * schema: a bare `#`, or `#/a/b/c` with RFC 6901 `~1` (`/`) and `~0` (`~`)
 * segment escapes decoded. This repository's schemas never reference an
 * external file, so no other `$ref` form is supported.
 *
 * @param {string} ref The `$ref` string to resolve.
 * @param {*} root The root schema document to resolve `ref` against.
 * @returns {*} The referenced (sub)schema, or `undefined` when `ref` is not
 * a local pointer this function understands, or the pointer does not
 * resolve to anything reachable from `root`.
 */
function resolveRef(ref, root) {
  if (typeof ref !== "string" || !ref.startsWith("#")) return undefined;
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;

  const segments = ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));

  let cur = root;
  for (const segment of segments) {
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, segment)) {
      return undefined;
    }
    cur = cur[segment];
  }
  return cur;
}

/**
 * Validates a value against a `oneOf` keyword's branches, requiring exactly
 * one to match — and when that fails, builds a message a developer can act
 * on without reading the schema themselves: which branches matched when
 * there were too many, or what each branch rejected when there were none.
 *
 * @param {object[]} branches The `oneOf` subschemas.
 * @param {*} value The value under validation.
 * @param {string} at A dotted path, for error messages.
 * @param {*} root The root schema, threaded through for `$ref` resolution
 * inside a branch.
 * @param {Set<string>} seenRefs The `$ref` pointers already being resolved
 * on the current path, threaded through for cycle detection inside a branch.
 * @returns {string[]} Empty when exactly one branch matches; one message
 * otherwise.
 */
function validateOneOf(branches, value, at, root, seenRefs) {
  const results = branches.map((branch, index) => ({
    index,
    errors: validateAgainst(branch, value, at, root, seenRefs),
  }));
  const matched = results.filter((r) => r.errors.length === 0);

  if (matched.length === 1) return [];
  if (matched.length > 1) {
    const indices = matched.map((r) => r.index).join(", ");
    return [
      `${at}: value ${JSON.stringify(value)} matches ${matched.length} oneOf branches (${indices}) — schema is ambiguous, expected exactly one`,
    ];
  }
  const reasons = results.map((r) => `branch ${r.index} — ${r.errors.join("; ") || "no further detail"}`).join(" | ");
  return [`${at}: value ${JSON.stringify(value)} matches none of the ${branches.length} oneOf branches (${reasons})`];
}

/**
 * Validates a value against the small subset of JSON Schema this
 * repository's own schemas use — see {@link HANDLED_SCHEMA_KEYWORDS} for the
 * exact list, and {@link findUnhandledSchemaKeywords} for how a keyword
 * outside that list is surfaced instead of silently skipped.
 *
 * `$ref` handling follows the schema's own declared `$schema`: this
 * repository's schema declares draft-07, where sibling keywords beside
 * `$ref` are ignored, so a resolved `$ref` is the whole story for that
 * schema node. A schema with no `$schema` declaration is treated as
 * 2020-12 instead — where `$ref` siblings ARE applied — since that is the
 * stricter reading, and stricter is the safe direction for a validator
 * whose failure mode is a false "valid".
 *
 * Cycle guard: a `Set` of the `$ref` pointer strings already being resolved
 * on the current path (not a global depth counter), so `A -> B -> A` is
 * caught the moment the path repeats a pointer, without capping legitimate
 * non-cyclic nesting at an arbitrary depth.
 *
 * @param {object} schema The (sub-)schema to validate against.
 * @param {*} value The value to validate.
 * @param {string} at A dotted path, for error messages.
 * @param {object} [root] The root schema `$ref` pointers resolve against;
 * defaults to `schema` itself, which is correct for a top-level call.
 * @param {Set<string>} [seenRefs] The `$ref` pointers already being
 * resolved on the current path; defaults to empty.
 * @returns {string[]} One message per violation found; empty when valid.
 */
function validateAgainst(schema, value, at, root = schema, seenRefs = new Set()) {
  const errors = [];
  if (!schema || typeof schema !== "object") return errors;

  if (typeof schema.$ref === "string") {
    if (seenRefs.has(schema.$ref)) {
      return [`${at}: $ref cycle detected — "${schema.$ref}" is already being resolved on this path`];
    }
    const resolved = resolveRef(schema.$ref, root);
    if (resolved === undefined) return [`${at}: unresolvable $ref "${schema.$ref}"`];

    const draft = schema.$schema || root.$schema;
    const siblingKeys = Object.keys(schema).filter((k) => k !== "$ref");
    const applySiblings = draft ? !String(draft).includes("draft-07") : true;

    const nextSeen = new Set(seenRefs);
    nextSeen.add(schema.$ref);
    const refErrors = validateAgainst(resolved, value, at, root, nextSeen);
    if (!applySiblings || siblingKeys.length === 0) return refErrors;

    const siblingSchema = { ...schema };
    delete siblingSchema.$ref;
    return [...refErrors, ...validateAgainst(siblingSchema, value, at, root, seenRefs)];
  }

  if (schema.type === "object" && (typeof value !== "object" || value === null || Array.isArray(value))) {
    return [`${at}: expected an object`];
  }
  if (schema.type === "array" && !Array.isArray(value)) return [`${at}: expected an array`];
  if (schema.type === "string" && typeof value !== "string") return [`${at}: expected a string`];
  if (schema.type === "integer" && !Number.isInteger(value)) return [`${at}: expected an integer`];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`);
  if (schema.minLength !== undefined && typeof value === "string" && value.length < schema.minLength) {
    errors.push(`${at}: must be at least ${schema.minLength} characters`);
  }
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) {
    errors.push(`${at}: must be at least ${schema.minimum}`);
  }
  if (schema.minItems !== undefined && Array.isArray(value) && value.length < schema.minItems) {
    errors.push(`${at}: must have at least ${schema.minItems} item(s)`);
  }
  if (Array.isArray(schema.oneOf)) {
    errors.push(...validateOneOf(schema.oneOf, value, at, root, seenRefs));
  }

  if (schema.type === "object" && value && typeof value === "object") {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${at}: missing required property "${key}"`);
    }
    if (schema.propertyNames) {
      for (const key of Object.keys(value)) {
        errors.push(...validateAgainst(schema.propertyNames, key, `${at}.${key}`, root, seenRefs));
      }
    }
    const known = schema.properties ? Object.keys(schema.properties) : [];
    for (const key of Object.keys(value)) {
      if (schema.properties && known.includes(key)) {
        errors.push(...validateAgainst(schema.properties[key], value[key], `${at}.${key}`, root, seenRefs));
      } else if (schema.additionalProperties === false) {
        errors.push(`${at}.${key}: unexpected property`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validateAgainst(schema.additionalProperties, value[key], `${at}.${key}`, root, seenRefs));
      }
    }
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validateAgainst(schema.items, item, `${at}[${i}]`, root, seenRefs)));
  }

  return errors;
}

/**
 * Validates every `projects/*.json` file this installation ships against
 * `project.schema.json`.
 *
 * @returns {{file: string, errors: string[]}[]} One entry per file that
 * failed validation or could not be parsed; an empty array when every
 * project file is valid.
 */
function validateProjectConfigs() {
  const projectsDir = path.join(paths.repoRoot(), "projects");
  const schema = readJson(path.join(paths.repoRoot(), "core", "schema", "project.schema.json"));
  let files;
  try {
    files = fs.readdirSync(projectsDir).filter((f) => f.toLowerCase().endsWith(".json"));
  } catch {
    return [];
  }

  const results = [];
  for (const file of files) {
    const data = readJson(path.join(projectsDir, file));
    if (!data) {
      results.push({ file, errors: ["could not be parsed as JSON"] });
      continue;
    }
    const errors = schema ? validateAgainst(schema, data, file) : [];
    if (errors.length) results.push({ file, errors });
  }
  return results;
}

/**
 * Reports every JSON Schema keyword `project.schema.json` itself uses that
 * `validateAgainst` does not implement, so a validation gap in the schema is
 * visible in `doctor`'s own output rather than silently passing everything
 * nested under that keyword.
 *
 * @returns {string[]} Sorted, de-duplicated keyword names; empty when the
 * schema is unreadable, or uses nothing this validator does not handle.
 */
function unhandledSchemaKeywords() {
  const schema = readJson(path.join(paths.repoRoot(), "core", "schema", "project.schema.json"));
  if (!schema) return [];
  return findUnhandledSchemaKeywords(schema);
}

/**
 * Reports every override found in an already-parsed overrides object,
 * resolved against the rule registry rather than echoed verbatim — the
 * single place that reads the `rules` / `projects.<id>.rules` shape, so both
 * `doctor` and `softela-ai override --list`/`--undo` read the exact same fields
 * that `core/lib/override-resolver.js` resolves at evaluation time, instead
 * of each inventing its own.
 *
 * Per CONTRACTS.md §6 ("Invalid patterns are ignored and reported by
 * doctor, never thrown"), every entry is classified by
 * `override-resolver.js#classifyOverrideEntry` into one of three states —
 * `"effective"`, `"ignored"` (targets a `mandatory` rule the engine never
 * consults), or `"invalid"` (an unknown rule id, a wrong-typed field, or a
 * regex that never compiles) — instead of being listed as an
 * undifferentiated, apparently-working override regardless of whether the
 * engine actually does anything with it.
 *
 * @param {object | null} raw The parsed content of an `overrides.json` file,
 * or `null` when it is absent, unreadable or malformed.
 * @returns {{scope: string, ruleId: string, action?: string, allow?: string[], reason?: string, setAt?: string, state: "effective"|"ignored"|"invalid", problems: string[]}[]}
 * One entry per rule carrying an override, global or per-project; an empty
 * array when `raw` is not a usable object.
 */
function listOverridesFromRaw(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out = [];
  for (const [ruleId, entry] of Object.entries(raw.rules || {})) {
    out.push(describeOverrideEntry("global", ruleId, entry));
  }
  for (const [projectId, projectEntry] of Object.entries(raw.projects || {})) {
    for (const [ruleId, entry] of Object.entries((projectEntry && projectEntry.rules) || {})) {
      out.push(describeOverrideEntry(`project:${projectId}`, ruleId, entry));
    }
  }
  return out;
}

/**
 * Builds one `listOverridesFromRaw` entry: the raw fields a hand-edited
 * file wrote, plus the classification `core/lib/override-resolver.js`
 * computes against the rule registry.
 *
 * @param {string} scope `"global"` or `"project:<id>"`.
 * @param {string} ruleId The rule id the entry is written against.
 * @param {*} entry The raw entry, of whatever shape a hand-edited file wrote.
 * @returns {{scope: string, ruleId: string, action?: string, allow?: string[], reason?: string, setAt?: string, state: "effective"|"ignored"|"invalid", problems: string[]}}
 * One entry, ready to append to a report.
 */
function describeOverrideEntry(scope, ruleId, entry) {
  const safe = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
  const { state, problems } = classifyOverrideEntry(ruleId, entry);
  return { scope, ruleId, action: safe.action, allow: safe.allow, reason: safe.reason, setAt: safe.setAt, state, problems };
}

/**
 * Reports every override, for `doctor`'s "a machine that has quietly
 * disabled half the rule set should be obvious" requirement.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @returns {{scope: string, ruleId: string, action?: string, allow?: string[], reason?: string, setAt?: string, state: "effective"|"ignored"|"invalid", problems: string[]}[]}
 * One entry per rule carrying an override, global or per-project; an empty
 * array when the overrides file is absent, unreadable, or empty.
 */
function listOverrides(agent) {
  return listOverridesFromRaw(readJson(paths.overridesPath(agent)));
}

/**
 * Validates an agent's `overrides.json` (when present and parseable)
 * against `overrides.schema.json` — the file's own declared shape, which
 * was never referenced anywhere in this repository before this check
 * existed. This is independent of {@link classifyOverrideEntry}'s per-rule
 * classification: the schema catches a malformed document shape (e.g. an
 * unexpected top-level key, `rules` written as an array), while
 * classification catches domain concerns the schema cannot know about (a
 * rule id that is not registered, a rule that is `mandatory`).
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @returns {string[]} Schema violation messages; empty when the file is
 * absent, unparseable (already surfaced as "unknown rule id" style noise
 * would be misleading here, so this is silently skipped — a malformed JSON
 * file is a read failure, not a shape failure), or shape-valid.
 */
function validateOverridesConfig(agent) {
  const raw = readJson(paths.overridesPath(agent));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const schema = readJson(path.join(paths.repoRoot(), "core", "schema", "overrides.schema.json"));
  if (!schema) return [];
  return validateAgainst(schema, raw, "overrides");
}

/**
 * Decides whether a seed setting's current value differs from what the
 * module shipped, comparing with the current value's type in mind: `raw`
 * (from `settings-toml.js#readKeyValue`) is always text, while `shipped` may
 * be a string, a boolean, or a number.
 *
 * @param {*} shipped The value the module ships.
 * @param {string} raw The current value's exact text, as TOML wrote it.
 * @returns {boolean} `true` when the two disagree.
 */
function seedValueChanged(shipped, raw) {
  return typeof shipped === "string" ? raw !== shipped : raw !== String(shipped);
}

/**
 * Reports seed settings whose current value no longer matches the default
 * an enabled module shipped — a developer's own deliberate choice, not a
 * problem, but one `doctor` names rather than hides.
 *
 * For a Codex entry that declares `tier` rather than a literal `value`,
 * `shipped` reports that tier's entry in `codex-models.js#FALLBACK_MODEL_IDS`
 * — the one stable, named constant this repository ships — rather than
 * whatever id a fresh install would actually resolve to right now. The two
 * can differ once a newer Codex binary is installed; `doctor` stays
 * deterministic and machine-independent by design rather than re-running the
 * binary scan on every invocation for a field that is already informational.
 *
 * A Codex value is read through `settings-toml.js#readKeyValue`, the same
 * confidence-checked reader `readEffectiveModelInfo` already uses — a
 * pointer this reader cannot follow confidently, or does not find present,
 * is skipped rather than guessed at, exactly like the Claude side skips a
 * pointer `settings-json.js#hasPointer` reports absent.
 *
 * @param {object} ctx A gathered context (`detect.js#gather`).
 * @returns {{module: string, pointer: string, shipped: *, current: *}[]}
 * One entry per seed setting that is present with a genuinely different
 * value than the module ships, for either agent.
 */
function listChangedSeedSettings(ctx) {
  const out = [];
  for (const mod of ctx.enabledModules) {
    for (const entry of Array.isArray(mod.json.settings) ? mod.json.settings : []) {
      if (!entry || entry.agent !== ctx.agent || entry.mode !== "seed") continue;
      const shipped = Object.prototype.hasOwnProperty.call(entry, "tier") ? FALLBACK_MODEL_IDS[entry.tier] : entry.value;
      let current;
      if (ctx.agent === "codex") {
        if (!ctx.configToml || ctx.configToml.content === null) continue;
        const result = st.readKeyValue(ctx.configToml.content, entry.pointer);
        if (!result.confident || !result.present) continue;
        current = result.raw;
        if (!seedValueChanged(shipped, current)) continue;
      } else {
        if (!sj.hasPointer(ctx.settings.content, entry.pointer)) continue;
        current = sj.getPointer(ctx.settings.content, entry.pointer);
        if (current === shipped) continue;
      }
      out.push({ module: mod.id, pointer: entry.pointer, shipped, current });
    }
  }
  return out;
}

/**
 * Reports every configured Codex model pointer (`/model`,
 * `/agents/default_subagent_model`) whose present value carries no tier
 * token `model-tiers.js#tierOf` recognises — an id this infrastructure
 * cannot place on the frontier/balanced/cheap scale silently disables both
 * the subagent-model guard and the reasoning-effort-floor guard, since each
 * compares tiers and a `null` tier never matches or violates anything.
 * Informational only: this never drives `doctor`'s exit code, the same way
 * `changedSeedSettings` does not — a developer running an id this
 * infrastructure does not yet know about is not itself a failure.
 *
 * @param {object} ctx A gathered context (`detect.js#gather`) for one agent.
 * @returns {{pointer: string, value: string}[]} One entry per configured
 * pointer whose value is present and confidently read but resolves to no
 * known tier; empty for a non-Codex agent, an absent `config.toml`, an
 * unparseable one, an absent pointer, or a pointer whose tier IS recognised.
 */
function listUnrecognizedTierModels(ctx) {
  if (ctx.agent !== "codex" || !ctx.configToml || ctx.configToml.content === null) return [];
  const out = [];
  for (const pointer of ["/model", "/agents/default_subagent_model"]) {
    const result = st.readKeyValue(ctx.configToml.content, pointer);
    if (!result.confident || !result.present || typeof result.raw !== "string") continue;
    if (tierOf(result.raw) === null) out.push({ pointer, value: result.raw });
  }
  return out;
}

/**
 * Lists every host event this installation has an `enforce`-mode softela-ai hook
 * registered for, deduplicated — the raw material {@link buildParityReport}
 * compares by job rather than by event spelling (see {@link HOOK_EVENT_JOBS}).
 *
 * Read from the manifest rather than re-scanning the settings file directly:
 * the manifest already IS this installer's own record of what it registered
 * (INSTALLER.md §4), and unlike a settings-file scan it cannot mistake a
 * developer's own foreign hook under the same event for one of ours.
 *
 * @param {object} ctx A gathered context (`detect.js#gather`).
 * @returns {string[]} Sorted, de-duplicated event names; empty when nothing
 * is installed yet or nothing carries an `enforce`-mode registration.
 */
function listRegisteredHookEvents(ctx) {
  const events = new Set();
  for (const s of (ctx.manifest && ctx.manifest.settings) || []) {
    if (s.mode === "enforce" && typeof s.event === "string") events.add(s.event);
  }
  return [...events].sort();
}

/**
 * Reads the effective main model and, where the host has one, the effective
 * main-session reasoning effort — both read straight off the host's own
 * config, never off what a module would seed, so a developer's own override
 * of either is what parity actually compares.
 *
 * @param {object} ctx A gathered context (`detect.js#gather`).
 * @returns {{model: string | null, reasoningEffort: string | null}} `model`
 * is Claude Code's `/model` pointer in `settings.json`, or Codex's `/model`
 * key in `config.toml`; `null` when absent or the file cannot be read
 * confidently. `reasoningEffort` is Codex's `/model_reasoning_effort` key;
 * always `null` for Claude Code, which has no persisted equivalent setting —
 * {@link buildParityReport} treats that absence as structural, not a
 * mismatch.
 */
function readEffectiveModelInfo(ctx) {
  if (ctx.agent === "codex") {
    if (!ctx.configToml || ctx.configToml.content === null) return { model: null, reasoningEffort: null };
    const modelResult = st.readKeyValue(ctx.configToml.content, "/model");
    const effortResult = st.readKeyValue(ctx.configToml.content, "/model_reasoning_effort");
    return {
      model: modelResult.confident && modelResult.present && typeof modelResult.raw === "string" ? modelResult.raw : null,
      reasoningEffort: effortResult.confident && effortResult.present && typeof effortResult.raw === "string" ? effortResult.raw : null,
    };
  }
  const value = sj.hasPointer(ctx.settings.content, "/model") ? sj.getPointer(ctx.settings.content, "/model") : null;
  return { model: typeof value === "string" ? value : null, reasoningEffort: null };
}

/**
 * Builds the full doctor report for one agent.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @param {string | null} repoVersion This repository's own version, or
 * `null` when neither a source `package.json` nor an installed `VERSION`
 * marker could be read (IMPORTANT I5) — there is genuinely nothing to
 * compare the installed version against.
 * @returns {object} Everything `formatDoctorReport` renders: installed
 * state (recovered from on-disk content, via `manifestUnreadable`, when
 * `manifest.json` itself could not be read), drift, overrides (each
 * classified effective/ignored/invalid), any overrides.json shape errors,
 * approvals, modules, any configured Codex model carrying an unrecognised
 * tier token, and the Codex trust caveat.
 */
/**
 * Decides whether a Codex `config.toml` is in a state this tool can seed
 * into, across the three states `detect.js#gather` can report:
 *
 * - absent (`exists: false`) — healthy. A `seed` creates the file, so there
 *   is nothing to warn about and nothing that could be overwritten.
 *
 * - present and parseable — healthy, the ordinary case.
 *
 * - present but unreadable, or present and not confidently parseable —
 *   NOT healthy. Seed settings were skipped rather than risk clobbering a
 *   file this tool could not understand, and the developer needs to know
 *   their Codex defaults never landed.
 *
 * @param {{path: string, content: string | null, exists: boolean} | null} configToml
 * The gathered `config.toml` state, or `null` for a non-Codex agent.
 * @returns {boolean} `true` when the file is absent or parseable, `false`
 * when it is present and this tool could not read or parse it.
 */
function codexConfigTomlReadable(configToml) {
  if (!configToml) return false;
  if (configToml.exists === false) return true;
  if (configToml.content === null) return false;
  return st.analyze(configToml.content).ok;
}

/**
 * Enumerates every hook entry a Codex `hooks.json` document registers, in
 * on-disk order — the same `<event>:<group index>:<hook index>` addressing
 * Codex's own `[hooks.state]` trust keys use (CONTRACTS.md §7).
 *
 * @param {*} hooksJson The parsed content of a Codex `hooks.json` file.
 * @returns {{event: string, groupIndex: number, hookIndex: number, command: string}[]}
 * One entry per hook whose `command` is a string; a malformed shape (no
 * `hooks` object, a non-array group, a group missing its own `hooks` array,
 * a non-string `command`) is skipped rather than guessed at.
 */
function listRegisteredCodexHooks(hooksJson) {
  const out = [];
  const byEvent = hooksJson && typeof hooksJson === "object" ? hooksJson.hooks : null;
  if (!byEvent || typeof byEvent !== "object") return out;
  for (const [event, groups] of Object.entries(byEvent)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, groupIndex) => {
      const hooks = group && Array.isArray(group.hooks) ? group.hooks : [];
      hooks.forEach((hook, hookIndex) => {
        if (hook && typeof hook.command === "string") out.push({ event, groupIndex, hookIndex, command: hook.command });
      });
    });
  }
  return out;
}

/**
 * A short, addressable label for one registered Codex hook, shared by every
 * rendered line that names one.
 *
 * @param {{event: string, groupIndex: number, hookIndex: number}} hook One
 * entry from {@link listRegisteredCodexHooks}.
 * @returns {string} `"<event>[<groupIndex>][<hookIndex>]"`.
 */
function codexHookLabel(hook) {
  return `${hook.event}[${hook.groupIndex}][${hook.hookIndex}]`;
}

/**
 * Judges whether one Codex hook command's executable token can spawn a
 * process at all — exactly the way Codex itself does, confirmed against the
 * real binary today: Codex splits the whole command line on whitespace and
 * uses the first token as the executable directly, with no shell involved
 * and no quote handling, so a quoted token is taken completely literally,
 * quote characters included — neither `"C:\Program Files\nodejs\node.exe" <script>`
 * nor the same path left unquoted ever starts a process, because the first
 * is truncated at its first internal space (a bare `"C:\Program` is not a
 * real file) and the second still carries its literal quote characters into
 * argv. This failure is silent on Codex's side: it logs `hook: <Event>
 * Failed` and carries on, so an installation can look healthy while
 * enforcing nothing.
 *
 * Flow:
 * - the command begins with `"` — the quote character is part of the
 *   token, so it can never name a real file; reported without ever
 *   touching the filesystem.
 * - otherwise, the first whitespace-delimited token is the executable.
 *   Arguments after it are tokenised properly and arrive unquoted, so a
 *   quoted argument is fine and never inspected here.
 * - a token with no path separator (`node`) is a bare name Codex resolves
 *   against `PATH` — treated as resolvable and fine, never checked against
 *   this machine's disk.
 * - a token with a path separator (`/` or `\`) must name a file that
 *   actually exists.
 *
 * @param {string} command The hook's raw `command` string.
 * @returns {{ok: true} | {ok: false, reason: string}} `ok: false` names why
 * the executable token can never spawn.
 */
function judgeCodexHookExecutable(command) {
  const text = typeof command === "string" ? command.trim() : "";
  if (text.startsWith('"')) {
    return {
      ok: false,
      reason:
        "the command begins with a double quote — Codex takes the executable token completely literally, quote characters included, so this can never name a real file",
    };
  }
  const token = text.split(/\s+/)[0] || "";
  if (!token) return { ok: false, reason: "the command has no executable token" };
  if (!token.includes("/") && !token.includes("\\")) return { ok: true };
  return fs.existsSync(token)
    ? { ok: true }
    : { ok: false, reason: `the executable token "${token}" does not exist on disk — a path with a space was truncated, or the path is simply wrong` };
}

/**
 * Reports every registered Codex hook command whose executable token can
 * never spawn a process (see {@link judgeCodexHookExecutable}) — a real
 * failure, since Codex logs the failure and carries on rather than refusing
 * to start, so an installation with a hook like this looks healthy while
 * enforcing nothing.
 *
 * @param {object} ctx A gathered context (`detect.js#gather`).
 * @returns {{event: string, groupIndex: number, hookIndex: number, command: string, reason: string}[]}
 * One entry per unspawnable hook command; empty for a non-Codex agent, an
 * unparseable `hooks.json`, or a healthy installation.
 */
function listUnspawnableCodexHooks(ctx) {
  if (ctx.agent !== "codex" || !ctx.settings.parseOk) return [];
  const out = [];
  for (const hook of listRegisteredCodexHooks(ctx.settings.content)) {
    const verdict = judgeCodexHookExecutable(hook.command);
    if (!verdict.ok) out.push({ ...hook, reason: verdict.reason });
  }
  return out;
}

/**
 * Builds the exact `[hooks.state]` section path Codex would record for one
 * registered hook's trust entry (CONTRACTS.md §7): `<absolute hooks.json
 * path>:<event in snake_case>:<group index>:<hook index>`, wrapped as a
 * single quoted TOML key segment dotted under `hooks.state` — the same
 * shape `settings-toml.js#analyze` reports for a real `[hooks.state.'...']`
 * header, so it can be matched against `analyze(...).sections` by exact
 * string equality.
 *
 * @param {string} hooksJsonPath The absolute path to the `hooks.json` file
 * that registered the hook.
 * @param {{event: string, groupIndex: number, hookIndex: number}} hook One
 * entry from {@link listRegisteredCodexHooks}.
 * @returns {string} The section path, e.g.
 * `hooks.state.'C:\Users\dev\.codex\hooks.json:pre_tool_use:0:0'`.
 */
function codexHookTrustSectionPath(hooksJsonPath, hook) {
  const eventSnakeCase = String(hook.event).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return `hooks.state.'${hooksJsonPath}:${eventSnakeCase}:${hook.groupIndex}:${hook.hookIndex}'`;
}

/**
 * Reports every registered Codex hook carrying no `[hooks.state]` trust
 * entry in `config.toml` at all — certainly never approved, since Codex
 * will not run an untrusted hook, and does so in complete silence: no
 * `hook:` line at all, indistinguishable from a healthy run.
 *
 * Deliberately narrower than confirming trust: a present entry only proves
 * a hook at *some* hash was once approved — asserting it matches the
 * *currently installed* hook would mean reproducing Codex's own hashing
 * function, which has not been done (CONTRACTS.md §7). Only an entry's
 * ABSENCE is ever asserted here; a present entry is never read as proof of
 * anything.
 *
 * @param {object} ctx A gathered context (`detect.js#gather`).
 * @returns {{applicable: boolean, unapproved: {event: string, groupIndex: number, hookIndex: number, command: string}[], allApproved: boolean}}
 * `applicable: false` when there is nothing this check can honestly say — a
 * non-Codex agent, no registered hooks, or a `config.toml` that is present
 * but could not be read confidently (already surfaced by
 * `configTomlReadable`, so this never doubles that finding). Otherwise
 * `unapproved` lists every registered hook missing a trust entry, and
 * `allApproved` is `true` exactly when that list is empty — a `config.toml`
 * that does not exist yet means every registered hook is unapproved by
 * construction, since no `[hooks.state]` table can exist in a file that
 * is not there.
 */
function listUnapprovedCodexHooks(ctx) {
  const registered = ctx.agent === "codex" && ctx.settings.parseOk ? listRegisteredCodexHooks(ctx.settings.content) : [];
  if (!registered.length || !ctx.configToml) return { applicable: false, unapproved: [], allApproved: false };

  let sections = [];
  if (ctx.configToml.exists) {
    if (ctx.configToml.content === null) return { applicable: false, unapproved: [], allApproved: false };
    const parsed = st.analyze(ctx.configToml.content);
    if (!parsed.ok) return { applicable: false, unapproved: [], allApproved: false };
    sections = parsed.sections;
  }

  const unapproved = registered.filter((hook) => !sections.some((s) => s.path === codexHookTrustSectionPath(ctx.settingsFile, hook)));
  return { applicable: true, unapproved, allApproved: unapproved.length === 0 };
}

/**
 * Resolves this installation's own Codex `askMode` — the setting
 * `adapters/codex/dispatch.js#resolveAskMode` reads at every tool call — for
 * {@link buildParityReport}'s informational row stating what it means for
 * parity.
 *
 * @param {object} ctx A gathered context (`detect.js#gather`) for the
 * `"codex"` agent.
 * @returns {"block" | "advise"} `"advise"` only when local state explicitly
 * asks for it; `"block"` otherwise — the same default `dispatch.js` uses.
 */
function resolveCodexAskMode(ctx) {
  const adapterOptions = ctx.state && ctx.state.adapterOptions;
  return adapterOptions && adapterOptions.askMode === "advise" ? "advise" : "block";
}

/**
 * Resolves the `memory-as-context` module's currently configured `location`
 * option for one agent (MODULES.md "Substitutions") — the developer's own
 * stored choice when present and still one of the option's declared
 * `values`, else the option's own shipped default. Mirrors
 * `plan.js#buildOptionVars`'s own fallback rule for this one option rather
 * than importing it: that module is installer *planning*, this one is
 * read-only *reporting*, and pulling in only the one rule this needs keeps
 * this file's own contract narrow.
 *
 * @param {object} ctx A gathered context (`detect.js#gather`).
 * @param {{id: string, json: object}} mod The `memory-as-context` module entry from `ctx.enabledModules`.
 * @returns {string} One of the option's declared `values` — `"repo"`, `"infrastructure"` or `"global"`.
 */
function resolveMemoryLocationOption(ctx, mod) {
  const def = (mod.json.options && mod.json.options.location) || {};
  const stored = ctx.state && ctx.state.options && ctx.state.options[mod.id] && ctx.state.options[mod.id].location;
  if (typeof stored === "string" && Array.isArray(def.values) && def.values.includes(stored)) return stored;
  return def.default || "global";
}

/**
 * Builds `doctor`'s report on the `memory-as-context` module's own seeded
 * knowledge base — the only visibility this repository has into whether
 * `seed-memory.js` ever actually landed the seed, how many files it seeded,
 * whether `MEMORY.md`'s generated index is present, or whether a run got
 * stuck (M1's own bug: a run that wrote every seed file but got stuck on an
 * ambiguous `MEMORY.md` left no error anywhere, and its own on-disk marker
 * falsely claimed full success — this section is what makes that state a
 * one-line answer instead of a silent, permanent failure).
 *
 * Reads three artifacts `seed-memory.js` itself owns, through its own
 * exported constants and never a second, duplicated copy of them: the
 * version marker (`SEED_SUBDIR/MARKER_FILE`, a fully successful run), the
 * warning marker (`SEED_SUBDIR/WARNING_FILE`, a run stuck on an ambiguous
 * index) and the skipped-files diagnostic (`SEED_SUBDIR/SKIPPED_FILE`, seed
 * files this run could not parse), plus `MEMORY.md`'s own managed block
 * (`BEGIN`/`END`). The dependency runs only this one direction — doctor
 * reading the module's exported constants and pure functions — never the
 * reverse; `seed-memory.js` and its siblings stay self-contained
 * (`memory-location.js`'s own module doc explains why).
 *
 * Read, never write: dynamically requiring `seed-memory.js` executes only
 * its own top-level constant and function definitions (its `main()` never
 * runs on `require`, guarded by its own `require.main === module` check),
 * so nothing this function does ever touches the filesystem beyond plain
 * reads.
 *
 * @param {object} ctx A gathered context (`detect.js#gather`).
 * @returns {object} `{moduleEnabled: false}` when `memory-as-context` is not
 * enabled for this agent — nothing else in this shape is meaningful then.
 * `{moduleEnabled: true, unreadable: true}` when the module is enabled but
 * its own hook scripts could not be loaded (a corrupted install). Otherwise
 * `{moduleEnabled: true, location, memoryDir, exists, seeded, seededAt,
 * fileCount, indexPresent, indexBlocked, indexBlockedReason,
 * indexBlockedSince, skippedFiles}` — `memoryDir` is resolved from the
 * current working directory exactly as a hook invoked with no host payload
 * would resolve it (`resolveMemoryDir`'s own `cwd` fallback), which is only
 * ever meaningful for the `"infrastructure"`/`"repo"` locations since
 * `"global"` ignores `cwd` entirely; `fileCount` is the real, on-disk count
 * of `.md` files under `softela/`, never the version marker's own self-reported
 * count, since a marker recording success while the index write actually
 * failed is exactly the bug this section exists to catch; `indexBlocked` is
 * `true` exactly when the warning marker is present.
 */
function buildMemoryReport(ctx) {
  const mod = ctx.enabledModules.find((m) => m.id === "memory-as-context");
  if (!mod) return { moduleEnabled: false };

  let memoryLocation;
  let seedMemory;
  try {
    memoryLocation = require(path.join(mod.dir, "hooks", "memory-location.js"));
    seedMemory = require(path.join(mod.dir, "hooks", "seed-memory.js"));
  } catch {
    return { moduleEnabled: true, unreadable: true };
  }

  const location = resolveMemoryLocationOption(ctx, mod);
  const memoryDir = memoryLocation.resolveMemoryDir({ agentHome: ctx.home, cwd: process.cwd(), location });
  const exists = fs.existsSync(memoryDir);
  const softelaDir = path.join(memoryDir, seedMemory.SEED_SUBDIR);

  const marker = readJson(path.join(softelaDir, seedMemory.MARKER_FILE));
  const warning = readJson(path.join(softelaDir, seedMemory.WARNING_FILE));
  const skipped = readJson(path.join(softelaDir, seedMemory.SKIPPED_FILE));

  let fileCount = null;
  try {
    fileCount = fs.readdirSync(softelaDir).filter((n) => n.endsWith(".md")).length;
  } catch {
    fileCount = exists ? 0 : null;
  }

  const indexText = readText(path.join(memoryDir, seedMemory.INDEX_FILE));
  const indexPresent = typeof indexText === "string" && indexText.includes(seedMemory.BEGIN) && indexText.includes(seedMemory.END);

  return {
    moduleEnabled: true,
    location,
    memoryDir,
    exists,
    seeded: !!marker && marker.version === seedMemory.SEED_VERSION,
    seededAt: marker && typeof marker.seededAt === "string" ? marker.seededAt : null,
    fileCount,
    indexPresent,
    indexBlocked: !!warning,
    indexBlockedReason: warning && typeof warning.reason === "string" ? warning.reason : null,
    indexBlockedSince: warning && typeof warning.detectedAt === "string" ? warning.detectedAt : null,
    skippedFiles: skipped && Array.isArray(skipped.files) ? skipped.files : [],
  };
}

function buildAgentReport(agent, repoVersion) {
  const ctx = detect.gather(agent);

  // On-disk bytes matching exactly what this version ships could only get
  // that way by this tool having written them — a developer's own file can
  // never coincide with the shipped hash. That is proof of ownership by
  // content, asked the same way regardless of what the manifest says about
  // the path: nothing at all (`manifestHash === undefined`), or a hash that
  // simply disagrees with reality (a hand-edited or stale manifest entry).
  // This is the same recovery `plan.js` performs before writing; here it lets
  // a corrupt, truncated, partial or simply wrong manifest.json still be
  // recognised as a real, healthy installation instead of every one of its
  // own files being reported as foreign or permanently "locally modified".
  const isRecovered = (f) => f.onDiskHash !== null && f.shippedHash !== null && f.onDiskHash === f.shippedHash && f.manifestHash !== f.shippedHash;
  const manifestUnreadable = !ctx.manifest && ctx.files.some(isRecovered);
  const installed = !!ctx.manifest || manifestUnreadable;

  const drift = ctx.files
    .filter((f) => f.shippedHash !== null || f.manifestHash !== undefined)
    .map((f) => {
      if (f.shippedHash === null) {
        // No longer shipped by this version. Nothing on disk either means
        // there is nothing left to report — the same benign, already-
        // resolved state `plan.js#planFiles` treats as "no longer shipped,
        // already gone", not as a modification of something that does not
        // exist.
        if (f.onDiskHash === null) return null;
        return f.onDiskHash === f.manifestHash
          ? null
          : { relPath: f.relPath, issue: "no longer shipped, but locally modified — left in place" };
      }
      if (f.onDiskHash === null) return { relPath: f.relPath, issue: f.manifestHash !== undefined ? "missing" : "not yet installed" };
      if (isRecovered(f)) return null;
      if (f.manifestHash === undefined) return { relPath: f.relPath, issue: "present but not tracked by the manifest" };
      if (f.onDiskHash !== f.manifestHash) return { relPath: f.relPath, issue: "locally modified" };
      if (f.shippedHash !== f.manifestHash) return { relPath: f.relPath, issue: "update available" };
      return null;
    })
    .filter(Boolean);

  const missing = drift.filter((d) => d.issue === "missing");
  const modelInfo = readEffectiveModelInfo(ctx);

  return {
    agent,
    installed,
    installedVersion: ctx.manifest ? ctx.manifest.version : null,
    repoVersion,
    updateAvailable: installed && !!ctx.manifest && repoVersion !== null && ctx.manifest.version !== repoVersion,
    manifestUnreadable,
    drift,
    missing,
    overrides: listOverrides(agent),
    overridesSchemaErrors: validateOverridesConfig(agent),
    approvals: approvals.list({ agent }).filter((a) => a.live),
    enabledModules: ctx.enabledModules.map((m) => m.id),
    memory: buildMemoryReport(ctx),
    changedSeedSettings: listChangedSeedSettings(ctx),
    unrecognizedTierModels: listUnrecognizedTierModels(ctx),
    settingsParseOk: ctx.settings.parseOk,
    settingsFile: ctx.settingsFile,
    // `content === null` no longer means "absent" on its own — `detect.js`'s
    // `exists` flag separates the two, and an absent file is fine (a seed
    // creates it) while a present one this tool cannot read is exactly the
    // case worth warning about. Reading them as the same thing is what let a
    // present-but-unreadable config.toml pass as healthy.
    configTomlReadable: agent === "codex" ? codexConfigTomlReadable(ctx.configToml) : null,
    unspawnableCodexHooks: agent === "codex" ? listUnspawnableCodexHooks(ctx) : [],
    codexHookTrust: agent === "codex" ? listUnapprovedCodexHooks(ctx) : { applicable: false, unapproved: [], allApproved: false },
    runCommand: `node "${path.join(ctx.installedRoot, "bin", "softela-ai")}"`,
    // Parity-only fields — read here (where `ctx` already exists) rather than
    // re-gathered inside `buildParityReport`, which only ever compares data
    // both agent reports already carry.
    registeredHookEvents: listRegisteredHookEvents(ctx),
    effectiveModel: modelInfo.model,
    effectiveReasoningEffort: modelInfo.reasoningEffort,
    askMode: agent === "codex" ? resolveCodexAskMode(ctx) : null,
  };
}

/**
 * Builds the complete `doctor` report across every requested agent.
 *
 * @param {string[]} agents The agents to report on.
 * @param {{ruleRegistryStatus?: {rules: object[], loadErrors: {file: string | null, error: string}[]}}} [options]
 * `ruleRegistryStatus` overrides `core/engine.js#ruleRegistryStatus`, purely
 * for tests — driving a fake broken/empty registry through this report
 * without touching the real `core/guards/` directory, which every other
 * agent process and every other test also reads.
 * @returns {{repoVersion: string | null, agents: object[], invalidProjects: {file: string, errors: string[]}[], schemaKeywordsUnhandled: string[], ruleLoadErrors: {file: string | null, error: string}[], ruleRegistryEmpty: boolean}}
 * The full report, ready for {@link formatDoctorReport} or JSON output.
 * `repoVersion` is `null` when there is no source repository to read a
 * version from (IMPORTANT I5). `ruleLoadErrors` is every rule module
 * `core/guards/index.js` could not load or validate — a rule that cannot
 * load is a rule that is not protecting anyone, so this is a real problem
 * ({@link doctorExitCode}), never merely informational. `ruleRegistryEmpty`
 * is `true` when the registry loaded zero rules at all — total
 * non-enforcement, distinct from an ordinary partial failure, and rendered
 * as its own loud, hard-to-miss line by {@link formatDoctorReport}.
 */
function buildReport(agents, options = {}) {
  const repoVersion = detect.readVersion();
  const agentReports = agents.map((agent) => buildAgentReport(agent, repoVersion));
  const registryStatus = options.ruleRegistryStatus || engine.ruleRegistryStatus();
  return {
    repoVersion,
    agents: agentReports,
    invalidProjects: validateProjectConfigs(),
    schemaKeywordsUnhandled: unhandledSchemaKeywords(),
    parity: buildParityReport(agentReports),
    ruleLoadErrors: registryStatus.loadErrors,
    ruleRegistryEmpty: registryStatus.rules.length === 0,
  };
}

/**
 * Maps each job an softela-ai hook performs to the host event name that carries
 * it on each agent, so {@link buildParityReport} can match a registration by
 * what the hook DOES rather than by the host's own event spelling — Claude
 * Code and Codex do not always name the same job the same way, and Codex
 * fires some jobs on an event Claude Code has no equivalent for at all.
 *
 * Every job this repository currently ships happens to use an identical
 * event name on both hosts (`PreToolUse`, `PostToolUse`, `SessionStart`,
 * `PreCompact`) — this table exists so that stays true by design, not by
 * coincidence, and so a future host-specific rename only ever has to touch
 * this one place, not every call site that compares hooks across agents.
 *
 * `claude: null` or `codex: null` marks a job with genuinely no counterpart
 * on that host, so a doctor row for it reads as structural rather than
 * alarming:
 *
 * - Codex's `PostCompact` has no Claude Code counterpart — Claude Code's own
 *   `SessionStart` already fires with `source: "compact"` right after a
 *   compaction (CONTRACTS.md §7's per-event field table), so the same job
 *   (re-injecting memory once conversation history is dropped) needs its own
 *   dedicated event on Codex but not on Claude Code.
 */
const HOOK_EVENT_JOBS = [
  { job: "before a tool call", claude: "PreToolUse", codex: "PreToolUse" },
  { job: "after a tool call", claude: "PostToolUse", codex: "PostToolUse" },
  { job: "session start", claude: "SessionStart", codex: "SessionStart" },
  { job: "before compaction", claude: "PreCompact", codex: "PreCompact" },
  { job: "after compaction (memory re-injection)", claude: null, codex: "PostCompact" },
];

/** Tier number ({@link TIERS}) to a short, human-readable name, for parity rows. */
const TIER_LABELS = { [TIERS.FRONTIER]: "frontier", [TIERS.BALANCED]: "balanced", [TIERS.CHEAP]: "cheap" };

/**
 * Renders a tier number as its short name.
 *
 * @param {number | null} tier One of {@link TIERS}, or `null`.
 * @returns {string} The tier's name, or `"unrecognised"` for `null` or a
 * number `model-tiers.js#tierOf` never returns.
 */
function tierLabel(tier) {
  return tier === null || tier === undefined ? "unrecognised" : TIER_LABELS[tier] || `tier ${tier}`;
}

/**
 * Builds one parity row comparing two sorted id lists for set equality,
 * shared by every "does this set match across agents" aspect (enabled
 * modules, effective rule overrides, seed-setting drift).
 *
 * @param {string} aspect The row's label.
 * @param {string[]} claudeIds Claude's ids.
 * @param {string[]} codexIds Codex's ids.
 * @param {string} onlyClaudeLabel Prefix for ids present for Claude only.
 * @param {string} onlyCodexLabel Prefix for ids present for Codex only.
 * @returns {{aspect: string, claude: string, codex: string, matched: boolean, note: string}}
 * The row.
 */
function buildSetEqualityRow(aspect, claudeIds, codexIds, onlyClaudeLabel, onlyCodexLabel) {
  const onlyClaude = claudeIds.filter((id) => !codexIds.includes(id));
  const onlyCodex = codexIds.filter((id) => !claudeIds.includes(id));
  const matched = onlyClaude.length === 0 && onlyCodex.length === 0;
  const note = [
    onlyClaude.length ? `${onlyClaudeLabel}: ${onlyClaude.join(", ")}` : null,
    onlyCodex.length ? `${onlyCodexLabel}: ${onlyCodex.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("; ");
  return {
    aspect,
    claude: claudeIds.length ? claudeIds.join(", ") : "(none)",
    codex: codexIds.length ? codexIds.join(", ") : "(none)",
    matched,
    note,
  };
}

/**
 * Compares Claude's and Codex's doctor reports side by side, one row per
 * aspect this repository is meant to keep behaviourally identical between
 * the two agents (INSTALLER.md §8's parity block).
 *
 * Never affects {@link doctorExitCode} — see that function's own doc
 * comment. A parity mismatch is information for the developer, not evidence
 * anything is broken: the two agents are allowed to diverge deliberately (a
 * developer's own override, a module enabled on one only), and this report
 * exists so that divergence is visible rather than silently assumed away.
 *
 * @param {object[]} agentReports Every agent report {@link buildAgentReport}
 * produced for this run; order does not matter, only which agents are
 * present.
 * @returns {
 *   {comparable: false, missing: "claude" | "codex"}
 *   | {comparable: true, rows: {aspect: string, claude: string, codex: string, matched: boolean, note: string}[], verdict: "match" | "mismatch"}
 * } `comparable: false` when fewer than both agents are present in
 * `agentReports` — there is nothing to compare a single agent's report
 * against, whether that is because only one was requested or only one is
 * actually installed. Otherwise one row per aspect below, plus an overall
 * `verdict`:
 *
 * - installed / not installed, and installed version
 * - the enabled module set (set equality)
 * - one row per {@link HOOK_EVENT_JOBS} entry — registered or not, matched
 *   by job rather than by event name; a job with no counterpart on one host
 *   always reads `matched: true`, since that asymmetry is structural
 * - the effective main model, compared through `model-tiers.js#tierOf` so
 *   Claude's `opus` and Codex's resolved frontier id compare as the same
 *   tier rather than as two different strings
 * - the effective main-session reasoning effort (Codex's
 *   `model_reasoning_effort`); Claude Code has no persisted equivalent
 *   setting, so this always reads `matched: true` for Claude — structural,
 *   not a mismatch
 * - developer rule overrides — which rule ids carry an `"effective"`
 *   override (set equality); an id softened for one agent only is exactly
 *   the asymmetry this row exists to catch
 * - live approvals per agent — informational only (`matched: true` always):
 *   an approval is short-lived and granted per developer session, never
 *   expected to match between agents
 * - Codex's `askMode` — informational only (`matched: true` always): Codex
 *   has no native "ask", so `adapters/codex/dispatch.js` always maps an
 *   `ask` decision onto a deny or an advisory, which is a real, permanent
 *   divergence from Claude Code's native "ask" — this row states it rather
 *   than letting the rest of the table imply the two hosts agree
 * - seed settings changed away from what the module shipped, by module id
 *   (set equality) — excludes the `/model` and `/model_reasoning_effort`
 *   pointers, which the two rows above already compare, so the same
 *   underlying change is never counted as two separate mismatches
 */
function buildParityReport(agentReports) {
  const claude = agentReports.find((a) => a.agent === "claude");
  const codex = agentReports.find((a) => a.agent === "codex");
  if (!claude || !codex) {
    return { comparable: false, missing: !claude ? "claude" : "codex" };
  }

  const rows = [];

  const describeInstalled = (a) => (a.installed ? a.installedVersion || "(unknown version)" : "not installed");
  const installedMatched = claude.installed === codex.installed && (!claude.installed || claude.installedVersion === codex.installedVersion);
  rows.push({
    aspect: "installed",
    claude: describeInstalled(claude),
    codex: describeInstalled(codex),
    matched: installedMatched,
    note: installedMatched ? "" : "installed state or version differs",
  });

  rows.push(
    buildSetEqualityRow("enabled modules", [...claude.enabledModules].sort(), [...codex.enabledModules].sort(), "only claude", "only codex"),
  );

  for (const { job, claude: claudeEvent, codex: codexEvent } of HOOK_EVENT_JOBS) {
    const claudeHas = claudeEvent ? claude.registeredHookEvents.includes(claudeEvent) : null;
    const codexHas = codexEvent ? codex.registeredHookEvents.includes(codexEvent) : null;
    if (claudeEvent === null || codexEvent === null) {
      rows.push({
        aspect: `hook: ${job}`,
        claude: claudeEvent ? (claudeHas ? `registered (${claudeEvent})` : "not registered") : "(no counterpart event on Claude Code)",
        codex: codexEvent ? (codexHas ? `registered (${codexEvent})` : "not registered") : "(no counterpart event on Codex)",
        matched: true,
        note: claudeEvent === null ? "Claude Code has no event for this job" : "Codex has no event for this job",
      });
      continue;
    }
    const matched = claudeHas === codexHas;
    rows.push({
      aspect: `hook: ${job}`,
      claude: claudeHas ? `registered (${claudeEvent})` : "not registered",
      codex: codexHas ? `registered (${codexEvent})` : "not registered",
      matched,
      note: matched ? "" : "registered for one agent only",
    });
  }

  const claudeTier = tierOf(claude.effectiveModel);
  const codexTier = tierOf(codex.effectiveModel);
  const modelMatched = claudeTier !== null && claudeTier === codexTier;
  rows.push({
    aspect: "main model",
    claude: claude.effectiveModel ? `${claude.effectiveModel} (${tierLabel(claudeTier)})` : "(not set)",
    codex: codex.effectiveModel ? `${codex.effectiveModel} (${tierLabel(codexTier)})` : "(not set)",
    matched: modelMatched,
    note: modelMatched ? "" : "resolve to different cost tiers, or one side is unset or unrecognised",
  });

  // Claude Code has no persisted reasoning-effort setting at all — see
  // `readEffectiveModelInfo`'s own doc comment — so that side's absence is
  // never itself a mismatch.
  const effortMatched = claude.effectiveReasoningEffort === null ? true : claude.effectiveReasoningEffort === codex.effectiveReasoningEffort;
  rows.push({
    aspect: "reasoning effort",
    claude: claude.effectiveReasoningEffort || "(not configurable for Claude Code)",
    codex: codex.effectiveReasoningEffort || "(not set)",
    matched: effortMatched,
    note: claude.effectiveReasoningEffort === null ? "Claude Code has no persisted reasoning-effort setting to compare" : effortMatched ? "" : "differs",
  });

  const effectiveOverrideIds = (report) =>
    [...new Set(report.overrides.filter((o) => o.state === "effective").map((o) => o.ruleId))].sort();
  rows.push(
    buildSetEqualityRow(
      "rule overrides",
      effectiveOverrideIds(claude),
      effectiveOverrideIds(codex),
      "softened for claude only",
      "softened for codex only",
    ),
  );

  const describeApprovals = (report) =>
    report.approvals.length ? report.approvals.map((a) => `${a.ruleId} (until ${a.until})`).join(", ") : "(none live)";
  rows.push({
    aspect: "live approvals",
    claude: describeApprovals(claude),
    codex: describeApprovals(codex),
    matched: true,
    note: "informational — approvals are short-lived and granted per developer session, not expected to match",
  });

  // Informational, same as "live approvals" above: Codex has no native
  // "ask", so `adapters/codex/dispatch.js` maps an `ask` decision onto a
  // deny (or an advisory, per `askMode`) instead of showing it to the
  // developer the way Claude Code does — the two hosts do not reach the
  // same outcome for a rule that returns `ask`, and that is by design, not
  // a bug this row could ever resolve to `matched: false`.
  rows.push({
    aspect: "codex askMode",
    claude: "(no native \"ask\" — Claude Code shows the decision to the developer directly)",
    codex: codex.askMode === "advise" ? '"advise" — an ask decision proceeds as an advisory note' : '"block" (default) — an ask decision becomes a deny until approved',
    matched: true,
    note: 'informational — Codex has no native "ask"; adapters/codex/dispatch.js always maps it onto a deny or an advisory, so the two hosts never reach the same outcome for a rule that returns "ask"',
  });

  // `/model` and `/model_reasoning_effort` are already compared, pointer by
  // pointer, in the two rows above — excluded here so the same underlying
  // change is never counted as two separate mismatches.
  const MODEL_RELATED_POINTERS = new Set(["/model", "/model_reasoning_effort"]);
  const driftedModules = (report) =>
    [...new Set(report.changedSeedSettings.filter((s) => !MODEL_RELATED_POINTERS.has(s.pointer)).map((s) => s.module))].sort();
  rows.push(
    buildSetEqualityRow(
      "seed settings changed from shipped default",
      driftedModules(claude),
      driftedModules(codex),
      "drifted on claude only",
      "drifted on codex only",
    ),
  );

  return { comparable: true, rows, verdict: rows.every((r) => r.matched) ? "match" : "mismatch" };
}

/**
 * Indents `prefix` before `text`'s first wrapped line, and an equal-width
 * blank indent before every continuation line, so a continuation stays
 * aligned under the first line's own text rather than under the prefix.
 *
 * Duplicates `core/installer/index.js#wrapWithPrefix`'s own shape rather
 * than importing it: `index.js` already requires this module for
 * {@link formatDoctorReport} and {@link CODEX_TRUST_CAVEAT}, so the reverse
 * import would be circular.
 *
 * @param {string} prefix Text placed before the wrapped body on its first
 * line only.
 * @param {string} text The body text to wrap.
 * @param {number} width The total column budget to fit within, prefix
 * included.
 * @returns {string[]} One rendered line per wrapped segment, each at most
 * `width` columns wide and with no trailing whitespace.
 */
function wrapPrefixed(prefix, text, width) {
  const indent = " ".repeat(tty.displayWidth(prefix));
  const bodyWidth = Math.max(10, width - indent.length);
  const wrapped = tty.wrap(text, bodyWidth);
  return wrapped.map((line, i) => tty.truncate(i === 0 ? `${prefix}${line}` : `${indent}${line}`, width).trimEnd());
}

/**
 * Fraction of a two-column row's available width {@link fitLabelValueLine}
 * ever gives to the label column — the rest always goes to the value, the
 * column that actually carries the information (a file path, a rule id and
 * its detail) a developer reads `doctor` for in the first place.
 */
const LABEL_VALUE_MAX_FRACTION = 0.5;

/**
 * Renders one label/value pair as a single fitted row, shrinking the label
 * column below its natural width first when the terminal is too narrow for
 * both columns at once — so a long value is never crowded out entirely by a
 * label that did not actually need all the room it was given.
 *
 * @param {string} indent Leading whitespace before the row.
 * @param {string} label The row's left column.
 * @param {number} labelWidth The label column's natural width — the widest
 * label actually present across the rows this call renders one of.
 * @param {string} value The row's right column; absorbs whatever width the
 * label column leaves, truncated with `…` when it still does not fit.
 * @param {number} width The terminal width this line must fit.
 * @returns {string} One line, at most `width` columns wide, with no
 * trailing whitespace.
 */
function fitLabelValueLine(indent, label, labelWidth, value, width) {
  const budget = Math.max(4, width - tty.displayWidth(indent));
  const cappedLabel = Math.min(labelWidth, Math.max(4, Math.floor(budget * LABEL_VALUE_MAX_FRACTION)));
  const row = tty.fitRow([{ text: label, width: cappedLabel }, { text: value, grow: true }], budget, { separator: " " });
  return `${indent}${row}`.trimEnd();
}

/**
 * Reference width a parity table's aspect/claude/codex column is measured
 * against only to decide whether three aligned columns are worth attempting
 * at all — {@link formatParitySection} falls back to one stacked block per
 * row when even this reference-sized table would not fit `width`. It is not
 * a cap on what a column actually renders at: once the table is chosen,
 * {@link growParityColumns} hands every column whatever additional width the
 * terminal leaves over, up to that column's own real content, so a wide
 * terminal still shows a long comma-joined id list (the module or override
 * set-equality rows) in full instead of cut short at this reference size.
 */
const PARITY_COLUMN_REFERENCE = 26;

/**
 * Fixed, non-content columns of one parity table row: the two-space
 * indent, one-character match mark and two-space gap before the aspect
 * column (5), plus the two-space separator before each of the claude and
 * codex columns (2 + 2).
 */
const PARITY_ROW_FIXED_CHARS = 9;

/**
 * Grows a parity table's column widths from their reference-capped starting
 * point out to whatever additional room `budget` leaves over, one column at
 * a time in round-robin order, so no column is stretched past its own
 * content's real width and no leftover budget is wasted on a column that
 * has nothing more to show.
 *
 * @param {{natural: number, cap: number}[]} columns One entry per column, in
 * render order — `natural` is the column's true widest content, `cap` its
 * starting width (at most {@link PARITY_COLUMN_REFERENCE}).
 * @param {number} budget The total width available across every column
 * (`width` minus {@link PARITY_ROW_FIXED_CHARS}).
 * @returns {number[]} One resolved width per column, in the same order,
 * each in `[cap, natural]` and summing to at most `budget`.
 */
function growParityColumns(columns, budget) {
  const widths = columns.map((c) => c.cap);
  let remaining = budget - widths.reduce((sum, w) => sum + w, 0);

  let grew = remaining > 0;
  while (grew && remaining > 0) {
    grew = false;
    for (let i = 0; i < columns.length && remaining > 0; i++) {
      if (widths[i] < columns[i].natural) {
        widths[i] += 1;
        remaining -= 1;
        grew = true;
      }
    }
  }
  return widths;
}

/**
 * Renders one parity row as a mark, aspect, claude value and codex value
 * aligned into three fixed-width columns, wrapping any cell whose content
 * outgrows its column onto further lines instead of truncating it — the
 * row's height follows whichever of the three cells wraps the most, with
 * every shorter cell's remaining lines padded blank so the columns stay
 * aligned throughout.
 *
 * @param {string} mark `"="` or `"!"`, placed before the aspect column on
 * the row's first line only.
 * @param {{aspect: string, claude: string, codex: string}} row The row's
 * three text values.
 * @param {number} aspectWidth The aspect column's resolved width.
 * @param {number} claudeWidth The claude column's resolved width.
 * @param {number} codexWidth The codex column's resolved width.
 * @param {number} width The terminal width every rendered line must fit.
 * @returns {string[]} One line per wrapped row height, each at most `width`
 * columns wide and with no trailing whitespace.
 */
function formatParityRow(mark, row, aspectWidth, claudeWidth, codexWidth, width) {
  const aspectLines = tty.wrap(row.aspect, aspectWidth);
  const claudeLines = tty.wrap(row.claude, claudeWidth);
  const codexLines = tty.wrap(row.codex, codexWidth);
  const rowHeight = Math.max(aspectLines.length, claudeLines.length, codexLines.length);

  const lines = [];
  for (let i = 0; i < rowHeight; i++) {
    const prefix = i === 0 ? `  ${mark}  ` : "     ";
    const aspectCell = tty.padTo(aspectLines[i] || "", aspectWidth);
    const claudeCell = tty.padTo(claudeLines[i] || "", claudeWidth);
    const codexCell = tty.padTo(codexLines[i] || "", codexWidth);
    lines.push(tty.truncate(`${prefix}${aspectCell}  ${claudeCell}  ${codexCell}`, width).trimEnd());
  }
  return lines;
}

/**
 * Renders {@link buildParityReport}'s result as an aligned three-column
 * table when `width` comfortably fits one, or as one stacked block per row
 * — aspect, then claude's value, then codex's value, each on its own
 * line — when it does not; always the single "cannot be assessed" line when
 * only one agent's report is present.
 *
 * @param {object} parity As returned by {@link buildParityReport}.
 * @param {number} width The terminal width every rendered line must fit.
 * @returns {string[]} The rendered lines, always ending with one blank line.
 */
function formatParitySection(parity, width) {
  if (!parity.comparable) {
    return [...wrapPrefixed("", `parity: cannot be assessed — ${parity.missing} is not installed/reported`, width), ""];
  }

  const lines = [tty.truncate(`parity (claude vs codex): ${parity.verdict}`, width).trimEnd()];
  const aspectNatural = Math.max(...parity.rows.map((r) => tty.displayWidth(r.aspect)));
  const claudeNatural = Math.max(tty.displayWidth("claude"), ...parity.rows.map((r) => tty.displayWidth(r.claude)));
  const codexNatural = Math.max(tty.displayWidth("codex"), ...parity.rows.map((r) => tty.displayWidth(r.codex)));

  const referenceWidth =
    PARITY_ROW_FIXED_CHARS +
    Math.min(PARITY_COLUMN_REFERENCE, aspectNatural) +
    Math.min(PARITY_COLUMN_REFERENCE, claudeNatural) +
    Math.min(PARITY_COLUMN_REFERENCE, codexNatural);

  if (referenceWidth <= width) {
    const [aspectWidth, claudeWidth, codexWidth] = growParityColumns(
      [
        { natural: aspectNatural, cap: Math.min(PARITY_COLUMN_REFERENCE, aspectNatural) },
        { natural: claudeNatural, cap: Math.min(PARITY_COLUMN_REFERENCE, claudeNatural) },
        { natural: codexNatural, cap: Math.min(PARITY_COLUMN_REFERENCE, codexNatural) },
      ],
      width - PARITY_ROW_FIXED_CHARS,
    );
    lines.push(
      tty
        .truncate(`     ${tty.padTo("", aspectWidth)}  ${tty.padTo("claude", claudeWidth)}  ${tty.padTo("codex", codexWidth)}`, width)
        .trimEnd(),
    );
    for (const r of parity.rows) {
      const mark = r.matched ? "=" : "!";
      lines.push(...formatParityRow(mark, r, aspectWidth, claudeWidth, codexWidth, width));
      if (r.note) lines.push(...wrapPrefixed("       — ", r.note, width));
    }
  } else {
    for (const r of parity.rows) {
      const mark = r.matched ? "=" : "!";
      lines.push(...wrapPrefixed(`  ${mark}  `, r.aspect, width));
      lines.push(...wrapPrefixed("      claude: ", r.claude, width));
      lines.push(...wrapPrefixed("      codex:  ", r.codex, width));
      if (r.note) lines.push(...wrapPrefixed("      — ", r.note, width));
    }
  }
  lines.push("");
  return lines;
}

/**
 * Renders a doctor report as human-readable text, in the order INSTALLER.md
 * §8 specifies, fitted to the running terminal's own width — every row
 * either wraps (prose), fits a shrinking label/value column pair (drift,
 * overrides), or wraps a literal, copy-pasteable value (the "run via:"
 * command) under a hanging indent rather than truncating it.
 *
 * @param {object} report As built by {@link buildReport}.
 * @param {number} [width] The terminal width every rendered line must fit;
 * defaults to {@link module:core/installer/tty.terminalWidth} read off
 * `process.stdout` directly. `core/installer/index.js`'s own CLI dispatch
 * passes its own already-resolved `outputWidth()` instead — the same value
 * used for every other printed surface, and the one the test suite's
 * `SOFTELA_AI_COLUMNS` seam can actually drive, since a piped child process's
 * `stdout.columns` is never set no matter how wide the real terminal running
 * the test is.
 * @returns {string[]} One line per line of output, none exceeding the
 * terminal's own width, none carrying trailing whitespace.
 */
function formatDoctorReport(report, width = tty.terminalWidth(process.stdout)) {
  const lines = [];

  // Rendered first, ahead of everything else in the report — a rule that
  // cannot load is not protecting anyone, and an empty registry means NO
  // rule is, so this must be the first thing a developer sees, never a
  // detail buried after several screens of otherwise-healthy-looking output.
  //
  // `report.ruleLoadErrors` is read defensively (`|| []`) rather than
  // assumed present: a synthetic report built by hand for a narrower test
  // (a per-agent or parity-table rendering fixture, for example) never
  // claims to model the rule registry at all, and must still render exactly
  // as it always has, with neither section appearing.
  const ruleLoadErrors = report.ruleLoadErrors || [];
  if (report.ruleRegistryEmpty) {
    lines.push(
      ...wrapPrefixed(
        "",
        "CRITICAL: the rule registry loaded ZERO rules — every softela-ai guard is currently disabled and no tool call is being checked against anything. This is almost certainly every module under core/guards/ failing to load at once; see \"rule modules that failed to load\" below for exactly which files and why.",
        width,
      ),
    );
    lines.push("");
  }
  if (ruleLoadErrors.length) {
    lines.push(...wrapPrefixed("", "rule modules that failed to load (skipped — every other rule still runs):", width));
    for (const e of ruleLoadErrors) {
      lines.push(...wrapPrefixed("  ", `${e.file || "(directory listing itself)"} — ${e.error}`, width));
    }
    lines.push("");
  }

  for (const a of report.agents) {
    lines.push(`agent  ${a.agent}`);

    const versionLabel = a.installedVersion === null ? "(unknown)" : a.installedVersion;
    if (a.installed) {
      let versionNote = "";
      if (a.manifestUnreadable) {
        versionNote = "manifest.json missing or unreadable — recovered from on-disk files matching what this version ships; run install/update to rewrite it";
      } else if (a.updateAvailable) {
        versionNote = `repository is at ${report.repoVersion} — update available`;
      } else if (report.repoVersion === null) {
        versionNote = "no source repository found — cannot check for updates";
      }
      if (versionNote) {
        lines.push(...wrapPrefixed(`  installed  ${versionLabel}  (`, `${versionNote})`, width));
      } else {
        lines.push(tty.truncate(`  installed  ${versionLabel}`, width).trimEnd());
      }
    } else {
      lines.push("  not installed");
    }

    if (a.drift.length) {
      lines.push("  drift:");
      const issueWidth = Math.max(...a.drift.map((d) => tty.displayWidth(d.issue)));
      for (const d of a.drift) lines.push(fitLabelValueLine("    ", d.issue, issueWidth, d.relPath, width));
    } else if (a.installed) {
      lines.push("  drift:      none");
    }

    if (a.overrides.length) {
      lines.push("  overrides:");
      const scopeWidth = Math.max(...a.overrides.map((o) => tty.displayWidth(o.scope)));
      for (const o of a.overrides) {
        const detail = o.action ? `action=${o.action}` : o.allow ? `allow=${o.allow.length} pattern(s)` : "";
        const stateTag =
          o.state === "invalid" ? "  [INVALID — has no effect]" : o.state === "ignored" ? "  [IGNORED — rule is mandatory]" : "";
        const problemDetail = o.problems.length ? `  (${o.problems.join("; ")})` : "";
        const rest = `${o.ruleId}  ${detail}${stateTag}${o.reason ? `  — ${o.reason}` : ""}${problemDetail}`;
        lines.push(fitLabelValueLine("    ", o.scope, scopeWidth, rest, width));
      }
    } else {
      lines.push("  overrides:  none active");
    }
    if (a.overridesSchemaErrors.length) {
      lines.push(...wrapPrefixed("", "  overrides.json failing schema validation:", width));
      for (const e of a.overridesSchemaErrors) lines.push(...wrapPrefixed("    ", e, width));
    }

    if (a.approvals.length) {
      lines.push("  approvals:");
      for (const ap of a.approvals) lines.push(...wrapPrefixed("    ", `${ap.ruleId}  until ${ap.until}`, width));
    } else {
      lines.push("  approvals:  none live");
    }

    lines.push(...wrapPrefixed("  modules:    ", a.enabledModules.length ? a.enabledModules.join(", ") : "none enabled", width));

    // `a.memory` is read defensively, the same way `report.ruleLoadErrors`
    // is above: a synthetic report built by hand for a narrower test never
    // claims to model the memory-as-context module's own seed state at all,
    // and must still render exactly as it always has, with no section
    // appearing, rather than throwing on a field it was never given.
    if (!a.memory) {
      // Nothing to render.
    } else if (!a.memory.moduleEnabled) {
      lines.push("  memory:     module not enabled");
    } else if (a.memory.unreadable) {
      lines.push("  memory:     module enabled, but its own hook scripts could not be read — no diagnosis available");
    } else {
      const m = a.memory;
      let status;
      if (!m.exists) {
        status = "not yet seeded — memory directory does not exist yet";
      } else if (m.indexBlocked) {
        status = `index write STUCK since ${m.indexBlockedSince || "(unknown)"} — ${m.indexBlockedReason}`;
      } else if (m.seeded && m.indexPresent) {
        status = `seeded — ${m.fileCount ?? 0} file(s) under softela/, index present (last seeded ${m.seededAt || "(unknown)"})`;
      } else if (m.seeded && !m.indexPresent) {
        status = "marker records a completed seed, but MEMORY.md currently carries no managed index block — was it edited or deleted by hand?";
      } else if (m.fileCount) {
        status = `${m.fileCount} file(s) under softela/, but no completed seed recorded — a session start has not finished yet, or was interrupted`;
      } else {
        status = "not yet seeded";
      }
      lines.push(...wrapPrefixed("  memory:     ", `location=${m.location}  ${status}`, width));
      lines.push(...wrapPrefixed("              ", m.memoryDir, width));
      if (m.skippedFiles.length) {
        lines.push(...wrapPrefixed("", "  seed source files that could not be parsed (skipped, harmless unless you shipped them):", width));
        for (const s of m.skippedFiles) lines.push(...wrapPrefixed("    ", `${s.file} — ${s.reason}`, width));
      }
    }

    if (a.changedSeedSettings.length) {
      lines.push(...wrapPrefixed("", "  seed settings changed from shipped default:", width));
      for (const s of a.changedSeedSettings) {
        lines.push(...wrapPrefixed("    ", `${s.module}  ${s.pointer}  shipped=${JSON.stringify(s.shipped)}`, width));
      }
    }
    if (a.unrecognizedTierModels && a.unrecognizedTierModels.length) {
      lines.push(...wrapPrefixed("", "  model tier not recognised (subagent-model / effort-floor comparisons disabled for it):", width));
      for (const u of a.unrecognizedTierModels) lines.push(...wrapPrefixed("    ", `${u.pointer} = ${JSON.stringify(u.value)}`, width));
    }

    if (!a.settingsParseOk) {
      lines.push(...wrapPrefixed("  warning:    ", `${a.settingsFile} exists but is not valid JSON — left untouched`, width));
    }
    if (a.agent === "codex") {
      if (a.configTomlReadable === false) {
        lines.push(
          ...wrapPrefixed(
            "  warning:    ",
            "config.toml exists but could not be read or parsed confidently — it was left untouched and every Codex seed setting was skipped, so the model, reasoning effort and approval defaults never landed",
            width,
          ),
        );
      }
      if (a.unspawnableCodexHooks.length) {
        lines.push(...wrapPrefixed("", "  hook commands that cannot spawn:", width));
        const hookLabelWidth = Math.max(...a.unspawnableCodexHooks.map((h) => tty.displayWidth(codexHookLabel(h))));
        for (const h of a.unspawnableCodexHooks) {
          lines.push(fitLabelValueLine("    ", codexHookLabel(h), hookLabelWidth, h.command, width));
          lines.push(...wrapPrefixed("      — ", h.reason, width));
        }
        lines.push(
          ...wrapPrefixed(
            "      fix:  ",
            "reinstall so the installer writes a space-free executable path — run `softela-ai update --agent codex --yes`.",
            width,
          ),
        );
      }

      if (a.codexHookTrust.applicable) {
        if (a.codexHookTrust.unapproved.length) {
          lines.push(...wrapPrefixed("", "  hooks awaiting approval — expected right after a fresh install, not a broken installation:", width));
          lines.push(
            ...wrapPrefixed(
              "    ",
              "until a human completes Codex's one-time hook-trust review, Codex runs none of these hooks and says nothing when it skips them — nothing here is enforced yet.",
              width,
            ),
          );
          lines.push(
            ...wrapPrefixed(
              "    fix: ",
              "open Codex and complete its one-time hook-trust review, then rerun `softela-ai doctor` to confirm.",
              width,
            ),
          );
          for (const h of a.codexHookTrust.unapproved) {
            lines.push(...wrapPrefixed("    ", `${codexHookLabel(h)}  ${h.command}`, width));
          }
        } else {
          lines.push(
            ...wrapPrefixed(
              "  hook trust: ",
              "every registered hook has a [hooks.state] entry in config.toml — a command edited since approval still needs approving again.",
              width,
            ),
          );
        }
      }

      // Skipped exactly when the "hooks awaiting approval" finding above
      // already said this: that Codex will not run these hooks until the
      // one-time trust review is complete. Printed in every other case
      // (nothing applicable, or every hook already carries a trust entry),
      // where the caveat's own hashing-verification nuance is not yet stated
      // by anything else on the page.
      if (!(a.codexHookTrust.applicable && a.codexHookTrust.unapproved.length)) {
        lines.push(...wrapPrefixed("  codex trust: ", CODEX_TRUST_CAVEAT, width));
      }
    }

    // A real, copy-pasteable filesystem path — never truncated, the same
    // "never mangle something meant to be typed verbatim" rule
    // `index.js#printClosingSummary` applies to its own equivalent line.
    // Unlike that line, this one can genuinely be too wide for a narrow
    // terminal, so it wraps under its own label with a hanging indent
    // exactly like every other long value in this report — the same
    // `wrapPrefixed` used throughout, not a bespoke mechanism.
    lines.push(...wrapPrefixed("  run via:    ", a.runCommand, width));
    lines.push("");
  }

  lines.push(...formatParitySection(report.parity, width));

  if (report.invalidProjects.length) {
    lines.push(...wrapPrefixed("", "project configs failing schema validation:", width));
    for (const p of report.invalidProjects) {
      lines.push(...wrapPrefixed("  ", p.file, width));
      for (const e of p.errors) lines.push(...wrapPrefixed("    ", e, width));
    }
  } else {
    lines.push("project configs: all valid");
  }

  if (report.schemaKeywordsUnhandled.length) {
    lines.push(
      ...wrapPrefixed("", `project schema uses keyword(s) doctor's validator does not check: ${report.schemaKeywordsUnhandled.join(", ")}`, width),
    );
  }

  return lines.map((l) => l.trimEnd());
}

/**
 * Decides `doctor`'s exit code.
 *
 * @param {object} report As built by {@link buildReport}.
 * @returns {number} `1` when an installed agent is missing a file the
 * manifest says should exist, an installed settings file failed to parse,
 * Codex's `config.toml` could not be read confidently, a project config
 * fails schema validation, an agent's `overrides.json` fails schema
 * validation, an agent carries an override classified `"invalid"`
 * (CONTRACTS §6 — a misconfigured override must be as visible as any other
 * real problem, not merely informational), the `memory-as-context` module's
 * seed is stuck on an ambiguous `MEMORY.md` ({@link buildMemoryReport}'s own
 * `indexBlocked` — M1's own bug: this state otherwise emits no error
 * anywhere, and its own on-disk marker used to falsely claim success), a
 * registered Codex hook command can never spawn ({@link listUnspawnableCodexHooks}
 * — Codex fails this silently, so `doctor` is the only place it can ever
 * surface), or a registered Codex hook carries no `[hooks.state]` trust entry at all
 * ({@link listUnapprovedCodexHooks} — an untrusted hook enforces nothing,
 * just as silently), a rule module `core/guards/index.js` could not load or
 * validate ({@link buildReport}'s `ruleLoadErrors` — a rule that cannot
 * load is not protecting anyone, exactly like an unspawnable or untrusted
 * Codex hook), or the rule registry loaded zero rules at all
 * (`ruleRegistryEmpty` — total non-enforcement); `0` otherwise — everything
 * else `doctor` reports (drift, an `"ignored"` override, changed seed
 * settings, the Codex trust caveat, a schema keyword the validator does not
 * check, Codex's `askMode`, and — deliberately — a Claude/Codex
 * {@link buildParityReport} mismatch, which this function never reads at
 * all) is informational, not a failure. Parity is a "does this diverge from
 * the other agent" question, not a "is this installation broken" one; the
 * two are allowed to diverge on purpose.
 */
function doctorExitCode(report) {
  const hasRealProblem = report.agents.some(
    (a) =>
      a.missing.length > 0 ||
      !a.settingsParseOk ||
      a.configTomlReadable === false ||
      a.overridesSchemaErrors.length > 0 ||
      a.overrides.some((o) => o.state === "invalid") ||
      // `a.memory` is read defensively, exactly like `formatDoctorReport`'s
      // own rendering above — a report built by hand for a narrower test
      // never claims to model the memory-as-context module's own seed
      // state, and must resolve exactly as it always has.
      (!!a.memory && a.memory.moduleEnabled && !a.memory.unreadable && a.memory.indexBlocked) ||
      a.unspawnableCodexHooks.length > 0 ||
      (a.codexHookTrust.applicable && a.codexHookTrust.unapproved.length > 0),
  );
  // `ruleLoadErrors`/`ruleRegistryEmpty` are read defensively: a report
  // built by hand for a narrower test never claims to model the rule
  // registry at all, and must still resolve exactly as it always has.
  return hasRealProblem || report.invalidProjects.length || (report.ruleLoadErrors || []).length || report.ruleRegistryEmpty ? 1 : 0;
}

module.exports = {
  buildReport,
  formatDoctorReport,
  doctorExitCode,
  validateProjectConfigs,
  validateAgainst,
  findUnhandledSchemaKeywords,
  unhandledSchemaKeywords,
  listOverrides,
  listOverridesFromRaw,
  validateOverridesConfig,
  buildParityReport,
  HOOK_EVENT_JOBS,
  CODEX_TRUST_CAVEAT,
  listRegisteredCodexHooks,
  judgeCodexHookExecutable,
  listUnspawnableCodexHooks,
  codexHookTrustSectionPath,
  listUnapprovedCodexHooks,
  resolveCodexAskMode,
  buildMemoryReport,
  resolveMemoryLocationOption,
};
