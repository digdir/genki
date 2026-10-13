# 0005 Definition store authority

Status: accepted, 2026-10-12 (built). Proposed 2026-10-06

## Decision

- The database is authoritative for service definitions, test sets and settings. Published versions are immutable.
- Definitions kept in git, such as Digdir's own services, are applied through the same publish path as the portal: at startup each file that has no published version is published as the admin task `platform.service.publish` by `platform:seed` and audited in the tenant's log. A definition already in the database is left alone. Git is a client, not a second source of truth, and `GET /operator/definitions/drift` reports each file as in sync, drifted (with the differing paths), not published, or missing from git.
- **Platform wiring** (which plugins exist and how they are connected) is read once at boot and fails fast.
- **Definitions** are tenant data: validated at publish, loaded per invocation by version, and cached.
- A stored definition that no longer validates, for example after a plugin upgrade, is quarantined. Its services report `misconfigured`. It never stops the process for other tenants.

## Why

The plan said both "config is read once at boot" and "tenants edit config in the portal", and had git and a database overlay with no rule for which wins.

## Consequences

- One publish path for humans, git automation, the builder assistant and the optimiser.
- A redeploy never wipes or ignores portal changes.
