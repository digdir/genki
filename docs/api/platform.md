# Platform

The platform describing itself: `GET /health` (status and version), `GET /up` (liveness), `GET /openapi.json` (this API), `GET /reference` (the browsable reference) and the configuration schemas.

## Rights

None. These routes are open to everyone and change nothing.

## Typical sequence: generate a client or a form

1. `GET /openapi.json`: every route with its schemas. The `tags` list names the areas.
2. `GET /schemas`: the published configuration schemas and which kinds use them.
3. `GET /schemas/{ref}`: one schema, for example a strategy's config, to draw a form from it.
4. `GET /health`: check the version you generated against.
