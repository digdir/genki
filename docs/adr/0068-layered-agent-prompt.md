# 0068 The agent prompt layers the owner on a platform base

Status: proposed, 2026-11-20 (built; service facts tool, 2026-11-23)

## Context

An `agent-loop` service was never told which service it is, and its `instructions` replaced the whole platform prompt. An owner who wrote instructions lost the workflow text without seeing it, and a question such as "what is the newest document you have" was read as being about the conversation. The search tool also cut its result at 20 chunks and said only how many lower-ranked chunks it left out, not that search returns only the best matches or how to see the rest.

## Decision

- **Every agent prompt starts with a service card**, generated at run time from the capability and the index: the service's name and purpose, that "du", "dere" and "you" mean the service and its collection, each dataset with its number of documents and year range within the active filters, the fields it can filter on, the answer languages and today's date in Norwegian time. The call that writes the answer gets the card without the filter fields and the date. The counts come from the same source facts as the `source_facts` tool, are cached per tenant, principal, capability version, datasets and filters for five minutes, are left out when the index cannot give them, and are shown as unknown for a dataset whose count is missing.
- **A service can let the agent look up facts about itself.** `service-facts@1` in `spec.tools` of an `agent-loop` service gives the agent the tool `service_facts`, with or without datasets, in every runtime that runs services (the API and the worker). It returns a fixed list of facts about the service and this run: the service's title and owner organisation, the version the run uses and the day it was published in Norwegian time, the environment the caller named (or, when none was named, whether the run uses the latest published version and which one that is), the main model's readable name and its maker when known, the answer languages, the accepted media types, the risk class and whether a person must approve. A trial run of a draft (playground, builder, eval) is called a draft, with no version or publish date. It never returns who published or why, ids, the config hash, the model's id, endpoint or deployment, costs or quotas; a model without a family in the catalogue has no readable name. The organisation and the service come from the capability's owner tenant, never from the input. A fact the platform cannot read is returned as "not recorded". The result is wrapped as untrusted data, and the card is unchanged.
- **Instructions are added, not replaced.** The platform base prompt has the sections `role`, `reasoning`, `workflow` and `gate` (only `role` and `reasoning` for a service without datasets). The service's `instructions` follow them under "The service owner's instructions:", as ADR 0029 already does for language instructions.
- **A section is edited on its own.** `spec.strategy.config.promptSections` maps a section id to the text that replaces it; an empty text leaves it out, and an unknown id is refused. `GET /tenants/{tenant}/definitions/strategies` lists the sections with a title and a one-line reason for keeping each, and `layered: true`. The portal shows them as editable sections with a reset, and marks where the owner's instructions go.
- **The generic prompt names no collection's fields.** Field names and document types of one collection belong in that service's instructions, or come from `inspect_filters` and the card.
- **Search shows an honest window.** Hits are grouped by document, with the publication date and publisher on the document line and at most three hits under it. The result states how many hits and documents the search found, which documents it shows, that more are available on `page=N`, that search returns only the best matches, and the active filters (from the service or caller, from `filter_by`, and from the query). A page of the same queries and filters is served from the last search without using the search budget. `search.displayLimit` counts documents per page.

## Why

Leading retrieval agents describe themselves and their collection in the prompt and show the agent what a result window leaves out; both were missing, and the failures traced back to them. Layering keeps the platform's workflow, which every service needs, under the owner's text instead of making each owner copy it. Per-section edits keep the base editable without a replace-all switch. We turned down a mode that keeps the old replace behaviour: emptying every section gives the same result.

## Consequences

- An existing service with `instructions` now gets the base sections too. A service whose instructions repeat the workflow can drop that text or empty the matching section.
- `service_facts` reports the main model only, not a role model or the fallback that may have written part of an answer. Earlier versions and the service's interface pages are not in it.
- The card adds a facets and count query against the index for a run that misses the cache.
- The search result format changed; diagnostics count the chunks of the page of documents a search showed as displayed; a later page served from the last search is not counted.
- Measuring the effect on answer quality needs a run of the golden set, which this change does not include.
