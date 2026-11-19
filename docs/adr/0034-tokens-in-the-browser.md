# 0034 Tokens in the browser

Status: proposed, 2026-10-16 (the BFF in the API, for the assistant host first, ADR 0061; built for the assistant host, 2026-11-19; until the host signs in through it, the assistant host keeps its token in `sessionStorage` on the same conditions)

## Context

The portal, workspace and console log in with Ansattporten in the browser, with the authorisation code flow and PKCE as public clients, and keep the session in `sessionStorage`. All three keep the access token, the refresh token when Ansattporten issues one, and the ID token (`apps/portal/src/oidc.ts`, `apps/workspace/src/oidc.ts`, `apps/console/src/auth.ts`). Before the access token expires they renew it with the refresh token, or without one by a `prompt=none` authorisation in a hidden frame of their own origin, unless the issuer's metadata leaves `none` out of `prompt_values_supported`. The console also renews once on a 401 and retries the request. All three ask for the same API audience, so a token from any of them carries the person's full rights in all of them. Anything that runs script in an app's origin can read the token and send it anywhere: the CSP limits which script runs, not where that script sends data.

A backend-for-frontend (BFF) keeps the tokens on a server and gives the browser only an HTTP-only session cookie, as Kunnskapsassistenten does (its ADR 0011).

## Decision

- **genki-test keeps tokens in `sessionStorage`,** on these conditions, which hold today and must keep holding:
  - The apps' CSP allows scripts from their own origin only, with no inline script and no `eval` (`docker/apps/headers.conf`), and every page except the System Atlas and `/callback` refuses to be framed. Only the app's own origin may frame those two, and `frame-src` allows only the app's origin and the login issuer.
  - The apps load no third-party script; the one third-party stylesheet is pinned with SRI. React escapes what it renders, and every link built from service or user data is limited to http(s).
  - No API route reachable through the apps' `/api/` proxy returns caller-controlled content as script or HTML, since `script-src 'self'` includes that proxy.
  - The System Atlas is a same-origin frame of the console that can read the console's session. It counts as console code, and every `innerHTML` in it takes only escaped or console-rendered HTML.
- **The token that matters in test is a trusted Entra login, not TestID.** A stolen TestID token is worth no more than a fresh TestID login. A trusted Entra login (ADR 0033) has every platform right and can create API keys and clients that keep model access after the token expires and after the person leaves the Entra group. The risk this decision accepts is an XSS against a team member.
- **Production gets a BFF before real people log in.** It does the code exchange as a confidential client, keeps the tokens server-side, and gives each app origin its own HTTP-only, `Secure`, `SameSite=Lax` cookie with the `__Host-` prefix. The apps call the API through their own origin with that cookie, and the API turns the session into the same principal as a bearer token today, accepted only from the app origin it was created for. External frontends keep using bearer tokens (ADR 0032).
- **The BFF is built in the API, for the assistant host first** (ADR 0061). The portal, workspace and console move to it later under #41.
- **Until then the apps keep tokens in `sessionStorage` only,** never in `localStorage` or IndexedDB. `sessionStorage` is per tab, but survives a reload, a duplicated tab and a restored session.

## Why

A BFF removes the token from the browser, so an XSS bug can act as the person only while the page is open, not take the token away. That matters in production, where the tokens act for real organisations. In test the data is synthetic, and the people whose tokens are worth stealing are a small team. Kunnskapsassistenten already built a BFF, so the pattern and its pitfalls are known: tokens live in the replica that signed the person in, so it needs sticky sessions or a shared session store.

Rejected: tokens in `localStorage` (survives the tab, readable by any script in the origin), and a BFF for the portal, workspace and console in test now (cost without matching benefit while the data is synthetic). A BFF as its own service or in each app's container: ADR 0061 puts it in the API, which already has the session store, content keys and token verifier.

## Consequences

- Closes the token criterion in #41 for test. Production readiness depends on the BFF.
- The BFF needs a session store shared by API replicas, so restarts do not sign everyone out. It rotates the session id at login, binds `state`, `nonce` and the PKCE verifier to a pre-login cookie, and at logout destroys the session, revokes the refresh token and ends the Ansattporten session.
- With cookies, every state-changing request through `/api/` checks the exact `Origin` and requires a JSON body or a non-simple header, since sibling subdomains are same-site.
- Ansattporten TEST issues 5-minute access tokens, and the console gets no refresh token (checked 2026-10-16; the apps ask for `openid profile`, without `offline_access`). Digdir's token endpoint documentation says refresh tokens go to confidential clients only, so the apps depend on the `prompt=none` renewal, which needs the Ansattporten session cookie in a frame; a browser that blocks third-party cookies sends the person back to login, with unsaved input kept. A refresh token, if the portal or workspace ever gets one, is a bearer credential that outlives the tab once stolen.
- Logout today removes the tokens from `sessionStorage` and ends the Ansattporten session on a deliberate logout; it does not revoke a refresh token. Unsaved input kept across re-login is stored per tab, not per person, and is cleared on a deliberate logout.
- The ID token is used only for the display name and for logout. It grants nothing and the API never accepts it. The console checks the `nonce` like the portal and workspace do.
- A new script source, inline script or third-party library in the apps weakens this decision until the BFF exists; review the CSP when adding one.
- Built 2026-11-19: the assistant host (`apps/assistant`, ADR 0061) logs in in the browser on the same conditions, as a public client of the service's hosted Client, and keeps only the access token and ID token in `sessionStorage`, with no refresh and no silent renewal: when the token expires, the person logs in again. It checks `state`, `nonce` and the issuer the metadata names, returns only to a path on its own hostname, and is served with the same CSP, with the issuer's origin in `connect-src`. All of it is in `apps/assistant/src/login.ts`, which the BFF replaces once the host signs in through it. Tests: `apps/assistant/src/app.test.tsx` and `apps/assistant/src/login.test.ts`.
- The BFF is built for the assistant host as ADR 0061 describes it, in `apps/api/src/bff`, with sessions in `bff_sessions`. It runs in front of the API and only for a request with a valid `GenAI-Proxy-Key`: it swaps the session for the access token as a bearer token, so the API checks the same principal, issuer and `sub` as for a browser token, and drops the cookie, the proxy key and any credential or `genai-acting-for` the page sent. Tests: `apps/api/src/bff/bff.test.ts` and `bff-postgres.test.ts`.
- Decided here where ADR 0061 is silent: `GET /auth/me` answers the name and organisations, never a token. The non-simple header for a state-changing call without a JSON body is `GenAI-CSRF`. `GET /auth/logout` is refused unless `Sec-Fetch-Dest` is `document` and `Sec-Fetch-Site` is same-origin or none, when the browser sends them, so an image in an answer cannot log anyone out. The login cookie is sealed with the tenant's content key. A refused refresh deletes the session and answers 401; an issuer that does not answer gives 503 and keeps it.
- The proxy key is off until an operator puts the same `genai-proxy-key` in genki's and the host's Key Vault and sets `assistantBffEnabled`. The portal, workspace and console still keep tokens in `sessionStorage`.
