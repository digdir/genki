# 0065 A service keeps its assistant layout in its definition

Status: proposed, 2026-11-19

Left: a check of the layout against the block catalogue when a version is published; `GET /v1/models/{id}/interface`; the bounds `available` and `required`; and the theme, menu and pages. Each needs its own change.

## Context

ADR 0054 made an assistant's layout data, `AssistantLayout` version 1 with its profile, and left where it is stored. The portal's «Grensesnitt» tab kept it only in the browser's session storage, per tenant and service, so a layout did not reach another browser, another person or a host, and it had no versions.

The proposal for ADR 0056 in pull request #570 is the prior work this record builds on: the interface lives in the service definition as `spec.interface`, versioned with it, drafted, validated and published per environment, with room for a host's own `x-` blocks. This record takes the part a builder needs to save to the API now, and the changes the hosted assistant asks for: texts in each of the service's languages, and room for a theme, a menu and pages.

## Decision

### Where it is stored

- **`spec.interface` is an optional, closed field of a Service definition** (`packages/definitions/src/service-interface.ts`). Its one part now is `layout`. A theme (ADR 0063 as proposed), a menu and pages (ADR 0061 as proposed) are later fields beside it.
- **It is part of the service.** It is saved in the draft (ADR 0051) through `GET` and `PUT /tenants/{tenant}/services/{id}/draft`, rebased with it, checked by `GET .../draft/checks`, published as a new version with a change reason, and an environment runs the version, and so the interface, it points to (ADR 0004). No new store, route or right.
- **Reading and writing it needs what the draft needs.** A member of the tenant reads the draft; `manage-services` writes it. A caller from another tenant gets `404`, as for any draft.
- **Runs ignore it.** No strategy, guardrail or capability reads it, and `definitionSubject` leaves it out, so a change of look alone keeps the eval runs a publishing gate looks up.
- **Everything in it is public to the service's callers** once a route serves it. An owner puts no secret or personal data in it.

### The layout's shape

- `version: 1`, an optional `template` and `look`, `zones` with exactly `primary`, `main` and `secondary`, each a list of placed blocks, and an optional `profile`, as ADR 0054 has them.
- **A block id** is lowercase letters, digits and dashes. An id that starts with `x-` is a host's own block. genki gives it no meaning; only a host that runs its own code draws one (ADR 0061 as proposed), and the generic host and the builder do not.
- **A setting** is a boolean or a string, under a key of letters, digits and dashes; an `x-` key is a host's own.
- **A text in the profile** is one string for every language, or `{ nb, en }`, one per language of the platform, as `spec.exampleQuestions` are. Ids, links and field names are not texts.
- **A document link or an experiment's link** is an `https` address whose host comes before `{id}`, as `isHttpsLink` checks in the builder.

### Limits

- The profile keeps ADR 0054's `profileLimits` and 32 KiB. A test in `packages/strategy-builder/src/interface-layout.test.ts` keeps the two copies of the limits alike, and runs every template's layout with a full profile through the definition's shape.
- At most 16 blocks in a zone, 32 settings on a block, and 1,000 characters in a string setting.
- The whole `spec.interface`, as JSON in UTF-8, at most 256 KiB.
- A draft save is not checked; the limits apply when the draft is checked or published. They may be raised and never lowered, since a lower one would quarantine stored versions (ADR 0005).

### The builder

- **The «Grensesnitt» tab saves to the draft.** A change the person makes writes the layout into `spec.interface.layout`, and the draft saves it as any other change. Opening the tab writes nothing.
- **A block the draft cannot back yet is stored where it was chosen.** The builder holds it off in its preview and puts it back once the draft can back it, after a reload too.
- **A layout the builder cannot edit without losing something is not edited.** When the draft's layout has texts per language, an `x-` block or a block the catalogue refuses, the tab says so and points to the YAML, and writes nothing.
- **A layout kept in the browser before is offered once.** When the draft has no layout and the browser kept one, the tab opens it and offers «Lagre i utkastet» or «Forkast». Saving it or changing it writes it into the draft and forgets the browser's copy; discarding forgets it and starts from the template.
- A layout changed elsewhere, by another person, another tab or the YAML, starts the builder again from the draft.

## Why

A layout is configuration, and genki keeps configuration as definitions it stores, validates and versions (ADR 0005, ADR 0030). In the service, the look gets the draft, the rebase, the versions and the environments a service already has, so a new look is tried on `test` before `prod` and rolled back with its version.

Turned down:

- **Keeping it in the browser.** It reaches no other browser, person or host, and has no versions.
- **The `Client` registration or a config entry per service.** Neither follows the version an environment runs, as ADR 0056's proposal sets out.
- **Texts in one language.** genki is in bokmål and English, a service names its languages in `spec.languages`, and a hosted assistant follows the person's language.
- **The catalogue check in `@genai/definitions`.** It would make the definitions package depend on UI code, and a block the catalogue drops would quarantine every version that used it. It comes with the read route, as ADR 0056 proposes, through `PluginSchemas` on publish.
- **The bounds `available` and `required` now.** No host draws them yet, and the closed shape can gain them later without a new layout version.
- **Building on pull request #570 itself.** It stays a proposal, and this record credits it; #570 may be closed when this record makes it obsolete.

## Consequences

- Built: the shape and its limits, labels in bokmål and English for the schema form, `definitionSubject` leaving out `interface`, the builder saving to and opening from the draft, and the offer for a layout kept in the browser. Tests: `packages/definitions/src/definitions.test.ts` ("a service interface (spec.interface)"), `apps/api/src/service-drafts.test.ts` ("a service's interface in its draft", including refusal for another tenant and for a member without `manage-services`), `apps/api/src/definition-subject.test.ts`, `packages/strategy-builder/src/interface-layout.test.ts` and `apps/portal/src/screens/services/blocks/interface.test.tsx`.
- Not built: the catalogue check on publish, `GET /v1/models/{id}/interface`, `available` and `required`, the theme, the menu and pages, editing texts per language in the builder, and the builder assistant's rule for links and `x-` values under `/spec/interface`.
- A publish refuses a layout past a limit, but not yet a block id the catalogue does not hold. A host draws only the blocks it knows, so such a block is not drawn.
- A stored interface is a contract from its first publish. Changes to its shape are additive.
