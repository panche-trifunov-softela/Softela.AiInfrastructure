# softela-ai: install plan for an AI agent

> **To hand this over:** paste this whole plan into a Claude Code or Codex session on
> the target machine and say "follow this plan". Stay nearby, because some steps
> are yours.

## Rules for you, the agent

- **Nothing is applied before the human says yes at step 5.** Silence or an
  ambiguous reply does not count as a yes.
- **Your shell has no interactive stdin.** `install` and `update` never prompt
  there; they apply the defaults without asking. `uninstall` and `override` do not ask for
  confirmation there either. They just run. Never run `uninstall`, `override`
  or `approve` unless the human asked for that exact command. `approve` is
  denied to agents anyway.
- **`npm run <script>` silently drops every `--flag`.** When a step needs a flag,
  run `node bin/softela-ai <command> --flag ...` from inside the clone.
- **A blocked tool call means a rule is doing its job.** Show the denial to the human.
  Never edit a hook, `settings.json`, `config.toml` or anything under
  `.softela-ai/` to get past it.
- **Never run `npm test` or `node tests/run.js`.** This plan needs no tests, and
  an uncapped run is denied.
- **Steps marked HUMAN belong to the human.** Ask them, then wait.

## 1. Preflight

```
node --version
git --version
```

You need Node 18 or newer, and git, because the installed hooks call git during a
session. **STOP** if either is missing. Do not install them yourself.

Ask the human where the clone should live, or where their existing clone is.

## 2. Back up (HUMAN first, then you)

**HUMAN:** close every other Claude Code and Codex session on this machine.
This session can stay open.

Then run this as **one** PowerShell command, so that `$stamp` is set for both lines:

```powershell
$stamp = Get-Date -Format yyyyMMdd-HHmm
if (Test-Path "$HOME\.claude") { Compress-Archive -Path "$HOME\.claude" -DestinationPath "$HOME\claude-backup-$stamp.zip" -ErrorAction Stop }
if (Test-Path "$HOME\.codex")  { Compress-Archive -Path "$HOME\.codex"  -DestinationPath "$HOME\codex-backup-$stamp.zip"  -ErrorAction Stop }
```

macOS or Linux:

```bash
stamp=$(date +%Y%m%d-%H%M); cd ~
[ -d .claude ] && zip -rq "claude-backup-$stamp.zip" .claude
[ -d .codex ] && zip -rq "codex-backup-$stamp.zip" .codex
```

The `.codex` zip can take a minute, because the folder can be close to 1 GB.

**STOP** if any line errors, for example "being used by another process", because
this session's own files are still being written. Ask the human to close all
sessions, including this one, run the same commands themselves, and then start a new
session that resumes at step 3.

## 3. Get the code

New clone:

```
git clone https://github.com/panche-trifunov-softela/Softela.AiInfrastructure.git
cd Softela.AiInfrastructure
```

Existing clone: `cd` into it, then `git pull --rebase`.

**HUMAN:** if git asks for GitHub credentials, the human signs in. If
the clone prints nothing for a couple of minutes, assume it is waiting for that
sign-in. Stop and ask the human. Do not retry the clone.

Run every command from here on inside the clone.

## 4. Preview (writes nothing)

```
npm run preview
```

This runs `install --dry-run`. It shows which agent homes it will change (only the
`~/.claude` and `~/.codex` folders that exist are targeted), which modules it will
enable and which files it will write.

If it stops with a **hook-registration conflict** instead, it has written
nothing. A conflict means a hook is already registered that softela-ai did not put
there. Show the report to the human and ask which `--on-conflict` value to use:
`replace`, `reconcile` or `abort`. You will need it in step 6.

## 5. GATE: wait for an explicit yes

Tell the human, in a few lines:

- which agents were found: Claude, Codex or both;
- which modules will be enabled. The default set is `agent-orchestration`,
  `analyze-first`, `frontend-workflows` and `memory-as-context`; `reply-language`
  and `session-cleanup` stay off. Memory location defaults to `global`;
- where the backup files from step 2 are;
- anything unexpected in the preview.

Ask "Apply this?" and wait for a yes. Nothing will ask about modules later, so if the
human wants a different set, get the list from them now for step 6.

## 6. Apply

```
npm run setup
```

If you need a flag (a different module set, or the answer to a conflict), run
the command directly and include only the flags you need:

```
node bin/softela-ai install --modules <id,id,...> --on-conflict <replace|reconcile|abort>
```

**Success:** exit code 0. The installer prints a backups line
(`<agent home>/.softela-ai/backups/<timestamp>/`) only when it overwrote an existing
file, so a clean first install with no backups line is normal. On a machine that
already has softela-ai, this command does the same thing as `update`.

## 7. Check

```
npm run doctor
```

This only reads, it never writes. Exit 0 means healthy; exit 1 means something is wrong, and
the output says what. Look for `drift: none`. With Codex, doctor exits 1 and
shows a **hooks awaiting approval** section until step 9 is done. That is
expected at this point. **STOP** and show the human any other problem.

## 8. Optional steps (ask the human first)

- **`npm link`** (run from the clone) makes `softela-ai <command>` work from any directory.
  `npm unlink` undoes it. If it fails with a permissions error, stop and ask.
- **Product repos:** `node bin/softela-ai link --repo "<path>"` writes a managed
  block into that repo's `AGENTS.md` and a one-line `@AGENTS.md` block into its
  `CLAUDE.md`. It does not commit anything; the human decides whether to commit. Run it
  with `--dry-run` first and show the human the result.

## 9. HUMAN, Codex only: trust the hooks

Codex does not run a newly installed hook until the human finishes Codex's own
one-time hook-trust review. Until then nothing is enforced, and no error is
shown. When the human is done, run `npm run doctor` again; the **hooks awaiting approval**
section must be gone. Doctor can prove that a hook is untrusted, but it cannot prove that one is trusted.

## 10. HUMAN: restart

The human closes and reopens every Claude Code and Codex session, including this one, so
that each session loads the new instructions and hooks when it starts.

## 11. Report to the human

- the backup files from step 2, and any `.softela-ai/backups/` path printed in step 6;
- doctor's exit code and every problem it listed;
- whether `npm link` was run, and which repos were linked;
- what the human still has to do: the Codex trust review and restarting the sessions.

## Later

**Update**, after new commits land on `main`:

```
cd <clone>
git pull --rebase
npm run update
npm run doctor
```

**Caution:** run `update` (and `install`) only from an up-to-date `main`
clone. `update` treats any `projects/<Repo>.json` missing from the current
checkout as no longer shipped, and removes its installed copy under
`<agent home>/.softela-ai/projects/` whenever that copy was never edited by
hand — silently, with no prompt. A branch that predates another repository's
project config, or one where it was deleted or renamed locally, loses that
repository's protections on every machine `update` runs on next. Pull or
check out `main` first.

**Roll back**, only when the human asks for it:

```
node bin/softela-ai uninstall --dry-run   # show what would be removed
node bin/softela-ai uninstall --yes       # removes it (runs without asking in an agent shell)
```

Uninstall removes everything softela-ai installed. It keeps `overrides.json`,
`approvals.json`, the backups folder and any file the human edited by hand.
For a full restore, the human closes every session and restores the step 2
zips.
