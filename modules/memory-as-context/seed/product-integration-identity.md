---
name: product-integration-identity
description: Web API 25.3, Softela Identity/OIDC (IdentityServer-based), SCExpert Connect plugin pattern, Email Gateway, Remote Printing, webhook management, and the full deployed-service inventory (RabbitMQ/MSMQ, Softela.Infra = the backend repo) — distilled from the official product docs
metadata:
  type: reference
  source: softela-ai
---

Companion to [[backend-architecture]]. This file covers the parts of the product the two local repos (`Softela.ReactSCExpert`, `Softela.SCExpert`) don't fully show on their own: the public Web API surface, the shared Identity/IAM platform, and how SCExpert talks to the outside world. See [[memory-authority-model]] — this is product-docs authority (what the product is designed to do), not code authority.

## Product documentation capture

Distilled from a local MkDocs capture of the official SCExpert product documentation. Page-level sources are cited inline as `[folder/page]`. SCExpert product version referenced throughout the corpus is **25.3** (see §5).

### 1. SCExpertWebAPI (v1) — shape

Folder name is `scexpertwebapidoc-25-3` — **25.3 is the SCExpert product version the API docs describe, not a separate API version number.** The docs do not state any API versioning scheme (no `/v1/`, `/v2/` in URLs, no version header, no deprecation policy mentioned anywhere). The guide page itself is titled "SCExpertWebAPI (v1) Guide" but no path segment reflects a "v1" — UNVERIFIED whether "v1" is a real versioning concept or just the doc title. `[scexpertwebapidoc-25-3/scexpertwebapi-v1-guide]`

**Discovery / tooling:**
- Swagger UI per installation: `https://[YourServerURL]/scexpertwebapi/swagger`
- A Postman collection ("SCExpertWebAPI.test") is provided; auth in Postman is set via **Basic Auth** using an SCExpert admin user (username/password entered directly in Postman's Authorization tab). This is stated as the *test* auth method — the docs do not separately describe a production OAuth/OIDC-token flow for this API. UNVERIFIED whether production calls use the same Basic Auth or go through Softela Identity (the Identity docs describe OIDC/JWT for *other* Softela services — see §2 — but the WebAPI guide itself only documents Basic Auth).
- Base URL pattern in all examples: `https://{{base_url}}/SCExpertWebAPI/api/{Resource}`

**Request/response conventions (as stated):**
- **All resources support POST for both create and update** (upsert): "A new resource is created in the system if the provided resource ID does not exist. A resource is updated in the system if the provided ID exists." On update, omitted fields keep their existing values (partial-update semantics on POST).
- GET is used for single-resource retrieval, generally by query params (e.g. `CLIENT` + business key) or a path `{ID}`.
- Response envelope for GET: `{ "DATACOLLECTION": { "DATA": { ...fields... } } }`.
- Response envelope for POST (create/update):
  ```json
  {
    "MessageProcess": "True",
    "MessageProcessError": "",
    "Transactions": [
      { "TransactionProcess": "True", "TransactionProcessError": "",
        "TransactionKeys": [ { "Name": "CLIENT", "Value": "..." }, ... ] }
    ]
  }
  ```
  This is the **only error-handling convention documented**: success/failure is signaled via `MessageProcess`/`TransactionProcess` boolean-ish strings plus an `*Error` string field, not via HTTP status codes beyond "200 OK" shown in every example. The docs never show a non-200 example, a validation-error payload, or an HTTP 4xx/5xx sample. **Paging is not mentioned anywhere in these 8 pages** — GET endpoints return a single object, not a collection, so paging may simply not apply to this API surface. Mark absence of documented paging/error-code conventions as a genuine gap, not an oversight in this distillation.
- `AdditionalData` (object, sometimes capitalized differently as `Additional Data` in the field table vs `AdditionalData` in JSON) is a generic custom-fields bag present on most root entities and several nested objects.

**Resource groups and main resources:**

| Group (doc page) | Covers | Main resources / endpoints |
|---|---|---|
| Warehouse Master Data `[warehouse-master-data-resources]` | Static/reference data | `Company` (`GET/POST /api/Company`), `Contact` (`GET/POST /api/Contact/{ID}`, `POST /api/Contact`), `SKU` (`GET/POST /api/SKU`), `Location` (`GET /api/Location/{ID}`, GET-only — no POST documented) |
| Inbound Process `[inbound-process-resources]` | Receiving | `InboundOrder` (`GET/POST /api/InboundOrder`), `Receipt` (`GET /api/Receipt/{ID}`, `POST /api/Receipt/{ID}`) |
| Outbound Process `[outbound-process-resources]` | Shipping | `OutboundOrder` (`GET/POST /api/OutboundOrder`), `Shipment` (`GET/POST /api/Shipment/{ID}`) |
| Cross-Dock `[cross-dock-resources]` | Flowthrough / transshipment | `Flowthrough` (`GET/POST /api/Flowthrough`), `Transshipment` (`GET/POST /api/Transshipment`) |
| Work Center Resources `[work-center-resources]` | Value-add manufacturing-type ops | `Assembly` (`GET/POST /api/Assembly`), `Disassembly` (`GET/POST /api/DisAssembly` — note capitalization), `ValueAdded` (`GET/POST /api/ValueAdded`) |
| Routing Process `[routing-process-resources]` | Delivery routing | `Route` (`GET/POST /api/Route/{ID}`) — includes nested `Stops`/`Tasks`/`Packages` |
| Courier Resources `[courier-resources]` | Carrier master data | `Carrier` (`POST /api/Carrier` — **no GET documented**) |

All entities key off `CLIENT` (a tenant/owner-of-goods concept *internal to SCExpert's warehouse data model* — distinct from the IAM "Tenant" concept in §2, and the same **Client** described in [[wms-domain-primer]]) plus a business-key field (e.g. `SKU`, `INBOUNDORDER`, `WORKORDER`, `ROUTE`). Nested line/detail collections follow a consistent `LINES`/`LINE` or singular/array-ambiguous JSON shape (the docs' example payloads are inconsistent about whether a 1-item collection serializes as an object or a 1-element array — treat as a quirk of the underlying XML-ish serializer, not a documented contract).

### 2. Softela Identity (IAM)

**What it is.** Built on **IdentityServer** (an OpenID Connect + OAuth 2.0 provider) — docs literally point to "IdentityServer8 documentation" for background on identity/API resources `[managing-identity-resources]`. It is a multi-tenant IAM platform shared by all Softela applications (SCExpert, SCExpertMobile, DeliveryExpert, Email Gateway, etc.). Product/installer name: **`Softela.IdentityPlatform.exe`**, downloaded from the Softela Support Portal `[appendix-2-iam-installation-guide]`. This matches the repo name `Softela.IdentityPlatform` already used internally. Deployed service names (per the URL rename table, §4): admin/API surface = `Softela.Identity` (formerly `IdentityServerAdminAPI`), token endpoint host = `Softela.STS` (formerly `IdentityServerSTS`), management UI = `IAMmanagement` (unchanged name) `[installation/appendix-a-url-name-updates]`.

**Core entity model** (from `[iam-application-overview]`):
- **Global Admin** — manages all tenants system-wide.
- **Tenant** — an organization/customer; each has isolated users, roles, groups, applications.
- **Tenant Admin** — administers one tenant.
- **Warehouses** — a per-tenant catalog (Warehouse ID + Name) that users/groups are assigned into; `Location`/warehouse identifiers here are the same IDs SCExpert itself uses ("the unique system identifier used across SCExpert and other Softela systems") `[managing-warehouses]`.
- **Users** — individual credentialed principals, assignable to warehouses, groups, roles, applications.
- **Roles** — permission sets; built-in IAM roles: `Global Admin`, `Global User Admin`, `Tenant Admin`, `Tenant User Admin` `[managing-roles]`. Applications can also define their **own** application-scoped roles (see below).
- **Groups** — collections of users; roles/claims assigned to a group propagate to its members `[managing-groups]`.
- **Applications** — OIDC relying parties that request tokens from IAM.
- **Identity Resources** — claims about the user an app can request (name, email, custom ones like `warehouse_id`) `[managing-identity-resources]`.
- **API Resources** / **API Scopes** — protected backend functionality/permissions an app can be granted access to `[managing-api-resources]`, `[managing-api-scopes]`.
- **Claims** — key/value pairs attachable to Users, Groups, Roles, and Applications; end up embedded in tokens.
- **Tokens** — Identity token (who the user is) and Access token (what they can call).
- **Access Policies** — tenant-scoped conditional access rules (see below).
- **Webhooks** — entity-change notifications to external subscribers (see §2.5).
- **Audit** / **Log** — action history and error logs, filtered by tenant scope.

**2.1 Tenants.** Global Admins create/edit/delete tenants (`Tenant ID`, `Tenant Name` [internal unique key], `Tenant Display Name`, `Description`, `Is Active`). Each tenant additionally configures, as sub-resources: **Active Directory** server(s) — org-level AD/LDAP config (see §2.6); **External Providers** — OIDC/SSO federation config (see §2.2); **Password Policy**, **MFA & Enrollment**, **Network Resources** (named CIDR ranges for use in Access Policies), **Webhook Configuration**.

**2.2 How OIDC is actually configured (external identity providers).** This lives under **Tenants → External Providers**, not under Applications. Each tenant can register one or more external OIDC providers (Azure AD, Okta, Google, Auth0, "any generic OIDC provider") `[managing-tenants]`. Concrete fields, exact as documented:

| Field | Meaning |
|---|---|
| Provider Type | Determines callback path; fixed after creation |
| Name | Internal config name |
| SSO Button Caption | Login-page button label |
| Domain Hint / User Name Suffix Hint | Email-domain suffix that triggers showing this provider's button (comma-separated for multiple) |
| Assign to All Tenants | Global-Admin-only; makes the provider available on other tenants' login pages |
| Client ID / Client Secret | OAuth client credentials registered at the provider |
| Authority | OIDC issuer base URL, e.g. Azure: `https://login.microsoftonline.com/{tenant}/v2.0` |
| Azure Directory (Tenant) Id | Azure-only GUID |
| Redirect URI | Read-only, generated; must be registered at the external provider |
| Callback Path | Read-only, fixed per provider type; final path segment of the redirect URI |
| Scopes | Space-separated OIDC scopes; `openid` is required/pinned; default set is `openid profile email`; removing `openid` or adding unknown scopes breaks sign-in |
| Group Name | The tenant group first-time external users land in (used with migration) |

Sign-in behavior settings per provider: **Use This Provider** (enable/hide), **Login Behavior** (`Show provider buttons` / `Go directly to this provider` / `Go directly to this provider with Silent Windows SSO`), **Force Login Prompt**, **Remember Login for SSO**, and **Support Migration** — explicitly noted as **not implemented**: "This flag is only marked and not implemented — first-time external users are created regardless of this setting."

**Claim Mappings**: rename an external claim (e.g. `employee_id`) to a local claim name (e.g. `user_id`) the SCExpert app expects. Reserved local claim names that cannot be reused as mapping targets:
- Roles/groups: `role`, `role_type`, `group`
- Tenant: `tenant_id`, `tenant_name`, `user_admin_tenant_id`
- Identity/profile: `sub`, `name`, `given_name`, `family_name`, `preferred_username`, `email`, `email_verified`
- Federation/session: `employee_id`, `client_id`, `idp`, `amr`, `auth_time`, `sid`, `nonce`
- Standard JWT: `iss`, `aud`, `exp`, `nbf`, `iat`, `jti`
- ASP.NET Identity/policy: `AspNet.Identity.SecurityStamp`, `PasswordChangeRequired`, `EnrollmentRequired`, `PasswordExpired`

**Notably NOT reserved: `warehouse`** — an external IdP can supply this claim to drive the user's warehouse assignment; during login the IdP value is treated as the **source of truth** and syncs the user's warehouse assignments `[managing-tenants]`.

**2.3 How an application registers (Applications).** Applications are the OIDC **relying parties/clients**. Created under **Applications**, scoped to a tenant. Fields/tabs, exact as documented `[managing-applications]`:
- **Application ID** (custom or random-generated), **Application Name**, **Description**, **Application template**.
- **General**: `Enabled`; `Protocol type` (always shows "OpenID Connect"); `Require Application Secret`; `Require Request Object`; `Require Pkce`; `Allow Plain Text Pkce`; `Allow Offline Access` (refresh tokens); `Allow Access Token Via Browser`; `SCIM SYNC` toggle + optional per-application SCIM URL (falls back to system-wide default SCIM URL if blank; a warning is shown if SCIM is enabled with no URL configured anywhere).
- **Roles**: application-scoped custom roles, or attach existing IAM roles; roles end up in the user's JWT at login.
- **Groups** / **Users**: assign groups/users to the app, then assign per-app roles to each; users can be invited by email with a direct app link.
- **Redirect Uri**: `Local Login` enable/disable (local accounts vs external-IdP-only), `Redirect Uris` list, `User SSO Lifetime`.
- **Token**: `Identity Token Lifetime`; `Allowed Identity Token Signing Algorithms` (defaults to server default if empty); `Access Token Lifetime`; `Access Token Type` (**Reference token** or **self-contained JWT**); `Absolute Refresh Token Lifetime`; `Sliding Refresh Token Lifetime`; `Refresh Token Usage` (**Can be reused** / **One-time-only**); `Refresh Token Expiration` (**Absolute** / **Sliding**); `Update Access Token Claim on Refresh`; `Include Jwt Id`; `Always Send Application Claims`; `Always Include User Claims in Id Token`; `Application Claims Prefix` (default `Application_`); `Pair Wise Subject Salt`.
- **Scopes**: allowed scopes selected from configured API/Identity scopes — "By default, an application has no access to any resources."
- **Grant Types**: e.g. Implicit, Client Credentials, Hybrid — freeform or from a suggested list.
- **Claims**: static app-level claim type/value pairs added to issued tokens.
- **Properties**: free key/value pairs (e.g. `appType=mobile`); also used functionally for webhook scoping (`webhook_tenants=*`, see §2.5) and for application-level AD server overrides (see §2.6).
- **Secrets**: `Secret Type`, generated `Secret Value` (shown once), `Hash Type` (SharedSecret only), `Expiration`, `Description`.
- **Cors**: allowed CORS origins list.
- **LogoutUri**: `Front Channel Logout Uri` (+ session-required flag), `Back Channel Logout Uri` (+ session-required flag), `Post Logout Redirect Uris`.
- **Consent**: `Require Consent` (default true), `Allow Remember Consent` (default true), `Application Uri`, `Logo Uri`.
- **MFA Exception**: per-IP MFA bypass list.

**2.4 Users / Roles / Groups / Access Policies (summary).**
- **Users**: username must be unique per tenant (same username *can* repeat across tenants); creation via self-onboarding email invite, or manual (with generated/typed password, optional forced change on next login). Assignable: Warehouses, Groups, Roles, Claims. Lockout can be permanent or time-boxed; Force Logout ends active sessions immediately.
- **Roles**: simple name; can carry claims; can define a custom navigation menu per role.
- **Groups**: users inherit the group's roles and claims; a `warehouse` type claim on a group populates from the tenant's warehouse catalog plus global predefined values.
- **Access Policies** — tenant- (or Global-Admin cross-tenant-) scoped conditional-access rules, evaluated as a two-phase engine: (1) Applicability — based on Users/Groups/Applications assignment (None/All-with-exclude/Specific-with-include) plus Conditions (Network CIDR ranges via Network Resources, Geo Location via an offline MaxMind GeoLite2 database that Global Admins must upload); (2) Enforcement — **Block Access** (overrides everything) or **Grant Access** with optional `Require MFA`, password-policy override, and session duration/re-authentication settings. Multiple applicable policies combine with **AND** logic; most-restrictive wins. Policies start `Off`, can run in `Report Only` (evaluated, logged, not enforced) before going `On`. Evaluation logs record decision, outcome, IP/country, and which policy decided `[managing-access-policies]`.

**2.5 Webhook management.** Purpose: notify external systems in real time when Users/Groups/Tenants change in IAM, instead of polling. Full developer flow, exact as documented `[webhook-management]`:

1. **Enable on tenant**: Tenants → Webhook Configuration → toggle `Webhooks Enabled`, pick entity types (`Tenant`, `Group`, `User`).
2. **Register a consumer application** (Applications): grant type `client_credentials` (M2M), scope **`webhook_consumer_api`**, a client secret. Optional Properties key `webhook_tenants=*` makes the consumer receive events for **all** tenants (default is scoped to its own tenant).
3. **Authenticate**: `POST https://{iam-server}/Softela.STS/connect/token` (`application/x-www-form-urlencoded`) with `grant_type=client_credentials&client_id=...&client_secret=...&scope=webhook_consumer_api` → `{ "access_token": "...", "expires_in": 3600, "token_type": "Bearer" }`. Tokens expire after 1 hour by default.
4. **Subscribe**: `POST https://{iam-server}/Softela.Identity/api/webhook-subscription` with Bearer auth. Body: `callbackUrl` (required, HTTPS), `entityFilter` (comma-separated `User,Tenant,Group`, empty = all), `maxRequestsPerMinute` (0 = unlimited), `burstSize` (default 10). Response (200): `{ subscriberId, clientId, callbackUrl, entityFilter, tenantId, keys: { hmacKey, encryptionKey } }` — **keys are regenerated on every subscribe call**; consumer must store them for verifying/decrypting every delivery. Error codes: `401` invalid/expired token, `403` deactivated subscriber or missing scope, `400` invalid request.
5. **Receive events**: IAM POSTs to the consumer's `callbackUrl` with headers `X-Webhook-Id`, `X-Webhook-Signature: sha256=...`, `X-Webhook-Timestamp`, and a JSON array body of `{ entityType, entityId, changeType, payload }` where `changeType` is `0=Created, 1=Updated, 2=Deleted`.
   - **HMAC verification** (mandatory before processing): signature = `HMAC-SHA256(hmacKey, "{timestamp}.{raw_body}")`, hex-encoded, prefixed `sha256=`; also reject if `|now - timestamp| > 5 minutes` (replay protection). Sample code given in C#/Node/Python.
   - **Idempotency**: dedupe on `X-Webhook-Id`.
   - **Password sync events**: only events with `passwordChanged: true` carry `systemEncryptedPassword: { ciphertextBase64, ivBase64, authTagBase64 }`, decrypted with **AES-256-GCM** using the `encryptionKey` from the subscribe response. Used e.g. to push IAM password changes to Active Directory.
6. **Report sync status** (optional): `POST .../Softela.Identity/api/webhook-subscription/sync-status` with a list of per-event `{ entityType, entityId, tenantId, changeType, status, processedAt }`.

Delivery/ops model: **outbox pattern** with states Pending → Processing → Delivered/Failed; failed-after-max-retries events move to a **Dead Letter Queue** (viewable/retryable/deletable in the UI); a **Subscription Audit** tab logs subscribe attempts and failure reasons; admins can activate/deactivate/edit (rate limits; `Entity Filter` is read-only, consumer-set) or delete subscribers from **Webhook Management**.

Technology reference explicitly cited: OAuth 2.0 Client Credentials (RFC 6749), HMAC-SHA256 (RFC 2104), AES-256-GCM (NIST SP 800-38D), HTTPS/TLS, outbox pattern, dead letter queue.

**2.6 Active Directory authentication.** Two configuration levels, application-level always wins:
- **Application-level** (Application → Client Properties): fields `AD_SERVER_ADDRESS` (host[:port], e.g. `dc1.company.com:636`), `AD_BASE_DN` (e.g. `DC=company,DC=com`), `AD_DOMAIN_SUFFIX` (optional, e.g. `@company.com`), `SECURE_SOCKET_LAYER` (bool), `AD_USERS_2FA_REQUIRED` (bool).
- **Organizational/tenant-level** (Tenant → Active Directory): `Name`, `Server Address`, `Port` (default 389; 636=LDAPS, 3268=Global Catalog), `Domain FQDN`, `Base DN` (auto-generated from FQDN if blank), `Use SSL` (default true), `Is Enabled`, `Priority` (0=highest, tried first), `Connection timeout` (default 30s), `Require AD Authentication` (default false; if true, non-AD users are blocked for the tenant).

Login decision flow, exact as documented: (1) if the user already exists locally, use local auth only; (2) else try application-level AD if configured; (3) on failure/absence, try tenant-level AD server(s) in priority order; (4) on success at any AD step, the user is auto-created ("migrated") locally with data pulled from AD (username, email, phone), linked to the tenant that authenticated them, and assigned default groups/roles per configuration. AD password is checked against local password policy during migration — a mismatch fails migration even though AD auth succeeded `[appendix-1-ad-authentication]`.

**2.7 SCIM.** Referenced but not deeply documented: applications can enable `SCIM SYNC` and either use a per-application SCIM URL or fall back to the system-wide default SCIM URL, for provisioning users out to external identity stores (e.g. different apps into Okta vs Azure AD) `[managing-applications]`. Deployed service name per the URL rename table: **`Softela.SCIM`** (formerly `SCIM`) `[installation/appendix-a-url-name-updates]`. UNVERIFIED: no dedicated SCIM protocol/endpoint documentation page exists in this capture.

**2.8 Email/SMS + IAM installation.**
- **Email/SMS config** is global (Global Admin, IAM Configuration section), applies across all tenants: general email provider (Company Name/Contact), an **Email Gateway provider** config (Base URL, Client ID/Secret, Scope, Identity Server Base URL, Timeout, "Ignore SSL errors — for test environments only"), and SMS provider = Twilio or AWS-SNS with API key/secret `[configuring-email-and-sms-settings]`.
- **IAM installation**: standard ASP.NET Core app; installer `Softela.IdentityPlatform.exe` from the Support Portal. Requires Windows Server 2025 (or earlier) + IIS 10+, .NET Core 8.0 (auto-installed), MS-SQL 2025 (or earlier). CPU/RAM scale table by user count (10-50 users → 1 CPU/4GB, up to 360-500 → 16 CPU/64GB; beyond that, contact Softela support). **A valid signing certificate is required** — obtained from a CA, private key installed in the local certificate store, public key placed in a shared folder referenced from app settings. Softela Identity uses the certificate to build an asymmetric key pair for JWT signing; supported algorithms: **RS256, RS384, RS512, PS256, PS384, PS512, ES256, ES384, ES512** (both RSA and ECDSA certs supported) `[appendix-2-iam-installation-guide]`. Post-install URL: `your-server/IAMMANAGEMENT`.

### 3. Integration patterns (generalized across BCD365, Shopify, Email Gateway, Remote Printing)

SCExpert exposes several distinct, reusable integration mechanisms; the BCD365/Shopify guides are two concrete instances of the *same* plugin pattern.

**3.1 SCExpert Connect plugin pattern (BCD365, Shopify).** A pluggable integration host ("SCExpert Connect") runs named **plugin instances**, each bound to one direction (Import or Export) and one data entity, per vendor integration — this is the plugin/XSLT mechanism referenced from [[wms-domain-primer]] §3. Common shape:
- **Import plugins** run in two modes concurrently: (a) a **delta sync / catch-up** on startup driven by a `SyncMode`/timestamp flag that pages through everything changed since `LastSyncTimestamp` (or, for Shopify, a polling `Import Time Interval` + `Last Run Time`), and (b) for BCD365 specifically, a **webhook listener** — the plugin registers a webhook with the external system (`ListenerUrl` internal bind address + publicly reachable `NotificationUrl`) and a `NotificationListenerService`/`ImportProcessorService` fetches and processes the changed record on push notification. Shopify import plugins are polling-only (no inbound webhook mentioned).
- **Export plugins** follow a **direct push model** driven by SCExpert domain **events** (e.g. "Receipt Closed", "Order Shipped"), registered per plugin via an `EVENTS`/`EVENTREGISTRATION` table mechanism: event → XML message → SCExpert Connect invokes the plugin → **XSLT translation file** transforms SCExpert XML into the target API's format → an `ApiService`/`ExportProcessorService` calls the external REST API → optionally a follow-up "Post"/commit call finalizes the document in the external system (`InvokeBCDPostDocument` for BCD365).
- **Auth to the external API** is per-integration: BCD365 supports `AuthMode = Onprem` (username/password) or `Cloud` (OAuth 2.0 client credentials against Azure AD — `CloudClientID`, `CloudClientSecret`, `CloudTokenUrl` e.g. `https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token`, `CloudScope`, `CloudGrantType`); Shopify uses `API Key`/`API Password`/`API Secret` + store URL + `API Version`.
- **Transaction Keys** define the upsert primary key used during import (same create-or-update-by-key idea as the WebAPI's POST semantics in §1).
- **Content filters**: separate Import/Export "Transaction Content Filter" settings exclude specific transactions/statuses/line-types from being synced, applied after transform (import) or before transform (export).
- **Partial-failure handling**: `Commit BO on BO Element Failure` (Yes = import good lines, skip bad ones; No = all-or-nothing per document) — this is the closest thing to a documented error-handling policy for these plugins.
- **Mapping is entirely XSLT-driven** and file-path-configured per plugin instance; Softela ships baseline XSLTs per entity (tables of entity↔entity↔filename mappings are in each guide, e.g. `BCD365ImportItems.xslt`, `ShopifyImportProducts.xslt`, `ExportInventoryLevelToShopify.xslt`).
- Alerting: `Alert Process Result` (`None`/`On Error`/`Always`) + `Alert Recipient` email, per plugin instance.

Generalized pattern: **plugin-hosted, XSLT-mapped, event-triggered push for export; poll-or-webhook pull for import; per-instance config table; REST to the external vendor API; OAuth2 or basic creds depending on vendor.**

**3.2 Email as a shared platform service (Email Gateway).** Not a per-integration plugin but a **shared, decoupled service**: a single Email Send REST API used by *all* Softela applications (`Softela.email/swagger` per install), fronting swappable email providers configured centrally per tenant in the Email Gateway Admin app — "provider configurations can be updated without requiring any changes to the applications that call the Send Email API." Supports multi-tenant and single-tenant deployments. Client apps authenticate against **Softela Identity** to get a token, then call the Email Send API with that token (machine-to-machine) `[email-gateway-admin-application]`. This is a distinct integration mechanism from the plugin pattern: **service API + centralized provider config**, not XSLT/event plugins.

**3.3 Remote printing (client/agent pattern).** A different mechanism again: a **locally installed client/agent** ("Remote Printing Client") running on a PC at a remote site, which maintains a secure outbound connection to SCExpert (so it works even when the remote printer's network isn't reachable from SCExpert directly). Flow: Admin creates a **Print Client** record in SCExpert (Setup → Reports and Labels → Print Client Tokens), which generates a **Print Client ID + one-time Token + Print Client Key**; the token is shareable exactly once (copy disables it; must Refresh to regenerate if lost). The remote-site user installs the client app, enters the ID/token to activate/connect, adds printers (auto-registers them into SCExpert), and printers are then assignable per warehouse to Label Types / Report templates / individual users as default printers `[remote-printing/*]`. Pattern: **credentialed agent pull/connect model**, token-based, one Print Client → many warehouses → many printers.

**3.4 Summary of mechanisms found:**

| Mechanism | Direction | Trigger | Transport | Auth |
|---|---|---|---|---|
| SCExpertWebAPI | Both (external system calls SCExpert) | On-demand REST calls | HTTPS REST, XML-ish JSON envelopes | Basic Auth (documented for test; production method UNVERIFIED) |
| SCExpert Connect plugins (BCD365/Shopify) | Both (SCExpert-initiated) | Import: poll/delta-sync or inbound webhook; Export: SCExpert domain event | HTTPS REST to vendor API + XSLT transform | Vendor-specific (OAuth2 client-credentials or basic) |
| Email Gateway | Outbound (send only) | App calls Send Email API | HTTPS REST | Softela Identity Bearer token (M2M) |
| IAM Webhooks | Outbound (IAM → subscriber) | Entity CRUD in IAM | HTTPS POST + HMAC-SHA256 signed, AES-256-GCM for password payloads | OAuth2 client_credentials (`webhook_consumer_api` scope) to get token; HMAC to verify deliveries |
| Remote Printing | Outbound (SCExpert → remote printer via client) | Print job triggered in SCExpert | Client-initiated persistent connection | Print Client ID + one-time token |
| Message queue (RabbitMQ/MSMQ) | Internal (SCExpert services ↔ each other) | Domain events, e.g. "Sku Bom Updated" | AMQP (RabbitMQ) or MSMQ | RabbitMQ user/pass (`RabbitMq.UserName`/`.Password`, encrypted) |

### 4. Deployment / installation shape

**4.1 Component inventory** (from the URL-rename appendix — read as a map of deployed services) `[installation/appendix-a-url-name-updates]`:

| Current deployed name | Former name | Role |
|---|---|---|
| `Softela.RemotePrint` | RemotePrintWS | Remote print service |
| `Softela.SCIM` | SCIM | SCIM provisioning endpoint |
| `SCExpert.Logic` | Softela.Legacy | Core legacy business logic |
| *(removed)* | Softela.SCExpert.LogicWebApi | retired |
| `SCExpert.Warehouse` | Softela.Warehouse | Warehouse API/service |
| `Softela.Infra` | Softela.Infra | Infra API (shared/base services) |
| `SCExpert.MobileBFF` | Softela.BFF | Backend-for-frontend for mobile |
| `SCExpertMobile` | RDTNG | Mobile terminal app (React) |
| `EmailManagement` | EmailGateway | Email admin app |
| `Softela.EmailGateway` | Softela.Email | Email send service |
| *(removed)* | IdentityServerAdmin | retired |
| `Softela.Identity` | IdentityServerAdminAPI | Identity admin API |
| `Softela.STS` | IdentityServerSTS | Token/STS endpoint |
| `IAMmanagement` | IAMmanagement | IAM management UI (name unchanged) |
| `Softela.License` | Softela.LicenseManager | License server |
| `SCExpertCustomerAccess` | CustomerAccessNG | Customer-facing portal |
| `ApplicationBuilder` | ApplicationBuilder | App Builder (screen/app designer, name unchanged) |
| `SCExpertWebAPI` | SCExpertWebAPI | The public Web API (§1), name unchanged |
| `SCExpertDataServiceAPI` | SCExpertDataServiceAPI | Data service API, name unchanged |
| `SCExpertDriver` | DeliveryExpert | Driver-facing app |
| `SCExpertDriverBFF` | DeliveryExpertAPI | BFF for driver app |

**`Softela.Infra` in this table is the `Softela.SCExpert` backend repo** (formerly `Softela.Infra.Api`, see [[backend-architecture]]) — the codebase behind this deployed service. The internal wiki has a page **"How to DEBUG Softela.Infra – NG"** relevant to this same component.

This table is a strong signal of an active **rename/re-platforming effort** (legacy `Softela.*`/`IdentityServer*` names being replaced by `Softela.*`/`SCExpert.*`), i.e. treat any `Softela.*` or `IdentityServer*` name seen elsewhere in old code/tickets as the *former* name of one of the above.

**4.2 What the installer actually wires together.** Single installer (`SCExpert_X.X.X_Installer.zip` / hotfixes) with a feature-selection step ("Custom Setup") that lets you choose per-server which components to install — implying a **multi-server topology is normal**: "run a separate installation on each server... select only the features relevant for that specific server." If License Server, Identity Platform, or Email Gateway are *not* installed on a given server, the installer prompts for the **external Server URL** where each lives instead `[installation/installing-scexperttm]`.

Dependencies wired during install:
- **Database**: MS-SQL server/instance, with separate DBs for: System DB, Warehouse DB, Identity Platform DB, Email Gateway DB (each definable/pointed elsewhere), SQL login created or validated, collation chosen once and must match across future DB additions.
- **License Server**: separate service; needs its own IP/port (`sys_param` table: `licenseserver`, `licenseserverport`, `licenseserverURL`); SCExpertMobile/Customer Access/SCExpert all depend on reaching it over the network — **SCExpertMobile React specifically requires License Server 25.3+ AND must use the same Identity service as the license server** (stated twice, in system-requirements and installing-scexperttm — a real interop constraint, not boilerplate).
- **Identity Platform**: as in §2.8; can be local or remote (URL prompt if remote).
- **Email Gateway**: installed automatically with SCExpert (per `[email-gateway-admin-application]`), but can also be pointed at a remote instance.
- **Message Queue**: either **MSMQ** (Windows feature, requires reboot to install — can abort the installer mid-flow) or **RabbitMQ** (external, install separately first — see §4.3), chosen at install time; local or remote IP.
- **React front-end wiring**: installer asks for Base URL + Endpoint for three React-facing services: **Infra API**, **BFF**, **Warehouse API** — "default endpoints are preconfigured and should not be modified for a standard installation... modify only if bypassing the BFF service or using custom API URLs."
- **IIS**: default website must have a valid SSL cert on port 443; URL Rewrite module required specifically **for the React applications**.

**4.3 Message queue layer (RabbitMQ or MSMQ).** RabbitMQ is the modern option (MSMQ is legacy/being phased toward RabbitMQ per the "Note: To install RabbitMQ instead..." framing). Requires Erlang first (27.3.4), then RabbitMQ 4.0.9. Config lives in `sys_param`-style keys, notably: `RabbitMq.Enable` (0=disabled→falls back to MSMQ, 1=enabled), `RabbitMq.HostName` (default `localhost`), `.Port` (default 5672, management UI 15672), `.UserName`/`.Password` (password Softela-cryptography-encrypted), `.VirtualHost`, `.DeliveryLimit`, `.MessageTimeToLiveMs`, `.NackDelayMs`, `.RecoveryAttempts` (default 15), `.RecoveryIntervalSec` (default 30), plus `.EnableLogging`/`.EnableSeq`/`.LogLevel`. Observed a real internal exchange name in a trace example: **`eventmanager_exchange`** routing to queue **`eventmanager`**, carrying domain-event messages like `"label": "Sku Bom Updated"` — confirms internal service-to-service messaging (not just an integration feature) rides this same broker `[installation/installing-rabbitmq-on-windows]`.

**4.4 Component diagram (in words):**
```
                         ┌─────────────────────────┐
 External vendor APIs ── │  SCExpert Connect        │ ── XSLT-mapped plugins
 (BCD365, Shopify, ...)  │  (Import/Export plugins) │    (§3.1)
                         └───────────┬──────────────┘
                                     │ domain events / DB
                         ┌───────────▼──────────────┐        ┌────────────────┐
  Browser (React) ─────► │  SCExpert.Warehouse /     │◄──────►│  MS-SQL:        │
  SCExpertMobile (React) │  SCExpert.Logic (core)    │        │  System DB,     │
  App Builder            │  + SCExpertWebAPI (§1)    │        │  Warehouse DB   │
                         └───┬─────────┬─────────┬───┘        └────────────────┘
                             │         │         │
                 ┌───────────▼──┐  ┌───▼─────┐ ┌─▼──────────────┐
                 │ Softela.Infra│  │SCExpert.│ │ RabbitMQ / MSMQ │
                 │ (Infra API)   │  │MobileBFF│ │ (§4.3)          │
                 └───────────────┘  └─────────┘ └─────────────────┘

                 ┌──────────────────────────────────────────────┐
                 │  Softela Identity Platform (Softela.IdentityPlatform) │
                 │  Softela.STS (token) · Softela.Identity (admin API) │
                 │  IAMmanagement (UI) · Softela.SCIM               │
                 │  own Identity DB, own signing cert                │
                 └──────────────────────────────────────────────┘
                     ▲ all apps authenticate here (OIDC) ▲

 Softela.License (License Server) ◄── every app checks in (esp. Mobile/Customer Access)
 Softela.EmailGateway (send API) + EmailManagement (admin UI) ◄── called w/ Identity token
 Softela.RemotePrint ◄── Print Client agents at remote sites (§3.3)
 SCExpertCustomerAccess, SCExpertDriver/SCExpertDriverBFF ◄── separate client-facing apps, same Identity/License backbone
```

Every app-facing component (SCExpert core, Mobile, Customer Access, Driver, Email Gateway, App Builder) is a **separate deployable that authenticates against the one shared Identity Platform** and checks in with the one shared License Server — this is the load-bearing fact for bug triage: **a login/token bug is almost never "in" the app itself — it is in Softela.STS/Softela.Identity or in the app's registered client/redirect config**, and **a "can't use the app" bug can be a License Server connectivity issue** distinct from either.

### 5. Security-relevant statements (as documented — not inferred)

- **JWT signing**: Identity Platform requires a real signing certificate (CA-issued or self-signed), private key in the certificate store, public key in a shared folder referenced from app settings. Supports RSA and ECDSA; algorithms RS256/RS384/RS512/PS256/PS384/PS512/ES256/ES384/ES512 `[appendix-2-iam-installation-guide]`.
- **Application secrets**: shown once at generation ("make sure to copy it, you cannot retrieve the secret value afterwards"), have an expiration date `[managing-applications]`. Same one-time-reveal pattern for API Resource secrets `[managing-api-resources]` and Remote-Printing Client tokens (copy disables further copying; must Refresh to regenerate) `[remote-printing/generating-remote-printing-client-id-and-token]`.
- **Webhook payload security**: HMAC-SHA256 signatures (`X-Webhook-Signature`) over `{timestamp}.{raw_body}`, verified with a per-subscription `hmacKey`; a 5-minute timestamp window is enforced as replay protection; passwords inside password-sync events are additionally encrypted with AES-256-GCM using a separate `encryptionKey`; **both keys are regenerated every time the consumer re-subscribes** (e.g. on restart) `[webhook-management]`.
- **Tenancy isolation**: each tenant has "its own isolated environment of users, roles, groups and applications" `[iam-application-overview]`. Warehouses, Audit, Error Logs and webhook event delivery are all tenant-scoped by default (a Tenant Admin sees only their tenant's data; Global Admin sees across tenants). Webhook subscribers are tenant-scoped by default and must be explicitly widened via the `webhook_tenants=*` application property to go cross-tenant `[webhook-management]`, `[tracking-audits-and-error-logs]`.
- **Access control conditions**: Access Policies can gate login by network CIDR range and by country (via an offline MaxMind GeoLite2 database that must be uploaded/kept updated by a Global Admin) — i.e. no live geo-IP API call, a local DB lookup `[managing-access-policies]`.
- **Password policy** exists at two levels (Tenant-level and Access-Policy-level) with an explicit precedence rule: **tenant-level password policy overrides the access-policy-level one** if both are configured `[managing-access-policies]`.
- **MFA**: tenant-level "Require MFA for all users" setting **overrides** the per-user MFA preference; if disabled at tenant level, the per-user setting is honored `[managing-tenants]`. Access Policies can separately force MFA per policy, with the same AND-combination rule as other policy controls.
- **AD credential handling**: encouraged (not enforced by product logic) to "Always use SSL/TLS in production environments" for AD/LDAPS traffic — this is guidance prose in the doc, not a hard product constraint `[appendix-1-ad-authentication]`.
- **SCExpertWebAPI auth**: only Basic Auth is documented (test/Postman context, admin user credentials typed directly into the client). No token-based/OIDC flow is described for this specific API in these pages — UNVERIFIED whether production deployments front it differently (e.g. with a reverse proxy enforcing OIDC, or client-cert, etc.); the docs simply don't say.
- **RabbitMQ credentials**: password stored "encrypted using the Softela cryptography library" in `sys_param` (`RabbitMq.Password`) — no further detail on the cipher used given here (unlike the AES-256-GCM/HMAC-SHA256 specifics given for webhooks) `[installation/installing-rabbitmq-on-windows]`.

### 6. Version and staleness signals

- **SCExpert product version referenced throughout**: **25.3** — API doc folder `scexpertwebapidoc-25-3`, "This was tested on version 25.3 and higher" (WebAPI guide), "SCExpertMobile React ... License Server 25.3 and above" (system requirements, and repeated in the installer guide). Treat 25.3 as the current baseline version this whole capture describes — same baseline as the "25.3/26.x" line noted in [[product-config-model]] §8.
- **Explicit "new in latest release"**: the Shopify `SKU Mapping` plugin parameter (`Product` vs `Variant` mode) is called out as newly introduced — "In the latest SCExpert release, a new plugin parameter SKU Mapping has been introduced" `[shopify-and-scexpert-integration-mode]`. Variant-based mapping is explicitly labeled **Recommended**; Product-based mapping is explicitly labeled **Legacy**.
- **Explicit "removed"/retired components**: `Softela.SCExpert.LogicWebApi` and `IdentityServerAdmin` are marked **removed** outright in the URL rename table, not just renamed — treat any reference to these two names in old code/tickets as dead `[installation/appendix-a-url-name-updates]`.
- **Explicitly not implemented**: the "Support Migration" checkbox on External Providers — documented as inert: "This flag is only marked and not implemented - first-time external users are created regardless of this setting" `[managing-tenants]`. Do not trust this checkbox's state when debugging migration behavior; behavior is unconditional.
- **Version/date markers seen in example payloads**: several JSON examples show dates in 2026 and 2027 (e.g. `CREATEDATE: "2026-04-28..."`, `LASTCOUNTDATE: "4/26/2027..."`) — these are clearly synthetic demo-data timestamps from the test/demo warehouse database referenced in the WebAPI guide ("tested against the SCExpert demo warehouse database"), **not** evidence of forward-dated features; do not over-read them.
- **Deprecated legacy naming actively in flux**: the entire `Softela.*` → `Softela.*`/`SCExpert.*` rename (§4.1) is presented as already-applied ("The URLs used in the system have been updated") but the doc still needs to exist specifically to reconcile old vs new names — meaning plenty of internal references (config, code, tickets) likely still use the old names. Old names are UNVERIFIED to be fully purged anywhere outside this table.
- **Workstation/browser requirements pinned to specific builds**: "Microsoft Edge version 142 and above OR Google Chrome 142.0.7444.59/60 and above" — unusually precise pinned versions, worth noting as a signal these docs are tied to a narrow, recent support matrix, not general "modern browser" language `[installation/system-requirements]`.
- **Windows Server / SQL ceiling stated as "and earlier versions"**: multiple install docs cap supported platforms at "Windows Server 2025 and earlier" and "MS-SQL 2025 and earlier" — phrased as an upper bound, i.e. newer-than-2025 platforms are UNVERIFIED/not yet certified as of this capture.

### Gaps explicitly called out (do not assume answers)

1. SCExpertWebAPI production authentication scheme beyond Basic Auth — UNVERIFIED.
2. SCExpertWebAPI paging — not mentioned; likely N/A since GET returns single objects, but no collection-listing endpoint was seen in any of the 8 pages to confirm either way.
3. SCExpertWebAPI HTTP error-code conventions — not documented; only the `MessageProcess`/`TransactionProcess` boolean-flag convention is shown, and always alongside "200 OK".
4. SCIM protocol details (endpoints, schema) — referenced by name/config toggle only, no dedicated page in this capture.
5. Whether "v1" in the WebAPI guide title reflects a real versioning scheme or is just the current doc's label — no second version is referenced anywhere to compare against.
