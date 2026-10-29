# Access and extensions

Who and what may call the platform, and what the platform may call: the caller's rights, API keys and key policies, frontend clients, Maskinporten clients, tenant secrets, tool connections (MCP, A2A, OpenAPI), database connectors, private networks, building blocks and plugins, hooks, and onboarding of new organisations. The `/mock` routes exist only in local development.

## Rights

- `GET /tenants/{tenant}/me` returns the caller's own rights in the tenant. Rights are granted in Altinn, not through this API.
- `GET /me` returns the organisations a signed-in person may act for, with names and rights. The apps use it for logins whose token lists no organisations, such as an Entra ID login in a locked environment (ADR 0033).
- Keys, key policies, clients, Maskinporten clients and tool connections need `manage-services`. A tenant secret needs `manage-services` or `register-building-blocks`; changing the hosts of an existing secret needs `manage-services`.
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

A client's webhook test (`POST /tenants/{tenant}/clients/{id}/webhook/test`) sends a request out, so it needs `change-reason` and is audited. Removing an unknown client answers 404.

For tools: `POST /tenants/{tenant}/tool-connections`, then `.../sync` and `.../approve` for each new tool before a service may name it.

## Tenant secrets

A tenant secret is used only for the hosts it is set for.

- `PUT /tenants/{tenant}/secrets/{name}` takes `value` and `allowedHosts`, a list of origins such as `https://api.example.no` or `https://token.example.no:8443`. A host without a scheme means `https://`. A new secret needs `allowedHosts`. Leaving it out on an existing secret keeps its hosts.
- `PUT /tenants/{tenant}/secrets/{name}/hosts` with `allowedHosts` changes the hosts of an existing secret. It needs `manage-services`, and so does a `PUT` of the secret with other hosts than it has.
- `GET /tenants/{tenant}/building-blocks/secrets` lists each secret with its `allowedHosts`.
- A tool connection (MCP, A2A, OpenAPI) and a remote agent may use a secret only when every address it is sent to is in `allowedHosts`: the endpoint, the OpenAPI document address and the OAuth token address. Registration refuses other addresses with `400`. At call time the platform does not send the secret, and it never follows a redirect to another origin.
- Secrets that existed before 2026-10-16 were bound once to the hosts of the tool connections and service definitions that already used them. A secret no connection used has no hosts and is not sent anywhere until someone with `manage-services` sets them.
