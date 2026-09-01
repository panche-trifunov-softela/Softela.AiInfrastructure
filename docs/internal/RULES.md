# Rule catalogue — implementation specification

One entry per file in `core/guards/`. Read `CONTRACTS.md` first; this document
assumes the rule-module contract, `ctx`, the override clamp and the decision
helpers.

`defaultAction` is the **strongest** action a rule may ever return. A rule may
return something weaker for a weaker case; it may never return something
stronger, and the engine clamps it if it tries.

Three states, and the difference is load-bearing:

- **deny** — blocks the call. Reserved for what is unambiguous and destructive,
  or for a trap where proceeding produces a silently wrong result.
- **ask** — the developer decides. Used wherever the convention is real but not
  universally followed, and wherever a legitimate exception exists.
- **pass** — silent.

A rule that fires on ordinary work gets switched off, and then it protects
nothing. **Negative cases matter more than positive ones**, and every rule's
test file must carry more of them than positive ones.

---

## Shared expectations for every rule

- Shell rules run per statement: split the command line with
  `shell-parse.splitStatements` and evaluate each. `cd x && git push` must be
  caught; `git log --oneline | head` must not.
- Every regex that matches a command uses `shell-parse.START` so a word inside
  a path, a message or a pipeline argument does not read as an invocation.
- Every denial carries a `fix`.
- Reasons are written for a developer reading one line in a terminal. State the
  rule, then why. No scolding, no exclamation marks, no capitals for emphasis.
- A rule that needs a project fact reads it from `ctx.project`. **A repository
  name, filename, branch name or build quirk must never appear in guard code.**
  The only names allowed in `core/guards/` are the rule ids themselves.
- File rules apply to `Write`, `Edit` and their Codex equivalents. Match tool
  names with `/^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|edit_file|write_file)$/`.
- Shell rules match `/^(Bash|PowerShell|shell|local_shell|run_command)$/`.

---

## Group 1 — git and version control (`group: "git"`)

### `no-push-to-base` · deny
Fires when a `git push` targets a branch in `ctx.project.baseBranches`, or when
the push is a force-push to any branch that matches
`ctx.project.releaseBranchPattern`, or when the current branch IS a base branch
and the push has no explicit refspec.

A push to the developer's own feature branch passes. This is the rule that most
needs to be precise, because pushing a feature branch is routine.

- deny: `git push origin dev-ng`, `git push --force origin releases/26.2`,
  `git push` while checked out on a base branch, `git -c x=y push origin main`
- pass: `git push origin feature/task_1_x`, `git push -u origin HEAD` on a
  feature branch, `git push --dry-run` … no: still deny for a base branch, the
  point is the habit
- evasion: `cd sub && git push origin dev`, `git push origin HEAD:dev-ng`

Fix: open a pull request and let it land by squash merge.

### `no-local-merge-to-base` · deny
Two shapes, both denied:
- `git merge <anything>` while the **current branch is a base branch**
- `git checkout dev && git merge feature/x` in one command line

Also denies `git push --force`/`--force-with-lease` to a base branch, which
belongs to the same failure.

Fix: a pull request with a squash merge.

### `pull-must-rebase` · deny
`git pull` without `--rebase`, and `git pull --no-rebase`. Passes when
`pull.rebase` cannot be read — the guard does not shell out to inspect config;
it looks only at the command line, and states in its reason that
`git pull --rebase` is the form to use.

- pass: `git pull --rebase origin dev-ng`, `git fetch origin`

### `branch-naming` · ask · `requiresConfig: ["branchNaming.pattern"]`
Fires on `git checkout -b <name>`, `git switch -c <name>`, `git branch <name>`.
Compares `<name>` against `ctx.project.branchNaming.pattern`; the action comes
from `ctx.project.branchNaming.action`, defaulting to `ask`.

**Never deny by default.** Real branches on origin legitimately vary, and a hard
denial blocks work a person intends to do. The reason quotes
`branchNaming.preferred` so the correct shape is one glance away.

- pass: a name matching the pattern, and any checkout of an existing branch
  (`git checkout dev-ng` has no `-b`)

### `commit-message` · deny / ask
Only fires on `git commit`. Reads the subject with
`shell-parse.extractQuoted(command, /-m/)`.

| Case | Action |
|---|---|
| a co-author or AI-attribution trailer anywhere in the command | deny |
| a generated-by signature or a robot emoji in the message | deny |
| `--no-verify` or `--no-gpg-sign` | deny |
| a conventional-commit prefix (`feat:`, `fix:`, `chore:`, …) | from `ctx.project.commitMessage.conventionalPrefix`, default `deny` |
| a ticket id (`#` followed by three or more digits) in the subject | deny |
| a staged path listed in `ctx.project.protectedPaths` | that path's action |
| a commit message that could not be read back at all (an unreadable `-F` target, or `-F -` with no heredoc to recover it from) | ask |

The ticket-id row denies, not asks: a real session committed
`#31921 - Probe…` unchallenged under the old `ask` default, and the
developer's standing rule is that a ticket number never appears in a commit
message. `defaultAction` was already `deny` on this rule before that
incident — only the branch itself asked instead of denying.

The conventional-prefix case is configurable on purpose: the shipped default is
a denial, and a repository whose team genuinely uses that convention softens it
in its own project file rather than by editing a guard. This rule's own
`requiresConfig` stays empty — only the conventional-prefix check reads
`commitMessage.conventionalPrefix`; the other rows are deliberately universal
and must never be silenced by that key's absence.

- pass: `git commit -m "Key screen-object coordination state by scope"`,
  `git commit --amend --no-edit`, and any commit whose message merely *mentions*
  one of these words in prose

### `rebase-safety` · ask
Only when `ctx.git.rebaseInProgress`. Then `git rebase --abort|--skip`,
`git reset --hard|--merge`, `git checkout`, `git switch`, `git stash`, and
`git clean -f|-d|-x` all ask.

A rebase in progress is unreproducible state: an abort throws away conflict
resolutions that took real analysis to reach.

- pass while rebasing: `git rebase --continue`, `git status`, `git add <path>`
- pass when not rebasing: all of the above

### `protected-paths` · from config · `requiresConfig: ["protectedPaths"]`
Fires on a file write whose path matches an entry in
`ctx.project.protectedPaths`, and on a blanket staging command
(`git add -A`, `git add --all`, `git add .`) in a repository that declares any
protected path. The action and reason come from the entry.

Path comparison normalises separators and is relative to `ctx.git.repoRoot`
when it can be resolved, absolute otherwise.

### `local-config-isolation` · from config · `requiresConfig: ["localConfig"]`
A frontend repository here keeps runtime configuration in a tracked file that
holds deployed hosts. A developer who wants the app to talk to their own
machine used to edit that tracked file, which put every local retarget one
commit away from shipping to everyone — it already happened, a local host sat
on a base branch as a production API URL. `ctx.project.localConfig` names
pairs of files: a `tracked` file reviewed and shipped, and a gitignored
`perMachine` file the dev server prefers when it exists and a build never
ships. This rule keeps a local host out of the `tracked` file.

Local-host markers are fixed in the rule, not read from config, because they
are universals rather than a repository fact: `localhost` as a whole word, any
address in 127.0.0.0/8, `0.0.0.0`, and the IPv6 loopback including the
bracketed form a URL uses (`https://[::1]:7237`). An entry may also declare
`allowedLines` (lines that may name a local host without firing — for a
tracked file that defines its local origins as named constants present even
when local mode is off) and `switches` (patterns that mean local mode has been
turned on, independent of any host string).

Two routes, deliberately divided:

- **Route A — a file write introduces the value.** Fires on a `Write`/`Edit`
  (and Codex equivalents) whose target is the entry's `tracked` file, when the
  new content carries an offending line or a `switches` match. A write to the
  entry's `perMachine` file always passes — that is the encouraged
  destination. An offending line that is suppressed here is one that is
  already present, unchanged, in the file currently on disk
  (`ctx.readFile`): route A stops the value being *introduced*, route B below
  stops one that is already there being *shipped*. Firing on both from route A
  would mean nagging on every unrelated edit to a file that happens to be in
  local mode, and a rule that fires on ordinary work gets switched off.
- **Route B — a command would commit the value.** Fires on `git add` of an
  offending `tracked` file (explicit pathspec, or a blanket `-A`/`--all`/`.`/
  `./`/`./.` that sweeps one in) and on `git commit` when an offending
  `tracked` file is staged (`ctx.git.staged()`), or, for `git commit -a`/
  `--all`, when any declared `tracked` file on disk offends. Read via
  `ctx.readFile` in both cases, since the on-disk content is what would
  actually be committed.

`action` defaults to `deny` per entry and can be set to `ask` or `off`.

- deny/ask: a `Write`/`Edit` putting `http://localhost:3000` into the tracked
  file; a configured `switches` pattern turned on in the tracked file's new
  content; `git add public/config.js` when that file currently names a local
  host; `git add -A` in a repository whose tracked config currently offends;
  `git commit` with the offending tracked file staged; `git commit -a` with
  the offending tracked file merely dirty (not staged)
- pass: the same host written into `public/config.development.js` (the
  `perMachine` file); a line matching an `allowedLines` pattern; an offending
  line that already exists in the tracked file on disk; `git commit` with only
  unrelated files staged while the tracked file is dirty but not staged; a
  repository whose project config declares no `localConfig`; an entry whose
  `action` is `"off"`
- evasion: `cd sub && git add public/config.js`,
  `git -c x=y add public/config.js`

Reason (route A): "`${tracked}` is tracked by git, so a machine-specific host
committed here reaches everyone who pulls it." Reason (route B): "`${tracked}`
currently points at a local machine, and this command would commit it." Both
default to the entry's own `reason` when set.

Fix: "Put the local value in `${perMachine}` instead — it is per-machine and
never shipped." (route A) / "Restore the deployed value in `${tracked}` and
keep the local one in `${perMachine}`." (route B)

An unreadable file, a missing `repoRoot`, a malformed entry, or a pattern that
fails to compile through `core/lib/safe-regexp.js` all pass rather than throw.
When several entries fire in one call, the most severe decision wins, the same
way `protected-paths` resolves a blanket stage sweeping in several protected
paths at once.

### `forbidden-commands` · from config
Runs each `ctx.project.commands.forbidden[]` entry against the statement. Each
entry supplies its own `action` and `reason`. Nothing is hard-coded.

Also the place where `ctx.project.notOurs` is honoured: a command that runs a
test suite under a `notOurs` path is refused with that path's ownership as the
reason. `requiresConfig` stays empty here: the rule fires from *either*
`commands.forbidden` or `notOurs`, and `requiresConfig`'s all-of-these-paths
semantics cannot express "at least one of two" — the rule's own emptiness
checks already produce the same silence without inventing anything.

### `package-install-flags` · from config · `requiresConfig: ["commands.install.deny"]`
Applies `ctx.project.commands.install.deny` to the statement. Reason and fix
come from the config. Silent for a project that declares nothing.

### `typecheck-invocation` · from config · `requiresConfig: ["commands.typecheck.deny"]`
Applies `ctx.project.commands.typecheck.deny`. This is the archetype for the
whole configuration idea: the pattern encodes one repository's trap — a
type-check invocation that silently checks nothing and exits 0 — and belongs in
that repository's file, never in guard code.

---

## Group 2 — code standards (`group: "code"`)

These rules see the content a tool is about to write. They are advisory in
tone and mostly `ask`, because a false denial on a file write is the fastest
way to get the whole installation removed.

### `file-size-limit` · ask (advisory) · `stacks: ["frontend"]` · `requiresConfig: ["limits.fileLines"]`
On a write, count the lines of `ctx.content`. Over `limits.fileLines.ask` →
ask, naming the count and the limit. **No invented default**: a project that
declares no `limits.fileLines` at all gets no size check — the engine never
even runs this rule for that project, which is what keeps a repository whose
team has not agreed a threshold yet genuinely silent instead of inheriting
someone else's number. Skipped for generated files, lock files, `.json`,
`.md`, `.snap`, and anything under a `notOurs` path.

**A write that leaves the file shorter passes**, even while it is still over
the threshold. Splitting an oversized file means editing it, and firing on
that edit blocks the work the rule is asking for — measured: an agent lifting
a shared helper out of a 1808-line component was stopped mid-refactor.
Deliberately "shorter", not "now under the limit": a file that size is not
fixed in one write.

**`advisoryAsk`.** This is a backstop, not a question for the developer, so on
a host with no interactive `ask` it is surfaced rather than blocking
(CONTRACTS §5 step 9, §7).

**Frontend-only.** The `limits.fileLines` thresholds shipped in
`projects/_presets/frontend.json` are frontend-agreed; no backend threshold is
agreed anywhere in this repository. That makes the rule frontend-specific
rather than stack-agnostic-but-currently-unconfigured — the day a backend
number *is* agreed, it would be judged against a different notion of "one
file" (a `.cs` type is not a `.tsx` component), so it belongs in its own
threshold and its own reasoning, not in this rule extended to a second stack.

### `component-folder-shape` · deny · `stacks: ["frontend"]` · `requiresConfig: ["conventions.componentFolders"]`
Only inside `ctx.project.conventions.componentFolders`. A new component file
must live in its own folder whose name matches the file's base name, with the
main file and an `index` beside it. Fires only when creating a NEW file — an
edit to an existing file that already breaks the shape is not this rule's
business, and saying so keeps it from nagging.

One component, one folder is an agreed, written-down team standard, not a
heuristic: the check is a deterministic match against the file's own path, so
the single case this rule fires on denies outright. The fix names the
concrete corrected path — the folder-and-index shape the file should have had
— so the denial is always actionable. (This raised from `ask` after a real
session dropped a component straight into the shared components root and the
`ask` went unseen: on a host that auto-approves, `ask` is invisible and the
write lands anyway.)

**A colocated `use*.tsx` / `use*.jsx` is exempt.** A `.ts`/`.js` sibling
always was — the folder is named after the component, not after the hook
beside it — but a hook legitimately takes a view extension when it genuinely
returns JSX, so the extension alone cannot tell the two apart. Without the
exemption, `RouteConfiguration/useRouteConfiguration.jsx` was denied for not
sitting in a `useRouteConfiguration` folder of its own, which is the opposite
of the layout this rule enforces. A component whose name merely begins with
the letters `use` (`userCard.jsx`) is not a hook and is still judged.

### `component-types-file` · deny · `stacks: ["frontend"]` · `requiresConfig: ["conventions.componentFolders"]`
A new component's own `.tsx`, or a component-folder hook (`use*.ts`/`use*.tsx`),
may not declare a top-level `interface` or `type` of its own. The standard
names `types.ts` as the file that holds "every type the component and its
internals need" precisely so a caller or a test can import a type without
importing the component or the hook body around it; an inline declaration
defeats that. Fires only when creating a NEW file, same reasoning as
`component-folder-shape` — an inline type predating this rule is a refactor,
not something to relitigate on every further edit — and the fix names the
folder's own `types.ts`.

Governs only the component's own view file and its own `use`-prefixed hook,
never `types.ts`/`types/*.ts`, `constants.ts`, the folder's `index` barrel, or
a test file. The check masks comments and string/template literals, then
tracks brace depth so a `type`/`interface` sitting inside a function body
(genuinely local, not part of the folder's public shape) is left alone. A
type-only import or re-export (`import type { … }`, `export type { … } from
"./types"`) is not a declaration and never matches.

### `component-view-logic` · deny · `stacks: ["frontend"]` · `requiresConfig: ["conventions.componentFolders"]`
A new component view file may not carry `useState`/`useReducer`,
`useEffect`/`useLayoutEffect`, an `addEventListener` call, an `await`, or a
`.then()` chain. Those belong in the component's own `use<Component>` hook —
the standard's first and load-bearing claim, and the one thing nothing checked
before this rule existed: `component-folder-shape` sees where a file sits and
`component-types-file` sees an inline type, so a component could satisfy both
and still put its entire click state machine, a window keydown listener and an
async dispatch inside the view.

The marker list is deliberately narrow. `useMemo` and `useCallback` are NOT
markers: the standard explicitly permits the view "rendering-only logic — a
conditional class, a mapped list, a small piece of formatting", and both are
routinely how that is written. A rule that fired on them would be wrong often
enough to get argued with, and a rule that gets argued with gets switched off.
Calling a custom hook (`useDrillDown(...)`) is not a marker either — that is
precisely what a view is supposed to do.

Fires only when creating a NEW file, same reasoning as its two siblings:
extracting the logic out of an existing view is a refactor, not a condition of
touching it. Governs the view alone — never the folder's own `use*` file
(including `use*.tsx` and `use*.jsx`, which take a view extension when they
genuinely return JSX), never the barrel in any extension, never a test.
Content is masked before scanning, so a marker named only in a comment or a
string does not count, and an import without a call does not either.

The hook and barrel exemptions read `.js`/`.jsx` as well as `.ts`/`.tsx`. On a
JavaScript project a `use*.jsx` hook is still a hook, and denying it for
holding state — the one thing it exists to hold — is exactly backwards.

### `hook-locality` · deny · `stacks: ["frontend"]` · `requiresConfig: ["conventions.sharedHooks", "conventions.componentFolders"]`
The global shared-hooks root (`conventions.sharedHooks`) is for a hook reused
by more than one component; a hook written for exactly one component belongs
inside that component's own folder instead. Fires only when creating a NEW
hook file directly under `conventions.sharedHooks` whose base name, minus its
`use` prefix, matches a component that already exists somewhere under
`conventions.componentFolders` — a folder of that name, or a flat
`<Name>.tsx`/`.jsx` file. The correspondence is a real, bounded scan of the
project's source roots, the same technique `reuse-before-new` uses to look at
the tree; when the scan cannot complete within its bound, the rule passes
rather than guessing.

Deliberately narrow: the match is exact, never a prefix or substring
(`useFoo.ts` is never matched to a `FooBar` component, nor `useFooBarBaz.ts`
to `FooBar`), and it never counts a hook's callers by scanning imports — the
file's own name proving a one-to-one correspondence is the only signal this
rule trusts. A hook with no matching component, a hook already inside its own
component's folder, an edit to an existing file, a barrel, and a test file are
all left alone. The fix names the component's own folder as the destination.

The new hook file itself may be `.ts`, `.tsx`, `.js` or `.jsx`. The
correspondence scan always read `.js`/`.jsx` when looking for the component;
restricting the hook to the TypeScript pair meant the rule could not fire at
all on a JavaScript project, whose shared-hooks root fills up the same way.

### `colocated-tests` · deny · `stacks: ["frontend"]` · `requiresConfig: ["conventions.testFolder"]`
A test file must sit in a `__tests__` directory (`conventions.testFolder`)
inside the folder of the component it covers, not in a distant test tree, and
not in the parent's `__tests__` when the subject is a nested child component.

Same reasoning as `component-folder-shape`, raised from `ask` for the same
incident: a deterministic path check with only one violation shape, and a
fix that always names the corrected path.

### `barrel-exports-only` · deny · `stacks: ["frontend"]` · `requiresConfig: ["conventions.componentFolders"]`
A barrel `index` file inside a component folder may contain only imports,
re-exports, comments and `export type` lines. Any statement, declaration or
side effect is a denial, because a barrel with logic in it is what turns an
import graph into a load-order problem.

Every module extension a project in scope actually writes a barrel in counts —
`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`. Keying it to the
TypeScript pair alone left the rule silently inert on every JavaScript
project, where an `index.js` has exactly the same load-order problem.

### `import-depth` · deny · `stacks: ["frontend"]` · `requiresConfig: ["conventions.pathAliases"]`
A module specifier climbing at least `limits.relativeImportDepth` folders
(default 3) is denied in favour of the project's own path alias.
`../../../../utils/storage` names nothing a reader can place, and it silently
retargets the moment either file moves — which is what stops a component
folder being relocated or extracted without a search-and-replace across the
tree, the property the folder shape exists to give it.

Four gates, and all four have to hold, which is what keeps it quiet:

- **The project declares `conventions.pathAliases`.** A rule whose fix is
  "first go and configure an alias" is a rule that gets switched off, and a
  fix naming an alias the bundler cannot resolve is worse than no rule at
  all. A project that has not adopted aliases never hears from this one.
- **The specifier climbs at least the threshold.** One or two levels is
  ordinary composition inside a feature; three is where the specifier has
  left it.
- **The resolved target lands under a declared alias root**, so the fix names
  the exact replacement. A climb that leaves every configured root produces
  nothing, because there would be nothing to rewrite it to.
- **The file is new** (`newCodeOnly`), like every other structural rule.

Type-only imports count here, unlike in `api-import-boundary`: that rule asks
about runtime coupling, this one asks whether the specifier can be read and
whether it survives a move, and a type-only import fails both the same way.
Comments are stripped first, so a specifier written only in prose or in a
commented-out line is never read as an import. Where two alias roots both
contain the target, the longest wins, so `@components/Common/Table` is
preferred over `@/components/Common/Table`.

### `api-import-boundary` · deny · `stacks: ["frontend"]` · `requiresConfig: ["conventions.componentFolders", "conventions.apiLayer"]`
A file under `conventions.componentFolders` may not import from
`conventions.apiLayer` directly. Components talk to hooks and services; the
network layer stays behind them. A relative specifier's alias resolution reads
`conventions.pathAliases` when the project declares it, but that key is
optional and never gates the rule itself.

### `no-explicit-any` · deny, ratcheted · `stacks: ["frontend"]` · `requiresConfig: ["conventions.contractTypes"]`
`: any`, `<any>`, `as any` and `any[]` in a file under
`conventions.contractTypes`. **Ratcheted, not absolute**: the count in the
incoming content is compared with the count in the file currently on disk
(`ctx.readFile`). Equal or fewer passes; more is denied. A brand-new file has a
baseline of zero.

Ratcheting is what makes this shippable against a codebase that already has
hundreds of them.

### `naming-standards` · deny · `requiresConfig: ["conventions.language"]`
From the organisation's naming wiki page: PascalCase for React components and
their files, camelCase for hooks with a `use` prefix, snake_case for API URL
segments, `I`-prefixed .NET interfaces, PascalCase for .NET types. Applies per
`conventions.language`.

Every one of these checks is a deterministic pattern match against the file's
own name or a declaration in its own content — there is no near-miss or
judgement-call branch here to keep at `ask`, so a genuine mismatch denies,
naming the corrected identifier as the fix.

`language: "javascript"` runs the same checks as `"typescript"`, and both the
component check (`.tsx`/`.jsx`) and the hook check (`.ts`/`.tsx`/`.js`/`.jsx`)
read the JavaScript extensions. The convention is the convention whether or
not the project has adopted TypeScript; the hook check was the one that did
not say so, and read `.ts`/`.tsx` alone.

The two checks partition the space rather than overlapping: **a `use`-prefixed
name is a hook, whatever extension it carries**, so the component check skips
it. Judging a JSX-returning hook as a component denied it with a fix — rename
`useColumnRenderer` to `UseColumnRenderer` — that was wrong in both
directions. A component merely beginning with the letters `use`
(`userCard.tsx`) does not match the hook shape and is still judged.

### `patch-manifest` · deny · `stacks: ["backend"]` · `requiresConfig: ["patchManifest.filePattern", "patchManifest.databasePattern", "patchManifest.requiredEntry"]`
Backend only. A patch manifest that lists database changes without its upgrade
script is a deployment that fails halfway. Reads the manifest content being
written and denies when the declared database section has no corresponding
upgrade-script entry.

Configured entirely from `ctx.project.patchManifest`: the manifest filename
pattern (`filePattern`), how a declared database change is recognised
(`databasePattern`), and the required entry name (`requiredEntry`) are project
config, not constants in the guard — and, since `core/schema/project.schema.json`
now declares this key, a repository can actually ship it.

### `layer-dependencies` · deny · `stacks: ["backend"]` · `requiresConfig: ["conventions.layers"]`
Backend only. Denies a reference pointing outward through the layer
ordering — the domain reaching into the application layer, the application
layer into infrastructure. The load-bearing rule of
`docs/standards/backend-architecture.md`, and the one that decays silently:
a violation costs nothing the day it is written and permanently removes the
ability to test a use case without a database.

Both spellings are checked: a `using` directive in a `.cs` file (including
`global`, `static` and alias forms) and a `ProjectReference` in a `.csproj`.
The `using` is the one that actually happens, since an IDE quick-fix adds it
while the developer is thinking about something else.

`conventions.layers` is an ordered list, innermost first, each entry naming
itself, the path globs that place a file in it, and the namespace segment
(`token`) identifying a reference to it. A file in layer `i` may reference
`0..i`. No project or namespace name appears in the guard.

A reference is matched by whole delimited segment, never substring, so
`Microsoft.ApplicationInsights` does not read as the `Application` layer.
A file in no configured layer — a host or test project — has no ordering to
break and passes.

- deny: `using *.Application.*` from a Domain file, a `ProjectReference` to
  the API project from Infrastructure
- pass: every inward and same-layer reference, framework namespaces, a
  commented-out `using`, a file outside the configured layers
- reads: `ctx.content` only, so an `Edit` elsewhere in a file whose imports
  predate the standard matches nothing; `newCodeOnly` covers the remaining
  whole-file-`Write` case, as `api-import-boundary` does on the frontend

### `transactional-outbox` · deny · `stacks: ["backend"]` · `requiresConfig: ["conventions.transactions.outboxInsert", "conventions.transactions.beginTransaction"]`
Backend only. Denies a domain event written to the outbox outside the
transaction carrying the data change it describes — either with no
transaction at all, or after the commit. Both produce a silently wrong
result rather than a failure: the row lands and the event never does, so
nothing downstream learns the change happened.

**This rule cannot judge the inserted fragment alone.** A plain `Edit`
adding one outbox line reports only that line, with the surrounding
`BeginTransactionAsync` elsewhere in the file — denying on that would block
every edit to a correct handler, which is how a rule gets switched off. The
file is reconstructed in the first way available: `ctx.resultingContent`;
else `ctx.content` when the tool writes a whole file by definition; else the
on-disk text plus the inserted text. The ordering check needs true offsets
in one coherent text, so it runs only under the first two; under the third
the rule still catches the commoner and worse case.

Only a write that actually introduces an outbox insert is judged.

- deny: an outbox insert with no `BeginTransactionAsync` in the file; an
  outbox insert positioned after `CommitAsync`
- pass: an edit inside a handler that already opens a transaction, a write
  introducing no outbox insert, anything outside `conventions.transactions.scope`
  (a query handler, the outbox processor itself), a non-`.cs` file

### `immutable-migrations` · from config · `readsChangeScope: true` · `requiresConfig: ["immutableMigrations"]`
A versioned database migration is applied once and then recorded by version
and checksum in the migration tool's own history table. Editing one that has
already run leaves the file and the recorded checksum disagreeing: the next
run fails against every database that had applied it, and passes against a
fresh one — so the developer who made the edit sees green and somebody else
gets the failure.

Fires only on the intersection of three things: a write, to a path matching a
configured `immutableMigrations` glob, to a file `changeScope` proved already
existed. Each entry carries its own `path`, `action` and `reason`, unioned
across config layers the same way `protectedPaths` is.

**Why this is not `protected-paths`.** That rule is deliberately blind to
whether a file already exists, which is right for a manifest or a credential
and wrong here: writing the NEXT versioned script is the ordinary route for
every schema change, and its path matches the same glob as every script
already applied. A `deny` through `protected-paths` would block routine work.

**Why not `newCodeOnly`.** That flag points the other way — it holds new code
to a standard and softens for code that predates it. Here pre-existence is
what makes the write wrong, not what excuses it, so the rule declares
`readsChangeScope` and reads `ctx.changeScope` in its own `evaluate`.
`readsChangeScope` buys only the computed value; it triggers no softening.
`"new"` and `"unknown"` are both treated as new, and pass — never having
proved a migration pre-exists must not stop anyone writing the next one.

Repeatable scripts, re-applied whenever their content changes, are meant to
be edited in place. Nothing in the guard knows the difference; telling the
two apart is a naming convention belonging to one repository's own scripts
directory, so it lives in that repository's globs.

- deny: an `Edit` of an existing `Database/Scripts/V1_0_0_05__*.sql`
- pass: writing a new `V1_0_0_28__*.sql`, editing an existing `R__*.sql`,
  any path outside the configured globs, any file not proved to pre-exist
- not covered: the staging route (`git add -A` sweeping an edited migration
  in) — that is `protected-paths`' job, and is deliberately not duplicated

### `doc-comment-style` · deny / ask
Enforces the house documentation style on newly written text: judges doc
blocks by their structure (bullets, numbered steps, tags pass at any length;
prose-only blocks ask if they exceed a configurable line threshold) and checks
for ticket ids and obsolete tags anywhere in the written content.

| Case | Action |
|---|---|
| `@example` in a doc block | deny |
| a `/** … */` block in a `.cs` file | deny |
| a prose-only doc block longer than 18 lines | ask |
| more than 6 consecutive `//` lines (a `///` line is not one of them) | ask |
| a ticket id anywhere in the written content, as `#12345` or `task_12345` | deny |

The last row is new and deliberate: a ticket number in a source file is a dead
reference the moment the tracker changes, and it is the one documentation defect
that survives review because it looks like context.

Passes: a long block that is a **list** (bullets, numbered steps, or `@`-tags),
`/// <summary>` in `.cs`, a short block, a Markdown file.

The `///` carve-out is load-bearing, not a detail. A `///` line opens with
`//`, so the run counter used to include it, and a C# member documented
exactly as this rule asks — a summary plus a `<param>` per parameter and a
`<returns>` — trips any sane run threshold on its own. On Codex, where an
`ask` was a hard stop, that denied correct documentation on every properly
documented method. A doc block now ends a run of plain `//` lines rather than
extending it; a genuine run of `//` lines in a `.cs` file still asks.

### `reuse-before-new` · ask (advisory) · no configuration required
Fires when a new file declares an exported helper, hook or type whose name is
very close to one that already exists in the project's source. "Very close"
means: identical ignoring case and a `use`/`get`/`is` prefix, or a
Levenshtein distance of 1 on the significant part.

**Needs no configuration to run.** When a project declares
`conventions.sourceRoots`, the scan is scoped to exactly those roots, same as
before. When it declares none — every backend repository today, and any
repository nobody has hand-configured yet — the scan falls back to the whole
repository root (`ctx.git.repoRoot`, else `ctx.cwd`), which is what makes the
rule live everywhere by default rather than only where someone remembered to
set `sourceRoots`.

**`advisoryAsk`.** A backstop for a search the agent should have done
itself, not a decision only the developer can take — so on Codex it is
surfaced rather than blocking (CONTRACTS §5 step 9, §7).

The search is a bounded filename scan, never a full-text index: only files
with a source extension are compared (`.cs .ts .tsx .js .jsx .mjs .cjs .vue
.razor .cshtml`, narrowed to one language's family when
`conventions.language` is `"csharp"`/`"dotnet"` or `"typescript"`/`"javascript"`,
otherwise both), build-output directories are skipped (`bin`, `obj`, `dist`,
`build`, `out`, `target`, `coverage`, `packages`, `TestResults`, `.vs`,
`.idea`, `.next`, `.turbo`, `.venv`, `__pycache__`, `vendor`), and the total
is capped at 6000 files by default — comfortably above the largest measured
real repository, at 3557 source files — overridable per project
with `reuseBeforeNew.maxScanFiles`. Results are cached per process, keyed by
the roots, the extension filter and the bound together. If the scan cannot
complete within the bound it passes, because "reuse" is a judgement and this
rule only exists to make the developer look.

### `test-structure` · deny · `stacks: ["backend"]`
A test body with no discernible Arrange-Act-Assert shape — no blank-line
grouping, no `// Arrange` style markers, and more than one assertion
interleaved with setup. Deliberately narrow in when it fires: any single one
of those three signals is enough to stay silent, which is what keeps the case
that does fire a genuine, agreed structural violation rather than a guess.

**Backend-only.** Arrange-Act-Assert is a convention of the backend suite;
the agreed frontend testing standard (`docs/standards/testing.md`) does not
use it. This is a house nudge, never presented as an agreed backend
standard — nothing about backend testing has been agreed with the backend
team.

---

## Group 3 — agent behaviour (`group: "agent"`)

### `subagent-model` · deny / ask · `requiresModule: "agent-orchestration"`
The rule with the most ways to be evaded, and therefore the one that must cover
every route to the same action:

- a direct subagent spawn (`Agent`, `Task`, `spawn_agent`, and the Codex
  equivalents)
- **every `agent()` call inside a workflow script passed as a tool argument** —
  parse the script text, find each call, read its options object
- any future spawn mechanism: an unrecognised tool whose name matches
  `/agent|subagent|spawn|delegate/i` and whose input carries a `model` key is
  treated as a spawn, not ignored

Tier comparison, not an allowlist. `core/lib/model-tiers.js` maps a model name
to a tier:

| Tier | Claude | Codex |
|---|---|---|
| 3 — frontier | `opus`, `fable` | any `gpt-<version>-sol` id, including suffixed variants such as `-preview` — currently `gpt-5.6-sol` |
| 2 — balanced | `sonnet` | any `gpt-<version>-terra` id — currently `gpt-5.6-terra` |
| 1 — cheap | `haiku` | any `gpt-<version>-luna` id — currently `gpt-5.6-luna` |

**The version is never part of the match.** Both columns key on the tier name
alone — `opus`/`sonnet`/`haiku` on one side, `sol`/`terra`/`luna` on the other —
so a new model release changes nothing here. The "currently" ids are what those
tiers resolve to today, not what the matcher looks for. Do not re-pin a version
in this table or in `core/lib/model-tiers.js`.

An unrecognised name is tier `null` and is treated as **unknown, not frontier**
— it asks with a reason saying the name was not recognised, rather than denying
something that may be perfectly reasonable.

| Case | Action |
|---|---|
| spawn with no model set at all | deny |
| spawn tier ≤ session tier | pass |
| spawn tier > session tier | ask |
| spawn tier 3 (frontier), whatever the session runs on | ask |
| session tier unknown | compare against tier 2 |

The frontier row holds even when the session is itself frontier. A single
frontier session is a deliberate choice; a fan-out of frontier subagents is how
a routine task quietly becomes an expensive one.

The deny row is the one that closes the loop: an unset model silently inherits
the session's own, which is exactly the escalation the rule exists to prevent.

Prose safety is required and has a regression case: a workflow script whose
*prompt text* discusses model options must not be judged on that prose. Strip
string literals and comments before parsing the calls.

### `reasoning-effort-floor` · deny · `requiresModule: "agent-orchestration"`
An effort below `medium` on a spawn. Cheap work still has to be correct, and
the cost saved is not worth the second attempt. Recognised ladder:
`minimal < low < medium < high < xhigh < max < ultra`. An unrecognised value
passes.

### `delegate-bulk-reading` · advisory ask · `requiresModule: "agent-orchestration"`
A shell command shaped like a survey of the codebase rather than like
ordinary work: a search that sweeps a tree (`grep -r`, or `rg` with no file
argument), or a read command naming four or more distinct files. Advises
spawning a subagent for it.

`advisoryAsk: true`, so it surfaces as advice on both hosts and can never
block. That is the whole design, not a softening: the same command shape is
produced by reviewing a subagent's diff, which the rulebook requires, and no
hook can tell the two apart.

Deliberately narrow, because an advisory rule that fires on ordinary work is
worse than one that is switched off — it stays on and teaches an agent to
ignore the channel. Silent on: a search inside one named file; a locator
search (`-l`, `-L`, `-c`, `--files-with-matches`, `--count`), which returns
paths or a number rather than content; three files or fewer; a bare-word
argument that is not file-shaped; and `-r` on a command that is not a search,
such as `cp -r` or `rm -rf`; a survey whose output is piped into `head`,
`tail`, `wc`, or `sort` feeding one of those, which caps what reaches the
context exactly the way a locator flag does; and every call made from inside
a delegated agent (`ctx.agentId` set), since the advice is addressed to an
orchestrator choosing whether to delegate, a subagent has nothing further to
delegate to, and telling it to spawn one is the nesting
`no-nested-delegation` forbids.

### `no-nested-delegation` · deny · `requiresModule: "agent-orchestration"`
A subagent spawn made from inside a subagent. Delegation runs one level
deep: an orchestrator spawns an agent for a bounded piece of work, and that
agent does the work itself. A second layer pays coordination overhead twice
for no gain, and the orchestrator that approved the first spawn never sees
what the second one did.

Keys on `ctx.agentId`, which a Claude Code `PreToolUse` payload carries only
when the hook fires inside a subagent call — so a main-thread spawn, the
ordinary and intended shape, always passes. Codex sends no known equivalent
field, so the rule is silent there rather than wrong.

A spawn is recognised through `core/lib/spawn-tools.js`, shared with
`subagent-model` so the two cannot drift: a direct spawn tool, the workflow
tool, or an unrecognised spawn-like tool name whose input actually carries a
`model` key. That last condition is what keeps an unrelated tool with
"agent" in its name from being denied.

Denies rather than asks. Unlike `delegate-bulk-reading`, which infers intent
from a command's shape and can only ever advise, this is an unambiguous fact
about who is spawning.

### `infra-self-protection` · ask / deny · `mandatory: true`
Two distinct jobs, and they need different strengths. `mandatory: true` is set
on this rule alone, in the whole registry: it ignores both the project
config's `rules` switch (§8 of CONTRACTS.md) and the developer's own
`overrides.json` (§6). A softening file an agent can neither write nor
disable is the entire mechanism that makes every other rule's softening a
human act rather than a self-service one.

**ask** — a write to any file the manifest owns under `<agentHome>/softela-ai/`, or
to `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.codex/config.toml`.
The prompt is not a formality: the reason instructs the agent to state what it
intends to change and why, and the developer approves or refuses. A developer
editing the same file in their own editor is never intercepted, because they
were never inside the enforcement path.

**deny** — an agent granting itself an approval. Any tool call invoking
`softela-ai approve`, or writing to `<agentHome>/.softela-ai/approvals.json` or
`overrides.json`. This is the rule that makes "approval" mean a person: the
developer runs the command in their own terminal, which never passes through a
hook.

Also denies deleting the state directory, and denies `chmod`/`icacls`-style
permission changes against it.

The checks above are precise and statement-scoped — each shell statement is
parsed and matched on its own. A raw-text conservative backstop covers the
gap that scoping leaves open: a construct that puts the recognisable words in
the text without the adjacent, single-statement shape the precise checks
need — a parameter expansion default (`${x:-approve}`), a brace-expansion
alternative, or an alias defined in one statement and invoked in another.
Whenever every precise check finds nothing, this backstop reads the whole
raw command text as one blob, with no statement or quote boundaries, and
returns **ask** (never deny) when it finds either pairing anywhere in the
text: the tool's own name together with the word "approve", or the state
directory's dotted name together with a destructive or permission-changing
verb. It is deliberately coarser than the checks above and will sometimes
ask on an ordinary grep pattern or commit message that merely mentions both
words — accepted, since on this mandatory rule a false positive costs one
prompt and a false negative defeats the rule the config layer can never
soften.

### `shell-file-write` · deny / ask
Every file rule above this line — `doc-comment-style`, `no-explicit-any`,
`naming-standards`, `barrel-exports-only`, `component-folder-shape`,
`component-types-file`, `component-view-logic`, `api-import-boundary`, `file-size-limit`,
`colocated-tests`, `reuse-before-new`, `test-structure`, `patch-manifest`,
`protected-paths` —
fires only on a write tool (`Write`, `Edit`, `apply_patch`, …). A shell
command that lands the same bytes on disk through `sed -i`, an output
redirect, a heredoc, an inline `node -e`/`python -c` script, or a PowerShell
cmdlet, bypasses every one of them. This is the rule that closes that gap.

`core/lib/shell-write.js#shellWriteTargets` does the analysis: it splits the
command into statements (unwrapping a nested shell wrapper the same way every
other shell rule does) and finds every path a statement actually writes —
`>`/`>>` including a stderr-only redirect and a leading fd number, a heredoc
redirect, `tee`/`tee -a`, the PowerShell write cmdlets (`Out-File`,
`Set-Content`, `Add-Content`, `Tee-Object`), `sed -i`/`--in-place`,
`perl -i`/`-pi`/`-ni`, a `node -e`/`python -c` script calling a known write
function with a literal path, `cp`/`mv`/`copy`/`move`/`Copy-Item`/`Move-Item`'s
destination, `truncate -s`, `dd of=`, and `New-Item -Force -Path`. Pure text
analysis — it never executes anything.

- **deny** — a target whose path was extracted with certainty and whose
  extension is one this rule governs: the code standards' own source set
  (`.ts .tsx .mts .cts .js .jsx .mjs .cjs .cs .vb .razor .cshtml .vue .svelte
  .scss .css`), plus `.md` and `.json` — configuration and knowledge formats
  an agent routing around the write tools would target on purpose (`.md` is
  how this project's durable memory and `docs/standards/` are stored, `.json`
  is how a project or module configuration is written). Deliberately not
  governed: `.yml`/`.yaml` (ordinary CI/pipeline editing), `.xml`
  (`patch-manifest` already matches its own manifest by filename pattern, not
  extension), `.txt`/`.log` (nothing in the catalogue reads them). The reason
  names the path and the mechanism; the fix says to use the write tool
  instead (`Write`/`Edit` on Claude Code, `apply_patch` on Codex) so the
  standards actually run.
- **ask** — a target whose mechanism was detected but whose concrete path
  could not be extracted (a shell variable, a glob, a computed expression) and
  which is not already excluded below. An unextractable path must surface,
  never be guessed at in either direction — assuming it is source would be a
  false positive on an ordinary redirect to a variable target, and assuming it
  is not would silently reopen the gap this rule exists to close.
- **pass** — a target under `node_modules/`, `dist/`, `build/`, `out/`,
  `coverage/`, `.next/`, `bin/`, `obj/`, `.git/`, `__pycache__/`, under this
  process's own OS temp directory, or absolute and outside a KNOWN
  `ctx.git.repoRoot` — a `repoRoot` this rule cannot resolve (a working
  directory outside any git repository, the normal case in a multi-repository
  session) is treated as "unknown", never as "outside", so it excludes
  nothing on its own; a target on an extension the standards do not govern;
  `/dev/null`, `$null`, `NUL`/`nul`, or a pure file-descriptor duplication
  (`2>&1`, `>&2`), none of which `shellWriteTargets` even reports as a target.

  A shell write landing inside the memory directory `memory-as-context`
  resolves is a separate concern this rule does not cover: that directory
  routinely lives outside whatever repository `ctx.git.repoRoot` names (the
  agent's own home, or a per-project folder under it), so the repo-root
  exclusion above would otherwise hide it from every rule in `core/guards/`.
  `modules/memory-as-context/hooks/guard-memory.js` — the one place that
  already resolves the memory location and already reads `## INTENT`
  sections — is extended to the same shell tools instead, and denies a shell
  write landing there outright. See that module's own README for why.

The inline-interpreter mechanism (`node -e`/`python -c`) only sees as much as
text scanning of the extracted script can prove, and that limit is worth
stating plainly rather than leaving it to be discovered: a recognised write
call (`writeFileSync`, `appendFileSync`, `createWriteStream`, `open(…, 'w')`,
`Path(…).write_text(`) with a literal string-literal path argument denies;
the same call with a computed argument instead (`path.join(dir, x)`, a bare
variable) asks, exactly like an unextractable redirect or PowerShell cmdlet
target — the write is provably there, only the path is not; and a script that
carries no recognised write call at all — a read, or an unrelated script — is
silent, never asked about, so an ordinary `readFileSync`/`open(p).read()`
never trips this rule. `open(...)` in particular only counts as a write with
an explicit write-ish mode string (`'w'`, `'a'`, `'w+'`, `'wb'`, `'ab'`,
`'xb'`); `open(p)` and `open(p, 'r')` default to reading in Python and are
never flagged.

Multiple targets in one command report the most severe decision, ties broken
by command order — the same pattern `protected-paths` uses for a blanket
stage sweeping in several protected paths at once.

`group: "agent"`, deliberately, not `"code"`: this repository turns the
`code` group off for itself
(`projects/Softela.AiInfrastructure.json`, `rules.groups.code.action:
"off"`) because it is developer infrastructure with no application code for
those rules to examine. But an agent routing a source write around the write
tools entirely is an agent-behaviour problem, not a code-standard one, and
must still be caught even in a repository that has switched `code` off — that
is what keeps this rule in the `agent` group rather than `code`.

### `no-edit-generated-docs` · ask
A generated standard is edited through its source parts in `docs/standards/`,
never through the generated output itself. `tools/build-standard.js` stamps
an unmistakable marker into the head of every document it assembles: a line
containing "Generated file — do not edit directly." together with "Produced
by `tools/build-standard.js`". This rule reads a write's TARGET file — its
content already on disk, through `ctx.readFile`, never the new content about
to replace it — and asks when that content already carries the marker.

Detection is content-based on purpose: no filename is hard-coded in the
guard. `tools/build-standard.js`'s own `DOCUMENTS` list is free to grow, and
this rule keeps working against whatever it produces without a second place
to update.

- ask: a `Write`/`Edit`/`apply_patch`/… call whose target already has the
  generated-file marker on disk, whatever new content the call carries
- pass: a write to one of the source parts in `docs/standards/` (no
  marker on disk), a write to an ordinary markdown file, a file that does
  not exist yet, a file `ctx.readFile` cannot read, and any tool call that
  is not a file write
- evasion: the same target file reached through a different write tool
  (`Edit` instead of `Write`, or the Codex `apply_patch` equivalent) still
  asks — the marker check does not depend on which tool made the call

Fix: edit the corresponding part in `docs/standards/` and run
`node tools/build-standard.js` to regenerate the output file instead.

---

## Test requirements

Every rule ships `tests/guards/<rule-id>.test.js`, table-driven:

```js
{ label, ctx: {…partial…}, want: "deny" | "ask" | "pass", wantRule?: "<id>" }
```

with a helper that fills the rest of `ctx` from a default. Each file must
contain, at minimum:

- every positive case in this specification
- **more negative cases than positive ones**, drawn from ordinary daily commands
- at least two evasion cases: the same action reached by a different spelling,
  a different shell, a compound statement, or a different tool name
- one case asserting the override clamp softens the rule as expected
- one case asserting the rule stays silent when the project config that drives
  it is absent
- for a rule that declares `stacks` (CONTRACTS.md §3, §8a): one case asserting
  it stays silent on the other stack's file path, and one asserting it still
  fires on its own
