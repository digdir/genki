# 0004 Service, capability and version

Status: accepted, 2026-10-12 (built; the data version for datasets on the knowledge database, 2026-11-03; sharing changed only by operators, 2026-11-11; service environments partly built, 2026-11-11; internal services built, 2026-11-12). Proposed 2026-10-06

## Decision

- A **service** is what a tenant defines. A **capability** is what the kernel invokes.
- A service has one or more **variants**, which replace headless-rag's modes. Each variant becomes one capability with id `<tenant>/<service>/<variant>`. A variant may have its own way of working (ADR 0031).
- A **fellestjeneste** is a service owned by Digdir and shared with other tenants. It is not a separate kind.
- `spec.availableTo` (`'*'` or a list of organisation numbers) says which other tenants may see and call a service. Only an operator changes it; the API refuses a publish or import by anyone else that changes it compared with the published version (`urn:genai:problem:share-operator-only`). Seeded definitions from git keep the value they declare.
- `spec.visibility: internal` marks a service only operators see, such as the post-deploy smoke test's `smoke`. Its latest published version decides, or its draft while it has never been published. Only operators, the platform's own workloads (the `workload` principals the platform runs as, such as the seed and the engine switch) and a test-runner key (ADR 0033) see it. Everyone else, tenant admins, members, other API keys and anonymous callers, never finds it in a list and gets 404 on its paths; see [Internal services](#internal-services) for what is and is not hidden.
- A service has one version scheme: an integer that increases by one on every publish. Published versions are immutable.
- All capabilities from one service version carry that version.
- Each variant has a public name, `<service>__<variant>` unless the definition sets one, and may keep extra names as aliases.
- A caller may pin a version with the `GenAI-Version` header, or `metadata.version` on the OpenAI-compatible API. If both are sent they must agree. MCP and REST read the header; A2A takes no pin. Without a pin, the name resolves to the version its service environment points to (below).
- Every task records the capability and service version, the strategy and its version, a hash of the resolved configuration, each model deployment it called, and each dataset it read with the index generation the engine served. An engine without generations, such as the shared read-only Typesense, records the collection names instead. For a dataset on the knowledge database ([ADR 0042](0042-the-knowledge-database.md)), which is updated in place, it also records the data version of the server that answered (`IndexProvenance.dataVersion`).

## Service environments

An environment is a named pointer from a service to one of its published versions, inside one installation. It is not a platform environment such as genki-test (ADR 0033).

- Every service has `prod`. Until another environment is added, `prod` follows every publish, so a service without environments behaves as before.
- An owner with `manage-services` adds an environment (`POST /tenants/{tenant}/services/{id}/environments`, name `^[a-z][a-z0-9-]{0,31}$`, at most 5 per service). A new environment follows every publish; `prod` is pinned at the latest version in the same change, so from then on publishing moves `test` and leaves `prod` where it is.
- Promote (`POST .../environments/{name}/promote`, `from` defaults to `test`) sets an environment, usually `prod`, to the version another runs. Roll back (`POST .../environments/{name}/rollback`) sets it to a named published version, or without one to the version it ran before its last change. Neither publishes, and both are refused (409) while `prod` is the only environment, since pinning it would stop it following publishes; there, publish an earlier version again instead. An environment that is promoted or rolled back is pinned: publishing no longer moves it until it is removed and added again. Both, like adding and removing, are admin actions (`platform.service.environments.*`, ADR 0010) that need `manage-services` and a change reason, and are in the audit log with the pointers before and after.
- Removing an environment other than `prod` is allowed; removing the last one lets `prod` follow publishes again, so the API refuses it (409) while `prod` is not on the latest version.
- The pointers are config entries of kind `service-environments`, one per service, append-only, in Postgres and in memory alike. `GET .../environments` lists each environment with the version it runs.
- A call names its environment with the `GenAI-Environment` header on every channel (OpenAI-compatible, REST, MCP, A2A). Without it the call runs `prod`, or the first environment the caller may use when `prod` is not among them. A service API key (`environments` on `POST /tenants/{tenant}/services/{service}/api-keys`) and a frontend (`spec.environments` on a Client) may be bound to environments; a key bound to a client may use only the environments both name. A bound caller is refused other environments (`403 environment_not_authorized`). A caller bound to none may name any environment of the service, since it may already pin any version. A name the service lacks is `409 environment_not_found`, and a header that is not a name `400 invalid_environment`.
- A `GenAI-Version` pin overrides the environment's version, within the same service. A caller bound to environments may pin only a version one of them runs (`prod` without a pointer runs the latest), else `403 environment_not_authorized`. A caller bound to none may pin any published version. The task records the environment that runs the pinned version, the named one first, then `prod`, then the others, or none when no environment runs it.
- The task records the environment beside the version (`ServiceProvenance.environment`), and the response carries `genai-environment`. The run log (`GET /tenants/{tenant}/tasks?environment=`) and usage (`GET /tenants/{tenant}/usage?environment=`, `byEnvironment`) show and filter by it; runs from before environments count as `prod`, and a pinned run no environment ran has none.
- Batch runs and evaluation runs without a version run the version `prod` points to; an evaluation run may name another environment. The playground always runs a named version and marks the versions each environment runs.

Defaults for the questions left open in the proposal:

- Promotion is offered, not gated by a passing test set. The evaluation gates on publish (ADR 0003) still apply to every version.
- An environment has no quota of its own. A key bound to `test` has its own calls per minute like any key.
- A frontend has one public URL. A separate test deployment is a separate Client bound to `test`.
- Variants follow the environment: all variants of a service run the version the environment points to.

## Why

The plan had services, agents, modes and capabilities with no defined mapping, and three version schemes. A task must be able to answer "which version decided this".

## Consequences

- The entry point resolves the version pin before the kernel runs, so `InvokeOptions` carries no version.
- The parity harness calls each side by its own names: headless-rag by its agent names, the platform by `<service>__<variant>`. Since the headless-rag aliases were removed on 2026-10-09, the harness's MCP and REST scenarios use that per-side mapping (ADR 0017, parity harness names).
- Rolling back a service without environments means publishing an earlier version as a new one, so history stays linear. With environments, rolling back moves a pointer and publishes nothing.
- Environments are pointers on a service rather than a configuration layer of their own, or a copy of the service under another name, because keys, frontends, test sets and history stay with one service and the difference between test and prod is always one version number.
- Not built yet: the portal screens to add, promote and roll back environments and to filter the run log and usage by environment, and the environments on service keys and clients in the portal. Triggers (schedule, documents arriving, queue messages) and the batch companion capability in the worker still run the latest published version, not `prod`'s. `GET /v1/models` and agent cards describe the latest version.

## Internal services

The API enforces `spec.visibility: internal` in `apps/api/src/internal-services.ts`, mostly in one place rather than route by route:

- **Who is looking.** A middleware reads the caller of every request once and keeps, for the rest of the request, whether it sees internal services (`seesInternalServices` in `@genai/identity`: an operator, a platform `workload` principal or a test-runner key). Which services are internal is looked up once per service per request.
- **The definition store.** The store the API and its modules read through leaves internal services out of `list`, `get`, `versions`, `capabilities` and `resolve` for anyone else. So the lists built from it leave them out: the portal's services, overview, playground, access and shared services, `GET /tenants/{tenant}/definitions`, `GET /services/by-name/{name}`, the builder, building blocks and the lists of where a dataset, skill or block is used. `/v1/models`, MCP and A2A resolve through the same store, so the service is not a model there and a run answers 404 `model_not_found`.
- **Service paths.** `/tenants/{tenant}/services/{id}/...` answers a signed-in caller 404: with `errors: []` where a route exists, as those routes answer an unknown id, and with the platform's plain not-found body where none does. An anonymous caller gets the route's own 401. The definition and diagnostics routes answer from the filtered store.
- **Runs.** The shared task lookup returns nothing for a run of an internal service, so `GET /tenants/{tenant}/tasks/{task}` and its timeline, review and export answer 404. The tenant's log, its usage view, the eval runs, test sets, feedback and test case candidates leave them out, and `GET /eval-runs/{id}` and `GET /eval-runs/compare` answer 404 for an eval run of one. Feedback whose run cannot be looked up is left out too.
- **Audit.** `GET /tenants/{tenant}/audit` leaves out publishes, drafts, lifecycle, environment and risk changes of an internal service, and `GET /tenants/{tenant}/audit/{task}` answers 404 for them.
- **Drafts and keys.** The draft list and the draft paths follow the same rule. The access view and the key policies leave out keys bound only to internal services, and the access view drops them from other keys' service lists, and `GET /tenants/{tenant}/clients` leaves out clients bound to one.
- **Publishing.** Only those who see internal services may publish, import, validate or save a draft with `visibility: internal` (others get 422 at `spec.visibility`); saving a draft that is already internal unchanged is allowed. Anyone else who publishes, imports or validates a definition with the id of an internal service gets 422 at `metadata.id`, "already in use", and a public name taken by one is reported as "already taken", the same text as for a name another organisation holds. The service stays as it was.
- **Console.** `GET /operator/tenants/{tenant}/definitions` marks the service `internal: true`, and the console shows it as Intern.

What this does not hide, honestly:

- The 404 is the same as for an unknown id only where the route itself answers 404 for one. Some routes answer an unknown id with 200 and an empty list or a default, so an internal id can be told apart there by its 404.
- Publishing, importing or validating tells the caller that the id or public name is taken, as it does for any taken id.
- Playground runs carry no service id, so a playground run of an internal service is still listed in the playground log and its timeline opens, with the question, the answer and the model, but without the service named.
- Checks made for a caller who does not see internal services, such as whether a dataset or block is in use, do not count them: an operator keeps an internal service working. Jobs that run outside a request, including the worker, see every service.
