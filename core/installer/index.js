"use strict";

/**
 * The `softela-ai` CLI: parses arguments and dispatches to one command,
 * printing the plan-then-result output INSTALLER.md §2 documents.
 *
 * Every command follows the same shape: gather (`detect.js`, read-only),
 * plan (`plan.js`, pure), apply (`apply.js`, the only place that writes) —
 * so `--dry-run` is simply "gather and plan, then stop."
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");
const paths = require("../lib/paths");
const { removeIfExists, writeTextAtomic, readJson } = require("../lib/fs-safe");
const detect = require("./detect");
const plan = require("./plan");
const apply = require("./apply");
const manifestStore = require("./manifest");
const stateStore = require("./state");
const doctor = require("./doctor");
const link = require("./link");
const approvals = require("../lib/approvals");
const override = require("./override");
const conflictsLib = require("./conflicts");
const prompt = require("./prompt");
const tty = require("./tty");

/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set([
  "dry-run",
  "yes",
  "json",
  "verbose",
  "apply",
  "all-projects",
  "include-current",
  "list",
  "undo",
  "help",
  "version",
]);

/**
 * The values that turn a boolean flag off when it is written in the
 * `--flag=value` form. Anything else after the `=` leaves the flag on.
 */
const FALSE_WORDS = new Set(["false", "0", "no", "off"]);

/**
 * Parses CLI arguments into a command, its positional arguments, and its
 * flags.
 *
 * @param {string[]} argv The arguments after the program name, e.g.
 * `process.argv.slice(2)`.
 * @returns {{command: string | undefined, positional: string[], flags: object}}
 * `flags` values are `true` for a boolean flag, or the flag's value for
 * anything else. A value may be written either as the following token
 * (`--agent codex`) or inline (`--agent=codex`); see {@link FALSE_WORDS}
 * for the inline form applied to a boolean flag.
 */
function parseArgs(argv) {
  let command;
  const positional = [];
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const key = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);
      if (BOOLEAN_FLAGS.has(key)) {
        // "--dry-run=false" has to mean false: reading it as "flag present,
        // therefore true" would apply an installation the developer asked to
        // only preview.
        flags[key] = inlineValue === undefined ? true : !FALSE_WORDS.has(inlineValue.toLowerCase());
      } else if (inlineValue !== undefined) {
        flags[key] = inlineValue;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
      continue;
    }
    if (command === undefined) command = token;
    else positional.push(token);
  }

  return { command, positional, flags };
}

/**
 * Every flag any command accepts, keyed by its `--name`. `type: "boolean"`
 * flags take no value (see {@link BOOLEAN_FLAGS}); `type: "value"` flags
 * consume the following token. `choices`, when present, is the flag's full
 * set of valid string values — checked by {@link validateFlags} so a typoed
 * value (`--agent windozs`) is refused instead of silently falling back to
 * auto-detection.
 *
 * This is the single source both {@link printCommandHelp} and
 * {@link validateFlags} read from, so a command's documented flags and its
 * actually-accepted flags can never drift apart from each other — only
 * {@link COMMANDS}`.flags` decides which of these apply to which command.
 */
const FLAG_DEFS = {
  agent: {
    type: "value",
    placeholder: "<claude|codex|all>",
    choices: ["claude", "codex", "all"],
    desc: 'Target one agent home explicitly, or both with "all".',
    default: "auto-detect — every one of ~/.claude and ~/.codex that already exists on this machine",
  },
  json: {
    type: "boolean",
    desc: "Print the result as machine-readable JSON instead of formatted text.",
    default: "off",
  },
  yes: {
    type: "boolean",
    desc: 'Skip the confirmation prompt. Only "uninstall" and "override" (setting or undoing) actually prompt; accepted by every writing command for scripting consistency, with no effect where nothing would have prompted.',
    default: "off — prompts when interactive and something would be destroyed or changed in enforcement",
  },
  "dry-run": {
    type: "boolean",
    desc: "Compute and print the plan; write nothing.",
    default: "off",
  },
  verbose: {
    type: "boolean",
    desc: "Print every file and setting individually, including ones that need no change — the default output instead bulks ordinary added or changed files into one count line.",
    default: "off — added/changed files print as a single count line; a locally-edited file, a removal, every settings change and the instructions block still print their own line either way",
  },
  modules: {
    type: "value",
    placeholder: "<id,id,...>",
    desc: 'Comma-separated module ids to enable, replacing the current selection. Run "softela-ai module list" for the ids this repository ships.',
    default: 'on a first install: every module whose module.json sets "defaultEnabled": true; on update, or a later install: whatever is already enabled',
  },
  "memory-location": {
    type: "value",
    placeholder: "<global|infrastructure|repo>",
    choices: ["repo", "infrastructure", "global"],
    desc: 'Shortcut for the memory-as-context module\'s "location" option.',
    default: "global — the agent's own memory directory, shared with whatever you already keep there",
  },
  "reply-language": {
    type: "value",
    placeholder: "<lang,lang,...>",
    desc: 'Shortcut for the reply-language module\'s "languages" option — an ordered, comma-separated preference list.',
    default: "English",
  },
  minutes: {
    type: "value",
    placeholder: "<N>",
    desc: "How many minutes the approval stays live.",
    default: "60",
  },
  list: {
    type: "boolean",
    desc: "List, instead of writing.",
    default: "off",
  },
  repo: {
    type: "value",
    placeholder: "<path>",
    desc: "The product repository to write AGENTS.md / CLAUDE.md into.",
    default: "the current working directory",
  },
  apply: {
    type: "boolean",
    desc: "Actually delete. Without it, only report what would be removed and how much space it would free.",
    default: "off — dry-run report only",
  },
  "include-current": {
    type: "boolean",
    desc: "Also drop the live session's own transcript, as far as the host lets go of it.",
    default: "off",
  },
  "all-projects": {
    type: "boolean",
    desc: "Sweep every project's session store, not only the current directory's.",
    default: "off — current directory only",
  },
  project: {
    type: "value",
    placeholder: "<name>",
    desc: "Target one specific project instead of the current one.",
    default: "the current directory",
  },
  current: {
    type: "value",
    placeholder: "<id>",
    desc: "Session id of the live session, to spare it explicitly.",
    default: "not spared explicitly — best-effort auto-detection only",
  },
  keep: {
    type: "value",
    placeholder: "<id[,id]>",
    desc: "Extra session id(s) to spare, comma-separated.",
    default: "none",
  },
  reason: {
    type: "value",
    placeholder: '<"why">',
    desc: "Why this override exists. Required when setting one; shown back by \"doctor\" and \"override --list\".",
    default: "(required when setting an override)",
  },
  undo: {
    type: "boolean",
    desc: "Restore the most recently backed-up overrides.json instead of setting a new override.",
    default: "off",
  },
  "on-conflict": {
    type: "value",
    placeholder: "<replace|reconcile|abort>",
    choices: ["replace", "reconcile", "abort"],
    desc:
      'How to resolve a pre-existing local hook registration this run finds that softela-ai did not put there. ' +
      '"replace" (recommended) backs up the settings file and disables the conflicting registration so softela-ai\'s own takes effect, without deleting the developer\'s own script file. ' +
      '"reconcile" reports what softela-ai would install, what is already there, and the question to answer for each conflict, then stops without merging anything on its own. ' +
      '"abort" reports the conflicts and stops, changing nothing. Has no effect when nothing conflicts.',
    default:
      'none — an interactive terminal is asked, recommending "replace"; a non-interactive run with an unresolved conflict refuses to guess and stops',
  },
};

/**
 * Every command this CLI dispatches, keyed by its name — the ordering here
 * is the ordering {@link printOverview} lists them in.
 *
 * `flags` names the subset of {@link FLAG_DEFS} this command accepts;
 * {@link validateFlags} refuses anything else, which is what makes an
 * unrecognised or misapplied flag (INSTALLER's `--no-prompt` finding) an
 * error instead of a silent no-op. `flagOverrides`, when present, replaces
 * one flag's `desc`/`default` with a command-specific reading of the same
 * flag (e.g. `--project` names a session store for `clean-sessions` but an
 * override's scope for `override`) without duplicating its `type`.
 *
 * @type {Record<string, {
 *   summary: string,
 *   usage: string,
 *   flags: string[],
 *   flagOverrides?: Record<string, {desc?: string, default?: string}>,
 *   notes?: string[],
 *   example: string
 * }>}
 */
const COMMANDS = {
  install: {
    summary: "Copy this repo's rules into an agent home.",
    usage: "softela-ai install [options]",
    flags: ["agent", "dry-run", "modules", "memory-location", "reply-language", "verbose", "yes", "on-conflict", "json"],
    flagOverrides: {
      yes: {
        desc: 'Skip every module-option prompt this run would otherwise ask on an interactive terminal — install has no separate confirmation prompt to skip. A stored or flag-supplied value, or a non-interactive stdin, already skips a given prompt without this.',
        default: 'off — a prompt only appears on an interactive terminal, for an option not already supplied by a flag or a prior run',
      },
    },
    notes: [
      "What gets copied: hooks that can refuse a tool call, prompt text and settings.",
      "Run with --dry-run first to see every file, hook registration and setting this would touch, without changing anything.",
      "A real run backs up each file it is about to change into <agent home>/.softela-ai/backups/<timestamp>/ and prints the directory it used.",
    ],
    example: "softela-ai install --dry-run\nsoftela-ai install",
  },
  update: {
    summary: "Reconcile an install with what ships now.",
    usage: "softela-ai update [options]",
    flags: ["agent", "dry-run", "modules", "memory-location", "reply-language", "verbose", "yes", "on-conflict", "json"],
    example: "softela-ai update",
  },
  doctor: {
    summary: "Report install status, drift and modules.",
    usage: "softela-ai doctor [options]",
    flags: ["agent", "json"],
    notes: ["Also reports every active override and approval."],
    example: "softela-ai doctor --agent claude",
  },
  test: {
    summary: "Run this repo's own self-test suite.",
    usage: "softela-ai test",
    flags: ["json"],
    notes: ['Same as running "npm test".'],
    example: "softela-ai test",
  },
  uninstall: {
    summary: "Remove everything this tool installed.",
    usage: "softela-ai uninstall [options]",
    flags: ["agent", "dry-run", "yes", "verbose", "json"],
    notes: ["Removes every manifest-tracked file, this installer's hook registrations and its instructions block."],
    example: "softela-ai uninstall --yes",
  },
  approve: {
    summary: "Grant a time-boxed exception for one rule.",
    usage: "softela-ai approve <ruleId> [options] | softela-ai approve --list",
    flags: ["minutes", "list", "agent", "json"],
    notes: ["Pass --list to see every exception currently live instead of granting a new one."],
    example: "softela-ai approve forbidden-commands --minutes 30",
  },
  module: {
    summary: "List, enable or disable opt-in modules.",
    usage: "softela-ai module <list|enable|disable> [id] [options]",
    flags: ["agent", "dry-run", "verbose", "yes", "json", "memory-location", "reply-language"],
    notes: [
      '"module list" prefixes each id with "*" when that module is enabled by default on a first install — not necessarily what is enabled for an agent right now; the per-agent line below the list is what is actually enabled.',
    ],
    example: "softela-ai module list\nsoftela-ai module enable session-cleanup",
  },
  link: {
    summary: "Write the AGENTS.md / CLAUDE.md pointer.",
    usage: "softela-ai link [options]",
    flags: ["repo", "dry-run", "json"],
    notes: ["Writes into the target product repository named by --repo, not this one."],
    example: "softela-ai link --repo ../Softela.Bugworx",
  },
  override: {
    summary: "Set, list or undo a rule's override.",
    usage: 'softela-ai override <ruleId> <off|ask|deny> --reason "<why>" [options] | softela-ai override --list | softela-ai override --undo',
    flags: ["reason", "project", "agent", "list", "undo", "dry-run", "yes", "json"],
    flagOverrides: {
      project: { desc: "Scope the override to one project id instead of every repository (global)." },
      list: { desc: "List currently active overrides instead of setting one." },
    },
    example: 'softela-ai override colocated-tests off --reason "flaky"',
  },
};

/**
 * Resolves one command's own reading of a flag, folding in
 * {@link COMMANDS}`[command].flagOverrides` over the shared
 * {@link FLAG_DEFS} entry.
 *
 * @param {string} command A key of {@link COMMANDS}.
 * @param {string} flagName A key of {@link FLAG_DEFS}.
 * @returns {object} The effective flag spec for this command.
 */
function flagSpecFor(command, flagName) {
  const base = FLAG_DEFS[flagName];
  const override = COMMANDS[command].flagOverrides && COMMANDS[command].flagOverrides[flagName];
  return override ? { ...base, ...override } : base;
}

/**
 * Renders a flag's left-hand column for the help text, e.g. `--agent
 * <claude|codex|all>` or `--dry-run`.
 *
 * @param {string} flagName The flag's name, without the leading `--`.
 * @param {object} spec Its spec, as returned by {@link flagSpecFor}.
 * @returns {string} The rendered head.
 */
function flagHead(flagName, spec) {
  return spec.type === "boolean" ? `--${flagName}` : `--${flagName} ${spec.placeholder}`;
}

/**
 * Computes the Levenshtein edit distance between two strings, for
 * "did you mean" suggestions on an unrecognised command or flag.
 *
 * @param {string} a The first string.
 * @param {string} b The second string.
 * @returns {number} The minimum number of single-character insertions,
 * deletions or substitutions turning `a` into `b`.
 */
function levenshteinDistance(a, b) {
  const rows = [];
  for (let i = 0; i <= a.length; i++) {
    rows.push(new Array(b.length + 1).fill(0));
    rows[i][0] = i;
  }
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] =
        a[i - 1] === b[j - 1] ? rows[i - 1][j - 1] : 1 + Math.min(rows[i - 1][j], rows[i][j - 1], rows[i - 1][j - 1]);
    }
  }
  return rows[a.length][b.length];
}

/**
 * Picks the closest candidate to a mistyped name, for an error message.
 *
 * @param {string} input The name actually typed.
 * @param {string[]} candidates The valid names it might have meant.
 * @returns {string | null} The nearest candidate by edit distance, or
 * `null` when `candidates` is empty.
 */
function closestMatch(input, candidates) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = levenshteinDistance(input, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/**
 * Validates a parsed command's flags against {@link COMMANDS}.
 *
 * @param {string} command A key of {@link COMMANDS}, already known valid.
 * @param {object} flags Parsed CLI flags, as returned by {@link parseArgs}.
 * @returns {{ok: true} | {ok: false, kind: "unknown", flag: string} |
 * {ok: false, kind: "invalid-value", flag: string, value: string, choices: string[]}}
 * `"unknown"` when a flag this command does not accept was passed;
 * `"invalid-value"` when a flag with a fixed `choices` list got something
 * else. `help` is always allowed here — {@link main} intercepts it before
 * this runs, but a defensive re-check costs nothing.
 */
function validateFlags(command, flags) {
  const allowed = new Set(COMMANDS[command].flags);
  for (const key of Object.keys(flags)) {
    if (key === "help") continue;
    if (!allowed.has(key)) return { ok: false, kind: "unknown", flag: key };
    const spec = flagSpecFor(command, key);
    if (spec && spec.choices && typeof flags[key] === "string" && !spec.choices.includes(flags[key])) {
      return { ok: false, kind: "invalid-value", flag: key, value: flags[key], choices: spec.choices };
    }
  }
  return { ok: true };
}

/**
 * Resolves the column width every printed surface below wraps and aligns to.
 *
 * @returns {number} `process.env.SOFTELA_AI_COLUMNS`, when it parses to a
 * positive number, clamped into {@link tty.MIN_WIDTH}/{@link tty.MAX_WIDTH} —
 * the test seam `tests/installer/_home.js#runCli`'s own `env` option drives,
 * since a piped subprocess's `stdout.columns` is never set no matter how wide
 * the real terminal running the test is (the same discipline
 * `isInteractiveStdin`'s own `SOFTELA_AI_FORCE_TTY` seam already uses). Otherwise
 * `tty.terminalWidth(process.stdout)`.
 */
function outputWidth() {
  const forced = Number(process.env.SOFTELA_AI_COLUMNS);
  if (Number.isFinite(forced) && forced > 0) {
    return Math.min(tty.MAX_WIDTH, Math.max(tty.MIN_WIDTH, Math.floor(forced)));
  }
  return tty.terminalWidth(process.stdout);
}

/**
 * Word-wraps a block of text to a fixed width, placing `prefix` before the
 * first line only and an equal-width blank indent before every line after
 * it, so a continuation line stays aligned under the first line's own text
 * rather than under the prefix.
 *
 * @param {string} prefix Text placed before the wrapped body on its first
 * line only, e.g. `"usage: "` or a padded left-hand column.
 * @param {string} text The body text to wrap.
 * @param {number} width The total column budget to fit within, prefix
 * included.
 * @param {{hardBreak?: boolean}} [options] Forwarded to {@link tty.wrap} —
 * `hardBreak: true` carries a single word too wide for one line across
 * further lines instead of cutting it with an ellipsis, for callers that
 * must never discard part of `text`.
 * @returns {string[]} One rendered line per wrapped segment, with no
 * trailing whitespace (a left-hand column padded via `tty.padTo` into
 * `prefix`, paired with an empty `text`, would otherwise leave one).
 */
function wrapWithPrefix(prefix, text, width, options) {
  const indent = " ".repeat(tty.displayWidth(prefix));
  // Floored at 10 so `tty.wrap` never receives a zero/negative budget — but
  // an unusually wide prefix (a long left-hand column at a narrow terminal)
  // can still leave `indent.length` alone close to or past `width`, so the
  // final `truncate` below is the actual guarantee, not this floor.
  const bodyWidth = Math.max(10, width - indent.length);
  const wrapped = tty.wrap(text, bodyWidth, options);
  return wrapped.map((line, i) => tty.truncate(i === 0 ? `${prefix}${line}` : `${indent}${line}`, width).trimEnd());
}

/**
 * The narrowest body a two-column {@link renderAlignedRow} will still wrap a
 * description into next to its label. A wide label (a long flag head) can
 * leave less than this once `width` is narrow, which would force ordinary
 * words into a mid-word `truncate` break inside {@link tty.wrap} — stacking
 * the description under the label instead keeps every word whole.
 *
 * Set above the widest single "word" any description actually places in
 * front of `tty.wrap` — this repository's own longest is the 29-column
 * `<global|infrastructure|repo>` placeholder; an override's rendered
 * `(set <ISO timestamp>)` tag is close behind it.
 */
const MIN_ALIGNED_BODY = 32;

/**
 * Renders one label/description pair as an aligned two-column row, wrapping
 * the description across as many continuation lines as it needs so no line
 * exceeds `width` — the shape {@link printCommandHelp} uses for every flag's
 * head/description and its own `default:` line.
 *
 * Below {@link MIN_ALIGNED_BODY}, the label's own column would leave too
 * little room to wrap into, so the label (when non-empty) is printed alone
 * and the description is stacked beneath it at a fixed, narrow hanging
 * indent instead of aligned under the label column.
 *
 * @param {string} label The left column's text, e.g. a flag's own head.
 * `""` renders only the description, hung at the same indent — the shape a
 * `default:` continuation row uses.
 * @param {number} labelWidth The left column's fixed width, already the
 * widest label this render call will place there.
 * @param {string} description The right column's text.
 * @param {number} width The total terminal width to fit within.
 * @returns {string[]} One or more rendered lines, indented two spaces.
 */
function renderAlignedRow(label, labelWidth, description, width) {
  const columnWidth = 2 + labelWidth + 2;
  if (width - columnWidth < MIN_ALIGNED_BODY) {
    const labelLine = label ? [tty.truncate(`  ${label}`, width).trimEnd()] : [];
    return [...labelLine, ...wrapWithPrefix("    ", description, width)];
  }
  return wrapWithPrefix(`  ${tty.padTo(label, labelWidth)}  `, description, width);
}

/**
 * Wraps one message to `width` and writes it to stderr as one or more
 * newline-terminated lines — the shape every `printUnknown*`/`printInvalid*`
 * refusal below uses for both its headline and its trailing "Run ... for
 * ..." pointer.
 *
 * @param {string} text The message to wrap and write.
 * @param {number} width The terminal width to fit within.
 * @returns {void}
 */
function writeWrappedErr(text, width) {
  process.stderr.write(`${wrapWithPrefix("", text, width).join("\n")}\n`);
}

/**
 * The three commands, in order, a first-time developer actually needs:
 * preview, install, then verify — each paired with its own label. Names no
 * command or flag {@link COMMANDS}/{@link FLAG_DEFS} does not already
 * define: `install --dry-run` and `install` are `COMMANDS.install`'s own
 * `example`; `doctor` reuses the exact phrasing `printClosingSummary`'s own
 * next-steps section already uses, so the two hints read as one voice.
 */
const GETTING_STARTED_STEPS = [
  ["1. Preview what would change:", "softela-ai install --dry-run"],
  ["2. Install:", "softela-ai install"],
  ["3. Check what landed:", "softela-ai doctor"],
];

/** The left column width {@link GETTING_STARTED_STEPS} aligns its labels to. */
const GETTING_STARTED_LABEL_WIDTH = Math.max(...GETTING_STARTED_STEPS.map(([label]) => label.length));

/**
 * Prints the top-level overview: what the tool does, every command with a
 * one-line summary, a "Getting started" pointer to the commands that matter
 * first, and how to get further help. Shown for no arguments, `-h`,
 * `--help`, and bare `help`.
 *
 * @returns {void}
 */
function printOverview() {
  const width = outputWidth();
  const nameWidth = Math.max(...Object.keys(COMMANDS).map((c) => c.length));
  const lines = [
    ...wrapWithPrefix(
      "",
      "softela-ai installs this repository's agent rules — hooks that can refuse a tool call, prompt text and settings — into an AI coding agent's home directory (~/.claude and/or ~/.codex), and keeps that installation in sync as the repository changes.",
      width,
    ),
    "",
    "usage: softela-ai <command> [options]",
    "",
    // A first-time developer has no reason to already know which of the ten
    // commands below to run first — name the three that matter, in order,
    // before the full list; "Check what landed" reuses the exact phrasing
    // printClosingSummary's own next-steps section already uses, so the two
    // hints read as one voice instead of two.
    "Getting started",
    ...GETTING_STARTED_STEPS.flatMap(([label, cmd]) => renderAlignedRow(label, GETTING_STARTED_LABEL_WIDTH, cmd, width)),
    "",
    "Commands:",
    // `fitRow`'s trailing "grow" cell pads a short summary out to the full
    // remaining column width — trimEnd() drops that padding rather than
    // leaving every shorter-than-longest summary line end in whitespace.
    ...Object.entries(COMMANDS).map(
      ([name, def]) =>
        `  ${tty.fitRow([{ text: name, width: nameWidth }, { text: def.summary, grow: true }], Math.max(10, width - 2))}`.trimEnd(),
    ),
    "",
    ...wrapWithPrefix("", 'Run "softela-ai <command> --help" or "softela-ai help <command>" for that command\'s own flags and a worked example.', width),
    ...wrapWithPrefix("", 'Run "softela-ai --version" for the installed version.', width),
  ];
  console.log(lines.join("\n"));
}

/**
 * Prints one command's own usage line, summary, any free-text notes,
 * flags (each with its default) and a worked example.
 *
 * @param {string} command A key of {@link COMMANDS}.
 * @returns {void}
 */
function printCommandHelp(command) {
  const def = COMMANDS[command];
  const width = outputWidth();
  const lines = [...wrapWithPrefix("usage: ", def.usage, width), "", ...wrapWithPrefix("", def.summary, width), ""];

  if (def.notes && def.notes.length) {
    for (const note of def.notes) lines.push(...wrapWithPrefix("", note, width));
    lines.push("");
  }

  if (def.flags.length) {
    lines.push("Options:");
    const rows = def.flags.map((name) => ({ name, spec: flagSpecFor(command, name) }));
    const labelWidth = Math.max(...rows.map((r) => flagHead(r.name, r.spec).length));
    for (const { name, spec } of rows) {
      lines.push(...renderAlignedRow(flagHead(name, spec), labelWidth, spec.desc, width));
      lines.push(...renderAlignedRow("", labelWidth, `default: ${spec.default}`, width));
    }
    lines.push("");
  }

  // The example itself is a literal, copy-pasteable command — never wrapped,
  // the same "never mangle something meant to be typed verbatim" rule
  // {@link printClosingSummary} applies to its own "run via:" line.
  lines.push("Example:");
  for (const line of def.example.split("\n")) lines.push(`  ${line}`);
  console.log(lines.join("\n"));
}

/**
 * Prints an unrecognised command name to stderr, with the closest known
 * command as a suggestion when one is available.
 *
 * @param {string | undefined} command The token that was typed.
 * @returns {void}
 */
function printUnknownCommand(command) {
  const width = outputWidth();
  const name = command === undefined ? "" : String(command);
  const suggestion = closestMatch(name, Object.keys(COMMANDS));
  writeWrappedErr(`softela-ai: unknown command "${name}"${suggestion ? ` — did you mean "${suggestion}"?` : ""}`, width);
  writeWrappedErr('Run "softela-ai --help" for the list of commands.', width);
}

/**
 * The commands that take a positional argument of their own. Every other
 * command receiving one is refused rather than ignored, because the most
 * likely way to produce one is `npm run doctor --agent codex`: npm drops the
 * `--agent` token on its own side and forwards a bare `codex`, which would
 * otherwise be discarded and the auto-detected agent reported on in silence.
 */
const POSITIONAL_COMMANDS = new Set(["approve", "module", "override"]);

/**
 * Prints a positional argument given to a command that takes none, naming
 * the two invocations that do carry a flag through intact.
 *
 * @param {string} command A key of {@link COMMANDS}.
 * @param {string} value The unexpected argument.
 * @returns {void}
 */
function printUnexpectedArgument(command, value) {
  const width = outputWidth();
  writeWrappedErr(`softela-ai: "${command}" takes no argument, but got "${value}".`, width);
  writeWrappedErr(
    `A flag written as "npm run <script> --flag ${value}" loses the flag on npm's side. Write "npx softela-ai ${command} --flag ${value}" or "npm run softela-ai -- ${command} --flag ${value}" instead.`,
    width,
  );
  writeWrappedErr(`Run "softela-ai ${command} --help" for its accepted flags.`, width);
}

/**
 * Prints an unrecognised or misapplied flag to stderr, with the closest
 * flag this command actually accepts as a suggestion when one is available.
 *
 * @param {string} command A key of {@link COMMANDS}.
 * @param {string} flagName The flag that was rejected, without its `--`.
 * @returns {void}
 */
function printUnknownFlag(command, flagName) {
  const width = outputWidth();
  const suggestion = closestMatch(flagName, COMMANDS[command].flags);
  writeWrappedErr(`softela-ai: unknown flag "--${flagName}" for "${command}"${suggestion ? ` — did you mean "--${suggestion}"?` : ""}`, width);
  writeWrappedErr(`Run "softela-ai ${command} --help" for its accepted flags.`, width);
}

/**
 * Prints a flag whose value is not among its fixed `choices` to stderr.
 *
 * @param {string} command A key of {@link COMMANDS}.
 * @param {string} flagName The flag whose value was rejected.
 * @param {string} value The value that was typed.
 * @param {string[]} choices The values this flag actually accepts.
 * @returns {void}
 */
function printInvalidValue(command, flagName, value, choices) {
  const width = outputWidth();
  writeWrappedErr(`softela-ai: invalid value "${value}" for "--${flagName}" — expected one of: ${choices.join(", ")}.`, width);
  writeWrappedErr(`Run "softela-ai ${command} --help" for details.`, width);
}

/**
 * Picks the display symbol for one plan line, matching INSTALLER.md §2.
 *
 * @param {object} a A plan action.
 * @returns {"+" | "~" | "=" | "!" | "-"} `+` created, `~` changed in place,
 * `=` unchanged, `!` kept yours and wrote `.new`, `-` removed.
 */
function symbolFor(a) {
  if (a.action === "remove") return "-";
  if (a.action === "write-new") return "!";
  if (a.action === "write") return a.state === "new" || a.state === "absent" ? "+" : "~";
  return "=";
}

/**
 * Renders a settings pointer as a short dotted label.
 *
 * @param {object} a A `kind: "settings"` plan action.
 * @returns {string} `hooks.<event>[softela-ai]` for a dispatcher registration;
 * the pointer with its leading slash stripped and `/` replaced by `.`
 * otherwise.
 */
function settingsLabel(a) {
  if (a.event) return `hooks.${a.event}[${a.module || "softela-ai"}]`;
  return String(a.pointer || "").replace(/^\//, "").replace(/\//g, ".");
}

/**
 * Hard ceiling on a padded column's width, so one abnormally long label,
 * pointer or path cannot blow out every other row's alignment the way a
 * fixed 28/32/38 guess used to when a real value ran past it. Comfortably
 * above every label this repository actually ships today; a value that
 * still exceeds it wraps onto further lines instead (see {@link
 * wrapColumn}) — it is never cut, only ever split across more lines.
 */
const MAX_COLUMN_WIDTH = 60;

/**
 * Fixed hanging indent a plan line's trailing suffix — a settings entry's
 * `(mode, reason)`, or a kept/removed file's own `reason` — is given when it
 * cannot share the row's own last line with the fixed columns before it (see
 * {@link appendSuffix}).
 *
 * Deliberately a small, fixed indent rather than one aligned under the
 * columns themselves: those columns can be wide (a long settings label, or a
 * deep relative path), and aligning under them would leave the suffix with
 * barely more room than it already had on the row — defeating the point of
 * giving it a line of its own.
 */
const SUFFIX_INDENT = "    ";

/**
 * Splits a column's value into one or more exact-width lines, so a value
 * wider than its column continues onto further lines instead of being cut
 * with an ellipsis — INSTALLER.md §2's "columns actually align" holds
 * because the column itself never grows past `width`, not because a value
 * too wide for it gets thrown away. A value that already fits is simply
 * padded, the same single line {@link tty.padTo} would produce.
 *
 * @param {string} value The column's raw value.
 * @param {number} width The column's fixed width.
 * @returns {string[]} One or more lines, each exactly `width` display
 * columns; more than one only when `value` itself is wider than `width`.
 */
function wrapColumn(value, width) {
  if (width <= 0) return [""];
  const str = String(value);
  if (tty.displayWidth(str) <= width) return [tty.padTo(str, width)];

  const chars = Array.from(str);
  const lines = [];
  for (let i = 0; i < chars.length; i += width) {
    lines.push(tty.padTo(chars.slice(i, i + width).join(""), width));
  }
  return lines;
}

/**
 * Appends a plan line's trailing suffix to the last of its already-rendered
 * column lines: inline, on that same line, when there is room left after the
 * columns — or, rather than starting the suffix there and splitting it
 * mid-phrase across the row and its continuation, onto fresh line(s) of its
 * own at {@link SUFFIX_INDENT}, so it gets the room the (possibly wide)
 * columns before it would otherwise have squeezed it into.
 *
 * @param {string[]} rows The line's fixed-column rows, already built by
 * {@link wrapColumn}; never empty.
 * @param {string} suffix The trailing text to attach — a settings entry's
 * own `(mode, reason)`, or a kept/removed file's own `reason`.
 * @param {number} width The terminal width every returned line must fit.
 * @returns {string[]} `rows`, each trimmed of trailing whitespace, with
 * `suffix` appended to the last one when it fits there, or wrapped onto new
 * lines after it (with {@link tty.wrap}'s `hardBreak` so nothing in it is
 * ever dropped) when it does not.
 */
function appendSuffix(rows, suffix, width) {
  const head = rows.slice(0, -1).map((line) => line.trimEnd());
  const last = rows[rows.length - 1];
  const spaceLeft = Math.max(0, width - tty.displayWidth(last));

  if (tty.displayWidth(suffix) <= spaceLeft) {
    return [...head, tty.truncate(`${last}${suffix}`, width).trimEnd()];
  }

  return [...head, last.trimEnd(), ...wrapWithPrefix(SUFFIX_INDENT, suffix, width, { hardBreak: true })];
}

/**
 * Fixed characters {@link renderLine} always prints around the settings
 * columns (the indent, symbol and the three single-space separators) — the
 * budget {@link computeColumnWidths} has left, after this, to split between
 * `settingsLabel` and `settingsDetail` so the two together still fit the
 * terminal.
 */
const SETTINGS_LINE_OVERHEAD = 9;

/** As {@link SETTINGS_LINE_OVERHEAD}, for the `fileRel` column's own line shape. */
const FILE_LINE_OVERHEAD = 7;

/**
 * Computes the column widths to align a set of plan lines to, from the
 * widest value {@link renderLine} will actually print across `items` this
 * run — rather than a fixed guess that a longer-than-usual label or pointer
 * could blow straight through — capped so the terminal's own width is never
 * exceeded even before {@link renderLine}'s own backstop truncate runs.
 *
 * @param {object[]} items The plan actions about to be rendered as lines.
 * @param {string} home The agent home, so a file path can be measured the
 * same way {@link renderLine} renders it.
 * @param {number} width The terminal width this run's lines must fit.
 * @returns {{settingsLabel: number, settingsDetail: number, fileRel: number}}
 * Each column's width, already capped at both {@link MAX_COLUMN_WIDTH} and
 * whatever `width` leaves room for.
 */
function computeColumnWidths(items, home, width) {
  let settingsLabelWidth = 0;
  let settingsDetailWidth = 0;
  let fileRelWidth = 0;
  for (const a of items) {
    if (a.kind === "settings") {
      settingsLabelWidth = Math.max(settingsLabelWidth, path.basename(a.target).length);
      settingsDetailWidth = Math.max(settingsDetailWidth, settingsLabel(a).length);
    } else {
      const symbol = symbolFor(a);
      if (symbol === "!" || symbol === "-") {
        const rel = a.relPath || path.relative(home, a.target).split(path.sep).join("/");
        fileRelWidth = Math.max(fileRelWidth, rel.length);
      }
    }
  }

  let labelWidth = Math.min(Math.max(settingsLabelWidth, 1), MAX_COLUMN_WIDTH);
  let detailWidth = Math.min(Math.max(settingsDetailWidth, 1), MAX_COLUMN_WIDTH);
  const settingsBudget = Math.max(8, width - SETTINGS_LINE_OVERHEAD);
  if (labelWidth + detailWidth > settingsBudget) {
    // The label is one settings file's own short basename — identical on
    // every row of a given run — while the detail column is the part that
    // actually varies in length. Shrink detail first and only take from the
    // label once detail alone cannot free up enough room, rather than
    // shrinking both proportionally and forcing the short, uniform label to
    // wrap too. `renderLine` wraps whichever column still overflows once
    // this budget is applied (see {@link wrapColumn}) rather than cutting it.
    labelWidth = Math.min(labelWidth, Math.max(4, settingsBudget - 4));
    detailWidth = Math.max(4, settingsBudget - labelWidth);
  }

  const fileRel = Math.min(Math.max(fileRelWidth, 1), MAX_COLUMN_WIDTH, Math.max(8, width - FILE_LINE_OVERHEAD));

  return { settingsLabel: labelWidth, settingsDetail: detailWidth, fileRel };
}

/**
 * Renders one plan action as one or more output lines — the fixed, aligned
 * columns (the settings label/detail pair, or a kept/removed file's own
 * relative path) first, with the trailing detail the developer actually
 * needs to READ — a settings entry's `(mode, reason)` suffix, or a kept/
 * removed file's own `reason` — attached after them.
 *
 * Neither the fixed columns nor the trailing suffix is ever cut with an
 * ellipsis: a column value wider than its own aligned width ({@link
 * wrapColumn}) continues on further lines, aligned under the column it
 * belongs to and blank-padded in every other column on those lines; a
 * suffix that will not fit on the row's own line moves to a fresh line of
 * its own instead of starting there and splitting mid-phrase ({@link
 * appendSuffix}) — see {@link computeColumnWidths}'s own doc comment for how
 * the column widths themselves are chosen.
 *
 * @param {object} a A plan action, as built by `plan.js`.
 * @param {string} home The agent home, so file paths print relative to it.
 * @param {{settingsLabel: number, settingsDetail: number, fileRel: number}} widths
 * Column widths for this run, as computed by {@link computeColumnWidths}.
 * @param {number} width The terminal width every rendered line must fit.
 * @returns {string[]} One or more rendered lines, none exceeding `width`
 * columns, none ending in trailing whitespace.
 */
function renderLine(a, home, widths, width) {
  const symbol = symbolFor(a);
  if (a.kind === "settings") {
    const labelLines = wrapColumn(path.basename(a.target), widths.settingsLabel);
    const detailLines = wrapColumn(settingsLabel(a), widths.settingsDetail);
    const blankLabel = " ".repeat(widths.settingsLabel);
    const blankDetail = " ".repeat(widths.settingsDetail);

    const rows = [];
    for (let i = 0; i < Math.max(labelLines.length, detailLines.length); i++) {
      rows.push(`  ${i === 0 ? symbol : " "}   ${labelLines[i] || blankLabel} ${detailLines[i] || blankDetail} `);
    }

    const suffix = a.action === "keep" || a.action === "none" ? `(${a.mode}, ${a.reason})` : `(${a.mode})`;
    return appendSuffix(rows, suffix, width);
  }

  const rel = a.relPath || path.relative(home, a.target).split(path.sep).join("/");
  if (symbol === "!" || symbol === "-") {
    const rows = wrapColumn(rel, widths.fileRel).map((line, i) => `  ${i === 0 ? symbol : " "}   ${line} `);
    return appendSuffix(rows, a.reason, width);
  }
  return wrapWithPrefix(`  ${symbol}   `, rel, width, { hardBreak: true });
}

/**
 * Renders every actionable, non-bulkable plan entry for the DEFAULT
 * (non-`--verbose`) output: an ordinary added or changed file — the bulk of
 * a first install's output — is rolled into {@link renderPlanSummary}'s own
 * count line instead of getting one line each, but everything a developer
 * actually needs to read individually still does: a file kept because it
 * was locally edited (`!`), a removal (`-`), and any other actionable entry
 * `renderLine` knows how to render (settings, the instructions block).
 *
 * @param {object[]} items The non-bulkable actionable entries, in plan order.
 * @param {string} home The agent home.
 * @param {number} width The terminal width every rendered line must fit.
 * @returns {string[]} The rendered lines — more than one per entry whenever
 * {@link renderLine} had to wrap its trailing detail.
 */
function renderIndividualLines(items, home, width) {
  const widths = computeColumnWidths(items, home, width);
  return items.flatMap((a) => renderLine(a, home, widths, width));
}

/**
 * Renders a plan's actionable entries for the DEFAULT (non-`--verbose`)
 * output — one count line per bulk category instead of one line per file,
 * so a first install's ~120 file lines collapse to a handful, while
 * anything a human actually needs to see individually still gets its own
 * line ({@link renderIndividualLines}).
 *
 * Only an ordinary added or changed file (`kind: "copy"`, symbol `+` or
 * `~`) is bulked; a kept locally-modified file, a removal, every settings
 * change and the instructions block are never bulked, matching what the
 * developer asked this output to still show one line each for.
 *
 * @param {object[]} shown The plan's actionable entries (already filtered
 * to exclude `config-error`, `conflictRemoval` and no-op entries).
 * @param {string} home The agent home.
 * @param {number} width The terminal width every rendered line must fit.
 * @returns {string[]} The rendered lines: the bulk count line(s) first,
 * then every individual line in plan order.
 */
function renderPlanSummary(shown, home, width) {
  const bulk = new Set(shown.filter((a) => a.kind === "copy" && (symbolFor(a) === "+" || symbolFor(a) === "~")));
  const individual = shown.filter((a) => !bulk.has(a));

  const lines = [];
  const added = shown.filter((a) => bulk.has(a) && symbolFor(a) === "+").length;
  const changed = shown.filter((a) => bulk.has(a) && symbolFor(a) === "~").length;
  if (added || changed) {
    const parts = [];
    if (added) parts.push(`${added} added`);
    if (changed) parts.push(`${changed} changed`);
    lines.push(`  files  ${parts.join(", ")}`);
  }
  return [...lines, ...renderIndividualLines(individual, home, width)];
}

/**
 * Renders a full plan as output lines.
 *
 * `--verbose` prints every entry individually, including unchanged (`=`,
 * skipped) ones, aligned by {@link computeColumnWidths} across the whole
 * set. The default (non-verbose) output instead bulks ordinary added or
 * changed files into a count line — see {@link renderPlanSummary}.
 *
 * A `kind: "config-error"` entry is always excluded here regardless of
 * `verbose` — {@link summarizeConfigErrors} prints it unconditionally
 * instead, the same way {@link summarizeAreaWarnings} handles a pruning
 * skip, and `renderLine`'s generic file branch has no sensible rendering for
 * an entry whose `target` is `null`. A `conflictRemoval: true` entry
 * (`conflicts.js#buildReplaceActions`) is excluded the same way — it is not
 * an ordinary `enforce`/`seed` registration of ours, so `renderLine`'s
 * `settings` branch has nothing sensible to print for it either; the
 * per-agent "conflict resolution disabled" summary reports it instead,
 * correctly labelled as the developer's own registration being removed.
 *
 * @param {object[]} actions The plan.
 * @param {string} home The agent home.
 * @param {boolean} verbose Whether to include unchanged (`=`, skipped)
 * entries, rendered individually instead of bulked.
 * @param {number} [width] The terminal width every rendered line must fit;
 * defaults to {@link outputWidth}, so an existing caller that only passed
 * three arguments keeps behaving exactly as before this parameter existed.
 * @returns {string[]} The rendered lines.
 */
function renderPlan(actions, home, verbose, width = outputWidth()) {
  const shown = actions.filter((a) => a.kind !== "config-error" && !a.conflictRemoval && (verbose || a.action !== "none"));
  if (verbose) return renderIndividualLines(shown, home, width);
  return renderPlanSummary(shown, home, width);
}

/**
 * Summarises every shipped area whose pruning `plan.js` skipped this run
 * because the running source could not currently produce it (Layer 2, the
 * cross-agent update invariant) — one line per area, not one per file, so a
 * hundred skipped files under a single missing directory still reads as a
 * single loud warning. Printed unconditionally, independent of `--verbose`
 * and of `--dry-run`, because "I cannot see it in my source" being silently
 * read as "it should not exist" is exactly the failure this guards against.
 *
 * @param {object[]} actions The plan, as built by `plan.js#buildPlan`.
 * @returns {string[]} One message per distinct unavailable area with at
 * least one file left un-pruned; empty when nothing was skipped.
 */
function summarizeAreaWarnings(actions) {
  const counts = new Map();
  for (const a of actions) {
    if (!a.areaUnavailable) continue;
    counts.set(a.area, (counts.get(a.area) || 0) + 1);
  }
  return [...counts.entries()].map(
    ([area, count]) => `"${area}" is missing or empty in the current source — pruning skipped, ${count} previously-installed file(s) left untouched`,
  );
}

/**
 * Summarises every `kind: "config-error"` action — a module.json seed
 * setting that declared both `value` and `tier`, neither, or a `tier` for an
 * agent that cannot resolve one (`plan.js#planModuleSettings`). Printed
 * unconditionally, independent of `--verbose` and of `--dry-run`, on the same
 * principle as {@link summarizeAreaWarnings}: a repository-authoring mistake
 * that would otherwise silently skip seeding a setting must never depend on a
 * flag to become visible.
 *
 * @param {object[]} actions The plan, as built by `plan.js#buildPlan`.
 * @returns {string[]} One message per config-error action; empty when none.
 */
function summarizeConfigErrors(actions) {
  return actions.filter((a) => a.kind === "config-error").map((a) => a.reason);
}

/**
 * Summarises every codex seed setting this run actually wrote whose tier
 * resolved through `codex-models.js`'s built-in fallback rather than the
 * installed binary — so a developer sees immediately when the shipped
 * default was used instead of a value read off their own machine, the whole
 * point of `codex-models.js#resolveModelForTier` reporting its source instead
 * of staying silent.
 *
 * @param {object[]} actions The plan.
 * @returns {string[]} One message per fallback resolution actually written
 * this run; empty when none.
 */
function summarizeTierFallbacks(actions) {
  return actions
    .filter((a) => a.kind === "settings" && a.action === "write" && a.resolution && a.resolution.source === "fallback")
    .map((a) => `codex tier "${a.tier}" resolved to the built-in default "${a.value}" — ${a.resolution.reason}`);
}

/**
 * Builds one printed line per module {@link resolveModuleSelection} turned
 * on automatically this run because it ships `defaultEnabled: true` and was
 * not already enabled or explicitly disabled. Printed unconditionally,
 * independent of `--verbose`: a module newly reaching enforcement (new
 * hooks, a new MCP server, new instructions) is a change nobody should have
 * to pass a flag to see.
 *
 * @param {string[]} newlyEnabledModules Ids {@link resolveModuleSelection}
 * newly enabled this run, as `runInstallOrUpdate`'s own result carries them.
 * @returns {string[]} One line per newly-enabled module; empty when none.
 */
function summarizeNewlyEnabledModules(newlyEnabledModules) {
  return newlyEnabledModules.map((id) => `module "${id}" enabled by default (new since this agent was last configured)`);
}

/**
 * Builds one printed line per `defaultEnabled` module {@link
 * resolveModuleSelection} left off this run because one of its declared
 * `requires` is disabled or was never enabled. Printed unconditionally, the
 * same as {@link summarizeNewlyEnabledModules}: silently skipping a module
 * the repository ships as on-by-default is exactly the outcome this reports
 * instead of hiding, without failing the run over it.
 *
 * @param {{id: string, missing: string[]}[]} requiresBlockedModules Every
 * blocked module, as `resolveModuleSelection` returns it.
 * @returns {string[]} One line per blocked module; empty when none.
 */
function summarizeRequiresBlockedModules(requiresBlockedModules) {
  return requiresBlockedModules.map(
    (b) =>
      `module "${b.id}" is enabled by default but was not turned on — it requires ${b.missing.map((id) => `"${id}"`).join(", ")}, which ${
        b.missing.length > 1 ? "are" : "is"
      } disabled or not enabled`,
  );
}

/**
 * Decides whether a plan has anything actionable in it at all.
 *
 * @param {object[]} actions The plan.
 * @returns {boolean} `true` when every action is a no-op (`action` is
 * `"none"` or an unchanged `"keep"`).
 */
function planIsEmpty(actions) {
  return actions.every((a) => a.action === "none" || a.action === "keep");
}

/**
 * Resolves which modules should be enabled for a run.
 *
 * @param {{id: string, dir: string, json: object}[]} allModules Every
 * module this repository ships.
 * @param {object} flags Parsed CLI flags; `flags.modules` is a
 * comma-separated id list. `flags.__moduleOp`, when present, is
 * `{action: "enable" | "disable", id: string}` — set only by
 * {@link cmdModule}, never parsed from `argv` — and takes priority over
 * `flags.modules`: it is resolved against `priorState` here, inside the same
 * locked critical section that reads it, rather than against a snapshot read
 * before the lock was taken (CONTRACTS §9's ownership invariant, and the
 * reason two concurrent `module enable`/`disable` runs must not each compute
 * their next set from the same stale read).
 * @param {{modules: string[]}} priorState The agent's current local state.
 * @param {"install" | "update"} mode The command being run.
 * @param {string[]} [chosenIds] The module selection {@link collectInteractiveAnswers}
 * asked the developer for and resolved (its own `requires` closure already
 * applied), when it asked; `undefined`/`null` otherwise. Ranked below
 * `flags.__moduleOp` and `flags.modules` — an interactive answer is only
 * ever collected when neither of those was given in the first place, so this
 * ordering is never actually contested — and above the shipped-default and
 * stored-state fallbacks, since an answer the developer was just asked for
 * must win over both.
 * @param {string[]} [disabledIds] Module ids the developer explicitly
 * disabled — the manifest's own `disabledModules`
 * (`manifest.js#readManifest`). Consulted only by the two fallbacks below
 * (a brand-new install, and an ordinary re-run with no explicit override);
 * every earlier branch is the developer's own explicit choice for this run
 * and already overrides whatever the disabled record says, the same way it
 * overrides the stored state.
 * @returns {{ids: string[], unknown: string[], newlyEnabled: string[],
 * blocked: {id: string, missing: string[]}[], implicitlyDisabled: string[]}}
 * `ids` is the resolved enabled set; `unknown` lists any requested id this
 * repository does not ship; `newlyEnabled` lists every `defaultEnabled`
 * module this call turned on that was not already in `priorState.modules` —
 * always empty except from the ordinary-re-run fallback, since every earlier
 * branch is the developer's own explicit choice, never an automatic one;
 * `blocked` lists every `defaultEnabled` module the same fallback left off
 * because one of its declared `requires` is neither already enabled nor
 * being newly enabled this same run — disabled, or never enabled — each
 * entry naming the missing dependency ids; `implicitlyDisabled` lists every
 * `defaultEnabled` module a `--modules` list or a confirmed interactive pick
 * left out — the developer choosing a set is the developer turning off
 * whatever it omits, on purpose, the same as `module disable` — so the
 * caller must fold these into the manifest's own `disabledModules`, or a
 * later re-run's fallback would silently sweep them back in.
 */
function resolveModuleSelection(allModules, flags, priorState, mode, chosenIds, disabledIds) {
  const known = new Set(allModules.map((m) => m.id));
  const empty = { newlyEnabled: [], blocked: [], implicitlyDisabled: [] };

  /**
   * Lists every `defaultEnabled` module an explicit selection left out — see
   * `implicitlyDisabled` in this function's own `@returns`.
   *
   * @param {string[]} ids The developer's own explicit selection.
   * @returns {string[]} The omitted `defaultEnabled` module ids.
   */
  const omittedDefaults = (ids) => {
    const chosen = new Set(ids);
    return allModules.filter((m) => m.json.defaultEnabled && !chosen.has(m.id)).map((m) => m.id);
  };

  if (flags.__moduleOp && typeof flags.__moduleOp.id === "string") {
    const current = new Set(priorState.modules.filter((id) => known.has(id)));
    if (flags.__moduleOp.action === "enable") current.add(flags.__moduleOp.id);
    else current.delete(flags.__moduleOp.id);
    return { ids: [...current], unknown: [], ...empty };
  }

  if (typeof flags.modules === "string") {
    const requested = flags.modules
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const ids = requested.filter((id) => known.has(id));
    return { ids, unknown: requested.filter((id) => !known.has(id)), newlyEnabled: [], blocked: [], implicitlyDisabled: omittedDefaults(ids) };
  }

  if (Array.isArray(chosenIds)) {
    const ids = chosenIds.filter((id) => known.has(id));
    return { ids, unknown: chosenIds.filter((id) => !known.has(id)), newlyEnabled: [], blocked: [], implicitlyDisabled: omittedDefaults(ids) };
  }

  const disabled = new Set(Array.isArray(disabledIds) ? disabledIds : []);

  if (mode === "install" && (!priorState.modules || priorState.modules.length === 0)) {
    return {
      ids: allModules.filter((m) => m.json.defaultEnabled && !disabled.has(m.id)).map((m) => m.id),
      unknown: [],
      ...empty,
    };
  }

  // An ordinary re-run — `update`, or `install` repeated on an
  // already-configured agent — keeps everything already enabled and turns
  // on every `defaultEnabled` module that either did not exist, or was
  // never enabled, when this agent's module set was last resolved, unless
  // the developer explicitly turned it off since. Without this, a module
  // added to the repository after an agent's first install stays invisible
  // to that agent forever: nothing here would otherwise distinguish "this
  // module did not exist yet" from "the developer turned it off", since
  // both look identical from `priorState.modules` alone — this is exactly
  // the defect `disabledIds` exists to let this function tell apart.
  const modulesById = new Map(allModules.map((m) => [m.id, m]));
  const sortedIds = allModules.map((m) => m.id).sort((a, b) => a.localeCompare(b));
  const enabled = new Set(priorState.modules.filter((id) => known.has(id)));
  const newlyEnabled = [];

  // Resolved to a fixed point, alphabetically, so a default module that
  // itself requires another default module turned on in this very same pass
  // is not skipped only because of scan order, and so the result is
  // deterministic regardless of how the repository's own directory listing
  // happens to be ordered on disk.
  for (let progressed = true; progressed; ) {
    progressed = false;
    for (const id of sortedIds) {
      if (enabled.has(id) || disabled.has(id)) continue;
      const mod = modulesById.get(id);
      if (!mod.json.defaultEnabled) continue;
      const requires = Array.isArray(mod.json.requires) ? mod.json.requires : [];
      if (requires.some((reqId) => !enabled.has(reqId))) continue;
      enabled.add(id);
      newlyEnabled.push(id);
      progressed = true;
    }
  }

  const blocked = [];
  for (const id of sortedIds) {
    if (enabled.has(id) || disabled.has(id)) continue;
    const mod = modulesById.get(id);
    if (!mod.json.defaultEnabled) continue;
    const requires = Array.isArray(mod.json.requires) ? mod.json.requires : [];
    const missing = requires.filter((reqId) => !enabled.has(reqId));
    if (missing.length) blocked.push({ id, missing });
  }

  return { ids: [...enabled], unknown: [], newlyEnabled, blocked, implicitlyDisabled: [] };
}

/**
 * Expands a module selection to include every dependency a `module.json`'s
 * own `requires` array declares, transitively, so a developer can never end
 * up with a module enabled whose dependency they left unchecked.
 *
 * @param {string[]} selectedIds The developer's own selection.
 * @param {{id: string, json: object}[]} allModules Every module this
 * repository ships.
 * @returns {{ids: string[], added: {id: string, requiredBy: string}[]}}
 * `ids` is `selectedIds` plus every auto-enabled dependency, original
 * selection first; `added` reports each auto-enabled id alongside the first
 * module found to require it, for the caller to tell the developer about.
 */
function moduleRequiresClosure(selectedIds, allModules) {
  const byId = new Map(allModules.map((m) => [m.id, m]));
  const ids = Array.isArray(selectedIds) ? selectedIds.slice() : [];
  const present = new Set(ids);
  const added = [];

  for (let i = 0; i < ids.length; i++) {
    const mod = byId.get(ids[i]);
    const requires = mod && Array.isArray(mod.json.requires) ? mod.json.requires : [];
    for (const reqId of requires) {
      if (present.has(reqId) || !byId.has(reqId)) continue;
      present.add(reqId);
      ids.push(reqId);
      added.push({ id: reqId, requiredBy: ids[i] });
    }
  }

  return { ids, added };
}

/**
 * Reads the `reply-language` module's ISO 639-1 catalogue, best-effort.
 *
 * @param {string} catalogueFile Absolute path to `languages.json`.
 * @returns {{code: string, name: string, endonym?: string}[] | null} The
 * catalogue entries, or `null` when the file is missing, unreadable, not
 * valid JSON, or carries no `languages` array — never thrown, so a damaged
 * catalogue degrades the `languages` question to plain free text instead of
 * failing the install.
 */
function loadReplyLanguageCatalogue(catalogueFile) {
  const data = readJson(catalogueFile);
  return data && Array.isArray(data.languages) ? data.languages : null;
}

/**
 * Maps a module option to the dedicated CLI flag that pre-supplies its
 * value, keyed by module id then option name — the same two special cases
 * {@link computeNewState} already applied before {@link collectInteractiveAnswers}
 * existed. A flag listed here both skips that option's interactive prompt
 * (the developer already answered, on the command line) and is the value
 * {@link computeNewState} stores for it.
 */
const OPTION_FLAG_SHORTCUTS = {
  "memory-as-context": { location: "memory-location" },
  "reply-language": { languages: "reply-language" },
};

/**
 * Folds CLI flags, prior local state and interactively-collected answers
 * into the state this run should write, applying `seed`-style "only when
 * absent" semantics to the CLI's own option values, not only to host
 * settings files.
 *
 * @param {string} agent `"claude"` or `"codex"`.
 * @param {{adapterOptions: object, options: object}} priorState The
 * agent's current local state.
 * @param {object} flags Parsed CLI flags.
 * @param {string[]} moduleIds The resolved enabled module set.
 * @param {{id: string, json: object}[]} allModules Every module this
 * repository ships, so a newly-enabled module's declared option defaults
 * can be seeded.
 * @param {object} [answers] This agent's own share of
 * {@link collectInteractiveAnswers}'s result — `{[moduleId]: {[optionName]:
 * value}}` — applied the same way the `--memory-location` /
 * `--reply-language` shortcuts below are, so downstream `{{OPT_*}}`
 * substitution, the manifest and `doctor` all see an interactively-answered
 * option through this one path rather than a second mechanism.
 * @returns {{modules: string[], adapterOptions: object, options: object}}
 * The state to write. `options` is keyed by module id, then option name —
 * generic to any module, per MODULES.md's `{{OPT_<NAME>}}` mechanism —
 * with `--memory-location` and `--reply-language` special-cased as the
 * documented shortcuts for `memory-as-context`'s `location` and
 * `reply-language`'s `languages` options specifically.
 */
function computeNewState(agent, priorState, flags, moduleIds, allModules, answers) {
  const state = {
    modules: moduleIds,
    adapterOptions: { ...priorState.adapterOptions },
    options: { ...priorState.options },
  };
  if (agent === "codex" && state.adapterOptions.askMode === undefined) state.adapterOptions.askMode = "block";

  for (const mod of allModules) {
    if (!moduleIds.includes(mod.id)) continue;
    const defs = mod.json.options || {};
    if (!state.options[mod.id]) state.options[mod.id] = {};
    for (const [name, def] of Object.entries(defs)) {
      if (state.options[mod.id][name] === undefined) state.options[mod.id][name] = def.default;
    }
  }

  if (typeof flags["memory-location"] === "string" && state.options["memory-as-context"]) {
    state.options["memory-as-context"].location = flags["memory-location"];
  }
  if (typeof flags["reply-language"] === "string" && state.options["reply-language"]) {
    state.options["reply-language"].languages = flags["reply-language"]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (answers) {
    for (const [modId, optAnswers] of Object.entries(answers)) {
      if (!state.options[modId]) continue;
      for (const [name, value] of Object.entries(optAnswers)) {
        state.options[modId][name] = value;
      }
    }
  }

  return state;
}

/**
 * Decides whether stdin is a terminal this run may safely prompt on,
 * without ever risking a hang on a CI or piped invocation that will never
 * supply an answer.
 *
 * @returns {boolean} `true` when `process.stdin.isTTY` is set, or when the
 * `SOFTELA_AI_FORCE_TTY` test seam is set. This repository's own installer
 * tests spawn the CLI with a piped stdin — never a real terminal, which
 * cannot be simulated in that suite — and set the env var to drive this
 * same production prompting path with scripted answers fed through the
 * pipe, rather than exercising a parallel copy of the logic.
 */
function isInteractiveStdin() {
  return !!process.stdin.isTTY || !!process.env.SOFTELA_AI_FORCE_TTY;
}

/**
 * Thrown by {@link collectInteractiveAnswers} to unwind out of whichever
 * question was in flight the moment the developer presses Ctrl-C, distinct
 * from `prompt.js`'s own `CANCELLED` (Escape) — which stays exactly what it
 * always was, "use the default for this one question" — since Ctrl-C means
 * "stop the run", not "skip this question". Never thrown once anything has
 * actually been written to disk: `collectInteractiveAnswers` only ever runs
 * before `runInstallOrUpdate`'s own locked read-modify-write, so unwinding
 * through it is always safe.
 */
class AbortedByDeveloper extends Error {
  constructor() {
    super("aborted by developer (Ctrl-C)");
    this.softelaAiAborted = true;
  }
}

/**
 * Decides whether a `prompt.selectOneCallback`/`selectManyCallback` result
 * reports the developer pressing Ctrl-C, as opposed to Escape or a plain
 * confirmed answer — see `prompt.js`'s own `ABORTED` sentinel, next to its
 * pre-existing `CANCELLED`.
 *
 * @param {{cancelled: boolean, aborted?: boolean}} result The callback's own
 * result object.
 * @returns {boolean} `true` only when the developer asked to stop the whole
 * run, never for an ordinary Escape (still `cancelled: true` alone) or a
 * confirmed answer.
 */
function wasAborted(result) {
  return !!(result && result.aborted);
}

/**
 * Hand-written hints for the enum options this installer ships, keyed by
 * module id, then option name, then value — taken from the option's own
 * `module.json` `prompt` text and `docs/internal/MODULES.md`, never
 * invented. An option or value not listed here (any future module's own
 * enum) simply renders with no hint.
 */
const ENUM_HINTS = {
  "memory-as-context": {
    location: {
      global: "the agent's own memory directory, shared with whatever the developer already keeps there",
      infrastructure: "a per-project folder inside this tool's own directory",
      repo: "inside the product repository, git-ignored",
    },
    checkpoint: {
      on: "save a checkpoint of everything the developer typed before a compaction drops it",
      off: "skip the compaction checkpoint",
    },
  },
};

/**
 * Looks up one enum value's hint.
 *
 * @param {string} [moduleId] The module id.
 * @param {string} [optionName] The option name.
 * @param {string} value The enum value.
 * @returns {string} The hint from {@link ENUM_HINTS}, or `""` when none is
 * declared for this module/option/value.
 */
function enumHint(moduleId, optionName, value) {
  const forModule = moduleId ? ENUM_HINTS[moduleId] : null;
  const forOption = forModule && optionName ? forModule[optionName] : null;
  return (forOption && forOption[value]) || "";
}

/**
 * Asks one module option's declared `prompt` through a plain typed answer —
 * no fixed choice set to pick from, so there is nothing to validate or
 * retry. `stringList` still comma-splits and trims, matching the shape
 * `--reply-language` produces; anything else is stored as the trimmed raw
 * text.
 *
 * @param {readline.Interface} rl The shared interactive session.
 * @param {object} def The option's declaration, `default` already resolved
 * to this question's effective default.
 * @param {(value: *) => void} onValue Called once, synchronously from
 * within the answer's own `line` event.
 * @returns {void}
 */
function askFreeTextOptionValue(rl, def, onValue) {
  const defaultLabel = Array.isArray(def.default) ? def.default.join(", ") : String(def.default);
  const question = `\n${def.prompt || ""}\n  [Enter for default: ${defaultLabel}] `;

  rl.question(question, (raw) => {
    const answer = String(raw).trim();
    if (!answer) {
      onValue(def.default);
      return;
    }
    if (def.type === "stringList") {
      const parsed = answer
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      onValue(parsed.length ? parsed : def.default);
      return;
    }
    onValue(answer);
  });
}

/**
 * Asks one module option's declared `prompt` on an already-open interactive
 * session, reporting the outcome through a plain callback rather than a
 * `Promise` — required so a caller chaining several questions on one shared,
 * already-open `readline.Interface` never loses a buffered answer; see
 * `prompt.js`'s own module doc for why an `await`-ed `Promise` between
 * questions silently drops every line but the first.
 *
 * Routes by `def.type`:
 * - `enum` — {@link prompt.selectOneCallback}, one choice per declared
 *   value, each carrying a short hint from {@link enumHint}.
 * - `stringList` belonging to `reply-language`'s `languages` option, when
 *   its catalogue loads — {@link prompt.selectManyCallback} over the
 *   catalogue. A catalogue that fails to load falls through to the line
 *   below instead of failing the install.
 * - anything else — {@link askFreeTextOptionValue}, which never reports
 *   `back` or `aborted` — a plain `readline.question()` has no Escape/Ctrl-C
 *   gesture of its own to intercept.
 *
 * A cancelled prompt (Escape without `canGoBack`, rich mode only) is treated
 * exactly like an empty answer — the option's own default — since nothing is
 * written anywhere until the review step at the very end of this collection
 * step is confirmed, so falling back to an already-valid, already-declared
 * default is always a safe, unsurprising outcome.
 *
 * @param {readline.Interface} rl The shared interactive session — left open
 * for the caller to ask further questions on and eventually close.
 * @param {object} def The option's declaration from `module.json`, with
 * `default` already resolved to the effective default this question should
 * offer (the module's own shipped default on a first install, the
 * developer's current stored value when reconfiguring, or whatever was
 * already answered this session when re-asked after a "go back" —
 * {@link collectInteractiveAnswers} decides which before calling this).
 * @param {boolean} canGoBack Whether Escape should report `back` instead of
 * cancelling to the default — `true` for every question after the first in
 * this collection step.
 * @param {(outcome: {back?: boolean, aborted?: boolean, value?: *}) => void} onOutcome
 * Called once, synchronously from within the answer's own event, with
 * exactly one of `back`, `aborted`, or `value` set.
 * @param {{id: string, dir: string, json: object}} [mod] The module this
 * option belongs to — needed only to resolve `reply-language`'s catalogue
 * file and to look up its enum hints; omitted callers get plain,
 * hint-free/catalogue-free behaviour.
 * @param {string} [optionName] The option's own name — needed only to look
 * up its enum hints in {@link ENUM_HINTS}.
 * @returns {void}
 */
function askOptionValue(rl, def, canGoBack, onOutcome, mod, optionName) {
  if (def.type === "enum" && Array.isArray(def.values)) {
    prompt.selectOneCallback(
      {
        title: def.prompt || "",
        choices: def.values.map((v) => ({ value: v, label: v, hint: enumHint(mod && mod.id, optionName, v) })),
        defaultValue: def.default,
        input: process.stdin,
        output: process.stdout,
        rl,
        canGoBack,
      },
      (result) => {
        if (wasAborted(result)) {
          onOutcome({ aborted: true });
          return;
        }
        if (result.back) {
          onOutcome({ back: true });
          return;
        }
        onOutcome({ value: result.cancelled ? def.default : result.value });
      },
    );
    return;
  }

  if (def.type === "stringList" && mod && mod.id === "reply-language") {
    const catalogue = loadReplyLanguageCatalogue(path.join(mod.dir, "languages.json"));
    if (catalogue) {
      prompt.selectManyCallback(
        {
          title: def.prompt || "",
          choices: catalogue.map((entry) => ({
            value: entry.name,
            label: entry.name,
            hint: [entry.code, entry.endonym].filter(Boolean).join(" · "),
          })),
          defaultValues: Array.isArray(def.default) ? def.default : [],
          input: process.stdin,
          output: process.stdout,
          rl,
          canGoBack,
        },
        (result) => {
          if (wasAborted(result)) {
            onOutcome({ aborted: true });
            return;
          }
          if (result.back) {
            onOutcome({ back: true });
            return;
          }
          onOutcome({ value: result.cancelled ? def.default : result.values });
        },
      );
      return;
    }
  }

  askFreeTextOptionValue(rl, def, (value) => onOutcome({ value }));
}

/**
 * Builds every option question a resolved module set would ask, in
 * declaration order, regardless of whether each one has already been
 * answered this session — so a caller can both count the total (for step
 * numbering) and find the next unanswered one from the same list.
 *
 * @param {{id: string, dir: string, json: object}[]} allModules Every module
 * this repository ships.
 * @param {object} flags Parsed CLI flags, checked against
 * {@link OPTION_FLAG_SHORTCUTS} so an option already supplied on the command
 * line is never asked here.
 * @param {string[]} moduleIds The resolved enabled module set.
 * @param {object} baselineOptions The stored option values to seed defaults
 * from and, outside `reconfigure`, to skip an already-answered option
 * against.
 * @param {boolean} reconfigure Whether every option is included regardless
 * of whether it already has a stored value (a "change it" answer), rather
 * than skipping one that already does.
 * @returns {{mod: object, name: string, def: object}[]} One entry per
 * question, `def.default` already resolved to this question's effective
 * default (the stored value under `reconfigure`, the module's own shipped
 * default otherwise).
 */
function computeOptionQuestions(allModules, flags, moduleIds, baselineOptions, reconfigure) {
  const questions = [];
  for (const mod of allModules) {
    if (!moduleIds.includes(mod.id)) continue;
    const defs = mod.json.options || {};
    for (const [name, def] of Object.entries(defs)) {
      const shortcutFlag = OPTION_FLAG_SHORTCUTS[mod.id] && OPTION_FLAG_SHORTCUTS[mod.id][name];
      if (shortcutFlag && typeof flags[shortcutFlag] === "string") continue;

      const stored = baselineOptions[mod.id];
      const hasStoredValue = !!stored && stored[name] !== undefined;
      if (hasStoredValue && !reconfigure) continue;

      const effectiveDefault = hasStoredValue ? stored[name] : def.default;
      questions.push({ mod, name, def: { ...def, default: effectiveDefault } });
    }
  }
  return questions;
}

/**
 * Canonicalises a value for {@link agentConfigSignature}: array element
 * order is preserved (this repository never treats an array's own order as
 * meaningful in the shapes stored here) but every plain object's keys are
 * sorted, so two states differing only in the key order `state.json`
 * happened to serialise still produce the identical signature.
 *
 * @param {*} value The value to canonicalise.
 * @returns {*} An equivalent value with every object's own keys sorted.
 */
function canonicalizeForSignature(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForSignature);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalizeForSignature(value[key]);
    return out;
  }
  return value;
}

/**
 * Computes a signature of what the module-selection and per-option
 * questions would be seeded from for one agent, so agents sharing it can be
 * grouped and asked once instead of once each — see {@link groupAgentsByConfig}.
 *
 * @param {{modules: string[], options: object}} priorState The agent's
 * current local state.
 * @returns {string} A string equal for two states that would produce the
 * identical question: the enabled module *set*, order-independent since no
 * code anywhere treats `state.modules`'s own order as meaningful, plus every
 * stored option value with key order normalised.
 */
function agentConfigSignature(priorState) {
  const modules = Array.isArray(priorState.modules) ? priorState.modules.slice().sort() : [];
  const options = canonicalizeForSignature(priorState.options || {});
  return JSON.stringify({ modules, options });
}

/**
 * Groups agents sharing an identical {@link agentConfigSignature}, so
 * `--agent all` (the default whenever both homes exist) is asked the
 * module-selection and reconfigure questions once per distinct
 * configuration rather than once per agent — two freshly-detected agents,
 * the common case, collapse to a single group asked a single time.
 *
 * @param {string[]} agents The agent ids to group.
 * @param {object} priorStates `{[agent]: priorState}`, already read.
 * @returns {{agents: string[], priorState: object}[]} One entry per
 * distinct signature, in the order its first member appears in `agents`;
 * `priorState` is one representative member's own state, valid for
 * rendering the whole group's question by construction.
 */
function groupAgentsByConfig(agents, priorStates) {
  const groups = [];
  const bySignature = new Map();
  for (const agent of agents) {
    const signature = agentConfigSignature(priorStates[agent]);
    let group = bySignature.get(signature);
    if (!group) {
      group = { agents: [], priorState: priorStates[agent] };
      bySignature.set(signature, group);
      groups.push(group);
    }
    group.agents.push(agent);
  }
  return groups;
}

/**
 * Renders the suffix a group's question carries to name which agent(s) it
 * is for.
 *
 * @param {{agents: string[]}} group The group asking this question.
 * @param {number} groupCount How many groups this run split its targeted
 * agents into.
 * @returns {string} `""` when a single group already covers every targeted
 * agent — a name that never varies is noise — otherwise `" for <agent>"` or
 * `" for <a>, <b>"`.
 */
function groupLabel(group, groupCount) {
  return groupCount <= 1 ? "" : ` for ${group.agents.join(", ")}`;
}

/**
 * Renders a single option value the way every module-configuration listing
 * shows it — a `stringList` joined with ", ", anything else coerced to a
 * plain string.
 *
 * @param {*} value The option's value.
 * @returns {string} The rendered text.
 */
function formatOptionValue(value) {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/**
 * Renders one group's module set and each enabled module's own option
 * values as indented, wrapped lines — shared by {@link printStoredConfig} (a
 * later run's stored configuration) and the review step's own listing
 * inside {@link collectInteractiveAnswers}, so the two can never drift in
 * how they format the same shape of data.
 *
 * @param {{modules: string[], options: object}} state The module set and
 * each enabled module's own option values to render.
 * @param {{id: string, json: object}[]} allModules Every module this
 * repository ships, so each enabled id renders by its own title.
 * @param {number} width The terminal width every rendered line must fit.
 * @returns {string[]} The rendered lines, indented two spaces —
 * `["  (no modules enabled)"]` when `state.modules` is empty.
 */
function renderModuleConfigLines(state, allModules, width) {
  const modules = Array.isArray(state.modules) ? state.modules : [];
  if (!modules.length) return ["  (no modules enabled)"];

  const byId = new Map(allModules.map((m) => [m.id, m]));
  const lines = [];
  for (const id of modules) {
    const mod = byId.get(id);
    const title = mod ? mod.json.title : id;
    const optionValues = (state.options && state.options[id]) || {};
    const rendered = Object.entries(optionValues)
      .map(([name, value]) => `${name}: ${formatOptionValue(value)}`)
      .join(", ");
    for (const line of wrapWithPrefix("  ", rendered ? `${title} — ${rendered}` : title, width)) lines.push(line);
  }
  return lines;
}

/**
 * Prints the developer's currently stored configuration for one group of
 * agents sharing it — enabled modules and each one's own option values — so
 * a later interactive run's continue/change question is answered against
 * something visible, never a hidden default.
 *
 * @param {string} label As {@link groupLabel} renders it.
 * @param {{modules: string[], options: object}} priorState One group
 * member's own state, representative of the whole group by construction.
 * @param {{id: string, json: object}[]} allModules Every module this
 * repository ships, so each enabled id renders by its own title.
 * @returns {void}
 */
function printStoredConfig(label, priorState, allModules) {
  console.log(`\ncurrent configuration${label}:`);
  for (const line of renderModuleConfigLines(priorState, allModules, outputWidth())) console.log(line);
}

/**
 * Prints one group's fully-resolved configuration inside the review step —
 * every enabled module and its own option values, whether the value came
 * from an answer given this run, a previously stored one, or a module's own
 * shipped default — so the listing is always complete, never only the
 * subset of questions this particular run happened to actually ask.
 *
 * @param {string} label As {@link groupLabel} renders it.
 * @param {{modules: string[], options: object}} effective The group's fully
 * resolved configuration.
 * @param {{id: string, json: object}[]} allModules Every module this
 * repository ships.
 * @returns {void}
 */
function printReviewConfig(label, effective, allModules) {
  console.log(`\nconfiguration to install${label}:`);
  for (const line of renderModuleConfigLines(effective, allModules, outputWidth())) console.log(line);
}

/**
 * Interactively asks the developer, on one shared session, what this run
 * should install: on a first install (no module selection stored yet for an
 * agent), which modules to enable — see {@link moduleRequiresClosure} for
 * how a `requires` dependency is folded in; on any later run, whether to
 * keep the stored configuration or change it (defaulting to "keep", so
 * pressing Enter behaves exactly as a routine update always has); then, for
 * whichever modules end up enabled, each one's own declared option values
 * this run would otherwise silently default or leave unchanged; finally, a
 * review step that prints everything chosen and asks for confirmation
 * before anything is applied.
 *
 * The whole flow is walked as an ordered, growing list of steps
 * (`module-select`, `continue-or-change`, `option`, and the trailing
 * `review`), addressed by a plain array index — see the local `steps`/
 * `runFrom`/`growSteps` inside the returned `Promise`'s executor. Later
 * steps are generated lazily, only once the answers they depend on are
 * known, so going back into an earlier one and answering it differently
 * (either via `canGoBack`'s Escape gesture, rich mode only, or via the
 * review step's own "go back and change something") drops every step after
 * it and regenerates them fresh against the new answer, rather than walking
 * forward through stale ones. A "back" on the very first step is a no-op —
 * `canGoBack` is only ever `true` from the second step on, so a rich-mode
 * Escape there simply has nothing to report.
 *
 * Agents sharing an identical {@link agentConfigSignature} — the common
 * `--agent all` case, on a machine with no prior install, whenever both
 * homes exist — are grouped by {@link groupAgentsByConfig} and asked the
 * module-selection/reconfigure questions once per group, not once per
 * agent; the group's single answer is then applied to every agent in it.
 * The per-option questions inherit the same grouping, since every member of
 * a group shares the identical stored options a question would be seeded
 * from. Only the two module-selection/reconfigure questions and the review
 * step's own per-group listing ever name which agent(s) they are for
 * ({@link groupLabel}) — the per-option questions read exactly as they
 * always have, since a group already ensures they mean the same thing for
 * every agent asked at once.
 *
 * Every read here (module discovery, each targeted agent's stored state) is
 * best-effort and unlocked, the same as `module list`'s own state read: this
 * function only decides what to ask and collects the answers, it writes
 * nothing — the `Promise` this returns resolves with the collected answers
 * only once the review step's own "install now" is confirmed, never before,
 * and the actual read-modify-write against each agent's state still happens
 * later inside {@link runInstallOrUpdate}'s own `manifestStore.withLock`,
 * once per agent — grouping only changes what is *asked*, never what is
 * applied or to whom.
 *
 * The module-selection question (the first-install multi-select, or a later
 * run's continue/change question) is skipped whenever `--modules` or
 * `flags.__moduleOp` (`module enable`/`disable`) already says what the
 * module set should be — asking would only second-guess an answer already
 * given on the command line. The per-option questions still run in that
 * case, exactly as they always have, against whatever module set
 * {@link resolveModuleSelection} resolves from those same flags. The review
 * step itself is skipped too, along with everything else, whenever nothing
 * was actually asked this run (every group's module set and every option
 * already resolved without a question) — there is nothing to review.
 *
 * @param {string[]} agents The agent ids this run targets.
 * @param {object} flags Parsed CLI flags.
 * @returns {Promise<object>} `{[agent]: {modules: string[] | null, options:
 * {[moduleId]: {[optionName]: value}}}}` — `modules: null` means the module
 * question was never asked for that agent, so {@link resolveModuleSelection}
 * should resolve it exactly as it does with no interactive answer at all;
 * `options` carries only what was actually asked. `{}` when nothing was
 * asked for any agent, including whenever stdin is not interactive (see
 * {@link isInteractiveStdin}) or `--yes` was passed, so a run in CI or under
 * a piped stdin never blocks waiting for input that will not come.
 * @throws {AbortedByDeveloper} Rejects with this, never resolves, the moment
 * a rich-mode question reports Ctrl-C (see {@link wasAborted}) — safe at any
 * point, since nothing this function's own caller does with the resolved
 * answers has run yet.
 */
async function collectInteractiveAnswers(agents, flags) {
  if (!isInteractiveStdin() || flags.yes || !agents.length) return {};

  const allModules = detect.discoverModules().slice().sort((a, b) => a.id.localeCompare(b.id));
  const moduleQuestionAllowed = typeof flags.modules !== "string" && !(flags.__moduleOp && typeof flags.__moduleOp.id === "string");

  const answers = {};
  for (const agent of agents) answers[agent] = { modules: null, options: {} };

  const priorStates = {};
  for (const agent of agents) priorStates[agent] = stateStore.readState(agent);
  const groups = groupAgentsByConfig(agents, priorStates);

  // One shared `readline.Interface` for every group and every question —
  // module selection, the continue/change question, every option question,
  // and the trailing review — walked with plain recursion so each next
  // `rl.question()` call happens synchronously from within the previous
  // answer's own event. See `askOptionValue`'s own doc comment for why an
  // `await`-ed `Promise` between questions would lose buffered answers.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const width = outputWidth();
  for (const line of wrapWithPrefix(
    "",
    "A few configuration questions follow — press Enter to accept the default shown, or Ctrl-C at any point to stop without changing anything.",
    width,
  )) {
    console.log(line);
  }

  // One resolution record per group, mutated as its own module-selection
  // step(s) resolve: `moduleIds: null` means the group's enabled set is not
  // yet known, the signal `growSteps` (below) uses to decide the next step
  // still owed is a module question rather than an option one. A group
  // whose module set comes from `--modules`/`__moduleOp` is resolved here,
  // eagerly, since nothing about it is ever interactively asked.
  const groupResolutions = groups.map((group) => {
    if (!moduleQuestionAllowed) {
      const selection = resolveModuleSelection(allModules, flags, group.priorState, "install");
      return { moduleIds: selection.ids, reconfigure: false, baselineOptions: group.priorState.options || {}, skipOptions: false, wantsChange: false, moduleStepCount: 0 };
    }
    return { moduleIds: null, reconfigure: false, baselineOptions: {}, skipOptions: false, wantsChange: false, moduleStepCount: 0 };
  });

  return new Promise((resolveAnswers, rejectAnswers) => {
    /** Every step generated so far, in order — see this function's own doc comment. */
    const steps = [];

    const finishAll = () => {
      rl.close();
      resolveAnswers(answers);
    };

    // Ctrl-C during any question below stops the whole collection step
    // immediately — no further question is asked, and the caller's own
    // `await collectInteractiveAnswers(...)` never resolves with a partial
    // answer set for `main()` to act on.
    const abortRun = () => {
      rl.close();
      rejectAnswers(new AbortedByDeveloper());
    };

    /**
     * Reports whether one module option already has a value for this
     * session — from an earlier answer, whether given moments ago or before
     * a "go back" revisited an unrelated step.
     *
     * @param {string} repAgent One group member, representative of the
     * whole group by construction.
     * @param {string} modId The module id.
     * @param {string} name The option name.
     * @returns {boolean} `true` when already answered.
     */
    function isAnswered(repAgent, modId, name) {
      return !!(answers[repAgent].options[modId] && answers[repAgent].options[modId][name] !== undefined);
    }

    /**
     * Decides whether every group's module set is already known, the
     * precondition for {@link totalStepsIfKnown} to return anything but
     * `null` — matching this function's own contract not to assert a total
     * before the module set is chosen.
     *
     * @returns {boolean} `true` once every group's `moduleIds` is resolved.
     */
    function everyGroupResolved() {
      return groupResolutions.every((r) => r.moduleIds !== null);
    }

    /**
     * Computes the total step count for this run, including the trailing
     * review step, once it is actually knowable.
     *
     * @returns {number | null} The total, or `null` while any group's
     * module set is still undetermined.
     */
    function totalStepsIfKnown() {
      if (!everyGroupResolved()) return null;
      let total = 0;
      for (let g = 0; g < groups.length; g++) {
        const res = groupResolutions[g];
        total += res.moduleStepCount;
        if (res.skipOptions) continue;
        total += computeOptionQuestions(allModules, flags, res.moduleIds, res.baselineOptions, res.reconfigure).length;
      }
      return total + 1;
    }

    /**
     * Renders the "Step N[ of M]." prefix a question's own title carries,
     * the total shown only once {@link totalStepsIfKnown} can actually
     * report one.
     *
     * @param {number} position This step's own index into `steps`.
     * @returns {string} The rendered prefix, e.g. `"Step 3. "` or `"Step 3
     * of 7. "`.
     */
    function stepPrefix(position) {
      const total = totalStepsIfKnown();
      return total !== null ? `Step ${position + 1} of ${total}. ` : `Step ${position + 1}. `;
    }

    /**
     * Resolves one group's fully-applied configuration for the review step —
     * every declared option of every enabled module, whether its value came
     * from an answer this session, a previously stored one, or the module's
     * own shipped default, so the listing is always complete rather than
     * only the subset of questions this particular run happened to ask.
     *
     * @param {number} g The group's index into `groups`/`groupResolutions`.
     * @returns {{modules: string[], options: object}} The resolved shape
     * {@link printReviewConfig} renders.
     */
    function computeEffectiveGroupConfig(g) {
      const group = groups[g];
      const res = groupResolutions[g];
      const repAgent = group.agents[0];
      const moduleIds = res.moduleIds !== null ? res.moduleIds : Array.isArray(group.priorState.modules) ? group.priorState.modules : [];

      const options = {};
      for (const id of moduleIds) {
        const mod = allModules.find((m) => m.id === id);
        if (!mod) continue;
        const defs = mod.json.options || {};
        const values = {};
        for (const [name, def] of Object.entries(defs)) {
          const answeredForModule = answers[repAgent].options[id];
          const answered = answeredForModule ? answeredForModule[name] : undefined;
          const storedForModule = res.baselineOptions[id];
          const stored = storedForModule ? storedForModule[name] : undefined;
          values[name] = answered !== undefined ? answered : stored !== undefined ? stored : def.default;
        }
        options[id] = values;
      }
      return { modules: moduleIds, options };
    }

    /**
     * Builds a module multi-select step, shared by the first-install pick
     * and the "change it" re-pick — the only difference between the two is
     * which fallback default set, baseline options and `reconfigure` flag
     * answering it resolves the group to.
     *
     * @param {number} g The group's index into `groups`/`groupResolutions`.
     * @param {string[]} fallbackDefaultIds The pre-checked module ids to
     * offer before anything has been chosen this session.
     * @param {{reconfigure: boolean, baselineOptions: object, moduleStepCount: number, wantsChangeOnRevisit: boolean}} resolution
     * What answering this step resolves the group's option-question phase
     * to; `wantsChangeOnRevisit` is what {@link Step#resetForRevisit} restores
     * `res.wantsChange` to, so jumping back to a "change it" re-pick lands on
     * this exact step again rather than back on the continue/change question.
     * @returns {object} The step.
     */
    function makeModuleSelectStep(g, fallbackDefaultIds, resolution) {
      const group = groups[g];
      const label = groupLabel(group, groups.length);
      const res = groupResolutions[g];
      return {
        kind: "module-select",
        title: `Which modules should be enabled${label}?`,
        describeValue: () => (res.moduleIds && res.moduleIds.length ? res.moduleIds.join(", ") : "(none)"),
        resetForRevisit: () => {
          res.moduleIds = null;
          res.wantsChange = !!resolution.wantsChangeOnRevisit;
        },
        run(position, onResult) {
          const currentDefaults = res.moduleIds || fallbackDefaultIds;
          prompt.selectManyCallback(
            {
              title: `\n${stepPrefix(position)}Which modules should be enabled${label}?`,
              choices: allModules.map((m) => ({ value: m.id, label: m.json.title, hint: m.json.summary })),
              defaultValues: currentDefaults,
              input: process.stdin,
              output: process.stdout,
              rl,
              canGoBack: position > 0,
            },
            (result) => {
              if (wasAborted(result)) {
                onResult({ aborted: true });
                return;
              }
              if (result.back) {
                onResult({ back: true });
                return;
              }
              const picked = result.cancelled ? currentDefaults : result.values;
              const closure = moduleRequiresClosure(picked, allModules);
              for (const a of closure.added) console.log(`  auto-enabled "${a.id}" — required by "${a.requiredBy}"`);
              for (const agent of group.agents) answers[agent].modules = closure.ids;
              res.moduleIds = closure.ids;
              res.reconfigure = resolution.reconfigure;
              res.baselineOptions = resolution.baselineOptions;
              res.skipOptions = false;
              res.wantsChange = false;
              res.moduleStepCount = resolution.moduleStepCount;
              onResult({});
            },
          );
        },
      };
    }

    /**
     * Builds the first-install module multi-select step for one group —
     * every shipped `defaultEnabled` module pre-checked, no baseline options
     * to seed from.
     *
     * @param {number} g The group's index into `groups`/`groupResolutions`.
     * @returns {object} The step.
     */
    function makeModuleFirstInstallStep(g) {
      const defaults = allModules.filter((m) => m.json.defaultEnabled).map((m) => m.id);
      return makeModuleSelectStep(g, defaults, { reconfigure: false, baselineOptions: {}, moduleStepCount: 1, wantsChangeOnRevisit: false });
    }

    /**
     * Builds the "change it" module multi-select step for one group — the
     * group's currently stored modules pre-checked, its stored options as
     * the baseline every option question then reconfigures from.
     *
     * @param {number} g The group's index into `groups`/`groupResolutions`.
     * @returns {object} The step.
     */
    function makeModuleChangeStep(g) {
      const priorState = groups[g].priorState;
      const priorModules = Array.isArray(priorState.modules) ? priorState.modules : [];
      return makeModuleSelectStep(g, priorModules, { reconfigure: true, baselineOptions: priorState.options || {}, moduleStepCount: 2, wantsChangeOnRevisit: true });
    }

    /**
     * Builds the continue/change step for one group that already has a
     * stored module selection — printing that stored configuration, then
     * asking whether to keep it (the default, so pressing Enter on a
     * routine later run behaves exactly as it always has) or change it.
     *
     * @param {number} g The group's index into `groups`/`groupResolutions`.
     * @returns {object} The step.
     */
    function makeContinueOrChangeStep(g) {
      const group = groups[g];
      const label = groupLabel(group, groups.length);
      const res = groupResolutions[g];
      const priorState = group.priorState;
      let lastChoice = "continue";
      return {
        kind: "continue-or-change",
        title: `Continue with this configuration${label}, or change it?`,
        describeValue: () => lastChoice,
        resetForRevisit: () => {
          res.moduleIds = null;
          res.wantsChange = false;
        },
        run(position, onResult) {
          printStoredConfig(label, priorState, allModules);
          prompt.selectOneCallback(
            {
              title: `${stepPrefix(position)}Continue with this configuration${label}, or change it?`,
              choices: [
                { value: "continue", label: "Continue with this configuration" },
                { value: "change", label: "Change it" },
              ],
              defaultValue: lastChoice,
              input: process.stdin,
              output: process.stdout,
              rl,
              canGoBack: position > 0,
            },
            (result) => {
              if (wasAborted(result)) {
                onResult({ aborted: true });
                return;
              }
              if (result.back) {
                onResult({ back: true });
                return;
              }
              lastChoice = result.cancelled ? "continue" : result.value;
              if (lastChoice === "continue") {
                res.moduleIds = Array.isArray(priorState.modules) ? priorState.modules : [];
                res.reconfigure = false;
                res.baselineOptions = priorState.options || {};
                res.skipOptions = true;
                res.wantsChange = false;
                res.moduleStepCount = 1;
              } else {
                res.moduleIds = null;
                res.skipOptions = false;
                res.wantsChange = true;
              }
              onResult({});
            },
          );
        },
      };
    }

    /**
     * Builds one module option's question step.
     *
     * @param {number} g The group's index into `groups`/`groupResolutions`.
     * @param {{id: string, dir: string, json: object}} mod The option's own
     * module.
     * @param {string} name The option name.
     * @param {object} def The option's declaration, `default` already
     * resolved to its baseline effective default.
     * @returns {object} The step.
     */
    function makeOptionStep(g, mod, name, def) {
      const group = groups[g];
      const repAgent = group.agents[0];
      return {
        kind: "option",
        title: def.prompt || `${mod.id}.${name}`,
        describeValue: () => {
          const stored = answers[repAgent].options[mod.id];
          const value = stored ? stored[name] : undefined;
          return formatOptionValue(value !== undefined ? value : def.default);
        },
        resetForRevisit: () => {
          for (const agent of group.agents) {
            if (answers[agent].options[mod.id]) delete answers[agent].options[mod.id][name];
          }
        },
        run(position, onResult) {
          const stored = answers[repAgent].options[mod.id];
          const sessionValue = stored ? stored[name] : undefined;
          const effectiveDefault = sessionValue !== undefined ? sessionValue : def.default;
          const stepDef = { ...def, default: effectiveDefault, prompt: `${stepPrefix(position)}${def.prompt || ""}` };
          askOptionValue(
            rl,
            stepDef,
            position > 0,
            (outcome) => {
              if (outcome.aborted) {
                onResult({ aborted: true });
                return;
              }
              if (outcome.back) {
                onResult({ back: true });
                return;
              }
              for (const agent of group.agents) {
                if (!answers[agent].options[mod.id]) answers[agent].options[mod.id] = {};
                answers[agent].options[mod.id][name] = outcome.value;
              }
              onResult({});
            },
            mod,
            name,
          );
        },
      };
    }

    /**
     * Asks the review step's own "install now, or go back" question.
     *
     * @param {number} position The review step's own index into `steps`.
     * @param {(result: {back?: boolean, aborted?: boolean}) => void} onResult
     * As every step's own `run`.
     * @returns {void}
     */
    function askProceedOrBack(position, onResult) {
      const proceedLabel = flags["dry-run"] ? "Continue to preview" : "Install now";
      prompt.selectOneCallback(
        {
          title: "",
          choices: [
            { value: "proceed", label: proceedLabel },
            { value: "back", label: "Go back and change something" },
          ],
          defaultValue: "proceed",
          input: process.stdin,
          output: process.stdout,
          rl,
          canGoBack: position > 0,
        },
        (result) => {
          if (wasAborted(result)) {
            onResult({ aborted: true });
            return;
          }
          if (result.back) {
            onResult({ back: true });
            return;
          }
          const choice = result.cancelled ? "proceed" : result.value;
          if (choice === "proceed") {
            onResult({});
            return;
          }
          askWhichStepToChange(onResult);
        },
      );
    }

    /**
     * Asks which already-answered step to jump back to, from the review
     * step's own "go back and change something" — offered by name, each
     * carrying its current answer as a hint, so the developer can go
     * straight to the one they want instead of walking back one at a time.
     *
     * The chosen step's own `resetForRevisit` clears exactly what it
     * resolved (an option's stored answer, or a group's module resolution)
     * before `steps` is truncated back to it and {@link runFrom} re-enters —
     * without that, `growSteps`'s "find the next unanswered question" search
     * would see the old answer still standing and skip straight past the
     * very step the developer just asked to revisit. Every OTHER
     * already-answered step is left untouched, so answering just this one
     * question returns straight to a freshly rendered review — nothing else
     * is re-asked unless changing this answer genuinely leaves something new
     * unresolved (a newly enabled module's own options, notably).
     *
     * @param {(result: {back?: boolean, aborted?: boolean}) => void} onResult
     * The review step's own `run` callback — only ever reached here through
     * `aborted`, since a chosen step re-enters {@link runFrom} directly
     * rather than returning through this callback.
     * @returns {void}
     */
    function askWhichStepToChange(onResult) {
      const named = steps.slice(0, -1);
      prompt.selectOneCallback(
        {
          title: "\nWhich step would you like to change?",
          choices: named.map((s, i) => ({ value: i, label: s.title, hint: s.describeValue() })),
          defaultValue: named.length - 1,
          input: process.stdin,
          output: process.stdout,
          rl,
          canGoBack: true,
        },
        (result) => {
          if (wasAborted(result)) {
            onResult({ aborted: true });
            return;
          }
          if (result.back) {
            askProceedOrBack(steps.length - 1, onResult);
            return;
          }
          const chosenIndex = result.cancelled ? named.length - 1 : result.value;
          named[chosenIndex].resetForRevisit();
          steps.length = chosenIndex;
          runFrom(chosenIndex);
        },
      );
    }

    /**
     * Builds the trailing review step — prints every group's fully-resolved
     * configuration ({@link computeEffectiveGroupConfig}), then asks to
     * install now or go back. Nothing this collection step has gathered is
     * handed back to its caller until "install now" is chosen here.
     *
     * @returns {object} The step.
     */
    function makeReviewStep() {
      return {
        kind: "review",
        title: "Review",
        describeValue: () => "",
        run(position, onResult) {
          console.log("");
          for (const line of wrapWithPrefix("", `${stepPrefix(position)}Review — nothing is installed until you confirm.`, width)) console.log(line);
          for (let g = 0; g < groups.length; g++) {
            printReviewConfig(groupLabel(groups[g], groups.length), computeEffectiveGroupConfig(g), allModules);
          }
          askProceedOrBack(position, onResult);
        },
      };
    }

    /**
     * Appends exactly one more step to `steps`, derived from the current
     * `groupResolutions`/`answers` state — the next unresolved group's
     * module question, that group's next unanswered option question, or,
     * once every group is fully settled, the trailing review step.
     *
     * @returns {boolean} `true` after appending a step; `false` when the
     * review step is already the last entry (nothing more to grow, ever),
     * or when `steps` is still empty (nothing was ever asked, so the whole
     * collection step is done with no review to show).
     */
    function growSteps() {
      const last = steps[steps.length - 1];
      if (last && last.kind === "review") return false;

      for (let g = 0; g < groups.length; g++) {
        const res = groupResolutions[g];
        if (res.moduleIds === null) {
          if (res.wantsChange) {
            steps.push(makeModuleChangeStep(g));
            return true;
          }
          const hasStoredModules = Array.isArray(groups[g].priorState.modules) && groups[g].priorState.modules.length > 0;
          steps.push(hasStoredModules ? makeContinueOrChangeStep(g) : makeModuleFirstInstallStep(g));
          return true;
        }
        if (res.skipOptions) continue;
        const questions = computeOptionQuestions(allModules, flags, res.moduleIds, res.baselineOptions, res.reconfigure);
        const repAgent = groups[g].agents[0];
        const next = questions.find((q) => !isAnswered(repAgent, q.mod.id, q.name));
        if (next) {
          steps.push(makeOptionStep(g, next.mod, next.name, next.def));
          return true;
        }
      }

      if (steps.length === 0) return false;
      steps.push(makeReviewStep());
      return true;
    }

    /**
     * Runs (or re-runs) the step at one position, growing `steps` first when
     * it does not exist yet, and dispatches its outcome: forward to the next
     * position, backward by dropping this step and re-entering the previous
     * one, or straight out through `abortRun`.
     *
     * @param {number} i The target position; clamped to `0` so a "back" from
     * the first step is a no-op rather than an out-of-range index.
     * @returns {void}
     */
    function runFrom(i) {
      const position = Math.max(0, i);
      if (position >= steps.length && !growSteps()) {
        finishAll();
        return;
      }
      steps[position].run(position, (result) => {
        if (result.aborted) {
          abortRun();
          return;
        }
        if (result.back) {
          steps.length = position;
          runFrom(position - 1);
          return;
        }
        runFrom(position + 1);
      });
    }

    runFrom(0);
  });
}

/**
 * Renders one line per foreign hook, and one per managed-block ambiguity,
 * across every agent a conflict-detection pass found something for.
 *
 * @param {{agent: string, conflicts: {hookGroups: object[], managedBlock: object | null}}[]} groups
 * As collected by {@link resolveConflictsPreflight}.
 * @returns {string[]} The rendered lines.
 */
function renderConflictGroups(groups) {
  const lines = [];
  for (const { agent, conflicts } of groups) {
    for (const g of conflicts.hookGroups) {
      for (const h of g.hooks) {
        // Deliberately never wrapped or truncated: this carries the
        // developer's own literal hook command/path verbatim, and
        // `tests/installer/conflicts.test.js` asserts it appears
        // byte-for-byte in this output — mangling it would defeat the whole
        // point of showing it (recognising your own registration).
        lines.push(`  ${agent}  hooks.${g.event}  matcher=${JSON.stringify(h.matcher)}  command=${h.command}`);
      }
    }
    if (conflicts.managedBlock) {
      lines.push(`  ${agent}  ${conflicts.managedBlock.target}  ${conflicts.managedBlock.message}`);
    }
  }
  return lines;
}

/**
 * Prints the conflicts found on a non-interactive run with no
 * `--on-conflict` given — refusing to guess (Part 1's non-negotiable case),
 * naming all three flag values so the message alone is enough to act on.
 *
 * @param {object[]} groups As collected by {@link resolveConflictsPreflight}.
 * @returns {void}
 */
function printConflictsUnresolved(groups) {
  const width = outputWidth();
  for (const line of wrapWithPrefix("", "conflict  found pre-existing local hook registration(s) that softela-ai did not put there:", width)) console.log(line);
  for (const line of renderConflictGroups(groups)) console.log(line);
  console.log("");
  for (const line of wrapWithPrefix("", "non-interactive run, no --on-conflict given — refusing to guess. Re-run with one of:", width)) console.log(line);
  const flagWidth = Math.max("--on-conflict=replace".length, "--on-conflict=reconcile".length, "--on-conflict=abort".length);
  for (const line of renderAlignedRow("--on-conflict=replace", flagWidth, "(recommended) disable the conflicting registration, use softela-ai's own", width)) console.log(line);
  for (const line of renderAlignedRow("--on-conflict=reconcile", flagWidth, "report what each side would install and the question to answer; does not merge", width)) console.log(line);
  for (const line of renderAlignedRow("--on-conflict=abort", flagWidth, "stop, changing nothing (same as this run)", width)) console.log(line);
}

/**
 * Prints the conflicts found under an explicit `--on-conflict=abort`.
 *
 * @param {object[]} groups As collected by {@link resolveConflictsPreflight}.
 * @returns {void}
 */
function printConflictsAbort(groups) {
  const width = outputWidth();
  for (const line of wrapWithPrefix("", "conflict  --on-conflict=abort — the following were found; nothing was changed:", width)) console.log(line);
  for (const line of renderConflictGroups(groups)) console.log(line);
}

/**
 * Prints the per-conflict report `--on-conflict=reconcile` produces: what
 * softela-ai would install, what the developer already has, and the specific
 * question left to answer — never a merge attempt (Part 1's "asks, does not
 * guess" requirement).
 *
 * @param {object[]} groups As collected by {@link resolveConflictsPreflight}.
 * @returns {void}
 */
function printConflictsReconcile(groups) {
  const width = outputWidth();
  // Left as one line on purpose, even past `width`: `conflicts.test.js`
  // asserts the phrase "does not merge" survives intact, and a word-wrap
  // break can land between "does" and "not" depending on terminal width —
  // wrapping this specific sentence risks exactly the corruption the
  // invariant this task adds is meant to prevent elsewhere.
  console.log(
    'conflict  --on-conflict=reconcile — reporting what softela-ai would install and the question to answer for each conflict; it does not merge them on its own.',
  );
  for (const { agent, conflicts } of groups) {
    const ctx = detect.gather(agent);
    const plannedActions = plan.buildPlan(ctx);
    for (const g of conflicts.hookGroups) {
      const ours = plannedActions.find((a) => a.kind === "settings" && a.event === g.event && a.action === "write");
      for (const h of g.hooks) {
        console.log(`  ${agent}  hooks.${g.event}`);
        // Both lines below carry literal data (a hook registration's own
        // JSON, or the developer's own command) — never wrapped, same
        // reasoning as `renderConflictGroups`.
        console.log(`    softela-ai would install: ${ours ? JSON.stringify(ours.value) : "(nothing for this event)"}`);
        console.log(`    you already have:     matcher=${JSON.stringify(h.matcher)}  command=${h.command}`);
        for (const line of wrapWithPrefix(
          "    ",
          `question: keep your own and skip softela-ai's here, replace yours with softela-ai's (re-run with --on-conflict=replace), or combine them by hand in ${path.basename(ctx.settingsFile)} and re-run?`,
          width,
        )) {
          console.log(line);
        }
      }
    }
    if (conflicts.managedBlock) {
      console.log(`  ${agent}  ${conflicts.managedBlock.target}`);
      console.log(`    ${conflicts.managedBlock.message}`);
      for (const line of wrapWithPrefix("    ", "question: resolve the ambiguous markers by hand (softela-ai will not guess which is its own), then re-run.", width)) {
        console.log(line);
      }
    }
  }
}

/**
 * How many attempts {@link askConflictResolution} tolerates before falling
 * back to the recommended `"replace"` — the same bounded-retry discipline
 * {@link askOptionValue} already applies to an invalid enum answer, so a
 * pasted or scripted bad answer can never loop forever.
 */
const MAX_CONFLICT_PROMPT_ATTEMPTS = 3;

/**
 * Prompts once for how to resolve a run's detected conflicts, recommending
 * `"replace"`.
 *
 * Unlike {@link askOptionValue}'s per-module-option loop, there is only ever
 * one question in this flow, so a single `rl.question()` call wrapped in a
 * `Promise` — the same shape {@link promptYesNo} already uses — is safe: the
 * buffered-line hazard `askOptionValue`'s own doc comment warns about only
 * bites when a SECOND `rl.question()` call is issued from inside an `await`
 * continuation after the first, which never happens here.
 *
 * @param {readline.Interface} rl An already-open interactive session.
 * @returns {Promise<"replace" | "reconcile" | "abort">} The developer's
 * choice; pressing Enter takes the recommended `"replace"`.
 */
function askConflictResolution(rl) {
  return new Promise((resolveAnswer) => {
    let attempts = 0;
    const ask = () => {
      rl.question(
        '\nHow should these conflicts be resolved?\n' +
          '  [replace]   (recommended) disable the conflicting local registration, use softela-ai\'s own\n' +
          '  reconcile   report what each side would install and the question to answer, then stop — does not merge\n' +
          '  abort       stop, changing nothing\n' +
          "[Enter for replace] ",
        (raw) => {
          const answer = String(raw).trim().toLowerCase();
          if (!answer || answer === "replace") return resolveAnswer("replace");
          if (answer === "reconcile" || answer === "abort") return resolveAnswer(answer);
          attempts += 1;
          if (attempts >= MAX_CONFLICT_PROMPT_ATTEMPTS) {
            console.log(`  using the recommended "replace" after ${MAX_CONFLICT_PROMPT_ATTEMPTS} invalid answers`);
            return resolveAnswer("replace");
          }
          console.log(`  "${answer}" is not one of: replace, reconcile, abort — try again.`);
          ask();
        },
      );
    };
    ask();
  });
}

/**
 * Detects every conflict a run's targeted agents currently carry, and
 * resolves which of Part 1's three responses applies — from `--on-conflict`,
 * by asking on an interactive terminal, or by refusing to guess otherwise.
 *
 * Every agent's context here is read outside any lock, the same way
 * {@link collectInteractiveAnswers} reads prior state before its own lock:
 * this function only decides which resolution applies and never writes;
 * {@link runInstallOrUpdate} re-detects the same conflicts inside its own
 * per-agent lock before acting on them (the authoritative check — see its
 * own doc comment), so nothing here needs to hold that lock across an
 * interactive wait on keyboard input.
 *
 * @param {string[]} agents The agent ids this run targets.
 * @param {object} flags Parsed CLI flags.
 * @returns {Promise<{groups: object[], resolution: "replace" | "reconcile" | "abort" | null, blocked: boolean}>}
 * `groups` is empty when nothing conflicts, in which case `resolution` is
 * `null` and `blocked` is `false` — the common case, no different from
 * before this feature existed. Otherwise `resolution` is `null` only when
 * nothing could be decided without guessing (non-interactive stdin, no
 * `--on-conflict`); `blocked` is `true` for that case and for an explicit or
 * interactively-chosen `"abort"`/`"reconcile"`, since both of those stop the
 * run by design — only `"replace"` ever lets the caller proceed.
 */
async function resolveConflictsPreflight(agents, flags) {
  const groups = [];
  for (const agent of agents) {
    const ctx = detect.gather(agent);
    const conflicts = conflictsLib.detectConflicts(ctx);
    if (conflictsLib.hasConflicts(conflicts)) groups.push({ agent, conflicts });
  }
  if (!groups.length) return { groups, resolution: null, blocked: false };

  if (typeof flags["on-conflict"] === "string") {
    const resolution = flags["on-conflict"];
    return { groups, resolution, blocked: resolution !== "replace" };
  }

  if (!isInteractiveStdin()) {
    return { groups, resolution: null, blocked: true };
  }

  console.log("conflict  found pre-existing local hook registration(s) that softela-ai did not put there:");
  for (const line of renderConflictGroups(groups)) console.log(line);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const resolution = await askConflictResolution(rl);
  rl.close();
  return { groups, resolution, blocked: resolution !== "replace" };
}

/**
 * Runs the conflict-detection pre-flight for `install`/`update` and prints
 * whichever outcome it reaches. Called from {@link main} before either
 * command's own plan-then-apply work begins.
 *
 * @param {string[]} agents The agent ids this run targets.
 * @param {object} flags Parsed CLI flags; `flags["on-conflict"]` is set to
 * the resolved value in place when the run may proceed, so
 * {@link runInstallOrUpdate} reads the same decision this function reached
 * without it being threaded through as a separate parameter.
 * @returns {Promise<boolean>} `true` when the run may proceed (nothing
 * conflicted, or `"replace"` was chosen); `false` when it must stop here —
 * the appropriate report has already been printed.
 */
async function applyConflictGate(agents, flags) {
  const check = await resolveConflictsPreflight(agents, flags);
  if (!check.groups.length) return true;

  if (check.blocked) {
    if (check.resolution === "abort") printConflictsAbort(check.groups);
    else if (check.resolution === "reconcile") printConflictsReconcile(check.groups);
    else printConflictsUnresolved(check.groups);
    return false;
  }

  flags["on-conflict"] = check.resolution;
  return true;
}

/**
 * Runs `install` or `update` for every targeted agent.
 *
 * @param {"install" | "update"} mode Which command this is — they share
 * every mechanic; `mode` only affects module-selection defaults and the
 * printed header.
 * @param {object} flags Parsed CLI flags.
 * @param {object} [answers] Interactively-collected option answers, as
 * returned by {@link collectInteractiveAnswers} — `{}` (its default) for
 * `update` and for `module enable`/`disable`, which never prompt.
 * @returns {{code: number, out: object}} The process exit code and a
 * summary for `--json` or text rendering.
 */
function runInstallOrUpdate(mode, flags, answers = {}) {
  const agents = detect.resolveAgents(flags.agent);
  if (!agents.length) {
    return {
      code: 2,
      out: { ok: false, message: "No agent home found (~/.claude or ~/.codex). Pass --agent claude|codex to install anyway." },
    };
  }

  const version = detect.readVersion() || "0.0.0";
  const now = Date.now();
  const perAgent = [];
  let anyChange = false;
  let anyError = false;

  for (const agent of agents) {
    // Everything that reads this agent's prior state and everything that
    // writes its manifest, state file and installed payload lives inside one
    // lock acquisition — reading `priorState` before the lock, the way this
    // used to work, is exactly what let two concurrent runs each act on the
    // same stale snapshot and silently overwrite one another's result.
    const result = manifestStore.withLock(agent, () => {
      const allModules = detect.discoverModules();
      const priorState = stateStore.readState(agent);
      const priorManifest = manifestStore.readManifest(agent);
      const priorDisabled = (priorManifest && priorManifest.disabledModules) || [];
      const agentAnswers = answers[agent];

      // `module enable`/`disable` (via `flags.__moduleOp`) is the only
      // caller that ever changes the disabled record; every other run keeps
      // it exactly as the manifest already had it, so a module the
      // developer never touched cannot silently leave or re-enter it.
      let disabledIds = priorDisabled;
      if (flags.__moduleOp && typeof flags.__moduleOp.id === "string") {
        const disabledSet = new Set(priorDisabled);
        if (flags.__moduleOp.action === "disable") disabledSet.add(flags.__moduleOp.id);
        else disabledSet.delete(flags.__moduleOp.id);
        disabledIds = [...disabledSet];
      }

      // The interactively-collected module selection is resolved against
      // `priorState` inside this same locked critical section it was read
      // in, not against the snapshot `collectInteractiveAnswers` read before
      // the lock — see `resolveModuleSelection`'s own doc comment.
      const selection = resolveModuleSelection(allModules, flags, priorState, mode, agentAnswers && agentAnswers.modules, disabledIds);

      // An explicit `--modules` list or a confirmed interactive pick is the
      // developer choosing a set — whatever `defaultEnabled` module it
      // leaves out is being turned off on purpose, the same as `module
      // disable`, not merely "not mentioned". Recorded into the disabled set
      // this same run persists, so a later re-run's own fallback (below,
      // inside `resolveModuleSelection`) never sweeps it back in — while a
      // module that does not exist yet at the time of this choice is simply
      // absent from `allModules` and so never added here, and still reaches
      // the agent whenever it ships.
      if (selection.implicitlyDisabled.length) {
        const disabledSet = new Set(disabledIds);
        for (const id of selection.implicitlyDisabled) disabledSet.add(id);
        disabledIds = [...disabledSet];
      }
      // Folded in BEFORE gather/plan, not only before the state.json write, so
      // a first-run flag such as `--memory-location` or `--reply-language` —
      // or an interactively-collected answer from `collectInteractiveAnswers`
      // — actually reaches what THIS run installs, not only what it remembers
      // for the next one (IMPORTANT B3).
      const newState = computeNewState(agent, priorState, flags, selection.ids, allModules, agentAnswers && agentAnswers.options);

      const ctx = detect.gather(agent, { enabledModuleIds: selection.ids, state: newState });
      ctx.version = version;
      ctx.now = now;

      // The authoritative conflict check — re-detected fresh here, inside the
      // lock, rather than trusted from `applyConflictGate`'s own earlier,
      // unlocked read (Part 1). This is also the ONLY conflict check `module
      // enable`/`disable` ever sees, since `cmdModule` calls this function
      // directly without going through `applyConflictGate` at all — so the
      // safety net has to live here, not only in `main()`'s pre-flight, for
      // "a non-interactive run can never clobber a developer's own hooks
      // without --on-conflict=replace" to hold through every entry point.
      const conflicts = conflictsLib.detectConflicts(ctx);
      const conflicted = conflictsLib.hasConflicts(conflicts);
      const resolution = flags["on-conflict"];

      if (conflicted && resolution !== "replace") {
        // Nothing is written for this agent — even an otherwise-harmless
        // file copy is withheld. Proceeding with everything except the
        // conflicting hook would still silently add softela-ai's own dispatcher
        // entry alongside the developer's un-reviewed one (Claude Code and
        // Codex both merge hook entries — see conflicts.js's own module
        // doc), exactly the "quietly, at its own discretion" outcome Part 1
        // rules out.
        return {
          agent,
          actions: [],
          empty: true,
          applied: null,
          unknownModules: selection.unknown,
          newlyEnabledModules: [],
          requiresBlockedModules: [],
          home: ctx.home,
          codexTrustCaveat: null,
          areaWarnings: [],
          configErrors: [],
          tierFallbacks: [],
          conflicts,
          conflictResolution: resolution || null,
          blockedByConflicts: true,
          disabledForeignHooks: [],
        };
      }

      const actions = plan.buildPlan(ctx);
      const replaceActions = conflicted ? conflictsLib.buildReplaceActions(ctx, conflicts) : [];
      if (replaceActions.length) actions.push(...replaceActions);

      const empty = planIsEmpty(actions);
      const anyHookWrite = actions.some((a) => a.kind === "settings" && a.event && a.action === "write");
      const codexTrustCaveat = agent === "codex" && anyHookWrite ? doctor.CODEX_TRUST_CAVEAT : null;
      const areaWarnings = summarizeAreaWarnings(actions);
      const configErrors = summarizeConfigErrors(actions);
      const tierFallbacks = summarizeTierFallbacks(actions);
      const disabledChanged = JSON.stringify(disabledIds) !== JSON.stringify(priorDisabled);

      let applied = null;
      if (!flags["dry-run"] && !empty) {
        applied = apply.applyPlan(actions, ctx);
        // `apply.js#buildManifest` has no notion of the disabled-module
        // record — it only ever built `modules` — so it is folded in here,
        // onto the manifest object it just produced, before that manifest
        // reaches disk. Skipping this would silently drop every explicit
        // disable back to "none recorded" the next time anything else about
        // this agent changed.
        applied.manifest.disabledModules = disabledIds;
        manifestStore.writeManifest(agent, applied.manifest);
        stateStore.writeState(agent, newState);
        // Written at install and update time so `readVersion` can fall back to
        // it once the source clone is gone (IMPORTANT I5).
        writeTextAtomic(path.join(ctx.installedRoot, "VERSION"), `${ctx.version}\n`);
        apply.pruneEmptyDirs(ctx.installedRoot);
      } else if (!flags["dry-run"]) {
        // Nothing actionable, but a module selection may still be new to record.
        stateStore.writeState(agent, newState);
        // `module disable`/`enable` on a module with no installed footprint
        // (nothing to add or remove on disk) still leaves the plan empty —
        // the disabled record must still reach the manifest, or the command
        // is a silent no-op. Only written when it actually changed, and only
        // when a manifest already exists to patch (a module never installed
        // at all has no manifest for this to update yet).
        if (disabledChanged && priorManifest) {
          manifestStore.writeManifest(agent, { ...priorManifest, disabledModules: disabledIds });
        }
      }

      return {
        agent,
        actions,
        empty,
        applied,
        unknownModules: selection.unknown,
        newlyEnabledModules: selection.newlyEnabled,
        requiresBlockedModules: selection.blocked,
        home: ctx.home,
        codexTrustCaveat,
        areaWarnings,
        configErrors,
        tierFallbacks,
        conflicts: conflicted ? conflicts : null,
        conflictResolution: conflicted ? "replace" : null,
        blockedByConflicts: false,
        disabledForeignHooks: replaceActions.map((a) => ({ event: a.event, command: a.needle })),
      };
    });

    if (!result.empty || result.newlyEnabledModules.length) anyChange = true;
    if (result.configErrors.length) anyError = true;
    if (result.applied && result.applied.report.errors.length) anyError = true;
    if (result.blockedByConflicts) anyError = true;
    perAgent.push(result);
  }

  return { code: anyError ? 1 : anyChange ? 0 : 2, out: { mode, agents: perAgent } };
}

/**
 * Prints the result of {@link runInstallOrUpdate}.
 *
 * @param {"install" | "update"} mode The command that ran.
 * @param {{agents: object[]}} out Its result.
 * @param {object} flags Parsed CLI flags.
 * @returns {void}
 */
function printInstallOrUpdate(mode, out, flags) {
  const width = outputWidth();
  if (out.message) {
    for (const line of wrapWithPrefix("", out.message, width)) console.log(line);
    return;
  }
  const dryRun = !!flags["dry-run"];
  for (const a of out.agents) {
    for (const line of wrapWithPrefix("", `softela-ai ${mode} -> ${a.agent}${dryRun ? "  (dry run - nothing written)" : ""}`, width)) console.log(line);
    if (a.blockedByConflicts) {
      console.log("  conflict  unresolved local hook registration(s) — nothing changed for this agent:");
      for (const line of renderConflictGroups([{ agent: a.agent, conflicts: a.conflicts }])) console.log(line);
      for (const line of wrapWithPrefix("  ", "re-run with --on-conflict=replace, --on-conflict=reconcile or --on-conflict=abort to resolve.", width)) console.log(line);
      console.log("");
      continue;
    }
    if (a.unknownModules.length) console.log(`  unknown module(s) ignored: ${a.unknownModules.join(", ")}`);
    // A newly-enabled or requires-blocked default module is a change in
    // enforcement (or a change withheld), never a silent one — printed
    // regardless of --verbose, the same principle as the warnings below.
    for (const line of summarizeNewlyEnabledModules(a.newlyEnabledModules)) console.log(`  ${line}`);
    for (const line of summarizeRequiresBlockedModules(a.requiresBlockedModules)) console.log(`  NOTE: ${line}`);
    const lines = renderPlan(a.actions, a.home, !!flags.verbose, width);
    if (!lines.length) console.log("  (nothing to do)");
    else for (const line of lines) console.log(line);
    // Loud regardless of --verbose or --dry-run — see summarizeAreaWarnings.
    if (a.areaWarnings) {
      for (const w of a.areaWarnings) console.log(`  WARNING: ${w}`);
    }
    // Same principle for a malformed seed setting and a fallback-sourced
    // model id — see summarizeConfigErrors and summarizeTierFallbacks.
    if (a.configErrors) {
      for (const e of a.configErrors) console.log(`  ERROR: ${e}`);
    }
    if (a.tierFallbacks) {
      for (const w of a.tierFallbacks) console.log(`  NOTE: ${w}`);
    }
    if (a.applied) {
      if (a.applied.report.modifiedKept.length) {
        console.log(`  kept locally-modified: ${a.applied.report.modifiedKept.join(", ")}`);
      }
      if (a.applied.report.errors.length) {
        for (const e of a.applied.report.errors) console.log(`  error: ${e}`);
      }
      // Never wrapped: a real filesystem path — see printClosingSummary's
      // own backup line for why.
      if (a.applied.backupsDir) console.log(`  backups: ${a.applied.backupsDir}`);
    }
    // Report exactly what conflict resolution "replace" disabled — see
    // conflicts.js#buildReplaceActions; the backup line above already names
    // where the pre-change settings file went.
    if (a.disabledForeignHooks && a.disabledForeignHooks.length) {
      console.log('  conflict resolution "replace" disabled:');
      // Never wrapped: the developer's own literal hook command —
      // `conflicts.test.js` asserts it survives byte-for-byte, same as
      // `renderConflictGroups`'s own lines.
      for (const d of a.disabledForeignHooks) console.log(`    hooks.${d.event}  ${d.command}`);
    }
    console.log("");
  }
  printClosingSummary(mode, out.agents, dryRun);
}

/**
 * Decides whether an `softela-ai` executable is already reachable via
 * `process.env.PATH`, so {@link printClosingSummary} only tells a developer
 * how to run it manually when that is actually true — stating it
 * unconditionally would claim something false about the very machine this
 * command just finished inspecting, for a developer who plainly just ran
 * `softela-ai install` from their own shell.
 *
 * @returns {boolean} `true` when a file named `softela-ai` — or, wherever
 * `PATHEXT` lists extensions (Windows), `softela-ai` suffixed with one of them —
 * exists directly inside any directory `process.env.PATH` lists. Never
 * throws: a malformed `PATH`/`PATHEXT`, an inaccessible directory, or a
 * missing entry is treated as "not found" rather than failing the command
 * that already succeeded.
 */
function isSoftelaAiOnPath() {
  try {
    const dirs = String(process.env.PATH || "")
      .split(path.delimiter)
      .filter(Boolean);
    const extensions = String(process.env.PATHEXT || "")
      .split(path.delimiter)
      .map((ext) => ext.trim())
      .filter(Boolean);
    const names = ["softela-ai", ...extensions.map((ext) => `softela-ai${ext.toLowerCase()}`)];

    for (const dir of dirs) {
      for (const name of names) {
        try {
          if (fs.statSync(path.join(dir, name)).isFile()) return true;
        } catch {
          // Not there, not readable, or not a plain file — keep looking.
        }
      }
    }
    return false;
  } catch {
    // A PATH so malformed it cannot even be split — treat as "not found"
    // rather than letting a bad environment variable break a successful
    // install's own closing summary.
    return false;
  }
}

/**
 * Prints the closing section after every agent's own block — the last
 * thing a developer reads, once the per-agent detail above has scrolled
 * past — so the run stops without simply trailing off after its last `+`
 * line (INSTALLER.md §2).
 *
 * Flow:
 * - States whether this run wrote anything, and for which agent(s), or that
 *   it was only a preview.
 * - Names each agent's backup directory, when one was created — the same
 *   value the per-agent block above already prints next to `backups:`.
 * - Always names `softela-ai doctor` as the next step to verify what landed.
 * - Names the command to run `softela-ai` again, built the same way
 *   `doctor.js`'s own "run via:" line is, only when {@link isSoftelaAiOnPath}
 *   actually reports it missing — only once something was actually written
 *   this run, never for a preview, and never when the developer plainly
 *   just ran it from their own shell.
 * - Names the Codex one-time hook-trust review as a next step, reusing
 *   `doctor.CODEX_TRUST_CAVEAT` verbatim (CONTRACTS §7), for any agent
 *   whose Codex hook was actually written this run — never for a preview,
 *   since nothing was written for it to review yet.
 *
 * @param {"install" | "update"} mode The command that ran.
 * @param {object[]} agents Each agent's result, as built by
 * {@link runInstallOrUpdate}.
 * @param {boolean} dryRun Whether this was a preview run.
 * @returns {void}
 */
function printClosingSummary(mode, agents, dryRun) {
  const width = outputWidth();
  // An agent left blockedByConflicts already printed its own "nothing
  // changed" report above and has nothing further to summarize here.
  const usable = agents.filter((a) => !a.blockedByConflicts);
  if (!usable.length) return;

  const written = usable.filter((a) => a.applied);
  const names = (list) => list.map((a) => a.agent).join(", ");

  if (dryRun) {
    for (const line of wrapWithPrefix("", `Preview only - nothing was written (${names(usable)}).`, width)) console.log(line);
  } else if (written.length) {
    for (const line of wrapWithPrefix("", `Done. ${mode === "update" ? "Updated" : "Installed"} for ${names(written)}.`, width)) console.log(line);
  } else {
    console.log("Done. Everything was already up to date.");
  }
  for (const a of written) {
    // Never wrapped or truncated: a real filesystem path, and
    // `output-format.test.js` asserts it appears byte-for-byte so the
    // developer can copy it straight into their next command.
    if (a.applied.backupsDir) console.log(`  backup (${a.agent}): ${a.applied.backupsDir}`);
  }

  console.log("");
  console.log("Next steps");
  for (const line of wrapWithPrefix("  1. Check what landed:  ", "softela-ai doctor", width)) console.log(line);

  // Stated as its own step, not a footnote: on Codex an installed hook does
  // nothing at all until the developer completes Codex's own trust review,
  // so "installed" and "enforcing" are two different states here.
  // The caveat text itself is printed verbatim from `doctor.CODEX_TRUST_CAVEAT`
  // rather than paraphrased here: `installer/codex-trust-notice` asserts the
  // two match exactly, so the wording a developer reads after `install` can
  // never drift from the wording `doctor` keeps repeating.
  for (const a of written) {
    if (!a.codexTrustCaveat) continue;
    console.log("  2. Codex is installed but not yet enforcing anything:");
    // Never wrapped: `installer/codex-trust-notice` asserts this equals
    // `doctor.CODEX_TRUST_CAVEAT` verbatim, so the two can never drift apart
    // — see this function's own doc comment above.
    console.log(`     ${a.codexTrustCaveat}`);
  }

  if (written.length && !isSoftelaAiOnPath()) {
    // Built the same way doctor.js's own "run via:" line reads it off ctx —
    // <agentHome>/softela-ai/bin/softela-ai — never invented.
    console.log("");
    console.log('softela-ai is not on your PATH. Run it with:');
    // Never wrapped: a literal, copy-pasteable command — breaking it across
    // lines would corrupt the very thing this line exists to hand over.
    console.log(`  node "${path.join(written[0].home, "softela-ai", "bin", "softela-ai")}" <command>`);
    console.log('  or run "npm link" once, from the clone, for a global "softela-ai" command.');
  }
  console.log("");
}

/**
 * Runs `doctor`.
 *
 * @param {object} flags Parsed CLI flags.
 * @returns {{code: number, out: object}} The exit code and the report.
 */
function cmdDoctor(flags) {
  const agents = detect.resolveAgents(flags.agent);
  const report = doctor.buildReport(agents.length ? agents : ["claude", "codex"].filter((a) => paths.detectAgents().includes(a)));
  return { code: doctor.doctorExitCode(report), out: report };
}

/**
 * Runs `test`: the repository's own self-test suite, against this running
 * installation's own location.
 *
 * @returns {{code: number, out: object}} The child process's exit code and
 * a minimal summary; the suite's own output is streamed directly.
 */
function cmdTest() {
  const runner = path.join(paths.repoRoot(), "tests", "run.js");
  const result = spawnSync(process.execPath, [runner], { stdio: "inherit" });
  return { code: result.status === null ? 1 : result.status, out: { ranFrom: runner } };
}

/**
 * Runs `uninstall`: removes every manifest-tracked file that has not been
 * locally modified, this installer's `enforce` hook registrations, and the
 * managed instructions block — never `seed` settings, and never
 * `.softela-ai/overrides.json` or `.softela-ai/approvals.json`.
 *
 * @param {object} flags Parsed CLI flags.
 * @returns {{code: number, out: object}} `3` when a locally-modified file
 * was left in place rather than destroyed; `2` when nothing was installed;
 * `0` otherwise.
 */
function cmdUninstall(flags) {
  const agents = detect.resolveAgents(flags.agent);
  if (!agents.length) return { code: 2, out: { message: "No agent home found." } };

  const perAgent = [];
  let anySurvivors = false;
  let anyChange = false;

  for (const agent of agents) {
    // Same lock as install/update/module — uninstall reads the manifest and
    // then writes it and state.json, and that whole read-then-write must not
    // interleave with another run against the same agent.
    const result = manifestStore.withLock(agent, () => {
      const ctx = detect.gather(agent, { enabledModuleIds: [] });
      if (!ctx.manifest) {
        return { agent, installed: false };
      }

      const uninstallCtx = {
        ...ctx,
        files: detect.hashFiles(agent, [], ctx.manifest.files),
        enabledModules: [],
        manifest: ctx.manifest,
        version: ctx.manifest.version,
        now: Date.now(),
        // Uninstalling is a deliberate, explicit teardown of everything this
        // installer ever put down — never an inference from "is it still
        // shipped". Layer 2's prune guard exists only to stop an UPDATE from
        // misreading an incomplete source as an instruction to delete; it must
        // not also make uninstall leave files behind because the source
        // happens to be incomplete right now.
        unavailableAreas: [],
      };
      const actions = plan.buildUninstallPlan(uninstallCtx);

      let applied = null;
      if (!flags["dry-run"] && !planIsEmpty(actions)) {
        applied = apply.applyPlan(actions, uninstallCtx);
        manifestStore.writeManifest(agent, applied.manifest);
        stateStore.writeState(agent, stateStore.defaultState());
        // Not manifest-tracked, so `planFiles` never schedules its removal on
        // its own — without this, the `VERSION` marker (IMPORTANT I5) is the
        // one file left behind that keeps `softela-ai/` from ever pruning empty.
        removeIfExists(path.join(ctx.installedRoot, "VERSION"));
        apply.pruneEmptyDirs(ctx.installedRoot);
      }

      return { agent, installed: true, actions, applied, home: ctx.home };
    });

    if (result.actions && !planIsEmpty(result.actions)) anyChange = true;
    if (result.applied && result.applied.report.modifiedKept.length) anySurvivors = true;
    perAgent.push(result);
  }

  const code = anySurvivors ? 3 : anyChange ? 0 : 2;
  return { code, out: { agents: perAgent } };
}

/**
 * Prints the result of {@link cmdUninstall}.
 *
 * @param {{agents: object[]}} out Its result.
 * @param {object} flags Parsed CLI flags.
 * @returns {void}
 */
function printUninstall(out, flags) {
  const width = outputWidth();
  for (const a of out.agents) {
    console.log(`uninstall  ${a.agent}`);
    if (!a.installed) {
      console.log("  not installed");
      console.log("");
      continue;
    }
    const lines = renderPlan(a.actions, a.home, !!flags.verbose, width);
    if (!lines.length) console.log("  (nothing to remove)");
    else for (const line of lines) console.log(line);
    if (a.applied && a.applied.report.modifiedKept.length) {
      console.log(`  refused to delete (locally modified): ${a.applied.report.modifiedKept.join(", ")}`);
    }
    console.log("  state left in place: .softela-ai/overrides.json, .softela-ai/approvals.json, .softela-ai/backups/");
    console.log("");
  }
}

/**
 * Runs `approve <ruleId> [--minutes N]` or `approve --list`.
 *
 * @param {string[]} positional `[ruleId]` when granting.
 * @param {object} flags Parsed CLI flags.
 * @returns {{code: number, out: object}} `1` when a rule id was required
 * but not given; `0` otherwise.
 */
function cmdApprove(positional, flags) {
  const agents = detect.resolveAgents(flags.agent);

  if (flags.list) {
    const out = agents.map((agent) => ({ agent, approvals: approvals.list({ agent }) }));
    return { code: 0, out: { list: out } };
  }

  const ruleId = positional[0];
  if (!ruleId) return { code: 1, out: { message: "usage: softela-ai approve <ruleId> [--minutes N]" } };

  const minutes = flags.minutes ? Number(flags.minutes) : undefined;
  const results = agents.map((agent) => ({ agent, granted: approvals.grant(ruleId, minutes, { agent }) }));
  return { code: results.every((r) => r.granted) ? 0 : 1, out: { ruleId, minutes: minutes || approvals.DEFAULT_MINUTES, results } };
}

/**
 * Runs `module list|enable|disable [id]`.
 *
 * @param {string[]} positional `[action, id?]`.
 * @param {object} flags Parsed CLI flags.
 * @returns {{code: number, out: object}} The exit code and a summary; for
 * `enable`/`disable` this delegates to {@link runInstallOrUpdate} so
 * ownership and backups behave identically to `install`/`update`
 * (MODULES.md "Enabling and disabling").
 */
function cmdModule(positional, flags) {
  const action = positional[0];
  const id = positional[1];
  const allModules = detect.discoverModules();

  if (action === "list" || !action) {
    const agents = detect.resolveAgents(flags.agent);
    const perAgent = agents.map((agent) => ({ agent, enabled: stateStore.readState(agent).modules }));
    return {
      code: 0,
      out: { modules: allModules.map((m) => ({ id: m.id, title: m.json.title, summary: m.json.summary, defaultEnabled: !!m.json.defaultEnabled })), perAgent },
    };
  }

  if (action !== "enable" && action !== "disable") {
    return { code: 1, out: { message: `usage: softela-ai module <list|enable|disable> [id]` } };
  }
  if (!id) return { code: 1, out: { message: `usage: softela-ai module ${action} <id>` } };
  const targetModule = allModules.find((m) => m.id === id);
  if (!targetModule) {
    return { code: 1, out: { message: `unknown module "${id}". Known: ${allModules.map((m) => m.id).join(", ") || "(none shipped)"}` } };
  }
  // A module not enabled at the original install ships catalogue metadata
  // only (`module.json`/`README.md`) once the source clone is gone — its
  // id is discoverable, but there is nothing to actually install
  // (IMPORTANT I6). Say so plainly instead of silently registering hooks
  // that point at files which were never copied.
  if (action === "enable" && !detect.moduleAssetsAvailable(targetModule)) {
    return {
      code: 1,
      out: {
        message: `module "${id}" is known but only its catalogue metadata is installed here — enabling it needs the source repository (the softela-ai clone this installer was originally run from). Re-run "softela-ai module enable ${id}" from there.`,
      },
    };
  }

  const agents = detect.resolveAgents(flags.agent);

  // Reuse the install/update mechanic per agent so files, hooks and the
  // instructions block are added or removed through the same plan-then-apply
  // path, with the same backups. `__moduleOp` carries the enable/disable
  // request itself rather than a precomputed id list — `runInstallOrUpdate`
  // resolves it against a fresh, lock-protected read of state.json, so two
  // concurrent `module` invocations against the same agent each act on the
  // other's result instead of both computing their next set from the same
  // now-stale read taken before either one locked anything.
  const perAgent = [];
  let anyError = false;
  for (const agent of agents) {
    const flagsForAgent = { ...flags, agent, __moduleOp: { action, id } };
    const result = runInstallOrUpdate("update", flagsForAgent);
    perAgent.push(...result.out.agents);
    if (result.code === 1) anyError = true;
  }

  return { code: anyError ? 1 : 0, out: { action, id, agents: perAgent } };
}

/**
 * Runs `link [--repo <path>]`.
 *
 * @param {object} flags Parsed CLI flags.
 * @returns {{code: number, out: object}} `1` when the shipped template
 * could not be read; `0` otherwise.
 */
function cmdLink(flags) {
  const result = link.planLink({ repo: flags.repo });
  if (!result.ok) return { code: 1, out: { message: result.reason } };

  if (!flags["dry-run"]) link.applyLink(result);
  return { code: 0, out: result };
}

/**
 * Runs `override <ruleId> <off|ask|deny> --reason "<why>" [--project <id>]`,
 * `override --list`, or `override --undo`.
 *
 * Confirmation for the two writing modes (setting, undoing) is handled by
 * `main()` before this is called, exactly like `uninstall` — this function
 * itself only validates and delegates to `core/installer/override.js`.
 *
 * @param {string[]} positional `[ruleId, action]` when setting; unused for
 * `--list`/`--undo`.
 * @param {object} flags Parsed CLI flags.
 * @returns {{code: number, out: object}} `1` on a usage or validation error,
 * `2` when no agent home is targeted, `0` otherwise. `out.mode` is `"list"`,
 * `"undo"`, or `"set"`.
 */
function cmdOverride(positional, flags) {
  if (flags.list) {
    const agents = detect.resolveAgents(flags.agent);
    const perAgent = agents.map((agent) => ({ agent, overrides: override.listActive(agent) }));
    return { code: 0, out: { mode: "list", agents: perAgent } };
  }

  if (flags.undo) {
    const agents = detect.resolveAgents(flags.agent);
    if (!agents.length) return { code: 2, out: { message: "No agent home found. Pass --agent claude|codex." } };
    const perAgent = agents.map((agent) => ({ agent, ...override.undo(agent, { dryRun: !!flags["dry-run"] }) }));
    const anyFail = perAgent.some((a) => !a.ok);
    return { code: anyFail ? 1 : 0, out: { mode: "undo", dryRun: !!flags["dry-run"], agents: perAgent } };
  }

  const ruleId = positional[0];
  const action = positional[1];
  if (!ruleId || !action) {
    return {
      code: 1,
      out: { message: 'usage: softela-ai override <ruleId> <off|ask|deny> --reason "<why>" [--project <id>] [--agent claude|codex]' },
    };
  }

  const reason = typeof flags.reason === "string" ? flags.reason.trim() : "";
  const projectId = typeof flags.project === "string" && flags.project ? flags.project : null;

  const validation = override.validateSet({ ruleId, action, reason });
  if (!validation.ok) return { code: 1, out: { message: validation.message } };

  const agents = detect.resolveAgents(flags.agent);
  if (!agents.length) return { code: 2, out: { message: "No agent home found. Pass --agent claude|codex." } };

  const request = { ruleId, action, reason, projectId };
  if (flags["dry-run"]) {
    return { code: 0, out: { mode: "set", dryRun: true, request, agents } };
  }

  const results = agents.map((agent) => override.applySet(agent, request));
  return { code: 0, out: { mode: "set", request, results } };
}

/**
 * Prints the result of {@link cmdOverride}.
 *
 * @param {object} out Its result's `out` field.
 * @param {number} width The terminal width to wrap the `--list` mode's
 * developer-supplied reason into; every other mode's own lines are already
 * bounded and never need it.
 * @returns {void}
 */
function printOverride(out, width) {
  if (out.mode === "list") {
    for (const a of out.agents) {
      console.log(`${a.agent}:`);
      if (!a.overrides.length) {
        console.log("  none active");
        continue;
      }
      for (const o of a.overrides) {
        const detail = o.action ? `action=${o.action}` : o.allow ? `allow=${o.allow.length} pattern(s)` : "";
        const head = `${o.scope.padEnd(16)} ${o.ruleId.padEnd(28)} ${detail}`;
        // `reason` is free text a developer typed when setting the override
        // — the one field here with no bound on its length — so it is the
        // one wrapped under a hanging indent rather than left to overflow.
        const tail = [o.reason ? `— ${o.reason}` : "", o.setAt ? `(set ${o.setAt})` : ""].filter(Boolean).join("  ");
        const lines = tail ? renderAlignedRow(head, tty.displayWidth(head), tail, width) : wrapWithPrefix("  ", head, width);
        for (const line of lines) console.log(line);
      }
    }
    return;
  }

  if (out.mode === "undo") {
    for (const a of out.agents) {
      console.log(`${a.agent}:`);
      if (!a.ok) {
        console.log(`  ${a.reason}`);
        continue;
      }
      console.log(`  ${out.dryRun ? "would restore" : "restored"} from backup ${a.restoredFrom}`);
      if (!a.changes.length) console.log("  no difference from the current file");
      else for (const line of a.changes) console.log(`  ${line}`);
    }
    return;
  }

  if (out.mode === "set") {
    const { ruleId, action, reason, projectId } = out.request;
    console.log(`${out.dryRun ? "plan  " : ""}override ${ruleId} = ${action}  (${projectId ? `project:${projectId}` : "global"})`);
    console.log(`  reason: ${reason}`);
    if (out.dryRun) {
      console.log(`  would write for: ${out.agents.join(", ")}`);
      return;
    }
    for (const r of out.results) {
      console.log(`  ${r.agent}: written to ${r.file}`);
      if (r.malformed) console.log(`    note: the previous overrides.json was not valid JSON — its bytes were preserved in a backup and a fresh file was written`);
      if (r.backupsDir) console.log(`    backup: ${r.backupsDir}`);
    }
  }
}

/**
 * Prints any command's `{code, out}` result, honouring `--json`.
 *
 * @param {string} command The command that ran.
 * @param {{code: number, out: object}} result Its result.
 * @param {object} flags Parsed CLI flags.
 * @returns {void}
 */
function printResult(command, result, flags) {
  if (flags.json) {
    console.log(JSON.stringify(result.out, null, 2));
    return;
  }

  if (command === "test") {
    return; // tests/run.js already streamed its own output via stdio: "inherit"
  }

  if (command === "install" || command === "update") {
    printInstallOrUpdate(command, result.out, flags);
  } else if (command === "uninstall") {
    printUninstall(result.out, flags);
  } else if (command === "doctor") {
    for (const line of doctor.formatDoctorReport(result.out, outputWidth())) console.log(line);
  } else if (command === "module" && result.out.modules) {
    const width = outputWidth();
    const idWidth = Math.max(...result.out.modules.map((m) => m.id.length), 1);
    console.log("modules shipped:");
    for (const m of result.out.modules) {
      // The default marker rides in the label column rather than in its own,
      // so a summary that has to wrap still aligns under the summary and not
      // under the marker.
      const label = `${m.defaultEnabled ? "*" : " "} ${m.id}`;
      for (const line of renderAlignedRow(label, idWidth + 2, m.summary, width)) console.log(line);
    }
    for (const line of wrapWithPrefix("  ", "* = enabled by default on a first install; the per-agent line below is what is actually enabled right now.", width)) {
      console.log(line);
    }
    for (const a of result.out.perAgent) {
      for (const line of renderAlignedRow(`${a.agent}:`, idWidth + 2, a.enabled.length ? a.enabled.join(", ") : "(none enabled)", width)) {
        console.log(line);
      }
    }
  } else if (command === "module" && result.out.agents) {
    console.log(`module ${result.out.action} ${result.out.id}`);
    printInstallOrUpdate("update", { agents: result.out.agents }, flags);
  } else if (command === "link") {
    if (result.out.message) {
      console.log(result.out.message);
    } else {
      for (const a of result.out.actions) {
        console.log(`  ${a.action === "write" ? (a.state === "new" ? "+" : "~") : "="}   ${a.target}`);
      }
      console.log(`  ${result.out.note}`);
    }
  } else if (command === "approve" && result.out.list) {
    for (const a of result.out.list) {
      console.log(`${a.agent}:`);
      const live = a.approvals.filter((x) => x.live);
      if (!live.length) console.log("  none live");
      for (const x of live) console.log(`  ${x.ruleId}  until ${x.until}`);
    }
  } else if (command === "approve" && result.out.results) {
    for (const r of result.out.results) {
      console.log(r.granted ? `${r.agent}: approved "${result.out.ruleId}" for ${result.out.minutes} minute(s)` : `${r.agent}: failed to grant approval`);
    }
  } else if (command === "override" && result.out.mode) {
    printOverride(result.out, outputWidth());
  } else if (result.out && result.out.message) {
    console.log(result.out.message);
  } else {
    console.log(JSON.stringify(result.out, null, 2));
  }
}

/**
 * Prompts once for a yes/no answer on an interactive terminal.
 *
 * @param {string} question The prompt text.
 * @returns {Promise<boolean>} `true` for an answer starting with `y`;
 * `false` for anything else, including a non-TTY stdin, where the prompt is
 * skipped entirely rather than risking a hang.
 */
function promptYesNo(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y/i.test(answer.trim()));
    });
  });
}

/**
 * Runs the CLI.
 *
 * @param {string[]} argv The arguments after the program name.
 * @returns {Promise<number>} The process exit code (INSTALLER.md §2):
 * `0` success, `1` failure, `2` nothing to do, `3` refused because
 * something would have been destroyed.
 */
async function main(argv) {
  // These three short-circuit before the general parser runs at all: "-h"
  // and bare "help" are not "--"-prefixed, so parseArgs would otherwise read
  // either as a command name, not a request for the overview.
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    printOverview();
    return 0;
  }
  if (argv[0] === "--version") {
    console.log(detect.readVersion() || "unknown");
    return 0;
  }
  if (argv[0] === "help") {
    const target = argv[1];
    if (!target) {
      printOverview();
      return 0;
    }
    if (!COMMANDS[target]) {
      printUnknownCommand(target);
      return 1;
    }
    printCommandHelp(target);
    return 0;
  }

  const { command, positional, flags } = parseArgs(argv);

  // Flags only, no command word at all (e.g. "softela-ai --json") — same as no
  // arguments, not "unknown command undefined".
  if (command === undefined) {
    printOverview();
    return 0;
  }
  if (!COMMANDS[command]) {
    printUnknownCommand(command);
    return 1;
  }
  if (flags.help) {
    printCommandHelp(command);
    return 0;
  }
  if (flags.version) {
    console.log(detect.readVersion() || "unknown");
    return 0;
  }
  if (positional.length && !POSITIONAL_COMMANDS.has(command)) {
    printUnexpectedArgument(command, positional[0]);
    return 1;
  }
  const validation = validateFlags(command, flags);
  if (!validation.ok) {
    if (validation.kind === "unknown") printUnknownFlag(command, validation.flag);
    else printInvalidValue(command, validation.flag, validation.value, validation.choices);
    return 1;
  }

  let result;
  switch (command) {
    case "install": {
      // Only `install` — never `update` or `module enable`/`disable`, which
      // reuse `runInstallOrUpdate` for the same plan-then-apply mechanic but
      // are not the first-run configuration step this collects answers for.
      const installAgents = detect.resolveAgents(flags.agent);
      // Conflicts are resolved first — before the module-option questions —
      // so a developer who has to stop and go fix something never gets asked
      // unrelated questions first only to have the run refuse anyway.
      if (!(await applyConflictGate(installAgents, flags))) return 1;
      let answers;
      try {
        answers = await collectInteractiveAnswers(installAgents, flags);
      } catch (err) {
        if (!(err instanceof AbortedByDeveloper)) throw err;
        // Nothing has been written yet: `collectInteractiveAnswers` only
        // ever runs before `runInstallOrUpdate`'s own locked
        // read-modify-write, so returning here without ever calling it
        // leaves every agent home exactly as it was found.
        console.log("Aborted — nothing was written.");
        return 2;
      }
      result = runInstallOrUpdate("install", flags, answers);
      break;
    }
    case "update": {
      const updateAgents = detect.resolveAgents(flags.agent);
      if (!(await applyConflictGate(updateAgents, flags))) return 1;
      // Reuses the exact same interactive step `install` runs — a stored
      // configuration is just as reconfigurable from `update` as from a
      // second `install` (the developer asked for both).
      let updateAnswers;
      try {
        updateAnswers = await collectInteractiveAnswers(updateAgents, flags);
      } catch (err) {
        if (!(err instanceof AbortedByDeveloper)) throw err;
        console.log("Aborted — nothing was written.");
        return 2;
      }
      result = runInstallOrUpdate("update", flags, updateAnswers);
      break;
    }
    case "doctor":
      result = cmdDoctor(flags);
      break;
    case "test":
      result = cmdTest();
      break;
    case "uninstall":
      if (!flags.yes && !flags["dry-run"]) {
        const confirmed = await promptYesNo("Remove the softela-ai installation for the targeted agent(s)?");
        if (!confirmed && process.stdin.isTTY) {
          console.log("Aborted — pass --yes to skip this prompt.");
          return 2;
        }
      }
      result = cmdUninstall(flags);
      break;
    case "approve":
      result = cmdApprove(positional, flags);
      break;
    case "module":
      result = cmdModule(positional, flags);
      break;
    case "link":
      result = cmdLink(flags);
      break;
    case "override": {
      // Setting or undoing an override changes local enforcement, exactly
      // what §7's "with the developer's approval" is meant to gate — the
      // same confirm-unless-`--yes`-or-non-interactive shape `uninstall`
      // already uses. `--list` and `--dry-run` never write, so neither
      // prompts.
      const isWrite = !flags.list && !flags["dry-run"];
      if (isWrite && !flags.yes) {
        const question = flags.undo
          ? "Restore the most recent overrides.json backup?"
          : `Set override "${positional[0]}" = ${positional[1]} (reason: ${flags.reason || "(missing)"})?`;
        const confirmed = await promptYesNo(question);
        if (!confirmed && process.stdin.isTTY) {
          console.log("Aborted — pass --yes to skip this prompt.");
          return 2;
        }
      }
      result = cmdOverride(positional, flags);
      break;
    }
    default:
      // Unreachable: every key of COMMANDS is handled above, and anything
      // not a key of COMMANDS was already rejected before this switch.
      printUnknownCommand(command);
      return 1;
  }

  printResult(command, result, flags);
  return result.code;
}

module.exports = {
  main,
  parseArgs,
  renderPlan,
  symbolFor,
  COMMANDS,
  FLAG_DEFS,
  validateFlags,
  moduleRequiresClosure,
  resolveModuleSelection,
  loadReplyLanguageCatalogue,
};
