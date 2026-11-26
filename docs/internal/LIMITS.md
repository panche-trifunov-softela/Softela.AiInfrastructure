# Limits of enforcement

Four rounds of adversarial testing — three fix-and-attack cycles plus a final
attack pass — went into `core/guards/`, especially the mandatory
`infra-self-protection` rule. Every naturally-occurring spelling that testing
found is now handled. This document states, plainly, what is still true after
that work: what a hook built on text inspection cannot see even in principle,
what this system is actually for, and where the current line between "closed"
and "open" sits. Read `CONTRACTS.md` first for the mechanism this document
describes the edges of.

## The threat model: a shortcut, not an adversary

This system exists to stop a capable assistant from taking a shortcut it
should not — pushing straight to a base branch, granting its own approval,
committing an AI attribution trailer, deleting the state directory that
tracks a developer's own overrides. It does not exist to stop a determined
human adversary, and it cannot: a developer with a shell can always edit
`~/.claude/settings.json` or `~/.codex/hooks.json` by hand, uninstall this
tool entirely, or run the same action under a name the hook does not
recognize. None of that requires defeating a guard — it requires only doing
what the developer's own machine already lets them do. Describing any rule
here as a security boundary would overstate what it is; every rule instead
raises the cost of an *accidental or careless* action, for an agent acting
inside the tool-call surface this system actually watches.

This is not an incidental weakness patched over with a disclaimer — it is
consistent with a choice made at the mechanism's foundation. Every hook in
this system **fails open**: an unparseable payload, an unreadable project
file, a missing home directory, or a thrown exception all resolve to `pass`
(`CONTRACTS.md` §7a). A real security boundary fails closed on doubt. This
one does not, on purpose, because the alternative — blocking a session on
every malformed edge case — would make the tool an obstacle to legitimate
work far more often than it caught a real problem. The developer approving or
refusing a prompt is still the actual authority; the hook's job is to make
sure that decision gets asked for, not to substitute for it.

## What a text-inspecting hook fundamentally cannot see

Every guard in `core/guards/` — including `infra-self-protection`'s mandatory
checks — decides from the raw text of a single tool call: the command string
Claude Code or Codex hands to `PreToolUse`. That is the entire input. Three
consequences follow from that fact alone, not from any particular regex being
incomplete:

- **A payload that is encoded at rest and decoded at run time.** A guard
  matches literal substrings. `echo <base64> | base64 -d | bash` or a
  `printf '\x6d\x34...'` hex-escape sequence never contains the plaintext
  command anywhere in the tool call's own text — the dangerous string is
  synthesized by a process the guard does not run and cannot see into. This
  is true of any encoding, not just base64 or hex; there is no fixed list of
  encodings a text scan could enumerate its way out of.
- **A command name assembled from variables.** `A=softela; B=ai; $A-$B approve
  <rule>` never puts the literal text `softela-ai` in the command line the guard
  reads — the shell concatenates the pieces after the guard has already
  returned its decision. The same is true of any other way of building a
  string at run time that a static scan of the pre-execution text cannot
  evaluate.
- **An action reached indirectly, through a file the hook never reads.** A
  `package.json` `scripts` entry, a `postinstall` hook, a Makefile target, or
  a `git` alias defined in `.gitconfig` can bind an innocuous-looking
  invocation — `npm run approve`, `make approve`, `git mrun <rule>`, or even
  a plain `npm install` that triggers a `postinstall` script — to the exact
  action a guard would otherwise catch. The tool call the hook actually
  inspects is `npm run approve`; the word `softela-ai` and the word `approve`
  never sit next to each other anywhere in that string, because the
  indirection lives in a file this hook does not open.

None of these are gaps in a particular pattern; they are the shape of the
problem. A hook that inspects one command's text, once, before it runs,
cannot observe a value that does not exist yet at that moment, or a mapping
that lives in a file outside the call it was invoked on. Closing any of them
for real needs a different mechanism than text inspection — e.g. intercepting
what a command actually does at execution time (a sandboxed or traced run)
rather than what its pre-execution text says, which is a materially larger
undertaking than adding another pattern.

## What is handled today

Because the gap above is architectural, the value that *is* deliverable is
recognizing every way a real shell reconstructs the same, un-encoded command
before a guard's verb-matching regex ever runs. `core/lib/shell-parse.js`
normalizes a statement's leading word — and, for the mandatory rule
specifically, the whole raw command text — against:

- **Quoted command words** — `"git" push`, `'git' push`, `'softela-ai' approve
  <rule>` — recognized identically to the unquoted form, at command-start
  position, the same way a real shell (bash, PowerShell's `&` call operator,
  cmd) executes them.
- **ANSI-C quoting** — `` $'git' push `` — bash's `$'...'` form, distinguished
  from a plain literal `$` character.
- **`${IFS}` / bare `$IFS` substitution** — `softela-ai${IFS}approve${IFS}<rule>`
  — recognized as a word boundary, matching how an unquoted `IFS` expansion
  actually word-splits in a real shell.
- **Backslash-newline line continuation** — a literal `\` immediately before
  a newline, mid-command — collapsed to a single space before matching, the
  same way a real shell deletes the pair and joins the two lines into one
  command.
- **Nested shells** — `bash -c "..."`, `powershell -Command "..."`,
  `cmd /c ...`, `eval`, and an `env VAR=x` prefix — unwrapped recursively (up
  to a bounded depth) so a rule matching on any layer catches a forbidden
  command hidden behind a wrapper without needing to know shells nest at all.
- **For the mandatory rule only, a conservative whole-text scan.** Every
  precise check above is statement-scoped: it can still be defeated by
  splitting the two words a check depends on across separate statements — a
  parameter-expansion default, a brace expansion, or an alias defined in one
  statement and invoked in a later one. `infra-self-protection` backstops
  exactly that with `evaluateRawShellConservative`: once every statement-level
  check has found nothing, it reads the entire raw command as one blob, with
  no statement or quote boundaries, and returns **ask** (deliberately weaker
  than the precise checks' **deny**) when the tool's own name and the word
  `approve` both appear anywhere in the text, or the state directory's name
  and a destructive verb both do. Only `infra-self-protection` carries this
  backstop — it is the one rule with no config tier or override able to
  soften it, so it is the one rule where a false negative is unacceptable
  enough to justify the false positives the next section describes.

## The false positives the mandatory rule accepts by design

`evaluateRawShellConservative`'s whole-text scan cannot tell a genuine
self-approval attempt from an unrelated command that happens to mention both
watched words. A commit message documenting this repository's own approval
flow (`git commit -m "explain how softela-ai approve works"`), or a `grep -rn
"softela-ai approve"` search through this project's own source, will `ask`
instead of passing silently — the developer sees one interruption to confirm
a call that was always safe.

This trade is deliberate, not an oversight the next round should close. The
mandatory rule is, by construction, the one place in the system with no
tier-2 project switch and no tier-3 override able to soften a wrong decision
after the fact — every other rule can be dialed back if it fires too often;
this one cannot. Weighed against that, the two failure directions are not
symmetric: a false positive here costs one approval prompt for an already-
safe action. A false negative would mean the one rule this whole system's
approval model depends on — "approval means a person, because an agent
granting its own approval never passes through a hook" — silently stopped
holding, with nothing left to catch it. Coarsening the conservative scan
until it stopped ever firing on an innocent grep pattern would only be
possible by adding back the statement-scoped precision the scan exists
specifically to not have.

There is one exception, and it is a shape rather than a pattern. A log
analysis one-liner — `node -e '…'` reading the state directory's logs, with
`rm` or `mkdir` sitting inside a regular expression it searches for — paired
the state directory's name with a destructive verb and asked every time. The
scan is now skipped for a command that is, in its entirety, one single-quoted
`node -e` / `--eval` / `-p` / `--print` script (`isSealedReadOnlyNodeCommand`),
and only on the `Bash` tool. "In its entirety" is one anchored test over the
raw text — nothing before `node`, nothing after the closing quote, only
spaces and tabs between `node`, the flag and the quote — not statement
parsing, so it brings none of the statement-scoped precision back.
Inside single quotes a POSIX shell expands and runs nothing, and the code
itself must name no way to run other code or start a process (`eval`,
`Function`, `import`, `child_process`, a `require` of anything but `fs`,
`path`, `os`, `util` or `readline`, and the like), no call that changes a
file, and, stricter than the deny half's own test because a miss here
silences the scan, none of the following, which the deny half tolerates so
that a read is not hard-denied: any other built-in module used as a bare
global (`vm`, `cluster`, `v8`, and the rest of the running Node's own list), a
short file-changing name in any position rather than only a call, the words
`flag` and `flags`, a `new` of anything but a few harmless built-ins, a call
on a computed member or a call result, a tagged template, and any spelling
that builds a name without writing it out (escaped bracket subscripts, joined
string literals, `fromCharCode`, the prototype-walking functions), plus the
words `fetch`, `WebSocket`, `EventSource`, `WebAssembly`, `setPriority` and web
storage. Three rules close whole families at once rather than one shape at a
time. First, `fs` is only ever used as `fs.<member>`: every occurrence of the
identifier is either the one binding `const fs = require("fs")` or directly
followed by a member access (`fs.promises` by another one), and every
`require("fs")` is that binding's initialiser or directly followed by a member
access, so a destructuring in any spelling, a spread, `Object.keys(fs)`, a
`for … in`, a `with`, an array or an alias of `fs` is refused without listing
any of them. Second, an HTML-like comment — `<!--` anywhere, `-->` at the start
of a line — is refused, since Node's sloppy-script grammar reads both as line
comments that can sit between a dot and a name. Third, the built-in-module ban
sees a spread (`{...vm}`), and the call-shape tests (`new`, `](`, `)(`, a tagged
template) run on the raw code and on two copies with the comments removed, so a
comment between the tokens hides nothing. The exception alone reads
`process.stdout.write(` as output. That is what keeps the argument above
intact: the scan exists for evasions that rebuild a verb out of separate
statements, and a sealed script has no statement, no shell and no capability
to rebuild one with. A script that is disguised past those lists — a function
name assembled at run time — is out of scope here exactly as it is for the
scan itself. Two gaps that need a deliberate trick stay open, and the list
below records them.

## Known open gaps

The list above is what closing three rounds of concrete, reproduced attacks
actually produced. The most recent attack pass, run after those fixes,
reproduced further gaps that remain open — recorded here rather than left
implicit, because a document that only lists what got fixed would let a
reader believe the coverage is more complete than it is. Each is a specific
instance of "literal-substring matching cannot see a spelling it was never
taught," not a new category of problem:

- **The state-directory matching reads a few spellings and not others.**
  `matchesStateDirGlob` expands `*` and `?` in the segment right after the
  host home, `matchesStateDirRelativeToCwd` resolves a bare state-directory
  name against a working directory that is an agent home, `hasFindRemove`
  reads `find … -delete` and `-exec rm`/`-exec unlink`, and
  `INLINE_DESTRUCTIVE_INDICATOR_RE` reads `shutil.rmtree`, `os.remove` and
  Node's `rmSync`. What none of them reads: a bracket class or a brace
  expansion in that glob segment (`rm -rf ~/.claude/.softe[l]a-ai`,
  `rm -rf ~/.claude/.soft{ela-ai,x}`); a wildcard in the host-home segment
  itself (`rm -rf ~/.cl*/.softela-ai`, `rm -rf ~/.c*/.s*`); a glob in a bare
  name when an agent home is the working directory (`rm -rf .soft*`,
  `rm -rf .*`, `rm -rf .softela-a?`); a path that reaches the state
  directory through the working directory in a form that resolution does not
  read (`rm -rf $PWD/.softela-ai` run from an agent home,
  `rm -rf ../.softela-ai` and `rm -rf .softela-ai` run from a subfolder of
  one); a command run from inside the state directory that names no path to
  it (`rm -rf *`, `find . -delete`, `rm overrides.json`); and a `find` that
  hands each match to another changing command, or a tool that removes by
  its own flag, or a shell's own alias for a verb, since `REMOVE_VERBS` and
  `PERMISSION_VERBS` stay closed lists
  (`find <state-dir> -type f -exec shred -u {} \;`, `-exec mv {} /tmp \;`,
  `rsync -a --delete /tmp/empty/ <state-dir>/`, and PowerShell's `ri`, which
  is not in the list: `ri <state-dir> -Recurse` passes, while `ri` given the
  full path of `overrides.json` is still caught by the name). **What
  would close this**: expanding bracket classes and braces in the glob
  segment and wildcards in the host-home segment, expanding a glob in a bare
  name against an agent home used as the working directory, resolving
  `$PWD` and `..` against the working directory, treating a working
  directory inside the state directory as a state-directory reference, and
  widening the `find -exec` and verb lists — the same mechanisms already in
  place, not yet exhaustive.
- **The read-only exemption for an inline interpreter script is a list of
  names.** A `node -e` or `python -c` one-liner that mentions the real
  `overrides.json` or `approvals.json` is read-only only when it passes the old
  test exactly as it was (the old unanchored recogniser, which takes `-e` and
  `--eval` only, and the old write net `LEGACY_INLINE_WRITE_RE`, `.write(`
  included) **and** the new detections on top of it — so the deny half is
  strictly additive over the old test and nothing the old test denied can pass.
  The new detections read the statement without its trailing comment and
  without the text of its leading assignments, refuse a double-quoted script
  in which the shell expands something (`$(`, a backtick, `${NAME:-…}`,
  `${!NAME}`; a bare `${NAME}` is a variable's value and a `$` or backtick
  after an odd number of backslashes is escaped, and for the PowerShell tool
  the backtick is its escape character and is not tested), join the one
  apostrophe splice a single-quoted script can hold (`'a'"'"'b'` is the word
  `a'b`) and refuse any other word that runs on past the closing quote, and
  then apply one list per language (`nodeScriptChangesFiles`,
  `pythonScriptChangesFiles`), because Python's `.replace(` and `.rename(`
  would otherwise catch ordinary JavaScript string code. Node's list is the
  unambiguous long names anywhere, the options that turn a read into a write,
  the short names as member calls, `fs`-specific destructuring where a binding
  is written (after `const`/`let`/`var`, in an import list, as a parameter, or
  as an assignment — not an object literal or a function body that holds a
  local of that name), bracket strings of the `fs`-specific names, an `open`
  that can write (a callback as the second argument is the no-mode form and
  reads), and code loading (a dynamic `import(` of one built-in module name is
  plain, except the modules that run code); the code-running globals (`vm`,
  `cluster`, `inspector`, `repl`, `v8`, `wasi`, `trace_events`) count only as an
  object, a call or a spread, never as a bare word, so a loop variable, a label
  or a home folder named `dev-vm` is not one. The shapes that hide a name — a
  comment right after a member dot, a `with (`, a renamed `open` — are read on
  the script with its string and template text blanked. A write to descriptor 1
  or 2 (`fs.writeSync(1, …)`) is neutralised by the new detections only; the
  old net never counted it. Python's covers `shutil`, `os`, pathlib-style
  methods, every `open(` read with balanced parentheses, every process start,
  loaded code and the commoner rarer writers; `zipfile`, `tarfile`, `dbm` and
  `shelve` count only in an import or a member position, `__import__` only with
  a non-literal argument or one of the modules that change files or load code,
  `getattr` on `os`, `shutil`, `pathlib` or `Path` only with a changing or
  non-literal name, a pandas `.to_*(` only when it names a file, and an
  assignment to `sys.stdout` or `sys.stderr` only unless it wraps the real
  stream's own buffer. A read, and a shell verb mentioned only as data, passes;
  a few reads are refused on purpose because the old test passed them and the
  detections cannot tell them from a write (any `child_process` or `copyFile`
  word anywhere, a binding that renames `open`, a non-literal `open` mode, a
  `from os import *`). Others are refused although they only read, and those
  are known false denies, not a choice: any `.eval(` in a Python script
  (pandas `df.eval(…)`), `from pathlib import *`, and a script followed by a
  descriptor redirect with no space (`'…'2>/dev/null`; a redirect without a
  descriptor number, a pipe or `;` after the quote is fine). A double-quoted
  `node -e` script that holds its own unescaped double quotes is refused too,
  on either shell tool and also under `cmd /c`, and on the PowerShell tool so
  is one whose inner quotes use PowerShell's own escapes (a backtick or a
  doubled quote); a backslash-escaped inner quote or an inner single quote is
  fine. None of these refused forms is a read as written: the inner quotes do
  not reach node intact, so node receives a different, broken script and
  fails with an error instead of running it. Removal detection keeps the
  loose recogniser, which also takes `-p`, `--print`, `-pe` and `-ep`, and
  reads the statement as written, since recognising more is the strict
  direction there. A `node -p` or `--print` statement that names either file
  is not a read-only script, as before.
  **What stays open**: a state path built at run time (`os.homedir()`,
  `Path.home()`, a name joined from two strings) that never names
  `approvals.json` or `overrides.json`; a script that changes the state
  directory itself without naming either file (renaming or copying over the
  directory, truncating a log), and the plain shell form of the same change
  (`mv <state-dir> …`, `cp -r … <state-dir>/`); a `$NAME` or bare `${NAME}`
  expansion that builds code inside a double-quoted script or carries the
  whole script (`M=copyFileSync; node -e "require('fs').${M}(…)"`,
  `S='…'; node -e "${S}" "<file>"`), on the PowerShell tool as well; a static
  `import` of a file under `--input-type=module` (`import "/tmp/w.mjs"`,
  `import x from "/tmp/w.mjs"`), since only a dynamic `import(` is read; a
  binding position the destructuring detection misses (an assignment pattern
  after another `=`, as in `a={unlink:r}=require("fs")`; a comment between the
  pattern and its `=`, as in `const {unlink:u}/**/=require("fs")` or `<!--x`
  and a newline; a short-named `fs` member (`unlink`, `rename`) taken as a
  value and called later, as in `const u=require("fs").unlink; u(…)`); a
  quote or a backtick inside a regular-expression literal (`x=/"/;…`,
  ``x=/`/;…``) and an escaped quote inside a string literal (`x="\"";…`,
  `x="a\"b";…`), which desynchronise the blanking of string text, so the
  blanked copy the textual tests read hides the code after it (a `with (`, a
  comment after a member dot, a renamed `open`); a script whose printed
  output is then executed (`| sh`, `$( … )` at command position); a quoted
  argument that merely contains `node -e '…'`; `node -e` run with a
  preload flag or `NODE_OPTIONS`; names disguised at run time
  (`fs["write" + "FileSync"]`, a name in a variable, a short name held in a
  string and used one step later, which the old test passed too, a `getattr`
  through an alias); pathlib's `.rename(` and
  `.replace(` reached through an alias or a variable (called directly on
  `Path(…)` they are recognised; bare they collide with `str.replace` and
  `DataFrame.rename`); and writers rarer than the lists name (`ctypes`,
  `multiprocessing`, `os.startfile`).
- **The sealed `node -e` exception has two gaps, each needing a deliberate
  trick.** First, a comment between `require("fs")` and a computed member
  (`const fs = require("fs")/**/[k];`, or `//c` and a newline) is still taken
  for the one plain binding, so `fs` can hold a function chosen at run time
  (`k` read from a file) and be called as `fs.call(…)`: the rule that every
  `require("fs")` is that binding's initialiser or directly followed by a
  member access has this exception. Second, read options, or an
  `Object.prototype` entry, loaded from a data file (a `JSON.parse` of a file
  that holds `{"flag":"w"}`, or a merge of `{"__proto__":{"flags":"w"}}`)
  reach the `open` behind a plain read call and can truncate or create the
  file, because the words `flag` and `flags` are refused only when they are
  written in the command. What each one reaches depends on the key. Loaded
  options carrying `flag` reach `readFileSync`, `readFile` and
  `promises.readFile`; loaded options carrying `flags` reach
  `createReadStream`. An `Object.prototype` entry named `flags` reaches
  `createReadStream` whatever it is called with, even with no options or a
  string; an entry named `flag` reaches `readFileSync`, `readFile` and
  `promises.readFile` when they are given an options object, even one that
  holds only `encoding`, and not when they are given no options or a string.
  **What would close this**: accept the binding only when its declarator
  ends right after `require("fs")` (`;`, `,` or the end of the script);
  accept a read call (`readFile`, `readFileSync`, `promises.readFile`) only
  when its options argument is absent or a string literal (a callback after
  the path is fine), which closes the loaded options and the `flag` entry;
  and refuse `createReadStream` altogether, since only that removes the
  `flags` entry, which no argument shape avoids.

None of these three are reachable by an agent that does not already know they
exist — the point of recording them here is that they are now known, not
that they are exploitable in the ordinary course of work.

## The host cannot be validated by CI

`tests/probes/` empirically checks facts about the real `claude` and `codex`
binaries — hook-config shape, event-key casing, hook trust — established by
running the actual CLIs, not read from documentation that could drift out of
date. A hosted CI agent has neither CLI installed, and every probe reports
itself as **skipped**, not failed, when its binary is absent — visibly, in
its own counted column, never folded into a false pass. See
`docs/guide/ci.md` for the full accounting of what a green pipeline run does
and does not prove; the short version is that CI validates the rule engine,
the installer, and every module, but the claim "the installed hook actually
intercepts a real tool call the way `tests/probes/` says it does" is only
ever checked where the real binary is present — a developer's own machine, or
a self-hosted agent with both CLIs installed and authenticated. A green
pipeline run is proof of everything except that one thing.

## The bottom line

Rely on this system for what it is built for: making an accidental or
careless shortcut visible and interruptible before it lands, identically
across every developer's machine. Do not rely on it to stop a developer, or
an agent instructed by a developer, who deliberately wants past it — that
was never the job, and no amount of pattern coverage changes what the
mechanism fundamentally is. Where a specific gap above matters to a
particular team's risk, closing it is a bounded, concrete change to a named
file, not a redesign — that is exactly why each one is written down with
what would close it, rather than left as an unstated asterisk on the
guarantee.
