# Softela.Bugworx — current state

**Measured 2026-09-01, against `master` at `272577d`.** Every number below
came from a command; none is an impression. Refresh it by re-running the
commands in [How to refresh this](#how-to-refresh-this) — and re-date the
heading when you do, because a stale snapshot presented as current is worse
than none.

Everything is measured under `react-app/src`, excluding `assets/` (the
vendored theme).

## Size

| Metric | Value |
| --- | --- |
| `.js` / `.jsx` files | 324 |
| Total lines | ~42,100 |
| Files over 1,500 lines (the critical threshold) | 1 |
| Files over 1,000 lines | 5 |
| Files over 500 lines | 8 |
| Files over 300 lines | 19 |
| Spec files | **0** |

The five largest:

| File | Lines |
| --- | --- |
| `utils/localStorage.js` | 1,840 |
| `pages/Scheduler.jsx` | 1,442 |
| `data/mockData.js` | 1,414 |
| `pages/Routing.jsx` | 1,127 |
| `pages/AccountDetail.jsx` | 1,049 |

Two of those five are not really components. `data/mockData.js` is seed data
— a declaration table, and the kind of file
[`docs/standards/file-size.md`](../../standards/file-size.md) names as a
legitimate exception. `utils/localStorage.js` is the browser-storage data
layer standing in for the backend; it is over the critical threshold, but
splitting it by line count is the wrong move while the real answer is that
most of it disappears as features are wired to the API.

That leaves **three genuine decomposition candidates**: `Scheduler.jsx`,
`Routing.jsx` and `AccountDetail.jsx` — all three are page views with no
hook beside them, so the whole file is view *and* logic. They are the
`/split-component` workflow's first customers.

## Structure

| Metric | Value |
| --- | --- |
| Component files (`.jsx` under `components/`, `pages/`, `layouts/`) | 174 |
| …with a matching `use<Component>` hook beside them | 102 |
| …without | 72 |
| Barrel (`index.js`) files | **0** |
| Relative imports climbing 3+ levels | 439 |
| …climbing 4+ levels | 428 |
| Path aliases configured | **0** |

**The 72 without a hook are not 72 violations.** Most are genuinely
presentational and correctly have none — `EmptyState`, `Pagination`,
`TableHeader`, `PhoneRow`, `EmailRow`, the seven `AdvancedFilter` panels. The
ones that matter are the page views carrying their own state: `AccountDetail`,
`Analytics`, `Appointments`, `Areas`, `Billing`, `Configuration`, and the
handful of configuration screens that have not been converted yet.

One file to note: `components/Configuration/OperationalSetup/RouteConfiguration/useAddEditRouteConfiguration.jsx`
is a hook with a `.jsx` extension. It returns no JSX, so it should be `.js` —
[`docs/standards/naming.md`](../../standards/naming.md).

## Data access

| Metric | Value |
| --- | --- |
| Modules importing `utils/localStorage` | 90 |
| …of which are views (`.jsx`) | 36 |
| Direct `fetch(` calls outside `services/` | **0** |
| Modules importing a service | 8 |
| …of which are components, pages or layouts | 3 |

The transport boundary holds — no feature code calls `fetch` directly, and
that is worth keeping. The two things that do not:

- **36 view files read `localStorage` in the render body.** That is data
  access in the view, which is the one boundary
  [`docs/standards/layer-boundaries.md`](../../standards/layer-boundaries.md)
  is built on.
- **Three views call a service directly** — `pages/CustomerOverview.jsx`,
  `pages/CustomerServiceAddresses.jsx` and
  `layouts/EditableForms/EditableForms.jsx`. Components call hooks; hooks
  call the API layer. `api-import-boundary` denies this for new files.
  (`contexts/EditableFormContext.jsx` calls one too, which is the same
  boundary crossed from the other side.)

Routes are inline string literals (`/api/customers`,
`/api/service-addresses?customerId=…`) with no endpoint-constants file, and
`services/customerService.js` maps a form shape to the API shape inside the
service — mapping is a hook's or a utility's job, not the API method's
([`docs/standards/api-layer.md`](../../standards/api-layer.md)).

## State

| Metric | Value |
| --- | --- |
| React contexts | 3 |
| Feature hooks instantiated inside `EditableFormContext` | 25 |
| Imports in that one file | 28 |
| Modules consuming `useEditableFormContext` | 28 |
| Routes declared in `App.jsx` | 90 |

`EditableFormContext` is the single largest architectural item in the
repository — see the anti-pattern section in
[`docs/standards/layer-boundaries.md`](../../standards/layer-boundaries.md),
which was written against it.

## Tooling

- **CI**: one GitHub Actions workflow, on push to `master`. It runs
  `npm install`, `npm run build`, `npm run test --if-present`, then deploys
  `react-app/dist` to an Azure Web App. **No lint step, and the test step is
  a no-op** because no test script exists.
- **Lint**: ESLint flat config, `js.configs.recommended` plus the React hooks
  and React refresh plugins. One custom rule (`no-unused-vars` ignoring
  `^[A-Z_]`). Not run in CI.
- **Format**: Prettier configured, format-on-save in `.vscode/settings.json`,
  not enforced anywhere. 23 of 179 `.jsx` files indent with four spaces
  against the configured two; 170 lines exceed the configured 150 columns.

## How to refresh this

From `react-app/`:

```bash
# size
find src -name '*.js' -o -name '*.jsx' | grep -v assets | xargs wc -l | sort -rn | head -20

# view/hook pairing
for f in $(find src/components src/pages src/layouts -name '*.jsx'); do
  d=$(dirname "$f"); b=$(basename "$f" .jsx)
  [ -f "$d/use$b.js" ] || echo "NOHOOK: $f"
done

# import depth
grep -rEo "from '(\.\./){4,}[^']*'" src --include=*.jsx --include=*.js | wc -l

# barrels
find src -name 'index.js*' -not -path 'src/assets/*' | wc -l

# data access in views
grep -rl 'utils/localStorage' src --include=*.jsx | wc -l
grep -rn 'fetch(' src --include=*.js --include=*.jsx | grep -v 'src/services/'
```

Clone with `git -c core.longpaths=true` on Windows, and into a short path:
several component paths under
`components/Configuration/communication/CancellationAdjustmentRejectionReasons/`
exceed `MAX_PATH`, and a plain `git clone` reports "unable to checkout
working tree" while leaving a half-populated index behind — the same trap
[`Softela.PestManagement`](../Softela.PestManagement/README.md) has.
