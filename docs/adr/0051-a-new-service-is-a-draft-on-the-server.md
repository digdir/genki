# 0051 A new service is a draft on the server

Status: proposed, 2026-11-03

## Context

The builder saved the draft of a published service on the server (`PUT /tenants/{tenant}/services/{id}/draft`), but a service that had never been published lived only in the builder's memory. A reload, a closed tab or another browser lost it, and it never showed under Tjenester.

## Decision

- **A new service is saved as a service draft from its first change,** the same entry a published service's draft uses: config entry kind `service-draft`, scoped to the tenant, with `baseVersion: 0`. Opening the builder saves nothing; the first change, the person's or one the builder assistant applies, does.
- **The draft has an id of its own until it is published.** The client picks it; the portal uses `utkast-` and eight hex digits. The name, and the id the service is published under, can change until the first publish. The portal publishes under the id from the name, then deletes the draft, and opens the published service.
- **`GET /tenants/{tenant}/service-drafts` lists the tenant's drafts,** newest first: `id`, `name` (null until the draft is named), `purpose`, `outputKind`, `latestVersion` (null for a service never published), `revision`, `at`, and who saved it last (`by`, `byName`). Any member of the tenant reads it, as with one draft; saving and discarding need `manage-services`.
- **The draft belongs to the tenant,** as the service will. Every save records who made it, and the audit log has each one. The browser holds no copy a person could lose: the playground's remembered setups in `localStorage` keep no definition.
- **A draft of a service never published can be deleted from its page.** «Slett utkastet» asks for confirmation on the page, then calls `DELETE /tenants/{tenant}/services/{id}/draft` with the revision it last saw and returns to the list. It is offered only to someone with `manage-services`, and only once the draft is saved. The draft of a published service is not deleted this way.
- **`GET /tenants/{tenant}/services` stays the list of published services.** Key bindings, the code examples and the admin MCP read it as services that can be called.

## Why

People expect work in progress to be kept where they work, from any browser, as the draft of a published service already is. The alternatives were turned down:

- Browser storage keeps the work in one browser and loses it with cleared site data.
- Unpublished services in `GET .../services` would show up as callable services to every reader of that list.
- An id fixed from the name at the start would either keep a name typed later out of the id, or leave the draft behind when the service is renamed.
- A draft only its creator can see would be a new access rule; the draft of a published service is shared in the tenant.

## Consequences

- A draft that is never published stays in the list until someone deletes it.
- The tests are `apps/api/src/service-drafts.test.ts` ("the list of service drafts") and `apps/portal/src/screens/services/live-builder.test.tsx` ("a new service saved as a draft on the server").
