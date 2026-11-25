# 0071 Feature flags

Status: proposed, 2026-11-25 (built)

Left: a flag per service, percentage rollouts and flags in the worker.

## Context

genki goes from a test platform to one environment that agencies depend on (issue #465). A bigger feature must be able to merge while it is off, and be switched on for one tenant or one person without a deploy. Until now each switch was its own code, such as the portal's `usesNewSetup`, or an environment variable that applies to everyone.

## Decision

### Declared in code

- Every flag is one entry in `packages/contracts/src/flags.ts`: its key, a one-line `description`, an `owner`, a `removeBy` date and `selfService`. Adding a flag is adding one entry. `FlagKey` is the union of the keys, so an unknown key is a type error in the API, the portal and the console, and `isFlagKey` refuses it at runtime.
- Every flag is off by default. There is no default-on flag: a flag that should be on for everyone is ready to be removed.
- `selfService: true` lets a person switch the flag for themselves, and a tenant admin (`manage-services`) for the whole tenant. A flag without it is switched only by operators, for risky or platform-level features.

### State

- State lives in `config_entries`, kind `feature-flag`, scope the tenant, id `["<key>"]` for the tenant and `["<key>", "<issuer>", "<subject>"]` for one person in it, with spec `{ on }`. A cleared choice is a deleted version. Each change is a new version with who and why, as for other config entries. No migration: the table exists, so an older revision runs beside a newer one.
- Precedence: the person's choice, then the tenant's, then `GENAI_FLAGS`, then off. A person can turn off for themselves what the tenant turned on. There is no operator override above the person: a flag that must not be turned off per person is not self-service.
- Rows for a key no longer in the registry are ignored, so removing a flag needs no data change.

### API

- `flags.on({ principal, tenant }, key)` on `MountDeps` asks a flag in a route. `requireFlag(mounted, key)` in `apps/api/src/feature-flags.ts` is route middleware that answers `404` exactly like an unknown route while the flag is off for the caller. It takes the tenant from the path, checked like the route checks it, or else the caller's own organisation, or the platform tenant for an operator without one, as `GET /me/flags` does. Writes to flags are serialized in each API process.
- `GET /tenants/{tenant}/me/flags` returns every flag as it applies to the caller: `{ data: [{ key, on, source, selfService, person, tenant }] }`, `source` being `person`, `tenant`, `env` or `default`. `GET /me/flags` is the same for the caller's own organisation, or the platform tenant for an operator without one; the console reads it.
- `PUT /tenants/{tenant}/me/flags/{key}` with `{ on: true | false | null }` changes the caller's own row only; the person is taken from the verified principal, never from the request. Any member may, the reason is optional and a default is stored.
- `PUT /tenants/{tenant}/flags/{key}` changes the tenant's row, needs `manage-services` and a reason.
- Both answer `403` `urn:genai:problem:flag-operator-only` for a flag that is not self-service, also to an operator acting in the tenant, who uses the operator routes instead, and `404` for an unknown key.
- `GET /operator/flags` lists every flag with its description, owner, `removeBy` and every row. `PUT /operator/flags/{key}` with `{ tenant, person?, on }` lets an operator switch any flag for any tenant or person. Both are operator only.
- Every change runs as an admin task, `platform.flag.person` or `platform.flag.tenant`, so it is in the tenant's audit log, and in the portal's change log under settings, with the actor, the level, the target (`flag:<key>` or `flag:<key>:person:<issuer>:<subject>`) and the reason.

### Frontends

- The portal loads `/tenants/{tenant}/me/flags` once per organisation in the shell, and `useFlag(key)` from `apps/portal/src/flags.tsx` answers it. The console loads `/me/flags` once, with `useFlag` from `apps/console/src/flags.tsx`. While the flags load, every flag is off.
- `<FlagsOn flags={[...]}>` turns flags on in a component test, and `withFlags({ tenant: { key: true } })` from the portal's `test-utils.tsx` does it for a test of the whole app.
- The portal's profile has a "Nye funksjoner" section with every self-service flag: a switch for the person, and for a tenant admin a switch for the whole organisation with a reason. It says at which level a flag is on ("På for deg", "På for hele virksomheten").
- The console's Funksjonsbrytere page lists the flags and their rows, and switches any flag for a tenant or a person with a reason.

### Local development

`GENAI_FLAGS=blockStudio,otherFlag` turns flags on for everyone below any stored choice, without a database row. The API refuses to start with it unless `GENAI_DEV_MODE=true`, and refuses a key that is not registered, also in dev mode. It is refused, not ignored, outside dev mode, so it can never decide silently in a shared environment, and dev mode rather than `GENAI_ENV=test` decides because the test tier is the environment agencies use.

### Hygiene

- CI warns on every pull request once a flag is past its `removeBy` date, and the weekly Flag expiry workflow fails until the flag is removed or its date moved. The rule itself is tested with fixed dates in `packages/contracts/src/flags.test.ts`, which also fails when a registered flag is not used anywhere outside the registry.

## Why

- A registry in code, not flags created at runtime, keeps every flag reviewed, typed and findable, and gives it an owner and an end date.
- `config_entries` already gives versioning, who and why, and per-tenant isolation; a new table would have added a migration for no gain.
- A route behind an off flag answers like an unknown route, so a feature in progress is not visible to clients and the API description does not promise it.
- Self-service is per flag, not global, because some switches are safe to try per person and others change the platform for a tenant.
- Turned down: a third-party flag service (another vendor holding tenant data, and a second audit trail), and environment variables per flag (one value for every tenant, a deploy for each change).

## Consequences

- A new flag needs one registry entry, and for a self-service flag a name and text in the portal catalogue's `profile` namespace and in `flagTexts` in `apps/portal/src/screens/NewFeatures.tsx`; `Record<SelfServiceFlag, ...>` makes a missing one a type error.
- A route behind a flag is described in the OpenAPI document like any other route, and its summary names the flag.
- Removing a flag means removing its entry, its uses and its texts. Its rows stay and are ignored.
- The removeBy check does not run as a test, because a test that depends on today's date would fail every pull request on the day a flag expires. CI warns instead, and the weekly Flag expiry workflow fails until the flag is removed or its date moved.
- The first flag is `blockStudio` (owner the lab, removeBy 2027-02-28). Code blocks, their share reviews and the console's review screen are behind it (ADR 0069).
