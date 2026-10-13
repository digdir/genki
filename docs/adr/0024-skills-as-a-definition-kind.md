# 0024 Skills as a definition kind

Status: accepted, 2026-10-12 (built). Proposed 2026-10-07

## Decision

A skill is a third definition kind, `Skill`, next to `Service` and `StepFlow` (0005, 0007). It holds a description, instructions, examples, the tools it may call, attachments and its own test set. It is stored in `definition_versions` like the other kinds, so it needed no migration.

- **Versions are whole numbers**, like services. A draft lives as a `skill-draft` config entry until it is published as the next version.
- **Services pin skills** in `spec.skills` as `id@version`. Publishing a service checks that every pinned version is published and that the skill's tools are within the service's own tools. A skill never widens access: it can only narrow or guide what the service already may do.
- **Skills reach the model only when pinned.** The skills module adds them to the capability config through `decorateCapability`, at sync and for draft runs. A service without `spec.skills` runs exactly as before.
- **Publishing has four requirements:** a test run on the current draft, a pass rate at or above the test set's threshold (or `skills.defaultPassThreshold`, 0.9), every `must_reject` case rejected, and only published tools.
- **Sharing goes through Digdir.** A tenant asks to share a published version (`skill-share`, state `pending_digdir`), a Digdir operator approves or rejects it, and other tenants can then pin or copy it, read-only.
- **The exchange format is Agent Skills:** a zip with `SKILL.md` (YAML frontmatter and instructions) and its attachments, for both export and import.

## Why

Instructions that several services share were copied by hand between prompts and drifted apart. Making them a versioned, tested definition gives them the same review, pinning and rollback as services, and the Agent Skills format keeps them portable to other tools (0023).

## Consequences

- A known limit: a pinned ref carries no owner. If two tenants share a skill with the same id, the first match wins. A ref with an owner is a follow-up.
- Usage counts rescan the services on each request; that is fine at today's volumes.
- Other instances pick up share decisions through the `config-entries` topic on the change feed.
