# 0067 Interface blocks are Block definitions

Status: proposed, 2026-11-20 (partly built)

Left: the declarative renderer and its element set, sandboxed code blocks with their bridge, block origin and bundle store, the named host channels and the field list a block may read, Block Studio, and the genki-admin tools for blocks. Each needs its own change; this record fixes the contract they build on.

## Context

A hosted assistant (ADR 0061) draws a service's layout (ADR 0065) from a fixed catalogue of blocks that genki builds as React components in `@genai/ui-blocks` and wires by hand in `packages/ui-assembly/src/Assistant.tsx`. The block ids live twice, in `builder/catalogue.ts` and in `catalogueBlockIds` in `@genai/definitions`, and a new block, a new variant or a changed text is a pull request into genki. ADR 0053 made blocks "data in, events out" and ADR 0054 made the layout data, but a block itself has no record of its own: no owner, no version, no sharing and no way to be published without a developer.

The adopted direction: one publish path for everyone, designers included. A designer or owner saves a block on test, tries it in the real app and promotes it with a reason and an audit entry. genki's own blocks travel the same path. Only the host and core (frame, chat shell, block registry, renderer, sandbox, bridge, named channels and the field list) are code changes by developers.

## Decision

### A kind of its own

- **An interface block is a definition of kind `Block`** beside `Service`, `StepFlow` and `Skill` (`blockDefinition` in `packages/definitions/src/schema.ts`). It has the same `apiVersion`, `metadata` (`tenant`, `id`, `name`, `version`) and store as the other kinds (ADR 0005), so it gets versions, validation, a change reason and the audit log without a new store, table or right.
- **It goes through the definition API.** `POST /definitions/validate` checks it, `POST /definitions` publishes it with `change-reason`, and `GET /tenants/{tenant}/definitions/blocks/{id}` and `.../versions/{version}` read it. The operator's `/operator/tenants/{tenant}/definitions/blocks/...` reads it too. Tenancy and rights are the existing ones: a member of the tenant reads, `manage-services` validates and publishes, and another tenant gets `404` on the reads and `403` on validate and publish. An export of a tenant carries its blocks, before its services.
- **A published version never changes.** A new look is a new version.

### The manifest

`spec` is closed and framework-free: JSON a host reads, never code genki runs.

- `tier`: `built-in`, `declarative` or `code`.
  - `built-in`: drawn by a component the host already has. `builtIn` names it, one of `catalogueBlockIds`, and only this tier has `builtIn`. genki's catalogue blocks are the built-in tier.
  - `declarative`: a template from a fixed element set the host draws. Reserved.
  - `code`: a built bundle drawn in a sandboxed frame from a separate registrable domain, with no token and a narrow message bridge. Reserved.
- `title`, and optionally `summary`: a text per language, as a map keyed by `nb`, `nn` and `en`; `nb` is required. Nynorsk is one more key, not a new shape.
- `zones`: the zones it may stand in, `primary`, `main` and `secondary`, at least one, each once.
- `sharing`: `private` (the publisher's own services), `organisation` or `everyone`; `private` when left out.
- `props`: a JSON Schema object with ADR 0030's `x-label` and `x-widget`, at most 32 properties and 32 KiB; a required prop must be one of them. The portal draws the block's settings from it with the same schema form it uses elsewhere.
- `events`: what the block may ask the host to do, from the list the host carries out: `ask`, `open-document`, `set-filter`, `open-page`, `notify`, `resize`. A block cannot invent an event. Writes are the host's (ADR 0054); a block never calls the API.
- `states`: the states it draws, from `empty`, `loading`, `error`, `partial`, `disabled`, `filled`.
- `texts`: the block's own words, per language, at most 200 keys per language, 1,000 characters each and 64 KiB in all.

### Draft, try and promote

- **A version is saved, tried on test and promoted through the service that pins it.** A block is not deployed on its own: a service's layout pins a version of it, the pin is part of the service draft (ADR 0051) and of the service version, and the version moves from `test` to `prod` with the service by ADR 0004's promote, with a reason and an audit entry. A tester sees the new block on the test hostname (ADR 0064) while `prod` keeps the version it pinned.
- **A layout pins a block by reference.** A placed block in `spec.interface.layout` gains `ref: "<publisher>/<id>@<version>"`, where the publisher is the organisation number of the tenant that published it. A shared block's author never changes someone else's service: a newer version shows as an update the owner takes in a draft.
- **Block Studio keeps a working copy before the first save.** Until it exists, saving is publishing a version, which nothing draws before a service pins it.

### Who publishes and shares

- **genki publishes its own blocks** through the same path, shared with everyone. genki's catalogue blocks are the built-in tier; genki may also publish declarative or code blocks, as any publisher does. Only an operator, or the platform's seed, publishes a `built-in` block; anyone else gets `403` `urn:genai:problem:share-operator-only` with the path `spec.tier`, from `POST /definitions/validate` as from `POST /definitions` and the tenant import, so validate and publish agree.
- **One person and the audit log at every level** (proportionate controls): the publisher with `manage-services` publishes `private` and `organisation` blocks after the automatic checks.
- **Sharing with everyone:** a `declarative` block is listed at once after the automatic checks, and an operator may unlist it afterwards. A `code` block is shared with everyone only by an operator, after one Digdir reviewer has read its source and what it reads; anyone else gets `403` `urn:genai:problem:share-operator-only` with the path `spec.sharing`. A new version that widens a code block's data or events needs the review again.

## Why

Sharing and pinning need a thing of their own, as step flows did (ADR 0031, ADR 0050). Inside each service's `spec.interface` a block could not be shared, versioned apart from the service or reused, and every service would carry a copy. As a definition kind it reuses the store, the versions, the reason, the audit log, export and import, and the routes and rights a tenant already has, so nothing new needs securing in the API for it.

The manifest is JSON so a host in any framework can read it, and so React can be replaced later without breaking a published block. Texts as a language map leave room for nynorsk without a new shape. Events from a closed list and no API access keep the rule of ADR 0053 and 0054 that data comes in and writes are the host's, for blocks genki did not write too.

Pinning through the service version means a block reaches `prod` only the way everything else in a service does, through test and a promote, and rolls back with the service.

Turned down:

- **A pull request lane for designers.** It is the cost the current catalogue shows: every block change touches the 1,300-line assembly, and reviews fix data, texts and tokens a manifest could have checked.
- **Blocks inside `spec.interface`.** No sharing, no version of their own, a copy per service.
- **A separate store and routes for blocks.** They would need their own tenancy, rights, audit and export, all of which the definition store already has.
- **Accepting `declarative` and `code` blocks before a host draws them.** A stored block nothing can draw would look published and do nothing; both tiers are refused until their renderer is built.
- **Review before listing for every shared block.** Declarative blocks are drawn by the host, so they cannot run code or reach data; review is kept for code blocks, where it buys something.

## Consequences

- Built: the `Block` kind, its manifest, limits and checks (`packages/definitions/src/schema.ts`, `checkBlock` in `validate.ts`), the `blocks` segment on the tenant's and the operator's definition routes, blocks in the tenant export before services, and the operator-only rule for `built-in` blocks (`blockPublisherProblems` in `apps/api/src/admin.ts`). Tests: `packages/definitions/src/block.test.ts` and `apps/api/src/block-definitions.test.ts` ("refuses a built-in block from anyone but an operator, since the built-in blocks are genki's", "refuses on validate, as on publish, a built-in block from anyone but an operator", "hides a tenant's blocks from another tenant", "refuses an import with a built-in block from anyone but an operator, and writes nothing"), and `apps/api/src/building-blocks.test.ts` ("keeps a platform Block definition out of another tenant's building blocks and counts"). Byggeklosser lists only skills and step flows..
- Not built: `ref` in the layout and its check at publish; the host's registry that draws blocks from their definitions instead of the branches in `Assistant.tsx`; genki's catalogue blocks (the ids in `catalogueBlockIds`) published as Block definitions; reading another publisher's shared blocks; the review before a `code` block is shared with everyone; unlisting; the declarative and code tiers; Block Studio's working copy; and the genki-admin tools `list_blocks`, `get_block`, `preview_interface` and `save_block_draft`.
- `catalogueBlockIds` stays the list of `builtIn` values until the registry replaces it.
- ADR 0061's rule that the host draws only catalogue blocks and runs no owner code still holds: a `built-in` block is a catalogue block. It changes when the declarative and code tiers are built, and the record for the bridge and the block origin says how.
- A stored Block definition is a contract from its first publish. Changes to its shape are additive.
