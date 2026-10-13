# 0031 Services, variants and ways of working

Status: accepted, 2026-10-12 (partly built)

Not built yet: the builder assistant panel in the portal's step-flow editor (the API route for step-flow drafts exists), and the read-only diagram on the assistant's proposal cards.

Amends 0004, 0007 and 0017. Touches 0026 and 0030.

## Decision

- **Five nouns.** Portal, workspace, console, docs and API texts use one model: a **service** has one or more **variants**; each variant has a **way of working**; a fixed way of working is a step flow made of **steps**; services use **building blocks** from the catalogue.

  | Bokmål      | English        | In the definition                                                |
  | ----------- | -------------- | ---------------------------------------------------------------- |
  | Tjeneste    | Service        | `kind: Service`, `metadata.id`                                   |
  | Variant     | Variant        | `spec.variants[]`, public name `<service>__<variant>`            |
  | Arbeidsmåte | Way of working | `strategy: { id, version, config }`, on the service or a variant |
  | Steg        | Step           | `StepFlow.spec.steps[]`                                          |
  | Byggekloss  | Building block | catalogue entries: models, datasets, tools, skills               |

- **"Modus" and "mode" are not used** for a variant in any text a person reads. Field names that already exist (`_mode`, `modes` in key grants) stay.
- **"Agent" has one meaning for owners and end users:** the way of working where the model plans and searches by itself, `agent-loop`, shown as "Agent (søker selv)" / "Agent (searches by itself)". Everything else gets another word:
  - the step type `agent@1` is "La modellen søke selv" / "Let the model search by itself";
  - `remote-agent` is "Egen motor" / "Own engine", and its registered plug-in is an engine;
  - a service is never called an agent, and a variant is never called an agent.

  "Agent" stays as a protocol term in the integration screens (A2A, agent card) and in existing API names (`_agent_id`, `agent`, `agentId`, the operator plug-in kind `agents`).

- **A variant may have its own way of working, including a step flow.** This replaces the rule in 0007 that a variant cannot switch to a step flow. A variant without its own `strategy` uses the service's. Every flow a service can run, from the service, a variant's own strategy, or a variant's `overrides.flow`, is checked at publish like the service-level one: the flow is published, its inputs match the input fields, its tool steps use tools the service lists, and a table output comes only from a flow. The runtime compiles one capability per variant with that variant's strategy, and the builder test run, the playground (`setup.service.variant`) and eval runs (`variant`) can run one named variant.
- **Recipes.** A published `StepFlow` with `spec.recipe` (title and "pick this when", in bokmål and English) is a recipe. `spec.settings` is a JSON Schema for plain settings with the `x-` metadata of 0030; steps read them as `{{settings.<name>}}`, and missing values take the schema defaults. A variant or service fills them in `strategy.config.settings`. Publish refuses a flow whose steps read an undeclared setting, and a service whose settings the schema refuses. `GET /tenants/{tenant}/step-flows/recipes` lists them, and the portal's Varianter section offers them first under "Egen arbeidsmåte", drawn with the shared schema renderer and a read-only diagram. The platform ships three: document types in order then answer, compare documents, and answer briefly with sources.
- **Digdir shares recipes with every organisation.** Recipes are shared the way skills are: a share decision stored as a config entry (`recipe-share`, scope the platform tenant), not a copy. Only an operator shares or unshares (`PUT`/`DELETE /operator/recipes/shares/{flow}`), as an audited admin task with a change reason (0010); only Digdir's own published recipes can be shared, and an organisation keeps its private recipes. A flow reference is resolved from the service's own tenant first, then from Digdir's shared recipes, in the same way in the in-memory store, the Postgres store and the runtime. Published definitions are already readable platform-wide under 0022, so no policy changes; writes stay limited to the tenant in context. A variant names an exact version (`flow@N`), so the published service is pinned: a newer version of a shared recipe changes nothing until the owner chooses "Oppdater til versjon N" in the Varianter section. Unsharing stops new use (listing, publishing, the assistant), while services already published keep running the version they pinned. `GET /tenants/{tenant}/step-flows/recipes` lists own recipes, then shared ones, with `origin`, and the builder assistant sees the same list.
- **The builder assistant proposes variants and edits step flows.** From a plain sentence it proposes a new variant with a recipe and settings, or with a new step flow when no recipe fits, as a level-1 change (0026). A new flow travels in the proposal and is published by the portal before the change is applied. Step-flow drafts are a builder target of their own.
- **The owner decides which variants end users can pick** ("Kan velges i chat" / "Can be picked in chat" per variant, `variants[].chat`), and A2A agent cards are named "Service · Variant" (the default variant's card carries the service name alone).
- **`GET /v1/models` names the service and the variant on every row:** `_service`, `_service_title`, `_variant`, `_variant_title`, `_pickable` (always present; `true` when an end user may pick the row in chat: a chat variant of a service exposed for chat, not paused, not an alias) and `_alias_of` (on an alias row, the `id` it points to). `_agent_id`, `_mode`, `_default`, `_chat` and `title` keep their meaning for headless-rag compatibility (0017).
- **Conversation routes accept `service`** (also `service-id`, `serviceId`, `service_id`) as well as `agent` and `agent-id`, and return `serviceId` next to `agentId`.
- **Frontend rule.** A frontend shows "service, then variant" and never presents a variant as a separate service ([frontend contract](../frontend-contract.md)).

## Why

Owners and end users met one concept under four names, and one word with seven meanings. A specialised flow for one service could only be made as a second service, which then showed up in KA's picker as another "agent". A small fixed vocabulary, fields that say which service a row belongs to, and per-variant ways of working let an owner say "KA, but annual reports first" and get it as a variant of KA.

## Consequences

- Ids and YAML keys are unchanged. Existing definitions stay valid, and `variants[].overrides.flow` keeps working; it is now checked at publish.
- The new `/v1/models` fields are additive. KA and other frontends can group by `_service` and offer `_pickable` rows as variants; until they do, nothing changes for them. The `/v1/models` parity scenario compares the whole row, so it now sees the new fields as well as `_chat`.
- Validation and problem texts say "variant" in bokmål and English. headless-rag's compatibility error texts (`Agent not found`, `API key cannot use mode`) stay as they were.
