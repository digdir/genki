# 0029 Language instructions

Status: accepted, 2026-10-12 (built). Proposed 2026-10-12

## Decision

A service can fine-tune how it answers in each language, through instructions and not by training models.

- **The answer language is chosen as today.** The language of the question (bokmål, nynorsk or English), `answers.writtenStandard`, or a service's `language` guardrail decides it. A service lists the languages it answers in with `spec.languages` (default `[nb, en]`). A service that lists bokmål also answers in nynorsk, since the two are written standards of one language. A question detected as bokmål, nynorsk or English in a language the service does not list is answered in the service's first language, with one line saying so. A question whose language cannot be detected (short, names, JSON) never counts as unsupported, and structured output (fields, tables) never gets the line.
- **Instructions are added, not replaced.** When the answer language is L, the model gets, in this order: the service's instructions, the house style for L, and the service's text for L. Each part is optional. The service's instructions stay the one source of truth, so three versions of a prompt cannot drift apart.
- **House style is a setting per language.** `answers.languageInstructions.nb`, `.nn` and `.en` are texts, settable at platform and tenant, and at service for a service that needs its own house style. The most specific layer wins, with the provenance and locks of ADR 0006. Digdir writes the platform texts, starting from today's "Svar på bokmål." and plain-language rules; an agency adds its own terms at tenant level. They cannot be set per call: a caller never adds instructions. The playground can force an answer language, through the draft's `language` guardrail.
- **Service text per language is in the definition.** `strategy.config.languageInstructions` maps a language to text or a prompt file (`prompts/<name>.<lang>.md`). A variant can override it like any other config (`variants[].overrides.languageInstructions`).
- **A full prompt per language is the exception.** `instructions` may be `{nb: ..., en: ...}` for a service whose languages need different prompts. Validation requires every listed language to have one.
- **One place applies it.** The guardrail wrapper that already chooses the language builds the text and scopes it to the calls that write the answer, for every strategy (single call, RAG, agent loop, step flow synthesize blocks and streaming model blocks). A strategy marks those calls with `purpose: 'answer'` on the model request. Planning, search and judge calls are not given it.
- **Every task records what was used.** Provenance names the answer language, the layers that contributed and a hash of the assembled texts. The service's own texts are part of the configuration hash, so a change shows up as a new configuration; house style comes from settings resolved at run time, so its change shows up in the provenance hash instead.
- **Quality is measured per language.** Test cases carry a language, and publishing gates can require a result per language, so a change to the English text is shown not to harm bokmål.

## Why

Agencies want answers that read well in each language, with their own terms and conventions, without maintaining a separate prompt per language. Instructions are versioned, testable and editable in the portal; fine-tuned models are costly, tied to one vendor and slow to change. Adding to one prompt keeps a single source of truth, and the settings layers already give Digdir and agencies a place to agree on house style.

## Consequences

- The portal's Instruksjoner section gets a tab per language: the inherited house style read-only with an override, the service's text, and an option to write a full prompt per language instead of the shared one. The playground can force an answer language. The console edits the platform texts in multi-line fields.
- Bokmål and English texts are written and tested now. Nynorsk gets today's one-line instruction until its texts are written; the mechanism is the same for any language, including later ones.
- The optimiser can propose a change to one language's text at a time: a proposal request names the language, the optimiser sees only that language's failing cases, and the change is written to that language's text in the draft. A language without a text of its own is refused.
