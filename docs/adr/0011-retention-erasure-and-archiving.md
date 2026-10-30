# 0011 Retention, erasure and archiving

Status: accepted, 2026-10-12 (built; amendment accepted with ADR 0040, 2026-10-29, not built; knowledge withdrawals proposed in ADR 0042, 2026-10-29). Proposed 2026-10-06

## Decision

- Each event has an **envelope** (ids, type, actor, usage, versions, timestamps) and a **payload** (prompts, answers, documents, tool results).
- Envelopes are kept for the audit period. Payloads follow the service's retention class and are encrypted with a key per tenant and thread. Erasure deletes the key, so the append-only log never has to be rewritten.
- Retention classes are defined by the platform and chosen per service (`retention.class`: transient 7 days, standard 90, case 365, counted from when the task ends). Higher risk classes have a minimum retention: limited-risk services keep content at least 30 days, high-risk at least 183. The audit period (`retention.auditDays`, 730 by default) is never shorter than the content. A task whose service no longer exists is kept as long as a high-risk one.
- A scheduled worker job purges what has expired, once a night on the worker that holds the lease. After the retention period it clears the payloads, erases the task-scoped key and deletes conversations that have been idle that long (with their thread key); after the audit period it deletes the envelopes too. Running the job again changes nothing.
- Traces leave the platform through one OpenTelemetry exporter (OTLP over HTTP). Langfuse is one endpoint. Azure Monitor (Application Insights) is reached by pointing the exporter at an OpenTelemetry Collector with the Azure Monitor exporter, which is deployment configuration, not platform code. Every sink carries metadata only, unless the connection explicitly opts in to content. A sink that cannot honour erasure never receives content.
- Documents a user attaches to a question are stored as blobs per tenant and service, and per conversation when they are sent in one. Deleting a conversation deletes its documents at once and erases the content key of the tasks its turns ran as, so their events read back as erased. Otherwise the same nightly job deletes them when the service's retention period (class and risk minimum, as for payloads) has passed since they were uploaded, which also covers conversations it erases as idle.
- Real questions become test cases only after anonymisation and human review, with an expiry date, and never across tenants.
- **The platform is not an archive.** The agency's case system is. Each result carries a provenance record: task id, service version, model, sources and approver. The case system archives it with the document, and the platform can export a task by id within its retention window: `POST /tenants/{tenant}/tasks/{task}/export` returns a zip with the task, its events, result, artifacts, provenance and retention policy. It needs the right to manage services and a change reason, and every export is written to the audit log.
- Quality is reported for services, never per employee.

## Accepted with ADR 0040 (not built)

These rules extend the decision above once they are built:

- **When a sink honours erasure.** It does when the platform can delete a task's trace and every trace the sink made from it, such as a judge's execution trace, and when its operator keeps the raw files it ingests for at most 7 days, the shortest retention class.
  - For a sink a tenant runs itself, the tenant's declaration that both hold is enough.
  - In development mode (`GENAI_DEV_MODE=true`), a Langfuse on the developer's own machine may receive content without the 7-day rule, as long as only made-up test sets are sent to it.
- **Platform-wide exporter.** It carries metadata only. `TRACES_CONTENT` is honoured only in development mode.
- **Text sent for evaluation.** It is only what the judges read, as their variable mappings name it: the question and the answer, and the cited sources, the retrieved documents, the case's `expected.criteria` or other fields only when a judge maps them. A field no judge maps is not sent. Holdout cases are never sent.
- **Deleting in a sink.** The platform records the id of every trace it sends to a sink, and of the traces the sink made from them, until each delete is confirmed.
  - When the nightly purge or any other erasure removes a task, the platform records the deletion of those traces as pending, and the nightly purge works through the pending deletes.
  - A failed delete stays pending and is tried again the next night, without holding back the purge in the platform.
  - A delete that keeps failing is reported to operators.
  - A sink connection with pending deletes cannot be removed.
- **Judge reasons.** A judge's reason may quote the answer, so it follows the case's retention: the nightly purge clears it from stored eval runs when the case's payload expires.

## Why

Prompts and answers are personal data and are probably case documents under offentleglova. The new arkivlov applies to AI-assisted case work. An append-only log needs a way to honour erasure.

## Consequences

- Content stays out of event rows in Postgres from the start, before the schema is fixed.
- The legal basis, retention periods and archive duties must be confirmed with the DPO and legal before KA traffic reaches the platform.
- [ADR 0042](0042-the-knowledge-database.md), proposed, withdraws a document from a dataset in the knowledge database on request: from every generation and the shared caches at once, from their Blob copies by the next night, and from the server's 7-day backups after that, with a log on the platform server that is applied again after a restore. Its tombstone keeps only a keyed hash of the document's id, and the Marker client asks the host to keep nothing.
