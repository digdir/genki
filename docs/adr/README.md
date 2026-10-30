# Architecture decisions

Each record says whether it is built, and names what is missing if not. Numbers that are not listed (0009, 0012 to 0014, 0016, 0018 and 0019) were withdrawn or merged into other records before the repository was published.

| ADR                                                      | Title                                                        | Status                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------- |
| [0001](0001-foundations.md)                              | Foundations                                                  | Accepted, partly built                                              |
| [0002](0002-paradigm-neutral-kernel.md)                  | A paradigm-neutral kernel                                    | Accepted, built                                                     |
| [0003](0003-evaluation-is-part-of-the-platform.md)       | Evaluation is part of the platform                           | Accepted, built; amendment accepted in 0040, not built              |
| [0004](0004-service-capability-and-version.md)           | Service, capability and version                              | Accepted, built                                                     |
| [0005](0005-definition-store-authority.md)               | Definition store authority                                   | Accepted, built                                                     |
| [0006](0006-configuration-layers.md)                     | Configuration layers and resolution                          | Accepted, built                                                     |
| [0007](0007-paradigm-neutral-service-definition.md)      | Paradigm-neutral service definition                          | Accepted, built                                                     |
| [0008](0008-principal-model-and-api-key-bridge.md)       | Principal model and the API-key bridge                       | Accepted, built                                                     |
| [0010](0010-admin-operations-and-audit.md)               | Admin operations and audit                                   | Accepted, built                                                     |
| [0011](0011-retention-erasure-and-archiving.md)          | Retention, erasure and archiving                             | Accepted, built; amendment accepted in 0040, not built              |
| [0015](0015-tenant-tools-and-secrets.md)                 | Tenant-provided tools and secrets                            | Accepted, built                                                     |
| [0017](0017-parity-scope-and-intentional-divergences.md) | Parity scope and intentional divergences                     | Accepted, built                                                     |
| [0020](0020-changes-made-by-ai.md)                       | Changes made by AI                                           | Accepted, built                                                     |
| [0021](0021-model-access-through-protocol-adapters.md)   | Model access through protocol adapters                       | Accepted, built                                                     |
| [0022](0022-tenant-isolation-in-postgres.md)             | Tenant isolation in Postgres                                 | Accepted, built                                                     |
| [0023](0023-extension-model.md)                          | Extension model                                              | Accepted, built                                                     |
| [0024](0024-skills-as-a-definition-kind.md)              | Skills as a definition kind                                  | Accepted, built; amendment accepted in 0040, not built              |
| [0025](0025-search-engine-switching.md)                  | Search engine switching                                      | Accepted, built                                                     |
| [0026](0026-builder-assistant-and-proposals.md)          | Builder assistant and proposals                              | Accepted, built                                                     |
| [0027](0027-platform-rights.md)                          | Platform rights                                              | Accepted, built                                                     |
| [0028](0028-custom-logic-from-outside.md)                | Custom logic comes from outside                              | Accepted, partly built                                              |
| [0029](0029-language-instructions.md)                    | Language instructions                                        | Accepted, built                                                     |
| [0030](0030-frontends-from-schemas.md)                   | Frontends from schemas                                       | Accepted; (a) partly built, (b) built and proven by two test builds |
| [0031](0031-services-variants-and-ways-of-working.md)    | Services, variants and ways of working                       | Accepted, partly built                                              |
| [0032](0032-the-portal-is-one-client.md)                 | The portal is one client                                     | Accepted, partly built                                              |
| [0033](0033-locked-test-environment.md)                  | Locked test environment                                      | Accepted, built                                                     |
| [0034](0034-tokens-in-the-browser.md)                    | Tokens in the browser                                        | Proposed                                                            |
| [0035](0035-operator-login.md)                           | Operator login                                               | Proposed                                                            |
| [0036](0036-delegating-platform-rights.md)               | Delegating platform rights                                   | Proposed                                                            |
| [0037](0037-simple-and-developer-view.md)                | Simple and developer view in the portal                      | Proposed                                                            |
| [0038](0038-ai-gateway.md)                               | The AI Gateway as a usage source, key issuer and model route | Proposed                                                            |
| [0039](0039-parquet-sources.md)                          | Parquet sources                                              | Proposed                                                            |
| [0040](0040-evaluating-with-langfuse.md)                 | Evaluating with Langfuse                                     | Accepted, not built; judges that block proposed                     |
| [0041](0041-durable-jobs-on-pg-boss.md)                  | Durable jobs on pg-boss                                      | Proposed                                                            |
| [0042](0042-the-knowledge-database.md)                   | The knowledge database                                       | Proposed, connection to the knowledge server built                  |
| [0044](0044-stateless-openai-responses.md)               | Stateless OpenAI Responses behind the model port             | Accepted, built                                                     |
