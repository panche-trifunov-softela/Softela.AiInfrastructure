"use strict";

/**
 * Protects this infrastructure's own installed files and its own approval
 * mechanism, at two different strengths that must never be blurred:
 *
 * - **ask** — a write to installed infrastructure (anything under the
 *   `softela-ai` root the installer manages) or to a host settings file
 *   (`~/.claude/settings.json`, `~/.codex/hooks.json`,
 *   `~/.codex/config.toml`). The reason instructs the agent to state exactly
 *   what it intends to change and why, and the developer approves or
 *   refuses.
 * - **deny** — an agent granting itself an approval: invoking
 *   `softela-ai approve`, or writing to the state directory's `approvals.json`
 *   or `overrides.json`, by any tool or any shell. Also denies deleting the
 *   state directory and changing its permissions. A demonstrably read-only
 *   `approve` invocation — `--list`, `--json`, `--help`/`-h`, `--agent` —
 *   grants nothing and is exempted; see {@link isReadOnlyApproveInvocation}.
 *
 * The deny half is the entire mechanism by which "approval" means a person:
 * a developer typing `softela-ai approve` in their own terminal never passes
 * through a hook, so the only way an approval can appear without one is a
 * tool call — and that is exactly what this half blocks.
 *
 * The deny half's checks are precise and statement-scoped, which a shell
 * evasion can defeat by splitting the recognisable words apart — a
 * parameter expansion, a brace expansion, an alias defined in one statement
 * and used in another. `evaluateRawShellConservative` backstops exactly
 * that: it reads the whole raw shell command as one blob, with no statement
 * or quote boundaries, and returns **ask** — not deny — when it finds the
 * tool's name paired with the self-unlock verb, or the state directory's
 * name paired with a destructive verb, anywhere in the text. It is
 * deliberately coarser and weaker than the deny half, trading some false
 * positives (a grep pattern, a commit message) for closing the gap a parser
 * cannot close by adding more patterns. It is skipped for a command that is
 * wholly read-only, and for the one shape that cannot run a shell, start a
 * process or change a file — see {@link isSealedReadOnlyNodeCommand}.
 *
 * Paths come from `lib/paths.js`, this system's own canonical locations, not
 * from a hard-coded literal here — the same distinction that keeps a product
 * repository's filenames out of guard code.
 */

const path = require("path");
const { builtinModules } = require("module");
const { ask, deny, pass } = require("../lib/decision");
const {
  splitStatements,
  splitTokens,
  hasCommand,
  hasFlag,
  extractQuoted,
  unwrapNestedShells,
} = require("../lib/shell-parse");
const { agentHome, installedRoot, stateDir, homeDir } = require("../lib/paths");

/** File-write tool names, across both hosts. */
const FILE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file)$/;

/** Shell tool names, across both hosts. */
const SHELL_TOOLS = /^(Bash|PowerShell|shell|local_shell|exec_command|shell_command)$/;

/** The union of both, for the rule's own `tools` filter. */
const ALL_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file|Bash|PowerShell|shell|local_shell|exec_command|shell_command)$/;

/** Invokes the approval CLI, however it is reached — directly, through `node`, or with an extension. */
const APPROVE_INVOCATION = "\\S*softela-ai(?:\\.\\w+)?\\s+approve";

/** Verbs that remove a file or directory, across shells. */
const REMOVE_VERBS = ["rm", "del", "erase", "rd", "rmdir", "Remove-Item"];

/** Verbs that change file or directory permissions, across shells. */
const PERMISSION_VERBS = ["chmod", "icacls", "attrib", "takeown"];

/**
 * Verbs that only read a file's contents, never write it — the narrow
 * exception carved out of the deny-by-default check below.
 */
const READ_ONLY_VERBS = ["cat", "type", "less", "more", "head", "tail", "Get-Content"];

/**
 * Verbs that change the current or pushed-directory location without
 * reading or writing anything themselves — {@link isWhollyReadOnlyCommand}'s
 * navigation exemption. Whatever a statement after one of these actually
 * does is judged independently, on its own merits, by that later statement.
 */
const NAVIGATION_VERBS = ["cd", "pushd", "popd", "Set-Location"];

/**
 * No-op verbs across shells — POSIX's `:` and `true`/`false` — whose only
 * effect is their own exit status. {@link isWhollyReadOnlyCommand}'s other
 * exemption alongside {@link NAVIGATION_VERBS}.
 */
const NOOP_VERBS = ["true", "false", ":"];

/** Either of the two files an approval could be granted through. */
const APPROVAL_FILENAME = /\b(approvals|overrides)\.json\b/i;

/**
 * The environment variable every path in this tool resolves through
 * (`lib/paths.js`). Setting it for the duration of a single command is
 * harmless: a hook runs in its own process and never inherits it. Setting it
 * so that it OUTLIVES the command is the one real way to disarm this rule
 * without touching a single protected file — every future hook process would
 * inherit it, and from then on `matchesRealStateDir` would be comparing
 * against a directory nobody's real infrastructure lives in.
 */
const HOME_OVERRIDE_VAR = /\bSOFTELA_AI_HOME\b/i;

/**
 * Mechanisms that write an environment variable somewhere it survives the
 * process that set it, and are themselves the write — no redirect needed:
 *
 * - Windows `setx`, which writes the user or machine environment directly;
 *
 * - .NET's `SetEnvironmentVariable`, whose `User` and `Machine` scopes
 *   persist (its `Process` scope does not, but a statement naming the API at
 *   all is close enough to the line to be worth stopping at);
 *
 * - `reg add` against the registry's `Environment` key, which is what `setx`
 *   does underneath and is equally persistent spelled by hand.
 */
const PERSISTENT_ENV_WRITERS = [/\bsetx\b/i, /SetEnvironmentVariable\s*\(/i, /\breg(?:\.exe)?\s+add\b[\s\S]*\bEnvironment\b/i];

/**
 * Shell startup files that re-export a variable into every future shell.
 * Naming one is not itself a write — `grep SOFTELA_AI_HOME ~/.bashrc` only
 * reads — so a statement matching this is only treated as persistence when
 * it also carries a genuine write (see {@link hasOutputRedirect}).
 */
const SHELL_STARTUP_FILE =
  /(\.bashrc|\.bash_profile|\.zshrc|\.zprofile|\.profile|\$PROFILE|Microsoft\.PowerShell_profile\.ps1)\b/i;

/**
 * Matches a shell or PowerShell output-redirect operator outside any quoted
 * region: `>`/`>>` (with an optional leading file-descriptor number, e.g.
 * `2>`), or a heredoc opener (`<<`, `<<-`, `<<~`).
 *
 * A `>`/`>>` immediately followed by `(` is excluded via the trailing
 * negative lookahead: that shape is `>( … )` process substitution —
 * `shell-parse.js`'s own grammar treats it as a grouping construct, never a
 * write — so `>(cat notes.txt)` must not be misread as "redirect into a
 * literal file named `(cat notes.txt)`". A genuine write occurring INSIDE
 * the substitution is not lost by this exclusion: `splitStatements` already
 * contributes that inner content as its own separate statement, which this
 * function is called against independently.
 */
const OUTPUT_REDIRECT_RE = /\d*>>?(?!\()|<<[-~]?/;

/**
 * A redirect whose destination is the platform's null device — `/dev/null`,
 * Windows' `NUL` (with or without a drive prefix), PowerShell's `$null`.
 *
 * Such a redirect writes nothing anywhere: it discards. Counting it as a
 * write is what made `cat approvals.json 2>/dev/null` — a read, with its
 * error output silenced — trip the deny half of this rule, because
 * {@link hasOutputRedirect} saw the `2>` operator and voided the read-only
 * verb exemption {@link READ_ONLY_VERBS} had just granted. Silencing stderr
 * is ordinary shell hygiene on a command that may legitimately fail, and a
 * rule that punishes it teaches the agent to write worse commands rather
 * than safer ones.
 *
 * Stripped from the masked statement before the operator test, rather than
 * excluded inside {@link OUTPUT_REDIRECT_RE} itself, so a statement carrying
 * BOTH a discard and a real redirect (`cat x 2>/dev/null > approvals.json`)
 * still has its real one found.
 */
const NULL_DEVICE_REDIRECT_RE = /\d*>>?\s*(?:[A-Za-z]:[\\/])?(?:\/dev\/null|NUL|\$null)\b/gi;

/**
 * PowerShell cmdlets that write their input to a file the way a Unix `>` or
 * `tee` would, rather than merely reading or displaying it.
 */
const WRITE_CMDLETS = ["Out-File", "Set-Content", "Add-Content"];

/**
 * Neutralises the contents of quoted regions, keeping the string the same
 * length and the quote characters themselves intact.
 *
 * A private copy of `shell-parse`'s own quote-masking, kept local because
 * this file may only touch its own module — it exists so a `>` that appears
 * inside a quoted argument (an ordinary message, a comparison in a filter
 * expression) is never mistaken for a real redirect operator.
 *
 * @param {string} str The raw text to mask.
 * @returns {string} The text with quoted contents replaced by a filler
 * character.
 */
function maskQuotedRegions(str) {
  const s = String(str || "");
  let out = "";
  let quote = null;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < s.length) {
        out += "\\#";
        i += 2;
        continue;
      }
      if (ch === quote) {
        out += ch;
        quote = null;
      } else {
        out += "#";
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Checks whether a statement genuinely writes rather than only reads:
 *
 * - an output redirect or heredoc opener outside any quoted region;
 * - a pipe into `tee`;
 * - a PowerShell write cmdlet (`Out-File`, `Set-Content`, `Add-Content`).
 *
 * This is what keeps the read-only-verb exemption below from being fooled by
 * `cat > file`, `Get-Content ... | tee file`, or `type ... | Set-Content
 * file` — the verb itself only reads, but the statement as a whole writes.
 *
 * @param {string} stmt A single shell statement.
 * @returns {boolean} `true` when the statement carries a genuine write.
 */
function hasOutputRedirect(stmt) {
  // A discard is not a write — see {@link NULL_DEVICE_REDIRECT_RE}. Removed
  // before the operator test so only redirects that land somewhere real are
  // left for it to find.
  const masked = maskQuotedRegions(stmt).replace(NULL_DEVICE_REDIRECT_RE, " ");
  if (OUTPUT_REDIRECT_RE.test(masked)) return true;
  if (hasCommand(stmt, "tee")) return true;
  return WRITE_CMDLETS.some((cmdlet) => hasCommand(stmt, cmdlet));
}

/**
 * Shell tools that follow POSIX/bash word-splitting rules, where an empty
 * quote pair (`''`) concatenates rather than producing a literal, and a
 * backslash before an ordinary character escapes it to that character.
 * PowerShell has neither convention — its backslash is a plain path
 * separator — so canonicalising a PowerShell statement the same way would
 * corrupt an ordinary Windows path instead of unmasking an evasion.
 */
const POSIX_SHELL_TOOLS = /^(Bash|shell|local_shell|exec_command|shell_command)$/;

/**
 * Escapes a literal string for safe embedding inside a regular expression.
 *
 * @param {string} text The literal text.
 * @returns {string} `text` with every regex-special character escaped.
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Shell/PowerShell spellings a real shell expands to the developer's own
 * home directory before a command ever runs — the only prefixes that make a
 * `.claude`/`.codex` segment right after them the developer's REAL host
 * home, as opposed to some other directory that merely happens to share
 * that name.
 */
const HOME_SHORTHAND_SOURCE = "~|\\$env:userprofile|%userprofile%|\\$userprofile|\\$home|\\$\\{home\\}|\\$env:home";

/**
 * Builds a regex source matching an absolute path's segments literally, with
 * either separator style and any run length between them, so the same
 * literal location is still recognised however a shell or a quoted script
 * literal happens to spell it — a doubled backslash inside a single-quoted
 * JS string, a forward slash substituted for a backslash, or the reverse.
 *
 * @param {string} absPath An absolute path this process itself computed.
 * @returns {string} A regex source matching that exact path, flexibly.
 */
function absolutePathToFlexibleRegexSource(absPath) {
  return String(absPath || "")
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(escapeRegExp)
    .join("[\\\\/]+");
}

/**
 * Converts one shell glob path segment into an anchored, whole-segment
 * regular expression: `*` becomes "zero or more characters", `?` becomes
 * "exactly one character", and every other character is matched literally —
 * the same reading a real shell gives that segment when it expands the glob
 * against files on disk.
 *
 * @param {string} glob A single path segment, e.g. `.softela*` or `.*`.
 * @returns {RegExp} A case-insensitive, `^…$`-anchored pattern.
 */
function globSegmentToRegExp(glob) {
  let source = "";
  for (const ch of String(glob || "")) {
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else source += escapeRegExp(ch);
  }
  return new RegExp(`^${source}$`, "i");
}

/**
 * Checks whether a statement's raw text is genuinely rooted at the real,
 * currently-resolved state directory for either host — recomputed on every
 * call, exactly like {@link selfApprovalFiles} below, because `SOFTELA_AI_HOME`
 * decides what "real" means and can differ between one evaluation and the
 * next (a fresh process per real dispatcher run; a scoped fixture home
 * inside a test).
 *
 * Matches either the full absolute state-directory path spelled out
 * literally (any separator style or run length), or a shell's own home
 * shorthand (`~`, `$env:USERPROFILE`, `$HOME`, …) immediately followed by
 * the host home name and `.softela-ai`. A directory that merely shares the
 * `.claude`/`.codex`/`.softela-ai` segment names without actually being rooted
 * at this resolved home — a disposable test fixture living under its own
 * scratch root, a decoy path — matches neither alternative and is correctly
 * left alone; see `SOFTELA_AI_HOME` in `lib/paths.js` for how a fixture
 * legitimately becomes "the real home" for a dispatcher run against it.
 *
 * @param {string} stmt A single statement's text.
 * @returns {boolean} `true` when the text targets the real state directory.
 */
function matchesRealStateDir(stmt) {
  const literalAlt = [stateDir("claude"), stateDir("codex")].map(absolutePathToFlexibleRegexSource).join("|");
  const hostHomeAlt = `${escapeRegExp(path.basename(agentHome("claude")))}|${escapeRegExp(path.basename(agentHome("codex")))}`;
  const stateDirBase = escapeRegExp(path.basename(stateDir("claude")));
  const shorthandAlt = `(?:${HOME_SHORTHAND_SOURCE})[\\\\/]+(?:${hostHomeAlt})[\\\\/]+${stateDirBase}\\b`;
  const re = new RegExp(`(?:${literalAlt})|(?:${shorthandAlt})`, "i");
  return re.test(stmt);
}

/**
 * Checks whether a statement carries a bare, cwd-relative reference to the
 * state directory — `rm -rf .softela-ai`, `Remove-Item .softela-ai` — that never
 * spells out the host home at all because the tool call's own working
 * directory already sits inside it. Requires `cwd` to literally be one of
 * the two real, currently-resolved agent homes; a fixture or unrelated
 * working directory that merely happens to contain a same-named subfolder
 * never qualifies.
 *
 * @param {string} stmt A single statement's text.
 * @param {string} cwd The tool call's working directory.
 * @returns {boolean} `true` when a bare `.softela-ai` reference, resolved
 * against `cwd`, is the real state directory for either host.
 */
function matchesStateDirRelativeToCwd(stmt, cwd) {
  if (!cwd) return false;
  if (![agentHome("claude"), agentHome("codex")].some((home) => samePath(cwd, home))) return false;
  const stateDirBase = escapeRegExp(path.basename(stateDir("claude")));
  const re = new RegExp(`(?:^|[\\s"'=(])(?:\\.[\\\\/])?${stateDirBase}(?=[\\s"')/\\\\]|$)`, "i");
  return re.test(stmt);
}

/**
 * Checks whether a statement's target, once the wildcard segment right after
 * the host home is expanded the way a real shell would, resolves to the
 * real state directory — `~/.claude/.softela*`, `~/.claude/.*` — the glob
 * spellings a literal `.softela-ai` substring check cannot see through. Requires
 * the same home anchor as {@link matchesRealStateDir}; a glob rooted
 * anywhere else never qualifies.
 *
 * @param {string} stmt A single statement's text.
 * @returns {boolean} `true` when the glob segment right after the host home
 * would, in a real shell, match `.softela-ai`.
 */
function matchesStateDirGlob(stmt) {
  const literalHomeAlt = [homeDir()].map(absolutePathToFlexibleRegexSource).join("|");
  const hostHomeAlt = `${escapeRegExp(path.basename(agentHome("claude")))}|${escapeRegExp(path.basename(agentHome("codex")))}`;
  const re = new RegExp(
    `(?:${HOME_SHORTHAND_SOURCE}|${literalHomeAlt})[\\\\/]+(?:${hostHomeAlt})[\\\\/]+([^\\\\/\\s"']*[*?][^\\\\/\\s"']*)`,
    "i",
  );
  const m = stmt.match(re);
  if (!m) return false;
  return globSegmentToRegExp(m[1]).test(path.basename(stateDir("claude")));
}

/**
 * Checks whether a statement targets the real state directory by any of the
 * three routes above: a literal or home-shorthand path, a bare reference
 * resolved against the tool call's own cwd, or a glob segment that would
 * expand to it in a real shell.
 *
 * @param {string} stmt A single statement's text.
 * @param {string} cwd The tool call's working directory.
 * @returns {boolean} `true` when the statement targets the real state
 * directory by any of those routes.
 */
function targetsStateDir(stmt, cwd) {
  return matchesRealStateDir(stmt) || matchesStateDirRelativeToCwd(stmt, cwd) || matchesStateDirGlob(stmt);
}

/**
 * The tool's own command name, matched anywhere in a raw command line with
 * no requirement that it sit at a command start — the coarse counterpart to
 * `APPROVE_INVOCATION` used only by {@link evaluateRawShellConservative}.
 */
const TOOL_NAME_RE = /\bsoftela-ai\b/i;

/**
 * The literal word that grants an approval, matched anywhere in raw text.
 * Word-bounded so it does not also catch "approved" or "approval", which
 * describe a state rather than perform the act.
 */
const SELF_UNLOCK_VERB_RE = /\bapprove\b/i;

/** The state directory's dotted name, matched as a plain substring anywhere in raw text. */
const STATE_DIR_NAME_RE = /\.softela-ai\b/i;

/**
 * Either host home directory's own dotted name (`.claude` / `.codex`, read
 * from `lib/paths.js`), matched as a plain substring anywhere in raw text —
 * the coarse counterpart to {@link matchesRealStateDir}'s home-anchoring.
 */
const HOST_HOME_NAME_RE = new RegExp(
  `(?:${escapeRegExp(path.basename(agentHome("claude")))}|${escapeRegExp(path.basename(agentHome("codex")))})\\b`,
  "i",
);

/**
 * Every verb from {@link REMOVE_VERBS} and {@link PERMISSION_VERBS}, as one
 * word-bounded alternation, matched anywhere in raw text rather than only at
 * a parsed command start.
 */
const DESTRUCTIVE_VERB_RE = new RegExp(
  `\\b(?:${[...REMOVE_VERBS, ...PERMISSION_VERBS].map(escapeRegExp).join("|")})\\b`,
  "i",
);

/**
 * Approximates how a POSIX shell reconstructs a word before running it:
 * drops an empty quote pair (`a''pprove` → `approve`) and collapses a
 * backslash escaping an ordinary character to that character
 * (`appro\ve` → `approve`). A raw substring match cannot see through either
 * construct, but the shell itself does.
 *
 * A genuinely quoted region — one with real content between the quotes, such
 * as a Windows path passed as a single argument — is copied through
 * untouched: neither its backslashes nor its quote characters are shell
 * escape syntax, so collapsing them would corrupt the path rather than
 * unmask an evasion.
 *
 * @param {string} stmt A single shell statement.
 * @returns {string} The statement with quote-splitting and
 * backslash-splitting collapsed outside of quoted regions.
 */
function canonicalizePosixWord(stmt) {
  const str = String(stmt || "");
  let out = "";
  let i = 0;
  while (i < str.length) {
    const ch = str[i];

    if ((ch === "'" || ch === '"') && str[i + 1] === ch) {
      i += 2; // empty pair: bash drops both characters and concatenates
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < str.length && str[i] !== quote) {
        if (str[i] === "\\" && quote === '"' && i + 1 < str.length) {
          out += str[i] + str[i + 1];
          i += 2;
          continue;
        }
        out += str[i];
        i += 1;
      }
      if (i < str.length) {
        out += str[i];
        i += 1;
      }
      continue;
    }

    if (ch === "\\" && /[A-Za-z0-9]/.test(str[i + 1] || "")) {
      out += str[i + 1];
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Normalises a path for comparison: `.` and `..` segments resolved, forward
 * slashes, lower case, no trailing slash.
 *
 * Segment resolution goes through `path.win32`, not the platform-default
 * `path` module, because the input is text a tool call supplied — possibly
 * with forward slashes even on Windows, or a mix of both — not a path this
 * process itself constructed. `path.win32` accepts either separator and
 * resolves `..` against the drive root without escaping it, which is exactly
 * what stops `<stateDir>/subdir/../overrides.json` from comparing unequal to
 * the canonical `<stateDir>/overrides.json`.
 *
 * @param {string} p The path to normalise.
 * @returns {string} The normalised path, or `""` for anything falsy.
 */
function normalize(p) {
  const raw = String(p || "");
  if (!raw) return "";
  return path.win32.normalize(raw).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}

/**
 * Checks whether a path sits at or under a directory.
 *
 * @param {string} filePath The path to check.
 * @param {string} dir The candidate ancestor directory.
 * @returns {boolean} `true` when `filePath` equals `dir` or is nested under it.
 */
function isUnderDir(filePath, dir) {
  const f = normalize(filePath);
  const d = normalize(dir);
  if (!f || !d) return false;
  return f === d || f.startsWith(`${d}/`);
}

/**
 * Checks whether two paths refer to the same file.
 *
 * @param {string} filePath The path to check.
 * @param {string} target The path it might match.
 * @returns {boolean} `true` when both normalise to the same string.
 */
function samePath(filePath, target) {
  const f = normalize(filePath);
  return Boolean(f) && f === normalize(target);
}

/**
 * Lists the installed-infrastructure roots the installer owns, for both hosts.
 *
 * @returns {string[]} `<agentHome>/softela-ai` for `claude` and for `codex`.
 */
function installedRoots() {
  return [installedRoot("claude"), installedRoot("codex")];
}

/**
 * Lists the host settings files a write to must be approved.
 *
 * @returns {string[]} Claude's `settings.json`, Codex's `hooks.json` and
 * `config.toml`.
 */
function hostSettingsFiles() {
  return [
    path.join(agentHome("claude"), "settings.json"),
    path.join(agentHome("codex"), "hooks.json"),
    path.join(agentHome("codex"), "config.toml"),
  ];
}

/**
 * Lists the files a write to grants an approval outright, for both hosts.
 *
 * @returns {string[]} Each host's `approvals.json` and `overrides.json`.
 */
function selfApprovalFiles() {
  return [
    path.join(stateDir("claude"), "approvals.json"),
    path.join(stateDir("claude"), "overrides.json"),
    path.join(stateDir("codex"), "approvals.json"),
    path.join(stateDir("codex"), "overrides.json"),
  ];
}

/**
 * Evaluates a file-write tool call against both protections.
 *
 * @param {object} ctx The evaluation context.
 * @returns {null | {action: string, reason: string, fix: string}} `deny` on
 * a write to `approvals.json`/`overrides.json`; `ask` on a write under
 * installed infrastructure or a host settings file; `pass` otherwise.
 */
function evaluateFileWrite(ctx) {
  const filePath = ctx.filePath || "";
  if (!filePath) return pass();

  if (selfApprovalFiles().some((target) => samePath(filePath, target))) {
    return deny(
      "INFRA SELF-PROTECTION: a write to the approvals or overrides file grants an approval from inside a tool call. Approval means a person, so this only happens from the developer's own terminal.",
      "Ask the developer to make this change themselves.",
    );
  }

  // The write-tool counterpart of `redirectsInfrastructureHome`: a shell
  // startup file is not infrastructure this tool owns, so nothing else here
  // looks at it — but a line exporting SOFTELA_AI_HOME into one repoints every
  // path this rule resolves, for every future hook process.
  // R3 decision: kept on ctx.content, not resultingContent — this denies the
  // WRITE that introduces the override line. An override already sitting in
  // a shell startup file from before this rule existed, untouched by a
  // later unrelated edit, is not what this deny should keep re-firing on.
  if (SHELL_STARTUP_FILE.test(filePath) && HOME_OVERRIDE_VAR.test(ctx.content || "")) {
    return deny(
      "INFRA SELF-PROTECTION: this writes SOFTELA_AI_HOME into a shell startup file, repointing every path this infrastructure resolves — including the state directory this rule protects — for every future hook process.",
      "Do not persist SOFTELA_AI_HOME from a tool call.",
    );
  }

  const touchesInstalled = installedRoots().some((root) => isUnderDir(filePath, root));
  const touchesSettings = hostSettingsFiles().some((target) => samePath(filePath, target));
  if (touchesInstalled || touchesSettings) {
    return ask(
      "INFRA SELF-PROTECTION: this writes to infrastructure the installer owns. State exactly what is about to change and why before the developer approves it.",
      "Describe the intended change, then wait for the developer's approval.",
    );
  }

  return pass();
}

/*
 * The deny half's read-only test for an inline interpreter script is strictly
 * ADDITIVE over the test this file used before the per-language lists
 * ({@link isInlineReadOnlyScript}): the old condition is kept exactly and the
 * detections below are only ever added on top of it, so nothing the old test
 * refused can pass now. The recognisers, the old write net and the per-language
 * detections that make up the deny half sit in this section; what only the
 * sealed exception additionally refuses sits apart, under
 * {@link isSealedReadOnlyNodeCommand}.
 */

/**
 * Recognises an interpreter told to run a single inline script — `node -e`
 * or `node --eval`, `python -c` or `python3 -c` — wherever it sits in a
 * statement. This is the recogniser the old read-only test used, kept
 * exactly: whatever it recognised, {@link isInlineReadOnlyScript} still
 * recognises, so that test can only ever refuse more.
 */
const NODE_INLINE_FLAG_RE = /\bnode(?:\.exe)?\s+(?:-\S+\s+)*(?:-e|--eval)\b/i;

/** The `python`/`python3 -c` counterpart to {@link NODE_INLINE_FLAG_RE}. */
const PYTHON_INLINE_FLAG_RE = /\bpython3?(?:\.exe)?\s+(?:-\S+\s+)*-c\b/i;

/**
 * The wider Node recogniser {@link hasRemoveAction} adds to
 * {@link NODE_INLINE_FLAG_RE}: `-p`, `--print` and the combined `-pe`/`-ep`
 * as well. Recognising more is the strict direction for a removal test; it is
 * never used to decide that a statement only reads.
 */
const NODE_PRINT_INLINE_FLAG_RE = /\bnode(?:\.exe)?\s+(?:-\S+\s+)*(?:-e|--eval|-p|--print|-pe|-ep)\b/i;

/**
 * Reads the inline script one recogniser finds in a statement, together with
 * what surrounds its quotes, so the shell's own reading of that quoting can
 * be checked too.
 *
 * @param {string} stmt A single statement's text.
 * @param {RegExp} nodeRe The Node recogniser to use; Python's is fixed.
 * @returns {null | {language: "node" | "python", script: string | null, raw: string, quote: string, after: string, start: number, end: number}}
 * The interpreter, the script's source text (`null` when no quoted script
 * follows the flag), the script as written between its quotes, the quote
 * character it was wrapped in, the character right after its closing quote,
 * where the invocation starts and where its quoted script ends; `null` when
 * the statement holds no such interpreter invocation.
 */
function inlineScriptOf(stmt, nodeRe) {
  const language = nodeRe.test(stmt) ? "node" : PYTHON_INLINE_FLAG_RE.test(stmt) ? "python" : null;
  if (language === null) return null;

  const flagRe = language === "node" ? nodeRe : PYTHON_INLINE_FLAG_RE;
  const script = extractQuoted(stmt, flagRe);
  const quoted = new RegExp(`(?:${flagRe.source})\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`, "i").exec(stmt);
  if (script === null || quoted === null) return { language, script: null, raw: "", quote: "", after: "", start: 0, end: 0 };

  const end = quoted.index + quoted[0].length;
  const raw = quoted[1] === undefined ? quoted[2] : quoted[1];

  return { language, script, raw, quote: quoted[0][quoted[0].length - 1], after: stmt[end] || "", start: quoted.index, end };
}

/**
 * Lists every inline script a removal check should read: the one the old
 * recogniser finds and the one the wider recogniser finds, which may be the
 * same.
 *
 * @param {string} stmt A single statement's text.
 * @returns {string[]} The scripts' source texts.
 */
function inlineScriptsForRemoval(stmt) {
  return [NODE_INLINE_FLAG_RE, NODE_PRINT_INLINE_FLAG_RE]
    .map((re) => inlineScriptOf(stmt, re))
    .filter((found) => found !== null && found.script !== null)
    .map((found) => found.script);
}

/** A shell comment's start: a `#` at the beginning of a word. */
const SHELL_COMMENT_START_RE = /(?:^|[\s;&|(])#/;

/** The `NAME=` that opens a leading assignment word, after any whitespace. */
const LEADING_ASSIGNMENT_RE = /^(\s*)([A-Za-z_]\w*=)/;

/**
 * Cuts an unquoted shell comment — a `#` that starts a word outside quotes —
 * off the end of a statement, so words inside a comment are not read as the
 * command. Quoted regions are found with the same position-keeping masking
 * the redirect test uses.
 *
 * @param {string} stmt A single statement's text.
 * @returns {string} The statement without its trailing comment.
 */
function cutShellComment(stmt) {
  const found = SHELL_COMMENT_START_RE.exec(maskQuotedRegions(stmt));
  if (found === null) return stmt;

  return stmt.slice(0, found.index + found[0].length - 1);
}

/**
 * Measures one shell word's length from its start: up to the first unquoted
 * whitespace, a backslash or a quote taking the next character or the whole
 * quoted run with it. An unterminated quote runs to the end.
 *
 * @param {string} text The text starting at the word.
 * @returns {number} The word's length in characters.
 */
function shellWordLength(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "\\") {
      i += 1;
    } else if (/\s/.test(ch)) {
      return i;
    }
  }

  return text.length;
}

/**
 * Keeps only the command substitutions — `$( … )` and backtick spans — of a
 * leading assignment's value: those really run, so a script inside one is
 * still a script; the rest of the value is only text. A single-quoted value
 * holds no substitution at all.
 *
 * @param {string} value An assignment's value, as written.
 * @returns {string} The substitution spans, joined with spaces.
 */
function assignmentSubstitutions(value) {
  if (value.startsWith("'")) return "";

  let kept = "";
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "`") {
      const close = value.indexOf("`", i + 1);
      const stop = close === -1 ? value.length : close + 1;
      kept += `${value.slice(i, stop)} `;
      i = stop - 1;
    } else if (value[i] === "$" && value[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < value.length; j += 1) {
        if (value[j] === "(") depth += 1;
        else if (value[j] === ")" && (depth -= 1) === 0) break;
      }
      kept += `${value.slice(i, j + 1)} `;
      i = j;
    }
  }

  return kept;
}

/**
 * Blanks the value of every leading `NAME=value` assignment word, keeping
 * only what runs inside it ({@link assignmentSubstitutions}), so an
 * interpreter named in an assigned string (`X="node -e 'x'" cp a b`) is not
 * mistaken for the command that runs.
 *
 * @param {string} stmt A single statement's text.
 * @returns {string} The statement with its leading assignments' values blanked.
 */
function blankLeadingAssignments(stmt) {
  let rest = stmt;
  let out = "";
  for (let m = LEADING_ASSIGNMENT_RE.exec(rest); m; m = LEADING_ASSIGNMENT_RE.exec(rest)) {
    const after = rest.slice(m[0].length);
    const length = shellWordLength(after);
    out += `${m[1]}${m[2]}${assignmentSubstitutions(after.slice(0, length))}`;
    rest = after.slice(length);
  }

  return out + rest;
}

/**
 * Prepares a statement for the read-only recogniser: without its trailing
 * comment and without the text of its leading assignments' values. Both only
 * ever take text away, so a statement can only stop being recognised, never
 * start to be.
 *
 * @param {string} stmt A single statement's text.
 * @returns {string} The statement as the command it actually runs.
 */
function stripForRecognition(stmt) {
  return blankLeadingAssignments(cutShellComment(stmt));
}

/**
 * The `process.stdout.write(` / `process.stderr.write(` call of a Node
 * script — output to a stream, never a file. Only the sealed exception
 * ({@link isSealedReadOnlyNodeCommand}) removes it before it reads the rest
 * for a `write` call; the deny half does not, so a script that writes to
 * standard output is no more "read-only" than the old test found it.
 */
const NODE_STD_WRITE_RE = /(?<![.\w$])process\s*\.\s*std(?:out|err)\s*\.\s*write\s*\(/g;

/**
 * The inline-script write test this file used before the per-language lists,
 * kept verbatim. {@link isInlineReadOnlyScript} applies it first, to the
 * unmodified script, as half of the old condition; the per-language tests
 * apply it again, so that anything calling them directly gets the same net —
 * it catches spellings the lists below do not name, such as an aliased
 * destructuring (`{writeFileSync:w}`) or an `open(` whose mode is a raw
 * string.
 */
const LEGACY_INLINE_WRITE_RE =
  /writefilesync|writefile\s*\(|createwritestream|appendfile|\.write\s*\(|open\([^)]*['"][wax]['"]/i;

/**
 * File-changing `fs` names with a `Sync` form. Each is an unambiguous word:
 * {@link NODE_LONG_NAME_RE} denies the `Sync` form of every one anywhere in a
 * script, and {@link NODE_API_POSITION_RES} the bare form in an API position.
 */
const NODE_SYNC_CHANGE_NAMES = [
  "writeFile", "appendFile", "copyFile", "rename", "truncate", "ftruncate", "symlink", "link", "unlink", "rmdir",
  "mkdir", "chmod", "lchmod", "fchmod", "chown", "lchown", "fchown", "utimes", "lutimes", "futimes", "write",
  "writev", "cp", "rm",
];

/**
 * Names that change a file whether or not they appear in an API position —
 * as a whole JavaScript identifier, in code, a string or a regular expression
 * alike: every {@link NODE_SYNC_CHANGE_NAMES} entry with `Sync`, the
 * promise-style `writeFile`, `appendFile`, `copyFile` and `writev`, any
 * `*WriteStream` and `mkdtemp*`, and the rarer `Utf8Stream`,
 * `writeHeapSnapshot` and `writeReport`. Case-sensitive, as Node is. The
 * name ends where an identifier does: a `$` that is a regular expression's
 * end anchor (`/^rmSync$/`) does not extend it.
 */
const NODE_LONG_NAME_RE = new RegExp(
  `(?<![\\w$])(?:(?:${NODE_SYNC_CHANGE_NAMES.join("|")})Sync|writeFile|appendFile|copyFile|writev|\\w*WriteStream|mkdtemp\\w*|Utf8Stream|writeHeapSnapshot|writeReport)(?!\\w|\\$[\\w$])`,
);

/**
 * An options key `flag`/`flags`, bare or quoted, whose value is a quoted mode
 * that can write (`w`, `a`, `wx`, `as`, `r+`, `rs+`), or an `O_*` open-flag
 * constant that can: either turns a read call into a truncating or appending
 * write (`readFileSync(p, {flag:"w"})`). A key holding `"r"`, or a value that
 * is not a literal, is not counted here; the sealed exception refuses the word
 * `flag` outright instead.
 */
const NODE_MODE_OPTION_RE =
  /(?<![\w$])['"`]?flags?['"`]?\s*:\s*(['"`])(?:[wa][xs]?\+?|rs?\+)\1|(?<![\w$])O_(?:WRONLY|RDWR|TRUNC|APPEND|CREAT|EXCL)(?![\w$])/;

/** The `fs` names that change a file in an API position, each with an optional `Sync`: {@link NODE_API_POSITION_RES}. */
const NODE_API_NAMES = [
  "unlink", "rename", "rmdir", "mkdir", "mkdtemp", "chmod", "lchmod", "fchmod", "chown", "lchown", "fchown",
  "truncate", "ftruncate", "symlink", "utimes", "lutimes", "futimes", "writeFile", "appendFile", "copyFile", "cp",
  "rm", "link", "write", "writev", "open",
];

/** One alternation of {@link NODE_API_NAMES}, each with an optional `Sync`. */
const NODE_API_NAME = `(?:${NODE_API_NAMES.join("|")})(?:Sync)?`;

/** The same alternation without the three generic words `link`, `open` and `write`, which are also common data keys. */
const NODE_API_NAME_SPECIFIC = `(?:${NODE_API_NAMES.filter((n) => !["link", "open", "write"].includes(n)).join("|")})(?:Sync)?`;

/** The same alternation without `open`, whose calls are read for their mode instead: {@link nodeOpensForWriting}. */
const NODE_API_NAME_NO_OPEN = `(?:${NODE_API_NAMES.filter((n) => n !== "open").join("|")})(?:Sync)?`;

/**
 * Builds the loose test for a destructuring or import list that holds one of
 * the given names, in ANY position: one brace pair with no nested braces, the
 * name bare or as a quoted key, followed by what ends a binding — `=`, `=>`,
 * `)`, `,`, `of`, `from`, or the `}` or `]` that closes a nested or
 * array-wrapped pattern (`{promises:{rm:r}}`, `[{rm:r}]`). Only the sealed
 * exception uses it: the deny half asks for a binding position, see
 * {@link bindingDestructuringRes}.
 *
 * @param {string} names A regular expression source matching the names.
 * @returns {RegExp} The test.
 */
function looseDestructuringRe(names) {
  return new RegExp(
    `\\{[^{}]*(?<![\\w$.])(['"\`]?)${names}\\1(?![\\w$])[^{}]*\\}\\s*(?:=(?![=>])|=>|\\)|,|of\\b|from\\b|\\}|\\])`,
  );
}

/** One element of a brace pattern: any character but a brace, or one nested brace pair. */
const BRACE_PATTERN_ITEM = "(?:[^{}]|\\{[^{}]*\\})";

/**
 * Builds the deny half's tests for a destructuring or import list that holds
 * one of the given names, found only where a binding is written, so an
 * object literal or a function body that merely holds a local of that name
 * never matches. The brace pattern (one level of nesting allowed inside, the
 * name bare or a quoted key) must follow:
 *
 * - `const`, `let` or `var`, optionally through an array pattern, and be
 *   followed by `=` (not `==` or `=>`) or `of`;
 * - an `import` keyword, and be followed by `from`;
 * - a `(` or `,` that opens a parameter, and be followed by the end of the
 *   parameter list and `=>` or a function body;
 * - the start of a statement or a `(`, and be followed by `=`.
 *
 * @param {string} names A regular expression source matching the names.
 * @returns {RegExp[]} The tests, one per binding position.
 */
function bindingDestructuringRes(names) {
  const name = `(?<![\\w$.])(?:"${names}"|'${names}'|\`${names}\`|${names}(?![\\w$]))`;
  const pattern = `\\{${BRACE_PATTERN_ITEM}*?(?:${name}|\\{[^{}]*?${name}[^{}]*\\})${BRACE_PATTERN_ITEM}*\\}`;

  return [
    new RegExp(`(?<=\\b(?:const|let|var)\\s*(?:\\[\\s*)?)${pattern}\\s*(?:\\]\\s*)?(?:=(?![=>])|of\\b)`),
    new RegExp(`(?<=\\bimport\\s*(?:[\\w$]+\\s*,\\s*)?)${pattern}\\s*from\\b`),
    new RegExp(`(?<=[(,]\\s*)${pattern}[^()]*\\)\\s*(?:=>|\\{)`),
    new RegExp(`(?<=(?:^|[;(\\n])\\s*)${pattern}\\s*=(?![=>])`),
  ];
}

/**
 * A short file-changing name in an API position, never merely as a word in
 * data — a shell verb inside a regular expression or a string
 * (`/\b(mkdir|rm )/`, `/x|mkdir(\s)/`), or a data field (`o.rules.mkdir`),
 * sits in none of them:
 *
 * - a member call (`fs.rm(`, `fs.unlink (`); a bare call is not counted, as it
 *   needs a binding that the destructuring tests below already show;
 * - a name handed to `promisify` (`util.promisify(fs.rm)`);
 * - a bracket string of an `fs`-specific name (`fs["rmSync"]`), in any of the
 *   three quotes; the generic `link`, `open` and `write` are common keys
 *   (`o.rules["write"]`) and are not counted.
 *
 * A short name held in a string and used one step later (`const m = "rm";
 * fs[m](p)`) is not recognised, as the old test did not recognise it.
 */
const NODE_API_POSITION_RES = [
  new RegExp(`\\.\\s*${NODE_API_NAME_NO_OPEN}\\s*\\(`),
  new RegExp(`\\bpromisify\\s*\\(\\s*[\\w$.\\s]*?\\.\\s*${NODE_API_NAME_SPECIFIC}(?![\\w$])`),
  new RegExp(`\\[\\s*(['"\`])${NODE_API_NAME_SPECIFIC}\\1\\s*\\]`),
];

/** A destructuring or import of an `fs`-specific short name, in a position where a binding is written. */
const NODE_BINDING_RES = bindingDestructuringRes(NODE_API_NAME_SPECIFIC);

/**
 * Shapes that hide a name from the tests above, found on the script with its
 * string and template text blanked ({@link blankJsStrings}) so that a label
 * such as `"x.//y"` or `"rules with (any) expiry"` is not one: a comment
 * right after a member dot, and a `with (` scope.
 */
const NODE_TEXTUAL_RES = [/\.\s*(?:\/[*/]|<!--|-->)/, /(?<![\w$.])with\s*\(/];

/**
 * Blanks the text of every JavaScript string and template literal, keeping
 * the delimiters, comments and code — a template placeholder (`${…}`) is code
 * and is kept. A string ends at its closing quote or, unterminated, at the end
 * of its line, so a stray quote inside a regular expression cannot swallow
 * more than that line.
 *
 * @param {string} text A Node script's source text.
 * @returns {string} The script with string and template text replaced by spaces.
 */
function blankJsStrings(text) {
  const resume = [];
  let out = "";
  let inTemplate = false;
  let depth = 0;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inTemplate) {
      if (ch === "\\") {
        out += "  ";
        i += 2;
      } else if (ch === "`") {
        out += ch;
        inTemplate = false;
        i += 1;
      } else if (ch === "$" && next === "{") {
        out += "${";
        resume.push(depth);
        depth += 1;
        inTemplate = false;
        i += 2;
      } else {
        out += ch === "\n" ? ch : " ";
        i += 1;
      }
      continue;
    }

    if (ch === "/" && (next === "/" || next === "*")) {
      const close = text.indexOf(next === "/" ? "\n" : "*/", i + 2);
      const end = close === -1 ? text.length : close + (next === "/" ? 0 : 2);
      out += text.slice(i, end);
      i = end;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      out += ch + " ".repeat(Math.max(0, Math.min(j, text.length) - i - 1)) + (text[j] === ch ? ch : "");
      i = text[j] === ch ? j + 1 : j;
    } else if (ch === "`") {
      out += ch;
      inTemplate = true;
      i += 1;
    } else {
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        inTemplate = resume.length > 0 && resume[resume.length - 1] === depth;
        if (inTemplate) resume.pop();
      }
      out += ch;
      i += 1;
    }
  }

  return out;
}

/**
 * Modules that run code the guard cannot read, start a process, or create a
 * database file (`sqlite`): `require`, a dynamic `import(` or a static
 * `import … from` of one of them, with or without a sub-path, is other code.
 */
const NODE_CODE_MODULE_RE =
  /(?:\brequire\s*\(\s*|\bimport\s*\(\s*|\bfrom\s*)(['"`])(?:node:)?(?:vm|child_process|worker_threads|cluster|inspector|module|repl|wasi|sqlite)(?:\/[\w-]+)*\1/;

/** The built-in modules that are global names in `node -e` and run other code or a process. */
const NODE_CODE_GLOBAL_NAMES = "vm|cluster|inspector|repl|v8|wasi|trace_events";

/**
 * Those globals in a position that uses them — an object, a call or a spread
 * (`vm.runInThisContext(…)`, `cluster.fork()`, `{...v8}`) — and never as a bare
 * word: a loop variable, a label or a string (`"cluster"`, `"v8"`) or a home
 * folder such as `dev-vm` is not one. A name after a single dot is a data
 * field; a spread's three dots are not.
 */
const NODE_CODE_GLOBAL_RES = [
  new RegExp(`(?<![\\w$])(?<!(?:^|[^.])\\.)(?:${NODE_CODE_GLOBAL_NAMES})\\s*(?:\\?\\.|\\.|\\[|\\()`),
  new RegExp(`\\.\\.\\.\\s*(?:${NODE_CODE_GLOBAL_NAMES})(?![\\w$])`),
];

/** A `require` call with exactly one plain module-name literal — no path, no dot — and nothing else inside. */
const NODE_PLAIN_REQUIRE_RE = /\brequire\s*\(\s*(['"`])(?:node:)?[A-Za-z_][\w-]*(?:\/[\w-]+)*\1\s*\)/g;

/** A `require` of one literal whose value ends in `.json`, which Node parses as data and never runs. */
const NODE_JSON_REQUIRE_RE = /\brequire\s*\(\s*(['"`])[^'"`\n]*\.json\1\s*\)/g;

/** A `require` written with a space before its parenthesis and a literal argument: a prose string such as `"require (n)"` has none. */
const NODE_SPACED_LITERAL_REQUIRE_RE = /\brequire\s+\(\s*['"`]/;

/**
 * A dynamic `import(` of one built-in module name, with the same shape a plain
 * `require` has: no path, no dot, an optional `node:` prefix and `/sub` path.
 * The modules that run code are refused separately, by {@link NODE_CODE_MODULE_RE}.
 */
const NODE_PLAIN_IMPORT_RE = /(?<![\w$.])import\s*\(\s*(['"`])(?:node:)?[A-Za-z_][\w-]*(?:\/[\w-]+)*\1\s*\)/g;

/** Direct ways to run code the guard never read, or to start a process. */
const NODE_OTHER_CODE_RES = [
  /child_process|worker_threads/,
  /(?<![\w$])eval\s*\(/,
  /\bnew\s+Function\b|(?<![\w$.])Function\s*\(/,
  /\bprocess\s*\.\s*(?:binding|_linkedBinding|dlopen|getBuiltinModule)\b/,
  /\bmodule\s*\.\s*require\b/,
  NODE_CODE_MODULE_RE,
  ...NODE_CODE_GLOBAL_RES,
];

/**
 * Checks whether a Node script can run code the guard never read or start a
 * process: one of {@link NODE_OTHER_CODE_RES}; a `require(` — written without
 * a space — of anything but one plain module-name literal or one `.json`
 * literal (`require("/tmp/w.js")`, `require("./x")` and `require(name)` all
 * load code from outside the text), or written with a space before a literal
 * that is not plain; or an `import(` of anything but one plain built-in.
 *
 * @param {string} text A Node script's source text.
 * @returns {boolean} `true` when the script may run other code.
 */
function nodeRunsOtherCode(text) {
  if (NODE_OTHER_CODE_RES.some((re) => re.test(text))) return true;

  const requires = text.replace(NODE_PLAIN_REQUIRE_RE, " ").replace(NODE_JSON_REQUIRE_RE, " ");
  if (/\brequire\(/.test(requires) || NODE_SPACED_LITERAL_REQUIRE_RE.test(requires)) return true;

  return /(?<![\w$.])import\s*\(/.test(text.replace(NODE_PLAIN_IMPORT_RE, " "));
}

/**
 * Splits a call's arguments at the top level, from just after its opening
 * parenthesis: commas inside nested brackets or quoted strings (any of the
 * three JavaScript quotes) do not split.
 *
 * @param {string} text The source text.
 * @param {number} from The index just past the call's opening parenthesis.
 * @returns {null | {args: string[], end: number}} The trimmed arguments and
 * the index just past the closing parenthesis, or `null` when the
 * parentheses never balance.
 */
function splitCallArgs(text, from) {
  const args = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && i + 1 < text.length) {
        current += text[i + 1];
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    if ((ch === ")" || ch === "]" || ch === "}") && depth === 0) {
      if (current.trim()) args.push(current.trim());

      return ch === ")" ? { args, end: i + 1 } : null;
    }
    if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }

  return null;
}

/** A destructuring or import of `open` or `openSync` that renames it, hiding every later call. */
const NODE_OPEN_ALIAS_RE =
  /\{[^{}]*(?<![\w$.])open(?:Sync)?\s*:[^{}]*\}\s*(?:=(?![=>])|of\b|from\b)|\bopen(?:Sync)?\s+as\b/;

/** A destructuring or import that binds `open` or `openSync` under its own name. */
const NODE_OPEN_BINDING_RE = /\{[^{}]*(?<![\w$.])open(?:Sync)?(?![\w$])[^{}]*\}\s*(?:=(?![=>])|=>|of\b|from\b)/;

/** The read-only second argument of `open`: `"r"`, `"rs"` or `O_RDONLY`. */
const NODE_OPEN_READ_MODE_RE = /^(?:(['"`])rs?\1|(?:[\w$]+\.)*O_RDONLY)$/;

/** An `open` argument that is a function or an arrow: the callback form, which carries no mode. */
const NODE_CALLBACK_ARG_RE = /^(?:async\s+)?(?:function\b|(?:\([^()]*\)|[\w$]+)\s*=>)/;

/**
 * Checks whether a Node script has an `open`/`openSync` call that can write:
 * a member call (`fs.openSync(`, `fs["open"](`), or — when the name is bound
 * by a destructuring or an import — a bare call too. A call that passes at
 * most one argument, whose second top-level argument is the literal `"r"`,
 * `"rs"` or `O_RDONLY`, or whose second argument is a callback function (the
 * form with no mode at all), only reads; any other does not, and a call whose
 * parentheses never balance counts as a write. A renamed binding
 * (`{openSync: o}`) hides its calls, so it counts as a write outright.
 *
 * @param {string} text A Node script's source text.
 * @param {string} bare The same script with its string and template text blanked.
 * @returns {boolean} `true` when some `open` call may write.
 */
function nodeOpensForWriting(text, bare) {
  if (NODE_OPEN_ALIAS_RE.test(bare)) return true;

  const callRe = NODE_OPEN_BINDING_RE.test(text)
    ? /(?<![\w$])open(?:Sync)?\s*\(/g
    : /\.\s*open(?:Sync)?\s*\(|\[\s*(['"`])open(?:Sync)?\1\s*\]\s*\(/g;
  for (let m = callRe.exec(text); m; m = callRe.exec(text)) {
    const call = splitCallArgs(text, m.index + m[0].length);
    if (call === null) return true;

    const mode = call.args[1];
    if (mode !== undefined && !NODE_OPEN_READ_MODE_RE.test(mode) && !NODE_CALLBACK_ARG_RE.test(mode)) return true;
  }

  return false;
}

/**
 * Checks whether a Node inline script can change a file, start a process or
 * run code the guard never read. Any of these makes it so:
 *
 * - {@link LEGACY_INLINE_WRITE_RE}, the old test, kept as a net;
 * - {@link NODE_LONG_NAME_RE}, an unambiguous name anywhere;
 * - {@link NODE_MODE_OPTION_RE}, an option that makes a read call write;
 * - {@link NODE_API_POSITION_RES} and {@link NODE_BINDING_RES}, a short name
 *   in an API position or a binding;
 * - {@link NODE_TEXTUAL_RES}, shapes that hide a name, on the script with its
 *   string text blanked;
 * - {@link nodeOpensForWriting}, an `open` that can write;
 * - {@link nodeRunsOtherCode}, a process start or loaded code.
 *
 * Only a name written out is recognised: a call built at run time
 * (`fs["rm" + "Sync"]`, a name held in a variable) is disguised code, out of
 * scope here exactly as it is for the raw-text scan. Output calls are not
 * neutralised here: a script that calls `process.stdout.write(` trips the old
 * net above, as it always did. The deny half neutralises a write to the
 * standard descriptors itself ({@link neutralizeFdWrites}) before it calls
 * this; the sealed exception does not.
 *
 * @param {string} text A Node inline script's source text.
 * @returns {boolean} `true` when the script may change a file or start a process.
 */
function nodeScriptChangesFiles(text) {
  if (LEGACY_INLINE_WRITE_RE.test(text) || NODE_LONG_NAME_RE.test(text) || NODE_MODE_OPTION_RE.test(text)) return true;
  if (NODE_API_POSITION_RES.some((re) => re.test(text)) || NODE_BINDING_RES.some((re) => re.test(text))) return true;

  const bare = blankJsStrings(text);
  if (NODE_TEXTUAL_RES.some((re) => re.test(bare))) return true;

  return nodeOpensForWriting(text, bare) || nodeRunsOtherCode(text);
}

/** A `writeSync` to descriptor 1 or 2 — standard output or error — and the comma after it. */
const NODE_FD_WRITE_RE = /(?<![\w$])writeSync\s*\(\s*[12]\s*,/g;

/**
 * Removes a `writeSync(1,` / `writeSync(2,` call's name, the descriptor
 * write to standard output or error, so the new detections do not read it as
 * a file write (the old test never did). Used only by the deny half, on top of
 * the old test, which still reads the script unmodified.
 *
 * @param {string} text A Node script's source text.
 * @returns {string} The script with those calls' names replaced by a bare paren.
 */
function neutralizeFdWrites(text) {
  return text.replace(NODE_FD_WRITE_RE, " (");
}

/** The changing `os` names, shared by the `os.name` and `from os import name` tests. */
const PYTHON_OS_CHANGE_NAMES =
  "rename|renames|replace|link|symlink|chmod|lchmod|fchmod|chown|lchown|fchown|truncate|ftruncate|mkdir|makedirs|utime|remove|unlink|rmdir|removedirs|write|open|mkfifo|mknod";

/** The `os` process-start names, in the same two spellings. */
const PYTHON_OS_START_NAMES = "system|popen|exec\\w*|spawn\\w*|posix_spawn\\w*";

/** The changing `shutil` names, shared by the `shutil.name` and `from shutil import name` tests. */
const PYTHON_SHUTIL_CHANGE_NAMES = "copy\\w*|move|rmtree|chown";

/** The modules whose names a wildcard import (`from os import *`) can bring in as changing calls. */
const PYTHON_WILDCARD_MODULES = "os|shutil|subprocess|pty|pathlib|io";

/**
 * What marks a Python inline script as able to change a file, start a
 * process or run code the guard never read, each as its own test:
 *
 * - a `shutil` function that copies, moves, removes or re-owns;
 * - an `os` function that renames, links, changes mode, owner or times,
 *   truncates, removes, creates, writes or opens a file descriptor;
 * - a pathlib-style method call that writes, creates, removes or re-modes;
 * - a `.write(` or `.writelines(` call;
 * - a process start: `subprocess`, `pty`'s `spawn`, `os.system`, `os.popen`,
 *   `os.exec*`, `os.spawn*`, `os.posix_spawn*`;
 * - a spelling that hides which module a call comes from: a `from` import of
 *   `subprocess`, `pty`, a changing name of `shutil` or `os`, or a wildcard
 *   import of `os`, `shutil`, `subprocess`, `pty`, `pathlib` or `io`;
 *   `importlib`, `runpy`;
 * - code built from text: `eval(` and `exec(` are tested on their own, with
 *   string literals blanked ({@link pythonRunsText}); `builtins.compile`;
 * - the rarer writers: `fileinput` in place, `sqlite3.connect`, a logging
 *   `FileHandler`, `os.fdopen`, `io.FileIO`, `GzipFile`, `BZ2File`,
 *   `LZMAFile`, `BufferedWriter`, `urlretrieve`, `savetxt`, `np.save*`,
 *   `make_archive`, `unpack_archive`.
 *
 * `open(` and pathlib's `Path(…).rename(`/`.replace(` are read by
 * {@link pythonOpenWrites} and {@link pythonPathMoves}, which need balanced
 * parentheses; a module alias by {@link pythonAliasChanges}; `zipfile`,
 * `tarfile`, `dbm` and `shelve` by {@link PYTHON_ARCHIVE_USE_RE}; an
 * assignment to `sys.stdout`/`sys.stderr` by {@link pythonRedirectsStd}; a
 * pandas `.to_*(` call by {@link pythonWritesFrame}; `__import__` by
 * {@link pythonDunderImportChanges}; `getattr(` on `os`, `shutil`, `pathlib`
 * or `Path` by {@link pythonGetattrChanges}. A bare
 * `.rename(`/`.replace(` on anything but a direct `Path(…)` is deliberately
 * NOT recognised: it collides with `str.replace` and `DataFrame.rename`,
 * ordinary calls in a read-only script.
 */
const PYTHON_FILE_CHANGE_RES = [
  new RegExp(`\\bshutil\\s*\\.\\s*(?:${PYTHON_SHUTIL_CHANGE_NAMES})\\b`),
  new RegExp(`\\bos\\s*\\.\\s*(?:${PYTHON_OS_CHANGE_NAMES})\\b`),
  /\.\s*(?:write_text|write_bytes|touch|symlink_to|hardlink_to|link_to|unlink|rmdir|mkdir|chmod|lchmod)\s*\(/,
  /\.\s*write(?:lines)?\s*\(/,
  /\bsubprocess\b|\bpty\s*\.\s*spawn\b/,
  new RegExp(`\\bos\\s*\\.\\s*(?:${PYTHON_OS_START_NAMES})\\b`),
  new RegExp(`\\bfrom\\s+(?:subprocess|pty)\\s+import\\b|\\bfrom\\s+shutil\\s+import\\b[^\\n;]*\\b(?:${PYTHON_SHUTIL_CHANGE_NAMES})\\b`),
  new RegExp(`\\bfrom\\s+os\\s+import\\b[^\\n;]*\\b(?:${PYTHON_OS_CHANGE_NAMES}|${PYTHON_OS_START_NAMES})\\b`),
  new RegExp(`\\bfrom\\s+(?:${PYTHON_WILDCARD_MODULES})\\s+import\\s+\\*`),
  /\bimportlib\b|\brunpy\b|\bbuiltins\s*\.\s*compile\b/,
  /\binplace\s*=\s*(?:True|1)\b|\bsqlite3\s*\.\s*connect\b|\bFileHandler\b|\bos\s*\.\s*fdopen\b/,
  /\bio\s*\.\s*FileIO\b|\b(?:Gzip|BZ2|LZMA)File\b|\bBufferedWriter\b|\burlretrieve\b|\bsavetxt\b/,
  /\b(?:np|numpy)\s*\.\s*save|\bmake_archive\b|\bunpack_archive\b/,
];

/** The archive and database modules whose use is read only in an import or a member position: {@link PYTHON_ARCHIVE_USE_RE}. */
const PYTHON_ARCHIVE_NAMES = "zipfile|tarfile|dbm|shelve";

/**
 * An archive or database module in an `import` / `from` clause or a member
 * position (`zipfile.ZipFile(`), never a word inside a path or a string.
 * Applied to the script with its plain strings blanked.
 */
const PYTHON_ARCHIVE_USE_RE = new RegExp(
  `\\b(?:import|from)[ \\t]+[\\w., \\t]*?\\b(?:${PYTHON_ARCHIVE_NAMES})\\b|\\b(?:${PYTHON_ARCHIVE_NAMES})\\s*\\.`,
);

/** The modules `__import__` may not be given: they change files, start processes or load code. */
const PYTHON_DUNDER_IMPORT_BLOCKED = new Set([
  "os", "shutil", "subprocess", "pty", "importlib", "runpy", "ctypes", "multiprocessing", "io", "codecs", "pathlib",
  "sqlite3", "zipfile", "tarfile", "shelve", "dbm", "fileinput", "logging",
]);

/** A single literal module name, in either quote. */
const PYTHON_NAME_LITERAL_RE = /^(['"])([\w.]+)\1$/;

/** The standard streams, as a pandas writer's target. */
const PYTHON_STD_STREAM_RE = /^sys\s*\.\s*std(?:out|err)$/;

/** A pandas writer's keyword that names the file it writes to. */
const PYTHON_FRAME_TARGET_KEYWORD_RE = /^(?:path_or_buf|path|excel_writer|buf|name|con|fname|file)\s*=(?!=)/;

/** A pandas `.to_*(` writer call. */
const PYTHON_FRAME_WRITER_RE = /\.\s*to_(?:json|csv|pickle|parquet|excel|hdf|feather|sql)\s*\(/g;

/** What `sys.stdout` may be reassigned to: a text wrapper over the real stream's own buffer. */
const PYTHON_STD_REWRAP_RE =
  /^\s*(?:io\s*\.\s*TextIOWrapper\s*\(\s*sys\s*\.\s*std(?:out|err)\s*\.\s*buffer\b|codecs\s*\.\s*getwriter\s*\([^()]*\)\s*\(\s*sys\s*\.\s*std(?:out|err)\s*\.\s*buffer\s*\))/;

/** The literal names that make a `getattr` on `os`, `shutil` or `pathlib` reach a changing function; every other literal name is read. */
const PYTHON_GETATTR_CHANGING_RE = new RegExp(
  `^(?:${PYTHON_OS_CHANGE_NAMES}|${PYTHON_OS_START_NAMES}|${PYTHON_SHUTIL_CHANGE_NAMES}|write_text|write_bytes|touch|symlink_to|hardlink_to|link_to|unlink|rmdir|mkdir|chmod|lchmod|rename|replace|write|writelines)$`,
);

/** The module aliases (`import os as o`) a changing member can hide behind, with the members that make the alias count. */
const PYTHON_ALIASED_MODULES = {
  os: `${PYTHON_OS_CHANGE_NAMES}|${PYTHON_OS_START_NAMES}`,
  shutil: PYTHON_SHUTIL_CHANGE_NAMES,
  pty: "spawn",
};

/** An `import module as alias` of one of {@link PYTHON_ALIASED_MODULES}. */
const PYTHON_MODULE_ALIAS_RE = /\bimport\s+(os|shutil|pty)\s+as\s+([A-Za-z_]\w*)/g;

/** The mode letters of Python's `open`; a mode string made only of these is a mode, not a path. */
const PYTHON_MODE_LITERAL_RE = /^[rRbBuUfF]{0,2}(['"])([rwxabtU+]*)\1$/;

/** A Python keyword argument `name=value`, but not a comparison. */
const PYTHON_KEYWORD_ARG_RE = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/;

/**
 * Checks whether one `open` argument can be a writing mode: a string literal
 * made only of mode letters holding at least one of `w`, `a`, `x`, `+`, or
 * anything that is not a literal at all (a variable, a call, `*args`).
 *
 * @param {string} arg One argument's source text.
 * @returns {boolean} `true` when the argument may select a writing mode.
 */
function pythonModeArgWrites(arg) {
  if (arg.startsWith("*")) return true;
  const literal = arg.match(PYTHON_MODE_LITERAL_RE);
  if (!literal) return !/^[rRbBuUfF]{0,2}(['"])[\s\S]*\1$/.test(arg);

  return /[wax+]/.test(literal[2]);
}

/**
 * Checks whether a Python script has an `open(` call that can write. The
 * mode is the second positional argument of `open(`, `io.open(` and the like,
 * the first of a method call such as `Path(p).open(`, or a `mode=` keyword; a
 * method call's second argument is read too. Parentheses are balanced and
 * quoted strings skipped, so a path built by `os.path.join(d, "x.json")`
 * does not hide the mode. A call whose parentheses never balance counts as
 * a write.
 *
 * @param {string} text A Python script, output calls already neutralised.
 * @returns {boolean} `true` when some `open(` call may write.
 */
function pythonOpenWrites(text) {
  const callRe = /(\.\s*)?\bopen\s*\(/g;
  for (let m = callRe.exec(text); m; m = callRe.exec(text)) {
    const call = splitCallArgs(text, m.index + m[0].length);
    if (call === null) return true;

    const { args } = call;
    const receiver = (text.slice(0, m.index).match(/([A-Za-z_]\w*)\s*$/) || [])[1];
    const isMethod = Boolean(m[1]) && !["io", "codecs", "builtins", "gzip", "bz2", "lzma"].includes(receiver);
    const positional = args.filter((arg) => !PYTHON_KEYWORD_ARG_RE.test(arg));
    const modeKeywords = args.map((arg) => arg.match(PYTHON_KEYWORD_ARG_RE)).filter((kw) => kw && kw[1] === "mode");

    if (modeKeywords.some((kw) => pythonModeArgWrites(kw[2].trim()))) return true;
    if (isMethod && positional.length && pythonModeArgWrites(positional[0])) return true;
    if (!isMethod && positional.length > 1 && pythonModeArgWrites(positional[1])) return true;

    const secondMode = positional.length > 1 ? (positional[1].match(PYTHON_MODE_LITERAL_RE) || [])[2] || "" : "";
    if (isMethod && /[wax+]/.test(secondMode)) return true;
  }

  return false;
}

/**
 * Checks whether a Python script calls `.rename(` or `.replace(` directly on a
 * `Path(…)` or `pathlib.Path(…)` expression, which moves a file over its
 * target. Reached through an alias or a variable it is not recognised.
 *
 * @param {string} text A Python script, output calls already neutralised.
 * @returns {boolean} `true` when a `Path(…)` is moved directly.
 */
function pythonPathMoves(text) {
  const pathRe = /\bPath\s*\(/g;
  for (let m = pathRe.exec(text); m; m = pathRe.exec(text)) {
    const call = splitCallArgs(text, m.index + m[0].length);
    if (call === null) return true;

    if (/^\s*\.\s*(?:rename|replace)\s*\(/.test(text.slice(call.end))) return true;
  }

  return false;
}

/**
 * Blanks the content of every plain Python string literal — single, double
 * or triple quoted — keeping its length and its quotes, so a word inside a
 * string is not read as code. An f-string keeps its content, as it can hold
 * code.
 *
 * @param {string} text A Python script's source text.
 * @returns {string} The script with plain string contents replaced by spaces.
 */
function blankPythonStrings(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== "'" && ch !== '"') {
      out += ch;
      i += 1;
      continue;
    }

    const delimiter = text.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
    const keepsCode = /f/i.test((out.match(/[A-Za-z]{0,2}$/) || [""])[0]);
    let j = i + delimiter.length;
    while (j < text.length && !text.startsWith(delimiter, j)) j += text[j] === "\\" ? 2 : 1;

    const body = text.slice(i + delimiter.length, Math.min(j, text.length));
    const closed = j < text.length;
    out += delimiter + (keepsCode ? body : body.replace(/[^\n]/g, " ")) + (closed ? delimiter : "");
    i = closed ? j + delimiter.length : text.length;
  }

  return out;
}

/**
 * Checks whether a Python script builds code from text and runs it: an
 * `exec(` or `eval(` call, found with the contents of plain string literals
 * blanked so a word inside a message is not one.
 *
 * @param {string} text A Python script's source text.
 * @returns {boolean} `true` when the script calls `exec(` or `eval(`.
 */
function pythonRunsText(text) {
  return /\b(?:exec|eval)\s*\(/.test(blankPythonStrings(text));
}

/**
 * Checks whether a module alias hides a changing call: `import os as o` counts
 * only when the alias is then used with a changing member (`o.replace(`,
 * `o.system(`), or handed to `getattr(`.
 *
 * @param {string} text A Python script's source text.
 * @returns {boolean} `true` when an aliased `os`, `shutil` or `pty` is used to change something.
 */
function pythonAliasChanges(text) {
  for (const [, module, alias] of text.matchAll(PYTHON_MODULE_ALIAS_RE)) {
    if (new RegExp(`\\b${alias}\\s*\\.\\s*(?:${PYTHON_ALIASED_MODULES[module]})\\b`).test(text)) return true;
    if (new RegExp(`\\bgetattr\\s*\\(\\s*${alias}\\b`).test(text)) return true;
  }

  return false;
}

/**
 * Checks whether a Python script configures logging to a file: a
 * `basicConfig(` call given a `filename=` keyword. A call whose parentheses
 * never balance counts.
 *
 * @param {string} text A Python script's source text.
 * @returns {boolean} `true` when logging is pointed at a file.
 */
function pythonLogsToFile(text) {
  const callRe = /\bbasicConfig\s*\(/g;
  for (let m = callRe.exec(text); m; m = callRe.exec(text)) {
    const call = splitCallArgs(text, m.index + m[0].length);
    if (call === null || call.args.some((arg) => /^filename\s*=(?!=)/.test(arg))) return true;
  }

  return false;
}

/**
 * Checks whether a Python script assigns `sys.stdout` or `sys.stderr` to
 * anything but a text wrapper over the real stream's own buffer
 * (`io.TextIOWrapper(sys.stdout.buffer, …)`, `codecs.getwriter(…)(sys.stdout.buffer)`),
 * which can point output at a file.
 *
 * @param {string} text A Python script's source text.
 * @returns {boolean} `true` when a standard stream is reassigned to something else.
 */
function pythonRedirectsStd(text) {
  const assignRe = /\bsys\s*\.\s*std(?:out|err)\s*=(?!=)/g;
  for (let m = assignRe.exec(text); m; m = assignRe.exec(text)) {
    if (!PYTHON_STD_REWRAP_RE.test(text.slice(m.index + m[0].length))) return true;
  }

  return false;
}

/**
 * Checks whether a pandas `.to_*(` writer call can write a file: it names a
 * file by keyword (`path_or_buf=`), or its first argument is positional and
 * not a standard stream. A call with no argument, or with only options
 * (`.to_csv(index=False)`), returns text; a call whose parentheses never
 * balance counts.
 *
 * @param {string} text A Python script's source text.
 * @returns {boolean} `true` when some writer call may write a file.
 */
function pythonWritesFrame(text) {
  for (const m of text.matchAll(PYTHON_FRAME_WRITER_RE)) {
    const call = splitCallArgs(text, m.index + m[0].length);
    if (call === null || call.args.some((arg) => PYTHON_FRAME_TARGET_KEYWORD_RE.test(arg))) return true;

    const first = call.args[0];
    if (first !== undefined && !PYTHON_KEYWORD_ARG_RE.test(first) && !PYTHON_STD_STREAM_RE.test(first)) return true;
  }

  return false;
}

/**
 * Checks whether a Python script's `__import__` can reach something that
 * changes a file: it is not called, is called with something but one literal
 * module name, or names one of {@link PYTHON_DUNDER_IMPORT_BLOCKED}
 * (judged by its top-level package, so `os.path` counts as `os`).
 *
 * @param {string} text A Python script's source text.
 * @returns {boolean} `true` when some `__import__` is not a harmless one.
 */
function pythonDunderImportChanges(text) {
  const importRe = /\b__import__\b/g;
  for (let m = importRe.exec(text); m; m = importRe.exec(text)) {
    const open = /^\s*\(/.exec(text.slice(m.index + m[0].length));
    const call = open === null ? null : splitCallArgs(text, m.index + m[0].length + open[0].length);
    const literal = call === null || call.args.length === 0 ? null : PYTHON_NAME_LITERAL_RE.exec(call.args[0]);
    if (literal === null || PYTHON_DUNDER_IMPORT_BLOCKED.has(literal[2].split(".")[0])) return true;
  }

  return false;
}

/**
 * Checks whether a Python script uses `getattr` on `os`, `shutil`, `pathlib`
 * or `Path` to reach a function that changes something: the name is not a
 * literal, or is a literal from the changing lists. `getattr(os, "sep")` only
 * reads.
 *
 * @param {string} text A Python script's source text.
 * @returns {boolean} `true` when such a `getattr` may reach a changing function.
 */
function pythonGetattrChanges(text) {
  const getattrRe = /\bgetattr\s*\(/g;
  for (let m = getattrRe.exec(text); m; m = getattrRe.exec(text)) {
    const call = splitCallArgs(text, m.index + m[0].length);
    if (call === null) return true;
    if (call.args.length === 0 || !/^(?:os|shutil|pathlib|Path)\b/.test(call.args[0])) continue;

    const literal = call.args.length > 1 ? PYTHON_NAME_LITERAL_RE.exec(call.args[1]) : null;
    if (literal === null || PYTHON_GETATTR_CHANGING_RE.test(literal[2])) return true;
  }

  return false;
}

/**
 * Checks whether a Python inline script can change a file, start a process
 * or run code the guard never read: {@link LEGACY_INLINE_WRITE_RE}, then
 * {@link PYTHON_FILE_CHANGE_RES}, {@link PYTHON_ARCHIVE_USE_RE},
 * {@link pythonRunsText}, {@link pythonOpenWrites}, {@link pythonPathMoves},
 * {@link pythonAliasChanges}, {@link pythonLogsToFile},
 * {@link pythonRedirectsStd}, {@link pythonWritesFrame},
 * {@link pythonDunderImportChanges} and {@link pythonGetattrChanges}. Output
 * calls are not neutralised: a script that calls `sys.stdout.write(` trips the
 * old net, as it always did.
 *
 * @param {string} script A Python inline script's source text.
 * @returns {boolean} `true` when the script may change a file or start a process.
 */
function pythonScriptChangesFiles(script) {
  const text = String(script || "");
  if (LEGACY_INLINE_WRITE_RE.test(text)) return true;
  if (PYTHON_FILE_CHANGE_RES.some((re) => re.test(text)) || PYTHON_ARCHIVE_USE_RE.test(blankPythonStrings(text))) return true;

  return (
    pythonRunsText(text) ||
    pythonOpenWrites(text) ||
    pythonPathMoves(text) ||
    pythonAliasChanges(text) ||
    pythonLogsToFile(text) ||
    pythonRedirectsStd(text) ||
    pythonWritesFrame(text) ||
    pythonDunderImportChanges(text) ||
    pythonGetattrChanges(text)
  );
}

/**
 * The old read-only condition, kept exactly: the statement holds an
 * `node -e` or `python -c` invocation by the old recogniser, and its script
 * carries nothing {@link LEGACY_INLINE_WRITE_RE} finds.
 *
 * @param {string} stmt A single statement's text.
 * @returns {boolean} `true` when the old test called the statement read-only.
 */
function passesOldReadOnlyTest(stmt) {
  const found = inlineScriptOf(stmt, NODE_INLINE_FLAG_RE);

  return found !== null && found.script !== null && !LEGACY_INLINE_WRITE_RE.test(found.script);
}

/** A bare `${NAME}` parameter: a plain variable's value, which is text and never code that runs. */
const BARE_BRACED_PARAMETER_RE = /^\$\{[A-Za-z_]\w*\}/;

/**
 * Checks whether the shell would run or expand something inside a
 * double-quoted script before the interpreter reads it: a command
 * substitution (`$(`), a backtick, or a parameter expansion with an operator
 * (`${NAME:-…}`, `${!NAME}`). A bare `${NAME}` is a variable's value and a
 * `$` or backtick preceded by an odd number of backslashes is escaped, so
 * neither counts. PowerShell escapes with the backtick itself, so there the
 * backtick is not an expansion and a backslash escapes nothing: `$(` counts
 * wherever it is.
 *
 * @param {string} raw The script as written between its double quotes.
 * @param {boolean} isPosixShell Whether the tool is a POSIX shell.
 * @returns {boolean} `true` when the shell expands something in the script.
 */
function shellExpandsDoubleQuoted(raw, isPosixShell) {
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (isPosixShell && ch === "\\") i += 1;
    else if (isPosixShell && ch === "`") return true;
    else if (ch === "$" && raw[i + 1] === "(") return true;
    else if (ch === "$" && raw[i + 1] === "{") {
      const bare = BARE_BRACED_PARAMETER_RE.exec(raw.slice(i));
      if (bare === null) return true;

      i += bare[0].length - 1;
    }
  }

  return false;
}

/** The rest of a shell word after a single-quoted piece, when it is the apostrophe splice and another single-quoted piece. */
const APOSTROPHE_SPLICE_RE = /^"'"'([^']*)'/;

/**
 * Joins what the shell joins when a single-quoted script holds an apostrophe
 * the one way a single-quoted string can: `'a'"'"'b'` is the one word `a'b`.
 * Only exactly that splice is read; any other adjacent piece is left alone and
 * keeps refusing, through {@link scriptWordContinues}.
 *
 * @param {string} text The statement the script was found in.
 * @param {null | object} found What {@link inlineScriptOf} found.
 * @returns {null | object} `found`, with the pieces joined into its script,
 * its `raw` text, its `after` character and its `end`.
 */
function joinApostropheSplices(text, found) {
  if (found === null || found.script === null || found.quote !== "'") return found;

  const joined = { ...found };
  for (let m = APOSTROPHE_SPLICE_RE.exec(text.slice(joined.end)); m; m = APOSTROPHE_SPLICE_RE.exec(text.slice(joined.end))) {
    joined.script += `'${m[1]}`;
    joined.raw += `'${m[1]}`;
    joined.end += m[0].length;
  }
  joined.after = text[joined.end] || "";

  return joined;
}

/**
 * Finds the quote still open at a position of a shell text.
 *
 * @param {string} text The shell text.
 * @param {number} index The position to look at.
 * @returns {string | null} `'` or `"` when that quote is open there, else `null`.
 */
function openQuoteAt(text, index) {
  let quote = null;
  for (let i = 0; i < index; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    }
  }

  return quote;
}

/**
 * Checks whether the character after a script's closing quote continues the
 * word instead of ending the invocation: a quote, `$`, a word character, or a
 * backtick. Two closers are not a continuation: the backtick that closes the
 * command substitution the invocation sits in (`` x=`node -e '…'` ``), and
 * the double quote that closes an outer double-quoted command
 * (`bash -lc "node -e '…'"`). `fs.copyFi''leSync(…)`, split across two quoted
 * pieces, is the shape this refuses.
 *
 * @param {string} text The statement the script was found in.
 * @param {{after: string, start: number}} found The script's surroundings.
 * @returns {boolean} `true` when the word runs on past the closing quote.
 */
function scriptWordContinues(text, found) {
  if (found.after === '"') return openQuoteAt(text, found.start) !== '"';
  if (/['$\w]/.test(found.after)) return true;
  if (found.after !== "`") return false;

  return ((text.slice(0, found.start).match(/`/g) || []).length % 2) === 0;
}

/**
 * Checks the new, additional conditions for one statement that runs an inline
 * script, reading it as the command it actually runs
 * ({@link stripForRecognition}). Refuses when no recognised script remains,
 * when the word runs on past the script's closing quote
 * ({@link scriptWordContinues}; an apostrophe splice is joined first,
 * {@link joinApostropheSplices}), when the script was double-quoted and the
 * shell expands something in it before the interpreter reads it
 * ({@link shellExpandsDoubleQuoted}; a single-quoted script is literal code,
 * and a plain `$NAME` stays allowed), or when the script's own source, read
 * with its language's own list ({@link nodeScriptChangesFiles},
 * {@link pythonScriptChangesFiles}), changes a file, starts a process or runs
 * code the guard never read. The source is read with each escaped double
 * quote taken as a plain one.
 *
 * @param {string} stmt A single statement's text.
 * @param {boolean} isPosixShell Whether the tool is a POSIX shell.
 * @returns {boolean} `true` when none of those refuse the statement.
 */
function inlineScriptIsPlain(stmt, isPosixShell) {
  const stripped = stripForRecognition(stmt);
  const found = joinApostropheSplices(stripped, inlineScriptOf(stripped, NODE_INLINE_FLAG_RE));
  if (found === null || found.script === null || scriptWordContinues(stripped, found)) return false;
  if (found.quote === '"' && shellExpandsDoubleQuoted(found.raw, isPosixShell)) return false;

  // A script quoted inside an outer double-quoted command that no wrapper
  // recogniser peels (`bash -lc "node -e '…require(\"fs\")…'"`) still carries
  // the outer layer's escaping; the inner shell reads those pairs as plain quotes.
  const script = found.script.replace(/\\"/g, '"');

  return found.language === "node" ? !nodeScriptChangesFiles(neutralizeFdWrites(script)) : !pythonScriptChangesFiles(script);
}

/**
 * Checks whether an inline interpreter script provably only reads. It is
 * strictly ADDITIVE over the old test: the statement must first pass that
 * test exactly as it was ({@link passesOldReadOnlyTest}), so nothing the old
 * test refused can pass here, and then pass the checks of
 * {@link inlineScriptIsPlain}, which can only refuse more. One list per
 * language cannot be shared: Python's `.replace(` and `.rename(` would catch
 * ordinary JavaScript string code.
 *
 * A nested-shell wrapper (`bash -c "node -e '…'"`) is judged by the scripts
 * inside it, read as the inner shell sees them: the outer text only carries
 * them behind one more layer of escaping, which is not code.
 *
 * Mirrors the same read-only reasoning `READ_ONLY_VERBS` applies to a shell
 * verb, for the one shape that list cannot name — an interpreter is not
 * itself a verb, only the script handed to it decides whether it writes.
 *
 * @param {string} stmt A single statement's text.
 * @param {boolean} [isPosixShell] Whether the tool is a POSIX shell; the
 * stricter reading when omitted.
 * @returns {boolean} `true` when the statement is an inline interpreter
 * invocation whose script text neither changes a file nor starts a process.
 */
function isInlineReadOnlyScript(stmt, isPosixShell = true) {
  if (!passesOldReadOnlyTest(stmt)) return false;

  const inner = unwrapNestedShells(stmt);
  const scripted =
    inner === null
      ? []
      : splitStatements(inner).filter((s) => unwrapNestedShells(s) === null && inlineScriptOf(s, NODE_INLINE_FLAG_RE) !== null);
  if (scripted.length) return scripted.every((s) => inlineScriptIsPlain(s, isPosixShell));

  return inlineScriptIsPlain(stmt, isPosixShell);
}

/**
 * Calls, in either Node's or Python's standard library, that remove a file
 * or directory tree — the inline-script counterpart to {@link REMOVE_VERBS}.
 */
const INLINE_DESTRUCTIVE_INDICATOR_RE =
  /shutil\.rmtree|os\.(?:remove|unlink|rmdir)|\.rmsync\s*\(|\.unlinksync\s*\(|\.rmdirsync\s*\(/i;

/**
 * Checks whether a `find` invocation removes what it finds, through either
 * spelling a real shell accepts: the `-delete` primary, or `-exec rm`/
 * `-exec unlink` handing each match to a removal command.
 *
 * @param {string} stmt A single statement's text.
 * @returns {boolean} `true` when the statement is a `find` invocation that
 * also deletes.
 */
function hasFindRemove(stmt) {
  if (!hasCommand(stmt, "find")) return false;
  if (hasFlag(stmt, "-delete")) return true;
  return /-exec\s+(?:rm|unlink)\b/i.test(maskQuotedRegions(stmt));
}

/**
 * Checks whether a statement removes the state directory by any spelling
 * this file recognises: a plain removal verb at its command start
 * ({@link REMOVE_VERBS}), a `find … -delete`/`-exec rm`/`-exec unlink`
 * invocation, or an inline Node/Python script that calls a removal function
 * on its own. The inline script is found by the old recogniser
 * ({@link NODE_INLINE_FLAG_RE}) and by the wider one
 * ({@link NODE_PRINT_INLINE_FLAG_RE}, which also takes `-p`/`--print`): here,
 * recognising more is the safe direction, so `time node -e "…"` counts too.
 * The statement is read as written, with no comment cut and no assignment
 * blanked.
 *
 * @param {string} stmt A single statement's text.
 * @returns {boolean} `true` when the statement removes something by any of
 * those routes.
 */
function hasRemoveAction(stmt) {
  if (REMOVE_VERBS.some((verb) => hasCommand(stmt, verb))) return true;
  if (hasFindRemove(stmt)) return true;

  return inlineScriptsForRemoval(stmt).some((script) => INLINE_DESTRUCTIVE_INDICATOR_RE.test(script));
}

/**
 * Evaluates one shell statement against both protections.
 *
 * @param {string} rawStmt A single statement, already split out of a
 * compound command line.
 * @param {boolean} isPosixShell Whether the enclosing tool follows POSIX
 * word-splitting rules — see {@link POSIX_SHELL_TOOLS}.
 * @param {string} cwd The tool call's working directory, resolved against a
 * bare state-directory reference by {@link matchesStateDirRelativeToCwd}.
 * @returns {null | {action: "deny", reason: string, fix: string}} `deny`
 * when the statement grants an approval, deletes the state directory, or
 * changes its permissions; `pass` otherwise.
 */
/**
 * Checks whether a statement makes `SOFTELA_AI_HOME` survive the command that
 * set it, by either route:
 *
 * - a persistent environment writer ({@link PERSISTENT_ENV_WRITERS}), which
 *   is itself the write;
 *
 * - a shell startup file ({@link SHELL_STARTUP_FILE}) combined with a
 *   genuine write, so that reading one is not mistaken for editing it.
 *
 * @param {string} stmt A single shell statement.
 * @returns {boolean} `true` when the statement persists the variable.
 */
function redirectsInfrastructureHome(stmt) {
  if (!HOME_OVERRIDE_VAR.test(stmt)) return false;
  if (PERSISTENT_ENV_WRITERS.some((re) => re.test(stmt))) return true;
  return SHELL_STARTUP_FILE.test(stmt) && hasOutputRedirect(stmt);
}

/**
 * Read-only flags an `softela-ai approve` invocation may carry without granting
 * anything, matched as a whole argument with no value of their own:
 *
 * - `--list` — list live approvals;
 * - `--json` — machine-readable output alongside `--list`;
 * - `--help` / `-h` — usage text.
 */
const APPROVE_READONLY_VALUELESS_FLAG_RE = /^(?:--list|--json|--help|-h)$/i;

/** `--agent=<value>`, the inline-value spelling of the read-only `--agent` flag. */
const APPROVE_READONLY_AGENT_INLINE_RE = /^--agent=\S+$/i;

/** `--agent`, whose value is the following argument — the space-separated spelling. */
const APPROVE_READONLY_AGENT_FLAG_RE = /^--agent$/i;

/**
 * Checks whether an approve invocation's every argument is one of the
 * read-only forms the CLI documents:
 *
 * - `--list`, `--json`, `--help`/`-h` — no value of their own;
 * - `--agent <value>` or `--agent=<value>` — scopes a read to one agent.
 *
 * Returns `false` — leaving the surrounding deny in place — for a
 * positional argument (a rule id), `--minutes` in any form, an unrecognised
 * flag, a bare `approve` with no arguments at all (the usage-error path, not
 * a read), and a statement carrying an output redirect of its own, reusing
 * {@link hasOutputRedirect} rather than a second check.
 *
 * @param {string} stmt A single statement, already canonicalised when the
 * enclosing tool is a POSIX shell — the same form the caller already tests
 * with {@link APPROVE_INVOCATION}.
 * @returns {boolean} `true` when the statement is an approve invocation
 * whose every argument is read-only.
 */
function isReadOnlyApproveInvocation(stmt) {
  if (!hasCommand(stmt, APPROVE_INVOCATION)) return false;
  if (hasOutputRedirect(stmt)) return false;

  const tokens = splitTokens(stmt);
  const toolIndex = tokens.findIndex((token) => /softela-ai(?:\.\w+)?$/i.test(token));
  if (toolIndex === -1 || toolIndex + 1 >= tokens.length) return false;
  if (!/^approve$/i.test(tokens[toolIndex + 1])) return false;

  const args = tokens.slice(toolIndex + 2);
  if (!args.length) return false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (APPROVE_READONLY_VALUELESS_FLAG_RE.test(arg) || APPROVE_READONLY_AGENT_INLINE_RE.test(arg)) {
      i += 1;
      continue;
    }
    if (APPROVE_READONLY_AGENT_FLAG_RE.test(arg)) {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) return false;
      i += 2;
      continue;
    }
    return false;
  }
  return true;
}

function evaluateShellStatement(rawStmt, isPosixShell, cwd) {
  const stmt = isPosixShell ? canonicalizePosixWord(rawStmt) : rawStmt;

  if (hasCommand(stmt, APPROVE_INVOCATION) && !isReadOnlyApproveInvocation(stmt)) {
    return deny(
      "INFRA SELF-PROTECTION: `softela-ai approve` grants an approval from inside a tool call. Approval means a person, so this only happens from the developer's own terminal.",
      "Ask the developer to run this command themselves.",
    );
  }

  // Checked before the state-directory gate below, because this statement
  // deliberately does NOT name the state directory — redirecting the home
  // every path resolves through is how you move the target instead of
  // touching it.
  if (redirectsInfrastructureHome(stmt) || redirectsInfrastructureHome(rawStmt)) {
    return deny(
      "INFRA SELF-PROTECTION: this makes SOFTELA_AI_HOME outlive the command, which repoints every path this infrastructure resolves — including the state directory this rule protects — for every future hook process.",
      "Do not persist SOFTELA_AI_HOME from a tool call. Setting it for one command is fine; writing it into the environment or a shell startup file is not.",
    );
  }

  // Checked against both the raw and the POSIX-canonicalised text: an
  // unquoted Windows-style absolute path is exactly the shape
  // canonicalisation itself would mangle (a real POSIX shell treats its own
  // backslash-letter pairs as escapes), so a real absolute path match must
  // not depend on having survived that collapse.
  if (!targetsStateDir(stmt, cwd) && !targetsStateDir(rawStmt, cwd)) return pass();

  // Any statement that touches the real approvals/overrides file and is not
  // provably read-only is treated as a write: a read-only verb or an inline
  // interpreter script with no write call alone does not prove that —
  // `cat > file` still writes despite `cat` — so the exemption only holds
  // once a genuine write redirect is also ruled out.
  const isReadOnlyStatement =
    (READ_ONLY_VERBS.some((verb) => hasCommand(stmt, verb)) || isInlineReadOnlyScript(stmt, isPosixShell)) &&
    !hasOutputRedirect(stmt);
  if (APPROVAL_FILENAME.test(stmt) && !isReadOnlyStatement) {
    return deny(
      "INFRA SELF-PROTECTION: this writes to the approvals or overrides file, granting an approval from inside a tool call.",
      "Ask the developer to make this change themselves.",
    );
  }

  if (hasRemoveAction(stmt)) {
    return deny(
      "INFRA SELF-PROTECTION: this removes the state directory that holds the developer's own approvals and overrides.",
      "Do not delete the state directory from a tool call.",
    );
  }

  if (PERMISSION_VERBS.some((verb) => hasCommand(stmt, verb))) {
    return deny(
      "INFRA SELF-PROTECTION: this changes permissions on the state directory from a tool call.",
      "Do not change permissions on the state directory from a tool call.",
    );
  }

  return pass();
}

/**
 * Backstops the precise, statement-by-statement checks above against
 * evasions that defeat statement boundaries themselves — a parameter
 * expansion default, a brace-expansion alternative, or an alias defined in
 * one statement and invoked in another. Each of those can put the tool name
 * or the state directory's name in the raw text without the adjacent,
 * parseable shape the precise checks require, and can put the self-unlock
 * verb or the destructive verb in a different statement entirely. Reads the
 * WHOLE raw command text as one blob on purpose, ignoring statement and
 * quote boundaries — respecting those boundaries is exactly what the
 * evasion exploits.
 *
 * Runs only once every precise check above has already found nothing — and
 * not at all for a wholly read-only command or one sealed read-only `node`
 * script, see {@link isSealedReadOnlyNodeCommand} — and returns `ask` rather
 * than `deny`: this scan is coarse by design and will
 * sometimes fire on a grep pattern, a commit message, or a coincidental
 * pairing of words that names neither the tool nor a real removal. The
 * asymmetry is deliberate — on this one mandatory rule, a false positive
 * costs one approval prompt, while a false negative silently defeats the
 * only rule no config tier or override can soften.
 *
 * @param {string} command The raw, unmodified command text.
 * @returns {null | {action: "ask", reason: string, fix: string}} `ask` when
 * the tool name and the self-unlock verb both appear anywhere in the text,
 * or the state directory's name and a destructive verb both do; `pass`
 * otherwise.
 */
function evaluateRawShellConservative(command) {
  const selfUnlock = TOOL_NAME_RE.test(command) && SELF_UNLOCK_VERB_RE.test(command);
  const destructiveStateDir =
    STATE_DIR_NAME_RE.test(command) && HOST_HOME_NAME_RE.test(command) && DESTRUCTIVE_VERB_RE.test(command);

  if (!selfUnlock && !destructiveStateDir) return pass();

  return ask(
    "INFRA SELF-PROTECTION: this command's raw text pairs the approval tool's name or the state directory with a self-unlock or destructive verb, in a shape that splitting into statements cannot rule out (a parameter expansion, a brace expansion, an alias, or similar). State exactly what this command does before the developer approves it.",
    "Describe the intended command in full and wait for the developer's approval, or run it from the developer's own terminal if it is a genuine developer action.",
  );
}

/**
 * Checks whether a single statement, judged entirely on its own, neither
 * reads nor writes anything a rule would ever need to care about: a
 * read-only verb invocation ({@link READ_ONLY_VERBS}), bare directory or
 * directory-stack navigation ({@link NAVIGATION_VERBS}), a plain no-op
 * ({@link NOOP_VERBS}), or a read-only `softela-ai approve` invocation
 * ({@link isReadOnlyApproveInvocation}) — in every case, provided it carries
 * no genuine output redirect of its own.
 *
 * @param {string} stmt A single statement, already canonicalised when the
 * enclosing tool is a POSIX shell.
 * @returns {boolean} `true` when the statement is one of the four inert
 * shapes above and carries no write redirect.
 */
function isInertStatement(stmt) {
  if (hasOutputRedirect(stmt)) return false;
  if (READ_ONLY_VERBS.some((verb) => hasCommand(stmt, verb))) return true;
  if (NAVIGATION_VERBS.some((verb) => hasCommand(stmt, verb))) return true;
  if (NOOP_VERBS.some((verb) => hasCommand(stmt, verb))) return true;
  return isReadOnlyApproveInvocation(stmt);
}

/**
 * Checks whether a command is nothing but read-only or otherwise-inert
 * invocations, with no genuine write anywhere — the same reasoning
 * {@link evaluateShellStatement} already applies to exempt a targeted read,
 * lifted to the whole command so the conservative backstop below never has
 * to fire on one. Reading bytes off disk cannot itself invoke the approval
 * CLI or delete anything, so a file whose NAME merely mentions the tool or
 * the word "approve" — a doc titled `softela-ai-approve-workflow.md`, say — is
 * not an approval or a removal no matter what its name says. Neither can
 * moving between directories, or a plain no-op.
 *
 * Checks every statement `splitStatements` returns, not only the first: a
 * single real command that a subshell, group command, or substitution wraps
 * (`(cat notes.md)`) now comes back as more than one entry — the outer,
 * still-wrapped form alongside its clean, unwrapped statement — and both
 * describe the exact same one read, so requiring all of them to be
 * individually inert stays exactly as strict as requiring a single
 * statement once did, without penalising a command for how it happened to
 * be grouped.
 *
 * An interpreter wrapper statement (`bash -c '…'`, `powershell -Command
 * "…"`, `iex "…"`, …) is exempted from {@link isInertStatement}'s own verb
 * check the same way: `splitStatements` already contributes the wrapper's
 * unwrapped inner statement(s) as their own separate entries, so judging the
 * wrapped form on its OWN leading word (`bash`, `powershell`, …) would
 * demand a read-only verb where none is meant to appear — the genuine verb
 * lives one entry over and is judged there instead. Still denies a wrapper
 * that carries a redirect of its own (`bash -c '…' > file`): the inner
 * statement it unwraps to knows nothing about that outer redirect, so
 * nothing else in this loop would ever catch it.
 *
 * @param {string} command The raw, unmodified command text.
 * @param {boolean} isPosixShell Whether the enclosing tool follows POSIX
 * word-splitting rules — see {@link POSIX_SHELL_TOOLS}.
 * @returns {boolean} `true` when every statement in the command is inert, or
 * is a wrapper statement with no redirect of its own.
 */
function isWhollyReadOnlyCommand(command, isPosixShell) {
  const statements = splitStatements(command);
  if (!statements.length) return false;
  return statements.every((raw) => {
    if (unwrapNestedShells(raw) !== null) return !hasOutputRedirect(raw);
    const stmt = isPosixShell ? canonicalizePosixWord(raw) : raw;
    return isInertStatement(stmt);
  });
}

/*
 * The sealed exception. Everything below this line is stricter than the deny
 * half's detections above and is used ONLY by the exception: a miss there
 * means a missed `ask`, a miss here would silence the backstop outright, so
 * the exception refuses on top of every deny-half detection:
 * {@link SEALED_UNICODE_ESCAPE}, the allow-lists, {@link SEALED_ESCAPE_WORD_RE},
 * and the extras in {@link sealedCodeDisguises}.
 */

/** The four typographic single quotes, U+2018 to U+201B, which Windows PowerShell reads as plain ones. */
const CURLY_QUOTES = String.fromCharCode(0x2018, 0x2019, 0x201a, 0x201b);

/** A backslash followed by `u`: how a Unicode escape begins, in an identifier too. */
const SEALED_UNICODE_ESCAPE = `${String.fromCharCode(92)}u`;

/**
 * The whole of one sealed `node` invocation: the interpreter, one of its four
 * evaluate-and-print flags, and the code in single quotes — captured, with no
 * single quote and no typographic quote ({@link CURLY_QUOTES}) inside it — and
 * nothing else before or after. Only spaces and tabs separate the three
 * parts: a newline is a command separator in a POSIX shell, so `node -e` then
 * a newline then a quoted word would run that word as its own command.
 */
const SEALED_NODE_COMMAND_RE = new RegExp(
  `^\\s*node(?:\\.exe)?[ \\t]+(?:-e|--eval|-p|--print)[ \\t]+'([^'${CURLY_QUOTES}]*)'\\s*$`,
);

/**
 * A `require` call with exactly one literal module name from the five
 * harmless built-ins, in any of the three quote styles, with nothing else
 * inside the parentheses.
 */
const SEALED_ALLOWED_REQUIRE_RE = /\brequire\s*\(\s*(['"`])(?:node:)?(?:fs|path|os|util|readline)\1\s*\)/g;

/** The parts of `process` a sealed script may read or use: arguments, environment, output, exit, cwd, platform. */
const SEALED_ALLOWED_PROCESS_RE = /\bprocess\s*\.\s*(?:argv|env|stdout|stderr|exit|exitCode|cwd|platform)\b/g;

/**
 * Words, case-sensitive and whole, with which JavaScript can reach code or a
 * capability the checks above never see: dynamic evaluation, dynamic import,
 * the global object, prototype and reflection access, the module system and a
 * function's own argument list, and the globals that start a network request,
 * a WebAssembly module, a priority change or web storage (`fetch`,
 * `WebSocket`, `EventSource`, `WebAssembly`, `setPriority`, `localStorage`,
 * `sessionStorage`). `exec`, `spawn` and `fork` are not here: a regular
 * expression's `.exec(` is ordinary, and the other two are unreachable
 * without `child_process`, which is.
 */
const SEALED_ESCAPE_WORD_RE =
  /\b(?:eval|Function|import|globalThis|global|this|constructor|prototype|__proto__|Reflect|Proxy|module|exports|arguments|child_process|worker_threads|setPriority|WebAssembly|fetch|WebSocket|EventSource|localStorage|sessionStorage)\b/;

/** The built-in modules a sealed script may use as plain globals: the five it may `require`, `console` and `process`. */
const SEALED_ALLOWED_BUILTINS = new Set(["fs", "path", "os", "util", "readline", "console", "process"]);

/**
 * Lists every other built-in module's bare name from the running Node's own
 * list: in `node -e` each of them is a global (`vm.runInThisContext`,
 * `cluster.fork`, `v8.writeHeapSnapshot` all run for real), so none may appear.
 *
 * @returns {string[]} The module names, without a `node:` prefix or a `/`.
 */
function sealedBuiltinNames() {
  const names = builtinModules.map((name) => name.replace(/^node:/, ""));

  return [...new Set(names)].filter((name) => !name.includes("/") && !SEALED_ALLOWED_BUILTINS.has(name));
}

/**
 * Any other built-in module's name as a whole word not preceded by a single
 * dot, so `.test(` and `o.events` stay fine while a spread (`{...vm}`) is seen.
 */
const SEALED_BUILTIN_GLOBAL_RE = new RegExp(
  `(?<![\\w$])(?<!(?:^|[^.])\\.)(?:${sealedBuiltinNames().map(escapeRegExp).join("|")})(?![\\w$])`,
);

/**
 * A short file-changing name in ANY position, where the deny half counts only
 * the API positions it can tell from data: a member access of any short name,
 * called or not (`o.rules.mkdir`, `promisify(fs.rm)`); a bare call of one; a
 * destructuring or import of one, the generic `open`, `write` and `link`
 * included, in any position ({@link looseDestructuringRe}); and a string
 * literal that is exactly one, which also covers a bracket string.
 */
const SEALED_NAME_RES = [
  new RegExp(`\\.\\s*${NODE_API_NAME}(?![\\w$])`),
  new RegExp(`(?<![\\w$./'"\`\\\\])(?<!(?:^|[^|])\\|)${NODE_API_NAME}\\s*\\(`),
  looseDestructuringRe(NODE_API_NAME),
  new RegExp(`(['"\`])${NODE_API_NAME}\\1`),
];

/**
 * The textual shapes the deny half reads on blanked string text, read here on
 * the raw text: a comment right after a member dot, a `with (` scope, and a
 * renamed `open` ({@link NODE_OPEN_ALIAS_RE}). A label that merely holds them
 * is refused here, as a miss would silence the backstop.
 */
const SEALED_RAW_TEXTUAL_RES = [...NODE_TEXTUAL_RES, NODE_OPEN_ALIAS_RE];

/**
 * Node's sloppy-script grammar reads `<!--` anywhere, and `-->` at the start of
 * a line (also after a block comment or a Unicode line terminator), as a line
 * comment: `fs.<!--x` then a newline and a name hides the name from every
 * test of a script's text.
 */
const SEALED_HTML_COMMENT_RE = new RegExp(
  `<!--|(?:^|[\\r\\n${String.fromCharCode(0x2028, 0x2029)}]|\\*\\/)[ \\t]*-->`,
);

/** A comment of any of the three styles, as {@link stripJsComments} removes it. */
const JS_COMMENT_RE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|<!--[^\n]*/g;

/** The whole words `flag` and `flags`, which can turn a read into a write however they are spelled (`{flag}`, `o.flag="w"`). */
const SEALED_FLAG_WORD_RE = /(?<![\w$])flags?(?![\w$])/;

/**
 * Shapes that reach a function the guard cannot name:
 *
 * - `new` of anything but a harmless built-in constructor (`Map`, `Set`,
 *   `WeakMap`, `WeakSet`, `Date`, `RegExp`, `Array`, `Object`, `Error`, `URL`,
 *   `Intl.<name>`);
 * - a call on a computed member or on a call result (`](`, `)(`).
 *
 * A third shape, a tagged template, is found by {@link hasTaggedTemplate}.
 */
const SEALED_SHAPE_RES = [
  /(?<![\w$.])new(?![\w$])\s*(?!(?:Map|Set|WeakMap|WeakSet|Date|RegExp|Array|Object|Error|URL|Intl\s*\.\s*\w+)(?![\w$]))[\w$([]/,
  /\]\s*\(/,
  /\)\s*\(/,
];

/**
 * Checks whether a script holds a tagged template: an identifier, `)` or `]`
 * directly before a backtick that OPENS a template, which calls a function
 * with the template's strings. Backticks are read in pairs, so the closing one
 * of an ordinary template (`` `n (${n})` ``) is not mistaken for a tag; a
 * script whose backticks do not pair up counts as holding one.
 *
 * @param {string} code A script's source text.
 * @returns {boolean} `true` when a tagged template, or an unpaired backtick, is found.
 */
function hasTaggedTemplate(code) {
  let open = false;
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] === "\\") i += 1;
    else if (code[i] !== "`") continue;
    else if (!open && /[\w$)\]]/.test(code[i - 1] || "")) return true;
    else open = !open;
  }

  return open;
}

/**
 * Spellings that build a name or reach a function without writing it out —
 * the extras only the sealed exception refuses, since an exception that
 * skips the backstop must not be talked past by plain disguise:
 *
 * - a bracket subscript opening with a string holding a backslash
 *   (`fs["\x72mSync"]`);
 * - two string literals joined with `+` (`"rm" + "Sync"`);
 * - a template placeholder opening with a literal (`${"rm"}Sync`);
 * - the whole words that assemble a name or walk to a constructor:
 *   `fromCharCode`, `fromCodePoint`, `getOwnPropertyNames`,
 *   `getOwnPropertyDescriptor(s)`, `getPrototypeOf`, `setPrototypeOf`,
 *   `defineProperty`, `getBuiltinModule`.
 */
const SEALED_DISGUISE_RES = [
  /\[\s*(['"`])(?:(?!\1)[\s\S])*?\\/,
  /(['"`])(?:(?!\1)[^\\])*\1\s*\+\s*['"`]/,
  /\$\{\s*['"`]/,
  /\b(?:fromCharCode|fromCodePoint|getOwnPropertyNames|getOwnPropertyDescriptors?|getPrototypeOf|setPrototypeOf|defineProperty|getBuiltinModule)\b/,
];

/**
 * Removes every comment from a script, replacing each with the given text, so
 * a call shape split by a comment — `new`, a comment, then a class name; a
 * name, a comment, then a template; a call, a comment, then a second argument
 * list — reads as the shape it is. Strings and regular expressions are not
 * parsed, so a `//` inside one cuts the line there: the stripped copy is only
 * ever read in addition to the raw text, and can only add refusals.
 *
 * @param {string} code A script's source text.
 * @param {string} filler What replaces each comment.
 * @returns {string} The script without its comments.
 */
function stripJsComments(code, filler) {
  return code.replace(JS_COMMENT_RE, filler);
}

/**
 * Checks whether a script holds a call shape the guard cannot follow
 * ({@link SEALED_SHAPE_RES}, {@link hasTaggedTemplate}), on the raw text and
 * on two copies with the comments removed — one leaving a space where each
 * was, one leaving nothing — so a comment between the tokens does not hide it.
 *
 * @param {string} code A script's source text.
 * @returns {boolean} `true` when any of the three copies holds such a shape.
 */
function sealedCallShapes(code) {
  return [code, stripJsComments(code, " "), stripJsComments(code, "")].some(
    (copy) => hasTaggedTemplate(copy) || SEALED_SHAPE_RES.some((re) => re.test(copy)),
  );
}

/** One `require` of `fs`, with or without the `node:` prefix. */
const SEALED_FS_REQUIRE_RE = /\brequire\s*\(\s*(['"`])(?:node:)?fs\1\s*\)/g;

/** The identifier `fs` as a whole word that is not a single-dot member name; a spread's `...fs` is checked. */
const SEALED_FS_WORD_RE = /(?<![\w$])(?<!(?:^|[^.])\.)fs(?![\w$])/g;

/** What may follow an object to make a member access: `.name` or `?.name`, the name captured. */
const MEMBER_ACCESS_RE = /^\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/;

/** The text before a binding's initialiser: `const`, `let` or `var`, then `fs` and `=`. */
const SEALED_FS_BINDING_RE = /\b(?:const|let|var)\s+fs\s*=\s*$/;

/**
 * Checks whether a member access follows: `.name` or `?.name`, and for
 * `promises` a member access after that too (`fs.promises` alone is the whole
 * promise API as a value).
 *
 * @param {string} after The text right after the object.
 * @returns {boolean} `true` when the object is only ever used as `object.member`.
 */
function memberAccessFollows(after) {
  const access = MEMBER_ACCESS_RE.exec(after);
  if (access === null) return false;
  if (access[1] !== "promises") return true;

  return MEMBER_ACCESS_RE.test(after.slice(access[0].length));
}

/**
 * Checks whether a script lets `fs` escape as a value. The only uses allowed
 * are the one binding `const fs = require("fs")` (or `let`, `var`, with
 * `node:fs`) whose initialiser is not itself followed by a member, call or
 * subscript, and `fs.<member>` — a `require("fs")` is that binding's
 * initialiser or is directly followed by a member access, and every other
 * `fs` is directly followed by one, `fs.promises` by a member in turn.
 * Everything else refuses at once: `const g = fs`, `{...fs}`,
 * `Object.keys(fs)`, `for (k in fs)`, `with (fs)`, `[fs]`, `Map(fs)`, any
 * destructuring of `fs` however it is written, and `require("fs")` bound to
 * another name. It replaces chasing each of those shapes one by one.
 *
 * @param {string} code A script's source text.
 * @returns {boolean} `true` when `fs` is used as anything but `fs.<member>`.
 */
function sealedFsEscapes(code) {
  const fine = new Set();

  for (const m of code.matchAll(SEALED_FS_REQUIRE_RE)) {
    const after = code.slice(m.index + m[0].length);
    const binding = SEALED_FS_BINDING_RE.exec(code.slice(0, m.index));
    const bound = binding !== null && !/^\s*[.[(`?]/.test(after);
    if (!bound && !memberAccessFollows(after)) return true;

    fine.add(m.index + m[0].indexOf("fs"));
    if (bound) fine.add(binding.index + binding[0].lastIndexOf("fs"));
  }

  for (const m of code.matchAll(SEALED_FS_WORD_RE)) {
    if (!fine.has(m.index) && !memberAccessFollows(code.slice(m.index + m[0].length))) return true;
  }

  return false;
}

/**
 * Checks whether a sealed script could run other code or start a process:
 * a Unicode escape inside an identifier (which would hide `eval`), a
 * `require` that is not a call naming one of the five harmless built-ins, a
 * `process` member outside the allowed few (output calls on `process.stdout`
 * and `process.stderr` included), or a word of {@link SEALED_ESCAPE_WORD_RE}.
 *
 * @param {string} code The script's source text.
 * @returns {boolean} `true` when the script is not clearly harmless.
 */
function sealedCodeRunsOther(code) {
  if (code.includes(SEALED_UNICODE_ESCAPE)) return true;

  const withoutRequires = code.replace(SEALED_ALLOWED_REQUIRE_RE, " ");
  if (/\brequire\b/.test(withoutRequires)) return true;

  const withoutProcess = withoutRequires.replace(NODE_STD_WRITE_RE, " (").replace(SEALED_ALLOWED_PROCESS_RE, " ");
  if (/\bprocess\b/.test(withoutProcess)) return true;

  return SEALED_ESCAPE_WORD_RE.test(code);
}

/**
 * Checks whether a sealed script names or builds a capability in a way only
 * the exception refuses: a built-in module used as a global
 * ({@link SEALED_BUILTIN_GLOBAL_RE}), `fs` used as anything but
 * `fs.<member>` ({@link sealedFsEscapes}), an HTML-like comment
 * ({@link SEALED_HTML_COMMENT_RE}), a short file-changing name in any
 * position ({@link SEALED_NAME_RES}), the textual shapes the deny half only
 * reads outside strings ({@link SEALED_RAW_TEXTUAL_RES}), the word `flag` or
 * `flags` ({@link SEALED_FLAG_WORD_RE}), a call shape the guard cannot follow,
 * also across a comment ({@link sealedCallShapes}), or a disguised name
 * ({@link SEALED_DISGUISE_RES}).
 *
 * @param {string} code The script's source text, output calls neutralised.
 * @returns {boolean} `true` when the script does any of those.
 */
function sealedCodeDisguises(code) {
  if (SEALED_BUILTIN_GLOBAL_RE.test(code) || SEALED_FLAG_WORD_RE.test(code) || SEALED_HTML_COMMENT_RE.test(code)) return true;
  if (sealedFsEscapes(code) || sealedCallShapes(code)) return true;

  return [...SEALED_NAME_RES, ...SEALED_RAW_TEXTUAL_RES, ...SEALED_DISGUISE_RES].some((re) => re.test(code));
}

/**
 * Checks whether a command is one sealed, read-only `node` script — the one
 * shape for which {@link evaluateRawShellConservative}'s coarse scan has
 * nothing left to catch, so a log-analysis script that merely holds `rm` or
 * `mkdir` in a regular expression, beside the state directory's path, is not
 * stopped by it.
 *
 * Every condition must hold, and anything not clearly recognised returns
 * `false`, which keeps the backstop running:
 *
 * - the tool is `Bash`, exactly. Windows PowerShell 5.1 rewrites embedded
 *   quotes when it hands an argument to a native program and reads U+2018 to
 *   U+201B as single quotes, so node could run different code than this guard
 *   read; a Codex shell tool's shell differs by platform;
 * - the whole command is {@link SEALED_NODE_COMMAND_RE}: one invocation, its
 *   code single-quoted — a POSIX shell expands and runs nothing inside — with
 *   nothing before `node` (no env prefix, no `cd`) and nothing after the
 *   closing quote (no pipe, redirect, `;`, `&&`, comment or second line). This
 *   is one test over the raw text, not statement parsing, so the backstop's
 *   own reason for ignoring statement boundaries is untouched;
 * - the code can neither run other code nor start a process
 *   ({@link sealedCodeRunsOther}): every `require` is a call naming one of
 *   `fs`, `path`, `os`, `util`, `readline`; every `process` is one of the
 *   harmless members; no word of {@link SEALED_ESCAPE_WORD_RE} appears; and no
 *   Unicode escape appears, since one inside an identifier would hide `eval`;
 * - the code cannot change a file: {@link nodeScriptChangesFiles}, the same
 *   list the deny half's read-only test uses, finds nothing — run on the
 *   code with `process.stdout.write(` and `process.stderr.write(` removed, the
 *   one place the exception reads output as output;
 * - the code does not name or build a capability in the ways
 *   {@link sealedCodeDisguises} lists, among them `fs` used as anything but
 *   `fs.<member>`, so no destructuring, enumeration or alias of `fs` is left to
 *   chase. These are stricter than the deny half's own test on purpose — here
 *   a miss silences the backstop outright.
 *
 * Such a script cannot invoke the approval CLI or remove anything either, so
 * both backstop arms are skipped. Code disguised past these lists — a name
 * assembled at run time by other means — is out of scope here exactly as it
 * is for the raw-text scan itself.
 *
 * @param {string} command The raw, unmodified command text.
 * @param {string} toolName The tool that issued the command.
 * @returns {boolean} `true` when the command is a sealed read-only script.
 */
function isSealedReadOnlyNodeCommand(command, toolName) {
  if (toolName !== "Bash") return false;

  const match = String(command || "").match(SEALED_NODE_COMMAND_RE);
  if (!match) return false;

  const code = match[1];
  if (sealedCodeRunsOther(code)) return false;

  const neutral = code.replace(NODE_STD_WRITE_RE, " (");
  if (sealedCodeDisguises(neutral)) return false;

  return !nodeScriptChangesFiles(neutral);
}

/**
 * Evaluates a shell tool call, statement by statement, so `cd x && softela-ai
 * approve y` is caught the same as the bare command. Falls back to
 * {@link evaluateRawShellConservative} when every precise statement-level
 * check stays silent, unless the whole command is already provably
 * read-only ({@link isWhollyReadOnlyCommand}) or is one sealed read-only
 * `node` script ({@link isSealedReadOnlyNodeCommand}).
 *
 * @param {object} ctx The evaluation context.
 * @returns {null | {action: string, reason: string, fix: string}} The first
 * statement's violation, the conservative fallback's `ask`, or `pass` when
 * neither applies.
 */
function evaluateShell(ctx) {
  const command = ctx.command || "";
  if (!command) return pass();
  const toolName = String(ctx.toolName || "");
  const isPosixShell = POSIX_SHELL_TOOLS.test(toolName);

  for (const stmt of splitStatements(command)) {
    const decision = evaluateShellStatement(stmt, isPosixShell, ctx.cwd || "");
    if (decision) return decision;
  }

  if (isWhollyReadOnlyCommand(command, isPosixShell) || isSealedReadOnlyNodeCommand(command, toolName)) return pass();

  return evaluateRawShellConservative(command);
}

module.exports = {
  id: "infra-self-protection",
  title: "Infrastructure writes ask; self-granted approvals are denied",
  events: ["PreToolUse"],
  tools: ALL_TOOLS,
  defaultAction: "deny",
  group: "agent",
  requiresConfig: [],

  /**
   * The only rule in the registry set to `true`. Ignores both the project
   * config's `rules` switch and the developer's own overrides file — a
   * softening file an agent can neither write nor disable is what makes
   * every other rule's softening a human act.
   */
  mandatory: true,

  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: string, reason: string, fix: string}} See
   * {@link evaluateFileWrite} and {@link evaluateShell}.
   */
  evaluate(ctx) {
    const toolName = String(ctx.toolName || "");
    if (FILE_TOOLS.test(toolName)) return evaluateFileWrite(ctx);
    if (SHELL_TOOLS.test(toolName)) return evaluateShell(ctx);
    return pass();
  },
};
