# Parity harness

Black-box comparison of headless-rag (`old`) and the new platform (`new`) over HTTP. Neither system is changed or imported; everything goes through their public APIs.

## Commands

```sh
npm run parity -w @genai/parity -- record --target old          # scenario fixtures from headless-rag
npm run parity -w @genai/parity -- compare --target new         # replay against the new platform
npm run parity -w @genai/parity -- compare --target new --playback
npm run parity -w @genai/parity -- baseline --questions q.json --out baselines/old --target old
npm run parity -w @genai/parity -- baseline --against baselines/old/kudos.json --out baselines/new --target new
npm run parity -w @genai/parity -- playback --mode record      # or --mode replay
npm run parity -w @genai/parity -- sweep --questions q.json --repeats 3
npm run parity -w @genai/parity -- quality --testset packages/eval/testsets/headless-rag-website-118.yaml
npm run parity -w @genai/parity -- quality-report --testset packages/eval/testsets/headless-rag-ue-42.yaml
npm run parity -w @genai/parity -- retrieval-score --target both --testset <set>
npm run parity -w @genai/parity -- rerank-benchmark --target both --max-acceptable-rank 10 --fail-on-gate
npm run parity -w @genai/parity -- auto-filter-eval --target both
npm run parity -w @genai/parity -- agent-budget-benchmark --repeats 3
```

Settings come from `.env.parity` in the repo root, which programs read and nobody prints:

| Variable                                                                       | Used by                                                                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `PARITY_OLD_URL`, `PARITY_OLD_API_KEY`                                         | every command against headless-rag                                                          |
| `PARITY_NEW_URL`, `PARITY_NEW_API_KEY`                                         | every command against the new platform                                                      |
| `PARITY_LLM_UPSTREAM_URL`, `PARITY_LLM_UPSTREAM_KEY`                           | `playback --mode record`                                                                    |
| `PARITY_LLM_UPSTREAM_AUTH`                                                     | `bearer`, or `api-key` (default, Azure style)                                               |
| `PARITY_JUDGE_URL`, `PARITY_JUDGE_KEY`, `PARITY_JUDGE_MODEL`                   | `sweep`; OpenAI-compatible, ideally another model family                                    |
| `PARITY_NEW_OPERATOR_TOKEN`, `PARITY_NEW_SUPPORT_SESSION`, `PARITY_NEW_TENANT` | operator diagnostics: stage attribution and fixed-query retrieval on the platform           |
| `PARITY_OLD_DEBUG_KEY`                                                         | headless-rag's `/api/debug/typesense-retrieve` (needs `RAG_TS_RETRIEVE_ENABLED=true` there) |
| `PARITY_OLD_SERVED_MODEL`, `PARITY_NEW_SERVED_MODEL`                           | quality report, only when a system does not report its model; marked as declared            |

## Playback stub

Both systems point their model endpoint at the stub (`http://127.0.0.1:8790/v1`). In record mode it forwards to the upstream with its own key and stores each answer in a cassette; in replay mode it answers from the cassette, so both systems get the same model output and can be compared exactly.

- Requests are matched by a hash of the conversation (`messages`, `tools`, `tool_choice`, `response_format`, `stream`, `input`) and the endpoint kind. The model name, temperature and other sampling details are left out, because each system names its deployment differently.
- The same request recorded several times is replayed in recorded order; after the last recording the last answer repeats.
- An unrecorded request gets HTTP 404 with `playback_miss`, never invented output. The count is printed when the stub stops.
- No header is stored, and body keys that look like credentials are dropped before writing.

## Names per side

Each system calls the same capability by its own name. `scope.json` maps every capability in parity scope to its headless-rag name (`old`) and the platform's native name (`new`, `<service>__<variant>`):

| Capability | headless-rag (`old`)                               | platform (`new`)                              |
| ---------- | -------------------------------------------------- | --------------------------------------------- |
| `agent`    | `builtin.agent-rag-agent__agent-rag-graph-bundled` | `kunnskapsassistenten__default`               |
| `probe`    | `builtin.retrieve-only-agent__retrieve-only`       | `kunnskapsassistenten-retrieve-only__default` |

Scenarios build each request for the side they run against: MCP tool names, the `/v1` model and the REST `agentId` (headless-rag's agent path, `builtin/agent-rag-agent`, or the platform's service id, `kunnskapsassistenten`). `record` and `compare` take the side from `--target`. Fixtures keep headless-rag's names; before comparing, the platform's names in its response are mapped back to headless-rag's, and only capabilities in scope are compared. `baseline` and `sweep` use the same mapping, and `sweep --model` sets the platform side only. A test fails if a new-side name in `scope.json` or `testsets/targets.json` is not served by the seeded definitions in `apps/api/config/local/services` and `config/services`.

## Comparison rules

Each source of nondeterminism has one rule, implemented in `src/compare.ts` and `src/runner.ts`.

| Source              | Rule                                                                                                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ids and timestamps  | UUIDs, ISO timestamps, `chatcmpl-…`, `call_…`/`toolu_…` and `msg_…`/`run_…`/`thread_…` ids are replaced by placeholders, and volatile keys (`conversation_id`, `created_at`, `elapsed_ms` and similar) by `<volatile>`, before an exact comparison. |
| SSE timing          | Frame timing, keep-alive comments and the number of delta frames are ignored. The final data frame is compared (exactly or by shape), and the set of progress event names is compared as a warning.                                                 |
| Typesense tie order | Ranked hits are split into groups of equal score (12 significant digits). Order inside a group is free; group order and membership must match. Hits without scores are compared strictly by position. Baselines store ties sorted by id.            |
| LLM output          | Steps of scenarios that need an LLM are compared by shape, unless `--playback` is given, in which case both systems got the same model output and the step's own mode (usually exact) applies.                                                      |

A step can also carry a `check` of the new platform's response alone, for what a shape comparison cannot see: a filter that must empty the result, citations that must resolve to a document, frames that must stream. A failed check fails the scenario.

## Intentional divergences

`divergences.json` is the machine-readable form of the table in [ADR 0017](../../docs/adr/0017-parity-scope-and-intentional-divergences.md); a test fails if the two drift apart. Scenario ids match exactly, or by prefix when the entry ends in a dot.

- `skip`: the scenario is not run, because headless-rag is not the reference. The report shows `SKIPPED` with the ADR reason.
- `invert`: the scenario must differ from headless-rag in the way the entry's `expect` says (status codes, JSON paths in the body). It reports `DIVERGENCE` when it does, and fails when the new platform still behaves like headless-rag or diverges in another way.

## Retrieval baseline

`baseline` sends each question through the retrieve-only MCP tool and stores the ranked chunk ids per question, one JSON file per dataset. The files carry no timestamps and ties are sorted by id, so two runs give identical files. `--against` compares a fresh run with an earlier file: a question passes when its ranking matches up to tie order, and overlap@10 is printed for the rest.

## Sweep

`sweep` asks both systems the same questions over `/v1/chat/completions`, `--repeats` times each, and scores every answer with one judge. The report has a mean and a t-based 95 % interval per system and a paired difference per question. It is marked invalid, and exits non-zero, when a system does not report its served model, the served models differ, a request fails, or the judge returns a score outside 0 to 1.

## Golden sets and benchmarks

`--testset` takes the JSON drafts in `testsets/` or a TestSet YAML from `packages/eval/testsets` (`headless-rag-website-118.yaml`, `headless-rag-ue-42.yaml`). `testsets/targets.json` names, per set and system, the agent tool, the retrieve-only tool, the scope arguments and the platform services. On headless-rag the website sets run with `tenant: digdir, dataset_config_key: default`; on the platform they run against the `public-docs-agent` and `public-docs-retrieve-only` services on `digdir/public-docs`. Reports for a set other than the Kunnskapsassistenten draft go to `reports/<set>/`.

- The raw answers of a run (`quality-runs.jsonl`, `budget-runs.jsonl`) stay local and are not committed; `quality-report` rebuilds the report from them. The repository keeps only the reports.
- The quality report records the served model per system (`_meta.model`), and says when a model is only declared or unknown, or when the two differ.
- With operator access, each platform answer is split into stages: the expected source in the agent's search pool, displayed to the model, and read (`GET /tenants/{tenant}/diagnostics/tasks/{task}/attribution`).
- `retrieval-score`, `rerank-benchmark` and `auto-filter-eval` send the raw question as one fixed query, with no planner, to `/api/debug/typesense-retrieve` and `POST /tenants/{tenant}/diagnostics/retrieve`, so runs are deterministic. They report chunk and document recall at 10 and 30 and the expected source's rank.
- `agent-budget-benchmark` compares the Kunnskapsassistenten (KA) service with `agent-budget-relaxed` (twice the budget) on the platform. The service lives in `apps/parity/config/services` and the API seeds it only when started with `SEED_PARITY_SERVICES=true`.

The compare report lists every scenario. A scenario left out by `--only` or `--skip` keeps its last result, or shows `not-run`.
