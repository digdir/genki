# 0010 Admin operations and audit

Status: accepted, 2026-10-12 (built). Proposed 2026-10-06

## Decision

- Admin changes are platform capabilities, such as `platform.service.publish`, `platform.setting.set` and `platform.support.open`. Each runs as a task. A route whose work needs its own context runs that work inside the task (`admin.within`), and its action cannot be called without the route.
- Who may do what in a tenant is granted in Altinn (0027), not by a platform action, so there is no `platform.access.grant`.
- The audit log is therefore the event log. Every event has an actor: the kernel, a strategy or a principal.
- The portal, the console, git automation, the builder assistant and the optimiser all change things through the same capabilities.
- Operators act across tenants only through support sessions with a reason and a time limit. The session appears in the tenant's own log.

## Why

The plan said both "every change is an event in the log" and "the console API is an inbound adapter", without deciding where admin events belong. Events must belong to a task.

## Consequences

- Policy, quotas and audit apply to admin changes for free.
- No screen can change anything without a task and an audit trail.
