# 0052 Answers cite excerpts, not whole documents

Status: proposed, 2026-11-03 (prototype, agent loop only)

Left: the `rag` and `step-flow` strategies keep numbering documents, and conversation history stores no markers.

## Context

The agent loop numbers documents for the model: `numberByDocument` gives one `[N]` per document with all of its excerpts under it, and `chunkIdsToMarkers` folds a cited excerpt back into its document's number. So `[2]` means «somewhere in the second document». A reader gets a whole document, often 5 to 10 excerpts, to check one sentence, and a frontend cannot keep footnotes and excerpts one to one (issue #273).

## Decision

- **A service chooses what a marker points to,** with `spec.strategy.config.citeBy` in the `agent-loop` strategy: `document` (the default, as before) or `excerpt`. Nothing changes for a service that does not set it.
- **With `excerpt`, every excerpt in the context has its own number.** `numberByExcerpt` numbers the excerpts `[1]`, `[2]`, … with a document's excerpts next to each other, and the instruction tells the model to cite the excerpt a claim rests on, also when two excerpts come from the same document. Each excerpt is framed as untrusted data the way a document's text is (#280), carrying the id of the document it comes from.
- **Validation and backfill work per excerpt,** through the same index: a chunk id the model writes becomes the marker of that excerpt, an uncited answer is re-synthesised from what was read with excerpt numbers, and a marker that leads to no excerpt is removed from the answer (notice `answer-discarded`, reason `unknown-markers`). No marker the reader sees leads nowhere.
- **The mapping is in the output.** The answer part's `meta` has `citations: [{ index, chunkId, document }]` and `citeBy: 'excerpt'`.
  - `/v1`: a top-level `markers: [{ marker, chunk_id, document }]` in marker order, with `marker` a string as written in the answer without brackets. `sources[]` stays one per cited document: `index` is its lowest marker, `markers` the markers that cite it, and `excerpts[].markers` the markers that cite each excerpt. The top-level `citations` (links people can open) is unchanged.
  - MCP: the same list as `structuredContent.markers`, declared in the output schema.
- **Frontends number markers for the reader as they like.** The platform's markers are the numbers in the context; a frontend may show the cited excerpts as 1, 2, 3 in the order the answer first cites them.

## Why

A reader can check a sentence against the one passage it rests on, and a frontend can show exactly one excerpt per footnote and a footnote for every excerpt it shows.

Turned down:

- **Dotted markers such as `[1.2]`.** They keep the document visible in the marker, but every frontend's `[N]` parsing, the source-list filter and the marker validation would change, for no gain once the output maps each marker to its document.
- **Excerpt numbering for every service at once.** A frontend that reads `[N]` as document N would point footnotes at the wrong sources. Opting in lets a frontend move first.
- **Renumbering markers 1, 2, 3 in the platform.** Which numbers a reader sees is presentation, and it differs between frontends.

## Measured

A replay of the answer step, 2026-11-03.

**Sample.** 37 questions captured from the test environment that day, each with the excerpts of the documents its answer cited: 140 excerpts in 55 documents. 27 questions have a document with several excerpts. Each question was answered twice in each mode, with the platform's own prompt and citation code and one model (`gpt-5.6-terra`, at its default temperature): 74 answers per mode.

|                                                             |      By document |                         By excerpt |
| ----------------------------------------------------------- | ---------------: | ---------------------------------: |
| Markers in the answers                                      |              367 |                                360 |
| Markers that lead to exactly one excerpt                    |       136 (37 %) |                        360 (100 %) |
| Excerpts a marker leads to, mean and highest                |         2.75, 15 |                               1, 1 |
| The same, in the 27 questions with a multi-excerpt document | 13 % lead to one |                              100 % |
| Markers that lead nowhere, in other forms, or as chunk ids  |                0 |                                  0 |
| Answers that cite two excerpts of one document apart        |   (not possible) |                           33 of 54 |
| Answers with no citation                                    |                0 | 1, a refusal over a single excerpt |

Every number in a cited sentence is in the text the marker leads to: 276 of 276 by excerpt, and 305 of 305 by document, where that text is the whole document.

Not measured: the whole loop against live retrieval (search, reading, backfill), other models, and a service's own instructions. The replay also ran before #280 framed source text as untrusted data; both modes frame it now, so the comparison holds, but the absolute numbers were measured without the frame.

## Consequences

- **Migration note for frontends.** With `citeBy: excerpt`, several markers can lead to one source, and `sources[].index` is only the lowest of them. Resolve `[N]` through `markers` (`/v1`) or `structuredContent.markers` (MCP), never through `index` alone. `docs/frontend-contract.md` says so.
- A service turns it on with one line in its strategy config, after its frontend reads `markers`.
- Not built: excerpt numbering in the `rag` and `step-flow` strategies, and markers in stored conversation turns.
- The tests are `packages/strategy-agent-loop/src/excerpt-citations.test.ts`, `packages/adapter-openai/src/frontend-contract.test.ts` ("when the answer cites excerpts") and `packages/adapter-mcp/src/markers.test.ts`.
