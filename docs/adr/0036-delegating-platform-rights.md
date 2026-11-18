# 0036 Delegating platform rights

Status: proposed, 2026-10-16

## Context

ADR 0027 splits access within a tenant into five rights, each an action on genki's Altinn resource, and gets them from the Altinn PDP. It does not say how an organisation gives those rights to its people. The test resource `urn:altinn:resource:digdir-genai-platform-test` is published in tt02 with a policy that gives the general manager (DAGL) `read` and `write`.

ADR 0027's mapping turns `read` into Bruke tjenester and Se forbruk og kostnad, and `write` into the four other rights, but only in the rights lookup at login. Invoking a service asks the PDP for `use-services` directly, so under today's tt02 policy a DAGL sees "Bruke tjenester" and is still refused when invoking. The local mock hides this, because its PDP applies the mapping itself; it also gives every action to DAGL and LEDE and uses two access packages that do not exist in Altinn.

## Decision

- **The general manager gets the five rights by default.** The policy gives DAGL all five actions directly, so an organisation can start without any delegation.
- **Everyone else gets single rights by delegation.** The organisation's access manager delegates one or more of the five actions on genki's resource to a person in Altinn's access management. No other role gets anything by default, not even LEDE or the chair: an agency decides who runs AI services.
- **`read` and `write` are DAGL-only and not delegable.** Delegating `write` would give four rights at once. They stay in the policy only until no token or client depends on them, then they and ADR 0027's mapping are removed.
- **`register-building-blocks` is high-risk.** Registering a building block lets the holder configure outbound calls that use the tenant's secrets. The guide tells organisations to delegate it only to people they would trust with every tenant secret. A tenant secret is used only for the hosts it is set for, and changing those hosts needs `manage-services` (ADR 0015).
- **Access packages come later.** When Altinn offers a fitting package, or one is created with the Altinn team, the policy grants the five actions to it as well. Until then genki depends on no package.
- **The mock follows the real policy.** `identity.yaml` gives DAGL the five actions, gives delegated test persons their rights through `party.resources`, keeps one LEDE test person with no rights, and drops the invented packages. The mock PDP stops mapping `read` and `write` itself.

## Why

Starting from DAGL means a new organisation can try genki the day the resource is available, without first learning Altinn delegation, while the decision about who else gets access stays with the organisation, in the tool it already uses for other public services. Single rights fit the five actions, which are deliberately small (ADR 0027). Giving LEDE or other roles rights by default would hand AI administration to people the organisation never chose.

Rejected: roles for everything (too coarse, and roles differ between organisation types), and access packages now (none fits, and creating one takes longer than the pilot).

## Consequences

- The tt02 policy is updated to grant the five actions to DAGL and make them delegable, with `read` and `write` DAGL-only; the production resource is created the same way.
- A new or revoked right takes effect within about four minutes: the rights lookup and the per-action decision each cache for two minutes. The tt02 test for #42 measures both grant and revoke. PDP errors fail closed: the person gets no rights for that organisation.
- Delegation governs people logging in through Ansattporten only. Trusted Entra logins (ADR 0033) and machine clients and API keys bound to a tenant keep full access in their tenant and are controlled by who may create those credentials.
- A person Ansattporten lists for an organisation without any of the five rights can open the tenant and see what routes without a right requirement show. Before production, those routes are listed, or entering a tenant requires at least one right.
- `docs/` gets a short guide for organisations: who has access from the start, how to give an employee one of the five rights, and why `register-building-blocks` needs care.
- To be confirmed with Digdir's Altinn team before this is accepted: that the five actions can be delegated one by one on this resource, and the plan for access packages.
