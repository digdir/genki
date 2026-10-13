# Build a frontend

For developers and for LLMs asked to generate a frontend against this platform. You need no access to the repository: the published contract is enough.

## Read three sources, in this order

1. [Frontend contract](frontend-contract.md): the rules, auth, the `/v1` extensions, conversations, citations, streaming and errors.
2. `GET /openapi.json`: every route with its request and response shapes. The per-key tool document is at `/api/tools/openapi.json`.
3. The schemas: `GET /schemas` and `GET /schemas/{kind}@{version}` describe what can be configured, and `GET /v1/models/{id}/schema` gives one service's input form and output shape as JSON Schema with `x-label` (nb and en), `x-help`, `x-widget`, `x-options` and `x-order`. Draw forms from these instead of hardcoding them.

## Auth

- Your own server: `X-API-Key: <service key>` (or `Authorization: Bearer <key>`) plus `X-User-Id: <pseudonymous end user>`. Create the key under the service in the portal. Never put it in a browser.
- A browser: register the frontend as kind `browser` and send `Authorization: Bearer <Ansattporten token>`.
- `401` is missing or bad credentials, `403` a key that may not reach the service or channel.
- A key bound to one service keeps conversations per `X-User-Id`. A tenant key ignores `X-User-Id` and shares one conversation list across everyone using it, so serve end users with a service key.

## Minimal call sequence

1. `GET /v1/models` with `Accept-Language: nb` or `en`. Keep entries with `_default: true` (one per service; `_chat: true` marks the ones that belong in a chat list), skip `status: "paused"` and rows with `_alias_of`. Use `id` as the model name, `_service_title` and `description` as labels. Group rows by `_service`: when a service has more than one `_pickable` row, offer a variant picker labelled with `_variant_title`. Never show a variant as a separate service (see Services and their variants in the contract).
2. If the entry has `input_fields`, fetch `GET /v1/models/{id}/schema` with the same `Accept-Language` and render `input` as a form.
3. If the entry has `_datasets`, offer filters: each dataset names its `tenant`, `dataset-config-key` and filter fields with their `value-type`. Fetch values with `GET /api/facets`. Without `_datasets`, send no `filters`.
4. If the entry has `_documents`, offer file upload for the types in `_documents.accepts`.
5. `POST /v1/chat/completions` (a form service may leave `messages` out and send only `input`) with `{ "model": id, "messages": [{ "role": "user", "content": question }], "input": { ...form values }, "genai_conversation": true, "stream": true, "genai_stream": "live" }`. Show tokens as they arrive and drop what you showed when a frame says `retract`.
6. Show `[N]` citations from `sources[].index`, and mark every answer as AI-generated. Do not number sources yourself.
7. Continue with `conversation_id` from the first response. List with `GET /api/conversations`; reopen with `GET /api/conversations/{id}`, which returns `{ conversation, messages }` with `sources` on each answer, resolved by the same `[N]` rule.
8. Send `POST /api/feedback` with the `genai-task` response header and `rating: "up"` or `"down"`.

Errors: `/v1/*` uses OpenAI's error shape, `/api/*` uses problem+json; both carry a `code`. See Errors in the contract.

Show the result by the output kind in the service schema: `answer` and `document` are text, `fields` is JSON in the message content, `table` arrives as the `table` member of the response.

## For contributors (repository only)

You need none of these to build a frontend; they live in the platform repository and are not published.

- Typed client without runtime dependencies: `@genai/client` (`packages/client`).
- Shared form renderer for the schemas: `@genai/schema-forms`.
- Working example: `examples/frontend-minimal`.
- Why schemas drive screens: [ADR 0030](adr/0030-frontends-from-schemas.md).
