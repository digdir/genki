# genki

genki is a shared platform for generative AI services in the Norwegian public sector. This glossary defines the words genki uses, so code, docs and the portal mean the same thing by them. It starts with evaluation; other areas are added as their words are settled.

## Evaluation

**Eval run**:
One pass of a test set version through one service variant, where every case is answered as for any other caller and then scored.
_Avoid_: test run, dataset run

**Experiment**:
Two or more eval runs on the same test set version that differ in exactly one thing, such as the variant, the model or the prompt, so their scores can be compared. Langfuse uses the word for a single run; in genki that is an eval run.
_Avoid_: dataset run, sweep

**Split**:
One of three groups a test case belongs to: train (looked at freely while improving a service), validation (used to check a change and by publishing gates) or holdout.
_Avoid_: partition, fold

**Holdout**:
The split of a test set kept away from anything that tunes a service, so a score on it is not inflated by tuning.
_Avoid_: locked split

**Judge**:
A model that grades an answer to a test case and gives a verdict with a reason.
_Avoid_: evaluator (for the model-based kind), grader

**Calibration label**:
A person's own verdict on a test case, to the same question a judge answered about it, used to measure how far that judge can be trusted.
_Avoid_: annotation, human score

**Advisory**:
Said of a score or gate that is recorded and shown but cannot block a publish, such as a gate on a judge that is not yet calibrated, or any Langfuse judge's score.
_Avoid_: soft gate, warning

**Feedback**:
What an end user says about a real answer in daily use, such as thumbs up or down with a comment.
_Avoid_: annotation, label, rating (for a reviewer's verdict)

## Knowledge

**Knowledge database**:
Where the platform keeps the datasets it indexes itself: the source records, their converted text and the generations services search. It is kept apart from the platform's own data.
_Avoid_: vector store, search index

**Dataset**:
A set of documents that services search, shared with the organisations allowed to read it. A test set is something else: the cases an eval run answers.
_Avoid_: index, collection, corpus

**Source**:
A system a dataset's documents come from, such as Kudos, a folder or a CMS. A document's id names the source and its id there.
_Avoid_: origin, provider

**Pipeline**:
One source, its settings and its schedule, filling one dataset. A dataset can be filled by several pipelines.
_Avoid_: connector, feed, ingestion job

**Ingestion run**:
One run of one pipeline: its source is listed and compared with what the dataset holds from that pipeline, and what changed is converted and indexed. It is not an eval run.
_Avoid_: sync, crawl

**Document record**:
What the platform keeps about one source document in one dataset: the record as the source gave it, the pipelines that own it and what has been done with it.
_Avoid_: document metadata, source row

**Tombstone**:
What is left of a deleted document: a keyed hash of its id and the date, so an old citation can say it was withdrawn.
_Avoid_: deleted marker

**Withdrawal**:
Removing one document from a dataset on request, such as an erasure request: from every generation, the caches and their copies, leaving a tombstone like any deleted document and a log entry that keeps it out of later runs. A purge is something else: removing expired task content.
_Avoid_: takedown, purge

**Change brake**:
The stop on an ingestion run that would change, take over or delete an unusually large share of its pipeline's documents, until a person approves it.
_Avoid_: circuit breaker, safety limit

**Stored conversion**:
A converter's text for one file, kept so that no file is converted twice with the same converter, version and settings.
_Avoid_: parse, extraction, cache (alone)

**Recipe**:
How documents become searchable: the converter, how text is cut into chunks and which search phrases are made, the embedding model, and how full text is indexed.
_Avoid_: pipeline, profile, configuration

**Generation**:
One complete searchable copy of a dataset, built with one recipe. Documents change inside it; a new generation is built only when the recipe changes or the dataset moves to another engine.
_Avoid_: version, snapshot, build, partition

**Active generation**:
The generation services search.
_Avoid_: live index, current version

**Candidate**:
A generation built beside the active one, which only people who manage the dataset in its own organisation can search, until it is activated or dropped.
_Avoid_: staging, shadow index

**Catch-up**:
Bringing a generation up to date with the document changes made after its data version: before a candidate serves, or just after a rollback.
_Avoid_: resync, backfill

**Data version**:
The highest point in a dataset's history of document changes below which a generation has every change, recorded with every result that read it, so that two results are compared only when they read the same data. A service version is something else.
_Avoid_: index version, revision

**Frozen sample**:
A small dataset with fixed documents and test cases, where recipes are tried before a full candidate is built.
_Avoid_: dev index, mini dataset

**Heavy work**:
Work on the knowledge database big enough to slow search, such as building the index of a large generation. It runs only in the night window.
_Avoid_: batch job, maintenance

**Job**:
A piece of background work the platform keeps until it is done, and retries when it fails. A task is something else: the kernel's record of one call.
_Avoid_: task, message
