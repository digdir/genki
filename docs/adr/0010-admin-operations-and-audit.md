# 0010 Admin operations and audit

Status: accepted, 2026-10-12 (built; lockdown exception for the platform tenant, ADR 0033, 2026-11-03; key creator recorded, 2026-11-10; limits set by operators, 2026-11-12; quota set by approving a quota request, 2026-11-25; support sessions superseded by ADR 0072, 2026-11-25). Proposed 2026-10-06

## Decision

- Admin changes are platform capabilities, such as `platform.service.publish`, `platform.setting.set` and `platform.content.reason`. Each runs as a task. A route whose work needs its own context runs that work inside the task (`admin.within`), and its action cannot be called without the route.
- Who may do what in a tenant is granted in Altinn (0027), not by a platform action, so there is no `platform.access.grant`.
- The audit log is therefore the event log. Every event has an actor: the kernel, a strategy or a principal.
- The portal, the console, git automation, the builder assistant and the optimiser all change things through the same capabilities.
- Operators act in any tenant directly, every change with a change reason, audited as the operator with the tenant as `onBehalfOf`, so it appears in the tenant's own log. Reading a tenant's content needs a reason once per operator, tenant and Oslo day, and every read is audited with it ([ADR 0072](0072-operators-own-the-platform.md)). In the locked test environment an operator also has every right in `PLATFORM_TENANT` as one of its people (ADR 0033).
- The limits Digdir sets for a tenant (settings marked `operatorOnly`, ADR 0006) are changed only by an operator, directly with a change reason (ADR 0072), or for `usage.monthlyTokens` by approving the tenant's quota request, which is the same operator act. An operator sets them from the console's organisation Settings tab; removing one is API-only for now, `DELETE /tenants/{tenant}/settings/{key}`. The audit entry names the operator with the tenant as `onBehalfOf`. The tenant's own people, keys and clients cannot set, remove, pin or import them.

## Why

The plan said both "every change is an event in the log" and "the console API is an inbound adapter", without deciding where admin events belong. Events must belong to a task.

## Consequences

- Policy, quotas and audit apply to admin changes for free.
- No screen can change anything without a task and an audit trail.
- An API key stores the actor who created or last rotated it (`created_by` in `legacy_api_keys`), the same identifier as the audit entry, and the key lists show it, with the person's name when known, only to callers with `manage-services`.
