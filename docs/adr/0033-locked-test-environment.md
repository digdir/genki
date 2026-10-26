# 0033 Locked test environment

Status: accepted, 2026-10-14 (built, 2026-10-14; ingestion locked, 2026-10-15; Entra logins, 2026-10-15; keys and clients from Entra logins, 2026-10-15; security review fixes, 2026-10-15; client allowlist, 2026-10-16)

## Context

genki-test logs people in through Ansattporten TEST. With TestID anyone can log in as any synthetic test person, including the general manager of the organisation that plays Digdir (`PLATFORM_TENANT`). Login does not keep strangers out of test, and every model call costs money.

## Decision

`GENAI_LOCKDOWN=true` locks an environment. It is off by default, and `infra/env/test.bicepparam` turns it on for genki-test.

In lockdown, only a credential from configuration, a trusted Entra login (below) or a credential such a login created may reach a model provider. A credential from configuration is an API key whose secret the API was given at startup (today `DEV_API_KEY` and `DEV_SERVICE_API_KEY`). The API marks such a caller when it authenticates the request, by the digest of the key it presented, so a key made or rotated through the API carries the mark only as described under Keys and clients from Entra logins.

- People (Ansattporten), operators and every other caller get a 403 problem, `urn:genai:problem:locked-environment`, whose title says the environment is locked, on routes that run models: service calls (MCP, OpenAI, A2A, tool calls), playground and test runs, builder assistant turns, eval and batch runs, project runs, the quality matrix, enrichment proposals, diagnostics and skill fixes.
- The same callers get the same problem, with a title that says ingestion is locked, on routes that fetch documents or write new embeddings: running a pipeline (tenant and operator), syncing a connector, starting or retrying an engine switch, and applying hypothetical questions.
- The model port refuses the same callers, so a model call from a route not on that list, a background job or a trigger fails too.
- The worker reads the same setting. It binds no triggers, so a document that lands in a folder or a scheduled trigger starts nothing, and each sync logs that it is locked. Its model port uses the same rule, and the worker runs as a system user without the mark, so any model call it makes is refused.
- The ingestion service refuses to start a run that a credential from configuration did not start. Scheduled runs and the first sync of a new connector therefore do not run; a scheduled run is recorded as failed with the reason and logged.
- People other than a trusted Entra login (below) are read-only: every change, meaning every write that needs a change reason (ADR 0026), gets the same problem with a title saying changes need an Entra ID login. Their own preferences, conversations, feedback and checks that change nothing stay open. API keys and Maskinporten clients keep their normal rights to change configuration. Startup seeding from YAML is unchanged.
- Checks that send a stored secret to an address the caller chooses (a building-block contract test, an operator knowledge endpoint test) are not reads: they get the same problem for people other than a trusted Entra login.
- For the same people, opening a draft with `rebase=clean` shows that it is behind instead of rebasing it, and a batch estimate skips the sample runs and assumes a range.
- One authenticator decides for the lockdown gate and the routes: the routes use the same caller as the gate (API keys excluded from the definition and platform routes, as before). When a locked route gets a credential that resolves to nobody, the gate answers 401 instead of passing the request on.
- `/health` reports `lockdown`, and the portal, console and workspace show a banner. A TestID login is told that changes, models and ingestion need an Entra ID login; an Entra login sees the ordinary locked-environment banner.

The embedding port is not locked, so search keeps embedding queries and reading existing data. Writing embeddings is locked where it starts instead: ingestion runs in the background under a system user, so the embedding port cannot tell who started it, but the start can. Saving a pipeline, including one with a schedule, is configuration and stays allowed.

## Entra logins in lockdown

Ansattporten also offers login with Entra ID (`acr=entraid`). Outside lockdown the API refuses such a login, as before. In lockdown with `LOCKDOWN_ENTRA_GROUPS` set (comma-separated Entra group object ids; the API refuses to start if one is not a GUID), the API accepts an Entra login whose `groups` claim holds at least one of them. When `LOCKDOWN_ENTRA_EMAIL_DOMAIN` is set as well, the `email` claim must also end with `@` and that domain, without regard to case. genki-test sets both, the domain to `digdir.no`. The login must also come from one of the clients in `OPERATOR_CLIENT_IDS` (comma-separated Ansattporten client ids), checked against the token's `client_id`, and never through a client a tenant registered; the API refuses to start in lockdown with `LOCKDOWN_ENTRA_GROUPS` set and `OPERATOR_CLIENT_IDS` empty. genki-test lists the portal, workspace and console clients, since all three use models. The API also reserves these client ids, so no tenant can register a client with one of them.

A trusted Entra login gets the whole platform, so the team can work in test:

- every platform right (ADR 0027) in the platform organisation (`PLATFORM_TENANT`) for the configured Altinn resource, set by the verifier, so the Altinn PDP lookup has nothing to fill in (the token carries no `pid` anyway);
- the operator role, so `/operator` routes and the console open;
- the internal scope `grant:trusted-entra-login`, which lets it use models, run ingestion and change configuration in lockdown, and invoke services in the platform organisation without asking the Altinn PDP. Only the verifier sets this scope: an Ansattporten token's own `scope` claim is never read into the principal, and Maskinporten scopes starting with `grant:` are dropped.

Work such a login starts keeps its admission. Batch, eval and project runs, test runs and resumed tasks run in the API under the person's own principal. The quality matrix, ingestion runs and the re-ingestion of an engine switch run under a system user; when the person who started them may use models, the API gives that system user the configured-credential mark, the same mark a configured key carries. The ingestion service sets it on a run it admitted, and an engine switch records it when it is started or retried. Nothing a caller sends can set it. Work that no person starts stays refused in lockdown, whoever configured it: worker triggers, scheduled ingestion and project subscriptions that run a service on new documents.

An Entra login outside the groups, with an email outside the domain, or from another client, gets a 403 problem `urn:genai:problem:entra-not-trusted` that says so, instead of an empty session. The token lists no organisations, so the portal and workspace ask `GET /me` for the organisations, names and rights of the login, and show the email when the token has no name.

Why groups and not the email alone: the token carries no Entra tenant id, and anyone can create an Entra tenant and give a user any email address, including one at `digdir.no`. A group object id is a GUID that only exists in the tenant that created it, so membership of a Digdir group is evidence of a Digdir account. The email domain is an extra guard, not the gate.

## Keys and clients from Entra logins

An API key created or rotated by a trusted Entra login, and a Maskinporten client registered by one, gets the same configured-credential mark when it authenticates in lockdown, so a team member can hand the KA test backend a key without a redeploy. The API stores `admittedInLockdown` with the key (column `admitted_in_lockdown` in `legacy_api_keys`) or with the client registration, and sets it from the principal that makes the change, never from the request body. `verifyApiKey` and the Maskinporten client admission turn it into the internal scope `grant:admitted-credential`, which the API turns into the configured-credential mark only in lockdown.

- The mark gives model use and ingestion and nothing else. The key keeps its own scopes and bindings: a key bound to a service reaches only that service, it is never an operator, and it gets no platform rights.
- Rotating a key or saving a client again sets the mark anew from the principal doing it, so a rotation or save by anyone else drops it. Revoking works as before.
- Keys and clients made before this change, by an API key, or by anyone outside lockdown have no mark.

This is safe because in lockdown only a trusted Entra login can create a key or register a client at all: TestID logins are read-only, and the mark comes from the creating principal's internal scope, which only the verifier sets. An API key that creates keys passes no mark on.

## Why

Test should stay open for the team to look at, and for configuration to be tried, without letting anyone with TestID spend model tokens. A pipeline run also crawls arbitrary websites from our network and spends embedding tokens without a ceiling, so it is locked the same way. A registered client such as the KA test backend is the only legitimate external user that needs models.

## Consequences

- genki-test has no credential from configuration, so models run there for trusted Entra logins and for the keys and clients they create, such as the KA test backend's key.
- An admitted key stays admitted until it is revoked or rotated by someone else. Removing a person from the Entra group does not revoke the keys they made; revoke them in the portal.
- TestID logins, including test persons who are general manager of `PLATFORM_TENANT` and operators listed in `OPERATOR_SUBJECTS` (`issuer|subject` pairs for Ansattporten logins), can only read in genki-test.
- Who may work in test is decided by Entra group membership in Digdir, not by the platform. Removing someone from the group takes effect at their next token.
- Production does not run in lockdown. It will have a real Kunnskapsassistenten service and a separate test service for KA's test backend.
- A new check that sends a stored secret somewhere goes in `secretSendingChecks`.
- A new route that runs a model goes in `modelRunRoutes` in `apps/api/src/lockdown.ts`, and a new route that ingests or writes embeddings goes in `ingestionRoutes`, so it gets the clear problem and not a failed task.
