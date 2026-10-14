# Services and definitions

Build, test and publish services. A service is a versioned definition; drafts, the playground and test runs let you change it safely before a new version is published. Also: skills, step-flow blocks, catalogue proposals from the builder assistant, layered settings and pins, export and import, shared services.

## Rights

- Reading needs membership in the tenant (any right).
- Saving drafts, publishing, test runs, settings, skills and import need `manage-services`. The playground also accepts `manage-datasets`.
- `POST /definitions` and `POST /definitions/validate` answer 403 `urn:genai:problem:tenant-not-registered` for an organisation Digdir has not registered, as the `/tenants/{tenant}` routes do. Publishing never registers an organisation.
- Another organisation reads, exports, copies and pins only the version of a shared skill that Digdir approved; any other version answers 404.
- A skill package may hold at most 1000 files and 20 MB of content, counted from the bytes actually unpacked; duplicate or overlapping entries are refused, and an import of an existing skill writes nothing.
- A high-risk service needs two different people to confirm its risk class (`POST .../risk-confirmations`) before it can be published. A confirmation the audit refuses answers problem+json with the task in `genai-task`.
- A skill whose requirements are not met answers `POST .../skills/{id}/publish` with `422` problem+json; `requirements` lists each requirement and whether it is met.
- Decisions on catalogue proposals (`POST /tenants/{tenant}/proposals/{pid}/approve`, `.../reject`, `.../send-for-approval`) and the operator's `POST /operator/proposals/{pid}/decision` and `.../status` read the reason from `change-reason` only; a `reason` in the body is ignored. Someone who cannot reach the tenant gets 404 from the proposal routes, before any right check.
- Changes need `change-reason` (at least 10 characters, a draft save too) and appear in `GET /tenants/{tenant}/audit`.

A playground run whose model or step fails answers `502` as `application/problem+json` with `type: urn:genai:problem:playground-unavailable`, `status: 502`, `setup`, `code` and, when the caller may see it, `detail` and `runId`. The streamed `failed` event carries the same problem.

## Typical sequence: change and publish a service

1. `GET /tenants/{tenant}/services`: the services with status and channels.
2. `GET /tenants/{tenant}/definitions/services/{id}`: the latest published version (`latest`) and every version (`versions`). For a new service, start from `GET /tenants/{tenant}/definitions/template`.
3. `PUT /tenants/{tenant}/services/{id}/draft` with `{ definition, files?, baseVersion, revision? }`. Send the `revision` you read; `409` means someone else saved in between.
4. `POST /tenants/{tenant}/definitions/test-run` with `{ definition, files?, query }`: one run of the unpublished definition, nothing saved.
5. `POST /definitions` with `change-reason` and `{ definition, files, draftRevision }`: publishes the draft as the next version (`201`). `409 draft-outdated` means a newer version was published; call `POST .../draft/rebase` first. `422` lists what is invalid.
6. `GET /tenants/{tenant}/definitions/services/{id}/versions/{version}`: read one version.
7. `GET /tenants/{tenant}/audit`: the change log, with who published and why.

Pause or archive with `PUT /tenants/{tenant}/services/{id}/lifecycle`. Validate without saving with `POST /definitions/validate`.

## Recipes: step flows with plain settings

A recipe is a published `StepFlow` with `spec.recipe` (a title and a "pick this when" summary, in bokmål and English) and `spec.settings`, a JSON Schema for plain settings a variant fills in. Each setting needs `x-label` in both languages and may use `x-help`, `x-widget` (text, textarea, number, toggle, select, multiselect, list), `x-options`, `x-enumLabels`, `x-order` and `x-advanced` (ADR 0030). An `x-options` route may use `{tenant}`, `{dataset}`, `{datasetOwner}`, `{datasetKey}` (the service's first dataset) and the value of any other text setting, for example `/api/facets?tenant={datasetOwner}&dataset-config-key={datasetKey}&fields={documentField}` with `items: fields.0.options` for a dataset's real facet values.

1. `GET /tenants/{tenant}/step-flows/recipes`: the tenant's own recipes, then the recipes Digdir shares, with `ref`, `origin` (`own` or `shared`), `title`, `summary`, `purpose`, `settings` and `steps` (to draw the steps read-only). `GET .../step-flows/recipes/{id}/versions/{version}` returns the version a variant is pinned to.
2. A variant picks a recipe with `strategy: { id: step-flow, version: 1, config: { flow: <ref>, settings: { ... } } }`. The service itself can do the same.
3. Steps read a setting as `{{settings.<name>}}`. Missing settings take the schema's `default`.

Publishing checks both sides: a step flow is refused when a step reads a setting `spec.settings` does not declare, and a service is refused when a variant's settings are unknown, missing where required, or not allowed by the schema (`spec.variants[i].strategy.config.settings.<name>`).

The builder assistant (`POST .../services/{id}/assistant/turns`) proposes a new variant from a plain sentence as a level-1 change: a recipe with settings, or, when no recipe fits, a new step flow in `proposal.flows` that the portal publishes before it applies the change. `POST /tenants/{tenant}/step-flows/{id}/assistant/turns` proposes changes to a step flow draft.

Sharing: an operator shares one of Digdir's recipes with every organisation with `PUT /operator/recipes/shares/{flow}` and stops with `DELETE` (both need `change-reason` and are audited); `GET /operator/recipes/shares` lists Digdir's recipes and whether each is shared. A service names an exact version (`flow@N`), so a newer version of a shared recipe changes nothing until the owner updates the variant. After unsharing, no new service can use the recipe, while services already published keep their pinned version.

## Build and edit a service from your own admin UI

The portal is one client of these routes; another admin UI, or one an LLM generates from `/openapi.json`, needs nothing else. Every text the routes return comes in bokmål and English.

1. `GET /tenants/{tenant}/definitions/template`: a valid starting Service definition with a model the tenant may use.
2. `GET /schemas` and `GET /schemas/Service@v1`: the definition as JSON Schema with labels, help, widgets and the right needed (`x-` keywords). `uses` links the schema for each strategy config, guardrail, input field, output and trigger.
3. `GET /tenants/{tenant}/definitions/strategies`: the ways of working a service can use. Each has `how` (`single`, `agent` or `flow`), `default` (the one to pick when the person only chooses the way of working), name, description, pipeline steps, `newConfig` (the starting `spec.strategy.config` when the service switches to it), `takes` (whether the config takes the service instructions and examples) and `schema` (its config schema under `/schemas`).
4. `GET /tenants/{tenant}/step-flows/blocks`: the step blocks for a step flow, with names (`title`, `summary`) and labelled param schemas.
5. Edit the definition in your form. `POST /tenants/{tenant}/definitions/complete` with `{ definition }` fills in what the platform derives and lists each change in `applied`: residency from the model, form field ids from labels, the strategy's starting config, human approval for high risk, no required sources for a fields output (validation refuses them), only the output parts that belong to the output kind, and a result field's description from its name when it has none. Nothing is saved.
6. `PUT /tenants/{tenant}/services/{id}/draft` with `{ definition, files?, baseVersion, revision? }` to save, as in the sequence above.
7. Open the draft again with `GET /tenants/{tenant}/services/{id}/draft?rebase=clean`. If a newer version was published since the draft started, the API rebases the draft on read when nobody changed the same path (`rebasedFrom` says from which version, and the rebase is audited). When both sides changed a path, the draft is returned unchanged with `behind: true` and `conflicts` (`path`, `published`, `draft`) for the person to choose; save the choice with `PUT .../draft`. A caller without `manage-services` gets `behind` and no rebase.
8. `POST /tenants/{tenant}/definitions/test-run` to try it (a test run completes the draft the same way first), then `POST /tenants/{tenant}/definitions/complete`, `POST /definitions/validate` and `POST /definitions` with `draftRevision` to publish the completed definition.
