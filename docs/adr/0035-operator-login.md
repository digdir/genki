# 0035 Operator login

Status: proposed, 2026-10-16 (partly built, 2026-11-03: `OPERATOR_SUBJECTS` holds `issuer|subject` pairs that count only for Ansattporten employees logging in through `OPERATOR_CLIENT_IDS`; operator pids in `identity.yaml` count only with the dev-mode mock login; support sessions superseded by ADR 0072, 2026-11-25; amended 2026-11-25: the platform login in a portal, workspace or console session counts alongside `OPERATOR_CLIENT_IDS`, and the console no longer renews with `prompt=none`, ADR 0061; `OPERATOR_ENTRA_GROUPS` built without lockdown as the one operator mark, which also gives every right in `PLATFORM_TENANT`, ADR 0033, 2026-11-25)

Not built yet: `OPERATOR_EMAIL_DOMAIN` (the guard is `ENTRA_EMAIL_DOMAIN`, for every group, and optional), `OPERATOR_BREAK_GLASS_UNTIL` and the break-glass audit, the two marks, logging the admitting group per login, and the `amr` check. Outside the mock login, startup ignores operator pids in `identity.yaml` with a log line instead of refusing them.

## Context

Operators run the console: tenants, catalog, settings, organisations and audit (ADR 0010). ADR 0008 says operators are Digdir staff with Entra ID, never a tenant principal. Today the API recognises an operator in three ways:

- by token subject, listed in `OPERATOR_SUBJECTS` as `issuer|subject` pairs, for Ansattporten employees who log in through one of `OPERATOR_CLIENT_IDS` (`apps/api/src/operators.ts`);
- with the dev-mode mock login, by the `pid` claim, for persons marked `operator: true` in `apps/api/config/local/identity.yaml`;
- by an Entra ID login through Ansattporten whose `groups` claim holds one of `OPERATOR_ENTRA_GROUPS` (ADR 0033; `LOCKDOWN_ENTRA_GROUPS` and only in lockdown until 2026-11-25). That rule also gives the person every right in `PLATFORM_TENANT`, so an operator reaches Digdir's data as one of its people, and counts as an operator there too.

## Decision

- **Operators log in with Entra ID through Ansattporten,** in every environment, and are recognised by membership of a Digdir Entra group, not by subject. The settings are `OPERATOR_ENTRA_GROUPS` (group object ids) and `OPERATOR_EMAIL_DOMAIN`, both required in production; the API refuses to start without them.
- **Only trusted clients can make an operator.** The operator rule accepts only access tokens whose `client_id` is in `OPERATOR_CLIENT_IDS` or that come from the platform login in a portal, workspace or console session (ADR 0061). A token from any other client, registered tenant clients included, is never an operator.
- **An operator is never a tenant principal.** Outside lockdown the rule gives the operator role and nothing else: no tenant, no `authorizedFor`. The operator acts in a tenant as an operator, never as one of its people, and reaches its content (conversations, documents, runs) only after giving the day's content reason ([ADR 0072](0072-operators-own-the-platform.md)). The group rule's grant of every right in `PLATFORM_TENANT` (ADR 0033) is the exception, decided for production on 2026-11-25.
- **Two marks, not one.** The verifier sets the operator mark from `OPERATOR_ENTRA_GROUPS` and the model-access mark, which counts only in lockdown, from the same groups and `MEMBER_ENTRA_GROUPS`. As built (2026-11-25) one setting gives both; separate settings remain proposed. Only the verifier sets either mark, never token scopes, key scopes or headers.
- **Group membership decides, per token.** Adding or removing an operator happens in Entra and needs no deploy. Removal takes effect when a new access token is issued without the group: Ansattporten TEST issues 5-minute access tokens, and the BFF renews them with the refresh token. Whether a removal from the group then takes effect at the next renewal or only when the Ansattporten session ends depends on whether Ansattporten reads the groups again on a silent authorisation; that is not yet checked. The API logs which group admitted the operator.
- **MFA is required, and enforced in Entra.** Ansattporten's Entra tokens carry no `amr` (checked 2026-10-16), so the API cannot see how the person authenticated. Digdir Conditional Access must require MFA for the Ansattporten app; if Ansattporten later adds `amr`, the API requires `mfa`.
- **No other way in, in production.** Operator pids in `identity.yaml` apply only to the mock issuer in dev mode, and startup refuses them otherwise. `OPERATOR_SUBJECTS` holds `issuer|subject` pairs for Ansattporten tokens only, for local development and break-glass: in production the API refuses to start with it set unless `OPERATOR_BREAK_GLASS_UNTIL` names a date at most seven days ahead, and every break-glass login is audited as such.

## Why

Group membership is managed where Digdir already manages access, works without a deploy, and leaves a trail in Entra. A group object id exists only in the tenant that created it, so it shows the account is Digdir's even though the token has no tenant id (the reason ADR 0033 gives). Pinning the client means an operator token can only come from the console's own login. Keeping operators out of tenants keeps ADR 0008 and ADR 0010 true.

Rejected: Altinn rights for operators (operators act across tenants, Altinn rights are per organisation), Entra ID directly against the API without Ansattporten (a second login flow to maintain), and subjects in configuration as the main rule (a deploy per change, unreadable, and today not tied to an issuer).

## Consequences

- Closes the operator criterion in #41 once built.
- Checked from a console token in genki-test (2026-10-16): the access token carries `client_id`, and `aud` lists both `digdir:genai` and the client id; it lives 5 minutes; it has `groups` and `email` but no `amr` and no Entra tenant id. Pinning `client_id` therefore does not depend on whether other Ansattporten clients can obtain `aud=digdir:genai`.
- Still to confirm with Digdir IT: that Conditional Access requires MFA for the Ansattporten app. If a tenant id claim becomes available, the API requires it to be Digdir's.
- Production needs a Digdir Entra group for genki operators, owned by someone who reviews it regularly, and Entra logins enabled on the production platform login client.
- The verifier's Entra branch, tied to lockdown today, is split into the two marks above; this is new code, not only configuration.
- Operators see tenant metadata across tenants directly (definitions, eval labels, audit, usage). ADR 0072 classifies every tenant route; the label queue hides judges' reasons without the day's content reason, and sink labels are metadata.
- A user in so many groups that Entra leaves out the `groups` claim cannot log in as operator; the login fails closed.
