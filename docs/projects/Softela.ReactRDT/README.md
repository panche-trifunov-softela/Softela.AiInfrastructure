# Softela.ReactRDT

The React RDT frontend. One codebase builds more than one app, selected at
runtime by `APP_ID` in the resolved config: `SCExpertMobile` and
`SynapseWebRF`.

- Base branch: `main`
- Remote: `https://SOFTELA@dev.azure.com/SOFTELA/RND/_git/Softela.ReactRDT`
- Project config file: `projects/Softela.ReactRDT.json`
- Build tool: Vite
- Output directory: `./dist/rdt`
- Dev server: HTTPS on `localhost:4200`, `strictPort: true`. Preview: `4300`.
  The port is fixed on purpose — the remote server's CORS allow-list names
  that exact origin, so falling back to another port breaks every API call.

## In this folder

- `local-development.md` — how the per-app, per-machine config is resolved,
  which files are tracked and which are not, and what to check when the
  wrong app or the wrong API host comes up.

## Related

- `docs/standards/local-dev-config.md` — the portable rule this repository
  follows, same as every other.
- `docs/OPEN-DECISIONS.md` — questions that touch this repository and are not
  settled yet. Nothing there is a rule; do not enforce or assume any of it.
