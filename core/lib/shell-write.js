"use strict";

/**
 * Finds every file path a shell command line WRITES, across POSIX shells and
 * PowerShell.
 *
 * Every file rule in `core/guards/` — `doc-comment-style`, `no-explicit-any`,
 * `naming-standards`, and the rest of the catalogue — fires only on a write
 * tool (`Write`, `Edit`, `apply_patch`, …). A shell command that lands the
 * same bytes on disk through `sed -i`, an output redirect, an inline
 * `node -e`/`python -c` script, a PowerShell cmdlet, a pathspec-scoped
 * `git checkout`/`restore`, a download (`curl`/`wget`/`Invoke-WebRequest`),
 * a copy (`xcopy`/`robocopy`), or a bulk operation that overwrites files it
 * never names (`git apply`/`am`, `Expand-Archive`, `tar -x`, `unzip` — the
 * last three reported only when an extraction destination is actually named
 * on the command line, leaving it to the guard's own exclusion checks to
 * tell a destination inside the repository's source tree from one that
 * plainly is not), bypasses every one of those rules.
 * This module is pure text analysis over the mechanisms a real shell or
 * interpreter actually uses to write a file — it never executes anything and
 * never throws. {@link WRITE_MECHANISMS} is the exact, finite catalogue —
 * read its own doc comment for what that boundary means and why it is a
 * deny-list on purpose.
 *
 * A deliberate omission sits alongside that deny-list, not a mechanism gap:
 * `git restore --staged` (with no `--worktree`), `git stash pop`/`apply`,
 * `git revert`, and `git cherry-pick` restore the developer's own prior work
 * or move commits rather than landing unreviewed external content, which is
 * what this module and the guard built on it exist to catch. None of them is
 * recognised here, on purpose, so a routine "unstage and redo" or "undo my
 * last commit" is never asked about.
 *
 * `core/guards/infra-self-protection.js` solves a narrower version of the
 * same problem (detecting a shell write aimed at this tool's own installed
 * files) and its detection surface — quote-masking, `hasOutputRedirect`, the
 * `node -e`/`python -c` inline-source extraction — is the design this module
 * borrows from. It is a fresh implementation, not a shared one: that file
 * deliberately keeps its own private copy so it cannot be disarmed by
 * tampering with a shared library, and this module must not undo that.
 */

const { splitStatements, splitTokens, extractQuoted } = require("./shell-parse");

/**
 * Masks quoted regions for operator/pipe scanning, honouring the calling
 * shell's own escaping rules.
 *
 * `shell-parse.js` keeps its own equivalent private — it is not part of that
 * module's exported surface — so this module carries its own copy rather
 * than reaching into another module's internals. A POSIX statement uses
 * {@link maskPosix}, which treats a backslash right before a double quote's
 * closing character as an escape — correct for `bash`/`sh`. A PowerShell
 * statement never does that: PowerShell has no backslash-escape convention
 * at all, so a Windows path ending in a backslash right before a closing
 * quote (`"C:\foo\"`) would have its quote boundary miscomputed by the POSIX
 * rule. {@link maskNoEscape} masks the same way without that rule.
 *
 * @param {string} stmt A single statement's text.
 * @param {boolean} isPosix Whether the enclosing shell follows POSIX
 * word-splitting and escaping rules.
 * @returns {string} The statement with quoted contents masked, same length.
 */
function maskForScan(stmt, isPosix) {
  return isPosix ? maskPosix(stmt) : maskNoEscape(stmt);
}

/**
 * Checks whether `${IFS}` or a word-bounded bare `$IFS` starts at a given
 * position — the whitespace field-separator spellings a POSIX shell treats
 * as interchangeable with ordinary whitespace, so a verb or operator split
 * across either one is not hidden inside what looks like one opaque token.
 *
 * @param {string} str The text to inspect.
 * @param {number} i The position to check.
 * @returns {number} The matched spelling's length (`6` for `${IFS}`, `4` for
 * a bare `$IFS`), or `0` when neither spelling starts there.
 */
function ifsTokenLengthAt(str, i) {
  if (str.startsWith("${IFS}", i)) return 6;
  if (str.startsWith("$IFS", i) && !/[A-Za-z0-9_]/.test(str[i + 4] || "")) return 4;
  return 0;
}

/**
 * Masks quoted regions the way a POSIX shell parses them: a backslash right
 * before a double quote's closing character is an escape, `${IFS}`/a bare
 * `$IFS` is neutralised the same as ordinary whitespace, and an ANSI-C
 * `$'...'` opener is treated the same as a plain single quote.
 *
 * @param {string} str The raw text to mask.
 * @returns {string} The text with quoted contents replaced by a filler
 * character, the same length as the input.
 */
function maskPosix(str) {
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

    if (ch === "\\" && s[i + 1] === "\n") {
      out += "  ";
      i += 2;
      continue;
    }

    const ifsLen = ifsTokenLengthAt(s, i);
    if (ifsLen) {
      out += " ".repeat(ifsLen);
      i += ifsLen;
      continue;
    }

    if (ch === "$" && s[i + 1] === "'") {
      quote = "'";
      out += ch + s[i + 1];
      i += 2;
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
 * Masks quoted regions with no backslash-escape handling at all — the
 * PowerShell counterpart to {@link maskPosix}.
 *
 * @param {string} str The raw text to mask.
 * @returns {string} The text with quoted contents replaced by a filler
 * character, the same length as the input.
 */
function maskNoEscape(str) {
  const s = String(str || "");
  let out = "";
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      out += ch === quote ? ch : "#";
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Splits a single statement into its unquoted pipeline stages, so a write
 * cmdlet or command reached through `|` (`$code | Out-File a.ts`) is scanned
 * on its own segment rather than the whole statement at once.
 *
 * @param {string} stmt A single statement's text.
 * @param {boolean} isPosix Whether the enclosing shell follows POSIX
 * escaping rules — see {@link maskForScan}.
 * @returns {string[]} The statement's pipeline stages, in order.
 */
function splitPipeSegments(stmt, isPosix) {
  const masked = maskForScan(stmt, isPosix);
  const segments = [];
  let start = 0;
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] === "|") {
      segments.push(stmt.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(stmt.slice(start));
  return segments;
}

/**
 * Reads one shell word starting at a position, skipping leading whitespace
 * and dequoting when the word opens with a quote.
 *
 * @param {string} str The text to read from — the original, unmasked
 * statement, so the returned value carries the real characters.
 * @param {number} start The position to start reading from.
 * @param {boolean} isPosix Whether a backslash right before a double quote's
 * closing character is an escape — see {@link maskForScan}.
 * @returns {null | {value: string, end: number}} The word's dequoted value
 * and the position right after it, or `null` when nothing follows.
 */
function readWord(str, start, isPosix) {
  let i = start;
  while (i < str.length && /\s/.test(str[i])) i += 1;
  if (i >= str.length) return null;

  const ch = str[i];
  if (ch === '"' || ch === "'") {
    let out = "";
    let j = i + 1;
    while (j < str.length && str[j] !== ch) {
      if (isPosix && ch === '"' && str[j] === "\\" && j + 1 < str.length) {
        out += str[j + 1];
        j += 2;
        continue;
      }
      out += str[j];
      j += 1;
    }
    return { value: out, end: j < str.length ? j + 1 : j };
  }

  const stopRe = /[\s;&|)`]/;
  let j = i;
  while (j < str.length && !stopRe.test(str[j])) j += 1;
  return { value: str.slice(i, j), end: j };
}

/** Sinks that are not a write target at all: null devices, either OS's spelling. */
const NULL_SINK_RE = /^(?:\/dev\/null|\$null|nul)$/i;

/**
 * Characters whose presence in an extracted path mean it names a variable, a
 * command substitution, or a glob rather than a concrete literal — the
 * `certain: false` signal.
 */
const UNRESOLVED_RE = /[$`*?]/;

/**
 * Records one write target, applying the two blanket exclusions every
 * mechanism shares: an empty or null-device value is not a target at all,
 * and a value carrying an unresolved expression is reported uncertain rather
 * than guessed at.
 *
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @param {string | null | undefined} rawValue The extracted path text.
 * @param {string} mechanism The mechanism name to report.
 * @returns {void}
 */
function pushTarget(out, rawValue, mechanism) {
  const value = String(rawValue || "").trim();
  if (!value) return;
  if (NULL_SINK_RE.test(value)) return;
  out.push({ path: value, mechanism, certain: !UNRESOLVED_RE.test(value) });
}

/**
 * Records an uncertain write target — one whose mechanism is proven present
 * but whose actual file names cannot be determined from the command line at
 * all, so no path is guessed at.
 *
 * Two shapes share this:
 *
 * - The inline-interpreter counterpart to a redirect or a PowerShell cmdlet
 *   whose argument was a variable rather than a literal: the mechanism
 *   itself proves a write call is present (a recognised function name was
 *   matched in the script text), but there is no quoted literal argument to
 *   report at all, only a computed expression (`path.join(dir, x)`, a bare
 *   identifier used as the mode-bearing argument, …). No `rawPath` is passed
 *   for this shape.
 * - A mechanism that writes an unknown, unnameable set of files by its very
 *   nature — `git apply`, `git am`, a bulk archive extraction — where a
 *   destination directory may still be known (`rawPath`) even though which
 *   files land inside it is not. `rawPath` here is carried only so the
 *   caller can still exclude an obviously-not-source destination (`dist/`,
 *   the OS temp directory, outside the repository); it is never treated as
 *   `certain`, because it never names the actual file.
 *
 * Unlike {@link pushTarget}, an empty path is not filtered out here — there
 * being no extractable path is exactly the fact this target reports, and it
 * is what routes the caller to `ask` rather than silently dropping a real
 * write call.
 *
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @param {string} mechanism The mechanism name to report.
 * @param {string} [rawPath] A known destination directory, when one exists,
 * carried for exclusion purposes only — never implies a named file.
 * @returns {void}
 */
function pushUncertainTarget(out, mechanism, rawPath) {
  out.push({ path: String(rawPath || "").trim(), mechanism, certain: false });
}

/**
 * Matches a POSIX output-redirect operator: `>`/`>>`, with an optional
 * leading file-descriptor number, not immediately followed by `&` — which is
 * a fd duplication (`2>&1`, `>&2`) rather than a write to a file.
 */
const REDIRECT_OP_RE = /\d*>>?(?!&)/g;

/**
 * Finds every POSIX output-redirect target in a statement — `> path`,
 * `>> path`, a stderr-only `2> path`, and the same combined with a trailing
 * heredoc opener (`cat > path <<'EOF'`), since the heredoc opener itself
 * carries no path and the redirect before it already does.
 *
 * @param {string} stmt A single statement's text.
 * @param {boolean} isPosix Whether the enclosing shell follows POSIX
 * escaping rules.
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @returns {void}
 */
function collectRedirectTargets(stmt, isPosix, out) {
  const masked = maskForScan(stmt, isPosix);
  REDIRECT_OP_RE.lastIndex = 0;
  let m;
  while ((m = REDIRECT_OP_RE.exec(masked))) {
    const word = readWord(stmt, m.index + m[0].length, isPosix);
    pushTarget(out, word && word.value, "redirect");
  }
}

/**
 * Finds every `tee` target in a pipeline segment's tokens — `tee path` and
 * `tee -a path`, and `tee` writing to several files at once.
 *
 * @param {string[]} tokens A pipeline segment's dequoted tokens.
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @returns {void}
 */
function collectTeeTargets(tokens, out) {
  const idx = tokens.findIndex((t) => /^tee$/i.test(t));
  if (idx === -1) return;
  for (let i = idx + 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (/^-/.test(t)) continue;
    pushTarget(out, t, "tee");
  }
}

/** The four PowerShell cmdlets that write their input to a file. */
const PS_WRITE_CMDLETS = ["out-file", "set-content", "add-content", "tee-object"];

/** The named-parameter spellings that carry a write cmdlet's target path. */
const PS_PATH_FLAG_RE = /^-(?:path|filepath|literalpath)$/i;

/**
 * Finds every PowerShell write-cmdlet target in a pipeline segment's tokens —
 * `Out-File`, `Set-Content`, `Add-Content`, `Tee-Object`. The path comes from
 * a named `-Path`/`-FilePath`/`-LiteralPath` argument when one is present,
 * otherwise the first positional argument after the cmdlet name.
 *
 * @param {string[]} tokens A pipeline segment's dequoted tokens.
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @returns {void}
 */
function collectPowerShellCmdletTargets(tokens, out) {
  for (const cmdlet of PS_WRITE_CMDLETS) {
    const idx = tokens.findIndex((t) => t.toLowerCase() === cmdlet);
    if (idx === -1) continue;
    const mechanism = `powershell-${cmdlet}`;

    const namedIdx = tokens.findIndex((t, i) => i > idx && PS_PATH_FLAG_RE.test(t));
    if (namedIdx !== -1 && tokens[namedIdx + 1] !== undefined) {
      pushTarget(out, tokens[namedIdx + 1], mechanism);
      continue;
    }

    const positional = tokens.slice(idx + 1).find((t) => !/^-/.test(t));
    if (positional !== undefined) pushTarget(out, positional, mechanism);
  }
}

/** The flag spellings whose value is the sed/perl script or expression, not a target file. */
const SCRIPT_FLAG_RE = /^(?:-e|--expression|-f|--file)$/i;

/**
 * Checks whether `sed`'s own in-place flag (`-i`, `-i.bak`, `--in-place`)
 * appears among the flags right after the command name.
 *
 * @param {string[]} tokens A pipeline segment's dequoted tokens.
 * @param {number} cmdIdx The index of the `sed` token.
 * @returns {boolean} `true` when an in-place flag is present.
 */
function isSedInPlace(tokens, cmdIdx) {
  for (let i = cmdIdx + 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (!/^-/.test(t)) break;
    if (/^-i/.test(t) || /^--in-place\b/i.test(t)) return true;
  }
  return false;
}

/**
 * Checks whether `perl`'s own in-place flag (`-i`, `-pi`, `-ni`, any combined
 * single-dash form carrying a lower-case `i`) appears among the flags right
 * after the command name. Case matters: `-I` is perl's unrelated
 * library-include-path flag.
 *
 * @param {string[]} tokens A pipeline segment's dequoted tokens.
 * @param {number} cmdIdx The index of the `perl` token.
 * @returns {boolean} `true` when an in-place flag is present.
 */
function isPerlInPlace(tokens, cmdIdx) {
  for (let i = cmdIdx + 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (!/^-/.test(t)) break;
    if (/^-[a-z]*i[a-z]*$/.test(t)) return true;
  }
  return false;
}

/**
 * Finds every `sed -i`/`sed --in-place` or `perl -i`/`-pi`/`-ni` target in a
 * pipeline segment's tokens. The trailing non-flag operands are the target
 * files; when an explicit `-e`/`-f` script flag is present, every remaining
 * non-flag operand is a target, otherwise the first one is the inline
 * script/expression itself and only the rest are targets.
 *
 * @param {string[]} tokens A pipeline segment's dequoted tokens.
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @returns {void}
 */
function collectSedPerlTargets(tokens, out) {
  const sedIdx = tokens.findIndex((t) => /^sed$/i.test(t));
  const perlIdx = tokens.findIndex((t) => /^perl$/i.test(t));
  const isSed = sedIdx !== -1;
  const cmdIdx = isSed ? sedIdx : perlIdx;
  if (cmdIdx === -1) return;
  if (isSed ? !isSedInPlace(tokens, cmdIdx) : !isPerlInPlace(tokens, cmdIdx)) return;

  let sawScriptFlag = false;
  const operands = [];
  let i = cmdIdx + 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (SCRIPT_FLAG_RE.test(t)) {
      sawScriptFlag = true;
      i += 2; // the flag and its value — the script/expression — are both consumed
      continue;
    }
    if (/^-/.test(t)) {
      i += 1;
      continue;
    }
    operands.push(t);
    i += 1;
  }

  const targets = sawScriptFlag ? operands : operands.slice(1);
  const mechanism = isSed ? "sed-inplace" : "perl-inplace";
  for (const target of targets) pushTarget(out, target, mechanism);
}

/** `cp`/`mv` and their Windows and PowerShell equivalents. */
const COPY_MOVE_VERB_RE = /^(?:cp|mv|copy|move|copy-item|move-item)$/i;

/** The named-parameter spellings that carry `Copy-Item`/`Move-Item`'s destination. */
const PS_DEST_FLAG_RE = /^-(?:destination|dest)$/i;

/**
 * Finds the destination of a `cp`/`mv`/`copy`/`move`/`Copy-Item`/`Move-Item`
 * invocation in a pipeline segment's tokens. A PowerShell cmdlet's named
 * `-Destination`/`-Dest` argument wins when present; otherwise the last
 * non-flag operand is the destination, which requires at least two operands
 * to be meaningful (a lone operand is a source with no discoverable target).
 *
 * @param {string[]} tokens A pipeline segment's dequoted tokens.
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @returns {void}
 */
function collectCopyMoveTargets(tokens, out) {
  const idx = tokens.findIndex((t) => COPY_MOVE_VERB_RE.test(t));
  if (idx === -1) return;
  const isPowerShellCmdlet = /^(?:copy-item|move-item)$/i.test(tokens[idx]);

  if (isPowerShellCmdlet) {
    const destIdx = tokens.findIndex((t, i) => i > idx && PS_DEST_FLAG_RE.test(t));
    if (destIdx !== -1 && tokens[destIdx + 1] !== undefined) {
      pushTarget(out, tokens[destIdx + 1], "copy-move");
      return;
    }
  }

  const operands = tokens.slice(idx + 1).filter((t) => !/^-/.test(t));
  if (operands.length >= 2) pushTarget(out, operands[operands.length - 1], "copy-move");
}

/** The flag spellings that carry `truncate`'s size argument, never a path. */
const TRUNCATE_SIZE_FLAG_RE = /^(?:-s|--size)$/i;

/**
 * Finds every `truncate` target in a pipeline segment's tokens, skipping the
 * size flag and its value.
 *
 * @param {string[]} tokens A pipeline segment's dequoted tokens.
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @returns {void}
 */
function collectTruncateTargets(tokens, out) {
  const idx = tokens.findIndex((t) => /^truncate$/i.test(t));
  if (idx === -1) return;
  let i = idx + 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (TRUNCATE_SIZE_FLAG_RE.test(t)) {
      i += 2; // the flag and its size value
      continue;
    }
    if (/^-/.test(t)) {
      i += 1;
      continue;
    }
    pushTarget(out, t, "truncate");
    i += 1;
  }
}

/**
 * Finds `dd`'s `of=<path>` output-file argument in a pipeline segment's
 * tokens.
 *
 * @param {string[]} tokens A pipeline segment's dequoted tokens.
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @returns {void}
 */
function collectDdTargets(tokens, out) {
  const idx = tokens.findIndex((t) => /^dd$/i.test(t));
  if (idx === -1) return;
  for (let i = idx + 1; i < tokens.length; i += 1) {
    const m = /^of=(.+)$/i.exec(tokens[i]);
    if (m) pushTarget(out, m[1], "dd");
  }
}

/**
 * Finds `New-Item -Force -Path <path>` in a pipeline segment's tokens.
 * `-Force` matters: without it, `New-Item` refuses to overwrite an existing
 * file rather than truncating it, so a bare `New-Item` is not treated as a
 * write to an existing source file here.
 *
 * @param {string[]} tokens A pipeline segment's dequoted tokens.
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @returns {void}
 */
function collectNewItemTargets(tokens, out) {
  const idx = tokens.findIndex((t) => /^new-item$/i.test(t));
  if (idx === -1) return;
  const hasForce = tokens.slice(idx + 1).some((t) => /^-force$/i.test(t));
  if (!hasForce) return;

  const namedIdx = tokens.findIndex((t, i) => i > idx && PS_PATH_FLAG_RE.test(t));
  if (namedIdx !== -1 && tokens[namedIdx + 1] !== undefined) {
    pushTarget(out, tokens[namedIdx + 1], "new-item-force");
    return;
  }
  const positional = tokens.slice(idx + 1).find((t) => !/^-/.test(t));
  if (positional !== undefined) pushTarget(out, positional, "new-item-force");
}

/**
 * Windows-style switches, spelled with a leading `/` rather than `-` —
 * `xcopy`'s and `robocopy`'s own convention, distinct from every other
 * token-based detector in this module.
 */
const WINDOWS_SWITCH_RE = /^\//;

/**
 * Finds `xcopy`'s destination — its second non-switch operand, source being
 * the first. A single operand (a source with nothing else) reports nothing,
 * the same as `cp`/`mv` with only one operand.
 *
 * @param {string[]} tokens A pipeline segment's dequoted tokens.
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @returns {void}
 */
function collectXcopyTargets(tokens, out) {
  const idx = tokens.findIndex((t) => /^xcopy$/i.test(t));
  if (idx === -1) return;
  const operands = tokens.slice(idx + 1).filter((t) => !WINDOWS_SWITCH_RE.test(t));
  if (operands.length >= 2) pushTarget(out, operands[1], "xcopy");
}

/**
 * Finds `robocopy`'s write target. `robocopy source destination [file
 * [file]...] [/switches]` copies an entire directory by default — which
 * files land under the destination is not written down anywhere on the
 * command line unless individual files are explicitly listed, and even then
 * `robocopy`'s own wildcard and mirroring switches (`/MIR`, `/E`, …) can
 * still pull in files never named. Rather than guess, this is always
 * reported uncertain: the destination directory is carried when present, so
 * an obviously-not-source destination (`dist/`, outside the repository) is
 * still excluded by the caller, but no individual file name is ever treated
 * as certain.
 *
 * @param {string[]} tokens A pipeline segment's dequoted tokens.
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @returns {void}
 */
function collectRobocopyTargets(tokens, out) {
  const idx = tokens.findIndex((t) => /^robocopy$/i.test(t));
  if (idx === -1) return;
  const operands = tokens.slice(idx + 1).filter((t) => !WINDOWS_SWITCH_RE.test(t));
  pushUncertainTarget(out, "robocopy", operands.length >= 2 ? operands[1] : "");
}

/**
 * Finds the index of a `git` subcommand token, immediately following the
 * `git` token itself. A `git` invocation that inserts a global option before
 * the subcommand (`git -C dir checkout …`) is a known gap: recognising it
 * would mean walking past an open-ended set of global flags, some of which
 * take a value and some of which do not, for a shape rare enough in
 * practice that the added complexity was not judged worth it here.
 *
 * @param {string[]} tokens A pipeline segment's dequoted tokens.
 * @param {RegExp} subcommandRe Pattern the subcommand token must match.
 * @returns {number} The subcommand's index, or `-1` when not found.
 */
function findGitSubcommandIndex(tokens, subcommandRe) {
  const gitIdx = tokens.findIndex((t) => /^git$/i.test(t));
  if (gitIdx === -1) return -1;
  return subcommandRe.test(tokens[gitIdx + 1] || "") ? gitIdx + 1 : -1;
}

/**
 * Finds `git checkout <ref>? -- <path>...` targets — the pathspec-scoped
 * form, which overwrites exactly the named working-tree files from another
 * ref or the index. A bare `git checkout <branch>` (no `--`) switches
 * branches instead, which can rewrite an unbounded set of files nowhere
 * named on the command line; that form is deliberately left unhandled here
 * rather than treated as an always-uncertain bulk write, because switching
 * branches is ordinary, frequent developer workflow — flagging every one of
 * them would be constant noise for a case this project already relies on
 * elsewhere (see `~/.claude/CLAUDE.md` §6 on this same command).
 *
 * @param {string[]} tokens A pipeline segment's dequoted tokens.
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @returns {void}
 */
function collectGitCheckoutTargets(tokens, out) {
  const idx = findGitSubcommandIndex(tokens, /^checkout$/i);
  if (idx === -1) return;
  const sepIdx = tokens.findIndex((t, i) => i > idx && t === "--");
  if (sepIdx === -1) return;
  for (let i = sepIdx + 1; i < tokens.length; i += 1) {
    pushTarget(out, tokens[i], "git-checkout");
  }
}

/**
 * Finds `git restore`'s pathspec targets — unlike `checkout`, `restore`
 * always names the files it overwrites as trailing operands, with or
 * without an explicit `--` separator, so every one of them is a certain
 * target. `--source=<ref>`/`--source <ref>`/`-s <ref>` names the ref to
 * restore from, not a target, and is skipped along with every other flag.
 *
 * `--staged`/`-S` restores the index only and leaves the working tree
 * byte-identical — the routine "unstage before recommitting" move — unless
 * `--worktree`/`-W` is also present, in which case the working tree is
 * overwritten too. A staged-only invocation (`--staged` present,
 * `--worktree` absent) reports nothing at all rather than a false certain
 * target; restoring with neither flag, or with `--worktree` present, keeps
 * reporting exactly as before.
 *
 * @param {string[]} tokens A pipeline segment's dequoted tokens.
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @returns {void}
 */
function collectGitRestoreTargets(tokens, out) {
  const idx = findGitSubcommandIndex(tokens, /^restore$/i);
  if (idx === -1) return;

  const flags = tokens.slice(idx + 1);
  const staged = flags.some((t) => /^--staged$/i.test(t) || t === "-S");
  const worktree = flags.some((t) => /^--worktree$/i.test(t) || t === "-W");
  if (staged && !worktree) return;

  const valueFlagRe = /^(?:--source|-s)$/i;
  let i = idx + 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "--" || /^--source=/i.test(t)) {
      i += 1;
      continue;
    }
    if (valueFlagRe.test(t)) {
      i += 2;
      continue;
    }
    if (/^-/.test(t)) {
      i += 1;
      continue;
    }
    pushTarget(out, t, "git-restore");
    i += 1;
  }
}

/**
 * Finds `git apply` invocations that write — the target files are named
 * only inside the patch text, never on the command line, so this always
 * reports an uncertain, pathless target rather than guessing at the patch
 * file's own name. `--check`/`--stat`/`--numstat`/`--summary` inspect a
 * patch without applying it and are excluded.
 *
 * @param {string[]} tokens A pipeline segment's dequoted tokens.
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @returns {void}
 */
function collectGitApplyTargets(tokens, out) {
  const idx = findGitSubcommandIndex(tokens, /^apply$/i);
  if (idx === -1) return;
  const inspectOnlyRe = /^--(?:check|stat|numstat|summary)$/i;
  if (tokens.slice(idx + 1).some((t) => inspectOnlyRe.test(t))) return;
  pushUncertainTarget(out, "git-apply");
}

/**
 * Finds `git am` invocations that write — same reasoning as
 * {@link collectGitApplyTargets}, applying a mailbox of patches whose target
 * files are never named on the command line. `--abort`/`--skip`/`--quit`/
 * `--show-current-patch` are control operations on an in-progress `am`
 * session rather than a fresh apply, and are excluded.
 *
 * @param {string[]} tokens A pipeline segment's dequoted tokens.
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @returns {void}
 */
function collectGitAmTargets(tokens, out) {
  const idx = findGitSubcommandIndex(tokens, /^am$/i);
  if (idx === -1) return;
  const controlOnlyRe = /^--(?:abort|skip|quit|show-current-patch)$/i;
  if (tokens.slice(idx + 1).some((t) => controlOnlyRe.test(t))) return;
  pushUncertainTarget(out, "git-am");
}

/** `curl`'s explicit output flag — lower-case `-o` only; `--output` may also take an `=`-joined value. */
const CURL_OUTPUT_FLAG_RE = /^(?:-o|--output)$/;

/** `curl -O` — remote-name mode, upper-case only and distinct from `-o`; takes no argument. */
const CURL_REMOTE_NAME_RE = /^-O$/;

/**
 * Finds `curl`'s write target. `-o`/`--output`/`--output=<path>` name it
 * explicitly and certainly. `-O` (upper case; curl's `-o` and `-O` are
 * different flags, not a case-insensitive pair) writes a file too, but names
 * it only from the remote URL, so it is reported as an uncertain, pathless
 * target rather than parsed out of the URL. A `curl` call with neither flag
 * streams to stdout and writes no file at all, so nothing is reported.
 *
 * @param {string[]} tokens A pipeline segment's dequoted tokens.
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @returns {void}
 */
function collectCurlTargets(tokens, out) {
  const idx = tokens.findIndex((t) => /^curl(?:\.exe)?$/i.test(t));
  if (idx === -1) return;
  for (let i = idx + 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    const eqMatch = /^--output=(.+)$/.exec(t);
    if (eqMatch) {
      pushTarget(out, eqMatch[1], "curl");
      continue;
    }
    if (CURL_OUTPUT_FLAG_RE.test(t)) {
      pushTarget(out, tokens[i + 1], "curl");
      i += 1;
      continue;
    }
    if (CURL_REMOTE_NAME_RE.test(t)) pushUncertainTarget(out, "curl");
  }
}

/**
 * Finds `wget`'s write target via `-O`/`--output-document`/
 * `--output-document=<path>` (wget's `-O` is upper case and always takes a
 * value — unlike curl's own `-O`, an unrelated flag spelled the same way).
 * A bare `wget <url>` with neither flag still writes a file, named from the
 * URL by default; that default-naming shape is a known, deliberately
 * unhandled gap here — see the module doc comment.
 *
 * @param {string[]} tokens A pipeline segment's dequoted tokens.
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @returns {void}
 */
function collectWgetTargets(tokens, out) {
  const idx = tokens.findIndex((t) => /^wget(?:\.exe)?$/i.test(t));
  if (idx === -1) return;
  for (let i = idx + 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    const eqMatch = /^--output-document=(.+)$/i.exec(t);
    if (eqMatch) {
      pushTarget(out, eqMatch[1], "wget");
      continue;
    }
    if (/^(?:-O|--output-document)$/i.test(t)) {
      pushTarget(out, tokens[i + 1], "wget");
      i += 1;
    }
  }
}

/**
 * Finds `Invoke-WebRequest`'s (and its `iwr` alias's) write target via a
 * named `-OutFile` argument. With no `-OutFile`, the cmdlet returns its
 * response as an object rather than writing to disk, so nothing is
 * reported.
 *
 * @param {string[]} tokens A pipeline segment's dequoted tokens.
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @returns {void}
 */
function collectInvokeWebRequestTargets(tokens, out) {
  const idx = tokens.findIndex((t) => /^(?:invoke-webrequest|iwr)$/i.test(t));
  if (idx === -1) return;
  const namedIdx = tokens.findIndex((t, i) => i > idx && /^-outfile$/i.test(t));
  if (namedIdx !== -1 && tokens[namedIdx + 1] !== undefined) {
    pushTarget(out, tokens[namedIdx + 1], "invoke-webrequest");
  }
}

/** The named-parameter spellings that carry `Expand-Archive`'s destination. */
const PS_DESTINATION_FLAG_RE = /^-(?:destinationpath|destination)$/i;

/**
 * Finds `Expand-Archive`'s write target. Which files an archive contains is
 * never on the command line, so this is always reported uncertain — but only
 * when a `-DestinationPath`/`-Destination` argument is actually present.
 * With neither, `Expand-Archive` extracts into the current directory and
 * nothing is reported at all: there is no named destination to weigh against
 * the guard's own exclusion checks (a build/dependency directory, this
 * process's OS temp directory, outside the repository — see
 * `core/guards/shell-file-write.js#isClearlyNotSource`), and reporting an
 * empty path would only ever route to an `ask` no exclusion check could ever
 * rule out.
 *
 * @param {string[]} tokens A pipeline segment's dequoted tokens.
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @returns {void}
 */
function collectExpandArchiveTargets(tokens, out) {
  const idx = tokens.findIndex((t) => /^expand-archive$/i.test(t));
  if (idx === -1) return;
  const namedIdx = tokens.findIndex((t, i) => i > idx && PS_DESTINATION_FLAG_RE.test(t));
  const dest = namedIdx !== -1 ? tokens[namedIdx + 1] : "";
  if (!String(dest || "").trim()) return;
  pushUncertainTarget(out, "expand-archive", dest);
}

/**
 * Checks whether a `tar` invocation runs in extract mode: the long
 * `--extract` spelling, a dashed short-option cluster containing `x`
 * (`-x`, `-xvf`, …), or `tar`'s old-style bundled form with no leading dash
 * at all (`tar xzf archive.tar.gz`) — recognised only as the very first
 * argument after `tar`, which is the form that shape is conventionally
 * written in; scanning every later bare word for a stray `x` would be far
 * too eager to trust.
 *
 * @param {string[]} tokens A pipeline segment's dequoted tokens.
 * @param {number} idx The index of the `tar` token.
 * @returns {boolean} `true` when this invocation extracts.
 */
function isTarExtractMode(tokens, idx) {
  const first = tokens[idx + 1] || "";
  if (/^[a-z]+$/i.test(first) && /x/i.test(first)) return true;
  return tokens.slice(idx + 1).some((t) => /^--extract$/i.test(t) || /^-[a-z]*x[a-z]*$/i.test(t));
}

/**
 * Finds `tar`'s extraction target. Which member files a `tar` archive
 * contains is never on the command line, so this is always reported
 * uncertain — but only when `-C`/`--directory`/`--directory=<dir>` actually
 * names an extraction directory. With none of those, `tar` extracts into the
 * current directory and nothing is reported at all: an unanchored
 * `tar xzf archive.tgz` names no destination to weigh against the guard's
 * own exclusion checks (a build/dependency directory, OS temp, outside the
 * repository — see `core/guards/shell-file-write.js#isClearlyNotSource`),
 * and reporting an empty path would only ever route to an `ask` no exclusion
 * check could ever rule out.
 *
 * @param {string[]} tokens A pipeline segment's dequoted tokens.
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @returns {void}
 */
function collectTarTargets(tokens, out) {
  const idx = tokens.findIndex((t) => /^tar(?:\.exe)?$/i.test(t));
  if (idx === -1) return;
  if (!isTarExtractMode(tokens, idx)) return;

  const eqMatch = tokens.slice(idx + 1).find((t) => /^--directory=/i.test(t));
  if (eqMatch) {
    const dir = eqMatch.replace(/^--directory=/i, "");
    if (String(dir || "").trim()) pushUncertainTarget(out, "tar-extract", dir);
    return;
  }
  const dirIdx = tokens.findIndex((t, i) => i > idx && /^(?:-C|--directory)$/i.test(t));
  const dir = dirIdx !== -1 ? tokens[dirIdx + 1] : "";
  if (String(dir || "").trim()) pushUncertainTarget(out, "tar-extract", dir);
}

/**
 * Finds `unzip`'s extraction target. Same reasoning as
 * {@link collectTarTargets}: uncertain, and reported only when `-d <dir>` is
 * actually present — `unzip` with no `-d` extracts into the current
 * directory and nothing is reported at all.
 *
 * @param {string[]} tokens A pipeline segment's dequoted tokens.
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @returns {void}
 */
function collectUnzipTargets(tokens, out) {
  const idx = tokens.findIndex((t) => /^unzip$/i.test(t));
  if (idx === -1) return;
  const dIdx = tokens.findIndex((t, i) => i > idx && /^-d$/i.test(t));
  const dest = dIdx !== -1 ? tokens[dIdx + 1] : "";
  if (String(dest || "").trim()) pushUncertainTarget(out, "unzip", dest);
}

/** `node -e`/`--eval`, right at a statement's command start. */
const NODE_INLINE_RE = /\bnode(?:\.exe)?\s+(?:-\S+\s+)*(?:-e|--eval)\b/i;

/** `python`/`python3 -c`, the same shape for Python. */
const PYTHON_INLINE_RE = /\bpython3?(?:\.exe)?\s+(?:-\S+\s+)*-c\b/i;

/**
 * Node and Python standard-library calls that write a file, each capturing
 * the first string-literal argument as the target path when the call was
 * written with a literal rather than a computed expression.
 *
 * The Node methods are matched on the method name alone, with no required
 * `fs.` prefix: the realistic inline shape is `require('fs').writeFileSync(
 * …)`, which never contains the literal substring `fs.writeFileSync` at all
 * — `fs` is `require`'s own argument, not a receiver identifier — and a
 * destructured `const { writeFileSync } = require('fs')` does not either.
 * The method names are distinctive enough on their own.
 */
const INLINE_WRITE_CALL_PATTERNS = [
  /\bwriteFileSync\s*\(\s*(["'])((?:\\.|(?!\1).)*)\1/g,
  /\bappendFileSync\s*\(\s*(["'])((?:\\.|(?!\1).)*)\1/g,
  /\bcreateWriteStream\s*\(\s*(["'])((?:\\.|(?!\1).)*)\1/g,
  /\bopen\(\s*(["'])((?:\\.|(?!\1).)*)\1\s*,\s*["'](?:w\+?|a|wb)["']/g,
  /Path\(\s*(["'])((?:\\.|(?!\1).)*)\1\s*\)\.write_text\(/g,
];

/**
 * Recognises the same write calls as {@link INLINE_WRITE_CALL_PATTERNS}, but
 * without requiring a quoted literal argument — the fallback that catches a
 * genuine write call whose path is a computed expression
 * (`fs.writeFileSync(path.join(dir, x), s)`, `open(target, 'w')`,
 * `Path(target).write_text(...)`) rather than a string literal.
 *
 * `writeFileSync`/`appendFileSync`/`createWriteStream`/`.write_text(` are
 * matched on the method name alone: none of them has a same-named read
 * counterpart, so the name by itself already proves a write. `open(...)` is
 * the one call with a real read/write ambiguity — Python's default mode is
 * read — so it additionally requires an explicit write-ish mode string
 * (`'w'`, `'a'`, `'w+'`, `'wb'`, `'ab'`, `'xb'`) as its second argument;
 * `open(p)` and `open(p, 'r')` do not match. The first argument itself may be
 * any expression, not only a bare identifier, as long as it carries no
 * top-level comma or parenthesis of its own — a nested call
 * (`open(os.path.join(a, b), 'w')`) is a known gap this pattern does not see
 * through.
 */
const INLINE_WRITE_INDICATOR_RE =
  /\bwriteFileSync\s*\(|\bappendFileSync\s*\(|\bcreateWriteStream\s*\(|\bopen\(\s*[^,()]*,\s*["'](?:[wax]\+?|wb|ab|xb)["']|\.write_text\s*\(/;

/**
 * Collapses a backslash-escaped character pair to the character it
 * represents — a plain, non-shell-aware unescape for a literal captured out
 * of an inline script's own string syntax.
 *
 * @param {string} s The text to unescape.
 * @returns {string} The text with every `\x` pair collapsed to `x`.
 */
function unescapeBackslash(s) {
  return String(s || "").replace(/\\(.)/g, "$1");
}

/**
 * Finds a write target inside a `node -e`/`python -c` inline script: the
 * shell statement is recognised by its interpreter invocation, the script
 * text itself is extracted with `shell-parse.extractQuoted`, and that text
 * is searched for a known write call.
 *
 * A literal path argument is reported certain, via
 * {@link INLINE_WRITE_CALL_PATTERNS}. When no literal was found anywhere in
 * the script but {@link INLINE_WRITE_INDICATOR_RE} still proves a write call
 * is present — a computed path argument rather than a string — an uncertain
 * target with no path is reported instead, so a computed write is asked
 * about rather than passing in total silence. A statement that does not open
 * with a recognised inline-interpreter invocation, whose script text cannot
 * be extracted at all (not a single quoted argument), or whose script
 * carries no recognised write call at all (a read, or an unrelated script),
 * produces nothing.
 *
 * @param {string} stmt A single statement's text.
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @returns {void}
 */
function collectInlineInterpreterTargets(stmt, out) {
  let flagRe = null;
  let mechanism = null;
  if (NODE_INLINE_RE.test(stmt)) {
    flagRe = NODE_INLINE_RE;
    mechanism = "node-inline-write";
  } else if (PYTHON_INLINE_RE.test(stmt)) {
    flagRe = PYTHON_INLINE_RE;
    mechanism = "python-inline-write";
  }
  if (!flagRe) return;

  const script = extractQuoted(stmt, flagRe);
  if (script === null) return;

  let foundLiteral = false;
  for (const pattern of INLINE_WRITE_CALL_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(script))) {
      foundLiteral = true;
      pushTarget(out, unescapeBackslash(m[2]), mechanism);
    }
  }

  if (!foundLiteral && INLINE_WRITE_INDICATOR_RE.test(script)) {
    pushUncertainTarget(out, mechanism);
  }
}

/**
 * Runs every token-based detector (everything except the redirect and
 * inline-interpreter mechanisms, which read the whole statement text
 * directly) against one pipeline segment.
 *
 * @param {string} segment One pipeline stage of a statement.
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} out
 * The accumulator to push onto.
 * @returns {void}
 */
function collectTokenBasedTargets(segment, out) {
  const tokens = splitTokens(segment);
  if (!tokens.length) return;
  collectTeeTargets(tokens, out);
  collectPowerShellCmdletTargets(tokens, out);
  collectSedPerlTargets(tokens, out);
  collectCopyMoveTargets(tokens, out);
  collectTruncateTargets(tokens, out);
  collectDdTargets(tokens, out);
  collectNewItemTargets(tokens, out);
  collectXcopyTargets(tokens, out);
  collectRobocopyTargets(tokens, out);
  collectGitCheckoutTargets(tokens, out);
  collectGitRestoreTargets(tokens, out);
  collectGitApplyTargets(tokens, out);
  collectGitAmTargets(tokens, out);
  collectCurlTargets(tokens, out);
  collectWgetTargets(tokens, out);
  collectInvokeWebRequestTargets(tokens, out);
  collectExpandArchiveTargets(tokens, out);
  collectTarTargets(tokens, out);
  collectUnzipTargets(tokens, out);
}

/**
 * The complete catalogue of write mechanisms this module recognises, by the
 * exact `mechanism` string each one reports.
 *
 * This is a **deny-list, not an allow-list**, and that is deliberate, not an
 * oversight: `shellWriteTargets` looks for these specific, named mechanisms
 * and stays silent about everything else. A shell command that writes a file
 * through a mechanism not named here is invisible to it, and therefore to
 * `core/guards/shell-file-write.js`, by construction. Turning this around
 * into an allow-list of read-only commands — flagging every command not
 * proven safe, rather than every command proven to write — would close that
 * gap structurally, but it would also turn every unrecognised shell command
 * into an `ask` for every developer on every session, which is a product
 * decision for a human to make deliberately, not one to slip in as a side
 * effect of extending this catalogue. Adding or removing an entry here is
 * meant to be a deliberate act: `tests/lib/shell-write.test.js` pins this
 * exact list against one representative command per mechanism, so a
 * silent drift between what this array says and what the code actually
 * recognises fails the suite.
 *
 * **Known limitation — directory pathspecs.** `git checkout <ref> -- <path>`
 * and `git restore <path>` are reported as certain targets by
 * {@link collectGitCheckoutTargets} and {@link collectGitRestoreTargets} for
 * any pathspec, including one naming a **directory** rather than a file —
 * `git checkout other -- src/components`. `core/guards/shell-file-write.js`
 * then lets it through anyway, because that rule denies on a governed file
 * extension and a directory carries none. Resolving a pathspec against the
 * real filesystem to tell a file from a directory is a deliberate choice not
 * to make here: this module never touches disk. This gap is recorded, not a
 * TODO — the developer chose to accept it rather than have a pure
 * text-analysis module start doing filesystem lookups.
 */
const WRITE_MECHANISMS = Object.freeze([
  "redirect",
  "tee",
  "powershell-out-file",
  "powershell-set-content",
  "powershell-add-content",
  "powershell-tee-object",
  "sed-inplace",
  "perl-inplace",
  "node-inline-write",
  "python-inline-write",
  "copy-move",
  "truncate",
  "dd",
  "new-item-force",
  "xcopy",
  "robocopy",
  "git-checkout",
  "git-restore",
  "git-apply",
  "git-am",
  "curl",
  "wget",
  "invoke-webrequest",
  "expand-archive",
  "tar-extract",
  "unzip",
]);

/**
 * Finds every file path a shell command line writes.
 *
 * Splits `command` into statements with `shell-parse.splitStatements`, which
 * already unwraps a nested shell wrapper (`bash -c`, `powershell -Command`,
 * `env … sh -c`, `eval`, …) into the statement(s) it actually runs, so a
 * write hidden behind one is found the same as a bare one. Each statement is
 * checked for a POSIX output redirect and an inline-interpreter write call
 * directly, and split into pipeline segments for the remaining, token-based
 * mechanisms:
 *
 * - POSIX output redirect (`>`, `>>`, a leading fd number, a stderr-only
 *   redirect, combined with a trailing heredoc opener)
 * - `tee`/`tee -a`
 * - the PowerShell write cmdlets: `Out-File`, `Set-Content`, `Add-Content`,
 *   `Tee-Object`
 * - `sed -i`/`--in-place`, `perl -i`/`-pi`/`-ni`
 * - `node -e`/`--eval` and `python`/`python3 -c` calling a known write
 *   function with a literal path argument
 * - `cp`/`mv`/`copy`/`move`/`Copy-Item`/`Move-Item`'s destination, plus
 *   `xcopy`'s and `robocopy`'s own Windows-switch conventions
 * - `truncate -s`, `dd of=`, `New-Item -Force -Path`
 * - `git checkout <ref>? -- <path>...` and `git restore`'s pathspec targets —
 *   `git restore --staged` reports nothing at all when `--worktree` is not
 *   also present, since an index-only restore leaves the working tree
 *   byte-identical
 * - `git apply`, `git am` — each writes files never named on the command
 *   line, so each is always reported as an uncertain, pathless target (see
 *   {@link pushUncertainTarget}) rather than silently missed
 * - `curl -o`/`-O`/`--output`, `wget -O`/`--output-document`,
 *   `Invoke-WebRequest -OutFile`
 * - `Expand-Archive`, `tar -x`/old-style `xzf`, `unzip` — bulk extraction,
 *   uncertain the same way as `git apply`/`am`, and reported only when an
 *   explicit destination is given; with none, nothing is reported at all
 *
 * `git stash pop`/`apply`, `git revert`, and `git cherry-pick` are not
 * recognised here at all, on purpose — see the module doc comment above.
 *
 * `/dev/null`, `$null`, `NUL`/`nul`, and a pure file-descriptor duplication
 * (`2>&1`, `>&2`) never appear in the result — they are not a write to a
 * file. Every result's `certain` field is `false` when the mechanism was
 * detected but the concrete path carries an unresolved variable, command
 * substitution, or glob rather than a literal, or when the mechanism itself
 * cannot name its target files at all.
 *
 * {@link WRITE_MECHANISMS} names every mechanism this function can report,
 * one place documenting the catalogue's own boundary — read it before
 * relying on a mechanism this function does or does not recognise.
 *
 * Never throws: any unexpected failure yields an empty result rather than
 * propagating.
 *
 * @param {string} command The raw command line.
 * @param {{powershell?: boolean}} [options] `powershell: true` when the
 * enclosing tool call is a PowerShell statement, so it is not canonicalised
 * with POSIX backslash-escaping rules that would corrupt a Windows path.
 * @returns {Array<{path: string, mechanism: string, certain: boolean}>}
 * Every write target found, in command order.
 */
function shellWriteTargets(command, options) {
  try {
    const isPosix = !(options && options.powershell);
    const out = [];
    for (const stmt of splitStatements(command)) {
      collectRedirectTargets(stmt, isPosix, out);
      collectInlineInterpreterTargets(stmt, out);
      for (const segment of splitPipeSegments(stmt, isPosix)) {
        collectTokenBasedTargets(segment, out);
      }
    }
    return out;
  } catch {
    return [];
  }
}

module.exports = { shellWriteTargets, WRITE_MECHANISMS };
