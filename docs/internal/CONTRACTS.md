# Internal contracts

The binding interfaces inside this repository. Everything under `core/`,
`adapters/`, `modules/`, `bin/` and `tests/` is written against this document;
where code and this document disagree, this document is the defect report.

Audience is whoever extends the repository, not the developer installing it.
Developer-facing documentation lives in `docs/standards/` and `README.md`.

---

## 1. Runtime rules

- **Node only.** No dependency on PowerShell, `bash`, `sh`, `cmd` or any other
  shell, at any point, including in tests and in the installer.
- **No runtime dependencies.** `package.json` declares no `dependencies`. The
  only thing that may be assumed present is Node 18+ and `git` on `PATH` (and
  even `git` must be optional — every call to it is wrapped and may fail).
- **CommonJS** (`require` / `module.exports`), no build step, no transpiler.
- **Paths** are always built with `path.join` / `path.resolve`. Never a literal
  `/` or `\` inside a path string. Comparisons normalise separators first.
- **Line endings**: files are written with `\n`. Content read from disk is
  normalised with `.replace(/\r\n/g, "\n")` before it is parsed or hashed.
- **Home directory** comes from `os.homedir()`, never from `$HOME` or
  `%USERPROFILE%` directly — except that `SOFTELA_AI_HOME` overrides it when set,
  which is what makes the installer testable against a fake home.

---

## 2. Decisions

`core/lib/decision.js`

```js
deny(reason, fix)   // → { action: "deny", reason, fix }
ask(reason, fix)    // → { action: "ask",  reason, fix }
pass()              // → null
```

- `reason` — one or two sentences stating the rule and why it exists. Written
  for the developer reading a prompt in a terminal, not for a log file.
- `fix` — optional. The corrected command or the concrete next step. A denial
  that carries a fix teaches; one that does not merely blocks.
- `pass()` returns `null`. A guard that has nothing to say returns `null`, never
  an object with `action: "allow"`.

Severity ordering, used everywhere a comparison is needed:

```
off = 0   <   ask = 1   <   deny = 2
```

---

## 3. Rule module contract

One rule per file in `core/guards/`. A rule is a **pure function** — it never
reads stdin, never writes stdout, never calls `process.exit`, never mutates
`ctx`. That is what makes it testable in isolation and identical under both
agents.

```js
module.exports = {
  /** kebab-case, unique, equals the filename without .js */
  id: "no-push-to-base",

  /** one line, shown by `softela-ai doctor` */
  title: "Never push to a base branch",

  /** which host events this rule can fire on */
  events: ["PreToolUse"],

  /** which tool names it applies to; null means every tool */
  tools: /^(Bash|PowerShell|shell|local_shell)$/,

  /** the strongest action this rule may ever return */
  defaultAction: "deny",

  /** which catalogue group this rule belongs to — see RULES.md */
  group: "git", // "git" | "code" | "agent"

  /**
   * which stack(s) this rule applies to; omitted means every stack. See
   * "stacks — scoping a rule to frontend or backend" below.
   */
  stacks: undefined, // ["frontend"] | ["backend"] | omitted

  /**
   * dotted paths into the resolved project config this rule needs to be
   * meaningful; the engine skips the rule entirely when any listed path is
   * absent. `[]` (or omitted) means unconditional — the rule never invents a
   * substitute value for a missing config key.
   */
  requiresConfig: [],

  /**
   * true only for `infra-self-protection`. A mandatory rule ignores both the
   * project-config switch (§5) and the developer's overrides file (§6) — it
   * is the rule that makes every other softening a human act.
   */
  mandatory: false,

  /**
   * true for a rule that states a structural expectation existing code can
   * only satisfy by being refactored (folder shape, naming, file size, a
   * layering boundary, ...). On a file `lib/change-scope.js#classifyChange`
   * classifies as `"existing"`, the engine (§5, step 6) clamps such a rule's
   * action to at most `"ask"` and reframes its reason as advice — mandatory
   * for new code, a refactoring suggestion for code that predates the
   * standard. Omitted (the default) means the rule is judged the same way
   * regardless of whether the file is new.
   */
  newCodeOnly: false,

  /**
   * true for a rule whose `ask` is a NUDGE rather than a request for the
   * developer's decision — a size backstop, a reuse reminder. The engine
   * (§5, step 9) marks such a decision `advisory: true`, and a host with no
   * interactive `ask` surfaces it instead of blocking. Omitted (the
   * default) means an `ask` from this rule genuinely wants the developer to
   * look before the call proceeds, and still blocks on Codex.
   */
  advisoryAsk: false,

  /** optional: only active when this module is enabled */
  requiresModule: null,

  /**
   * @param {Ctx} ctx
   * @returns {null | {action: "deny"|"ask", reason: string, fix?: string}}
   */
  evaluate(ctx) { /* … */ }
};
```

`core/guards/index.js` exports `{ rules: Rule[], byId: Record<string, Rule> }`
and asserts at load time that every `id` is unique and matches its filename.

### requiresConfig — no invented substitutes

A rule that reads a fact from the project config (a threshold, a glob, a
pattern) must never fall back to a literal value it made up when that fact is
absent — a config-driven rule with nothing configured is silent, not tuned to
a guess. `requiresConfig` makes that declarative: the engine (§5) checks every
listed path before the rule ever runs, so the rule body itself does not need
an `if (!configured) return pass()` guard for the paths it lists — though nothing
stops it from having one, and a rule with only *part* of its behaviour gated
by config (`commit-message`'s conventional-prefix check, for instance) still
checks that part internally, because `requiresConfig` would otherwise silence
checks that are meant to stay universal.

A path is "absent" when it resolves to `null` or `undefined` — an explicit
`false` or `0` in the config counts as present, since a developer may
deliberately configure a falsy threshold.

### stacks — scoping a rule to frontend or backend

Some rules encode an assumption about which kind of codebase they are looking
at: `component-folder-shape` only means anything next to JSX components,
`patch-manifest` only means anything next to a deployable backend patch. A
rule that carries that assumption declares it in `stacks`:

- `["frontend"]` or `["backend"]` — the rule is a candidate only when the
  context's file path resolves to that stack (§8a). Every other stack, and
  the no-file case, mean the rule is simply never selected — it behaves
  exactly as if it were absent from the registry for that call.
- Omitted (the default) — the rule is stack-agnostic and `stacks` never
  affects whether it runs. Every git rule and every agent rule is
  stack-agnostic, and so are the code rules whose concern is not tied to one
  kind of codebase: `reuse-before-new`, `doc-comment-style`,
  `naming-standards` (which branches on `conventions.language` instead).

This is a *narrower* gate than `requiresConfig`: a rule can decline to run
because the fact it needs is unconfigured (`requiresConfig`), because the
context's stack does not match what it was written for (`stacks`), or both —
`file-size-limit` is the example that uses both, since its thresholds are
frontend-agreed *and* need `limits.fileLines` set before they mean anything.
`stacks` is validated by `core/guards/index.js` the same way `group` and
`requiresConfig` already are.

### What a rule may not do

- No I/O beyond what `ctx` already provides, with one exception: reading a file
  the tool call is about (its current content on disk) through `ctx.readFile()`,
  which is sandboxed and returns `null` on any failure.
- No `process.env` reads other than through `ctx`.
- No regex built from unvalidated override input without
  `lib/safe-regexp.js#compile`, which returns `null` on an invalid pattern
  instead of throwing.

---

## 4. The evaluation context (`ctx`)

Built by `core/lib/context.js` from a host payload, then frozen.

| Field | Type | Notes |
|---|---|---|
| `event` | string | `PreToolUse`, `PostToolUse`, `SessionStart`, … |
| `agent` | `"claude"` \| `"codex"` | which host produced the payload |
| `toolName` | string | normalised; `""` when unknown |
| `input` | object | the raw tool input, host-shaped |
| `command` | string | the shell command line, `""` when not a shell call |
| `filePath` | string | absolute where the host gave one, `""` otherwise |
| `content` | string | full new content (Write) or the replacement (Edit) |
| `cwd` | string | absolute |
| `project` | object | resolved `projects/*.json`, never `null` — falls back to `_default.json` |
| `git` | object | `{ repoRoot, branch, base, remote, rebaseInProgress, staged() }` |
| `session` | object | `{ model, effort }` — the host session's own settings, `null` fields when unknown |
| `sessionId` | string \| null | the host's own session id (`session_id`/`sessionId`); `null` when the payload carries neither — see §7's "Verified Claude payload shape" and "Verified Codex payload shape" |
| `agentId` | string \| null | set only when the call comes from inside a delegated agent; `null` on a main-thread call |
| `agentType` | string \| null | the delegated agent's own type, alongside `agentId` |
| `modules` | Set\<string> | enabled module ids |
| `overrides` | object | already resolved **for this rule** — see §6 |
| `raw` | object | the untouched payload; last resort only |
| `readFile(p)` | fn | `string \| null` |
| `statFile(p)` | fn | `number \| null` — the file's size in bytes, under the same boundary checks as `readFile` and without reading it |
| `resultingContent` | string \| null | the file as it would stand after the write, when the decoder could reconstruct it |

`ctx.git` is lazy: nothing shells out to `git` until a rule touches the field,
and every failure yields a null-ish value rather than an exception.

---

## 5. The engine

`core/engine.js`

```js
evaluate(ctx, options) → null | { action, reason, fix, ruleId }
```

1. Resolve the **effective context**: the stack a candidate is judged against
   (§8a) is resolved from `ctx.filePath` against `ctx.project`, and, when one
   resolves, that stack's preset (§8a) is merged underneath `ctx.project`
   (`project`'s own keys win — see §8a's merge rule). Every following step
   reads this effective context, not the raw one `buildContext` produced —
   this is what lets a monorepo path see the right stack's conventions
   without the project file restating them.
2. Select rules where `events` includes `ctx.event`, `tools` matches
   `ctx.toolName` (or `tools` is `null`), `requiresModule` is either null or
   present in `ctx.modules`, the rule's `stacks` (§3, "stacks") admits the
   resolved stack, every one of the rule's `requiresConfig` paths is present
   in the effective project (§3, "requiresConfig"), and — unless the rule is
   `mandatory` — the project config's rule switch (§8) does not resolve to
   `"off"` for this rule. All of this lives in `applies()`, a pure predicate
   that never runs `evaluate`.
3. Run each selected rule in a `try`/`catch`. **A thrown rule is skipped,
   never fatal** — the throw is recorded on `options.diagnostics` when one is
   supplied. A `null` result (the rule passed) is dropped immediately.
4. Clamp a non-`null` result to at most the rule's own `defaultAction`:
   `action = clamp(result.action, rule.defaultAction)`. This is the one step
   every rule goes through regardless of `mandatory` — it polices a rule
   against its *own* stated ceiling (§3), which is a different thing from the
   project switch or the override clamp policing what happens *to* the
   result afterward.
5. Unless the rule is `mandatory`, apply the project config's rule switch to
   the (already-clamped) result: when `byId[<ruleId>]` or, failing that,
   `groups[<group>]` names an action, that action **replaces** the result's
   action outright — the committed config can move it either stronger or
   weaker than the rule's own `defaultAction`, because it is reviewed by the
   team (§8). `byId` beats `groups`.
6. Unless the rule is `mandatory`, when the rule declares `newCodeOnly` (§3)
   and the target file's path classifies as `"existing"`
   (`lib/change-scope.js#classifyChange`), clamp the (already-resolved)
   action to at most `"ask"` and prefix the reason with an advisory note
   stating plainly that this is advice, and why — the rule's own reason
   survives unedited after the prefix. `"unknown"` is treated exactly like
   `"new"`: never having proved a file pre-exists never softens it. This
   step can only soften, same direction as the developer override below,
   never sharpen. Computed at most once per `evaluate` call, and only when
   at least one candidate rule actually declares `newCodeOnly` and
   `ctx.filePath` is non-empty — a shell-only call, or a call whose
   candidates are all unflagged, never pays for the git shell-out this
   needs. The result is also exposed on the effective context as
   `ctx.changeScope`, for a rule that ever wants to read it directly, though
   none does today.
7. Unless the rule is `mandatory`, apply the developer override clamp (§6) to
   what remains: the `allow` short-circuit, then
   `min(severity(action), severity(overrideAction))` — the developer may only
   soften, never escalate.
8. **Most severe wins** among whatever survives; ties are broken by registry
   order, which is the order in `index.js`. The single returned decision
   carries `ruleId` so the developer can see which rule spoke, and so an
   override can be written without guessing.
9. Mark the surviving decision `advisory: true` when it is an `ask` that is
   advice rather than a question: the rule declares `advisoryAsk` (§3), the
   rule's own `evaluate` result carries `advisory: true`, or step 6 has just
   reframed its reason as advice. Only ever set on an `ask`
   — a `deny` blocks on every host, and an override that deliberately
   escalated a nudge into a denial must not have that undone. A host with a
   native `ask` ignores the field entirely; Codex, which has none, uses it
   to decide between surfacing and blocking (§7).

**Evaluation order, stated once for the whole chain**: the rule produces an
action → the engine clamps it to the rule's own `defaultAction` → the project
config sets or clears it, in either direction → a `newCodeOnly` rule on a file
proved to already exist is capped at `"ask"` → the developer override may only
soften it further → whatever survives is marked advisory when it is a nudge. A `mandatory` rule still passes through the `defaultAction`
clamp (step 4) — that is the rule's own honesty, not a policy tier — but stops
there: its own (clamped) result stands, immune to the project switch, the
`newCodeOnly` softening, and the override alike.

**A known limitation, accepted deliberately**: because the `newCodeOnly`
softening (step 6) runs *after* the project-config switch (step 5), a project
cannot configure its way into hard-enforcing a structural rule against
pre-existing code — `byId` escalating a `newCodeOnly` rule to `"deny"` still
ends at `"ask"` once the target file classifies as `"existing"`
(`tests/guards/legacy-advisory.test.js` asserts this exact case). This is
intentional, not an oversight: whether legacy code gets advice or a
requirement is a team-wide policy decision about the standard itself, not a
per-repository one, so no project file is given a lever to override it.

Determinism is a hard requirement: the same `ctx` always produces the same
decision. No wall clock, no randomness, no ordering that depends on the
filesystem.

### Reading a dotted config path

`core/engine.js` exports no public helper for this — it is internal, used by
both the `requiresConfig` gate and the rule-switch lookup — but its contract
is worth stating because a rule module never needs to reimplement it: walking
`a.b.c` against the resolved project config returns `undefined` the moment any
segment is missing, and treats `null`/`undefined` as absent while an explicit
`false` or `0` counts as present.

---

## 6. Overrides

This is the **third and last** of three tiers, and it is the only one of the
three a single developer controls unilaterally:

1. **The rule itself** (§3) — what it needs (`requiresConfig`) and the
   strongest it may ever return (`defaultAction`).
2. **The committed project config** (§8, `projects/<Repo>.json`) — reviewed
   by the whole team, may switch a rule or a whole group off, and may equally
   escalate a rule beyond its own default.
3. **This file** — one developer's own machine, never reviewed by anyone
   else. It may only soften what tiers 1 and 2 produced, never escalate, which
   is the entire reason it is safe to let a developer edit it without review.

Resolved by `core/lib/override-resolver.js` from
`<agentHome>/.softela-ai/overrides.json`, a file the installer neither creates
nor writes nor reads on update.

```json
{
  "rules": {
    "forbidden-commands": { "allow": ["\\bkubectl\\b"], "reason": "DevOps tooling" },
    "no-explicit-any":    { "action": "ask" },
    "colocated-tests":    { "action": "off" }
  },
  "projects": {
    "Softela.Bugworx": { "rules": { "file-size-limit": { "action": "off" } } }
  }
}
```

Resolution order — later wins, but only in the softening direction:

1. the rule's own `defaultAction`
2. `rules[<id>]`
3. `projects[<projectId>].rules[<id>]`

Three invariants, each with a test:

- **Clamp, never sharpen.** The effective action is
  `min(severity(ruleResult.action), severity(overrideAction))`. An override
  saying `deny` on a rule that returned `ask` still yields `ask`.
- **`allow` drops the decision entirely.** If any `allow` pattern matches
  `ctx.command` — or `ctx.filePath` for a file rule — the rule produces `null`.
  Invalid patterns are ignored and reported by `doctor`, never thrown.
- **Local only.** Nothing in this repository reads, writes, distributes or
  aggregates an overrides file. `doctor` prints the active set locally.

---

## 7. Adapters

An adapter contains **no rule logic**. Three responsibilities: normalise, run,
serialise.

```js
// adapters/<host>/dispatch.js
const payload = readStdinJson();          // {} on any parse failure
const ctx     = buildContext(payload, { agent: "<host>" });
const result  = engine.evaluate(ctx);
writeDecision(result);                    // silence when null
```

### Wire formats

Both hosts use the same envelope, which is why one core can serve both:

```json
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "…reason…\n\nFix: …" } }
```

| | Claude Code | Codex |
|---|---|---|
| Registration | hook entries in `~/.claude/settings.json` | `~/.codex/hooks.json` |
| Deny | `permissionDecision: "deny"` | same; `permissionDecisionReason` **must be non-empty** |
| Ask | `permissionDecision: "ask"` | **not supported on `PreToolUse`** — see below |
| Pass | exit 0, no stdout | exit 0, no stdout (`"allow"` is rejected) |
| Hard block | exit 2 + stderr | exit 2 + stderr |

`SOFTELA_AI_EXIT2=1` makes a denial additionally exit 2 with the reason on stderr,
for hosts or versions where the JSON path is not honoured. The probe suite is
what decides whether that is ever needed.

#### Verified Codex hook spawn contract

The exact shape a hook `command` string must take to actually run — which
quoting of the executable token works, which fails near-silently, and why
`plan.js#baseVars` resolves the Node executable through
`core/lib/short-path.js` on Windows — is measured and recorded in full in
`INSTALLER.md`'s "Verified Codex hook spawn contract", since that document is
where the installer's own construction of this string already lives. The
short version: the executable (the command's first token) must be a single
whitespace-free token and quoting it does not help, while everything after it
is tokenised correctly and arrives unquoted, so a quoted argument is fine. A
failure is near-silent — `hook: <Event> Failed`, with the run otherwise
continuing.

#### Verified Codex registration file

Every claim here was confirmed by running the real binary, not read from
documentation. **The method is worth keeping**: point `CODEX_HOME` at a scratch
directory and run `codex exec --skip-git-repo-check "x"`. The hooks-config parse
warning is emitted before authentication, so an unauthenticated scratch home is
a free, fast oracle and the 401 that follows is irrelevant. `codex doctor` says
nothing about hooks and `codex debug prompt-input` does not validate them.

**The file is not shaped like Claude Code's, and assuming it was would produce a
configuration that parses cleanly and never fires.**

```json
{
  "description": "optional",
  "hooks": {
    "SessionStart": [
      { "matcher": null,
        "hooks": [ { "type": "command", "command": "node \"…/dispatch.js\"" } ] }
    ]
  }
}
```

- The top level holds `description` and `hooks`; the events live **inside**
  `hooks`. The parser states this itself: `unknown field "SessionStart",
  expected "description" or "hooks"`.
- **Event keys are PascalCase.** Proven by firing: a hook under `SessionStart`
  ran, an identical one under `sessionStart` did not.
- Handler fields: `command`, `windows`, `timeout`, `async`, `statusMessage`,
  `additionalContextLimit`.

Two properties that change what the installer and `doctor` must do:

- **Unknown keys inside `hooks` are silently accepted.** A misspelled event
  name, and even a matcher group containing nothing but an unknown field, parse
  without a warning. So a typo does not fail — it produces a hook that never
  runs. `doctor` must never treat "the file parsed" as "the hook is active".
- **A newly installed hook does not run until a human trusts it.** Codex keeps
  per-hook trust in `~/.codex/config.toml`, under a `[hooks.state]` table —
  plain, readable TOML, not an opaque state database — one entry per
  `<hooks.json path>:<event in snake_case>:<matcher-group index>:<hook
  index>`, each carrying `trusted_hash = "sha256:..."`. An untrusted hook is
  inert. Confirmed: the same configuration fired nothing until
  `--dangerously-bypass-hook-trust` was passed, and then logged `hook:
  SessionStart` / `hook: SessionStart Completed`.

  The installer therefore **must** tell the developer that Codex hooks are
  installed but not yet active, and name the one-time review that activates
  them. The real limitation is narrower than "unreadable": the presence of a
  `[hooks.state]` entry only proves a hook at *some* hash was once trusted —
  asserting that the *currently installed* hook is the trusted one would mean
  reproducing Codex's own hashing function over the hook entry, which has not
  been done. `doctor` reports the requirement and states this narrower
  limitation rather than pretending the file cannot be read at all — it does
  not guess, and it does not pretend the Codex half is live when it may not
  be. Pre-seeding trust is out of the question: that check exists for exactly
  the reason ours does.

  This is also a feature, not only an obstacle. It is the integrity guarantee
  Claude Code lacks, which is why `doctor` compares installed files against the
  manifest on that side.

#### Verified Codex matcher semantics

`matcher` is not a no-op. It is a real regex string, compiled by the Rust
`regex` crate at hook-discovery time and validated: an invalid pattern makes
the binary print `warning: invalid matcher "<value>" in <path>: regex parse
error: ...`. Omitting it, or using `""` or `"*"`, matches every occurrence.

When valid, it is matched against a per-event field:

| Event(s) | Field matched |
|---|---|
| PreToolUse, PostToolUse, PermissionRequest | `tool_name` |
| PreCompact, PostCompact | `trigger` (`manual`\|`auto`) |
| SessionStart | `source` (`startup`\|`resume`\|`clear`\|`compact`) |
| SubagentStart, SubagentStop | `agent_type` |
| UserPromptSubmit, Stop | unsupported — no effect |

**Fire-tested**, for the SessionStart/`source` case only: on an otherwise
identical scratch configuration, `matcher: "startup"` fired on a plain
`codex exec`, and `matcher: "resume"` did not.

**Not fire-tested**: the PreToolUse/`tool_name` case. Codex's own generated
JSON Schema declares `tool_name` as an unconstrained `{"type": "string"}`
with no enum, so the exact literal values it would match remain unverified —
only `apply_patch` is well corroborated as the unified write/edit/patch tool
name.

This is why `plan.js`'s core dispatcher registration deliberately still
writes `matcher: null` for PreToolUse: not because the mechanism is absent —
it works, and is proven to work for at least one event — but because this
repository does not rely on an unverified `tool_name` literal, and lets the
shared rule engine filter by tool name instead.

#### Verified Claude payload shape

Measured, not assumed: every record in a real Claude Code guard-activity log
(§7b) carried a non-null `session_id` — 79 records out of 79, across two
separate sessions, on this machine. `logGuardActivity` writes one record per
dispatch pass, and dispatch runs off a `PreToolUse` hook, so this establishes
exactly one thing: **Claude Code's own `PreToolUse` payload carries
`session_id`.** It establishes nothing about any other event's payload
shape — `SessionStart`, `UserPromptSubmit`, `PostToolUse` and the rest were
not part of this measurement. `core/lib/context.js#buildContext` still
treats the field as host-supplied rather than guaranteed, exactly the way it
already treats Codex's own `session_id` below: a payload shape nobody has
measured yet may simply omit it, and every consumer reads a missing value as
`null` — "unknown" — rather than assuming the field is always present.

#### Verified Codex payload shape

The `PreToolUse` payload carries:

```
session_id, turn_id, agent_id, agent_type, transcript_path, cwd,
hook_event_name, model, permission_mode, trigger, tool_name, tool_input,
tool_use_id
```

Two consequences worth stating explicitly:

- `model` is present in the payload, so the subagent-tier rule has a real
  session model to compare against on the Codex side rather than a guess.
- `agent_id` / `agent_type` are present **on a subagent's own events only**.
  Measured on 0.149.1: a subagent's tool calls carry `agent_id` and
  `agent_type: "default"`; the main session's carry neither, and no
  `UserPromptSubmit` has been observed carrying them at all. Absence is
  therefore the marker for "this is the main session", not a gap.

The same binary rejects these outputs by name:
`PreToolUse hook returned unsupported permissionDecision:ask`,
`…permissionDecision:allow`, and
`…permissionDecision:deny without a non-empty permissionDecisionReason`.

##### `apply_patch`'s own payload shape

**Fire-tested** on 0.149.1 (Windows), by capturing a live `PreToolUse` payload
off the real binary. The patch envelope arrives under **`command`**:

```json
{"tool_name":"apply_patch",
 "tool_input":{"command":"*** Begin Patch\n*** Update File: foo.txt\n@@\n-hello\n+world\n*** End Patch"}}
```

Two consequences, both of which were live defects until this was measured:

- `core/lib/write-decode.js` read `input`, `patch`, `changes` and the direct
  `{file_path, content}` pair, but not `command` — so EVERY patch Codex wrote
  decoded to no files at all and came back as the unrecognised-write-shape
  decision, which on this host is a denial. The agent could not change a
  single file.
- `command` is also the field `core/lib/context.js#pickCommand` reads for a
  SHELL call, so `ctx.command` for an `apply_patch` became the patch's own
  text and every command-matching rule judged file content as if it were a
  command line. `pickCommand` now takes the tool name and returns `""` for a
  write tool.

##### Only `deny` is accepted, and every other value is fail-open

**Fire-tested**: a hook cycling `ask`, `escalate`, `confirm`, `prompt`,
`approve`, `review`, `elicit` and `allow` across eight successive tool calls
had all eight rejected — the TUI reports `hook: PreToolUse Failed` — while the
hook process itself ran normally each time. The rejection is **fail-open**: the
hook run is marked failed and **the tool call proceeds unreviewed**. Emitting
`ask` and hoping for a graceful degradation is therefore strictly worse than
mapping it onto a denial, which is what `adapters/codex/dispatch.js` does.

Codex's own JSON schema does list `["allow","deny","ask"]` for this field. That
is forward-looking surface, not current behaviour;
`tests/probes/codex-host.test.js` is what would notice it becoming real.

#### `UserPromptSubmit` — the in-session approval channel

**Fire-tested** on 0.149.1: the event fires, and its payload carries what the
developer typed verbatim under `prompt`:

```json
{"hook_event_name":"UserPromptSubmit","session_id":"…","cwd":"…",
 "model":"gpt-5.6-luna","prompt":"softela approve protected-paths"}
```

This is what makes `ask` usable on a host with no native `ask`, without
sending the developer to a second terminal — see
`adapters/shared/approve-from-prompt.js`. The security property it rests on is
structural rather than a matter of wording: **the host raises this event from
the developer's own keystrokes, and no tool call can author one.** Fire-tested
from the other direction too — spawning a subagent under `multi_agent_v2` and
running it to completion produced exactly one `UserPromptSubmit`, the
developer's own message, and none for the spawn or for anything the subagent
did.

#### Delegation is off by default, and untierable until a second flag is set

Both established by running the binary, and both are what
`modules/agent-orchestration` seeds:

- **`features.multi_agent_v2`** ships `stable` but **`false`**. With it off, a
  session asked to list its own tools reports `exec`, `apply_patch`,
  `exec_command`, `update_plan` and friends — **no spawn tool of any kind**.
  With it on, `collaboration.spawn_agent`, `wait_agent`, `send_message`,
  `followup_task`, `interrupt_agent` and `list_agents` appear.
- **`multi_agent_v2.expose_spawn_agent_model_overrides`**. With it off, the
  spawn payload carries `task_name`, `fork_turns`, `message` — and no model —
  and the subagent runs on the session's model (both threads' rollout records
  read the same frontier id). With it on, the payload carries `model` and the
  subagent's own rollout records the requested tier.
- The spawn's `tool_name` reaches a hook as **`collaborationspawn_agent`** —
  namespace punctuation stripped. Both `subagent-model` and
  `reasoning-effort-floor` match the dotted and undotted spellings.
- `default_subagent_model` is a real top-level `ConfigToml` field (there is no
  `[agents]` section at all) but had **no measurable effect** under
  `multi_agent_v2`, so nothing seeds it. `default_subagent_reasoning_effort`
  defaults to `medium` even when the session runs at `low`; it is seeded to
  state that floor explicitly rather than depend on it.
- `features.per_spawn_model_override` **does not exist** — `codex features
  list` enumerates every flag the binary knows and does not contain it. It was
  seeded for a while and wrote a key nothing read.

#### There is no native `ask` on Codex

This is the one place the two hosts genuinely differ, and it is resolved in the
adapter, never in a rule. A rule returns `ask`; what that becomes is the
adapter's problem.

- **Claude Code** — `permissionDecision: "ask"`. The developer sees the reason
  and decides.
- **Codex, `askMode: "block"` (default)** — emitted as a denial whose reason
  states the rule, states that it needs the developer's approval, and names the
  exact approval command. Chosen as the default because an advisory note is
  bypassable, and the requirement is that a rule cannot be bypassed except with
  the developer's explicit approval.
- **Codex, `askMode: "advise"`** — emitted as `additionalContext` with no
  decision, so the call proceeds and the agent is told to raise it. Available
  for teams that would rather not be hard-blocked; selected at install time and
  reported by `doctor`.

**A nudge is advised on both hosts.** A decision carrying `advisory: true`
(§5, step 9) is emitted as `additionalContext` on Codex even under the
default `askMode: "block"`, and as `additionalContext` on Claude Code rather
than as `permissionDecision: "ask"`. The reasoning is that the argument for
blocking above — "an advisory note is bypassable, and a rule must not be
bypassable without the developer's approval" — applies to a rule that wants
the developer's *decision*. It does not apply to a rule that is telling the
agent something: a size backstop, a reuse reminder, a structural expectation
the engine has already softened to advice because the file predates it.

Treating those two the same is expensive on both hosts, in different
currencies. Codex rendered both as a denial clearable only by typing an
approval, so an ordinary session accumulated several typed approvals for
advice nobody needed to rule on — measured on a real session, where the
developer approved twice inside one task and the second approval had already
expired by the time the retry came.

Claude Code looked cheaper — one keystroke — and that was the mistake. A
keystroke is cheap once; it is not cheap once per tool call across a fan-out
of subagents, and a subagent cannot answer a permission prompt at all, so
every one of them surfaces to the developer instead. Measured on a real
session: a single advisory rule produced fifteen prompts inside one task,
none of which the agent that triggered them could have cleared. The severity
was never the problem; the *cost of the same severity, multiplied by how
often it fires* was.

What still blocks on Codex is unchanged: every `deny`, and every `ask` a rule
means as a question — a protected path, a destructive git command, a
generated document, a subagent tier the developer has to sanction.

---

## 7a. Session approvals

`ask` is useless without a way to say yes. On Claude Code the host provides it;
on Codex it has to be built, and building it once for both keeps the two
identical.

`core/lib/approvals.js`, state in `<agentHome>/.softela-ai/approvals.json`:

```json
{ "branch-naming": { "until": "2026-08-14T15:41:00Z", "scope": "session-or-time" } }
```

- `softela-ai approve <ruleId> [--minutes 60]` grants it. The engine consults
  approvals **before** running a rule and skips it while an approval is live.
- Approvals are time-boxed, default 60 minutes. They never persist indefinitely;
  a permanent change belongs in `overrides.json`, where it is visible.
- `softela-ai approve --list` and `softela-ai doctor` both show what is live.
- **The agent may not grant its own approval.** `softela-ai approve` issued from
  inside a tool call is denied by `infra-self-protection`; the developer runs it
  in their own terminal, which never passes through a hook. This is the whole
  mechanism by which "approval" means a person, and it is what the rule's own
  test suite asserts.

### Fail open, always

An unparseable payload, an unreadable project file, a missing home directory or
a thrown exception all result in **pass**. A guard that crashes must never be
able to brick a session. Every failure path has a test. When `SOFTELA_AI_DEBUG=1` is
set, the failure is written to stderr — which the host shows and ignores —
instead of being swallowed silently.

### Parity

`tests/adapters/` asserts that the same rule and the same logical input produce
the same decision through both adapters. This suite is what stops the two hosts
drifting apart.

---

## 7b. Guard-activity log

`adapters/shared/dispatch-core.js` records every dispatch pass to
`<agentHome>/.softela-ai/logs/guard-activity-<YYYY-MM-DD>.jsonl` (path from
`core/lib/paths.js#guardLogPath`), one file per agent per calendar day, named
by local time.

- **Exactly one line per dispatch, including a plain pass.** A log that only
  recorded a denial or a question could never answer whether a rule was even
  consulted — so a call with no rule to say anything at all still writes a
  line, `action: "pass"` and `ruleId: null`, alongside the tool, the file path
  or command (truncated past 20000 characters), the session id when known, and
  the agent/subagent identity fields `ctx` already carries.
- **Append-only, and never on stdout.** Every write goes through
  `core/lib/fs-safe.js#appendLineSafe`, a single `fs.appendFileSync` call
  opened with `O_APPEND` — deliberately not the atomic
  temp-file-then-rename `writeTextAtomic`/`writeJsonAtomic` use elsewhere in
  this file, because several dispatch processes (a subagent spawns its own
  per tool call) can be appending to the same day's file at the same moment,
  and a read-modify-rewrite would let two concurrent writers race and lose a
  line. This is purely a side channel: nothing about logging may reach
  stdout, and nothing about it may change the decision already computed.
- **Fails open, under the same rule as §7a.** Logging is wrapped in its own
  `try`/`catch`, entirely separate from dispatch's own error handling — an
  unwritable log directory, a full disk, or any other failure here must never
  turn a dispatch into anything other than the decision already computed.
  A logging failure surfaces only on stderr, and only under
  `SOFTELA_AI_DEBUG=1`, through the same `debugLog` every other fail-open path in
  this module uses. Covers both of `runDispatch`'s own return points — the
  normal path and its outer fail-open `catch` — so a crash partway through
  dispatch is still recorded, not only a clean pass or a rule's decision.
- **Retention: 14 days.** After each write, `guard-activity-*.jsonl` files
  under the same agent's log directory whose modified time is older than 14
  days are deleted, best-effort, one file's stat/unlink failure never
  stopping the rest from being pruned. There is no configuration for this
  window; it is a constant in `dispatch-core.js`.

---

## 7c. Per-task file tally

`core/lib/task-tally.js#readTaskTally` turns the guard-activity log (§7b)
into a count of how many distinct files the CURRENT task has read and
written, so a rule can tell "the session did this work itself" apart from
"the session delegated it". This is a contract layered on top of §7b's own
log-record shape, not a second log.

- **What a record must carry for this to work.** Exactly the fields §7b
  already requires of every dispatch record: `sessionId`, `agentId`,
  `filePath`, `tool`. A record with no `filePath` is ignored. A record whose
  `agentId` is present — a subagent's own dispatch, not the main session's —
  is excluded from every tally outright: delegated work must never count
  against the session that delegated it.
- **The task boundary is the last `UserPromptSubmit` marker for this
  session.** `modules/agent-orchestration/hooks/inject-delegation-mode.js`
  appends one such marker — `event: "UserPromptSubmit"`, carrying only `ts`,
  `agent`, `event` and `sessionId` — to the same day's log on every
  main-session prompt. Only records after the last matching marker are
  counted. A marker whose own `sessionId` is missing or `null` resets every
  session for this agent, this one included, rather than letting a stale
  count accumulate past a prompt boundary it cannot rule out.
- **The read is bounded, not exhaustive.** At most the last
  `TASK_TALLY_READ_BOUND_BYTES` (256 KiB) of the log is read. A task whose
  own activity since its last boundary exceeds that window has its earliest
  records silently fall outside it and never get counted. **This is the
  deliberate safe direction to fail in**: an unusually long task is
  under-counted, never over-counted, so a rule reading this tally can only
  ever be too permissive because of it, never wrongly block a developer's
  own work.
- **The whole mechanism is fail-open, as bindingly as every other guarantee
  in this document.** `readTaskTally` never throws, and reports `null` —
  meaning "unknown, do not act on this" and never a guessed zero — whenever
  the answer cannot be trusted: a missing or empty `sessionId`, a log file
  that does not exist or cannot be read, or a read that produced no usable
  record at all.
- **A denial requires a trustworthy session key.** A rule reading this
  tally MUST NOT deny when `sessionId` is `null` or the tally itself is
  `null` — it may advise at most. Without a trustworthy session key the
  counter cannot separate two concurrent sessions working in one repository,
  and an over-count at the deny tier would block a developer for no reason.
  `core/guards/delegate-bulk-reading.js` is the concrete instance of this
  contract today (see `RULES.md`): it reaches `deny` only once both a
  non-null `ctx.sessionId` and a resolved tally are in hand, and falls back
  to advice, or to silence, in every other case.
- **Softela departure from upstream.** On Codex, the tier that would
  otherwise `deny` returns `ask` instead: Codex sends no `agent_id` on any
  call, so a subagent's own dispatches cannot be excluded from the tally the
  way `readTaskTally` excludes them on Claude, and denying on an uncertain
  count would block exactly the delegated work this rule asks for. See
  `core/guards/delegate-bulk-reading.js#tallyBasedDecision`.

---

## 8. Project configuration

`projects/<RepositoryName>.json`, one file per repository, named exactly after
the repository. Resolution by `core/lib/project-resolver.js`:

1. git remote URL of `ctx.cwd` matched against `match.remotes` globs
2. failing that, `match.paths` globs against the repo root's basename
3. failing that, `_default.json`

**`_default.json` is a floor, not a fallback.** Whichever of the three steps
above answers, the engine layers `_default.json` underneath the result
(`core/lib/config-merge.js`, applied by `core/engine.js#withEffectivePreset`
before the stack is resolved). Naming a repository therefore adds
configuration to it and never removes any — the alternative, which this
replaced, is a repository that reads as configured and has silently stopped
protecting `.env` because somebody wrote a project file for it.

The merge is directional and stated per key:

- **Additive keys** — `protectedPaths`, `localConfig`, `baseBranches`,
  `notOurs`, and `commands.forbidden` — are the **union** of every layer.
  Where both layers name the same entry (by `path`, `tracked`, `pattern`, or
  the string itself), the project's own entry wins on shape, so its `reason`
  is what a denial shows, but the **stronger action is kept**. Every key here
  names a list whose entries only ever restrict what may happen.
- **Every other key** keeps the original behaviour: the project's own value
  replaces the layer beneath it wholesale. `branchNaming` is one pattern and
  not a set, `commands.typecheck` describes one repository's build and cannot
  be unioned with another's, and `limits` is a threshold whose stack preset is
  the more specific answer.
- **`id`, `match`, `stack` and `stacks` are never inherited.** The first two
  identify the project; the last two answer "what kind of repository is this",
  and `stacks` outranks `stack` in `lib/stack-resolver.js`, so inheriting it
  would silently outrank a project's own declaration.

Two ways a project may still end up weaker than the floor, both deliberate
and both visible: an entry whose `action` is `off`, and `softela-ai override`.
An entry naming **no** action is left naming none, so the rule's own default
severity still decides rather than being replaced by an inherited, weaker
value.

The same merge runs for the stack preset (§8a), which is layered between the
two: `_default.json`, then the preset, then the project's own file.

`_default.json` carries what is true in every repository — but "every
repository" is not the same as "nothing at all". It declares:

- **`stacks`**, routing a file to `frontend` or `backend` by extension, so a
  repository that never declared a stack still resolves one and still inherits
  the matching preset's `conventions` and `limits` (§8a). Without this the
  whole `code` catalogue is inert outside the three named repositories, which
  is a rule set that reads as installed and enforces nothing.
- **`baseBranches`**, **`releaseBranchPattern`** and **`branchNaming`**, the
  git flow every repository here follows.
- **`protectedPaths`** for credential-bearing files — `.env`, `.env.*`,
  `.npmrc`, `id_rsa`, `*.pfx` — which are worth an `ask` in any repository.

A fact that is true of one repository still belongs in that repository's file,
and a guard must never hard-code a filename, a base-branch name or a build
quirk. The distinction is between a default that is *general* and a default
that is *empty*; only the second is forbidden.

Schema: `core/schema/project.schema.json`. `softela-ai doctor` validates every file
in `projects/` against it, and the test suite does the same in CI.

### The `rules` switch — tier 2

A project config may switch rules on or off **wholesale**, not only one id at
a time — the requirement this exists for is a repository that is "pure
developer infrastructure, not a product," where most of a product repo's rule
set has no business running at all:

```json
"rules": {
  "groups": { "code": "off" },
  "byId": { "branch-naming": { "action": "off", "reason": "this repo has no shared branch convention yet" } }
}
```

- A `group` is one of the three values a rule's own `group` field carries —
  `"git"`, `"code"`, `"agent"` (§3). `byId` targets one rule by its id.
- Each entry is either the bare action string (`"off"` / `"ask"` / `"deny"`)
  or `{action, reason}` — the `reason` is for a developer reading the project
  file to understand *why* the team turned a rule off or up, not only that
  they did. `doctor` today prints the reason on an active *override* (§6); it
  does not yet echo this tier's `reason` back — a project file is meant to be
  read directly, since it is committed and short.
- **`byId` beats `groups`**; `groups` beats the rule's own default. A group
  can be switched off wholesale and one specific rule inside it re-enabled (or
  even escalated) through `byId`.
- Unlike the developer's own `overrides.json` (§6), this tier may move a
  rule's action in **either** direction — off, or stronger than its own
  default — because it is a file committed to the repository and reviewed by
  the team, not one person's unilateral local change.
- `infra-self-protection` ignores this switch entirely (`mandatory: true`,
  §3): it cannot be turned off from inside the repository whose infrastructure
  it protects.
- **`groups.code: "off"` is a blunt instrument** — it silences every code rule,
  including the stack-agnostic ones (`reuse-before-new`, `doc-comment-style`,
  `naming-standards`) that have nothing to do with why a repository does not
  want frontend rules. A repository that is genuinely not
  a product at all (developer infrastructure, with no application code in
  either stack) is the right use of this switch — `Softela.AiInfrastructure`
  is that case. A backend repository that merely has no frontend code is not:
  it declares `"stack": "backend"` (§8a) instead, which silences exactly the
  frontend-scoped rules and leaves the stack-agnostic ones running.

### Protecting a checked-out project config

`infra-self-protection` (§3, `mandatory: true`) only covers the **installed**
copy under `<agentHome>/softela-ai/` — the files `softela-ai` actually copies onto a
developer's machine. A checked-out `projects/*.json` in this repository's own
working tree, before it is ever installed anywhere, has no equivalent
technical control; only pull-request review stands between an agent and a
rewrite of, say, `Softela.AiInfrastructure.json`'s own protections. This
repository's own project config lists `projects/**.json` under
`protectedPaths` (§8's blanket-write and blanket-stage coverage) precisely to
close that gap — as an `"ask"`, the strongest this tier can do for its own
files without becoming `mandatory` itself, which only `infra-self-protection`
is.

**The blast radius of this is deferred, and that is worth stating plainly
rather than assuming either way**: this protection fires only when the hook
pipeline running against a checkout is the one evaluating a real rule set
against this real repository — day-to-day, that means a developer or an
agent working inside a clone of `Softela.AiInfrastructure` itself. It does
**not** reach a developer's `<agentHome>/softela-ai/projects/*.json` after
installation; that copy is `infra-self-protection`'s job, not this entry's.
Editing a checked-out `projects/*.json` and merging it changes nothing on any
machine until the next `softela-ai update` re-copies it — so this control's real
job is making the edit visible and deliberate in the moment it happens, not
stopping a change from ever reaching production. Tier 2 (§8) has no stronger
technical control available for its own files today; only review does.

---

## 8a. Stacks and presets

A repository is not always one uniform kind of codebase. `Softela.PestManagement`
is backend-only; `Softela.Bugworx` is frontend-only; a monorepo genuinely
contains both, and which one applies to a
given tool call depends on *where in the repository* the call touches, not on
the repository as a whole. `"stack"` / `"stacks"` in a project config, and a
rule's own `stacks` field (§3), exist to make that resolvable per path instead
of per repository.

### Declaring a project's stack

Two spellings, because a monorepo needs the second and a plain repository
should not have to pay for it:

```json
"stack": "frontend"
```

```json
"stacks": [
  { "paths": ["src/Web/ClientApp/**"], "stack": "frontend" },
  { "paths": ["src/**"], "stack": "backend" }
]
```

- The shorthand `"stack"` names the one stack the whole repository is. It
  applies to any tool call that carries a file path, unconditionally — there
  is nothing to disambiguate.
- The monorepo `"stacks"` list is **ordered, and order is load-bearing**: the
  engine (`lib/stack-resolver.js#resolveStack`) walks it top to bottom and the
  **first** entry whose `paths` glob matches the tool call's file path (made
  relative to the repository root) wins. The natural authoring mistake is
  listing a broad glob before a narrow one — `"src/**"` before
  `"src/Web/ClientApp/**"` — which silently swallows the narrow entry and
  every frontend file resolves to backend. `tests/lib/stack-resolver.test.js`
  asserts the ordering both ways.
- A file path matching no entry in `"stacks"` resolves to **no stack**, the
  same as the no-file case below — it is not an error, and it is not assigned
  to whichever entry happens to be first.
- If a project config declares both, `"stacks"` (the monorepo list) takes
  precedence; a project is expected to declare only one.

### The non-file case

A shell command (`git push`, `npm install`) carries no file path, so there is
nothing to test a stack's globs against. **It always resolves to no stack —
never to a guess, and never to whichever stack a monorepo happens to list
first.** The consequence that matters:

- A rule with a `stacks` field (§3) is **never** a candidate for a no-file
  context, because "no stack" is never a member of any rule's `stacks` list.
- A rule with no `stacks` field — every git rule, every agent rule, and the
  stack-agnostic code rules — is **completely unaffected**, because stack
  resolution is only ever consulted for a rule that declared one. Getting
  this backwards in either direction is the exact bug this behaviour guards
  against: resolving *some* stack for a shell command would risk silencing
  the git rules (if resolution ever fed into a filter git rules were
  mistakenly subjected to) or firing a frontend rule on a backend shell
  command (if the guess leaned frontend). Neither happens, because the
  resolver only ever returns a real stack when there is a real file path to
  test against real globs.

### Presets — the conventions common to one stack

`projects/_presets/frontend.json` and `projects/_presets/backend.json` hold
the `conventions` (and other config) that are common to *every* project of
one stack, so an individual project file only has to state what is genuinely
its own. `Softela.Bugworx.json` keeps its base branch, its tracked/per-machine
config pair, its vendored-theme `notOurs` entries and its `npm test` trap —
all genuinely specific to that repository — and gets `limits.fileLines` from
the frontend preset instead of restating it. It does restate `conventions`
wholesale, because the merge replaces that key rather than merging into it
and its source root is `react-app/src`, not `src`.

**Resolution**: when a context's file path resolves to a stack (above), the
engine loads that stack's preset and merges it underneath the resolved
project config, before either the `requiresConfig` gate or any rule's
`evaluate` sees it (`core/engine.js#withEffectivePreset`). A context with no
resolvable stack, or a stack whose preset file is missing or unparseable, is
left with its project config exactly as resolved — a preset never invents
configuration a project did not, directly or through its stack, actually
declare.

**The merge rule, stated once so it is never ambiguous**: the merge is
*shallow, one top-level key at a time*. A key the project config declares
replaces the preset's key of the same name **wholesale** — nothing inside a
shared object such as `conventions` or `limits` is merged field by field. A
project that wants to change only `conventions.language` while keeping the
preset's `conventions.sourceRoots` restates the entire `conventions` object;
there is no partial override inside one key. This was chosen over a deep
merge specifically because a deep merge invites the question "which side wins
when both set `conventions.language`, and does a project's `conventions.a`
also expect the preset's `conventions.b` to survive?" — a question with no
single obviously-correct answer. A flat, per-key "yours or the preset's,
never both" avoids the question entirely.

**In a monorepo, this happens per call, not once for the whole repository**:
a frontend path resolves the frontend stack and merges the frontend preset;
a backend path in the very same repository resolves the backend stack and
merges the backend preset. Neither path's effective config ever sees the
other stack's preset.

**Why this also matters for stack-agnostic rules**: `reuse-before-new` and
`naming-standards` (`requiresConfig: ["conventions.language"]`) declare no
`stacks` field at all — they are meant to run on both frontend and backend
code. Because the preset merge happens before `requiresConfig` is checked, a
backend project that declares `"stack": "backend"` and nothing else already
satisfies `naming-standards`'s `conventions.language` requirement from the
backend preset's `"language": "csharp"`, without the project file repeating
it. This is the concrete fix for the defect the previous round introduced:
switching `groups.code` off to keep frontend rules out of a backend
repository also silenced `reuse-before-new` and `doc-comment-style`, which the
team confirmed **do** apply on the backend. `conventions.sourceRoots` is
deliberately left out of `projects/_presets/backend.json` — it is genuinely
per-repository (a real backend repository's actual source layout is not known
here) — but, unlike `naming-standards`, `reuse-before-new` no longer declares
`requiresConfig` at all: when a project (or its preset) states no
`conventions.sourceRoots`, the rule falls back to scanning the whole
repository root instead of staying silent, which is what lets it run on
`Softela.PestManagement` and on `_default` without anyone stating a source layout
by hand (see `RULES.md`'s `reuse-before-new` entry).

---

## 9. The installer

`bin/softela-ai`, implementation in `core/installer/`.

- **Copy, never link.** Nothing installed may reference a path inside the
  clone. `tests/installer/` deletes the clone and asserts the installation still
  works — that test is the reason for this rule.
- **Ownership manifest** at `<agentHome>/.softela-ai/manifest.json`: for every
  installed file, its relative path and the SHA-256 of the bytes as written; for
  every managed JSON key, its JSON pointer.
- **Three cases on update**, per file:
  | Case | Test | Action |
  |---|---|---|
  | untouched | hash matches manifest | overwrite |
  | locally modified | hash differs | keep, write the new version as `<name>.new`, report |
  | absent | path missing | install fresh |
  A file no longer shipped is removed only when still untouched.
- **Managed JSON keys** come in two modes, and confusing them is how an
  installer earns a reputation for wrecking configuration:
  - **`enforce`** — rewritten on every update. Only hook registrations and the
    permission entries we ship. A rule change has to actually reach the machine,
    so these are ours unconditionally.
  - **`seed`** — written only when the key is **absent**. Everything that is a
    preference rather than a rule: model choice, reasoning effort, approval
    policy, sandbox mode. A developer running a stronger model than our default
    must not be quietly downgraded by an update, and this is the mechanism that
    guarantees it.

    The target file itself may not exist yet either — a fresh machine that has
    never launched Codex has no `config.toml` at all, and that is the most
    absent a seed key can be: the file is created and every seed key is
    written into it, the same as seeding into an existing-but-empty one. A
    file that **exists but cannot be read** is a different situation and is
    left untouched instead — a file this installer cannot read is a file it
    must not overwrite — so "absent" and "unreadable" are tracked as distinct
    states (`core/installer/detect.js#gather`'s `configToml.exists`), never
    both collapsed onto "nothing to seed into".

  Anything the installer does not name is preserved: byte-for-byte where the
  file can be edited surgically, key-for-key otherwise.
- **Managed text blocks** are delimited by
  `<!-- BEGIN softela-ai (managed — edits here are overwritten on update) -->` and
  `<!-- END softela-ai -->`. Content outside the markers is preserved verbatim. When
  the markers are absent the block is appended; the file is never replaced.
- **Backup before write.** Every file the installer is about to modify is
  copied into `<agentHome>/.softela-ai/backups/<timestamp>/` first.
- **`--dry-run` is universal** and prints the same plan the real run executes.
  The plan is computed by a pure function so it can be asserted in tests without
  touching a filesystem.

---

## 10. Tests

`node bin/softela-ai test` and `npm test` both run `tests/run.js`, which discovers
`tests/**/*.test.js`. No framework, no dependency; the harness is
`tests/harness.js` and exposes:

```js
suite("name", ({ test, eq, deepEq, throws, tmpdir, fakeHome }) => { … });
```

- exit code 1 on any failure, 0 otherwise
- every test is independent and may run in any order
- nothing writes outside `os.tmpdir()`; a test that touches the real
  `~/.claude` or `~/.codex` is a defect
- `fakeHome()` returns a disposable directory and sets `SOFTELA_AI_HOME` for the
  duration of the test

Five suites, per `docs/standards/` and the build specification:

| Suite | Asserts |
|---|---|
| `tests/guards/` | table-driven per rule: a `ctx` in, an expected decision out; positive, negative and **evasion** cases |
| `tests/adapters/` | parity — the same rule and input through both adapters give the same decision |
| `tests/installer/` | the five sequences in §11 |
| `tests/modules/` | one suite per module, each including its own guard behaviour |
| `tests/probes/` | empirical checks of host behaviour the vendor documentation does not specify; skipped, not failed, when the host is absent |

---

## 11. The installer sequences that must hold

1. install → update → nothing changes
2. install → the developer edits a shipped file → update → **the edit survives**
3. install onto a home that already has hooks, skills, settings and memory →
   all of it is still present and unmodified afterwards
4. install → **delete the clone** → everything still works
5. install → uninstall → only managed artefacts are gone

---

## 12. Style

- Documentation in code follows `docs/standards/code-documentation.md`, which
  this repository obeys itself: JSDoc `/** … */` on exported functions with
  `@param` for every parameter and `@returns` even when `void`; never
  `@example`; a block covering more than one item is a list, not a paragraph;
  every member of an exported object literal or type carries its own inline
  block with a blank line between comment and member.
- Inline comments explain **why**, not what.
- **No ticket number ever appears in a source file** — not in a comment, a test
  name, a string or a commit subject. Ticket ids live in the tracker and the PR.
- Everything in this repository is written in English: code, comments, docs,
  test names, commit messages, CLI output.
- No customer name appears anywhere.
