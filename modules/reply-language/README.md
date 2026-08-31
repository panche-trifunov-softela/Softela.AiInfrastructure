# reply-language

Default: **on**. Option: `languages` — an ordered list, default
`["English"]`.

Sets the language, or ordered list of languages, the agent uses when talking
to the developer. Any language may be chosen — see "The language catalogue"
below — not only the ones named as examples in this file.

## Conversation only

Code, comments, documentation, commit messages, pull request descriptions,
test names, CLI output and every other artefact stay English regardless of
this setting. `prompt.md` states the carve-out explicitly, naming the exact
categories it covers, so the generated block is unambiguous for whatever
language list an installation configures — this is the one thing about this
module that must not be possible to get wrong, per `MODULES.md`.

## How the option reaches the prompt

`prompt.md` uses `{{OPT_LANGUAGES}}` — per `MODULES.md`'s substitution list,
"any option value as `{{OPT_<NAME>}}`" — substituted at install time with the
configured list. A single-language install reads naturally as "in English";
an ordered multi-language list is described in the same block as a
preference order, so the substituted value is expected to render as a
plain, comma-separated phrase (e.g. `English` or `German, French`)
rather than a list literal.

## The language catalogue

`languages.json` is the full set of ISO 639-1 two-letter language codes —
183 entries — each carrying at least its code and its English name, plus an
endonym (the language's own name for itself) wherever that is confidently
known rather than guessed. ISO 639-1 is used as the source of truth because
it is a real, bounded, published standard: it is what makes "the full list"
a defensible claim rather than one person's opinion of which languages
matter.

- The full catalogue is offered flat, with no tier and no ordering by
  preference: every ISO 639-1 language in `languages.json` is an equally
  valid, equally available choice, and nothing about the module nudges a
  developer toward any particular one.
- The `languages` option still accepts a plain comma-separated list, exactly
  as before this catalogue existed — nothing that already worked breaks. Each
  entry may be given as the catalogue's English name, its ISO 639-1 code, or
  its endonym; matching is case-insensitive.
- Skipping the option leaves the default, `["English"]`.

### Validating a configured language

`hooks/validate-languages.js` runs on `SessionStart` and checks every
configured entry against the catalogue. An entry the catalogue does not
recognise is reported by name in the session's additional context — a
message such as *"lists an entry not found in this module's ISO 639-1
catalogue: \"Klingon\""* — rather than being silently accepted or crashing
the session.

This is a deliberate approximation, not the ideal location for this check.
The natural place to validate a `languages` value is where the installer
resolves it — `core/installer/plan.js#computeNewState` /
`buildOptionVars` — so a developer gets told immediately, at
`softela-ai install` / `module enable` / `--reply-language` time, rather than
waiting for the next session start. `module.json`'s own `options` schema has
no field for "validate this value against a module-shipped data file," and
adding one is a `core/` change, which is out of this module's own scope. A
`SessionStart` hook is the closest approximation available entirely from
inside the module: it already has the resolved `{{OPT_LANGUAGES}}` value
(via the same substitution every other module option uses) and the
`additionalContext` mechanism `memory-as-context`'s `inject-memory.js`
already establishes for informational, non-blocking output. A maintainer
who wants install-time validation instead should add a validation hook to
the `options` schema itself in `core/installer/`, called after
`computeNewState` resolves each module's option values and before they are
written to `state.json`.

## Judgement calls made in this implementation

- **`languages` needs a list-typed option**, which `MODULES.md`'s own
  `options` schema example only shows for `type: "enum"` (a fixed set of
  values). This module uses `"type": "stringList"` with a `default` array —
  a reasonable minimal extension, but not itself drawn from the spec, so the
  installer's option-prompting code needs to actually support it (an ordered
  free-text list, not a fixed enum) rather than only what the worked example
  shows. The catalogue in `languages.json` does not change this: `languages`
  is still a `stringList`, now cross-checked against data the module ships
  rather than left to accept anything.
- **No guard on reply language itself.** Reply language is conversational
  behaviour a `PreToolUse` or `PostToolUse` hook has no vantage point to
  check — there is no tool call whose input reliably tells a guard what
  language the agent's own reply used. Enforcement is the carve-out sentence
  in `prompt.md` plus (per `MODULES.md`) a future
  `tests/modules/reply-language.test.js` asserting the carve-out text is
  present in the generated block for every configured language. This is
  unrelated to, and unchanged by, the `SessionStart` catalogue check above:
  that check validates the configured *option value* against a fixed data
  file, a plain deterministic lookup, not the agent's conversational
  behaviour.

## Turning it off

`softela-ai module disable reply-language` removes the prompt block and the
`SessionStart` validation hook. The agent reverts to its host's own default
reply behaviour — this module adds no other mechanism to undo.
