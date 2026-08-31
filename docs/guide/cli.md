# CLI reference

Every command `softela-ai` accepts, every flag, its default, and one worked
example — kept flag-for-flag identical to what `--help` prints for it (see
[How this stays in sync](#how-this-stays-in-sync)).

## Running it

Recommended, once, from inside this clone: `npm link`. From then on
`softela-ai <command>` works from any directory — including the product repo
where a rule just blocked you. `npm unlink`, from the clone, undoes it.

| Alternative | Works from | Notes |
|---|---|---|
| `npx softela-ai <command>` | inside this clone only | no setup; outside the clone `npx` fetches from the public registry instead |
| `node bin/softela-ai <command>` | inside this clone only | always works; what this repository's own tests run |

All three run identical code. A flag's value can be written either way:
`--agent codex` or `--agent=codex`. This guide writes `softela-ai <command>`,
meaning any of the above.

`package.json` also ships one-word scripts for the common, no-flag case:

| Script | Runs |
|---|---|
| `npm run preview` | `install --dry-run` |
| `npm run setup` | `install` |
| `npm run update` | `update` |
| `npm run doctor` | `doctor` |
| `npm run remove` | `uninstall` |
| `npm run help` | `help` |

None take flags — npm silently drops any `--…` token, so `npm run doctor
--agent codex` arrives as `doctor codex`, which is refused rather than
running unfiltered. To pass a flag through npm, add the literal `--`:
`npm run softela-ai -- install --agent codex`.

## Getting help without this document

```
softela-ai                    # overview: every command, one line each
softela-ai -h / --help        # same
softela-ai <command> --help   # one command's own flags, defaults and an example
softela-ai help <command>     # same
softela-ai --version          # the installed version, from package.json
```

An unknown command, flag, or flag value outside a fixed set (`--agent`,
`--memory-location`, ...) is refused on stderr with a non-zero exit and the
closest valid name suggested (`softela-ai instal` → `did you mean "install"?`),
never silently ignored. Help text goes to stdout and exits `0`.

## Flags shared by most commands

| Flag | Default | Meaning |
|---|---|---|
| `--agent <claude\|codex\|all>` | auto-detect — every one of `~/.claude` and `~/.codex` that already exists | Target one agent home explicitly, or both with `all`. Not accepted by `test` or `link`. |
| `--json` | off | Machine-readable output instead of formatted text. Accepted by every command. |
| `--dry-run` | off | Compute and print the plan; write nothing. |
| `--verbose` | off | Print every file and setting individually, including ones needing no change — the default instead rolls ordinary added/changed files into one count line. |
| `--yes` | off | Skip the confirmation prompt (`uninstall`, `module`, `override`), or `install`'s first-run module-option questions. No effect where nothing would have prompted. |

## Commands

### `install` / `update`

`install` copies this repository's rules — hooks, prompt text and
settings — into an agent home: `softela-ai install [options]`. `update`
reconciles an existing installation against what the repository ships
now: `softela-ai update [options]`. Same mechanics, identical flags.

Accepts: `--agent`, `--dry-run`, `--verbose`, `--yes`, `--json` (above),
plus:

| Flag | Default | What it does |
|---|---|---|
| `--modules <id,id,...>` | first install: every module with `defaultEnabled: true`; later: whatever is already enabled | Comma-separated module ids to enable, replacing the current selection. `softela-ai module list` prints the ids this repository ships. |
| `--memory-location <global\|infrastructure\|repo>` | `global` | Shortcut for the `memory-as-context` module's `location` option. |
| `--reply-language <lang,lang,...>` | `English` | Shortcut for the `reply-language` module's `languages` option — an ordered preference list. |
| `--on-conflict <replace\|reconcile\|abort>` | interactive terminal: asks, recommending `replace`; non-interactive with an unresolved conflict: stops | How to resolve a pre-existing local hook registration this run finds that `softela-ai` did not put there. `replace` backs up the settings file and disables the conflicting registration so `softela-ai`'s own takes effect. `reconcile` reports the conflicts and stops without merging. `abort` reports and stops, changing nothing. No effect when nothing conflicts. |

A real run backs up every file it is about to change into `<agent
home>/.softela-ai/backups/<timestamp>/` first, and prints that directory.
Auto-detection only targets an agent home that already exists on disk.

```
softela-ai install --dry-run
softela-ai install
softela-ai update
```

### `doctor`

Report what is installed, what has drifted, every active override and
approval, and the enabled module set: `softela-ai doctor [options]`.

Accepts: `--agent`, `--json`.

```
softela-ai doctor --agent claude
```

### `test`

Run this repository's own self-test suite — identical to `npm test`:
`softela-ai test`.

Accepts: `--json` only (prints `{"ranFrom": "<path>"}` instead of letting
the suite's own output stream through).

### `uninstall`

Remove every manifest-tracked file, this installer's own hook
registrations, and the managed instructions block — never
`overrides.json`, `approvals.json`, or a locally-modified file (that one is
reported and left in place instead): `softela-ai uninstall [options]`.

Accepts: `--agent`, `--dry-run`, `--yes`, `--verbose`, `--json`.

```
softela-ai uninstall --yes
```

### `approve`

Grant yourself a time-boxed exception for one rule, from your own
terminal — never from inside a tool call, which is the whole point (see
[`configuration.md`](configuration.md)) — or list what is currently live:
`softela-ai approve <ruleId> [options]` / `softela-ai approve --list [options]`.

Accepts: `--agent`, `--json`, plus:

| Flag | Default | What it does |
|---|---|---|
| `--minutes <N>` | `60` | How many minutes the approval stays live. |
| `--list` | off | List currently active approvals instead of granting a new one. |

```
softela-ai approve forbidden-commands --minutes 30
```

### `module`

List this repository's opt-in modules, or enable/disable one for an
agent — `softela-ai module <list|enable|disable> [id] [options]`.
`enable`/`disable` reuse `install`/`update`'s own plan-then-apply path, so
they get the same backups and ownership tracking.

Accepts: `--agent`, `--dry-run`, `--verbose`, `--yes`, `--json`, plus
`--memory-location` and `--reply-language` — meaningful when the module
being enabled is `memory-as-context` or `reply-language` (same flags as
[`install` / `update`](#install--update) above).

```
softela-ai module list
softela-ai module enable session-cleanup
```

### `link`

Write the per-repository `AGENTS.md` / `CLAUDE.md` pointer into a product
repository: `softela-ai link [options]`.

Accepts: `--dry-run`, `--json`, plus:

| Flag | Default | What it does |
|---|---|---|
| `--repo <path>` | the current working directory | The product repository to write the pointer into. |

```
softela-ai link --repo ../Softela.SCExpert
```

### Pruning session transcripts

Not an `softela-ai` command. The `session-cleanup` module installs it as the
host's own in-session command instead — `/clean-sessions` on Claude Code,
`$clean-sessions` on Codex — so it works without this CLI being on `PATH`
at all, which is the state most developer machines are actually in.

Two arguments, and no others:

| Flag | Default | What it does |
|---|---|---|
| *(none)* | the sessions nearest the work | Claude Code sweeps the current project; Codex sweeps today, since it files transcripts by date rather than by project. |
| `--all` | off | Every session on the machine except the live one. |
| `--apply` | off — dry-run report only | Actually delete. Without it, only report what would go and how much space it would free. |

Two things it will not do, whatever the arguments say: the live session is
never deleted, and nothing under a directory named `memory` is ever touched.
Both are enforced in the script rather than left to a flag.

### `override`

Set, list, or undo a local softening override for one rule — backed up
first, with a required reason. See
[`configuration.md`](configuration.md#softening-a-rule-for-yourself-only)
for what an override can and cannot do:
`softela-ai override <ruleId> <off|ask|deny> --reason "<why>" [options]`,
`softela-ai override --list`, or `softela-ai override --undo`.

Accepts: `--agent`, `--dry-run`, `--yes`, `--json`, plus:

| Flag | Default | What it does |
|---|---|---|
| `--reason <"why">` | required when setting | Why this override exists; shown back by `doctor` and `override --list`. |
| `--project <id>` | global (every repository) | Scope the override to one project id instead of every repository. |
| `--list` | off | List currently active overrides instead of setting one. |
| `--undo` | off | Restore the most recently backed-up `overrides.json` instead of setting a new override. |

```
softela-ai override forbidden-commands ask --reason "DevOps tooling"
```

## How this stays in sync

`softela-ai <command> --help`'s Options section is generated from one registry
(`COMMANDS` in `core/installer/index.js`) that the argument parser itself
validates every flag against — an unlisted flag is refused before the
command runs. `tests/installer/help.test.js` asserts every command's real
`--help` flag set equals `COMMANDS[command].flags` exactly, so the parser
and its own help text can never silently drift apart. Keeping *this file*
aligned with both is a manual step: update the tables above in the same
change that adds, removes or renames a flag in `core/installer/index.js`.
