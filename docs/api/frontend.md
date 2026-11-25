# Frontend

What a frontend, chat client or agent calls to use published services: `/v1` (OpenAI-compatible), `/api/conversations`, `/api/feedback`, `/api/datasets`, `/api/facets`, `/api/tools`, `/api/mcp` and `/a2a`.

The rules for these routes are in the [Frontend contract](../frontend-contract.md); start with [Build a frontend](../build-a-frontend.md).

## Rights

- A person needs `use-services` in the tenant that owns the service.
- An API key bound to a service, or a tenant key, reaches what its grants allow. A frontend registered as a client is limited to its channels and origins.
- These routes are runs, not admin changes: they need no `change-reason`. Each run is a task you can follow by the `genai-task` response header.

## Typical sequence

1. `GET /v1/models`: the services the credential may use, with `title`, `_default`, `_chat` and `input_fields`.
2. `GET /v1/models/{id}/schema`: the input form and the output shape, when the service has a form.
3. `GET /api/facets?tenant=&dataset-config-key=&fields=`: filter values, when the service has `_datasets`.
   To open a cited document, `GET /api/datasets/{id}/documents/{doc}/file`: its uploaded original, or a redirect to its source's address when the dataset's documents come from a remote source. A PDF the document's record lists on an origin the operator allows in `GENAI_DOCUMENT_FILE_ORIGINS` is read and served by genki instead, inline and framable by the same site; `?file=<address>` asks for one listed file, such as an excerpt's; a file whose record gives a size over 50 MiB is `404 document_file_not_found` (ADR 0066). Send `Accept: application/json` to learn what it is first (`kind`, `mediaType`, `url` for a source, `source` for a file genki serves). The original is only for callers of the organisation that owns the dataset, or a frontend of its service.
4. `POST /v1/chat/completions` with `"genai_conversation": true` and `"stream": true`.
   When the person stops the answer, `POST /v1/tasks/{task}/cancel` with the `genai-task` header value. Closing the stream does not stop the run.
5. `GET /api/conversations` and `GET /api/conversations/{id}` to list and reopen.
6. `POST /api/feedback` with the `genai-task` header value and `rating: "up"` or `"down"`.

## A hosted assistant

genki's assistant host draws a service on a hostname of its own (ADR 0061). It needs no credential to start:

1. `GET /v1/hosts/{hostname}`: the tenant, service, environment, name, menu and page titles, and `login` with `issuer`, `clientId`, `audience` and `altinnResource` (for a Client without `oidc`, genki's platform login client and the API audience). Any hostname that is not active, including one opened to another tenant, gets `404` with `urn:genai:problem:host-not-found`. Cached 60 seconds. A hostname claimed as a redirect answers only `{ hostname, redirectTo }`; the host then sends the browser to the same path on `redirectTo`.
2. `GET /v1/hosts/{hostname}/pages/{id}`: a page's title and Markdown body.
3. After login with the named client: `GET /v1/models`, then `GET /v1/models/{id}/interface` for the layout, then the sequence above.

## Addresses for a hosted service

A hostname is opened by an operator's parameter file or by a claim of the service owner (ADR 0062). A claim is served, and a signed-in page on it admitted, only while it is `active`.

- `GET /tenants/{tenant}/services/{service}/hostnames`: the service's addresses with their state (`pending-dns`, `binding`, `active`, `failed`, `lapsed`, `removing`, `removed`) and, for an own domain, the three DNS records it needs.
- `POST /tenants/{tenant}/services/{service}/address` gives a published service with an assistant interface genki's name for it, `<label>.apps.<zone>`, where the label is the service id, or `<label>-2` and on when that is taken. The first publish does this by itself.
- `POST /tenants/{tenant}/clients/{client}/hostnames` with `{ hostname, environment | redirectTo, reason }` claims an own domain for a hosted Client; `DELETE .../hostnames/{hostname}` removes it. Both need `manage-services`.

## On genki's assistant host

A page on the assistant host signs in through the BFF (ADR 0061, ADR 0034) and holds no token. The host proxies these routes to the API with its proxy key; the API does not answer them without it.

- `GET /auth/login?next=/path` starts the login; `next` is kept only as a path on the same hostname.
- `GET /auth/callback` is the redirect URI a Client with its own `oidc` registers, `https://{hostname}/auth/callback`.
- A Client without `oidc` logs in through genki's platform login: `/auth/login` sends the browser to `https://login.apps.<zone>/auth/login?host={hostname}`, which runs the login with genki's own client and returns to `GET /auth/handoff?code=...` on the hostname. The code works once, for about a minute, only on that hostname and only in the browser that started the login.
- `GET /auth/me` and `GET /auth/org`: the name, the chosen organisation and the organisations the person may act for, or `401` when no one is signed in. Never a token.
- `POST /auth/org` with `{"organisation": "<orgnr>"}` and the hostname's exact `Origin` changes the organisation.
- `GET /auth/logout` ends the session, revokes the refresh token and ends the login session. Through the platform login, Ansattporten returns to `https://login.apps.<zone>/auth/logged-out`, which sends the browser back to the hostname it came from, or shows a signed-out page.
- `/api/...` with the `__Host-genki_session` cookie reaches the routes above as the signed-in person. A state-changing call needs the hostname's exact `Origin` and a JSON body or the `GenAI-CSRF` header; `401 urn:genai:problem:signed-out` means sign in again.
