"use strict";

/**
 * Computes the list of actions an install or update would take, without
 * touching the filesystem (INSTALLER.md §3, CONTRACTS §9).
 *
 * `buildPlan` is a pure function: everything it needs about disk and the
 * repository arrives already gathered on `ctx` (`detect.js#gather`), and
 * everything it decides is returned as data for `apply.js` to execute. The
 * same `ctx` always produces the same plan.
 */

const path = require("path");
const { readText } = require("../lib/fs-safe");
const sj = require("./settings-json");
const st = require("./settings-toml");
const mb = require("./managed-block");
const codexModels = require("../lib/codex-models");
const shortPath = require("../lib/short-path");

/**
 * Quotes a path for inclusion in a shell command line — re-exported from
 * `core/lib/short-path.js` so every existing caller of `plan.js#quoted`
 * keeps working unchanged.
 *
 * @param {string} p The path to quote.
 * @returns {string} `p` wrapped in double quotes, so a Node install under
 * e.g. `C:\Program Files\nodejs\node.exe` still parses as one token.
 */
function quoted(p) {
  return shortPath.quotePath(p);
}

/**
 * Resolves one absolute path into the exact token a hook `command` template
 * substitutes it for. The two hosts this installer targets launch a hook
 * command in opposite ways, so the token each one needs is opposite too:
 *
 * - Claude Code hands the whole command string to a POSIX shell
 *   (`/usr/bin/bash` on Windows), which treats a bare backslash as an escape
 *   character and destroys an unquoted Windows path — so this always quotes,
 *   via {@link quoted} (`core/lib/short-path.js#quotePath`), regardless of
 *   whether `absPath` carries a space.
 * - Codex spawns argv[0] directly with no shell, splitting the command on
 *   whitespace — a quoted executable path is taken completely literally,
 *   quote characters included, and never starts; only a bare, space-free
 *   token works there. This keeps today's behavior unchanged for Codex:
 *   `core/lib/short-path.js#resolvePathToken`, which produces that bare
 *   token when it can and an honest quoted fallback when it cannot.
 *   `ctx.shortPathOptions`, when a caller sets it (tests only;
 *   `detect.js#gather` never does), is threaded through unchanged so a test
 *   can drive both the short-path-succeeds and the falls-back-to-quoted
 *   branch by injecting `shortPathResolver`, without depending on this
 *   machine's own volume settings.
 *
 * @param {object} ctx The gathered context (`ctx.agent` is `"claude"` or
 * `"codex"`).
 * @param {string} absPath An absolute filesystem path.
 * @returns {string} The token to substitute.
 */
function pathToken(ctx, absPath) {
  if (ctx.agent === "claude") return shortPath.quotePath(absPath);
  return shortPath.resolvePathToken(absPath, ctx.shortPathOptions).value;
}

/**
 * Builds the substitution variables shared by every template this
 * installer fills in (MODULES.md "Substitutions").
 *
 * Every path-valued entry (`NODE`, `DISPATCH`, `INSTALLED`, `AGENT_HOME`) is
 * resolved through {@link pathToken}, host-aware: always quoted for Claude
 * Code, and a bare space-free token when one can be produced and verified
 * for Codex (falling back to quoted otherwise) — see {@link pathToken}'s own
 * doc comment for why the two hosts need opposite shapes. Every hook
 * `command` template that uses one of these tokens
 * (`adapters/*\/*.fragment.json`, `modules/*\/module.json`) therefore
 * carries no literal quotes of its own around them any more — the token
 * itself always supplies whatever quoting its host needs.
 *
 * @param {object} ctx The gathered context.
 * @returns {object} `{NODE, DISPATCH, APPROVE_HOOK, INSTALLED, AGENT_HOME, STATE_DIR, VERSION}`.
 */
function baseVars(ctx) {
  return {
    NODE: pathToken(ctx, ctx.nodeExe),
    DISPATCH: pathToken(ctx, path.join(ctx.installedRoot, "adapters", ctx.agent, "dispatch.js")),
    // Shared rather than per-agent: the in-session approval channel reads the
    // same `UserPromptSubmit` payload and writes the same approvals file on
    // both hosts, so a second copy would only be a second thing to drift.
    APPROVE_HOOK: pathToken(ctx, path.join(ctx.installedRoot, "adapters", "shared", "approve-from-prompt.js")),
    INSTALLED: pathToken(ctx, ctx.installedRoot),
    AGENT_HOME: pathToken(ctx, ctx.home),
    STATE_DIR: path.join(ctx.home, ".softela-ai"),
    VERSION: ctx.version,
  };
}

/**
 * Finds which unavailable shipped area, if any, a manifest-relative path
 * falls under.
 *
 * @param {string} relPath A manifest-relative path, e.g.
 * `"softela-ai/adapters/codex/dispatch.js"`.
 * @param {string[]} unavailableAreas Shipped-directory prefixes the running
 * source could not currently produce (`detect.js#gather`'s
 * `unavailableAreas`).
 * @returns {string | null} The matching prefix, or `null` when `relPath`
 * falls under none of them.
 */
function findUnavailableArea(relPath, unavailableAreas) {
  for (const area of unavailableAreas) {
    if (relPath === area || relPath.startsWith(`${area}/`)) return area;
  }
  return null;
}

/**
 * Plans every tracked file: the core payload, every known agent's adapter,
 * and every enabled module's files (INSTALLER.md §4, "the three cases").
 *
 * Before a manifest-tracked file that is no longer in the shipped list is
 * planned as removable, this checks whether the running source could have
 * produced its whole area at all (Layer 2, the cross-agent update
 * invariant): a directory that is absent or empty in the current source is
 * never evidence the files it used to ship should be deleted — it is
 * evidence the source is incomplete. Pruning is skipped for that entire area
 * rather than guessed at file by file.
 *
 * @param {object} ctx The gathered context. `ctx.unavailableAreas`
 * (optional; treated as empty when absent) names the areas this guard
 * applies to.
 * @param {object[]} actions The plan being built; entries are pushed onto
 * it.
 * @returns {void}
 */
function planFiles(ctx, actions) {
  const unavailableAreas = ctx.unavailableAreas || [];

  for (const f of ctx.files) {
    const target = path.join(ctx.home, f.relPath);
    const base = { kind: "copy", agent: ctx.agent, target, source: f.sourceAbsPath, relPath: f.relPath };

    if (f.shippedHash === null) {
      const area = findUnavailableArea(f.relPath, unavailableAreas);
      if (area) {
        actions.push({
          ...base,
          kind: "skip",
          state: "obsolete",
          action: "none",
          areaUnavailable: true,
          area,
          reason: `"${area}" is missing or empty in the current source — pruning skipped rather than risk deleting another installation's files`,
        });
        continue;
      }

      // No longer shipped by this version of the repository.
      if (f.onDiskHash === null) {
        actions.push({ ...base, kind: "skip", state: "obsolete", action: "none", reason: "no longer shipped, already gone" });
      } else if (f.onDiskHash === f.manifestHash) {
        actions.push({ ...base, kind: "remove", state: "obsolete", action: "remove", reason: "no longer shipped" });
      } else {
        actions.push({
          ...base,
          kind: "skip",
          state: "obsolete",
          action: "none",
          reason: "locally modified, no longer shipped — left in place",
          locallyModified: true,
        });
      }
      continue;
    }

    if (f.onDiskHash === null) {
      const state = f.manifestHash !== undefined ? "absent" : "new";
      actions.push({
        ...base,
        state,
        action: "write",
        reason: state === "absent" ? "missing on disk — installing fresh" : "new file",
      });
    } else if (f.onDiskHash === f.shippedHash) {
      // On-disk bytes are exactly what this version would write — but that
      // alone is not proof of ownership, and the ways it can happen must not
      // all be treated alike. Stronger corroborating evidence than content
      // recovers ownership immediately; weaker evidence is refused rather
      // than silently adopted, because claiming ownership now only surfaces
      // as a silent overwrite later, once the shipped file diverges and the
      // "content happens to match" excuse no longer holds:
      //
      // - the manifest DOES have an entry for this exact path, just a wrong
      //   one (a hand-edit, or a stale value a bug once wrote) — real
      //   evidence this installer wrote the file at some point.
      // - no entry for this path, but a manifest for this install does exist
      //   — it simply lost this one entry (e.g. a write that landed before
      //   its checkpoint recorded it). The rest of the manifest still
      //   corroborates a prior install, so this also recovers in place.
      // - no entry for this path, AND no manifest exists at all — nothing
      //   whatsoever corroborates a prior install. "A developer file could
      //   never coincide with the shipped hash" does not hold once copying
      //   or vendoring the file verbatim is exactly what produces that
      //   coincidence, so this weakest case is never silently adopted: kept
      //   as-is, with the shipped bytes written to a `.new` sibling — the
      //   one file action the CLI always prints its reason for, so this
      //   stays visible on every run it keeps recurring on, not silent even
      //   once.
      if (f.manifestHash === f.shippedHash) {
        actions.push({ ...base, kind: "skip", state: "current", action: "none", reason: "unchanged" });
      } else if (f.manifestHash === undefined && !ctx.manifest) {
        // No manifest object exists at all — not merely missing this one
        // entry, but nothing to corroborate a prior install with. This is
        // the case with no evidence whatsoever this installer ever wrote the
        // file, so it is never adopted silently: kept as-is, with the
        // shipped bytes written to a `.new` sibling instead — the one file
        // action the CLI always names its reason for, so this stays visible
        // on every run it keeps recurring on, not silent even once.
        actions.push({
          ...base,
          state: "modified",
          action: "write-new",
          recoveredOwnership: "unseen",
          reason:
            "not tracked by any manifest — none exists at all — though its content happens to match exactly what " +
            "this version ships; could be a fully lost manifest.json, or a developer's own file that coincidentally " +
            "matches (e.g. copied or vendored from this repository); keeping it as-is and writing the shipped " +
            "version as .new rather than silently claiming ownership",
        });
      } else {
        // Writing (even though the bytes are already identical) is what
        // re-enters this file into the manifest apply.js builds, under its
        // correct hash. Reached two different ways, each with its own
        // corroborating evidence a prior install really did write this file:
        // a manifest exists and simply lost this one entry (e.g. a write
        // that landed before its checkpoint recorded it — the rest of the
        // manifest is intact), or a manifest entry for this exact path is
        // present but recorded the wrong hash (a hand-edit, or a stale
        // value). Marked `recoveredOwnership` either way so a consumer of
        // the plan's data — `--dry-run --json` included — can always see
        // that this write is a recovery, not an ordinary update.
        actions.push({
          ...base,
          state: "current",
          action: "write",
          recoveredOwnership: f.manifestHash === undefined ? "lost-entry" : "stale-hash",
          reason:
            f.manifestHash === undefined
              ? "not tracked by the manifest, though a manifest for this install exists and simply lost this one " +
                "entry — its content matches exactly what this version ships, so ownership is recovered"
              : "tracked by the manifest under a hash that does not match its content — recovering ownership",
        });
      }
    } else if (f.manifestHash !== undefined && f.onDiskHash === f.manifestHash) {
      // Matches exactly what the manifest recorded — a prior version this
      // tool itself wrote, simply out of date against what is shipping now.
      actions.push({ ...base, state: "current", action: "write", reason: "updated by this version" });
    } else {
      // Content matching neither the shipped file nor whatever the manifest
      // recorded (or, since the manifest has no entry at all, no known prior
      // version to compare against) is treated as the developer's own,
      // whether it always was or was a shipped file they edited after
      // install — content alone cannot tell the two apart, and both must be
      // preserved the same way rather than risk overwriting an edit.
      actions.push({
        ...base,
        state: "modified",
        action: "write-new",
        reason:
          f.manifestHash === undefined
            ? "not tracked by the manifest — keeping it, writing the shipped version as .new"
            : "locally modified — keeping yours, writing .new",
      });
    }
  }
}

/**
 * Per-hook timeout, in seconds, written into every hook registration this
 * installer produces, for both hosts — the config key is `timeout` in both
 * `~/.codex/hooks.json` handler objects and Claude Code `settings.json`
 * hook entries (never `timeoutSec`, which only names an OpenTelemetry
 * attribute and an internal Rust field inside the Codex binary, and is
 * silently ignored if written into a config file).
 *
 * Neither host defaults to anything safe for a hook this fast: an omitted
 * value defaults to 600 seconds on Codex, during which a synchronous
 * PreToolUse hook blocks the tool call that triggered it — not a safety net
 * for a hook whose own work finishes in milliseconds.
 *
 * The value is thirty seconds rather than the five it started at, because
 * the number that matters is not how long the hook's own work takes but how
 * long the machine takes to start it. Measured on this repository's own dev
 * machine: a dispatch that runs in ~330 ms idle takes **2.8 seconds** while
 * every core is busy — and a full frontend test run, a backend build and two
 * subagents are exactly what is happening when an agent is doing real work.
 * At five seconds those runs timed out repeatedly.
 *
 * A timeout is not a neutral outcome on Codex: the hook is marked failed and
 * the tool call proceeds **unreviewed** (CONTRACTS §7). So a timeout budget
 * set too tight does not slow the guards down, it silently switches them off
 * precisely when the most work is being done. Thirty seconds still bounds a
 * hook that genuinely hangs — the case this constant exists for — while
 * leaving contention no way to disable enforcement by accident.
 *
 * Codex's `SessionEnd` event is the one documented exception: it defaults to
 * 1 second and is capped at 3. This installer registers no `SessionEnd` hook
 * today, so this constant never applies there — but if one is ever added, it
 * must use a value at or under that 3-second cap, not this constant.
 */
const HOOK_TIMEOUT_SECONDS = 30;

/**
 * Stamps {@link HOOK_TIMEOUT_SECONDS} onto every handler object in a hook
 * entry's `hooks` array — the one point {@link planHooks} (the core
 * dispatcher, built from the shipped fragment) and {@link planModuleHooks}
 * (a module's own hooks) both pass their `desired` entry through before
 * planning it, for either host.
 *
 * @param {{matcher: *, hooks: object[]}} entry A hook entry, already
 * substituted.
 * @returns {object} `entry`, mutated in place, for convenient chaining at
 * its call sites.
 */
function withHookTimeout(entry) {
  if (entry && Array.isArray(entry.hooks)) {
    for (const h of entry.hooks) h.timeout = HOOK_TIMEOUT_SECONDS;
  }
  return entry;
}

/**
 * Plans the dispatcher's `enforce` registration for every event the
 * shipped fragment names (CONTRACTS §9, INSTALLER.md §5). Rewritten every
 * update — a rule change has to actually reach the machine.
 *
 * @param {object} ctx The gathered context.
 * @param {object[]} actions The plan being built.
 * @param {Map<string, number>} pendingAppends How many entries have already
 * been staged for each event this planning pass, shared with
 * {@link planModuleHooks} so a plan against a fresh file reports the index
 * each entry will actually land at, not the index it would land at against
 * the untouched file alone; mutated.
 * @returns {void}
 */
/**
 * Picks the needle that identifies one core fragment registration on disk —
 * the substring `settings-json.js` locates an existing entry by, so a second
 * install run recognises what the first one wrote instead of appending a
 * duplicate.
 *
 * Read off the entry's OWN substituted command rather than assumed. This was
 * hard-coded to `vars.DISPATCH` while the dispatcher was the only thing the
 * fragments registered; the moment a second core hook was added
 * (`UserPromptSubmit`, the approval channel) that assumption silently made it
 * unrecognisable to every later run — planned as `new` every time, and
 * reported by `conflicts.js` as a foreign registration the installer then
 * refused to proceed over. A needle taken from the command itself cannot
 * drift that way when a third one is added.
 *
 * The resolved token, not the raw path, is what is matched: `pathToken`
 * gives a host-aware shape (quoted for Claude Code, bare-when-possible for
 * Codex), and only that shape actually appears inside a substituted command.
 *
 * @param {{hooks?: object[]}} desired The substituted hook entry.
 * @param {object} vars {@link baseVars}' own resolved tokens.
 * @returns {string} The matching core-script token, defaulting to the
 * dispatcher's — which is what every pre-existing registration used, so an
 * entry this function does not recognise keeps behaving exactly as it did.
 */
function coreHookNeedle(desired, vars) {
  const commands = (Array.isArray(desired && desired.hooks) ? desired.hooks : [])
    .map((h) => String((h && h.command) || ""))
    .join("\n");
  for (const token of [vars.APPROVE_HOOK, vars.DISPATCH]) {
    if (token && commands.includes(token)) return token;
  }
  return vars.DISPATCH;
}

function planHooks(ctx, actions, pendingAppends) {
  const vars = baseVars(ctx);
  const events = Object.keys((ctx.fragment && ctx.fragment.hooks) || {});

  for (const event of events) {
    const rawEntries = ctx.fragment.hooks[event];
    if (!Array.isArray(rawEntries)) continue;

    for (const rawEntry of rawEntries) {
      const desired = withHookTimeout(sj.substituteDeep(rawEntry, vars));
      const needle = coreHookNeedle(desired, vars);
      const info = sj.planHookEvent(ctx.settings.content, event, desired, needle, pendingAppends.get(event) || 0);
      if (!info.exists) pendingAppends.set(event, (pendingAppends.get(event) || 0) + 1);

      actions.push({
        kind: "settings",
        agent: ctx.agent,
        target: ctx.settingsFile,
        pointer: info.pointer,
        mode: "enforce",
        state: info.exists ? (info.changed ? "modified" : "current") : "new",
        action: info.changed ? "write" : "keep",
        reason: info.changed
          ? `hooks.${event}[softela-ai] ${info.exists ? "re-registering" : "registering"} ${
              needle === vars.APPROVE_HOOK ? "the approval channel" : "the dispatcher"
            }`
          : `hooks.${event}[softela-ai] already registered`,
        value: desired,
        event,
        needle,
      });
    }
  }

  // Codex's `hooks.json` also carries a top-level `description`
  // (CONTRACTS §7, "Verified Codex registration file") — a scalar piece of
  // metadata, not a hook registration or a shipped permission entry, so
  // CONTRACTS §9 licenses it only as `seed`: written once, when absent,
  // never overwriting a developer's own text (IMPORTANT I1).
  if (typeof ctx.fragment.description === "string") {
    const info = sj.planSeedKey(ctx.settings.content, "/description");
    actions.push({
      kind: "settings",
      agent: ctx.agent,
      target: ctx.settingsFile,
      pointer: "/description",
      mode: "seed",
      state: info.present ? "current" : "new",
      action: info.action,
      reason: info.present ? "description present — left alone" : "seeding the registration file's description",
      value: ctx.fragment.description,
    });
  }
}

/**
 * Extracts the stable part of a module hook's command that identifies its
 * own script, independent of any option value substituted alongside it —
 * `{{AGENT_HOME}}` or an `{{OPT_*}}` token can change from one run to the
 * next without the registration itself becoming a different entry.
 *
 * `installedToken` must be the already-resolved substitution — `baseVars(ctx)
 * .INSTALLED` (`{@link pathToken}`'s own output for `ctx.installedRoot`) —
 * never the raw `ctx.installedRoot` path. The two diverge in shape per host:
 * Claude Code's is always wrapped in quotes, Codex's is bare and space-free
 * (or quoted, on its own rarer fallback). A needle built from the raw root
 * instead never appears verbatim inside the substituted `command` string
 * `sj.substitute`/`substituteDeep` actually produced, so ownership never
 * matches — a registration this tool wrote is then misclassified as a
 * foreign one on every `update`/`doctor` run, and left behind by
 * `uninstall`. Every call site (this module and `conflicts.js`) must resolve
 * `installedToken` the same way; `conflicts.js` calls this function directly
 * rather than keeping its own copy, so there is only ever one place this can
 * drift.
 *
 * @param {string} rawCommand The unsubstituted `command` template from
 * `module.json`.
 * @param {string} installedToken The resolved `INSTALLED` substitution for
 * this host, exactly as {@link baseVars} produces it.
 * @returns {string | null} The needle this entry's ownership is matched on,
 * or `null` when the template does not follow the shipped
 * `{{INSTALLED}}/hooks/<file>.js` shape.
 */
function extractHookScriptNeedle(rawCommand, installedToken) {
  const match = /\/hooks\/[\w.-]+\.js/.exec(String(rawCommand || ""));
  return match ? `${installedToken}${match[0]}` : null;
}

/**
 * Builds `{{OPT_<NAME>}}` substitution values for one module, from its
 * currently-stored option values, falling back to `module.json`'s own
 * declared default for any option not yet stored (MODULES.md
 * "Substitutions").
 *
 * An `enum`-typed option's stored value is validated against its own
 * declared `values` here — the single choke point every substitution site
 * (a hook `command`, a `prompt.md` body) reads through, regardless of how
 * the value reached `state.json` (a validated CLI flag, a hand-edited
 * state file, or a future caller that adds none of its own checking). A
 * value outside the declared set is never trusted; the option's own
 * default is substituted in its place instead.
 *
 * @param {object} state The agent's local state (`state.js#readState`).
 * @param {{id: string, json: object}} mod The module.
 * @returns {object} One `OPT_<UPPER_NAME>` entry per option the module
 * declares; a list value is joined with `", "`.
 */
function buildOptionVars(state, mod) {
  const stored = (state && state.options && state.options[mod.id]) || {};
  const defs = mod.json.options || {};
  const vars = {};
  for (const [name, def] of Object.entries(defs)) {
    let value = stored[name] !== undefined ? stored[name] : def.default;
    if (def && def.type === "enum" && Array.isArray(def.values) && !def.values.includes(value)) {
      value = def.default;
    }
    vars[`OPT_${name.toUpperCase()}`] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return vars;
}

/**
 * The characters a free-text option value may safely carry into a hook
 * `command` template's own double-quoted argument (MODULES.md's
 * substitution convention — see e.g. `modules/reply-language/module.json`'s
 * `--languages="{{OPT_LANGUAGES}}"`), on every shell softela-ai installs onto —
 * POSIX sh, cmd.exe and PowerShell, whichever the host happens to run the
 * generated command line through.
 *
 * Stripping a fixed set of "dangerous" characters was tried first and
 * proved unsafe, because each shell closes, expands or re-quotes a
 * different set of characters even inside an already-double-quoted
 * argument:
 *
 * - a POSIX `$(...)` command substitution or a backtick still runs;
 * - `%VAR%` still expands under `cmd.exe`, before argv is ever parsed;
 * - a trailing backslash still escapes the template's own closing quote.
 *
 * Allowing only this conservative set instead is safe by construction —
 * nothing outside it can be assembled into new syntax in any of the three —
 * rather than only as safe as the last character class someone thought to
 * strip.
 */
const COMMAND_LINE_UNSAFE_CHAR = /[^\p{L}\p{M}\p{N} ,.'-]/u;

/**
 * Finds the first `OPT_*` substitution value a hook `command` template
 * cannot safely embed (see {@link COMMAND_LINE_UNSAFE_CHAR}).
 *
 * @param {object} vars A vars map as {@link buildOptionVars} extends
 * {@link baseVars} with.
 * @returns {{name: string, char: string} | null} The offending option's
 * own declared name (`OPT_LANGUAGES` reads back as `"languages"`) and its
 * first disallowed character; `null` when every `OPT_*` value is safe.
 */
function findUnsafeOptionValue(vars) {
  for (const key of Object.keys(vars)) {
    if (!key.startsWith("OPT_")) continue;
    const match = COMMAND_LINE_UNSAFE_CHAR.exec(String(vars[key]));
    if (match) return { name: key.slice(4).toLowerCase(), char: match[0] };
  }
  return null;
}

/**
 * Checks whether a value carries `managed-block.js`'s `BEGIN` or `END`
 * marker — directly, or as a fragment that stripping literal occurrences of
 * the OTHER marker would reassemble into one. A value built as `BEGIN`'s
 * first half, then a full `END`, then `BEGIN`'s second half contains neither
 * marker as a literal substring by itself, yet removing the embedded `END`
 * reassembles a complete `BEGIN` from what is left behind.
 *
 * Detection strips to a fixed point — repeatedly removing every `BEGIN`/`END`
 * occurrence until a pass changes nothing — but only to answer yes/no. The
 * stripped string is never returned or embedded anywhere: {@link
 * findBlockDelimiterOptionValue} rejects an offending value outright instead,
 * the same way {@link findUnsafeOptionValue} rejects a command-line-unsafe
 * value rather than editing it. The loop always terminates because every
 * pass that changes the string strictly shortens it.
 *
 * @param {string} value The raw substituted value.
 * @returns {boolean} `true` when `value` contains, or can be stripped down to
 * reveal, a `BEGIN` or `END` marker.
 */
function containsBlockDelimiterFragment(value) {
  const original = String(value);
  let current = original;
  for (;;) {
    const stripped = current.split(mb.BEGIN).join("").split(mb.END).join("");
    if (stripped === current) break;
    current = stripped;
  }
  return current !== original;
}

/**
 * Finds the first `OPT_*` substitution value that would let a free-text
 * option fragment the managed-block body `managed-block.js` writes between
 * its own `BEGIN`/`END` markers (see {@link containsBlockDelimiterFragment}) —
 * the point at which a value (a language list, a path — never enum-checked,
 * so this cannot be closed by validation alone) enters the text
 * `managed-block.js` parses back out of `CLAUDE.md`/`AGENTS.md` on the next
 * update.
 *
 * @param {object} optVars A module's own `{{OPT_<NAME>}}` vars, as {@link
 * buildOptionVars} returns.
 * @returns {{name: string} | null} The offending option's own declared name
 * (`OPT_LANGUAGES` reads back as `"languages"`); `null` when every value is
 * free of marker fragments.
 */
function findBlockDelimiterOptionValue(optVars) {
  for (const key of Object.keys(optVars)) {
    if (!key.startsWith("OPT_")) continue;
    if (containsBlockDelimiterFragment(optVars[key])) return { name: key.slice(4).toLowerCase() };
  }
  return null;
}

/**
 * Validates every enabled module's current option values exactly once,
 * before either consumer resolves its own vars from them — a hook `command`
 * line ({@link planModuleHooks}) and the global instructions block ({@link
 * planGlobalInstructions}) both read through {@link buildOptionVars}, and an
 * earlier version of this file gated only the first of the two: a value
 * {@link findUnsafeOptionValue} rejected for a command line still reached
 * the block body unfiltered. A value that is unsafe is unsafe everywhere it
 * could go, so it is checked here, once, and both consumers skip a module
 * this function flags rather than each re-deriving the same judgement (and
 * each risking forgetting to).
 *
 * Two independent hazards are checked, either sufficient alone against
 * today's marker text (which cannot be spelled using only the characters
 * {@link COMMAND_LINE_UNSAFE_CHAR} allows) but each closing a gap the other
 * does not: a character a shell could turn into new syntax, and a fragment
 * that could reassemble into a stray `BEGIN`/`END` marker regardless of what
 * characters it uses.
 *
 * @param {object} ctx The gathered context.
 * @param {object[]} actions The plan being built; one `kind: "config-error"`
 * entry is pushed per module whose option values fail either check.
 * @returns {Set<string>} The ids of every enabled module flagged unsafe —
 * {@link planModuleHooks} and {@link planGlobalInstructions} both skip these
 * modules' own contribution instead of resolving unsafe vars a second time.
 */
function planOptionErrors(ctx, actions) {
  const unsafeModuleIds = new Set();
  for (const mod of ctx.enabledModules) {
    const optVars = buildOptionVars(ctx.state, mod);

    const unsafeChar = findUnsafeOptionValue(optVars);
    if (unsafeChar) {
      unsafeModuleIds.add(mod.id);
      actions.push({
        kind: "config-error",
        agent: ctx.agent,
        target: null,
        pointer: `/options/${unsafeChar.name}`,
        mode: "enforce",
        state: "invalid",
        action: "none",
        reason: `${mod.id}'s "${unsafeChar.name}" option contains "${unsafeChar.char}", which a command-line value may not carry — only letters, numbers, spaces, and , . ' - are allowed; edit the value and re-run install`,
        module: mod.id,
      });
      continue;
    }

    const unsafeDelimiter = findBlockDelimiterOptionValue(optVars);
    if (unsafeDelimiter) {
      unsafeModuleIds.add(mod.id);
      actions.push({
        kind: "config-error",
        agent: ctx.agent,
        target: null,
        pointer: `/options/${unsafeDelimiter.name}`,
        mode: "enforce",
        state: "invalid",
        action: "none",
        reason: `${mod.id}'s "${unsafeDelimiter.name}" option contains a fragment of the managed instructions block's BEGIN/END delimiter, which could corrupt it on the next update; edit the value and re-run install`,
        module: mod.id,
      });
    }
  }
  return unsafeModuleIds;
}

/**
 * Plans every enabled module's own hook registrations (MODULES.md
 * `module.json.hooks`), the same `enforce` mechanism as the core
 * dispatcher, and removes the registration of any module that was
 * previously enabled and no longer is.
 *
 * A module {@link planOptionErrors} already flagged unsafe contributes no
 * hook action here — none of that module's hooks are planned this run, so a
 * value that cannot safely reach a command line never reaches one; the
 * developer's own prior registration, if any, is left exactly as it was.
 *
 * @param {object} ctx The gathered context.
 * @param {object[]} actions The plan being built.
 * @param {Map<string, number>} pendingAppends Shared with {@link planHooks};
 * same meaning; mutated.
 * @param {Set<string>} unsafeModuleIds Ids {@link planOptionErrors} already
 * flagged and reported a `config-error` for; skipped here rather than
 * re-checked.
 * @returns {void}
 */
function planModuleHooks(ctx, actions, pendingAppends, unsafeModuleIds) {
  const base = baseVars(ctx);

  for (const mod of ctx.enabledModules) {
    if (unsafeModuleIds.has(mod.id)) continue;
    const vars = { ...base, ...buildOptionVars(ctx.state, mod) };

    for (const rawEntry of Array.isArray(mod.json.hooks) ? mod.json.hooks : []) {
      if (!rawEntry || rawEntry.agent !== ctx.agent || typeof rawEntry.event !== "string") continue;
      const needle = extractHookScriptNeedle(rawEntry.command, base.INSTALLED);
      if (!needle) continue;

      // Codex's matcher IS a real regex, compiled by the Rust `regex` crate
      // at hook-discovery time and matched against a per-event field —
      // `tool_name` for PreToolUse/PostToolUse/PermissionRequest, `trigger`
      // for PreCompact/PostCompact, `source` for SessionStart, `agent_type`
      // for SubagentStart/SubagentStop; UserPromptSubmit and Stop ignore it.
      // Fire-tested for SessionStart's `source` field; the PreToolUse
      // `tool_name` case was not — Codex's own generated JSON Schema leaves
      // `tool_name` an unconstrained string with no enum, so the exact
      // literals it would match are unverified. `null` stays this
      // installer's deliberate, final value here: not because the mechanism
      // is absent, but because it deliberately does not rely on an
      // unverified pattern yet, letting the shared rule engine filter by
      // tool name instead (docs/internal/CONTRACTS.md §7).
      // Claude Code's own settings schema requires a string — "" meaning
      // "every phase" is what a module author means by declaring `null`
      // (MODULES.md), so only the Claude side is translated here.
      const rawMatcher = rawEntry.matcher ?? null;
      const matcher = ctx.agent === "claude" && rawMatcher === null ? "" : rawMatcher;
      const desired = withHookTimeout({ matcher, hooks: [{ type: "command", command: sj.substitute(rawEntry.command, vars) }] });
      const info = sj.planHookEvent(ctx.settings.content, rawEntry.event, desired, needle, pendingAppends.get(rawEntry.event) || 0);
      if (!info.exists) pendingAppends.set(rawEntry.event, (pendingAppends.get(rawEntry.event) || 0) + 1);

      actions.push({
        kind: "settings",
        agent: ctx.agent,
        target: ctx.settingsFile,
        pointer: info.pointer,
        mode: "enforce",
        state: info.exists ? (info.changed ? "modified" : "current") : "new",
        action: info.changed ? "write" : "keep",
        reason: info.changed
          ? `hooks.${rawEntry.event}[${mod.id}] ${info.exists ? "re-registering" : "registering"}`
          : `hooks.${rawEntry.event}[${mod.id}] already registered`,
        value: desired,
        event: rawEntry.event,
        needle,
        module: mod.id,
      });
    }
  }

  const enabledIds = new Set(ctx.enabledModules.map((m) => m.id));
  const byModule = new Map();
  for (const s of (ctx.manifest && ctx.manifest.settings) || []) {
    if (s.mode !== "enforce" || !s.module || enabledIds.has(s.module)) continue;
    if (!byModule.has(s.module)) byModule.set(s.module, new Set());
    byModule.get(s.module).add(s.event);
  }
  for (const [moduleId, events] of byModule) {
    const mod = (ctx.allModules || []).find((m) => m.id === moduleId);
    const rawHooks = mod && Array.isArray(mod.json.hooks) ? mod.json.hooks : [];
    for (const event of events) {
      const rawEntry = rawHooks.find((h) => h && h.agent === ctx.agent && h.event === event);
      const needle = rawEntry && extractHookScriptNeedle(rawEntry.command, base.INSTALLED);
      if (!needle) continue;
      actions.push({
        kind: "settings",
        agent: ctx.agent,
        target: ctx.settingsFile,
        pointer: `/hooks/${event}`,
        mode: "enforce",
        state: "obsolete",
        action: "remove",
        reason: `${moduleId} disabled — removing hooks.${event}[${moduleId}]`,
        event,
        needle,
        module: moduleId,
      });
    }
  }
}

/**
 * Plans every enabled module's `seed` settings — a Claude Code pointer
 * into `settings.json`, or a Codex pointer resolved into `config.toml`
 * (MODULES.md, CONTRACTS §9 "seed"). Never overwrites a value the
 * developer's own configuration already has.
 *
 * A seed entry declares exactly one of `value` (a literal, used as-is — the
 * only form Claude Code needs, since `/model = "opus"` already resolves on
 * its own) or `tier` (a cost tier resolved into a concrete Codex model id via
 * `codex-models.js#resolveModelForTier` — Codex has no bare tier alias, so
 * this is the only agent `tier` is meaningful for). Declaring both, or
 * neither, or a `tier` for an agent other than `"codex"`, is a configuration
 * error reported as a `kind: "config-error"` action rather than guessed at
 * one way or the other.
 *
 * Resolving a tier only runs when the pointer is confidently absent — a
 * pointer `settings-toml.js#planSeedKey` already finds present never reaches
 * resolution at all, which is what makes "the developer's own value wins"
 * true without this function needing to implement it itself.
 *
 * A Codex pointer's target, `config.toml`, may not exist on disk at all — a
 * developer who has never launched Codex, or never changed a default, has
 * none. That is planned as a creation (`state: "absent"`), the same seed
 * path used for an existing-but-empty file; `config.toml` existing but
 * unreadable is left alone instead, since a file this tool cannot read is a
 * file it must not overwrite (`detect.js#gather`'s `configToml.exists`).
 *
 * @param {object} ctx The gathered context.
 * @param {object[]} actions The plan being built.
 * @returns {void}
 */
function planModuleSettings(ctx, actions) {
  for (const mod of ctx.enabledModules) {
    const entries = Array.isArray(mod.json.settings) ? mod.json.settings : [];
    for (const entry of entries) {
      if (!entry || entry.agent !== ctx.agent || entry.mode !== "seed" || typeof entry.pointer !== "string") continue;

      const hasValue = Object.prototype.hasOwnProperty.call(entry, "value");
      const hasTier = Object.prototype.hasOwnProperty.call(entry, "tier");
      if (hasValue === hasTier) {
        actions.push({
          kind: "config-error",
          agent: ctx.agent,
          target: null,
          pointer: entry.pointer,
          mode: "seed",
          state: "invalid",
          action: "none",
          reason: hasValue
            ? `${mod.id}'s seed setting for ${entry.pointer} declares both "value" and "tier" — exactly one is required`
            : `${mod.id}'s seed setting for ${entry.pointer} declares neither "value" nor "tier" — exactly one is required`,
          module: mod.id,
        });
        continue;
      }
      if (hasTier && entry.agent !== "codex") {
        actions.push({
          kind: "config-error",
          agent: ctx.agent,
          target: null,
          pointer: entry.pointer,
          mode: "seed",
          state: "invalid",
          action: "none",
          reason: `${mod.id}'s seed setting for ${entry.pointer} declares "tier", but tier resolution is only meaningful for agent "codex" — use a literal "value" instead`,
          module: mod.id,
        });
        continue;
      }

      if (ctx.agent === "codex") {
        // `exists: false` is a fresh machine — the file itself is the most
        // absent a seed target can be, and a seed still writes into it.
        // `exists: true, content: null` is the opposite: something is there
        // and this tool could not read it, so it stays untouched rather than
        // risk clobbering it. Only these two share `content === null` — a
        // readable file (even an empty one) always has a string `content`
        // and falls through to the normal `planSeedKey` path below.
        const configAbsent = !!(ctx.configToml && ctx.configToml.exists === false);
        const configUnreadable = !!(ctx.configToml && ctx.configToml.exists && ctx.configToml.content === null);

        if (!ctx.configToml || configUnreadable) {
          actions.push({
            kind: "skip",
            agent: ctx.agent,
            target: ctx.configToml ? ctx.configToml.path : null,
            pointer: entry.pointer,
            mode: "seed",
            state: "unknown",
            action: "none",
            reason: ctx.configToml
              ? "config.toml exists but could not be read — skipped rather than risk overwriting it"
              : "config.toml state could not be determined — skipped rather than guessed",
            value: entry.value,
            tier: entry.tier,
            module: mod.id,
          });
          continue;
        }

        const info = st.planSeedKey(configAbsent ? "" : ctx.configToml.content, entry.pointer);
        if (!info.confident) {
          actions.push({
            kind: "skip",
            agent: ctx.agent,
            target: ctx.configToml.path,
            pointer: entry.pointer,
            mode: "seed",
            state: "unknown",
            action: "none",
            reason: `config.toml could not be parsed confidently (${info.reason}) — skipped rather than guessed`,
            value: entry.value,
            tier: entry.tier,
            module: mod.id,
          });
          continue;
        }

        let value = entry.value;
        let resolution = null;
        if (hasTier && !info.present) {
          resolution = codexModels.resolveModelForTier(entry.tier);
          value = resolution.id;
        }

        actions.push({
          kind: "settings",
          agent: ctx.agent,
          target: ctx.configToml.path,
          pointer: entry.pointer,
          mode: "seed",
          state: configAbsent ? "absent" : info.present ? "current" : "new",
          action: info.action,
          reason: info.present ? "present — left alone" : `seeding ${mod.id}'s default`,
          value,
          tier: entry.tier,
          resolution,
          module: mod.id,
        });
        continue;
      }

      if (!ctx.settings.parseOk) continue; // already reported once, in `buildPlan`

      const info = sj.planSeedKey(ctx.settings.content, entry.pointer);
      actions.push({
        kind: "settings",
        agent: ctx.agent,
        target: ctx.settingsFile,
        pointer: entry.pointer,
        mode: "seed",
        state: info.present ? "current" : "new",
        action: info.action,
        reason: info.present ? "present — left alone" : `seeding ${mod.id}'s default`,
        value: entry.value,
        module: mod.id,
      });
    }
  }
}

/**
 * Plans the global managed instructions block — the base rulebook this
 * repository always ships for an agent (`ctx.rulebookBody`,
 * `core/installer/rulebook.js#buildRulebookBody`, generated by
 * `detect.js#gather` from this run's own live facts, never from a
 * checked-in file), followed by every enabled module's own `prompt.md`, all
 * inside the single region this installer owns.
 *
 * A module {@link planOptionErrors} already flagged unsafe contributes no
 * prompt text here, the same way {@link planModuleHooks} contributes no hook
 * for it — a value unsafe for a command line or for the block body is unsafe
 * for both consumers, checked once, upstream of either.
 *
 * @param {object} ctx The gathered context.
 * @param {object[]} actions The plan being built.
 * @param {Set<string>} unsafeModuleIds Ids {@link planOptionErrors} already
 * flagged and reported a `config-error` for; skipped here rather than
 * re-checked.
 * @returns {void}
 */
function planGlobalInstructions(ctx, actions, unsafeModuleIds) {
  const vars = {
    VERSION: ctx.version,
    STANDARDS_PATH: path.join(ctx.installedRoot, "docs", "standards"),
    STATE_DIR: path.join(ctx.home, ".softela-ai"),
    AGENT_HOME: ctx.home,
  };

  const parts = [];
  if (typeof ctx.rulebookBody === "string" && ctx.rulebookBody.trim()) parts.push(sj.substitute(ctx.rulebookBody, vars).trim());
  for (const mod of ctx.enabledModules) {
    if (unsafeModuleIds.has(mod.id) || typeof mod.promptText !== "string") continue;
    const modVars = { ...vars, ...buildOptionVars(ctx.state, mod) };
    parts.push(sj.substitute(mod.promptText, modVars).trim());
  }

  if (!parts.length) {
    // Nothing this run contributes prompt text. Two different situations
    // look identical here, and must not be treated alike (IMPORTANT B2):
    // a file that has never carried a managed block is left untouched
    // rather than created empty, but a file that DOES still carry a block
    // from an earlier run — the last prompt-contributing module having just
    // been disabled — must have that block cleared, or a disable can never
    // actually remove the stale instructions it left behind.
    if (ctx.agentsMdCurrent === null || !mb.hasBlock(ctx.agentsMdCurrent)) return;
    const cleared = mb.removeBlock(ctx.agentsMdCurrent);
    actions.push({
      kind: "block",
      agent: ctx.agent,
      target: ctx.agentsMdTargetPath,
      state: "obsolete",
      action: cleared.changed ? "write" : "none",
      reason: "no module or base template contributes instructions any more — clearing the managed block",
      content: cleared.content,
    });
    return;
  }

  const body = parts.join("\n\n");
  const result = mb.upsertBlock(ctx.agentsMdCurrent || "", body);

  actions.push({
    kind: "block",
    agent: ctx.agent,
    target: ctx.agentsMdTargetPath,
    state: ctx.agentsMdCurrent === null ? "new" : result.changed ? "modified" : "current",
    action: result.changed ? "write" : "none",
    reason:
      ctx.agentsMdCurrent === null
        ? "creating the global instructions block"
        : result.changed
          ? "updating the managed block"
          : "unchanged",
    content: result.content,
  });
}

/**
 * Builds the full plan for one agent.
 *
 * @param {object} ctx The gathered context, as returned by
 * `detect.js#gather` plus `version` and `now` (`index.js` adds those two).
 * @returns {object[]} The plan, in the shape documented in INSTALLER.md §3:
 * `{kind, agent, target, pointer?, mode?, state, action, reason}`, plus a
 * few implementation-only fields (`source`, `value`, `content`, `relPath`,
 * `event`, `module`) that `apply.js` reads and the CLI renderer ignores,
 * `areaUnavailable`/`area` on a `kind: "skip"` entry {@link planFiles} left
 * un-pruned under Layer 2's guard, and `tier`/`resolution` on a codex
 * `kind: "settings"` entry from {@link planModuleSettings}. A malformed seed
 * setting (both `value` and `tier`, or neither), or a module option value
 * {@link planOptionErrors} rejects as unsafe for a command line or for the
 * global-instructions block body, surfaces as its own `kind: "config-error"`
 * entry (`target: null`, `action: "none"`) rather than a guess — `index.js`
 * prints these unconditionally and fails the run.
 */
function buildPlan(ctx) {
  const actions = [];
  planFiles(ctx, actions);

  // Computed once, unconditionally, before either consumer of a module's
  // option vars runs — including when `settings.json` itself is unparseable
  // and `planModuleHooks` below never runs at all, so a value unsafe for the
  // block body is still caught even on a run that touches no hook.
  const unsafeModuleIds = planOptionErrors(ctx, actions);

  if (ctx.settings.parseOk) {
    const pendingAppends = new Map();
    planHooks(ctx, actions, pendingAppends);
    planModuleHooks(ctx, actions, pendingAppends, unsafeModuleIds);
  } else {
    // The developer's settings file exists but is not valid JSON — writing
    // into it would mean guessing at what it should become, exactly what
    // this installer refuses to do to `config.toml` for the same reason.
    // `doctor` reports this as a real problem; the fix is manual.
    actions.push({
      kind: "skip",
      agent: ctx.agent,
      target: ctx.settingsFile,
      state: "unknown",
      action: "none",
      reason: "exists but is not valid JSON — left untouched; hook registrations and seed settings were skipped",
    });
  }

  planModuleSettings(ctx, actions);
  planGlobalInstructions(ctx, actions, unsafeModuleIds);
  return actions;
}

/**
 * Builds the plan for `uninstall`: removes every manifest-tracked file
 * (respecting the same "never destroy a local change" rule as an ordinary
 * update — a locally modified file is left in place and reported, not
 * deleted), removes this installer's `enforce` hook registrations, and
 * removes the managed instructions block. `seed` settings are never
 * touched — they are the developer's own, exactly as when a module is
 * disabled (MODULES.md "Enabling and disabling").
 *
 * @param {object} ctx A gathered context whose `files` were computed with
 * an empty shipped-file list, so every manifest entry reads as no-longer-
 * shipped (`detect.js#hashFiles` with `shippedFiles: []`), and whose
 * `enabledModules` is `[]`.
 * @returns {object[]} The uninstall plan, in the same shape {@link buildPlan}
 * returns.
 */
function buildUninstallPlan(ctx) {
  const actions = [];
  planFiles(ctx, actions);

  // Resolved once, the same way `planHooks`/`planModuleHooks` resolve it —
  // `vars.DISPATCH`/`vars.INSTALLED`, never the raw `ctx.dispatchNeedle` /
  // `ctx.installedRoot` (see `extractHookScriptNeedle`'s own doc comment for
  // why the raw root never appears verbatim in a substituted command).
  const vars = baseVars(ctx);

  // One `remove` per distinct (event, needle) pair, each carrying the exact
  // needle that entry was registered under (IMPORTANT B1). Collapsing every
  // manifest entry down to a bare Set of event names, as this used to do,
  // discards which module (if any) each entry belongs to; every remove then
  // fell back to `ctx.dispatchNeedle` in `apply.js`, so only the core
  // dispatcher's own registration was ever actually spliced out and a
  // module's hook registrations — e.g. `memory-as-context`'s three — were
  // left behind pointing at files uninstall had just deleted.
  const removals = new Map();
  for (const s of (ctx.manifest && ctx.manifest.settings) || []) {
    if (s.mode !== "enforce") continue; // seed settings are the developer's now — never removed here
    const eventMatch = /^\/hooks\/([^/]+)\//.exec(s.pointer || "");
    const event = s.event || (eventMatch && eventMatch[1]);
    if (!event) continue;

    let needle = vars.DISPATCH;
    if (s.module) {
      // Resolved exactly the way `planModuleHooks` resolves an owning
      // module's needle: look the module up by id, find its own hooks[]
      // entry for this {agent, event}, and extract its script needle from
      // that. A module the repository no longer ships, or whose hook shape
      // changed, has nothing safe to match on — skip it rather than guess.
      const mod = (ctx.allModules || []).find((m) => m.id === s.module);
      const rawEntry = mod && Array.isArray(mod.json.hooks) ? mod.json.hooks.find((h) => h && h.agent === ctx.agent && h.event === event) : null;
      const moduleNeedle = rawEntry && extractHookScriptNeedle(rawEntry.command, vars.INSTALLED);
      if (!moduleNeedle) continue;
      needle = moduleNeedle;
    }

    removals.set(`${event}::${needle}`, { event, needle, module: s.module || null });
  }

  for (const { event, needle, module } of removals.values()) {
    actions.push({
      kind: "settings",
      agent: ctx.agent,
      target: ctx.settingsFile,
      pointer: `/hooks/${event}`,
      mode: "enforce",
      state: "obsolete",
      action: "remove",
      reason: module
        ? `uninstalling — removing hooks.${event}[${module}]`
        : `uninstalling — removing the dispatcher registration for ${event}`,
      event,
      needle,
      module,
    });
  }

  for (const b of (ctx.manifest && ctx.manifest.blocks) || []) {
    const target = path.join(ctx.home, b.file);
    const current = readText(target);
    if (current === null) continue;
    const result = mb.removeBlock(current);
    actions.push({
      kind: "block",
      agent: ctx.agent,
      target,
      state: "obsolete",
      action: result.changed ? "write" : "none",
      reason: "uninstalling — removing the managed block",
      content: result.content,
    });
  }

  return actions;
}

module.exports = { buildPlan, buildUninstallPlan, baseVars, quoted, HOOK_TIMEOUT_SECONDS, extractHookScriptNeedle };
