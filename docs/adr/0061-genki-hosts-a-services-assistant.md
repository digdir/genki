# 0061 genki hosts a service's assistant

Status: proposed, 2026-11-19

Left: a logo and other images in a hosted assistant; a host's own `x-` blocks (ADR 0065) in the generic host, which draws only catalogue blocks; and production Ansattporten, which #464 decides. Each needs its own change.

## Context

A service's end users need an assistant on a web page. Today a service owner who wants one writes and runs a web app, as Kunnskapsassistenten does: a client and a BFF in one container in the owner's own Container Apps environment, one replica with tokens in process memory, a confidential Ansattporten client with its secret as a Container Apps secret, and a custom domain with a managed certificate bound by hand. Its backend already runs on genki as a service.

genki has the parts for a hosted assistant but no host. `@genai/ui-assembly` draws an assistant from a layout (ADR 0054), ADR 0065 proposes to store the layout in the service definition as `spec.interface` and leaves the read route, the theme, the menu and pages to later records, a Client registers a frontend and maps its Ansattporten client id to one service (`clientRegistry` in `apps/api/src/frontends.ts`), and ADR 0034 requires a BFF before real people log in. genki serves four fixed apps (`api`, `portal`, `workspace`, `console`) from one apps image (`docker/apps`, chosen by `APP`), on hostnames set in `infra/main.bicep`.

## Decision

### One generic host, and frontends that run elsewhere

- **genki runs one generic assistant host.** It is a fifth app in the apps image, `APP=assistant`, deployed as its own container app (`${baseName}-assistant`) in an environment of its own, with an identity of its own that has no right on genki's Key Vault or Postgres (ADR 0062). It serves every hosted hostname. For a request it looks the `Host` up, and draws the service that hostname belongs to, with the interface of the version the hostname's environment runs (ADR 0065, ADR 0064). An unknown hostname gets a plain 404 page and no login.
- **A hosted assistant is configuration, not code.** A service, a published `spec.interface`, a Client with `spec.hosted: true` and its hostnames, and DNS records. No build and no image per service. A hostname is an entry in the environment's parameter file and a deploy for now, and a self-service claim later (ADR 0062).
- **The host draws only catalogue blocks, and the service's theme, menu and pages.** It draws the layout through `@genai/ui-assembly`, the theme from ADR 0063, and the menu and pages below. It runs no code from the service owner.
- **A service that needs its own frontend code runs it itself.** It runs its own container in its own Azure (or anywhere), and registers it as a genki frontend: a Client of kind `browser` with bearer tokens, as today (ADR 0032), or `server` with a service key. genki runs no team's container in its own Container Apps environment.
- **No Front Door.** Custom hostnames bind to the host container app with free managed certificates (ADR 0062). Apex names use the environment's static IP.

### The host's configuration

- **A Client registration says it is hosted.** `spec.hosted: true` on a Client of kind `browser` makes it a hosted frontend: it needs `oidc` and at least one hostname, and its `allowedOrigins` are its hostnames' origins, kept in step by the API. A Client has at most one service, as today, so a hostname draws exactly one service.
- **`GET /v1/hosts/{hostname}` is public.** It answers what the host needs before anyone logs in: the tenant, the service, the environment, the issuer and the OIDC client id to log in with (not the Client's registration id), the assistant's name, the theme's stylesheet address and the menu and page titles. It answers no secret, no layout zones and no profile, and the same `404` (`urn:genai:problem:host-not-found`) for every hostname that is not active, so the answer does not tell why. The host may cache it for 60 seconds, so a removed or lapsed hostname may still draw its page for up to a minute; no session call succeeds in that minute, since the API checks the hostname on every session request.
- **The layout itself comes after login,** from `GET /v1/models/{id}/interface` with the person's session, so the layout keeps the access rules of the service. This record adds the route, which ADR 0065 leaves out: it answers the `spec.interface` of the version the caller's environment runs (ADR 0064), with the theme as its stylesheet address, to a caller that may invoke the service, and `404` to anyone else.

### The BFF

The BFF in ADR 0034 is built now, for the assistant host first. The portal, workspace and console move to it later under #41.

- **The BFF is in the API, under the host's origin.** The host's nginx proxies `/auth/` to the API's `/bff/auth/` and `/api/` to the API, and `/theme/` to the public `GET /v1/themes/{hash}.css` (ADR 0063), as the other apps proxy `/api/` today (`docker/apps/default.conf.template`). It adds `X-Forwarded-Host` and `GenAI-Proxy-Key`, a secret the host reads from a Key Vault of its own (ADR 0062). The API compares the key in constant time and trusts `X-Forwarded-Host` only with a valid key.
- **The routes are those Kunnskapsassistenten uses,** so its registered redirect URIs keep working: `GET /auth/login`, `GET /auth/callback`, `GET /auth/org` to show the choice of organisation and `POST /auth/org` to make it, and `GET /auth/logout`. Choosing an organisation changes the session, so only the `POST` does it, with the exact `Origin` of the hostname. A return address after login or a change of organisation is a path on the same hostname, starting with a single `/`; anything else returns to `/`. The redirect URI is `https://{hostname}/auth/callback`, and the post-logout URI `https://{hostname}/`.
- **The BFF is a confidential client per hosted frontend.** It runs the authorization code flow with PKCE, `state` and `nonce`, and the client's own `oidc.audience`, `resource` and `authorization_details` as the Client sets them. It authenticates with `client_secret_basic`, and `private_key_jwt` is added when an owner needs it.
- **The client secret is a tenant secret.** `spec.oidc.secret` on the Client names a tenant secret (ADR 0015), written through the write-only secrets API and bound to the issuer's token endpoint origin as its only allowed host. The owner rotates it: a new secret in Ansattporten's self-service, then `PUT` of the new value. genki never shows it.
- **Tokens stay on the server.** Sessions are rows in Postgres (`bff_sessions`): the session id hash, the hostname and client it was made for, the person's tokens sealed with the tenant's content key (as tenant secrets are), the chosen organisation, and the expiry, at most 8 hours. The BFF refreshes the access token with the refresh token a confidential client gets. Any API replica serves any session, so a restart or a new revision signs no one out.
- **Cookies are host-only.** `__Host-genki_session` is `HttpOnly`, `Secure`, `SameSite=Lax` and `Path=/`, and holds only the session id. The login's `state`, `nonce` and PKCE verifier sit in a sealed `__Host-genki_login` cookie for 10 minutes. The session id is new at every login.
- **A session works only on the hostname it was made for.** The API turns it into the same principal a bearer token from that client gives (confined to the client, ADR 0032), and refuses it when `X-Forwarded-Host` differs. On every request it reads the session and the hostname's state from Postgres with no cache, so a deleted session, a removed or lapsed hostname, or a Client no longer hosted stops the next call. A state-changing request through `/api/` needs the exact `Origin` of the hostname and a JSON body or a non-simple header.
- **Logout** deletes the session, revokes the refresh token and ends the Ansattporten session with `id_token_hint`.

### In lockdown

ADR 0033 lets a service-group login through only a client listed in `LOCKDOWN_SERVICE_CLIENT_IDS`, which takes a deploy to change.

- **A hosted Client passes lockdown by configuration.** In lockdown, a login through a Client with `spec.hosted: true` is treated as a login through a listed service client: the Client must be registered in `PLATFORM_TENANT`, and the login is confined to it, gets only `use-services` and is read-only, as ADR 0033 sets out. The API reads the Client from the database at each login, so admitting or withdrawing one needs no deploy.
- **In lockdown only a platform operator sets or clears `spec.hosted`.** It is the admin action `platform.client.hosted`, with a reason, in the audit log (ADR 0010). A tenant's own change to the Client cannot set it there. Outside lockdown the owner sets it as part of the Client.
- **`LOCKDOWN_SERVICE_CLIENT_IDS` stays** for service frontends that are not hosted, such as bearer-token frontends a team runs itself. A platform client (`OPERATOR_CLIENT_IDS`, `EMPLOYEE_CLIENT_IDS`) can never be hosted.

### Menu and pages

- **`spec.interface` gains `menu` and `pages`,** beside `layout` (ADR 0065) and `theme` (ADR 0063), within ADR 0065's 256 KiB for the whole interface. `menu` is a list of at most 12 items, each a label and either `page: <id>` or an `https` link. `pages` is a list of at most 12 pages, each an id, a title and a body in Markdown.
- **Texts are in each of the service's languages,** one string or `{ nb, en }` as ADR 0065 has them for the profile, so the host follows the person's language.
- **Markdown is drawn without HTML.** Raw HTML is dropped, links are `https` or `mailto` only, and images and embeds are drawn as links. A page is at most 32 KiB and all pages 128 KiB.
- **The host adds** a link to the settings block when the layout has it, the language choice, and «Logg ut».

### Thread continuity when a frontend moves to the host

- **A thread's owner is the tenant and `issuer|sub`** (`userKey` in `packages/conversations/src/routes.ts`). Ansattporten's `sub` is pairwise per client, as in ID-porten, so the same person gets the same `sub` only from the same client id.
- **A frontend that moves to the host keeps its Ansattporten client id.** Its Client registration becomes hosted, with the same `oidc.clientId`, and its people see their threads. A new client id gives everyone new owner keys.

## Why

A generic host makes a standard assistant a matter of configuration: the next service needs no web app, no Azure resources and no deploy, and a fix to the host reaches every service at once. Keeping custom frontends outside genki's environment keeps genki's network, identities and secrets free of code it did not review, and keeps ADR 0028 (custom logic comes from outside).

The alternatives, with what we found:

- **Only frontends that teams run themselves.** It is today's model. Kunnskapsassistenten shows the cost: its own resource group, environment, registry grant, identity, DNS zone, managed certificate and manual deploys, one replica because tokens are in memory, and a BFF with its own login code that each new service would copy. The next service owner would do it all again.
- **Only the generic host.** It leaves no room for a service whose interface the catalogue cannot draw. Bearer-token frontends are already built and cost genki nothing to keep.
- **Teams' containers inside genki's environment.** One place to run everything, but team code would share genki's network, egress and managed identities, and genki would carry the review, patching and incidents of code it does not own.
- **One host deployment per service.** Isolation between services' pages, but a deploy and a container app per service, which is what a host should remove. The host draws data, not code, so one deployment is enough.
- **The BFF as its own service, or in the host's container.** A separate service is one more thing to deploy, secure and scale, and the host's nginx image runs no application code. In the API, the BFF uses the session store, content keys, tenant secrets and token verifier that are already there.
- **The client secret as a Key Vault secret per frontend.** The API's identity would need to write Key Vault secrets at run time. Tenant secrets are already sealed per tenant, write-only and bound to hosts.
- **Moving thread owners to new keys at #464.** It would need a mapping from each old `issuer|sub` to the new one, which the pairwise `sub` does not give and genki would have to build from identity numbers it does not keep. The threads are test data, so they start fresh.
- **Menu links only, pages elsewhere.** Kunnskapsassistenten's onboarding, change log and about pages are its own Markdown today; without pages in genki a hosted service would need a second web site.

## Consequences

- KA becomes a service, an interface, a hosted Client with its current client id, a hostname per environment (ADR 0064) and DNS records. Its own app and the resources around it are retired once the swap is verified and the team agrees.
- A hosted frontend's people keep their threads only while it keeps its client id and issuer. A move to production Ansattporten (#464) changes both, so every person starts with no threads on every frontend. Nothing is in production yet and the threads are test data, so they are not moved. If real threads exist by then, a one-off migration script is prepared at #464: it records, for each login in a window before the switch, the old `issuer|sub` beside the keyed person id ADR 0060 derives from the identity number; at each person's first production login it finds the same person id and rewrites the owner of their threads, feedback and settings (`conversations.owner_hash` and the rows keyed the same way) from the old key to the new, per tenant, with an audit entry. Not built.
- ADR 0034 is built for the assistant host by this record; the portal, workspace and console keep `sessionStorage` until #41 moves them.
- ADR 0065's `spec.interface` gains `menu` and `pages`, and `GET /v1/models/{id}/interface` is built; its `Left:` drops them on acceptance. Its 256 KiB and texts per language already hold the pages.
- ADR 0033 gains the hosted Client as a second way past lockdown for service users. `LOCKDOWN_SERVICE_CLIENT_IDS` stays for service frontends that are not hosted.
- The apps image's CSP stays `script-src 'self'`; a hosted page loads no script, style or font from another origin, and Markdown links open in a new tab with `rel="noopener noreferrer"`.
- New settings: `GENAI_PROXY_KEY`, in genki's Key Vault for the API and in the host's own Key Vault for the host. The host's container app has `minReplicas: 1`, in its own environment (ADR 0062).
- Built in #832: `GET /v1/hosts/{hostname}` and `GET /v1/hosts/{hostname}/pages/{id}` (`apps/api/src/hosts.ts`), hostnames named by a frontend registration, `GET /v1/models/{id}/interface`, and `apps/assistant` with its `host.ts`, which draws the assistant from the public host answer. Not built: the login and the BFF with its sessions, the theme, the lockdown rule for a hosted Client, the secret management, and hostname self-service. The host's infrastructure and hostnames from the parameter file are built (ADR 0062). Tests to come with it: "an unknown hostname gets no login", "a session is refused on another hostname", "a forwarded host without the proxy key is not trusted", "a restart keeps a person signed in", "the client secret is sent only to the issuer's token endpoint", "logout revokes the refresh token", "a change of organisation by GET or from another origin is refused", "a return address that is not a same-origin path returns to /", "a removed hostname stops the next session call", "a page's raw HTML is dropped", "a hosted client with the same client id sees the threads it had", "in lockdown a hosted client passes without being listed", "in lockdown only a platform operator can mark a client hosted", "a hosted client outside the platform tenant does not pass lockdown".
