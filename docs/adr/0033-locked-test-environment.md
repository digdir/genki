# 0033 Locked test environment

Status: accepted, 2026-10-14 (built, 2026-10-14; ingestion locked, 2026-10-15)

## Context

genki-test logs people in through Ansattporten TEST. With TestID anyone can log in as any synthetic test person, including the general manager of the organisation that plays Digdir (`PLATFORM_TENANT`). Login does not keep strangers out of test, and every model call costs money.

## Decision

`GENAI_LOCKDOWN=true` locks an environment. It is off by default, and `infra/env/test.bicepparam` turns it on for genki-test.

In lockdown, only a credential from configuration may reach a model provider: an API key whose secret the API was given at startup (today `DEV_API_KEY` and `DEV_SERVICE_API_KEY`). The API marks such a caller when it authenticates the request, by the digest of the key it presented, so a key made or rotated through the API never carries the mark, even when it is bound to a client from the repository.

- People (Ansattporten), operators and every other caller get a 403 problem, `urn:genai:problem:locked-environment`, whose title says the environment is locked, on routes that run models: service calls (MCP, OpenAI, A2A, tool calls), playground and test runs, builder assistant turns, eval and batch runs, project runs, the quality matrix, enrichment proposals, diagnostics and skill fixes.
- The same callers get the same problem, with a title that says ingestion is locked, on routes that fetch documents or write new embeddings: running a pipeline (tenant and operator), syncing a connector, starting or retrying an engine switch, and applying hypothetical questions.
- The model port refuses the same callers, so a model call from a route not on that list, a background job or a trigger fails too.
- The worker reads the same setting. It binds no triggers, so a document that lands in a folder or a scheduled trigger starts nothing, and each sync logs that it is locked. Its model port uses the same rule, and the worker runs as a system user without the mark, so any model call it makes is refused.
- The ingestion service refuses to start a run that a credential from configuration did not start. Scheduled runs and the first sync of a new connector therefore do not run; a scheduled run is recorded as failed with the reason and logged.
- Reading and configuration changes keep their normal rights. Startup seeding from YAML is unchanged.
- `/health` reports `lockdown`, and the portal, console and workspace show a banner saying that only registered clients use models and run ingestion here.

The embedding port is not locked, so search keeps embedding queries and reading existing data. Writing embeddings is locked where it starts instead: ingestion runs in the background under a system user, so the embedding port cannot tell who started it, but the start can. Saving a pipeline, including one with a schedule, is configuration and stays allowed.

## Why

Test should stay open for the team to look at, and for configuration to be tried, without letting anyone with TestID spend model tokens. A pipeline run also crawls arbitrary websites from our network and spends embedding tokens without a ceiling, so it is locked the same way. A registered client such as the KA test backend is the only legitimate external user that needs models.

## Consequences

- genki-test has no credential from configuration yet, so nothing runs models there until one is added.
- Production does not run in lockdown. It will have a real Kunnskapsassistenten service and a separate test service for KA's test backend.
- A new route that runs a model goes in `modelRunRoutes` in `apps/api/src/lockdown.ts`, and a new route that ingests or writes embeddings goes in `ingestionRoutes`, so it gets the clear problem and not a failed task.
