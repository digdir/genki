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
   To open a cited document, `GET /api/datasets/{id}/documents/{doc}/file`: its uploaded original, or a redirect to its source's address when the dataset's documents come from a remote source. Send `Accept: application/json` to learn what it is first (`kind`, `mediaType`, and `url` for a source). The original is only for callers of the organisation that owns the dataset, or a frontend of its service.
4. `POST /v1/chat/completions` with `"genai_conversation": true` and `"stream": true`.
   When the person stops the answer, `POST /v1/tasks/{task}/cancel` with the `genai-task` header value. Closing the stream does not stop the run.
5. `GET /api/conversations` and `GET /api/conversations/{id}` to list and reopen.
6. `POST /api/feedback` with the `genai-task` header value and `rating: "up"` or `"down"`.
