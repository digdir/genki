# 0057 A caller stops a run it started

Status: proposed, 2026-11-15 (built, 2026-11-15)

## Context

A run goes on when its client stops reading the stream, on purpose: a reader who reloads the page or leaves a thread finds the answer stored when it is done. So a frontend had no way to say that the person wants the answer stopped. The run went on, used tokens, and stored the whole answer, which showed up later in a thread the reader had stopped. The kernel could cancel a task, but only on the instance that ran it, and nothing on `/v1` called it.

## Decision

- **An explicit route stops a `/v1` run.** `POST /v1/tasks/{task}/cancel` stops a run started through `/v1`: a chat completion, whose id is the `genai-task` header, or a live session, whose id is the `task` it was opened with. Their tasks record the entry point `openai` (`Task.entryPoint`). A disconnect never cancels a run. A chat completion asked without streaming sends `genai-task` only with its answer, so its own client cannot stop it.
- **Only the caller who started it.** The same principal (kind, issuer and subject) in the same organisation, and, when the run belongs to a conversation, a caller who may read that conversation, so a service key sends the same `X-User-Id` as when it asked. Anyone else, an operator included, and a task that does not exist, get `404 task_not_found`, as genki answers for what a caller may not see. A run without a conversation is the key's own, as for feedback: `X-User-Id` plays no part.
- **Other runs are not stopped here.** A run with another entry point or none (batch runs, test-set runs, the playground, `/api/tools`, MCP, A2A, a child task) is refused with `409 run_not_cancellable`. A run that has completed or failed is refused with `409 run_finished`. A cancelled run answers `200` again, so the call is idempotent.
- **Through the kernel's own abort path.** The route calls `Kernel.cancel`, which aborts the run the way a deadline or a used-up budget does: the abort signal reaches the model call through the gate, the task records `cancelled` in the task store, and the status change is in the run's event log.
- **On whichever instance runs it.** A cancel for a task another instance runs is recorded in the task store (`TaskStore.requestCancel`, the column `tasks.cancel_requested_at`), and every kernel asks the store about its own running tasks every `cancelPollMs`, 1 second by default. The request is cleared when the task leaves `queued` and `running`, so a run that paused for approval before its instance saw it is not stopped later when it resumes; the route cancels such a run itself. A2A's `tasks/cancel` and the operator's `POST /operator/tasks/{task}/cancel` call the same kernel method and reach other instances the same way.
- **The answer says where the stop is.** The route waits up to 2 seconds for the run to end and answers `200 { id, object: "task", status: "cancelled" }`, or `202` with the current status when the stop has not landed yet.
- **The turn is kept as stopped.** A `/v1` run cancelled while it runs, that belongs to a conversation, stores an assistant turn with `stopped: true`, its `task`, no sources, and as text the answer as far as it had come, after any drafts the run took back. The conversation is kept, streamed or not. A stopped turn is left out of the history that later questions get. A client still reading the stream keeps what it got, and the stream ends with `finish_reason: "error"` and `failure_code: "cancelled"`.
- **A cancel is not a call to a service.** The monthly token quota does not refuse it, since it only ends work.

## Why

- Cancelling on disconnect was turned down: clients disconnect on purpose, and an answer must still arrive after a reload or a visit to another thread.
- A route under `/v1/tasks/{task}` uses the id the client already holds, sits beside the media route, and keeps the channel and origin rules of a registered frontend.
- The task store, read once a second by each instance that runs tasks, was chosen over a notification between instances: a notification missed while a connection is down loses the cancel, and the query is one lookup by primary key.
- Recording the entry point on the task, rather than refusing by capability, lets the route refuse a batch item or a playground run that the same person started, so those runs keep their own bookkeeping.

## Consequences

- Frontends call the route when the person stops an answer. `@genai/client` has `cancel(taskId)`, yields the run's id first on a stream as a `task` event, and reads `stopped` on stored messages. The UI assembly's «Avbryt genereringen» does not call it yet.
- The UI assembly and the workspace do not read `stopped` yet, so they show a stopped turn as an answer.
- A run whose instance stopped stays `running` in the store; a cancel for it answers `202` and nothing ends it.
- A task stored before this change has no entry point and cannot be stopped through `/v1`.
- Deleting a conversation does not stop a run in it; a client stops the run first.
- Test-set runs and the playground have no route that stops a run.
