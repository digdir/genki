# 0065 A service keeps its assistant layout in its definition

Status: proposed, 2026-11-19

Left: the bounds `available` and `required`, and the theme (ADR 0063). Each needs its own change. The menu and pages are ADR 0061's.

## Context

ADR 0054 made an assistant's layout data, `AssistantLayout` version 1 with its profile, and left where it is stored. The portal's «Grensesnitt» tab kept it only in the browser's session storage, per tenant and service, so a layout did not reach another browser, another person or a host, and it had no versions.

The proposal for ADR 0056 in pull request #570 is the prior work this record builds on: the interface lives in the service definition as `spec.interface`, versioned with it, drafted, validated and published per environment, with room for a host's own `x-` blocks. This record takes the part a builder needs to save to the API now, and the changes the hosted assistant asks for: texts in each of the service's languages, and room for a theme, a menu and pages.

## Decision

### Where it is stored

- **`spec.interface` is an optional, closed field of a Service definition** (`packages/definitions/src/service-interface.ts`). Its parts now are `layout` and `icon`, an optional base64 `data:` address of a PNG or SVG image, at most 24 KiB, which the public host answer returns (ADR 0061). A theme (ADR 0063 as proposed), a menu and pages (ADR 0061 as proposed) are later fields beside it.
- **It is part of the service.** It is saved in the draft (ADR 0051) through `GET` and `PUT /tenants/{tenant}/services/{id}/draft`, rebased with it, checked by `GET .../draft/checks`, published as a new version with a change reason, and an environment runs the version, and so the interface, it points to (ADR 0004). Saving it needs no new store, route or right; the routes that read it are under Consequences.
- **Reading and writing it needs what the draft needs.** A member of the tenant reads the draft; `manage-services` writes it. A caller from another tenant gets `404`, as for any draft.
- **Runs ignore it.** No strategy, guardrail or capability reads it, and `definitionSubject` leaves it out, so a change of look alone keeps the eval runs a publishing gate looks up.
- **Everything in it is public to the service's callers** once a route serves it, and the name, menu and pages to anyone on a hostname genki hosts. An owner puts no secret or personal data in it.

### The layout's shape

- `version: 1`, an optional `template` and `look`, `zones` with exactly `primary`, `main` and `secondary`, each a list of placed blocks, and an optional `profile`, as ADR 0054 has them.
- **A block id** is lowercase letters, digits and dashes. An id that starts with `x-` is a host's own block. genki gives it no meaning; only a host that runs its own code draws one (ADR 0061 as proposed), and the generic host and the builder do not.
- **A setting** is a boolean or a string, under a key of letters, digits and dashes; an `x-` key is a host's own.
- **A text in the profile** is one string for every language, or `{ nb, en }`, one per language of the platform, as `spec.exampleQuestions` are. Ids, links and field names are not texts.
- **An experiment's link** is an `https` address whose host comes before `{id}`, as `isHttpsLink` checks in the builder. **A document link** is that, or a path on the host's own site (`/` first, never `//` or a backslash, as `isSitePath` checks), so a hosted assistant links to its documents under whatever hostname draws it, such as `/api/datasets/kudos/documents/{id}/file`.

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
- **The catalogue check in `@genai/definitions`.** It would make the definitions package depend on UI code, and a block the catalogue drops would quarantine every version that used it. The check is the API's, on publish and validate; the definitions package holds only the list of block ids, kept alike with the builder's by a test.
- **The bounds `available` and `required` now.** No host draws them yet, and the closed shape can gain them later without a new layout version.
- **Building on pull request #570 itself.** It stays a proposal, and this record credits it; #570 may be closed when this record makes it obsolete.

## Consequences

- Built: the shape and its limits, labels in bokmål and English for the schema form, `definitionSubject` leaving out `interface`, the builder saving to and opening from the draft, and the offer for a layout kept in the browser. Tests: `packages/definitions/src/definitions.test.ts` ("a service interface (spec.interface)"), `apps/api/src/service-drafts.test.ts` ("a service's interface in its draft", including refusal for another tenant and for a member without `manage-services`), `apps/api/src/definition-subject.test.ts`, `packages/strategy-builder/src/interface-layout.test.ts` and `apps/portal/src/screens/services/blocks/interface.test.tsx`.
- Built since: the catalogue check on publish and validate (`apps/api/src/interface-catalogue.ts`), which refuses a block the catalogue does not hold, and an `x-` block while a hosted Client draws the service; the list of catalogue blocks is `catalogueBlockIds` in `@genai/definitions`, kept alike with the builder's `blockIds` by `packages/strategy-builder/src/interface-layout.test.ts`. A publish reports refused blocks together with a missing dataset. `GET /v1/models/{id}/interface` answers the interface of the version the caller's environment runs, with `Cache-Control: private, no-store`, to a caller that may invoke the service; a caller that cannot resolve the model gets `404 model_not_found`, and a service with no layout `404 interface_not_found`. `menu` and `pages` in the shape (ADR 0061).
- Built since: `GET /v1/hosts/{hostname}` and `GET /v1/hosts/{hostname}/pages/{id}` (`apps/api/src/hosts.ts`), public and cached 60 seconds, for a hostname the operator has opened to the tenant in `GENAI_HOSTED_HOSTNAMES` and a hosted Client claims, whose environment points to a version with a layout. Every other hostname or page gets the same `404` with `urn:genai:problem:host-not-found` and `no-store`, so the answer does not tell why.
- What the public route reveals is decided: only what the page needs before login, the tenant's organisation number, the service id, the environment, the assistant's name, the issuer, OIDC client id, audience and Altinn resource (all public in any login redirect), the languages of the service the host has words for (`nb`, `en`, in the service's order, bokmål when none), the menu and the page titles. `theme` is `null`, Designsystemet's default theme, until ADR 0063 is built. Not the Client's registration id, the version, the layout or its profile, which come after login from the interface route.
- Built since: the host app logs in with what the route names and draws the layout (`apps/assistant`), and genki's own assistant hostname (`GENAI_ASSISTANT_HOSTNAME`, `assistant.genki-test.digdir.cloud` in test) is the one name in genki's zones a hosted Client may claim, still only once `GENAI_HOSTED_HOSTNAMES` opens it to the tenant.
- Built since: a document link may be a path on the host's own site (`packages/definitions/src/service-interface.ts`, `isDocumentLink` in `@genai/ui-blocks`, `documentLink` in `@genai/ui-assembly`), and `GET /api/datasets/{id}/documents/{doc}/file` opens a cited document for a frontend with the access of `/api/datasets/{id}`: the uploaded original, only to a caller of the organisation that owns the dataset or a frontend of its service, a PDF inline with `frame-ancestors 'self'` and anything else as a sandboxed attachment; otherwise a `302` to the source's own http or https address without credentials or fragment, for a dataset whose documents come from a remote source. With `Accept: application/json` it says what the file is (`kind`, `mediaType`, and `url` for a source), so a host with a bearer token can decide before it frames it. genki does not fetch a remote source's file itself, except a PDF the record lists on an origin the operator allows ([ADR 0066](0066-genki-serves-a-cited-remote-pdf.md)).
- Tests: `apps/api/src/hosts.test.ts` ("the assistant host", "the interface catalogue", "a service's interface"), `packages/definitions/src/definitions.test.ts`, `packages/adapter-rest/src/rest.test.ts` ("a document file"), `apps/api/src/document-originals.test.ts`, `packages/ui-blocks/src/builder/profile.test.ts` and `packages/ui-assembly/src/links.test.ts`.
- Built with #901: `icon`. Tests: `packages/definitions/src/definitions.test.ts` (the icon tests) and `apps/api/src/hosts.test.ts` ("gives the service’s icon for the browser tab before login").
- Not built: `available` and `required`, the theme, editing texts per language in the builder, and the builder assistant's rule for links and `x-` values under `/spec/interface`.
- A stored interface is a contract from its first publish. Changes to its shape are additive.
