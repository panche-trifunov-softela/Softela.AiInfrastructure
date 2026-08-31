# Local development — Softela.ReactRDT

How this repository resolves the config that decides which app runs and
which API host it talks to. See `docs/standards/local-dev-config.md` for the
portable principle behind the split; this file is the mechanics specific to
this repository.

## The two config files

- `public/config.js` — tracked, deployed hosts only. This is the only config
  file a build ships. It currently carries the `SCExpertMobile` entry.
- `public/config.development.js` — gitignored, one per machine. Used by
  `npm run dev`, and by Cypress outside CI when the file exists.

Both files are plain scripts whose only effect is assigning `window.config`.
`scripts/softela-env.ts` evaluates them with a stand-in `window` object — the
same thing the browser does at runtime — so reading the config at build time
and reading it in the browser go through the same assignment, not two
parallel implementations that can drift apart.

## `scripts/softela-env.ts`

Exports `resolveConfigFile(rootDir, preferDevelopment)` and
`readAppConfig(rootDir, preferDevelopment)`. Both `vite.config.ts` and
`cypress.config.ts` import these two functions, and that shared import is
what keeps the running app, the dev server's `<base href>`, and the Cypress
interceptor URLs pointing at the same place with nothing to keep in sync by
hand. Change the resolution logic once, here, and every consumer picks it up.

## The three Vite plugins

- `softela-base-href` — rewrites `<base href>` from `APP_ID`, at both dev and
  build time.
- `softela-runtime-config` — rewrites the config `<script src>` in `index.html`
  to whichever config file applies.
- `softela-strip-dev-config` — deletes `config.development.js` from `dist/rdt`
  after a build. Vite copies all of `publicDir` into the bundle, so without
  this step the per-machine file would ship.

## `index.html`

Carries `<base href>` and the config `<script src>`. Both are rewritten by
the plugins above and are not edited by hand — the file says so itself in
comments.

## `vite preview` resolves the build, not the dev server

`vite preview` runs with `command === "serve"`, the same value the dev
server uses, but it must resolve what the *build* resolved: it serves build
output whose `index.html` already points at `config.js`, and from which
`config.development.js` was already stripped. Only the dev server may use
the development file. A build is always `config.js`.

## What the dev server prints

Two `[softela]` lines on startup name the app, the config file in use, and the
resolved API host. That is the check that the setup is right — read them
before assuming a stale config is the cause of something.

## Falling back to defaults

Deleting `public/config.development.js` falls back to the deployed
defaults in `public/config.js`.

## CI is unaffected

CI stays on `config.js`. `preferDevelopment` is never set there.

## `APP_ID` selects the app, not merely the servers

Putting the `SynapseWebRF` entry in `public/config.development.js` runs that
app at `https://localhost:4200/SynapseWebRF/`, with no tracked file touched.
`public/config.js` itself currently carries the `SCExpertMobile` entry only —
the older single local switch, pinned to one hard-coded local port, is gone.
The deployed `SynapseWebRF` entry is recorded in this repository's own
`docs/LOCAL_DEVELOPMENT.md`, not here.

## HTTPS is not optional for a local Synapse API

The dev server serves over HTTPS. An `http://` API base is blocked by the
browser as mixed content, and no CORS entry works around that — a local
Synapse API must itself be served over HTTPS.

## This repository's own docs

- `docs/LOCAL_DEVELOPMENT.md` — setup for both apps, CORS, the local server
  port map.
- `docs/SUBMIT_API_ROUTING.md` — how submit buttons compose their URLs.

Host names and port numbers for backend services belong in those two files,
not duplicated here.

## The `local-config-isolation` guard

The project config for this repository (`projects/Softela.ReactRDT.json`)
sets `local-config-isolation` to `deny`. The split between `config.js` and
`config.development.js` already exists in this codebase, so there is never a
legitimate reason to put a local host in the tracked file — any attempt is
blocked outright, not merely flagged.
