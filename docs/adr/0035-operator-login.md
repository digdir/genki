# 0035 Operator login

Status: proposed, 2026-10-16

## Context

Operators run the console: tenants, catalog, settings, support sessions and audit (ADR 0010). ADR 0008 says operators are Digdir staff with Entra ID, never a tenant principal. Today the API recognises an operator in three ways:

- by token subject, listed in `OPERATOR_SUBJECTS`, for any trusted issuer, Maskinporten included (`apps/api/src/operators.ts`);
- by the `pid` claim of an Ansattporten token, for persons marked `operator: true` in `apps/api/config/local/identity.yaml`;
- in lockdown, by an Entra ID login through Ansattporten whose `groups` claim holds one of `LOCKDOWN_ENTRA_GROUPS` (ADR 0033). That rule also gives the person every right in `PLATFORM_TENANT`, so in genki-test an operator reaches the Digdir tenant's data without a support session.

## Decision

- **Operators log in with Entra ID through Ansattporten,** in every environment, and are recognised by membership of a Digdir Entra group, not by subject. The settings are `OPERATOR_ENTRA_GROUPS` (group object ids) and `OPERATOR_EMAIL_DOMAIN`, both required in production; the API refuses to start without them.
- **Only the console's own client can make an operator.** The operator rule accepts only access tokens whose `client_id` is in `OPERATOR_CLIENT_IDS`. A token from any other client, registered tenant clients included, is never an operator.
- **An operator is never a tenant principal.** Outside lockdown the rule gives the operator role and nothing else: no tenant, no `authorizedFor`. A tenant's content (conversations, documents, runs) is reached only through a support session with a reason and a time limit (ADR 0010). The lockdown grant of every right in `PLATFORM_TENANT` stays specific to genki-test.
- **Two marks, not one.** The verifier sets the operator mark from `OPERATOR_ENTRA_GROUPS` and, in lockdown, the model-access mark from `LOCKDOWN_ENTRA_GROUPS`. genki-test may name the same group in both; the code never derives one from the other. Only the verifier sets either mark, never token scopes, key scopes or headers.
- **Group membership decides, per token.** Adding or removing an operator happens in Entra and needs no deploy. Removal takes effect when the operator's current access token expires, and at the latest at their next login. The API logs which group admitted the operator.
- **MFA is required.** Digdir Conditional Access enforces MFA on the Ansattporten app for operators; if the token carries `amr`, the API requires `mfa`.
- **No other way in, in production.** Operator pids in `identity.yaml` apply only to the mock issuer in dev mode, and startup refuses them otherwise. `OPERATOR_SUBJECTS` holds `issuer|subject` pairs for Ansattporten tokens only, for local development and break-glass: in production the API refuses to start with it set unless `OPERATOR_BREAK_GLASS_UNTIL` names a date at most seven days ahead, and every break-glass login is audited as such.

## Why

Group membership is managed where Digdir already manages access, works without a deploy, and leaves a trail in Entra. A group object id exists only in the tenant that created it, so it shows the account is Digdir's even though the token has no tenant id (the reason ADR 0033 gives). Pinning the client means an operator token can only come from the console's own login. Keeping operators out of tenants keeps ADR 0008 and ADR 0010 true.

Rejected: Altinn rights for operators (operators act across tenants, Altinn rights are per organisation), Entra ID directly against the API without Ansattporten (a second login flow to maintain), and subjects in configuration as the main rule (a deploy per change, unreadable, and today not tied to an issuer).

## Consequences

- Closes the operator criterion in #41 once built.
- Before production, confirm with the Ansattporten team: which clients can obtain `aud=digdir:genai`; that `groups` is passed through only for logins from Digdir's Entra tenant and cannot be shaped by another tenant's configuration; whether tokens carry `amr`; and the access token lifetime. If a tenant id claim becomes available, the API requires it to be Digdir's.
- Production needs a Digdir Entra group for genki operators, owned by someone who reviews it regularly, and Entra logins enabled on the production console client.
- The verifier's Entra branch, tied to lockdown today, is split into the two marks above; this is new code, not only configuration.
- Today operators see tenant metadata across tenants without a support session (definitions, tasks, eval labels, audit, usage). Each of those routes is either documented as metadata or moved behind a support session.
- A user in so many groups that Entra leaves out the `groups` claim cannot log in as operator; the login fails closed.
