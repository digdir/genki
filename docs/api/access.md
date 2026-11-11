# Access and extensions

Who and what may call the platform, and what the platform may call: the caller's rights, API keys and key policies, frontend clients, Maskinporten clients, tenant secrets, tool connections (MCP, A2A, OpenAPI), database connectors, private networks, building blocks and plugins, hooks, and onboarding of new organisations. The `/mock` routes exist only in local development.

## Rights

- `GET /tenants/{tenant}/me` returns the caller's own rights in the tenant. Rights are granted in Altinn, not through this API.
- `GET /me` returns the organisations a signed-in person may act for, with names and rights. The apps use it for logins whose token lists no organisations, such as an Entra ID login in a locked environment (ADR 0033). In a locked environment it also has `lockdownReadOnly: true` when the login may only read, so the apps can show the read-only banner.
- Keys, key policies, clients and Maskinporten clients need `manage-services`. Registering or syncing a tool connection needs `manage-services` or `register-building-blocks`; approving one needs `manage-services`. A tenant secret needs `manage-services` or `register-building-blocks`; changing the hosts of an existing secret needs `manage-services`.
- Registering building blocks needs `register-building-blocks`; adopting one needs `manage-services`, or `manage-datasets` for data blocks.
- Connector syncs and credentials need `manage-datasets`.
- Operator plug-in writes (`POST /operator/plugins`, `DELETE /operator/plugins/{id}`, `POST /operator/plugins/promotions`) and contract-test reruns (`POST /operator/plugins/{id}/contract-tests`, `POST /operator/building-blocks/{id}/contract-tests`) need `change-reason` of at least 10 characters. An operator decision on an access request (`POST /operator/onboarding/requests/{id}/decision`) reads the reason from `change-reason` only. Filing an access request (`POST /onboarding/requests`) needs no header: its `purpose` says why.
- Changes need `change-reason` and appear in `GET /tenants/{tenant}/audit`. Secret values are never returned and never logged.

## Typical sequence: a key for a system that calls one service

1. `GET /tenants/{tenant}/me`: check that you have `manage-services`.
2. `POST /tenants/{tenant}/services/{service}/api-keys` with `change-reason`: the key is in the response, once. Store it on the server.
3. Optional: `POST /tenants/{tenant}/api-key-policies` and `PUT /tenants/{tenant}/api-keys/{id}/policy` to share limits between keys.
4. The system calls the [Frontend](frontend.md) routes with `X-API-Key`.
5. `POST /tenants/{tenant}/api-keys/{id}/rotate` to replace the key, or `.../revoke` to stop it. An unknown key, or rotating a key that is already revoked, answers 404.

The key lists (`GET /tenants/{tenant}/access` and `GET /tenants/{tenant}/services/{service}/api-keys`) give each key's `createdAt`. For a caller with `manage-services` they also give `createdBy`, the actor who created or last rotated the key as the audit log names it, with `createdByName` when the platform knows the person's name; keys from before this was recorded have `createdBy: null`. In a locked environment each key also has `modelsInLockdown`, which is `false` for a key that was created or rotated by a login that may not use models there (ADR 0033).

A client's webhook test (`POST /tenants/{tenant}/clients/{id}/webhook/test`) sends a request out, so it needs `change-reason` and is audited. Removing an unknown client answers 404.

## Test-runner keys

A post-deploy smoke test in a locked test environment needs a key that can look at the whole tenant and clean up after itself. `POST /tenants/{tenant}/api-keys` takes `testRunner: true` only when the API runs with `GENAI_LOCKDOWN=true` and `GENAI_ENV=test`, and only from a trusted Entra ID login, that is a member of `LOCKDOWN_ENTRA_GROUPS` acting in its own organisation (members of `LOCKDOWN_USER_GROUPS` are not operators and may not); otherwise it answers 403 `urn:genai:problem:test-runner-refused`. The request must also set `expiresInDays` (1 to 90) and `callsPerMinute`, or it answers 400. `GET /tenants/{tenant}/access` has `testRunnerKeys: true` when the caller may set it there, and each key in the list says whether it has the grant. Rotating the key drops the grant. The `smoke-` prefix is reserved for smoke tests: a test-runner key may change any definition whose id starts with it, a service or a StepFlow. Outside a locked test environment a stored grant is ignored and the key is an ordinary key.

In its own tenant the key then:

- keeps its model runs and bindings as an ordinary admitted key;
- reads every `GET` route under `/tenants/{tenant}`, plus `/me`, `/models`, `/definitions*`, `/settings*`, `/shared-services`, `/schemas*`, `/onboarding/*` and `/openapi.json`, with every platform right in that tenant, so a run timeline shows tokens and cost;
- may validate definitions and run the other checks that change nothing (except those that send a stored secret, and the batch estimate), give feedback, publish, change the lifecycle of, and save or delete the draft of a definition whose id starts with `smoke-`, and run the playground on a published service its grants reach or on any version of a `smoke-` service, where an inline draft must also have a `smoke-` id. The playground also checks the key's service grants in the kernel, which today passes only a key granted every service, so create the key for all services if it should use the playground;
- reads `/operator/tenants`, `/operator/operations`, `/operator/models`, `/operator/apis`, `/operator/plugins*`, `/operator/catalog*`, `/operator/tracing`, `/operator/quality` and `/operator/knowledge/engines` as an operator that is not admitted, so it can show the console's configuration screens. Some of these list every tenant, as they do for any operator. It gets nothing else from the operator role: every other `/operator` route, such as audit, onboarding requests, support sessions, tenant definitions, tasks and usage, answers 403 `urn:genai:problem:test-runner-scope`.

Every other write, including every non-GET route under `/operator`, support sessions, secrets, keys, Maskinporten clients, settings, ingestion and batch runs, answers 403 `urn:genai:problem:test-runner-scope`. Routes under `/tenants/{other}` answer 404. See ADR 0033.

For tools: `POST /tenants/{tenant}/tool-connections`, then `.../sync` and `.../approve` for each new tool before a service may name it.

## Tenant secrets

A tenant secret is used only for the hosts it is set for.

- `PUT /tenants/{tenant}/secrets/{name}` takes `value` and `allowedHosts`, a list of origins such as `https://api.example.no` or `https://token.example.no:8443`. A host without a scheme means `https://`. A new secret needs `allowedHosts`. Leaving it out on an existing secret keeps its hosts.
- `PUT /tenants/{tenant}/secrets/{name}/hosts` with `allowedHosts` changes the hosts of an existing secret. It needs `manage-services`, and so does a `PUT` of the secret with other hosts than it has.
- `GET /tenants/{tenant}/building-blocks/secrets` lists each secret with its `allowedHosts`.
- A tool connection (MCP, A2A, OpenAPI) and a remote agent may use a secret only when every address it is sent to is in `allowedHosts`: the endpoint, the OpenAPI document address and the OAuth token address. Registration refuses other addresses with `400`. At call time the platform does not send the secret, and it never follows a redirect to another origin.
- Secrets that existed before 2026-10-16 were bound once to the hosts of the tool connections and service definitions that already used them. A secret no connection used has no hosts and is not sent anywhere until someone with `manage-services` sets them.
