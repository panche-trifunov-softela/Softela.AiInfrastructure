# Probes

A probe is not a unit test. Everything else under `tests/` asserts facts
about *this repository's own code* — a `ctx` in, a decision out — and can run
anywhere Node runs, forever, unchanged. A probe asserts a fact about *the
host CLI itself*: exactly what CONTRACTS.md §7 records about how Codex's
`hooks.json` is shaped, which event-key casing fires, whether an untrusted
hook stays inert, and what Claude Code's own settings validator accepts.
Those facts were established once by running the real binaries, not read
from vendor documentation, and a vendor release can quietly change any of
them. This directory is what would notice.

## Why skip, not fail (and not a silent pass either)

`node tests/run.js` has to stay green on a machine that has never heard of
Codex, and on one that has never heard of Claude Code either. A probe whose
host is missing is not a failure of this repository — there is nothing here
to be wrong. So a probe **skips** instead: `tests/harness.js` has a third
state beyond pass/fail, `skip(label, reason)`, distinct from a passing
`test()` call. It shows up in `node tests/run.js` output as its own line,
counted separately from both `passed` and `failed`:

```
skip probes/codex-host :: codex host probes -> codex is not installed on PATH

=== 1338 passed, 0 failed, 12 skipped ===
```

so a skip stays **visible** — folding it into the pass count, even with a
label suffix, would read as coverage that was never actually exercised. A
probe also skips when the host *is* installed but a single run of it was
inconclusive (killed at its timeout before reaching a decisive point) — that
is treated the same way, never as a failure and never as a silent hang.
`tests/probes/_host.js` is what runs the host and decides which case
applies; see its `runProbe` for the exact rule.

A developer who wants proof the probes actually ran, rather than skipped,
can pass `--strict-skips` (`node tests/run.js probes/ --strict-skips`),
which turns every skip in the run into a failure. CI never uses this flag —
see `docs/guide/ci.md` for why a hosted agent legitimately skips both files.

## Running deliberately

```
node tests/run.js probes/                  # both probe files
node tests/run.js probes/codex-host        # Codex only
node tests/run.js probes/claude-host       # Claude Code only
```

Every probe also runs as part of a plain `node tests/run.js`, since that is
the only way drift gets noticed without someone remembering to look. Expect
the Codex file in particular to take real wall-clock time: `codex exec`
never exits on its own against an unauthenticated scratch home, so each of
its probes deliberately lets it run for a few seconds and then kills it —
see `codex-host.test.js` for why that is not the same thing as the
inconclusive-timeout case above.

## What each file actually checks

### `codex-host.test.js`

Reuses the exact oracle CONTRACTS §7 documents: point `CODEX_HOME` at a
disposable directory and run `codex exec --skip-git-repo-check "x"` with
empty stdin. The hooks-config parse warning — and, under
`--dangerously-bypass-hook-trust`, hook firing itself — happens before any
authentication attempt, so an unauthenticated scratch home is a free,
deterministic oracle; the 401s that follow it are never inspected. Checked:

- a top-level `{"PreToolUse": ...}` document still produces `unknown field
  "PreToolUse", expected "description" or "hooks"`;
- the `{description, hooks: {...}}` shape still parses without that warning;
- a `SessionStart` hook (PascalCase) fires under the bypass flag, proven by
  a marker file the hook command writes;
- the identical hook under `sessionStart` (camelCase) does **not** fire,
  under the same flag;
- the identical PascalCase hook does **not** fire without the flag, which is
  the trust requirement CONTRACTS documents.

### `claude-host.test.js`

Claude Code has no equivalent unauthenticated oracle that fires a real
hook — every path that reaches `PreToolUse` for real starts an interactive
or model-backed session, and spending the developer's own credentials (or
hanging on an auth prompt) is not an acceptable price for a test probe. So
this file never starts a real session. Instead it uses `CLAUDE_CONFIG_DIR`,
which fully redirects Claude Code's home directory, together with
`claude doctor` — documented as reading settings files without a trust
prompt, and confirmed here to run entirely offline. Checked:

- `CLAUDE_CONFIG_DIR` really does redirect settings validation: doctor's
  reported error path is read back and asserted to point inside the
  disposable directory, never at the developer's real `~/.claude`;
- the installer's exact `{matcher, hooks: [{type: "command", command}]}`
  fragment (INSTALLER.md §5) parses without a `hooks` validation error;
- a hook entry missing its `type` field is rejected, so the "no error" case
  above is known to mean something rather than doctor ignoring `hooks`
  entirely;
- an event key outside the exact documented casing (`pretooluse`) is
  rejected by name, and the valid-events list doctor prints names
  `PreToolUse` in exactly that casing.

**What this file does not, and cannot honestly, check**: that a hook
registered in `settings.json` actually intercepts a real tool call. Doing
that for real needs a live Claude Code session, which needs either
authentication or a running host loop this suite has no safe, offline way to
drive. If a future release adds an offline way to prove firing the way
Codex's `exec` subcommand does, this file should grow that check; until
then, the shape validation above is the honest limit of what runs here
without touching the developer's real configuration or credentials.

## Isolation

Every probe in both files works against a disposable directory created
under the OS temp directory (`host.mkTempDir`), passed to the host through
its own override — `CODEX_HOME` for Codex, `CLAUDE_CONFIG_DIR` for Claude
Code — and removed afterwards (`host.removeTempDir`, which retries briefly
before giving up, since a just-killed process can hold a file lock for a
moment on Windows). Nothing in this directory reads, writes, or mutates the
developer's real `~/.codex` or `~/.claude`.

## No shell, even here

CONTRACTS §1 bans a shell dependency everywhere in this repository,
including in tests, and a probe is not an exception. On Windows an
npm-installed CLI is typically a `.cmd` shim that Node cannot execute
without one — `tests/probes/_host.js` resolves that shim by reading it as
plain text, extracting the real `.js` entry point npm's generated shim
always ends by invoking, and running that directly through
`process.execPath`. Nothing here ever asks `cmd.exe`, `powershell.exe`, or
any POSIX shell to interpret a command line.
