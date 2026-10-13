# 0002 A paradigm-neutral kernel

Status: accepted, 2026-10-12 (built). Proposed 2026-10-06

## Decision

The kernel holds only what has stayed constant across completion, chat, RAG, agents and whatever comes next:

- an identified principal acting for a tenant invokes a named capability with typed input
- every invocation is a task with an append-only event log
- access, quotas and budgets are enforced in one place
- data and models are reached only through the kernel's broker, which checks grants, meters use and records what was used

The kernel has no concept of message, tool or chat. A **strategy** turns input into output and is a plugin: single-shot RAG, the agent loop and step graphs today. Protocol adapters, models, search, stores and authenticators are plugins too.

v1 reserves fields for what it does not build yet: duplex interaction, interrupts with human approval, oversight risk class, and checkpoints.

## Rules

- `packages/kernel` imports only `packages/contracts`. CI fails otherwise.
- Contracts and ports follow semver independently. Event types carry their own version.
- New event types start as `x.<namespace>.<name>` and move to `kernel.*` once two strategies use them.
- If a new paradigm cannot be a strategy, a port change or an `x.*` event, write an ADR that answers: which invariant does not hold, why not an extension, can it ship as an additive minor version, and what is the migration path.
- Only the kernel writes the audit record: status, input, usage, resources used, spawned children, resolved interrupts, errors, scores and feedback. A strategy that emits a kernel-owned event fails.
- A task belongs to the calling tenant. The capability's owner is recorded separately, and a capability runs for another tenant only when it is shared with it.
- State is keyed by tenant and full principal. Thread ids from callers never reach state on their own.
- Budgets are enforced by the kernel, along the whole chain of parent and child tasks. Ports report usage through their context, not the strategy.
- Every task records the capability version, the strategy version and a hash of the resolved configuration.
- Clients see only client events. The audit stream is a separate call that needs its own right.
- A task always ends: a throwing strategy fails it, cancel ends it at once, and a deadline fails it.
