# 0026 Builder assistant and proposals

Status: accepted, 2026-10-12 (built). Proposed 2026-10-07

## Decision

The builder assistant helps a person set up a service or a skill in the portal. It follows 0020 and climbs the ladder from 0023.

- **A metered platform service.** The assistant is the published `builder-assistant` service of the platform tenant (strategy `strategy-builder`, ADR 0020), run through the kernel for the person's tenant with traces and usage. The model is `assistant.model` when the tenant sets it, otherwise the model in the published definition, otherwise the first model with tools the tenant may use; it must be a shared catalog model, since a tenant's own model is not granted to a platform service. It is turned on with `assistant.enabled` and limited per tenant by `assistant.dailyTokens` (200 000 by default, reset at 00:00 Norwegian time). Each turn gets the rest of the day's budget as its kernel budget, so a turn that uses it up stops with `budget_exhausted`, and later turns answer `budget_exhausted` without calling the model.
- **It only proposes.** A turn returns a message, questions and proposals. Nothing is applied by the AI: the person applies a change to their draft and publishes it through the normal path, with their own rights and gates.
- **Four levels, lowest first:**
  1. A change to the draft, as a JSON Patch with the full draft after it, validated against the schema.
  2. Configuration for an existing connector, such as a mapping from tables to documents and fields. Stored as a `catalog-proposal`; approved by someone with Administrere tjenester and Administrere datasett.
  3. A new building block, such as an MCP server. Stored; approved by someone with Registrere byggeklosser, and registered through the normal registration path, which runs the contract test again.
  4. A platform change. Stored and handled by Digdir, who sets it to under review, planned or rejected. The assistant never generates code for it.
- **Policy is checked outside the model.** Every proposal is checked by code against the schema, the tenant's block policy, residency and the person's rights before it is shown. A proposal that fails is returned as `rejected` with the rule and who owns it, never silently dropped or applied. A proposal the person could not approve themselves is shown with the right it needs (`approval`, in bokmål and English), using the same rights the approval routes check.
- **Prompt injection is assumed.** The assistant reads drafts, documents and schemas that may contain instructions. Because it can only propose, cannot touch secrets or register anything, and every proposal passes checks that do not depend on the model, an injected instruction can at worst produce a proposal a person then rejects.

## Why

People setting up services need help with instructions, test cases and connecting their own data, and an assistant inside the builder gives that help where the work happens. Keeping it to proposals with model-independent checks keeps every change reviewable and attributable to a person, as 0020 requires.

## Consequences

- Proposals at levels 2 to 4 have their own API and history; level-4 proposals are visible to operators and get a case id.
- The daily budget makes the assistant's cost predictable per tenant, separate from the services' own usage.
- The assistant has its own test set (`packages/eval/testsets/builder-assistant.yaml`), like any service.
