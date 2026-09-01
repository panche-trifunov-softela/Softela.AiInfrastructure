---
name: bugworx-verification-trap
description: "`npm run test` in Softela.Bugworx exits 0 having run NOTHING — there is no test suite; verify with npm run build and npm run lint"
metadata:
  type: project
  source: softela-ai
---

**`npm test` / `npm run test` in `Softela.Bugworx` succeeds having executed nothing.** `react-app/package.json` declares no `test` script at all, and the GitHub Actions workflow runs `npm run test --if-present` — which skips silently and passes.

There are **zero spec files** in the repository. Not "few" — none.

**A green `npm test` here is indistinguishable from a healthy suite and means nothing.** Never report it as tests passing. `projects/Softela.Bugworx.json` asks before any `npm test` invocation for exactly this reason.

## Verify with these instead

```bash
cd react-app
npm install        # no flags needed; no lockfile, no peer-dependency conflict
npm run build      # vite build — the real check
npm run lint       # eslint flat config; NOT run in CI
```

`npm run build` is the only thing that actually fails on broken code. Lint is configured but no CI step runs it, so a lint error reaches `master` unnoticed.

## Related traps in this repository

- **Clone with `git -c core.longpaths=true` and into a short directory.** Paths under `components/Configuration/communication/CancellationAdjustmentRejectionReasons/` exceed `MAX_PATH`; a plain `git clone` on Windows reports "unable to checkout working tree" and leaves a half-populated tree behind. Same trap as `Softela.PestManagement`.
- **`react-app/.env` is tracked and carries a live Google Maps API key.** Do not add a local host to it — `VITE_API_URL` and `VITE_KEYCLOAK_URL` both default to localhost in code, so a local override belongs in `react-app/.env.local`, which `*.local` in `react-app/.gitignore` already excludes. The `local-config-isolation` guard enforces this pair.
- **Prettier is configured and not enforced.** Two-space indentation and 150 columns in `.prettierrc.json`; 23 of 179 `.jsx` files use four spaces and 170 lines run past 150. **Do not reformat a file you are not otherwise changing** — it buries the real diff.

See [[bugworx-architecture]] and `docs/projects/Softela.Bugworx/README.md`.
