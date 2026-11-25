# Run your own frontend

Status: preview. The template in `examples/team-frontend` has been run end to end against a local genki with the mock Ansattporten login and the local test model: a registered frontend, a login, an answer with sources and a reopened thread. It has not run against genki-test or real Ansattporten.

A service's end users can reach it in two ways ([ADR 0061](adr/0061-genki-hosts-a-services-assistant.md)):

- **The genki host.** genki draws the service's assistant from its published layout, on the service's own hostname. Built so far (#832): the public host lookup, the layout route and `apps/assistant`, which draws the assistant. Not built yet: its login, the BFF that keeps tokens on the server (ADR 0034, proposed), themes and custom hostnames. Use it when the building blocks in the catalogue draw what you need and those parts are in place.
- **Your own frontend.** You write the code, run it in your own container in your own Azure (or anywhere), and register it in genki as a frontend of your service. People log in with Ansattporten, and your frontend calls genki with their token. This page is about this way.

Start from the template: [`examples/team-frontend`](../examples/team-frontend/README.md). It is plain TypeScript with no dependencies, an nginx image and a Dockerfile.

## Who owns what

| Your team owns                                                              | genki owns                                                                       |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| The frontend's code, image, container, Azure resources and deploys          | The API, the service's runs, models, datasets and sources                        |
| The Ansattporten client: its registration, redirect URIs and any secret     | The frontend registration (a `Client`), and the check of every token against it  |
| The domain, DNS records and certificate of the frontend                     | Threads, feedback and the audit log of every run                                 |
| Where tokens live in the browser or on your server, and your page's CSP     | Rights: who may use the service, through which channels, from which origins      |
| Support for your users, and anything the page shows besides genki's answers | Uptime of the API on genki-test, and changes to the contract, which are additive |

The service owner, who may be your team too, owns the service definition. genki runs no team's container in its own Container Apps environment, and calls nothing in your frontend.

## 1. Register the frontend

You need two registrations with the same client id.

**In Ansattporten**, a client of your own, through Digdir's self-service. A frontend that keeps tokens in the browser is a public client with PKCE; one with its own server can be confidential. Register `https://<your host>/callback` as redirect URI and `https://<your host>/` for logout. One client id belongs to one service in genki, so a team with two services needs two clients.

**In genki**, a `Client` of kind `browser` under the service's organisation. In the portal: open the service, then **Avanserte innstillinger**, **Kanaler og frontend**, **Egne brukerflater**, **Registrer brukerflate**. Or through the API, with `manage-services` in the organisation:

```http
PUT /tenants/{tenant}/clients/{id}
Authorization: Bearer <your token>
change-reason: Register the team's own frontend for the service

{
  "metadata": { "name": "Our assistant" },
  "spec": {
    "service": "<service id>",
    "kind": "browser",
    "url": "https://assistent.example.no",
    "channels": ["openai", "conversations", "feedback"],
    "allowedOrigins": ["https://assistent.example.no"],
    "oidc": {
      "clientId": "<Ansattporten client id>",
      "redirectUris": ["https://assistent.example.no/callback"],
      "postLogoutRedirectUris": ["https://assistent.example.no/"]
    }
  }
}
```

- `channels` are what the frontend may call: `openai` (`/v1`), `conversations`, `feedback`, `facets` and `mcp`. Leave out what you do not use.
- `allowedOrigins` are the origins your page runs on. genki refuses a call with any other `Origin`, and answers CORS for these only.
- `environments` (optional) limits the frontend to some of the service's environments, such as `["test"]`.
- A client id can be registered once across genki. `GET /tenants/{tenant}/clients?service=<id>` lists the service's frontends.

**On genki-test**, which is locked ([ADR 0033](adr/0033-locked-test-environment.md)), two more things hold. People log in with Entra ID through Ansattporten, and a login from the all-employees group reaches a service only through a client id listed in `LOCKDOWN_SERVICE_CLIENT_IDS` and registered in the platform organisation. Adding a client id to that list is a change to the GitHub environment variable and a deploy, so ask the genki maintainers. TestID logins on genki-test can only read, so they get no answers.

## 2. Log in

Use the authorization code flow with PKCE (`S256`), `state` and `nonce`, against the issuer's `/.well-known/openid-configuration`. Ask for the Altinn resource genki checks, as the template's `loginUrl` does:

```
authorization_details=[{"type":"ansattporten:altinn:resource","resource":"urn:altinn:resource:digdir-genai-platform"}]
```

On the callback, check `state`, exchange the code with the verifier, and check the ID token's `nonce`. Send the access token as `Authorization: Bearer <token>`. The ID token grants nothing in genki; use it for the name and for logout.

What genki checks on every call with that token: the issuer and signature, that the token's `client_id` is a registered frontend, that the login carries a right in the organisation that owns the service, the frontend's channels and origins, and `use-services`. The person is then confined to that one service. In genki-test the login is an Entra login, as above.

Locally, the API runs a mock Ansattporten at `http://localhost:8080/mock/ansattporten` with test persons ([development](development.md)). Saving a `browser` client registers its client id and redirect URIs with the mock, and any loopback port works. The mock's discovery and token endpoints answer no CORS, so a page on another origin reaches them through its own proxy; the template sends every call under `/genki/` through its nginx.

## 3. Call the service

The [frontend contract](frontend-contract.md) has every rule; these are the calls a chat frontend needs.

| Need                     | Call                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| The service and its name | `GET /v1/models`: keep rows with `_default: true`, no `_alias_of`, and not `status: "paused"`; use `id` as `model`           |
| Ask, streamed            | `POST /v1/chat/completions` with `"stream": true, "genai_stream": "live"`, and `"genai_conversation": true` for a new thread |
| Continue a thread        | the same with `"conversation_id": "<id>"` from the first frame; send only the new question                                   |
| Sources                  | the `sources` frame: `[N]` in the text is the source with `index: N`; never number sources yourself                          |
| List and reopen threads  | `GET /api/conversations`, `GET /api/conversations/{id}`; each answer keeps its `sources`                                     |
| Stop an answer           | `POST /v1/tasks/{task}/cancel` with the `genai-task` response header                                                         |
| Feedback                 | `POST /api/feedback` with `{ "task": "<genai-task>", "rating": "up" }`                                                       |

Drop what you have shown when a frame has `"retract": true`. Mark every answer as generated by AI. Show a link only for an `http` or `https` `url`, and render answer and source text as text, never as HTML.

`@genai/client` in the repository does all of this, but it is not published to a package registry, so a frontend outside the repository uses the HTTP calls. The template's `genki.ts` is a copy-ready version of the same calls for a browser.

## 4. Run it

The template builds to static files served by `nginxinc/nginx-unprivileged`, configured from the environment at start (`PUBLIC_URL`, `GENKI_API_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, see its README). Run it in a Container Apps environment of your own with a managed certificate for your hostname. It keeps no state, so any number of replicas work.

The page's CSP allows scripts and styles from its own origin only and connections to its own origin and the issuer. Keep it that strict: tokens live in `sessionStorage`, so any script on the page can act as the person while the tab is open. Never keep them in `localStorage`.

## Limits

- One client id, one service. A thread belongs to the organisation and the person's `issuer|sub`, and Ansattporten's `sub` is per client id, so a new client id or issuer gives every person an empty thread list.
- Ansattporten TEST gives a public client 5-minute access tokens and no refresh token. When the token runs out, the template asks the person to log in again; a frontend can renew it with `prompt=none` in a hidden frame of its own origin, or use a server of its own.
- Rate limits, budgets and the service's guardrails apply to your frontend's calls as to every other caller's. A call on a channel the registration does not list, or from an origin it does not list, answers `401`, as a missing token does, so check the registration before you ask the person to log in again. A `403` names an environment the frontend may not use or a right the person lacks.
- genki-test is one environment with synthetic data. Real people do not log in there.

## Moving to production later

Production login is decided in #464, and genki's production environment does not exist yet. What is known now:

- You register a client in Ansattporten's production environment and register its client id in genki's production, as in step 1. The issuer and client id change, so threads from test do not follow (ADR 0061, Consequences).
- Before real people log in, keep tokens off the browser: run a small server of your own as a confidential client that keeps the tokens and gives the page an `HttpOnly`, `Secure`, `__Host-` session cookie, the rule genki follows for its own apps ([ADR 0034](adr/0034-tokens-in-the-browser.md)). Or move to the genki host once its BFF, proposed in ADR 0061 and not built yet, is in place.
- `LOCKDOWN_SERVICE_CLIENT_IDS` is a genki-test setting; production checks the person's Altinn rights for the service.
