# 0033 Locked test environment

Status: accepted, 2026-10-14 (built, 2026-10-14)

## Context

genki-test logs people in through Ansattporten TEST. With TestID anyone can log in as any synthetic test person, including the general manager of the organisation that plays Digdir (`PLATFORM_TENANT`). Login does not keep strangers out of test, and every model call costs money.

## Decision

`GENAI_LOCKDOWN=true` locks an environment. It is off by default, and `infra/env/test.bicepparam` turns it on for genki-test.

In lockdown, only a credential from configuration may reach a model provider: an API key whose secret the API was given at startup (today `DEV_API_KEY` and `DEV_SERVICE_API_KEY`). The API marks such a caller when it authenticates the request, by the digest of the key it presented, so a key made or rotated through the API never carries the mark, even when it is bound to a client from the repository.

- People (Ansattporten), operators and every other caller get a 403 problem, `urn:genai:problem:locked-environment`, whose title says the environment is locked, on routes that run models: service calls (MCP, OpenAI, A2A, tool calls), playground and test runs, builder assistant turns, eval and batch runs, project runs, the quality matrix, enrichment proposals, diagnostics and skill fixes.
- The model port refuses the same callers, so a model call from a route not on that list, a background job or a trigger fails too.
- Reading and configuration changes keep their normal rights. Startup seeding from YAML is unchanged.
- `/health` reports `lockdown`, and the portal, console and workspace show a banner saying that only registered clients use models here.

Embeddings are not locked: they go through the embedding port, not the model port, and search from the portal is reading. A pipeline that writes search phrases with a model fails in lockdown.

## Why

Test should stay open for the team to look at, and for configuration to be tried, without letting anyone with TestID spend model tokens. A registered client such as the KA test backend is the only legitimate external user that needs models.

## Consequences

- genki-test has no credential from configuration yet, so nothing runs models there until one is added.
- Production does not run in lockdown. It will have a real Kunnskapsassistenten service and a separate test service for KA's test backend.
- A new route that runs a model goes in `modelRunRoutes` in `apps/api/src/lockdown.ts`, so it gets the clear problem and not a failed task.
