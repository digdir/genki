# 0049 Any provider API through descriptors

Status: built except the blind-provider proof and the genki-test runs, 2026-11-06. Built: classes (`issued`, multipart filenames, `$dataUrl`), credential placements `header`, `query`, `form`, `basic` and `signedBy: module`, arithmetic `$add $sub $mul $coalesce`, multi-type media output, `until.fail`, open units in usage totals, streaming (sse, ndjson, lines) through the gate and on `/v1/chat/completions`, `resources` with the ledger, `finally` deletion, the nightly sweep and incidents in Revisjon, the processor record's provider state, operator `allowedHosts`, WebAssembly modules, live sessions (`websocket`, `GET /v1/sessions`, `live-session@1`) and the hostile descriptors of each. A caller's audio, image or file reaches a `call-operation@1` step as `{{input.files.N}}`, so transcription, image editing and audio chat can take what a caller sends. Described and fixtured, never run live: `openai/chat-stream@1`, `openai/batch@1`, `openai/realtime-transcription@1`. See "What building changed" below.

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
- `http` with `response.stream` on a step: one request, an answer that arrives in parts, framed as `sse`, `ndjson` or `lines`. A step streams its text deltas through the gate.
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
- `issued`: an identifier the provider issued, written `{ issued: '<anchored pattern>' }`. It comes only from an answer in the same run (`bind` with `class: { issued: ... }`), never from input, and is the only class that may fill a path segment or go back out as an id; the pattern is checked every time. A plain `ref` in an answer shape is read but cannot be sent anywhere.
- `url`: a link in an answer, bound only for `request.follow` (section 6).
- `number`, `enum`, `boolean`: as today.
- `json`: arbitrary JSON. The walker masks every string inside it, and the masking probe of `operation@1` puts synthetic personal data into every string it allows.
- `opaque`: state the provider gave that is replayed unread, only within the same run.

The mapping language gains indexing (`$response.items.0`), `$concat`, `$join` and `$if`. Nothing in input chooses a host, a model, a credential or a path outside a pattern-checked `ref`.

### 5. Credentials and signing

The credential stays on the connection (ADR 0048) and never appears in a descriptor, a module, a log or an answer. A descriptor says where it goes, per step: a header with a scheme, a query parameter, a form field or HTTP basic (`credential: { place: header | query | form | basic, ... }`); a query parameter is redacted from every log. A token from an exchange step is bound as `secret`, a class that only the gate can place and that nothing else can read. Signing a request over its body, a timestamp or a header set is done by a module (section 8) through a host function that takes the key's name, never the key. A key that only signs is declared `auth: { signedBy: module }`: it reaches the module's `hmac_sha256` and is placed on no request, every step that sends it to the connection then needs a module that takes the connection key, and no step may place it. A step that carries a token an exchange step bound, or reads a followed link, needs no module.

### 6. Where requests may go

Every request goes to the connection's resource, at a path the descriptor states. Redirects are never followed. A URL in an answer, such as a signed download link, is followed only through a step's `request.follow`, from a value bound with the `url` class, over https, without a login, and only when its host is the connection's own or one the operator lists on the connection under `allowedHosts`, a change that is audited. The credential is never sent to a host other than the connection's own; those calls go through the egress guard. Input never names a URL, so an API in which the provider fetches a URL given by the caller cannot be described; it is refused at load.

### 7. Things kept at the provider

A `ref` that names something the provider keeps, such as an uploaded file, a job, a session, a stored response or a conversation, is declared under `resources: [{ id: <step>.<bound field>, delete: <step name>, longestSeconds }]`. A resource with no `delete` is `retained`: it is in the ledger as kept, never due, and needs the processor record's retention.

- The executor records every such object in a ledger: tenant, run, connection, object id, created and delete-by.
- The object is deleted by the descriptor's `finally` steps, or at its longest life. A failing delete in `finally` does not fail the call; the object stays open for the nightly sweep (`packages/jobs`, cron `43 3 * * *`), which deletes what is left. What it cannot delete becomes an incident (`platform.provider-object.incident` in Revisjon, state `incident`); an incident is final, the sweep does not retry it, and an operator deletes it by hand.
- A connection serves descriptors that keep things at the provider only when its processor record has `providerState: { allowed: true, retention: { days, note } }`. Otherwise the call is refused as `processor`.
- A `ref` the provider can keep but offers no way to delete is allowed only when the processor record names that retention.

### 8. Modules for what the language cannot say

A descriptor may name a module: a WebAssembly component, pinned by its SHA-256, uploaded and reviewed with the descriptor. It is for what data cannot express, such as a request signature, a binary framing or an unusual codec. It is declared as `modules: { <name>: { sha256, keys: [connection] } }` (at most two), used by a step as `module: { use, emits, headers }`, and uploaded with the descriptor (`PUT /operator/operation-descriptors/{id}` with `modules`, 128 KiB at most each; the SHA-256 pin must match). It runs in a worker with 250 ms, 16 pages of memory and 1 MiB of input, and only these host functions (`genki.input_read`, `sha256`, `hmac_sha256`, `hex_encode`, `hex_decode`, `base64_encode`, `base64_decode`, `emit`):

- encode and decode bytes, hash, and sign with a named key (the key never enters the module); it reads `method`, `body`, `timestamp` and `path`, the path as sent, with the connection's base path and the query but without a key or `secret` placed in the query, so a signature never covers one;
- read the step's classified values and return classified values, which the gate walks like any answer.

A module has no network, no file system, no clock beyond the timestamp the gate passes and no access to other runs; a module that declares its own memory or any other import is refused. It emits at most eight values of 512 bytes. Each emit must be pinned by the descriptor to an anchored `ref` pattern or an enum and goes only to a declared, non-credential header, so a module can change how bytes look, never what leaves. A module signs requests; it does not frame streams or sessions.

### 9. Usage and units

A descriptor maps usage from wherever the provider reports it: a field in the answer, a header, the last stream part, a session message or a separate step. Units are open: a descriptor names its units (for example `page`, `pixel`, `frame`), and an operator prices them per model and kind as in ADR 0048. A unit without a price is metered and shown as not priced. The eight units of ADR 0048 are the built-in names.

### 10. Errors

A descriptor maps the provider's error envelope to Genki's error kinds (`invalid`, `unavailable`, `rate-limited`, `refused`, `processor`). `429` with `Retry-After` is honoured up to the step's cap. An answer whose content type differs from the one declared fails the call. The provider's status and the first 500 characters of its error body, JSON or plain text, with the connection's key and bound secrets redacted, go to the run's audit error and the run timeline of those who manage the service, never to the caller; the API log has the status, and the body only with `LOG_FAILURE_MESSAGES`.

### 11. Sessions

A `websocket` step is a session. Genki relays it: the frontend connects to Genki at `GET /v1/sessions` with an upgrade, under the same access as `/v1/chat/completions`, and Genki connects to the provider. The credential and any short-lived provider key stay in Genki. Every message in both directions is walked against its class: text is masked and restored, audio frames are `media`. The run is the session; its transcript, usage and audit belong to the run, and it ends at its longest duration (close code 4001), when the service's kind is moved back to test (4002), when the caller closes, or when the provider sends its declared `done` event. The step is `websocket: { longestSeconds, maxMessages, maxMessageBytes, client, server }`: each declared event has a shape, and a server event may map `transcript`, `usage`, `done` or `fail`; an event the descriptor does not declare ends the session as an error. A client binary frame is media under consent and may be sent on as a declared JSON event with `client.binaryAs`. A guardrail that holds a stream back (`holdsStream`) refuses a session. Tool calls in a session go through the service's tools and the gate. A service uses a session through the way of working `live-session@1`, whose config names the descriptor; the way of working waits 15 seconds for the connection the route hands over, and its answer is the transcript.

### 12. Checks

A descriptor may declare `checks` on an answer: `same-names` (every question has one answer), `count` and `one-of`. A failed check fails the call.

### What building changed

- `stream` is a property of a step (`response.stream`), not of the descriptor.
- Answer URLs are never followed by redirect; `request.follow` with the `url` class is the one way, and only for https links to allowed hosts.
- `issued` replaced `ref` as the class that may be sent; `resources` has `retained`, and an undeletable object is a final incident.
- Multipart filenames are mapped (`filenames`), and `credential` is placed per step.
- A signature cannot be proven by a fixture, because the contract uses its own probe key; module headers are left out of the recorded request, and the signing is proven by tests with a hand-built module (`packages/operations/src/module.test.ts`). A fixture may carry `at`, the signing time.
- A session fixture records `session: { request, messages: [{ from, message, binary? }] }` and `operation@1` replays it against a scripted provider.
- A descriptor polls for 600 seconds at most, so `openai/batch@1` serves batches that end within ten minutes; longer batches need work that outlives a call, which this record does not build.
- The kernel's usage totals add open units (`units`), and the API shows them wherever usage is returned; the portal does not show them yet.
- Bundled descriptors cannot ship modules yet; a module comes in an upload.
- A live run on genki-test on 6 November failed with only "the service failed": the provider's error was in no run, audit event or log. The provider's status and redacted error body are now kept for the audit and shown to those who manage the service, and a non-streamed `call-operation@1` step whose result is text, or has a text field `text`, answers with that text as a streamed one does.

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
- A module runs in a fresh worker per call; a service that signs many requests a second would need a pool.
- Not built yet: everything above, #326 and #302.
