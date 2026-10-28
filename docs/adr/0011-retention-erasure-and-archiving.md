# 0011 Retention, erasure and archiving

Status: accepted, 2026-10-12 (built). Proposed 2026-10-06

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

## Why

Prompts and answers are personal data and are probably case documents under offentleglova. The new arkivlov applies to AI-assisted case work. An append-only log needs a way to honour erasure.

## Consequences

- Content stays out of event rows in Postgres from the start, before the schema is fixed.
- The legal basis, retention periods and archive duties must be confirmed with the DPO and legal before KA traffic reaches the platform.
