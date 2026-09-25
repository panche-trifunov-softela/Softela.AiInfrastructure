"use strict";

/**
 * Safe-enough shell command tokenising for rule matching.
 *
 * Every function here is a pure string function operating on plain text —
 * there is no real shell parser underneath. The goal is only to be careful
 * enough that a rule does not fire on a substring that merely resembles the
 * pattern it is looking for: a pipeline's second stage, a quoted argument, a
 * hyphenated word that happens to start with a forbidden verb.
 */

/**
 * Command start: line start, or right after a separator, pipe, or subshell
 * opener. Matching a verb only when preceded by this is what stops
 * `git log | grep push` from reading as a push.
 */
const START = "(?:^|[\\s;&|(`])";

/**
 * Checks whether `${IFS}` or a word-bounded bare `$IFS` starts at a given
 * position — the two spellings a real shell treats as interchangeable with
 * its whitespace field separator, so a verb split by either one still reads
 * as two separate words instead of hiding inside one opaque token.
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
 * Replaces the contents of every quoted region with a neutral filler
 * character, keeping the string length and the quote characters themselves
 * intact. Used before command-start matching so that a command name
 * appearing inside a quoted argument is never mistaken for an invocation.
 *
 * Outside any quoted region, three shell spellings that are otherwise
 * invisible to a plain substring check are neutralised to same-length
 * whitespace before the ordinary quote scan runs, so every caller of this
 * function — and anything sliced from the original string using a position
 * it reports — sees a real shell's actual word boundaries:
 *
 * - a backslash-newline line continuation, which a real shell deletes and
 *   joins across;
 * - `${IFS}` or a word-bounded bare `$IFS`, a real shell's own whitespace
 *   field separator spelled out as text;
 * - an ANSI-C `$'...'` quote opener, recognised the same as a plain `'` so
 *   its content does not leak past command-start masking untouched.
 *
 * @param {string} str The raw command line.
 * @returns {string} The command line with quoted contents masked.
 */
function maskQuoted(str) {
  let out = "";
  let quote = null;
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < str.length) {
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

    if (ch === "\\" && str[i + 1] === "\n") {
      out += "  ";
      i += 2;
      continue;
    }

    const ifsLen = ifsTokenLengthAt(str, i);
    if (ifsLen) {
      out += " ".repeat(ifsLen);
      i += ifsLen;
      continue;
    }

    if (ch === "$" && str[i + 1] === "'") {
      quote = "'";
      out += ch + str[i + 1];
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
 * Statement-separator characters: the true boundary between one statement's
 * leading word and the next, on any of bash/sh, PowerShell (including the
 * `&` call operator) or cmd. Distinct from ordinary whitespace, which only
 * ends a leading word without starting a new statement.
 */
const SEPARATOR_CHARS = new Set([";", "&", "|", "(", "`", "\n"]);

/**
 * Replaces the contents of every quoted region with a neutral filler
 * character, except a quoted or partially-quoted word sitting at a
 * statement's leading position, which is unquoted instead — its quote
 * characters are dropped and its content copied through literally. This
 * mirrors real shell behaviour: `"git" push` and `gi"t" push` both execute
 * identically to `git push`, while a quoted word anywhere else in the line
 * (an argument to some other command, e.g. `echo "please run git push
 * later"`) is still just prose and is masked as before. Adjacent
 * quoted/unquoted segments with no whitespace between them concatenate into
 * one leading word, exactly as a real shell would join them — including a
 * quoted space, which becomes literal content of that single word rather
 * than a separator; over-matching that degenerate case is harmless, since a
 * real shell would fail to find such a command too.
 *
 * Outside any quoted region, the same three spellings {@link maskQuoted}
 * neutralises — a backslash-newline continuation, `${IFS}`/bare `$IFS`, and
 * an ANSI-C `$'...'` opener — are recognised here too, so a verb split
 * across any of them still reads as two separate words and a leading `$'…'`
 * word is unquoted exactly like a plain `'…'` one.
 *
 * @param {string} str The raw command line.
 * @returns {string} The command line with its leading word(s) unquoted and
 * every other quoted region masked, safe to test a command-start verb regex
 * against.
 */
function maskQuotedForCommandStart(str) {
  let out = "";
  let quote = null;
  let atLeadingWord = true;
  let leadingWordStarted = false;
  let i = 0;
  while (i < str.length) {
    const ch = str[i];

    if (quote) {
      // The `atLeadingWord` branch genuinely dequotes the leading word's
      // value (for the verb regex to match against), so it follows the same
      // Windows-path-safe rule {@link splitTokens} and {@link
      // peelNestedShellLayer} apply: a backslash is literal content except
      // right before the closing double quote, where it still escapes that
      // quote. The non-leading branch only masks — it never inspects the
      // escaped character's own value — so it keeps its previous two-
      // characters-in, two-characters-out masking for any other backslash,
      // preserving the boundary invariant callers rely on when NOT unquoting.
      if (ch === "\\" && quote === '"' && str[i + 1] === '"') {
        out += atLeadingWord ? '"' : "\\#";
        i += 2;
        continue;
      }
      if (ch === quote) {
        if (!atLeadingWord) out += ch;
        quote = null;
        i += 1;
        continue;
      }
      out += atLeadingWord ? ch : "#";
      i += 1;
      continue;
    }

    // A real shell deletes a backslash-newline pair and joins across it —
    // treating it as a plain space keeps the verb regex from reading the
    // two halves as one unmatched word.
    if (ch === "\\" && str[i + 1] === "\n") {
      out += " ";
      if (atLeadingWord && leadingWordStarted) atLeadingWord = false;
      i += 2;
      continue;
    }

    const ifsLen = ifsTokenLengthAt(str, i);
    if (ifsLen) {
      out += " ";
      if (atLeadingWord && leadingWordStarted) atLeadingWord = false;
      i += ifsLen;
      continue;
    }

    if (ch === "$" && str[i + 1] === "'") {
      quote = "'";
      leadingWordStarted = leadingWordStarted || atLeadingWord;
      if (!atLeadingWord) out += ch + str[i + 1];
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      leadingWordStarted = leadingWordStarted || atLeadingWord;
      if (!atLeadingWord) out += ch;
      i += 1;
      continue;
    }

    if (SEPARATOR_CHARS.has(ch)) {
      out += ch;
      atLeadingWord = true;
      leadingWordStarted = false;
      i += 1;
      continue;
    }

    if (/\s/.test(ch)) {
      out += ch;
      if (atLeadingWord && leadingWordStarted) atLeadingWord = false;
      i += 1;
      continue;
    }

    out += ch;
    if (atLeadingWord) leadingWordStarted = true;
    i += 1;
  }
  return out;
}

/**
 * Checks whether a command line invokes a given command at a command start.
 *
 * @param {string} command The raw command line.
 * @param {string} verbPattern A regular expression source describing the
 * command invocation, e.g. `"git\\s+push"` or `"npm\\s+(?:install|i)"`.
 * @returns {boolean} `true` when the pattern matches right after a command
 * start and is followed by a separator or the end of the string, outside any
 * quoted region.
 */
function hasCommand(command, verbPattern) {
  const str = maskQuotedForCommandStart(String(command || ""));
  const re = new RegExp(`${START}(?:${verbPattern})(?=[\\s;&|)\`]|$)`, "i");
  return re.test(str);
}

/**
 * Checks whether a command line invokes `git <verb>`, tolerating global git
 * flags in between — including a value-bearing `-c`/`-C`, e.g.
 * `git -c x=y push`.
 *
 * @param {string} command The raw command line.
 * @param {string} verb The git subcommand, e.g. `"push"` or `"commit"`.
 * @returns {boolean} `true` when the command line invokes that git verb.
 */
function gitVerb(command, verb) {
  const str = maskQuotedForCommandStart(String(command || ""));
  const flag = "(?:(?:-c|-C)\\s+\\S+|-[^\\s]+(?:=\\S*)?)";
  const re = new RegExp(
    `${START}git\\s+(?:${flag}\\s+)*${verb}(?=[\\s;&|)\`]|$)`,
    "i",
  );
  return re.test(str);
}

/**
 * Checks whether a command line carries a given flag, outside any quoted
 * region.
 *
 * @param {string} command The raw command line.
 * @param {string} flagPattern A regular expression source describing the
 * flag, e.g. `"--force"` or `"-f"`.
 * @returns {boolean} `true` when the flag appears preceded by whitespace or
 * a command start and followed by whitespace, a separator, or the end of the
 * string.
 */
function hasFlag(command, flagPattern) {
  const str = maskQuoted(String(command || ""));
  const re = new RegExp(`${START}(?:${flagPattern})(?=[\\s;&|)\`]|$)`, "i");
  return re.test(str);
}

/**
 * Extracts the quoted value that follows a flag, e.g. the message text after
 * `-m "…"`, handling both quote styles and escaped characters inside double
 * quotes.
 *
 * @param {string} command The raw command line.
 * @param {RegExp | string} flagRegex The flag pattern to locate, as a
 * `RegExp` or a regular expression source string.
 * @returns {string | null} The unescaped quoted value, or `null` when the
 * flag or a quoted value after it is absent.
 */
function extractQuoted(command, flagRegex) {
  const str = String(command || "");
  const source = flagRegex instanceof RegExp ? flagRegex.source : String(flagRegex);
  const caseInsensitive = !(flagRegex instanceof RegExp) || flagRegex.flags.includes("i");
  const re = new RegExp(
    `(?:${source})\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`,
    caseInsensitive ? "i" : "",
  );
  const m = str.match(re);
  if (!m) return null;
  if (m[1] !== undefined) return m[1].replace(/\\(["\\])/g, "$1");
  if (m[2] !== undefined) return m[2];
  return null;
}

/**
 * Splits a command line into statements on `;`, `&&`, `||`, and newlines
 * only, ignoring separators that appear inside quotes — nothing about a
 * pipeline, a background operator, or a subshell/group/substitution
 * boundary. This is the cheap, non-recursive fallback
 * {@link splitStatements} falls back to once a command exceeds
 * {@link MAX_COMMAND_LENGTH_FOR_UNWRAP}; {@link splitBoundaries} is the full
 * parser normal-sized input goes through instead, and
 * {@link splitStatements} is the public entry point layering nested-shell
 * unwrapping on top of whichever one ran.
 *
 * A backslash immediately followed by a newline, outside any quote, is
 * POSIX line continuation: a real shell deletes the pair and joins the
 * surrounding text into one statement, so it is replaced with a plain space
 * here rather than falling into the newline-separator check below — the
 * same join a real shell performs, without inventing a false statement
 * boundary partway through a verb split across two lines.
 *
 * @param {string} command The raw command line.
 * @returns {string[]} The trimmed, non-empty statements, in order.
 */
function splitOnSeparators(command) {
  const str = String(command || "");
  const statements = [];
  let current = "";
  let quote = null;
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"' && i + 1 < str.length) {
        current += str[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "\\" && str[i + 1] === "\n") {
      current += " ";
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      statements.push(current);
      current = "";
      i += 1;
      continue;
    }
    if (ch === "&" && str[i + 1] === "&") {
      statements.push(current);
      current = "";
      i += 2;
      continue;
    }
    if (ch === "|" && str[i + 1] === "|") {
      statements.push(current);
      current = "";
      i += 2;
      continue;
    }
    current += ch;
    i += 1;
  }
  statements.push(current);
  return statements.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Maximum nested-grouping depth {@link parseStatements} recurses through for
 * a subshell, group command, command substitution, backtick substitution, or
 * process substitution — the bracket-recursion counterpart to
 * {@link MAX_UNWRAP_DEPTH}. Bounds recursion so a pathological input
 * (`((((((…))))))`) cannot exhaust the call stack; real usage never nests
 * this deep.
 */
const MAX_GROUPING_DEPTH = 16;

/**
 * Finds the index just past a `$((` arithmetic expansion's matching closing
 * `))`, given `start` pointing at the expansion's leading `$`.
 *
 * Arithmetic expansion is not a command — `$(( 2 + 2 ))` merely evaluates to
 * a number — so {@link parseStatements} must consume it as opaque literal
 * text rather than recursing into it as a grouping construct the way it does
 * for `$( … )`. Left unhandled, the leading `$((` would be read as a `$(`
 * command substitution whose own first character is a second, nested `(`,
 * turning the arithmetic body into a spurious statement of its own.
 *
 * Tracks parenthesis depth starting at 2, for the two opens `$((` already
 * consumed, so a grouping paren legitimately nested inside the expression
 * (`$(( (1 + 2) * 3 ))`) is consumed as part of the expansion rather than
 * misread as a third, unmatched open. A quoted region inside the expression
 * is skipped without inspecting its content, consistent with every other
 * quote-aware scan in this module.
 *
 * @param {string} str The full raw text being parsed.
 * @param {number} start The index of the expansion's leading `$`.
 * @returns {number} The index just past the matching `))`, or `str.length`
 * when the expansion is never closed.
 */
function findArithmeticExpansionEnd(str, start) {
  let i = start + 3; // past "$(("
  let depth = 2;
  let quote = null;
  while (i < str.length && depth > 0) {
    const ch = str[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < str.length) {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return i;
}

/**
 * A PowerShell cmdlet whose bare, unquoted `{ … }` argument is a script
 * block carrying further statements to run. Tested against the text
 * accumulated so far for the CURRENT statement only — {@link parseStatements}
 * resets that accumulator at every separator, so a match here can never
 * reach back into a previous statement.
 *
 * Anchored end-to-end (`^…$`) so it matches only when the statement built up
 * so far is nothing BUT the cmdlet name and simple flags — `Invoke-Command
 * -ScriptBlock`, say — never when the cmdlet's name merely appears somewhere
 * earlier in a longer, unrelated statement. That anchoring is what keeps
 * `echo remember Invoke-Command later { odd }` from being misread as a
 * scriptblock argument: `echo remember Invoke-Command later` does not match
 * `^Invoke-Command\b…$`.
 *
 * Limited to the one scriptblock-consuming cmdlet this project explicitly
 * closes; a bare `& { … }` call-operator script block is already covered by
 * the ordinary command-start `{` check below, since `&` itself is treated as
 * a background-job separator that resets the accumulator to empty right
 * before the `{`. Another scriptblock-consuming cmdlet not named here is a
 * documented exclusion — see {@link parseStatements}'s own doc comment.
 */
const SCRIPTBLOCK_ARGUMENT_RE = /^Invoke-Command(?:\.exe)?\b(?:\s+\S+)*$/i;

/**
 * Matches a heredoc redirect opener — `<<WORD`, `<<-WORD`, `<<~WORD`, or any
 * of those with the delimiter word wrapped in matching single or double
 * quotes — anchored with the sticky flag so {@link matchHeredocOpener} can
 * test one exact position without slicing a copy of the remaining text.
 *
 * The unquoted-word alternative excludes `<` and `>`, which is what keeps a
 * `<<<` here-string from ever matching here: after the leading `<<` and the
 * optional `-`/`~` modifier, a third `<` is neither whitespace nor a valid
 * unquoted-word character, so the whole pattern simply fails to match and
 * the text is left for the ordinary character-by-character copy below.
 */
const HEREDOC_OPENER_RE = /<<[-~]?\s*(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|([^\s'"`;&|()<>]+))/y;

/**
 * Detects a heredoc redirect opener starting exactly at `str[i]`, outside
 * any quoted region — {@link parseStatements} only ever calls this at a
 * position where `quote` is `null`, so quoted text never reaches it.
 *
 * @param {string} str The full raw text being parsed.
 * @param {number} i The index to test.
 * @returns {{length: number, delimiter: string} | null} The matched
 * opener's length and its dequoted delimiter word, or `null` when no
 * heredoc opener starts there.
 */
function matchHeredocOpener(str, i) {
  HEREDOC_OPENER_RE.lastIndex = i;
  const m = HEREDOC_OPENER_RE.exec(str);
  if (!m) return null;
  const delimiter = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
  return { length: m[0].length, delimiter };
}

/**
 * Consumes one heredoc body: every line starting at `startIndex` up to and
 * including the first line whose trimmed content equals `delimiter` — a
 * real shell ignores surrounding whitespace, including the leading tabs
 * `<<-` and `<<~` explicitly tolerate, when matching the terminator line.
 *
 * @param {string} str The full raw text being parsed.
 * @param {number} startIndex The index right after the newline that ends
 * the statement opening the heredoc — where the body begins.
 * @param {string} delimiter The heredoc's terminator word.
 * @returns {number} The index just past the terminator line's own newline,
 * or `str.length` when the terminator is never found — an unterminated
 * heredoc is consumed to the end of the input rather than looped over.
 */
function consumeHeredocBody(str, startIndex, delimiter) {
  let i = startIndex;
  while (i <= str.length) {
    const nl = str.indexOf("\n", i);
    const lineEnd = nl === -1 ? str.length : nl;
    if (str.slice(i, lineEnd).trim() === delimiter) return nl === -1 ? str.length : nl + 1;
    if (nl === -1) return str.length;
    i = nl + 1;
  }
  return str.length;
}

/**
 * Parses raw shell text starting at `start` into an ordered list of
 * statements, recursing into every real command boundary this module
 * recognises:
 *
 * - `;`, `&&`, `||`, and a newline — the separators {@link splitOnSeparators}
 *   already knew about;
 * - a pipeline stage's `|` or `|&`, never the `||` handled above;
 * - a background `&`, never the `&&` it is part of, and never a
 *   redirection's fd-duplication target (`2>&1`, `>&2`, `&>file` all keep
 *   their `&` literal);
 * - the paired delimiters of a subshell `( … )` or a group command `{ … }`,
 *   recognised only when the opener sits at a command-start position —
 *   nothing accumulated yet for the statement in progress — so an unrelated
 *   unquoted `{`/`(` elsewhere in a word (brace expansion, a function call,
 *   a method invocation) is left as literal text, the same as a real
 *   shell's own grammar requires; a `{` is ALSO recognised right after
 *   {@link SCRIPTBLOCK_ARGUMENT_RE} matches, so `Invoke-Command -ScriptBlock
 *   { … }` is caught even though its `{` is an argument, not the statement's
 *   own first character;
 * - the delimiters of a command substitution `$( … )`, a backtick
 *   substitution `` ` … ` ``, or a process substitution `<( … )`/`>( … )`,
 *   recognised anywhere in the text, since all three legitimately sit inside
 *   a larger word — `$((` is checked first and handled separately, by
 *   {@link findArithmeticExpansionEnd}, so an arithmetic expansion is never
 *   misread as a command substitution whose body starts with a stray `(`.
 *
 * A heredoc redirect (`<<WORD`, `<<-WORD`, `<<~WORD`, either spelling with
 * the delimiter quoted, and more than one such redirect on the same
 * statement) is handled specially rather than as a grouping construct: the
 * opener text stays part of the statement that carries it — the statement
 * that opens a heredoc is still a real statement to judge — but every line
 * of the body that follows the next newline, up to and including the
 * terminator line, produces no statement of its own at all. That body is
 * data a real shell never executes, so reading it for command boundaries the
 * way the rest of this function reads everything else would misjudge a
 * harmless payload as a command. An unterminated heredoc consumes to the end
 * of the input rather than leaving the scan stuck looking for a line that
 * never comes. See {@link matchHeredocOpener} and {@link consumeHeredocBody}.
 *
 * Every grouping construct keeps its own verbatim text in the statement that
 * contains it — nothing is stripped from that outer statement — and also
 * contributes the statement(s) found inside it, appended right after it.
 * This mirrors {@link collectWithNestedShells}'s wrapped-then-unwrapped
 * convention: a rule that already tolerates the grouping punctuation (e.g.
 * {@link gitVerb}, whose command-start regex already treats `(` and `` ` ``
 * as valid predecessors) keeps working directly off the outer form, while a
 * rule that needs clean, ungrouped tokens gets the inner statement instead.
 *
 * Constructs deliberately left unhandled, because they cannot hide a
 * statement the way the ones above can:
 *
 * - `;;` and `;&` case terminators — each character is already one of the
 *   separators handled above (`;` flushes, and a lone `&` not glued to `&`
 *   or `>` flushes too), so a case terminator already produces the correct
 *   split with no dedicated branch; the empty statement between the two
 *   flushes is silently dropped, same as any other empty statement;
 * - brace expansion (`file.{js,ts}`) and a function-call- or
 *   method-call-style paren (`SetEnvironmentVariable("x", "y")`) — both are
 *   already excluded by the command-start requirement on the plain `(`/`{`
 *   check, since neither sits where `current.trim() === ""`;
 * - a PowerShell scriptblock-consuming cmdlet other than `Invoke-Command`
 *   (`ForEach-Object { … }`, `Where-Object { … }`, `%{ … }`, …) — an
 *   intentionally narrow list, not a general "any cmdlet followed by `{`"
 *   rule; widening {@link SCRIPTBLOCK_ARGUMENT_RE} to every such cmdlet is a
 *   documented exclusion, not a silent gap, left for the day one of them
 *   actually needs closing;
 * - a heredoc opener sitting right before `stopChar` with no newline ever
 *   found in between — inside a subshell/substitution written entirely on
 *   one line, say — leaves its delimiter in `pendingHeredocs` unconsumed
 *   when this call returns early. Real shell usage always puts a heredoc
 *   body on the lines that follow, so this never actually loses a body; it
 *   only means the abandoned delimiter is not explicitly cleared.
 *
 * @param {string} str The full raw text being parsed.
 * @param {number} start The index to begin parsing at.
 * @param {string | null} stopChar The single unquoted character that ends
 * this parse early — `)` for a subshell, command substitution, or process
 * substitution, `}` for a group command, `` ` `` for a backtick substitution
 * — or `null` at the top level, where only the end of the string ends it.
 * @param {number} groupingDepth Remaining levels of subshell/group/
 * substitution recursion allowed, bounding a pathological input.
 * @returns {{statements: string[], nextIndex: number}} The statements found,
 * in order, and the index just past the consumed text: `str.length` when
 * `stopChar` was never found, otherwise one past the matched `stopChar`.
 */
function parseStatements(str, start, stopChar, groupingDepth) {
  const statements = [];
  let pending = [];
  // Delimiters of every heredoc opened by the text accumulated into
  // `current` so far, in the order their `<<` openers appeared. Untouched by
  // `flush()`, so it survives a `;`/`&&`/`||`/pipe/background flush the same
  // way a real shell's own heredoc body — which starts only at the next
  // literal newline, no matter how many statements share that line — does.
  let pendingHeredocs = [];
  let current = "";
  let quote = null;
  let i = start;

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) statements.push(trimmed);
    current = "";
    if (pending.length) {
      statements.push(...pending);
      pending = [];
    }
  };

  const enterGroup = (openLen, closeChar) => {
    const innerStart = i + openLen;
    const inner = parseStatements(str, innerStart, closeChar, groupingDepth - 1);
    current += str.slice(i, inner.nextIndex);
    pending.push(...inner.statements);
    i = inner.nextIndex;
  };

  while (i < str.length) {
    const ch = str[i];

    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"' && i + 1 < str.length) {
        current += str[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === "\\" && str[i + 1] === "\n") {
      current += " ";
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }

    // A heredoc opener: its own text stays part of the statement being
    // built, but the delimiter is queued rather than acted on immediately —
    // the body it introduces does not begin until the next literal newline,
    // handled below.
    if (ch === "<" && str[i + 1] === "<") {
      const opener = matchHeredocOpener(str, i);
      if (opener) {
        current += str.slice(i, i + opener.length);
        pendingHeredocs.push(opener.delimiter);
        i += opener.length;
        continue;
      }
    }

    if (stopChar !== null && ch === stopChar) {
      i += 1;
      flush();
      return { statements, nextIndex: i };
    }

    if (ch === ";" || ch === "\n") {
      flush();
      i += 1;
      if (ch === "\n" && pendingHeredocs.length) {
        for (const delimiter of pendingHeredocs) i = consumeHeredocBody(str, i, delimiter);
        pendingHeredocs = [];
      }
      continue;
    }

    if (ch === "&" && str[i + 1] === "&") {
      flush();
      i += 2;
      continue;
    }

    if (ch === "|" && str[i + 1] === "|") {
      flush();
      i += 2;
      continue;
    }

    // A pipeline stage: a lone `|`, or the POSIX `|&` shorthand for
    // `2>&1 |`. Neither is the `||` handled just above.
    if (ch === "|") {
      flush();
      i += str[i + 1] === "&" ? 2 : 1;
      continue;
    }

    // A background `&`: never half of `&&` (ruled out above), and never a
    // redirection's fd-duplication target — `2>&1`/`>&2` have a `>` right
    // before it, `&>file` has a `>` right after it.
    if (ch === "&" && !current.endsWith(">") && str[i + 1] !== ">") {
      flush();
      i += 1;
      continue;
    }

    // `$((` — arithmetic expansion. Checked BEFORE the plain `$(` branch
    // below and consumed as opaque literal text, never as a group: it is not
    // a command, and letting the plain `$(` branch handle it would read the
    // arithmetic body's own leading `(` as the start of a nested statement.
    if (groupingDepth > 0 && ch === "$" && str[i + 1] === "(" && str[i + 2] === "(") {
      const end = findArithmeticExpansionEnd(str, i);
      current += str.slice(i, end);
      i = end;
      continue;
    }

    if (groupingDepth > 0 && ch === "$" && str[i + 1] === "(") {
      enterGroup(2, ")");
      continue;
    }

    // `<( … )` and `>( … )` — process substitution. Recognised anywhere,
    // exactly like `$( … )` just above: a shell reads either one as a
    // filename argument that legitimately sits inside a larger word
    // (`diff <(cmd) other-file`), not only at a command's own start.
    if (groupingDepth > 0 && (ch === "<" || ch === ">") && str[i + 1] === "(") {
      enterGroup(2, ")");
      continue;
    }

    if (groupingDepth > 0 && ch === "`") {
      enterGroup(1, "`");
      continue;
    }

    if (groupingDepth > 0 && ch === "(" && current.trim() === "") {
      enterGroup(1, ")");
      continue;
    }

    if (
      groupingDepth > 0 &&
      ch === "{" &&
      (current.trim() === "" || SCRIPTBLOCK_ARGUMENT_RE.test(current.trim()))
    ) {
      enterGroup(1, "}");
      continue;
    }

    current += ch;
    i += 1;
  }

  flush();
  return { statements, nextIndex: i };
}

/**
 * Splits raw command text into an ordered list of statements — the full,
 * bracket-aware parser normal-sized input goes through. See
 * {@link parseStatements} for the complete boundary set recognised and the
 * wrapped-then-unwrapped convention every grouping construct follows.
 *
 * @param {string} command The raw command line.
 * @returns {string[]} The statements found, in order.
 */
function splitBoundaries(command) {
  return parseStatements(String(command || ""), 0, null, MAX_GROUPING_DEPTH).statements;
}

/**
 * Splits a single, already-isolated statement into its ordered, fully
 * dequoted tokens — the words a real shell would actually see once every
 * quote form (`'…'`, `"…"`, ANSI-C `$'…'`) is stripped down to its content
 * and every whitespace-equivalent separator (plain whitespace, `${IFS}`/bare
 * `$IFS`, a backslash-newline continuation) is collapsed to a token
 * boundary. Stops at the first unquoted statement-separator character
 * (`;`, `&`, `|`, `(`, backtick) — a statement is already isolated by
 * {@link splitStatements}, so text past such a character belongs to a
 * different command and is never one of this statement's own tokens.
 *
 * Two passes protect a caller that hands this function a statement still
 * carrying grouping punctuation — the outer, still-wrapped form
 * {@link splitStatements} deliberately keeps alongside its clean inner
 * statement, or any other text a caller isolated by hand:
 *
 * - before tokenising, a leading run of whitespace and grouping openers
 *   (`(`, `{`, `` ` ``, `$(`) is stripped, so a statement opening with one
 *   never starves the scan below of a first token;
 * - after tokenising, a trailing run of `)`, `}`, or `;` is stripped off the
 *   FINAL token only — the closing punctuation a real shell reads as ending
 *   the grouping rather than as part of the last word — dropping that token
 *   entirely when nothing but punctuation is left.
 *
 * Unlike {@link maskQuotedForCommandStart}, which only unquotes the leading
 * word for a regex verb-match, every token here is fully dequoted by value.
 * That is what lets a caller walk a fixed-shape prefix — a command word,
 * its flags, its target — by comparing token VALUES, so a quoted, IFS-joined
 * or backslash-continued word never has to line up with a character
 * position computed against a differently-shaped masked copy of the text.
 *
 * A backslash inside a double-quoted token is kept as a literal character —
 * this is what lets a quoted Windows path (`"C:\Users\dev\repo"`) dequote to
 * itself instead of every backslash being eaten as a POSIX escape — EXCEPT
 * immediately before the closing double quote, where it still escapes that
 * quote character so `"a\"b"` keeps dequoting to `a"b` rather than ending
 * the token early. A single-quoted token never reaches this rule at all:
 * its content is already always literal.
 *
 * @param {string} statement A single, already-isolated shell statement.
 * @returns {string[]} The statement's dequoted leading tokens, in order.
 */
function splitTokens(statement) {
  const str = String(statement || "").replace(/^(?:\s|\(|\{|\$\(|`)+/, "");
  const tokens = [];
  let current = "";
  let hasCurrent = false;
  let quote = null;
  let i = 0;

  const flush = () => {
    if (hasCurrent) tokens.push(current);
    current = "";
    hasCurrent = false;
  };

  while (i < str.length) {
    const ch = str[i];

    if (quote) {
      // Inside double quotes, a backslash is literal Windows-path content
      // (`"C:\Users\dev"`) EXCEPT right before the closing-quote character,
      // where it still escapes that quote so `"a\"b"` keeps dequoting to
      // `a"b` instead of ending the token early. Single quotes never reach
      // this branch with `quote === '"'`, so their content stays untouched.
      if (ch === "\\" && quote === '"' && str[i + 1] === '"') {
        current += '"';
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }

    if (ch === "\\" && str[i + 1] === "\n") {
      flush();
      i += 2;
      continue;
    }

    const ifsLen = ifsTokenLengthAt(str, i);
    if (ifsLen) {
      flush();
      i += ifsLen;
      continue;
    }

    if (ch === "$" && str[i + 1] === "'") {
      quote = "'";
      hasCurrent = true;
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      hasCurrent = true;
      i += 1;
      continue;
    }

    if (SEPARATOR_CHARS.has(ch)) break;

    if (/\s/.test(ch)) {
      flush();
      i += 1;
      continue;
    }

    current += ch;
    hasCurrent = true;
    i += 1;
  }

  flush();

  if (tokens.length) {
    const stripped = tokens[tokens.length - 1].replace(/[)};`]+$/, "");
    if (stripped) tokens[tokens.length - 1] = stripped;
    else tokens.pop();
  }

  return tokens;
}

/**
 * Maximum number of nested-shell layers {@link unwrapNestedShells} and
 * {@link splitStatements} will peel through. Bounds the recursion so a
 * pathological or self-referential input (`bash -c "bash -c \"bash -c …\""`)
 * cannot loop; real usage never nests this deep.
 */
const MAX_UNWRAP_DEPTH = 6;

/** A POSIX shell told to run its argument as a whole command line. */
const POSIX_SHELL_C = "(?:bash|sh|zsh|dash|ksh)(?:\\.exe)?\\s+(?:-\\w+\\s+)*-c";

/** PowerShell's equivalent, both binary names and both flag spellings. */
const POWERSHELL_C = "(?:powershell|pwsh)(?:\\.exe)?\\s+(?:-\\w+\\s+)*(?:-command|-c)";

/** cmd.exe's equivalent — `/c` runs and exits, `/k` runs and stays open. */
const CMD_C = "cmd(?:\\.exe)?\\s+(?:-\\w+\\s+)*/[ck]";

/**
 * PowerShell's `Invoke-Expression`, and its built-in alias `iex` — both
 * parse and run a string as a whole command line, the same shape `eval`
 * already covers on a POSIX shell.
 */
const POWERSHELL_INVOKE_EXPRESSION = "(?:Invoke-Expression|iex)";

/** `env` invoked only to set variables ahead of one of the wrappers above. */
const ENV_PREFIX = "env\\s+(?:(?:-\\w+|[A-Za-z_]\\w*=\\S*)\\s+)*";

/**
 * A nested-shell invocation, matched only at the true start of an
 * already-isolated, trimmed statement on quote-masked text: an interpreter
 * told to run a whole command line handed to it as a single argument,
 * optionally reached through `env` setting variables first. This is what
 * defeats quote-masking on its own — the argument that masking protects is
 * itself a real command the outer shell executes.
 *
 * Anchored with `^\s*`, not the general {@link START} fragment — a wrapper
 * recognised anywhere `START` matches (e.g. mid-statement, after a bare
 * word like `eval` inside `printf %s eval "…"`) would peel a quoted
 * argument that was never actually executed, re-emitting it as an unmasked
 * synthetic statement. {@link peelNestedShellLayer} only ever receives a
 * single statement already delimited by {@link splitRaw}, so there is no
 * legitimate case for recognising a wrapper anywhere but at index 0.
 */
const NESTED_SHELL_RE = new RegExp(
  `^\\s*(?:${ENV_PREFIX})?(?:${POSIX_SHELL_C}|${POWERSHELL_C}|${CMD_C}|eval|${POWERSHELL_INVOKE_EXPRESSION})(?=[\\s;&|)\`]|$)`,
  "i",
);

/**
 * Peels exactly one layer of a nested-shell wrapper from the start of a
 * statement, returning the wrapper's own argument — the command text it
 * will actually run.
 *
 * @param {string} text A candidate statement.
 * @returns {string | null} The wrapper's inner text, unescaped when it was
 * double-quoted, or `null` when `text` does not open with a recognised
 * wrapper, or opens with one but carries no argument at all.
 */
function peelNestedShellLayer(text) {
  const str = String(text || "");
  const masked = maskQuoted(str);
  const m = masked.match(NESTED_SHELL_RE);
  if (!m) return null;

  const after = str.slice(m.index + m[0].length).replace(/^\s+/, "");
  if (!after) return null;

  const quote = after[0];
  if (quote === '"' || quote === "'") {
    let out = "";
    let i = 1;
    while (i < after.length) {
      const ch = after[i];
      // Inside double quotes, a backslash is literal Windows-path content
      // (`"C:\Users\dev"`) EXCEPT right before the closing-quote character,
      // where it still escapes that quote — the same rule {@link splitTokens}
      // applies, so an argument peeled off a nested-shell wrapper dequotes a
      // Windows path identically whether or not the wrapper is present.
      // Single quotes never reach this branch with `quote === '"'`, so their
      // content stays untouched.
      if (ch === "\\" && quote === '"' && after[i + 1] === '"') {
        out += '"';
        i += 2;
        continue;
      }
      if (ch === quote) break;
      out += ch;
      i += 1;
    }
    return out;
  }

  // An unquoted single-token argument — `bash -c update-cache`, say.
  const token = after.match(/^[^\s;&|)`]+/);
  return token ? token[0] : null;
}

/**
 * Recognises a nested-shell invocation — a POSIX shell, PowerShell, cmd,
 * `env` ahead of one of those, or `eval` — and returns the command text it
 * runs, peeling through further wrapper layers as long as one remains, up
 * to {@link MAX_UNWRAP_DEPTH}.
 *
 * @param {string} command A candidate statement.
 * @returns {string | null} The fully unwrapped inner command text, or
 * `null` when `command` does not open with a recognised wrapper at all.
 */
function unwrapNestedShells(command) {
  const first = peelNestedShellLayer(command);
  if (first === null) return null;

  let current = first;
  for (let depth = 1; depth < MAX_UNWRAP_DEPTH; depth += 1) {
    const next = peelNestedShellLayer(current);
    if (next === null) break;
    current = next;
  }
  return current;
}

/**
 * Collects a statement, then — when it opens with a nested-shell wrapper —
 * the statement(s) that wrapper actually runs, recursively.
 *
 * @param {string} statement A single statement, already split on the
 * top-level separators.
 * @param {number} depth Remaining unwrap levels, bounding recursion on a
 * pathological input.
 * @param {string[]} out The accumulator every discovered statement is
 * pushed onto, in order.
 * @returns {void}
 */
function collectWithNestedShells(statement, depth, out) {
  out.push(statement);
  if (depth <= 0) return;

  const peeled = peelNestedShellLayer(statement);
  if (peeled === null) return;

  for (const inner of splitBoundaries(peeled)) {
    collectWithNestedShells(inner, depth - 1, out);
  }
}

/**
 * Above this length, {@link splitStatements} skips the boundary-and-nested-
 * shell probe entirely and falls back to the cheap separator-only split
 * ({@link splitOnSeparators}) — which neither peels a nested-shell wrapper
 * (`bash -c "…"`, `powershell -Command "…"`, `eval …`) nor splits on a
 * pipeline, background `&`, or subshell/group/substitution boundary. Once a
 * command crosses this length, a forbidden verb hidden behind exactly one of
 * those — `bash -c "npm install"` as one long argument, say — never becomes
 * its own statement at all, so a rule scanning statements for that verb sees
 * nothing to match and silently returns `pass` on a command it never
 * actually looked inside.
 *
 * This is cheap insurance, not a fix for an observed stall. Measured
 * directly against `splitStatements` itself (not a proxy metric): 1 MB of
 * quoted text costs the full probe 142 ms, 4 MB costs 743 ms — both trivial
 * next to the real `HOOK_TIMEOUT_SECONDS` budget both hosts actually enforce
 * on every hook registration (`core/installer/plan.js`, 30 seconds). A
 * legitimate shell invocation is essentially never hundreds of kilobytes of
 * literal command text, but a generated or templated command line (a long
 * inline script, a large embedded payload passed as a single argument) can
 * legitimately run past the old 1 MB bound — and every byte past it was
 * exactly the part of the command no rule could see. Raised fourfold, to
 * 4 MB, so that legitimate case keeps getting the full probe.
 *
 * Deliberately NOT raised again to 16 MB: measured at 6.58 SECONDS — the
 * growth from 4 MB to 16 MB is markedly superlinear (roughly 4x the input
 * for roughly 9x the time), so the next fourfold step is worse than
 * proportional and starts eating real fractions of the 30-second hook
 * budget on its own. 4 MB is the point where this ceiling stops paying for
 * itself; do not raise it again without measuring fresh, and note that a
 * naive "it costed X ms at 4 MB, extrapolate linearly" argument does not
 * hold here.
 */
const MAX_COMMAND_LENGTH_FOR_UNWRAP = 4 * 1024 * 1024;

/**
 * Splits a command line into statements on every real command boundary this
 * module recognises — see {@link parseStatements} for the complete set —
 * then expands every statement that opens with a nested-shell wrapper
 * (`bash -c`, `powershell -Command`, `cmd /c`, `env … sh -c`, `eval`, …)
 * into the statement(s) it actually runs.
 *
 * The returned list carries both the outer, still-wrapped statement and its
 * unwrapped inner statements — for a nested-shell wrapper and equally for a
 * subshell, group command, or substitution — so a rule matching on any entry
 * catches a forbidden command hidden behind either kind of wrapping without
 * having to know that shells nest at all. Once `command` exceeds
 * {@link MAX_COMMAND_LENGTH_FOR_UNWRAP}, the boundary-and-nested-shell probe
 * is skipped and only the cheap `;`/`&&`/`||`/newline separator split runs,
 * so a rule still gets statements back — just without the richer
 * unwrapping — rather than the guard path paying an unbounded cost on an
 * unbounded input.
 *
 * @param {string} command The raw command line.
 * @returns {string[]} The trimmed, non-empty statements, outer and
 * unwrapped, in order.
 */
function splitStatements(command) {
  const str = String(command || "");
  if (str.length > MAX_COMMAND_LENGTH_FOR_UNWRAP) return splitOnSeparators(str);

  const out = [];
  for (const statement of splitBoundaries(str)) {
    collectWithNestedShells(statement, MAX_UNWRAP_DEPTH, out);
  }
  return out;
}

module.exports = {
  START,
  hasCommand,
  gitVerb,
  hasFlag,
  extractQuoted,
  splitStatements,
  splitTokens,
  unwrapNestedShells,
};
