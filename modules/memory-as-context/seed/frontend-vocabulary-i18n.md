---
name: frontend-vocabulary-i18n
description: How the SCExpert vocabulary reaches the UI — uppercased keys, the patched i18n.t, and what silently never translates
metadata:
  type: reference
  source: softela-ai
---

# Frontend vocabulary / i18n

## Vocabulary loading and translation mechanism

Depth behind [[frontend-architecture]]; consumed all over [[frontend-render-tree]].

- `src/translation/i18n.ts` is the whole mechanism. Vocabulary comes from the
  backend `vocabulary/{languageCode}` endpoint as `{ phraseId, phraseTranslation }`
  rows and is registered as one flat `translation` bundle whose language name is
  the numeric language code as a string.
- **The cache moved** (commit 7cdedce1): it used to be
  `localStorage` under `i18n_vocab_<code>` with a 24 h TTL; it is now the zustand
  `useStore.vocabulary` map keyed by language code (`setVocabulary` /
  `clearVocabulary`). That store has no `persist` middleware, so the cache no
  longer survives a page reload — every reload refetches the vocabulary.
- **Keys are stored UPPERCASED** (`acc[item.phraseId.toUpperCase()]`).
  `initI18n` therefore replaces `i18n.t` with a `customT` that uppercases the
  incoming key and, **on a miss, returns the caller's original string** — so a
  phrase that is not in the vocabulary renders in its authored casing.
- `useTranslation()` returns `i18n.getFixedT(...)`, which is not `customT` — but
  i18next's `getFixedT` delegates to `this.t(...)`, and `this.t` IS the patched
  instance property. So the uppercasing and the miss-fallback do apply to every
  component's `t`.
- Consequence for review work: **any user-visible string not wrapped in `t()`
  can never be translated**, and wrapping a string in `t()` is always safe — a
  missing vocabulary entry costs nothing.
- `keySeparator` / `nsSeparator` are left at the i18next defaults (`.` and `:`).
  A phrase containing a dot or a colon is parsed as a nested path / namespace and
  can never resolve, even when the vocabulary holds it as a flat key. AC captions
  are free DB text, so this hits real data.
- Two different translation contracts coexist for **data** (not chrome):
  - Grid/form path — only DT fields flagged `translate=true` are translated;
    `isTranslateField` + `translateRows` (`src/utils/gridUtils.ts`),
    `useTranslatedRows`, and `buildColumnsFromDt` (`src/utils/columnBuilder.tsx`,
    which translates both the header and, via `isTranslate`, the cell values).
  - Chart path — CRT/NIB viewers translate **every** label through a local
    `translateLabel`, ignoring the DT flag. NIB's copy additionally reformats ISO
    dates; CRT's does not.
- `src/components/RequestState.tsx` translates the three default messages. The
  underlying `@softela/basic` `RequestState` treats `error` as a **boolean flag only**
  and renders `errorMessage`; passing an error string into `error` never shows it.
