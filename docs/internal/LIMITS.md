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

## Known open gaps

The list above is what closing three rounds of concrete, reproduced attacks
actually produced. The most recent attack pass, run after those fixes,
reproduced further gaps that remain open — recorded here rather than left
implicit, because a document that only lists what got fixed would let a
reader believe the coverage is more complete than it is. Each is a specific
instance of "literal-substring matching cannot see a spelling it was never
taught," not a new category of problem:

- **Shell globs and cwd-relative paths.** `rm -rf ~/.claude/.softela*` or
  `rm -rf ~/.claude/.*` never contains the literal text `.softela-ai` — the shell
  only produces that name by expanding the glob at run time. Separately, the
  guard never reads `ctx.cwd`: a bare `rm -rf .softela-ai` run from inside the
  agent home already deletes the real state directory without the command
  text containing any recognizable path at all. **What would close this**: a
  glob-aware check (recognizing a wildcard character adjacent to a partial
  match of the protected name) and reading `ctx.cwd` to resolve a relative
  path before comparing it — both are extensions of the existing
  path-matching logic, not a new mechanism.
- **Deletion verbs outside the fixed list.** `REMOVE_VERBS` and
  `PERMISSION_VERBS` are closed lists (`rm`, `del`, `chmod`, `icacls`, and a
  handful more). `find ~/.claude/.softela-ai -delete`, `find ... -exec unlink {}
  \;`, and a one-line `python3 -c "import shutil; shutil.rmtree(...)"` remove
  the same directory while spelling its full, unobfuscated path, because none
  of `find`, `unlink` or `shutil` is on either list. **What would close
  this**: widening the verb lists — the same mechanism already in place, just
  not yet exhaustive against every standard-library and coreutils way to
  delete a directory tree.
- **State-directory matching is not anchored to the real home directory.**
  `STATE_DIR_MARKER` matches any path containing the segment sequence
  `.claude/.softela-ai` or `.codex/.softela-ai`, anywhere on disk — including a
  disposable test fixture that deliberately reproduces that nesting under a
  scratch temp directory, which the mandatory rule then denies unconditionally
  with no override able to let it through. **What would close this**:
  resolving the match against the developer's actual home directory (as
  `lib/paths.js` already computes it) instead of a bare path-segment test.
- **The read-only exemption is a fixed list of literal commands.** A
  statement whose command word is in `READ_ONLY_VERBS` (`cat`, `type`,
  `head`, and similar) and carries no output redirect is treated as a safe
  read. A `node -e "console.log(fs.existsSync(...))"` or `python -c "..."`
  one-liner that only reads the same path is not on that list, so a purely
  diagnostic, read-only interpreter invocation that merely mentions the real
  `overrides.json` path is denied as if it wrote to it. **What would close
  this**: recognizing an interpreter invocation as read-only when its inline
  script contains no matching write construct, the same distinction
  `hasOutputRedirect` already draws for the commands on the fixed list.

None of these four are reachable by an agent that does not already know they
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
