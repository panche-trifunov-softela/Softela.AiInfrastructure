# Debugging — Softela.SCExpert (Infra NG)

Sourced from the organisation wiki's NG debugging page. Repository names and
Swagger constants below are quoted as given; verify they still match before
relying on them, since the wiki has been observed to drift from actual
practice elsewhere (see `docs/standards/git-flow.md`'s "Where the wiki
disagrees" section).

## Backend debug

Repository: `Softela.Infra.Api`.

In Visual Studio, set three projects as startup projects:

- `Softela.Bff.WebApi`
- `Softela.Infra.WebApi`
- `Softela.Warehouse.WebApi`

Compile and run — this should launch three Swagger browser windows, one per
project above.

To hit a breakpoint on screen loading: `Softela.Infra.Api` ->
`Softela.Infra.Ui.Web` -> `Controllers` -> `Screens2Controller` ->
`GetAllScreens(...)`.

Debugging through Swagger:

1. Open the `Softela.Infra.WebApi` Swagger page.
2. Use the "Authorize" button.
3. Set `client_id` = `SCExpertNG`, then authorize.
4. Call `GET /api/screens` (invoked on app start) with:
   - `term` — any text
   - `page` = `1`
   - `pageLimit` = `1`
   - `x-Application-id` = `WarehouseExpertWS`
   - `x-WAREHOUSE` = `TEST04_WH_demo`
5. Execute — the breakpoint set above should be hit.

## Frontend debug, driven from `Softela.ReactSCExpert`

Repository: `Softela.ReactSCExpert`, branch `dev-ng`. Open in VS Code and
read the repository's own `readme.md` first.

Chrome needs web security disabled for this to work locally:

```
start chrome --disable-web-security --user-data-dir="C:\chrome_dev"
```

or a permanent shortcut with this target:

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --disable-web-security --user-data-dir="C:\ChromeDevSession"
```

`config.js` should point at the local backend:

```js
const BASE_URL = "https://localhost:7236";
const runtimeConfig = {
  BASE_URL,
  API_URL: `${BASE_URL}/api`,
  WAREHOUSE_API_URL: `${BASE_URL}softela.warehouse/api`,
  TOKEN_KEY: "jwtToken",
  API_URL_SILENT: "./silent-renew",
  API_URL_CALLBACK: "./callback",
  APPLICATION_ID: "WarehouseExpertWS",
  APPLICATION_NAME: "SCExpertNG",
  HOME_URL: "main",
  LOGO_NAME: "SCExpert",
  SUB_LOGO_NAME: "Warehouse",
  devMode: false,
  OIDC: {},
};
// Vite loads some modules in Node (no window). Only attach to window in-browser.
if (typeof window !== "undefined") {
  window.config = runtimeConfig;
  window.APP_CONFIG = window.APP_CONFIG || {};
}
```

Set a breakpoint at `Softela.Infra.Api` -> `Softela.Infra.Ui.Web` ->
`Controllers` -> `Screens2Controller` -> `GetAllScreenObjects(...)`.

Install dependencies with `npm i --force` (see
`docs/projects/Softela.ReactSCExpert/repository-traps.md` for why a plain
`npm install` does not work here), then `npm run dev`.

**Also worth a breakpoint:** `WarehouseHandlerService`.

## Handheld (RDT) debugging

Repository: `Softela.ReactRDT`. The wiki source did not have further
RDT-specific steps captured beyond naming the repository — confirm the flow
directly with whoever owns that app before relying on this being complete.
