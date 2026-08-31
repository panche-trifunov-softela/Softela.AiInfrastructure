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
 * cannot close by adding more patterns.
 *
 * Paths come from `lib/paths.js`, this system's own canonical locations, not
 * from a hard-coded literal here — the same distinction that keeps a product
 * repository's filenames out of guard code.
 */

const path = require("path");
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

/**
 * Recognises an interpreter told to run a single inline script — `node -e`
 * or `node --eval`, `python -c` or `python3 -c` — right at a statement's
 * command start, the two shapes the closed-evasion suite below already
 * exercises for a genuine write.
 */
const NODE_INLINE_FLAG_RE = /\bnode(?:\.exe)?\s+(?:-\S+\s+)*(?:-e|--eval)\b/i;

/** The `python`/`python3 -c` counterpart to {@link NODE_INLINE_FLAG_RE}. */
const PYTHON_INLINE_FLAG_RE = /\bpython3?(?:\.exe)?\s+(?:-\S+\s+)*-c\b/i;

/**
 * Extracts the inline script text handed to `node -e`/`--eval` or
 * `python(3) -c`, so its own content — not the shell statement around it —
 * can be read for read-versus-write intent.
 *
 * @param {string} stmt A single statement's text.
 * @returns {string | null} The inline script's source text, or `null` when
 * the statement does not open with one of those interpreter invocations.
 */
function interpreterInlineScript(stmt) {
  if (NODE_INLINE_FLAG_RE.test(stmt)) return extractQuoted(stmt, NODE_INLINE_FLAG_RE);
  if (PYTHON_INLINE_FLAG_RE.test(stmt)) return extractQuoted(stmt, PYTHON_INLINE_FLAG_RE);
  return null;
}

/**
 * Calls, in either Node's or Python's standard library, that write, append,
 * rename or truncate a file — matched as a plain substring since an inline
 * script's own source text is arbitrary code this file has no reason to
 * parse.
 */
const INLINE_WRITE_INDICATOR_RE =
  /writefilesync|writefile\s*\(|createwritestream|appendfile|\.write\s*\(|open\([^)]*['"][wax]['"]/i;

/**
 * Checks whether an inline interpreter script provably only reads: it is a
 * recognised `node -e`/`python -c` invocation, and its own source text
 * carries none of {@link INLINE_WRITE_INDICATOR_RE}'s write calls. Mirrors
 * the same read-only reasoning `READ_ONLY_VERBS` applies to a shell verb,
 * for the one shape that list cannot name — an interpreter is not itself a
 * verb, only the script handed to it decides whether it writes.
 *
 * @param {string} stmt A single statement's text.
 * @returns {boolean} `true` when the statement is an inline interpreter
 * invocation whose script text carries no write call.
 */
function isInlineReadOnlyScript(stmt) {
  const script = interpreterInlineScript(stmt);
  return script !== null && !INLINE_WRITE_INDICATOR_RE.test(script);
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
 * on its own.
 *
 * @param {string} stmt A single statement's text.
 * @returns {boolean} `true` when the statement removes something by any of
 * those routes.
 */
function hasRemoveAction(stmt) {
  if (REMOVE_VERBS.some((verb) => hasCommand(stmt, verb))) return true;
  if (hasFindRemove(stmt)) return true;
  const script = interpreterInlineScript(stmt);
  return script !== null && INLINE_DESTRUCTIVE_INDICATOR_RE.test(script);
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
    (READ_ONLY_VERBS.some((verb) => hasCommand(stmt, verb)) || isInlineReadOnlyScript(stmt)) &&
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
 * Runs only once every precise check above has already found nothing, and
 * returns `ask` rather than `deny`: this scan is coarse by design and will
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

/**
 * Evaluates a shell tool call, statement by statement, so `cd x && softela-ai
 * approve y` is caught the same as the bare command. Falls back to
 * {@link evaluateRawShellConservative} when every precise statement-level
 * check stays silent, unless the whole command is already provably
 * read-only.
 *
 * @param {object} ctx The evaluation context.
 * @returns {null | {action: string, reason: string, fix: string}} The first
 * statement's violation, the conservative fallback's `ask`, or `pass` when
 * neither applies.
 */
function evaluateShell(ctx) {
  const command = ctx.command || "";
  if (!command) return pass();
  const isPosixShell = POSIX_SHELL_TOOLS.test(String(ctx.toolName || ""));
  for (const stmt of splitStatements(command)) {
    const decision = evaluateShellStatement(stmt, isPosixShell, ctx.cwd || "");
    if (decision) return decision;
  }
  if (isWhollyReadOnlyCommand(command, isPosixShell)) return pass();
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
