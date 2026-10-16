# 0034 Tokens in the browser

Status: proposed, 2026-10-16

## Context

The portal, workspace and console log in with Ansattporten in the browser, with the authorisation code flow and PKCE as public clients, and keep the session in `sessionStorage`. The portal and workspace keep the access token, the refresh token when Ansattporten issues one, and the ID token, and refresh with it (`apps/portal/src/oidc.ts`, `apps/workspace/src/oidc.ts`). The console keeps the access and ID tokens and does not refresh (`apps/console/src/auth.ts`). All three ask for the same API audience, so a token from any of them carries the person's full rights in all of them. Anything that runs script in an app's origin can read the token and send it anywhere: the CSP limits which script runs, not where that script sends data.

A backend-for-frontend (BFF) keeps the tokens on a server and gives the browser only an HTTP-only session cookie, as Kunnskapsassistenten does (its ADR 0011).

## Decision

- **genki-test keeps tokens in `sessionStorage`,** on these conditions, which hold today and must keep holding:
  - The apps' CSP allows scripts from their own origin only, with no inline script and no `eval` (`docker/apps/headers.conf`), and every page except the System Atlas refuses to be framed.
  - The apps load no third-party script; the one third-party stylesheet is pinned with SRI. React escapes what it renders, and every link built from service or user data is limited to http(s).
  - No API route reachable through the apps' `/api/` proxy returns caller-controlled content as script or HTML, since `script-src 'self'` includes that proxy.
  - The System Atlas is a same-origin frame of the console that can read the console's session. It counts as console code, and every `innerHTML` in it takes only escaped or console-rendered HTML.
- **The token that matters in test is a trusted Entra login, not TestID.** A stolen TestID token is worth no more than a fresh TestID login. A trusted Entra login (ADR 0033) has every platform right and can create API keys and clients that keep model access after the token expires and after the person leaves the Entra group. The risk this decision accepts is an XSS against a team member.
- **Production gets a BFF before real people log in.** It does the code exchange as a confidential client, keeps the tokens server-side, and gives each app origin its own HTTP-only, `Secure`, `SameSite=Lax` cookie with the `__Host-` prefix. The apps call the API through their own origin with that cookie, and the API turns the session into the same principal as a bearer token today, accepted only from the app origin it was created for. External frontends keep using bearer tokens (ADR 0032).
- **Until then the apps keep tokens in `sessionStorage` only,** never in `localStorage` or IndexedDB. `sessionStorage` is per tab, but survives a reload, a duplicated tab and a restored session.

## Why

A BFF removes the token from the browser, so an XSS bug can act as the person only while the page is open, not take the token away. That matters in production, where the tokens act for real organisations. In test the data is synthetic, and the people whose tokens are worth stealing are a small team. Kunnskapsassistenten already built a BFF, so the pattern and its pitfalls are known: tokens live in the replica that signed the person in, so it needs sticky sessions or a shared session store.

Rejected: tokens in `localStorage` (survives the tab, readable by any script in the origin), and a BFF in test now (cost without matching benefit while the data is synthetic).

## Consequences

- Closes the token criterion in #41 for test. Production readiness depends on the BFF.
- The BFF needs a session store shared by API replicas, so restarts do not sign everyone out. It rotates the session id at login, binds `state`, `nonce` and the PKCE verifier to a pre-login cookie, and at logout destroys the session, revokes the refresh token and ends the Ansattporten session.
- With cookies, every state-changing request through `/api/` checks the exact `Origin` and requires a JSON body or a non-simple header, since sibling subdomains are same-site.
- Ansattporten TEST issues 5-minute access tokens, and the console gets no refresh token (checked 2026-10-16; the apps ask for `openid profile`, without `offline_access`). A refresh token, if the portal or workspace ever gets one, is a bearer credential that outlives the tab once stolen.
- Logout today removes the tokens from `sessionStorage` and ends the Ansattporten session on a deliberate logout; it does not revoke a refresh token. Unsaved input kept across re-login is stored per tab, not per person, and is cleared on a deliberate logout.
- The ID token is used only for the display name and for logout. It grants nothing and the API never accepts it. The console checks the `nonce` like the portal and workspace do.
- A new script source, inline script or third-party library in the apps weakens this decision until the BFF exists; review the CSP when adding one.
