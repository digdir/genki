# 0049 Every API pattern through descriptors

Status: proposed, 2026-11-05 (not built)

Replaces the "Kept out" section of ADR 0047. Builds on ADR 0048.

## Context

A descriptor today describes one JSON request and one JSON answer (`packages/operations/src/executor.ts`). Provider APIs also upload files as multipart forms, answer with raw bytes, stream server-sent events, start jobs that are polled, keep files, batches and responses at the provider, and hold live sessions over WebSocket. ADR 0047 kept realtime, batch, provider-side files and stored responses out of descriptors, because they hold a session or keep data at the provider. Each of these then needs code when a provider ships it, and the platform falls behind.

The goal is that a new provider API needs a reviewed descriptor and no code. Code is written once per pattern, never per API.

## Decision

Each pattern below is built once in the executor and the gate, declared in the descriptor, and proven by `operation@1` like any descriptor. The governance of ADR 0047 applies to every pattern: the gate, closed shapes, masking, metering, audit, tiers, maturity and the processor record.

### 1. Request encodings

`request.encoding` is `json` (the default), `multipart` or `binary`. A multipart request declares its parts as a mapping like the body: `parts: { file: $input.audio, language: $input.language }`. A file part takes only a `media` input field. A binary request sends one `media` input field as the body.

### 2. Media input

A descriptor may declare `{ media: <type/subtype or type/*>, maxBytes }` in its input and wire request. Media cannot be masked, so the gate lets it through only when the service's confirmed risk assessment records unmasked input for that media type with a reason (#326), and the raw tier only for a try marked synthetic. The run keeps the input as a blob under the service's retention, and `kernel.gate.call` records its type, size and SHA-256. The ADR 0047 refusal of URLs and long base64 runs in `plain` fields stays.

### 3. Response encodings

`response.encoding` is `json` (the default), `binary` or `text`. A binary answer becomes one media reference in the result, kept as a blob as in #314. A text answer, such as `srt` or `vtt`, is one text field. The content type of the answer must match what the descriptor declares, or the call fails.

### 4. Streaming

`stream.events` (already in the schema, #302) declares each server-sent event by name with its shape, a `delta` path for text and `done`. The gate walks every event against its shape, ends the stream on an unknown event, masks nothing in the answer but restores masked values in deltas, including across event boundaries, and meters the usage event. A `call-operation` step streams its text deltas to the answer stream like a model step.

### 5. Jobs

`interaction: job` declares four requests:

- `start`, which returns a job id in a field declared `ref`;
- `poll`, with a path holding `{job}`, an interval, a timeout, the status path and its `done` and `failed` values;
- `fetch`, which reads the result, often `binary`;
- `cleanup`, an optional delete.

`{job}` is filled only from the start answer, never from input. A job polls inside its run up to its timeout and a platform ceiling; jobs longer than that run on pg-boss (ADR 0041) and are left. The cleanup runs whether the job succeeds or fails.

### 6. State at the provider

A descriptor that creates something at the provider, such as an uploaded file, a vector store, a batch, a stored response or a conversation, declares it under `resources` with how it is created, how it is deleted and its longest life. Fields such as `store`, `file_id` and `previous_response_id` are allowed only in a descriptor that declares the resource they refer to.

- The executor records every provider object it creates in a ledger: tenant, run, connection, object id, created and delete-by.
- The object is deleted when its run ends, or at its declared longest life if the run needs it longer. A nightly sweep deletes what is left and reports what it could not delete.
- A connection serves such descriptors only when its processor record states the provider's retention and allows provider-side state. Without that, the call is refused as `processor`.
- An object id is never taken from input, only from an answer within the same run.

Batch is a job (pattern 5) over an uploaded file (pattern 6) and needs no pattern of its own.

### 7. Sessions

`interaction: session` describes a live session over WebSocket: how the session is opened, the client and server events with their shapes, the usage events, and a longest duration.

- Genki relays the session. The frontend connects to Genki, Genki connects to the provider, and the provider credential and any ephemeral key never leave Genki.
- Every event in both directions is walked against its shape. Text is masked and restored as in a model call, and audio frames are media input and output under pattern 2.
- A session is a way of working for a service, `live-session@1`, whose config names the descriptor. Frontends open it at `GET /v1/sessions` with an upgrade, under the same access as `/v1/chat/completions`.
- The run is the session: the transcript, usage and audit belong to it, and the session ends at its longest duration or when the service is moved back to test.
- Tool calls inside a session go through the service's tools and the gate. WebRTC is left.

### 8. The mapping language

The mapping gains indexing (`$response.choices.0`), `$concat`, `$join` and `$if`. A described descriptor may declare `json` in its input and wire request; the walker masks every string inside it, and the masking probe of `operation@1` puts synthetic personal data into every string it allows.

### 9. Checks

A descriptor may declare `checks` that the executor runs on each answer: `same-names` (every question has one answer, as the hand-written decide adapter checks), `count` and `one-of`. A failed check fails the call.

### Proof

Each pattern is proven twice: by a synthetic example descriptor in `operation@1`, as `example/classify@1` proves new kinds today, and by one real API, new to Genki, taken from upload to a published service on genki-test through the console and the portal, with the deployed commit the same before and after. The first real APIs are `gpt-transcribe` (patterns 1, 2 and the `audio-second` price of ADR 0048), audio input and output on Chat Completions (2, 3, 8), streamed answers (4), a video API (5), batch (5, 6) and a live transcription session (7). The record is accepted after a final run with the newest provider API at that time, one not used to design any pattern, on YAML alone.

## Why

Providers add a new kind of API every month or two (ADR 0047). If each pattern is code per API, the platform is always one release behind the provider. A pattern is a small, closed set of shapes the gate can walk, so building it once keeps every later API on data.

Sessions and provider-side state were kept out because they hold data the platform does not control. They are let in here with that risk handled in the platform instead of avoided: Genki relays the session and sees every event, and every provider object is recorded and deleted on a deadline, under a processor record that states the provider's retention.

Turned down:

- Opaque pass-through for sessions or uploads: it cannot mask, meter or audit.
- Ephemeral provider keys in the browser: the provider would see the user directly, and Genki would see nothing.
- A plug-in per pattern: it would be code per API again.

## Consequences

- ADR 0047's "Kept out" section and the loader's refusal of `/realtime`, `/batches`, `/files`, `store` and the like are replaced by these declarations. The refusals stay for any descriptor that does not declare what it creates.
- ADR 0044 still holds for the built-in chat implementations: they stay stateless.
- A provider object that cannot be deleted is an incident, reported by the sweep and in Revisjon.
- The relay for sessions adds a long-lived connection to the API; its limits are set per environment.
- Not built yet: every pattern above, #326, #302.
