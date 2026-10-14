# 0027 Platform rights

Status: accepted, 2026-10-12 (built). Proposed 2026-10-07

## Decision

Access within a tenant is split into five rights, each an action on the platform's Altinn resource (`urn:altinn:resource:digdir-genai-platform`):

| Action                     | Label                   | Needed for                                                                  |
| -------------------------- | ----------------------- | --------------------------------------------------------------------------- |
| `use-services`             | Bruke tjenester         | Invoking services                                                           |
| `manage-services`          | Administrere tjenester  | Definitions, settings, skills, tools and secrets, test sets, keys, adoption |
| `manage-datasets`          | Administrere datasett   | Datasets, pipelines, search engines and engine switches                     |
| `register-building-blocks` | Registrere byggeklosser | Registering building blocks, approving level-3 proposals                    |
| `view-usage`               | Se forbruk og kostnad   | Usage and cost                                                              |

- **Legacy actions still work.** When a token or PDP answer has none of the five actions, `read` maps to Bruke tjenester and Se forbruk og kostnad, and `write` to the four others plus Se forbruk og kostnad. Once any of the five is present, only those count.
- **The rights come from the Altinn PDP.** Ansattporten lists the organisations where the person has access to the resource, without actions. The API asks the PDP which actions the person has for each listed organisation and caches the answer for two minutes. Actions in a token are used as they are. When the PDP fails, the person gets no rights for that organisation.
- **Routes check rights after tenant access.** A route first checks that the principal may act for the tenant at all (404 otherwise), then the right for that action (403 "Du trenger rettigheten «…»").
- **Invoking a service requires `use-services`.** The playground needs Administrere tjenester or Administrere datasett, because it runs drafts.
- **Operators** get every right, but reach a tenant's data only through a support session with a reason (0010).

## Why

Before this, any Altinn action gave full tenant administration. Agencies need to let someone run services, or manage a dataset, without letting them publish services or register code. Altinn already holds who may do what for an organisation, so the rights live there and not in the platform.

## Consequences

- The portal shows the person's rights per organisation and hides or disables what they cannot do; the API is still what enforces it.
- Admin actions check rights too, not only the routes. `adminActionRights` in `apps/api/src/rights.ts` maps every admin action to the right it needs, or to operators only, and `admin.perform` checks it before the handler runs, so a module calling a handler directly gets the same refusal. An action missing from the map needs Administrere tjenester, and a test fails when a registered action is missing. The check applies to people with Altinn actions; operators, support sessions and API keys bound to the tenant keep their access.
