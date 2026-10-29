# 0025 Search engine switching

Status: accepted, 2026-10-12 (built; in-place updates and generation recipes proposed in ADR 0042, 2026-10-27). Proposed 2026-10-07

## Decision

A tenant can move a dataset to another search engine without services noticing until the tenant decides.

- **The new engine is filled beside the old one.** The routers open a dataset at a given endpoint (`openAt`), so the switch writes to the target while services keep reading from the current endpoint.
- **Two methods.** _Copy_ reads the documents out of the current engine (`IndexWriter.read`, or a read-only export from Typesense) and writes them to the target. It needs the same embedding model on both sides. _Re-ingest_ runs the dataset's pipelines again into the target and works across embedding models, at a higher cost. The estimate shows both before anything starts.
- **Quality is compared before activation.** When the switch is filled, the dataset's test set runs against both engines: hits in the top five, mean rank and latency, with example questions. If the new engine is worse, activating needs a reason of at least 20 characters instead of 10.
- **Activating is a catalog change.** It publishes a new version of the dataset entry pointing at the new endpoint, with the person's reason, through the normal admin path. Every instance picks it up through the change feed.
- **Rollback.** The previous engine and its data are kept for `knowledge.switchRetentionDays` (14 by default). Within that time, rollback publishes the previous dataset version again; after it, the old generation is dropped and rollback is refused.
- **Typesense needs its own write key.** The shared Typesense cluster is search-only for this platform. Switching to Typesense is refused with "Krever egen skrivenøkkel" until a separate key and an explicit decision exist.

## Why

Search engines differ in cost, residency and what they support (0023), and a tenant should be able to choose without re-registering datasets or touching services. Comparing on the tenant's own test set turns the choice into a measurable one, and keeping the previous engine makes it reversible.

## Consequences

- A switch is an `engine-switch` config entry; its progress and decisions are versioned and audited like any other change.
- The copy or re-ingest job runs on the instance that started it, and is not resumed elsewhere. While it runs, it writes a heartbeat on the switch every 30 seconds. A switch whose heartbeat is older than two minutes (configurable) is marked as failed with "Overføringen stoppet. Start den på nytt.", and the tenant can try again.
- The writer port can drop a generation that is still active in its engine (`drop(dataset, generation, { force: true })`). Through the routers, a forced drop is refused for the generation the catalog serves, also from another endpoint of the same engine, since pgvector endpoints share tables per dataset id.
- The comparison runs two endpoints against each other (`openAt`). Two generations on the same engine cannot be compared, because a pgvector search always reads the active generation.
- [ADR 0042](0042-the-knowledge-database.md), proposed, changes how pgvector datasets get new generations: in-place updates for normal runs, and generations, activation and rollback within one engine for a changed recipe. Activation names the generation in the catalog, and a named candidate can be searched and compared with the active generation on the same engine, which the previous point rules out today. For datasets in the knowledge database, documents owned by their pipelines replace copying the other pipelines' documents into each new generation (issue 107), and a disabled pipeline keeps its documents. A switch into the knowledge database fills its generation with ingestion runs that run as jobs (ADR 0041) and follows their run records instead of a heartbeat in the API, and the generation it fills can be checked through a service's full retrieval path in an evaluation run before it is activated. Otherwise engine switches stay as described here, and a switch counts as an open run of every pipeline of its dataset.
- One instance at a time cleans up old generations, under a lease in the config entries: the copies a cancel, rollback or retry left on the target, and the previous engine's data when the retention period is over. Data on engines the platform may not write to, such as the shared Typesense cluster, is never deleted. A drop that fails is recorded and not retried automatically.
