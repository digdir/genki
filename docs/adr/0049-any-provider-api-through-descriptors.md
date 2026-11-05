# 0049 Any provider API through descriptors

Status: proposed, 2026-11-05 (not built; rewritten from a list of API patterns to primitives, 2026-11-05)

Replaces the "Kept out" section of ADR 0047. Builds on ADR 0048.

## Context

A descriptor today describes one JSON request and one JSON answer (`packages/operations/src/executor.ts`). Providers also take multipart uploads and raw bytes, answer with bytes or text, stream in more than one format, start jobs that are polled, keep files and sessions at the provider, hold live sessions over WebSocket, sign requests and count usage in units that are not tokens.

The first version of this record listed nine such patterns and built each once. That still leaves a closed world: the first API that combines things differently, or does something no pattern names, needs a pull request to the platform. Providers ship new kinds of API every month or two, and we cannot know what the next one looks like.

The goal is that any provider API, including ones nobody has seen yet, is added as a reviewed descriptor, with no change to the platform's code and no deploy, and stays as safe as a chat call through the gate.

## Decision

The platform does not know APIs or patterns. It knows a few primitives, each a small closed set that grows with web standards, not with provider releases. A descriptor combines them freely. Security attaches to the data that crosses the gate, never to what an API is for.

### 1. Transports

A step uses one transport:

- `http`: one request, one answer.
- `http` with `response.stream`: one request, an answer that arrives in parts, framed as `sse`, `ndjson` or `lines`.
- `websocket`: a live session with client and server messages, text or binary frames.

### 2. Encodings

`request.encoding` and `response.encoding` are `json` (the default), `multipart`, `form`, `binary`, `text` or `ndjson`. A multipart request maps its parts like a body (`parts: { file: $input.audio, language: $input.language }`). A binary body is one `media` value. Query parameters and headers are mapped the same way, from the same classified values.

### 3. Steps

A descriptor is a list of `steps`. A step is one request on one transport. A one-call descriptor is one step, and today's descriptors are read as exactly that, unchanged.

- `bind` captures values from an answer under a name, each with its class (section 4). Later steps use them as `$steps.<name>.<field>`.
- `until` repeats a step until a condition on its answer holds, with an interval, the provider's `Retry-After` honoured up to a cap, and a longest duration.
- `finally` lists steps that run whether the steps before them succeeded or failed, such as deleting what a job created.
- `result` maps what the operation returns from any step's answer.

Start, poll, fetch and delete is four steps. Upload, process and delete is three. A token exchange is a first step whose answer is bound as `secret` (section 5). None of these is a pattern the platform knows.

### 4. Every value is classified

Every field that goes out or comes in has a class from the payload shapes the gate already walks (`packages/kernel/src/payload.ts`). A field without a class is refused when the descriptor is loaded, and an unknown field in an answer is dropped and counted, as today.

- `text`: may hold personal data. Masked going out, restored coming back, also across stream parts and session messages.
- `plain`: written by the service or a tool. A URL or a long base64 run is refused going out.
- `media` with a media type: audio, images, video and documents. It cannot be masked, so it goes out only when the service's confirmed risk assessment records unmasked input for that media type with a reason (#326), or in a try marked synthetic. The run keeps it as a blob under the service's retention, and `kernel.gate.call` records its type, size and SHA-256. Media coming back is kept as a blob, as in #314.
- `ref`: an identifier the provider issued. It comes only from an answer in the same run, never from input. It may fill a path segment, checked against its pattern.
- `number`, `enum`, `boolean`: as today.
- `json`: arbitrary JSON. The walker masks every string inside it, and the masking probe of `operation@1` puts synthetic personal data into every string it allows.
- `opaque`: state the provider gave that is replayed unread, only within the same run.

The mapping language gains indexing (`$response.items.0`), `$concat`, `$join` and `$if`. Nothing in input chooses a host, a model, a credential or a path outside a pattern-checked `ref`.

### 5. Credentials and signing

The credential stays on the connection (ADR 0048) and never appears in a descriptor, a module, a log or an answer. A descriptor says where it goes: a header with a scheme, or a query parameter, which is then redacted from every log. A token from an exchange step is bound as `secret`, a class that only the gate can place and that nothing else can read. Signing a request over its body, a timestamp or a header set is done by a module (section 8) through a host function that takes the key's name, never the key.

### 6. Where requests may go

Every request goes to the connection's resource, at a path the descriptor states. A URL in an answer, such as a signed download link, is followed only when its host is the connection's own or one the operator lists on the connection under `allowedHosts`, a change that is audited. Input never names a URL, so an API in which the provider fetches a URL given by the caller cannot be described; it is refused at load.

### 7. Things kept at the provider

A `ref` that names something the provider keeps, such as an uploaded file, a job, a session, a stored response or a conversation, is declared under `resources` with the step that deletes it and its longest life.

- The executor records every such object in a ledger: tenant, run, connection, object id, created and delete-by.
- The object is deleted by the descriptor's `finally` steps, or at its longest life. A nightly sweep deletes what is left and reports what it could not delete as an incident in Revisjon.
- A connection serves descriptors that keep things at the provider only when its processor record states the provider's retention and allows provider-side state. Otherwise the call is refused as `processor`.
- A `ref` the provider can keep but offers no way to delete is allowed only when the processor record names that retention.

### 8. Modules for what the language cannot say

A descriptor may name a module: a WebAssembly component, pinned by its SHA-256, uploaded and reviewed with the descriptor. It is for what data cannot express, such as a request signature, a binary framing or an unusual codec. It runs inside the gate with fixed limits on time and memory and only these host functions:

- encode and decode bytes, hash, and sign with a named key (the key never enters the module);
- read the step's classified values and return classified values, which the gate walks like any answer.

A module has no network, no file system, no clock beyond what the gate passes and no access to other runs. Its output goes through the same shapes and masking as everything else, so a module can change how bytes look, never what leaves.

### 9. Usage and units

A descriptor maps usage from wherever the provider reports it: a field in the answer, a header, the last stream part, a session message or a separate step. Units are open: a descriptor names its units (for example `page`, `pixel`, `frame`), and an operator prices them per model and kind as in ADR 0048. A unit without a price is metered and shown as not priced. The eight units of ADR 0048 are the built-in names.

### 10. Errors

A descriptor maps the provider's error envelope to Genki's error kinds (`invalid`, `unavailable`, `rate-limited`, `refused`, `processor`). `429` with `Retry-After` is honoured up to the step's cap. An answer whose content type differs from the one declared fails the call.

### 11. Sessions

A `websocket` step is a session. Genki relays it: the frontend connects to Genki at `GET /v1/sessions` with an upgrade, under the same access as `/v1/chat/completions`, and Genki connects to the provider. The credential and any short-lived provider key stay in Genki. Every message in both directions is walked against its class: text is masked and restored, audio frames are `media`. The run is the session; its transcript, usage and audit belong to the run, and it ends at its longest duration or when the service's kind is moved back to test. Tool calls in a session go through the service's tools and the gate. A service uses a session through the way of working `live-session@1`, whose config names the descriptor.

### 12. Checks

A descriptor may declare `checks` on an answer: `same-names` (every question has one answer), `count` and `one-of`. A failed check fails the call.

### What never changes

Whatever a descriptor or module says, the gate holds these, and `operation@1` proves each with a hostile descriptor that must be refused:

- The credential is placed only by the gate.
- Requests go only to the connection's hosts and the operator's `allowedHosts`.
- No value leaves unclassified. Text is masked. Media leaves only with recorded consent or as synthetic data.
- Input never chooses a host, a model, a credential or an unchecked path.
- Every object kept at the provider is in the ledger and has a deadline.
- Every call is metered and audited, within limits on bytes, duration, steps and messages.
- Maturity, the processor record and the review of ADR 0047 apply to every descriptor and module.

## Proof

The record is accepted only when all three parts pass, on genki-test, with the same deployed commit before and after each. A failure is fixed inside this record, not moved to a new one.

1. **Known shapes.** Each is uploaded as a descriptor, tried, approved, bound and used by a published service: plain language and image generation (done under ADR 0047), transcription with `gpt-transcribe`, image editing with `gpt-image-2`, audio in and out with `gpt-audio-1.5`, a streamed answer, a batch, and a live session with `gpt-realtime-2.1`.
2. **A blind provider.** A mock provider with APIs the builders have not seen, made in a separate session after this record is built. Its public documentation is handed over in two waves; the second wave is added on descriptors and modules alone. The person who made it judges the result from the provider's own request log, leak detector and list of objects left behind.
3. **Hostile descriptors.** Descriptors that try to send unclassified data, reach another host, take a path, model or object id from input, read a credential or keep objects without a deadline are all refused.

## Why

A list of patterns is a closed world: it needs code for the first API that does not fit. Transports, encodings and steps change at the pace of web standards, so building them once and letting descriptors combine them covers APIs we cannot foresee.

Classifying data instead of approving API types keeps the rules the same for every API. The gate never needs to understand what an API is for, only what crosses it.

Modules cover what a data language cannot say without opening the platform to code: they run with no network and no secrets, and their output is walked like any answer.

Turned down:

- A list of patterns, the first version of this record: still code per new kind of API.
- Plug-ins in JavaScript or containers: they would need network and secrets, and the gate could not see what they send.
- Opaque pass-through for uploads or sessions: it cannot mask, meter or audit.
- Short-lived provider keys in the browser: the provider would see the user directly, and Genki would see nothing.

## Consequences

- ADR 0047's "Kept out" section and the loader's refusal of `/realtime`, `/batches`, `/files`, `store` and the like are replaced by the declarations above. The refusals stay for any descriptor that does not declare what it creates.
- Today's descriptors stay valid as one-step descriptors.
- Price units become open (ADR 0048 named eight).
- ADR 0044 still holds for the built-in chat implementations: they stay stateless.
- The session relay adds long-lived connections to the API; their limits are set per environment.
- A provider object that cannot be deleted is an incident.
- Not built yet: everything above, #326 and #302.
