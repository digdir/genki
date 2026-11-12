# 0020 Changes made by AI

Status: accepted, 2026-10-12 (built). Proposed 2026-10-06

## Decision

- The builder assistant and optimisers only produce **proposals**: a diff against a service version, with scores, cost and examples.
- A human publishes a proposal through the normal publish path, with their own principal and rights, and the normal gates. High-risk services need two different approvers: the person who publishes and a recorded risk confirmation from someone else. A tenant import follows the same rules and records the importing person as the one who confirmed the risk class.
- The builder assistant may propose a risk class, but a human sets it.
- Neither may touch secrets, register tools, or widen access beyond what the person using them has.
- Automatic changes are out of scope. The AI Act's predetermined-change exception (art. 43(4)) covers only high-risk systems that keep learning after release, with the changes fixed at the first conformity assessment. It does not cover swapping prompts or models.
- Both are services on the platform: published Service definitions owned by the platform tenant (`builder-assistant` and `optimiser`), run through the kernel on the model the definition grants, with a token budget and the definition version as provenance. Their instructions change only through the normal publish path.
- Each has its own test set (`packages/eval/testsets/builder-assistant.yaml` and `optimiser.yaml`), scored by the contract evaluator and run offline against a replayed model. Only the platform tenant can publish a service on these two strategies.
- The optimiser proposes new instructions only, and refuses instructions that reference a secret. Approving its proposal writes to the draft, never to the published service.

## Why

An LLM that edits definitions can be prompt-injected through the documents it reads, and could otherwise add tools, datasets or lower guardrails.

## Consequences

- One reviewable path for every change, whoever or whatever proposed it.
