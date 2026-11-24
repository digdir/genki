# Platform

The platform describing itself: `GET /health` (status, version and `builtAt`, the commit time of the image, from `APP_BUILT_AT`; absent in local builds; `status` is `degraded`, still with 200, while `modelDiscovery.state` is `retrying` because the providers' model listing has not succeeded yet, or `failed` once twelve attempts in a row have failed, with waits that grow from 2.5 to 5 seconds up to 2.5 to 5 minutes; each replica tracks its own state and clears it when its own next listing succeeds, while it serves the stored listings of every connection; an operator's model refresh lists on the replica that takes it, and the other replicas load what it stored; `modelDiscovery.connections` reports per connection how many models it serves, when a listing last succeeded and the kind of its last failure), `GET /up` (liveness), `GET /openapi.json` (this API), `GET /reference` (the browsable reference) and the configuration schemas.

## Rights

None. These routes are open to everyone and change nothing.

## Typical sequence: generate a client or a form

1. `GET /openapi.json`: every route with its schemas. The `tags` list names the areas.
2. `GET /schemas`: the published configuration schemas and which kinds use them.
3. `GET /schemas/{ref}`: one schema, for example a strategy's config, to draw a form from it.
4. `GET /health`: check the version you generated against.
