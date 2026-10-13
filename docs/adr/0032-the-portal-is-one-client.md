# 0032 The portal is one client

Status: accepted, 2026-10-12 (built, 2026-10-13)

Left: `GET .../definitions/template` takes no job, so the job presets a new service starts from (answers, drafts, extracts and so on) exist only in the portal's mock data. A live builder starts every job from the same API template. Draft saves are not completed, on purpose: a draft is the person's work in progress, and completing it on save would freeze a field id while its label is still being typed.

## Decision

The platform is headless. Everything an admin UI needs to build, edit, rebase and publish a service is an API route documented in `/openapi.json`. The portal, the console and any UI another agency or an LLM builds use the same routes. A client keeps presentation (labels it shows, layout, colours) and its own form state, and nothing else.

What moved out of the portal:

- **Rebase on open.** `GET /tenants/{tenant}/services/{id}/draft?rebase=clean` rebases a draft built on an older published version when the three-way merge is clean, and returns the conflicts for the person to choose when it is not.
- **Strategy catalogue.** `GET /tenants/{tenant}/definitions/strategies` lists the ways of working with their names, steps, default per way of working, starting config and schema link. Strategy settings are rendered from `/schemas/Strategy.{id}@1`; the portal has no hand-written field list.
- **Step block names and param labels.** `GET /tenants/{tenant}/step-flows/blocks` returns `title`, `summary` and labelled param schemas in bokmål and English.
- **Derived values.** `POST /tenants/{tenant}/definitions/complete` fills in residency from the model, form field ids from labels, the starting strategy config, human approval for high risk, and drops required sources from a fields output. The portal publishes the completed definition, and a test run completes the draft the same way before it runs. Validation refuses required sources on a fields output.
- **Editing.** The portal's editor state is the Service definition itself. Form helpers read and write definition paths (`apps/portal/src/data/service-form.ts`), and fields the form does not know are kept as they are. Two sub-editors that take text lists (the input form and the table columns) keep the typed text locally and write the definition on every change.

The portal's mock serves snapshots of these routes, and an API test fails when a snapshot differs from the route.

## Why

The repository moves to a public Digdir repository where large cross-cutting changes are not allowed. Rules that live only in the portal drift (the portal offered a `batch` strategy the API refuses, guessed `norway` for unknown models, and missed a reserved field id) and cannot be used by another UI.

## Consequences

- A new rule about what a definition may contain or derives goes in the API, with a test whose name states it, and in `docs/api/services.md`.
- Labels for platform things (strategies, blocks, schemas) come from the API in both languages; portal i18n keeps screen copy only.
