# 0056 A service offers its interface in its definition

Status: proposed, 2026-11-14

Left: a store in genki for a person's choices; an option the owner fixes, so that a host may not change it; texts in more than one language; colours, logos and other theme values; one interface per variant, or several per service; and a flag for it on the rows of `GET /v1/models`. Each needs its own change.

## Context

ADR 0054 made a layout data: `AssistantLayout` version 1 (`packages/ui-blocks/src/builder/layout.ts:35-51`), checked against one catalogue. The layout also carries its words as `profile` (`ProfileData`, `packages/ui-blocks/src/builder/profile.ts:66-79`). ADR 0054 left where a layout is stored, and ADR 0053 expected the service definition.

Today the portal's «Grensesnitt» tab keeps a service's layout in the browser's session storage, and carries it to another browser or a host only as copied JSON (`apps/portal/src/screens/services/blocks/layoutStore.ts:1-3,131-146`). A host that is not the owner's own code, such as the workspace, has nowhere to read it from, and a layout has no versions.

The definition has no slot for it. `spec` and `metadata` are closed (`packages/definitions/src/schema.ts:105,274`; ADR 0007), and `spec.settings` takes only registered settings (`packages/definitions/src/validate.ts:553-560`). ADR 0032 says a client keeps presentation.

Two more needs shape the contract. Owners and hosts want blocks, settings and words the catalogue does not have. And one service is drawn by several hosts for many people: a host draws only part of what the owner offers, and a person may want a block out of their own view.

## Decision

### Where it is stored

- **`spec.interface` is an optional field of a Service definition.** It has one part, `layout`: an `AssistantLayout` version 1 as ADR 0054 defines it, its profile included, with the additions below. The object leaves room for later parts, such as a theme.
- **It is part of the service.** It is saved in the draft (ADR 0051), rebased with it (`apps/api/src/service-drafts.ts:74-94`), published as a new version with a change reason (`docs/api/services.md:27`), exported with the definition (`packages/definitions/src/transfer.ts:14-19`), and an environment serves the interface of the version it points to (`apps/api/src/service-environments.ts:48-65`; ADR 0004). Changing it needs what changing any part of the draft needs (`manage-services`, `apps/api/src/quality.ts:284-286`).
- **Runs ignore it.** No strategy, guardrail or compiled capability reads the interface of the service it runs, and no run of that service checks it. To the service's callers, only the read route below serves it.
- **The words are the layout's profile,** as ADR 0054 defines it: strings in the author's language, collections keyed by the `dataset-config-key` that `_datasets` gives (`apps/api/src/composition.ts:952-959`), and document links as https templates per kind of number. The suggested questions are `spec.exampleQuestions` (`schema.ts:107-115`), which today only the playground offers as questions (`apps/api/src/playground.ts:833`): a profile may set its own `suggestions`, and without them the read route gives the example questions.
- **Everything in it is public to the service's callers.** genki serves it unredacted to every credential that may see the service, and serves each published version's, since a caller may pin one. An owner puts no secrets or personal data in it.

### The owner's default and bounds

The interface in the definition is the groundwork: the owner's default, and the outer bounds of what a host and a person may draw.

- **`zones` is the default:** the blocks that are on, where they stand and with which options, as in ADR 0054.
- **`available` is what may be added.** It is optional and has the shape of `zones`: blocks that are off by default, each in the zone it goes to and with the options it gets when a host or a person turns it on.
- **`required` is what may not be removed.** It is an optional list of ids of blocks that `zones` places. A host or a person may not turn them off.
- **A block that may stand in both its zones is one block.** `required` keeps it in each zone `zones` places it in. It may be placed in one of its zones and available in the other, and it keeps one set of settings, those in `zones`.
- **The bounds are the blocks in `zones` and `available`, and the blocks in `required`.** A block in neither `zones` nor `available` is not drawn by the assembly, whoever asks, and a required block is not left out.
- **A host chooses within the bounds.** It may leave out a block that is not required, turn on an available one, move a block to another zone the catalogue allows, and change a block's options. Its choices are its own code or configuration, and genki does not store them.
- **A person chooses within what the host offers,** for example by taking «Fremgangsmåte» out of their own view, or by turning on an available block the host offers. The host keeps those choices, through the assembly's `AssistantStorage` (`packages/ui-assembly/src/storage.ts:6-12`), which `browserStorage` keeps in the browser (`storage.ts:15-45`). They are never in the definition. A kept choice that the current bounds no longer allow, such as leaving out a block that has since become required, is passed over.
- **Options are defaults, not bounds.** A host may change a block's options, and a person those the host offers.
- **Each layer narrows or moves, and never widens.** Through the assembly, no host or person adds a block outside the bounds or removes a required one. A required block whose needs are not met is still not drawn (`packages/ui-assembly/src/useAssistant.ts:288-294`; ADR 0053).
- **The bounds are about the look, not about access.** genki does not draw, so `@genai/ui-assembly` keeps the bounds. A block left out hides nothing that a reader's credential can read through the API, where rights and grants decide (ADR 0027), and a host that draws `@genai/ui-blocks` itself is not stopped by them.
- **A host that does not know `available` or `required` draws the default.** The assembly reads only the zones, the look or its template, and the profile of a layout (`useAssistant.ts:248,288-298,616`), so an older host draws the placed blocks, as before.

### Room for the host's own

genki allows what the catalogue does not have, in one reserved namespace, rather than forbid it.

- **An id or key that starts with `x-` is the host's:** `x-` followed by lowercase letters, digits and hyphens. genki gives it no meaning, no catalogue id starts with `x-`, and a publish checks only its shape and limits. A name after the host, `x-<host>-<name>`, keeps two hosts' ids apart.
- **A block of the host's own has an `x-` id.** It may stand in any zone, once per zone, in `zones` or `available`, and be listed in `required`. Its settings may have any keys. A host that knows it draws it where it stands. Every other host passes over it, as the assembly asks only for the blocks it knows (`useAssistant.ts:288-307`), and a builder keeps it where it stands and lets it be moved or removed.
- **A setting or a word of the host's own is an `x-` key,** in a block's `settings`, in `profile`, or in a collection of `profile.corpora`, with a boolean or a string as its value. A host that does not know it passes over it, as `isProfileData` already does (`builder/profile.ts:136-154`).
- **An `x-` value is shown as written.** genki does not check it as a link or a text. A host that draws one as a link checks it first, for example with `isHttpsLink` (`builder/profile.ts:191-206`).
- **When several hosts draw the same `x-` block,** it can be proposed for the catalogue under an id without `x-`. The `x-` id keeps working where it is stored.
- **A host's own interface outside the layout is its own.** What it draws around or beside the assembly, such as its header, menus, pages and panels, is not stored, checked or bounded by genki, and a host may ignore `spec.interface` altogether (ADR 0032).

```yaml
spec:
  exampleQuestions: [Hva handler dokumentene i Kudos om?]
  knowledge: { datasets: [{ dataset: digdir/kudos }] }
  interface:
    layout:
      version: 1
      template: knowledge-assistant-next
      look: next
      zones:
        primary: [{ block: threads }, { block: filter }, { block: settings }]
        main: [{ block: approach }, { block: chat, settings: { feedback: true, followUps: false } }]
        secondary: [{ block: approach }, { block: sources }, { block: document-view }]
      available:
        secondary: [{ block: x-ka-glossary, settings: { source: begrepskatalogen } }]
      required: [chat]
      profile:
        assistantName: Kunnskapsassistenten
        settingsNote: Valgene huskes i denne nettleseren.
        corpora:
          kudos:
            label: Kudos
            description: dokumenter fra kudos.dfo.no
            fields:
              - { id: type, label: Dokumenttyper, heading: Dokumenttype }
              - { id: concerned_years, label: År, kind: year, years: { first: 1990 } }
            typeField: type
            typePlurals: { Årsrapport: årsrapporter }
            documentLinks: { digits: 'https://kudos.dfo.no/documents/{id}' }
            about: { idField: doc_num, fields: [type, concerned_years] }
```

## Validation

The catalogue lives in `@genai/ui-blocks`, which the definitions package does not depend on. The check is split in two, so that `@genai/definitions` stays free of UI code and a stored version never stops working because the catalogue changed.

- **The shape is in `@genai/definitions`** (`schema.ts`): closed objects, but for `x-` keys where the rules above allow them; `version: 1`; the three zone names in `zones` and `available`; a block id, a template and a look as lowercase id strings; a setting as a boolean or a string (`layout.ts:26`); the profile's shape as ADR 0054 gives it (`builder/profile.ts:6-79`), written again in zod since the package cannot import it; and the limits below. It names no block, option, template or look. A stored version is parsed against this shape when it loads (`packages/definitions/src/store.ts:48-57`), and one that fails is quarantined as `misconfigured` (ADR 0005), so the shape only ever grows.
  - The `x-` keys survive the parse, since each store saves the parsed definition (`validate.ts:116-119`, `store.ts:314-316`) and a draft is rebased from it (`apps/api/src/service-drafts.ts:45-47`).
  - The rule is written as a pattern on property names, so that it carries over to the JSON Schema that the YAML tab and the builder assistant read, and the test that compares a served schema with its zod schema holds it (`apps/api/src/schemas.test.ts:206`).
  - A test runs every template's layout, with a full profile, through both this shape and `isAssistantLayout`, so the two copies of the profile's shape stay alike.
- **The catalogue rules come through `PluginSchemas`,** as strategy schemas and dataset filters do (`validate.ts:36-57`): a new optional `interfaceProblems(definition)` returns errors and warnings with paths under `spec.interface.layout`. The composition root fills it in its literal (`packages/composition/src/runtime.ts:702-736`), since the stores take a copy of that object (`runtime.ts:835`; `apps/api/src/main.ts:532,538`; `apps/worker/src/main.ts:637,642`), from `layoutProblems` in `@genai/ui-blocks/builder`.
  - **It is not part of `validateDefinition`,** which also checks every test run, playground run and eval (`apps/api/src/draft-runner.ts:425-426`). Those, the drift report and the loading of a stored version, which checks only the strategies (`store.ts:48-51`), never run it.
  - **It runs in each store's publish** (`store.ts:314`, `packages/providers-postgres/src/definitions.ts:80`), which is one path for people, git, imports, the builder assistant and the optimiser (ADR 0005); in `POST /definitions/validate` (`apps/api/src/definitions.ts:116`); and in the builder assistant's check of a proposal.
  - **It checks an interface only when it differs from the latest published version's.** A republish that changes something else, as an operator's sharing does (`apps/api/src/routes/console-routes.ts:163-191`), is never refused for a block the catalogue has since dropped.
- **What it refuses.** A publish is refused on `unknown-block`, `zone-not-allowed`, `placed-twice`, `not-built` and `missing-partner` (`layout.ts:270-284`), checked in `available` as in `zones`, and on ADR 0054's profile rules (`builder/profile.ts:182-187`). `placed-twice` counts `zones` and `available` together, and a partner counts when it is placed or available.
  - `layoutProblems` gains four rules: `unknown-look`; `unknown-option`, a setting that is neither one of the block's options in the catalogue nor an `x-` key; `option-value`, a value of the wrong kind or not among the choices; and `required-not-placed`, a required block that `zones` does not place.
  - An `x-` block meets no catalogue rule but `placed-twice` within one zone and `required-not-placed`.
- **Warnings** never refuse a publish. The validate and publish routes return them beside `definitionWarnings` (`validate.ts:656-666`; `apps/api/src/definitions.ts:350,423`):
  - `needs-unmet`, for the `service:*` needs a definition shows, read with `factsFromDefinition` and `needMet` (`builder/facts.ts:194-233`). `service:steps`, `channel:*` and `genki:*` are not known from a definition and are not checked. A block whose needs are not met is not drawn (`useAssistant.ts:288-294`), and a dataset can gain filter fields without a new version.
  - A field of a collection the service searches that its dataset does not declare, through `plugins.datasetFilters` (`runtime.ts:728`). The assembly does not offer it (`packages/ui-assembly/src/api.ts:500-505`). A collection the service does not search gets no warning: a reader may choose it in the collection picker, where its words are used (`useAssistant.ts:351-375`).
- **What a server may import.** The builder has its own entry, `@genai/ui-blocks/builder` (`packages/ui-blocks/package.json:16-20`), and a test keeps it free of the blocks and the package root (`packages/ui-blocks/src/builder/entry.test.ts:39-45`). But React and Designsystemet are required peers of the package (`package.json:30-34`), the API image installs the production dependencies of the API and the worker (`Dockerfile:25-26`), no dependency rule names the package (`.dependency-cruiser.cjs:3-80`), and the atlas draws any real import as an edge (`scripts/build-atlas.test.ts:88-94`). So:
  - `@genai/ui-blocks` marks its peers optional, as `@genai/i18n` does for its `./react` entry (`packages/i18n/package.json:13-33`);
  - a dependency rule, `ui-blocks-builder-without-react`, keeps every file the entry reaches free of React, `.tsx` files and stylesheets, `src/shell/toolMode.ts` included (`layout.ts:266`);
  - a second rule, `servers-import-ui-blocks-builder-only`, lets `apps/api`, `apps/worker` and the server packages import `@genai/ui-blocks` only through `./builder`;
  - the atlas gains the edge `composition → ui-blocks`.

## Reading it

- **`GET /v1/models/{id}/interface`** returns the interface of the service whose row `id` names, beside `GET /v1/models/{id}/schema` (`packages/adapter-openai/src/app.ts:588-596`).
  - Like that route, it first finds `{id}` among the rows `list` gives the credential, and answers `404 model_not_found` when it is not there (ADR 0030), never `403`. It belongs to the `openai` channel and is not counted against the tenant's call limit (`apps/api/src/composition.ts:1792`; `docs/frontend-contract.md:95`).
  - It then picks the version as a call does (`CapabilityResolver.resolve`, `app.ts:116-124`): `GenAI-Version`, then `GenAI-Environment`, then `prod`, with the version and environment errors of a call (`docs/frontend-contract.md:45-47`). A key bound to environments gets only theirs (`service-environments.ts:70-83`). The response carries `genai-service-version` and `genai-environment`.
  - A paused service's interface is still served: pausing stops runs, not the look.
  - It answers `{ layout }`: the layout as stored, `available`, `required` and `x-` entries included. When the profile sets no `suggestions`, they are the version's `exampleQuestions` in the language `Accept-Language` names, as the playground picks them (`apps/api/src/playground.ts:375,833`), with `vary: Accept-Language`. An example question longer than `profileLimits.question` (`builder/profile.ts:166`) is left out, so the served layout keeps ADR 0054's limits.
  - A version without `spec.interface` is `404 interface_not_found`.
- **`GET /v1/models` does not change.** Its rows are one per variant and alias (`app.ts:537-576`), so an interface on each would repeat, and `list` takes no version or environment (`app.ts:122`), so the rows could not say which version's interface they show.
- **Hosts.** The workspace reads the route with the person's token it already sends (`apps/workspace/src/api.ts:293-300`) for the service it opens, and draws its own chat on `404`. A host's server reads it with its service key, and may set `GenAI-Environment` per request. The portal's builder reads and writes the draft (`GET` and `PUT .../draft`, `apps/api/src/quality.ts:269,284`) where it now uses the browser's session storage, and not the route, since a draft is not published. A host may ignore the route and keep its own presentation.

## A block the catalogue drops

- A published version is immutable (ADR 0005), and its loading never consults the catalogue (above), so the service keeps running and is never marked `misconfigured` because of its look.
- The route serves the layout as stored. A host asks for blocks by the ids it knows (`useAssistant.ts:288-307`), so a block it does not know is not drawn, just as an `x-` block it does not know is not. An option the catalogue no longer has is off (`layout.ts:369-370`), and a template it does not know draws the layout's own look, or the current look when the layout names none (`layout.ts:82-87`).
- The draft keeps the block until someone removes it, and a publish that changes the interface refuses it with `unknown-block`.
- A block, option or template id is never reused for something else. A pull request that drops one says so, as a change to the layout's version 1 (ADR 0054).
- A look, a field kind and a kind of number are never dropped. `isAssistantLayout` refuses a layout whose look it does not know (`layout.ts:423`), and `isProfileData` a profile whose field kind or kind of number it does not know (`builder/profile.ts:101,121`), so a host that checks a stored layout would draw none of it.

## Limits

- Layout: at most 16 blocks in each zone of `zones` and of `available`, and 16 ids in `required`; a block id, template, look, setting key or `x-` key at most 64 characters; at most 32 settings on a block, and 32 `x-` keys in `profile` and in each collection; a string setting or an `x-` value at most 1,000 characters.
- Profile: ADR 0054's `profileLimits`, among them 128 characters for a collection's key or a field's id, and at most 32 KiB (`builder/profile.ts:158-180`).
- The whole `spec.interface`, as JSON in UTF-8, at most 64 KiB.
- The limits are part of the shape, so they may be raised and never lowered: a lower one would quarantine stored versions (ADR 0005).

## The builder assistant

The builder assistant (ADR 0026) may propose JSON Patch operations under `/spec/interface`, as it may anywhere in the draft.

- Its check of a proposal runs `interfaceProblems` with the same `PluginSchemas` (`apps/api/src/composition.ts:1241,1271`; `packages/strategy-builder/src/validation.ts:71-79`), so a proposal with a block the catalogue refuses comes back `rejected` with the rule (ADR 0026). `validation.ts` gains a label for `spec.interface` and words for the layout rules (`validation.ts:81`).
- A valid proposal is applied to the draft directly (`apps/portal/src/screens/services/assistant/useAssistant.ts:72-76`), and ADR 0026 assumes an injected instruction can steer a proposal. The https rule (ADR 0054) keeps a document's number out of a link's host, but does not choose the host.
- So `checkAfter` refuses a proposal that adds or changes a document link, an experiment's link, any `x-` value or any setting of an `x-` block under `/spec/interface`, as it refuses a change to the risk confirmation (`packages/strategy-builder/src/policy.ts:180-192`). Only a person writes those.

## Why

A layout is configuration the builder edits, and genki keeps configuration as definitions the API stores, validates and versions (ADR 0005, ADR 0030). Putting it in the service gives the look the draft, the versions, the rebase and the environments a service already has, so a new look is tried on `test` before `prod` and rolled back with its version, with no new store, right or write route.

Where it is stored, turned down:

- **The `Client` registration** (`packages/identity/src/clients.ts:52-86`). It fits ADR 0032's wording and the change would be small, but a client keeps only its latest version, with no history (`StoredClient` and `ClientStore`, `clients.ts:105-117`), so a look would not follow the service version an environment runs, and nothing rolls back. The workspace calls with a person's token and has no client per service (`apps/workspace/src/api.ts:293-300`), and a browser client needs an OIDC registration (`clients.ts:87-95`), so a look would need a login registration to exist.
- **A per-service config entry,** as `service-environments` is (`service-environments.ts:13,48-65`). No definition change, but its history is not the service's: promoting version 7 to `prod` would not bring version 7's look, unless the entry kept its own pointers per environment. It would also need its own routes, rights and audit actions (`service-environments.ts:383-423`), and the draft, the YAML tab and the builder assistant would not reach it.
- **A new definition kind, `Frontend`.** The fullest separation, and several looks per service. It is also the largest: its own store, versions, drafts, publish path, rights, schemas (ADR 0030), drift report (ADR 0005) and export, and a pointer to the service version it fits, which can disagree with the environment's. Nothing needs several looks per service yet. If something does, the same shape moves into a kind as a copy.
- **A profile beside the layout,** with texts in two languages and links chosen by regular expressions. ADR 0054 keeps the profile in the layout, as data with links per kind of number and no pattern built from stored text. One object is what the builder edits, a host stores and copy and paste carry; two would drift.
- **The catalogue check inside `validateDefinition` or `@genai/definitions`.** It would make the definitions package depend on UI code, and it would run on every test run and eval and when a stored version loads, so dropping a block would stop or quarantine every service that used it.
- **The interface on every row of `/v1/models`,** for the reasons under Reading it.

The owner's default and bounds: the definition is the owner's, so it says what the owner decides and no more. Hosts and people narrow it where they are, without a new version of the service. Turned down:

- **A flag on a placed block, `on: false`.** One list would be shorter, but a host that does not know the flag would draw the block on. With a list of its own, a host that does not know `available` draws the owner's default.
- **The host's and the person's choices in the definition.** Each host and each person would need a version of the service, and an owner would review choices that are not theirs.
- **Bounds on options now.** Nothing asks for an option a host may not change yet. It can be added beside `required` when something does.
- **Refusing blocks outside the bounds in the API.** genki does not draw and cannot see what a host draws, and a check there would look like access control without being one.

Room for the host's own: forbidden, it happens anyway, in host code outside the definition, which no version, environment or review reaches. The `x-` prefix is the convention OpenAPI uses for extensions, and ADR 0030's `x-label` already follows it. Turned down:

- **An open schema.** A typo such as `sorces` would pass and draw nothing. The prefix keeps the schema closed (ADR 0007) and makes the host's own explicit.
- **A registry of custom blocks in genki,** with their options and needs. A store, rights and checks for something only one host understands; a block many hosts want belongs in the catalogue.
- **Any JSON as an `x-` value.** Booleans and strings, as settings are, keep a stored version easy to read, compare and bound. A host that needs more keeps it in its own code.

## Consequences

- On acceptance, ADR 0032 changes from «A client keeps presentation (labels it shows, layout, colours) and its own form state, and nothing else.» to: «A client keeps its own form state and may keep its own presentation (labels it shows, layout, colours), and nothing else. A service may also offer a presentation in its definition, `spec.interface` (ADR 0056): a default and bounds that a client draws within, or ignores.» Its status line notes the change.
- On acceptance, ADR 0054's `Left:` drops where a layout is stored and the suggestions from the service's example questions, and its layout version 1 gains `available`, `required` and `x-` ids and keys, all optional. ADR 0007's closed schema gains one optional field, closed but for the `x-` keys this record allows.
- Layout version 1, the profile's shape, `available`, `required` and the `x-` rules are a stored contract from the first publish that uses them. Changes are additive; a new layout version is accepted beside version 1.
- A change of look is a new service version with a change reason, and without environments set up, `prod` follows every publish (ADR 0004). `definitionSubject` leaves out `interface`, as it leaves out the risk confirmation (`apps/api/src/definition-subject.ts:13-14`), so a change of look alone needs no new eval run under the service's gates.
- A draft save is not validated or capped today (`apps/api/src/quality.ts:284-354`), so the limits apply when a draft is validated or published.
- The builder keeps `x-` entries it does not know. Today `normalised` drops a block the catalogue does not hold (`layout.ts:383-394`), and a pasted layout with one is refused (`layoutStore.ts:38-48`).
- `@genai/ui-blocks` gets optional peers, and `@genai/composition` depends on it through `./builder`. The API image then also installs its icon package, `@navikt/aksel-icons` (`packages/ui-blocks/package.json:26-29`), which the builder entry does not load.
- Every property of `spec.interface` gets labels in bokmål and English (`apps/api/src/schemas.test.ts:80`).
- Not built: the shape and its rules, `interfaceProblems` and its warnings, the route and a method for it in `@genai/client`, the bounds and a place for a host's own `x-` block in `@genai/ui-assembly`, the workspace reading the route, the portal's builder saving to the draft and keeping `x-` entries, the builder assistant's rule and labels, `definitionSubject` leaving out `interface`, and the optional peers, the two dependency rules and the atlas edge. The tests, each with the part it comes with:
  - Shape, `packages/definitions/src/definitions.test.ts`: "an interface is optional", "an interface is closed but for x- keys", "an x- block or key is checked for its shape and limits only", "a publish keeps the x- keys it was given", "refuses an interface past each of its limits" (one row per limit), "an interface over 64 KiB is refused".
  - Both copies of the profile's shape, `apps/api/src/definitions.test.ts`: "every template's layout with a full profile is a valid spec.interface that isAssistantLayout reads back".
  - Catalogue rules, `packages/ui-blocks/src/builder/layout.test.ts`: "an x- block is not an unknown block", "an x- block stands once in a zone", "a block stands once in a zone across zones and available", "a required block is one the zones place, an x- block too", "a partner that is only available counts", "finds a setting the catalogue does not have unless it is x-", "finds an option value of the wrong kind or not among its choices", "finds a look the catalogue does not hold", "keeps an x- block where it stands when it sorts a zone"; and `catalogue.test.ts`: "no block, option, template or look id starts with x-".
  - Publish, in a test that boots the composition root, since `apps/api/src/testkit.ts` builds its own `PluginSchemas`: "a publish refuses a layout the catalogue does not allow", "a publish that leaves the interface as it was is not refused for a block the catalogue has dropped", "a published version whose block left the catalogue can still be tried and evaluated", "a publish with unmet needs or an undeclared field goes through, each as a warning", "a collection the service does not search gets no warning". Also `apps/api/src/quarantine.test.ts` "a stored interface whose block left the catalogue still loads", `apps/api/src/service-drafts.test.ts` "a rebase keeps a draft's x- keys", and `apps/api/src/definition-subject.test.ts` "a change of look alone keeps the subject its eval runs are found by".
  - Route: `apps/api/src/service-schema.test.ts` "a key cannot see the interface of another service or tenant, which is 404, never 403"; `apps/api/src/service-environments.test.ts` "serves the interface of the version the key's environment runs" and "lets a bound key pin only an interface of a version one of its environments runs"; `packages/adapter-openai/src/frontend-contract.test.ts` "a version without an interface is 404 interface_not_found"; `apps/api/src/frontend-contract.test.ts` "gives the example questions in the language Accept-Language names", "varies the interface on Accept-Language", "leaves out an example question longer than a suggestion may be" and "serves the interface of a paused service"; `apps/api/src/key-access.test.ts` "never rate-limits the interface route".
  - Builder assistant, `packages/strategy-builder/src/assistant.test.ts`: "a proposal with a block the catalogue refuses comes back rejected with the rule", "a proposal that adds or changes a link, an x- value or a setting of an x- block under spec.interface is refused".
  - Assembly, `packages/ui-assembly/src/assistant.test.tsx`: "a host or a person cannot turn a required block off", "a block outside the bounds is not drawn", "draws an available block a host turns on, in the zone available gives it", "passes over a kept choice the bounds no longer allow", "an x- block is drawn only by a host that knows it".
  - Dependency rules: `ui-blocks-builder-without-react` and `servers-import-ui-blocks-builder-only`.
