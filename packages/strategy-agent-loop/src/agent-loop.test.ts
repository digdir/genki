import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { serviceDefinition, toCapabilities } from '@genai/definitions';
import { createKernel } from '@genai/kernel';
import { ModelError, type ChatResult } from '@genai/port-model';
import { ToolRegistry } from '@genai/port-tools';
import { z } from 'zod';
import {
  baseConfig,
  call,
  capability,
  chunk,
  decision,
  kari,
  models,
  readSignal,
  result,
  retrieval,
  run,
  systemMessages,
  toolMessages,
} from './harness.test-utils.js';
import {
  agentLoopConfig,
  agentLoopRuntimeConfig,
  createAgentLoop,
  evaluatorSystemPrompt,
  exhaustionNudge,
  noToolCallHonestMiss,
  noToolCallNudge,
  readEvaluatorSystemPrompt,
} from './index.js';

describe('agent-loop strategy', () => {
  it('gives attached documents to generate_response as the first numbered sources and names them in the prompt', async () => {
    const out = await run({
      parts: [
        {
          mime: 'text/plain',
          body: { kind: 'text', text: 'Fristen er 1. mars.' },
          meta: { attached: true, name: 'brev.txt', sha256: 'abc' },
        },
      ],
      scripts: {
        primary: {
          loop: [() => result('', [call('generate_response', { query: 'frist' })])],
          synth: [
            (request) =>
              String(request.messages.at(-1)?.content).includes('[1] Fristen er 1. mars.')
                ? 'Fristen er 1. mars [1].'
                : 'Fant ikke dokumentet.',
          ],
        },
      },
    });

    expect(String(out.loops[0]?.messages[0]?.content)).toContain('brev.txt');
    expect(out.text).toBe('Fristen er 1. mars [1].');
    expect(out.sources[0]).toMatchObject({ chunkId: 'attached:abc:0', title: 'brev.txt' });
  });

  it('finalizes by synthesis as soon as read signals cover every claim, citing what it read', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () =>
              result('Jeg søker først.', [
                call('search', { queries: ['tildelingsbrev Digdir 2025'] }),
              ]),
            () => result('Leser.', [call('read_chunks', { chunk_ids: ['c1', 'c2', 'c3'] })]),
          ],
          synth: [() => 'Digdir skal digitalisere [3] og samordne [3][2].'],
        },
      },
    });

    expect(out.task.status).toBe('completed');
    expect(out.loops).toHaveLength(2);
    expect(out.text).toBe('Digdir skal digitalisere [3] og samordne [3][2].');
    expect(out.meta).toEqual({
      citations: [
        { index: 2, chunkId: 'c2' },
        { index: 3, chunkId: 'c3' },
      ],
    });
    expect(out.sources.map((s) => [s.chunkId, s.title, s.url])).toEqual([
      ['c1', 'Rapport 1', 'https://kudos.dfo.no/d1'],
      ['c2', 'Rapport 2', 'https://kudos.dfo.no/d2'],
      ['c3', 'Rapport 3', 'https://kudos.dfo.no/d3'],
    ]);
    const readEval = out.seen.find((s) => s.kind === 'read')?.request;
    expect(readEval?.messages[0]?.content).toBe(readEvaluatorSystemPrompt);
    expect(readEval?.temperature).toBe(0);
    expect(readEval?.messages[1]?.content).toContain(
      '"required_claims":[{"claim_id":"target-entity"',
    );
    const synth = out.seen.find((s) => s.kind === 'synth')?.request;
    expect(synth?.messages[0]?.content).toBe(
      'You are a helpful assistant. The date this conversation was created at is 6. oktober 2026 (Norwegian time).',
    );
    expect(synth?.messages[1]?.content).toContain(
      'Question: Hva sier tildelingsbrevet til Digdir for 2025?',
    );
    expect(out.notices).toContainEqual(
      expect.objectContaining({
        stage: 'gate',
        source: 'shadow-read-signals',
        status: 'sufficient',
      }),
    );
    const retrieved = out.notices.filter((n) => n.kind === 'retrieval');
    expect(retrieved.map((n) => (n.hits as { id: string }[]).map((h) => h.id))).toEqual([
      ['c1', 'c2', 'c3', 'c4', 'c5'],
    ]);
    expect((retrieved[0]?.hits as unknown[])[0]).toEqual({
      id: 'c1',
      document: 'd1',
      position: 0,
      score: 1,
      title: 'Rapport 1',
    });
    expect(retrieved[0]).toMatchObject({ queries: expect.arrayContaining([expect.any(String)]) });
  });

  it('runs the LLM sufficiency gate on a generated answer, sends its hint back, and validates the next answer', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('generate_response', { query: 'x' })]),
            () => result('', [call('generate_response', { query: 'x' })]),
          ],
          read: [() => readSignal('gap-remaining', { scope_assessment: 'ambiguous' })],
          sufficiency: [
            () => decision('insufficient', 're-search'),
            () => decision('sufficient', 'finalize'),
            () => decision('sufficient', 'finalize'),
          ],
          synth: [() => 'Første utkast [1].', () => 'Bedre svar [1].'],
        },
      },
    });

    const gates = out.seen.filter((s) => s.kind === 'sufficiency');
    expect(gates).toHaveLength(3);
    expect(gates[0]?.request.messages[0]?.content).toBe(evaluatorSystemPrompt);
    expect(gates[0]?.request.temperature).toBe(0);
    expect(gates[0]?.request.messages[1]?.content).toMatch(
      /^User query:\nHva sier tildelingsbrevet til Digdir for 2025\?\n\nEvidence summary JSON:\n\{/,
    );
    const fourth = out.loops[3];
    const hint =
      '[SYSTEM: Sufficiency gate rejected the current evidence. insufficient by test Missing info: the requested figure. Avoid repeating the latest queries verbatim: ("x"). Start a more targeted search and then read the new hits before finalizing.]';
    expect(toolMessages(fourth).at(-1)).toBe(hint);
    expect(systemMessages(fourth).at(-1)).toBe(hint);
    expect(out.text).toBe('Bedre svar [1].');
  });

  it('forces finalize at the retry limit of five rejections', async () => {
    const out = await run({
      config: { ...baseConfig, strategy: { ...baseConfig.strategy, maxIterations: 10 } },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('generate_response', { query: 'x' })]),
          ],
          read: [() => readSignal('gap-remaining', { scope_assessment: 'ambiguous' })],
          sufficiency: [() => decision('insufficient', 'read-more')],
          synth: [() => 'Svar med forbehold [1].'],
        },
      },
    });

    const rejections = out.notices.filter((n) => n.stage === 'gate' && n.status === 'insufficient');
    expect(rejections.map((n) => n.strategy)).toEqual([
      'read-more',
      'read-more',
      'read-more',
      'read-more',
      'finalize',
    ]);
    expect(out.text).toBe('Svar med forbehold [1].');
  });

  it('rejects an uncited answer through the grounding floor even when the evaluator accepts it', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('generate_response', { query: 'x' })]),
            () => result('', [call('generate_response', { query: 'x' })]),
          ],
          read: [() => readSignal('gap-remaining', { scope_assessment: 'ambiguous' })],
          synth: [() => 'Paris.', () => 'Kildene dekker ikke dette [1].'],
        },
      },
    });

    expect(toolMessages(out.loops[3]).at(-1)).toMatch(
      /^\[SYSTEM: Grounding gate rejected the answer\. The generated answer cites no retrieved source \(0 reference\(s\), 0 valid\)/,
    );
    expect(out.notices).toContainEqual(
      expect.objectContaining({ stage: 'gate', source: 'grounding-gate' }),
    );
    expect(out.text).toBe('Kildene dekker ikke dette [1].');
  });

  it('returns a clarification question instead of an answer, without pausing the task', async () => {
    const out = await run({
      question: 'Hvordan setter jeg opp Altinn 3?',
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['altinn 3'] })]),
            () => result('', [call('generate_response', { query: 'altinn 3' })]),
          ],
          sufficiency: [
            () =>
              decision('insufficient', 'ask-clarification', {
                clarification_question:
                  'Hvilken del av Altinn 3 mener du: Altinn Studio, Altinn Apps?',
                options: ['Altinn Studio', 'Altinn Apps'],
                context_summary: 'Kildene peker mot flere deler av Altinn 3.',
              }),
          ],
        },
      },
    });

    expect(out.task.status).toBe('completed');
    expect(out.text).toBe('Hvilken del av Altinn 3 mener du: Altinn Studio, Altinn Apps?');
    expect(out.clarification).toEqual({
      question: 'Hvilken del av Altinn 3 mener du: Altinn Studio, Altinn Apps?',
      options: ['Altinn Studio', 'Altinn Apps'],
      'context-summary': 'Kildene peker mot flere deler av Altinn 3.',
    });
    expect(out.sources).toEqual([]);
  });

  it('skips chunks that were read without supporting anything when the model asks for them again', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2'] })]),
            () => result('Ferdig.'),
          ],
          read: [
            () =>
              JSON.stringify({
                ...JSON.parse(readSignal('gap-remaining')),
                next_action_hint: 're-search',
              }),
            () => readSignal('gap-remaining'),
          ],
          sufficiency: [() => decision('insufficient', 're-search')],
        },
      },
    });

    expect(toolMessages(out.loops[3])[2]).toContain(
      'Skipped 1 previously non-supporting chunk for this query: ["c1"]. These chunks were already read and did not add support for the current question.',
    );
  });

  it('adds a range-read hint when a read leaves a gap inside a multi-chunk document', async () => {
    const store = new Map([
      [
        'c1',
        chunk(1, { document: 'd1', position: 1, totalChunks: 4, content: 'Del 2 av rapporten.' }),
      ],
      ['c2', chunk(2)],
    ]);
    const out = await run({
      retrieval: retrieval({}, store).impl,
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('Ferdig.'),
          ],
          read: [() => readSignal('gap-remaining')],
        },
      },
    });

    expect(toolMessages(out.loops[2])[1]).toContain(
      '[SYSTEM: The chunks you just read came from doc_num="d1" (title="Rapport 1", total_chunks=4). You have read chunk_index(es) [1] from this doc but chunk_index(es) [0 2 3] are still unread in the SAME doc. The answer is often in an adjacent chunk — before issuing any new search, call read_chunks with these exact args: {"doc_num": "d1", "chunk_range": {"from": 0, "to": 3}}.]',
    );
  });

  it('auto-reads the top chunks after a search when configured, counting it as a read', async () => {
    const r = retrieval();
    const out = await run({
      retrieval: r.impl,
      config: { ...baseConfig, strategy: { ...baseConfig.strategy, search: { autoReadTopK: 2 } } },
      scripts: {
        primary: {
          loop: [() => result('', [call('search', { queries: ['x'] })]), () => result('Ferdig.')],
        },
      },
    });

    expect(toolMessages(out.loops[1])[0]).toMatch(
      /\nAuto-read top 2 by rank into workspace: c1, c2\. Do NOT re-read these via read_chunks\.$/,
    );
    expect(r.calls.filter((c) => c.op === 'read')[0]?.args).toEqual(['c1', 'c2']);
    expect(out.seen.filter((s) => s.kind === 'read')).toHaveLength(1);
  });

  it('shows title matches after rescoring and caps the visible list when configured', async () => {
    const store = new Map([
      ['c1', chunk(1, { title: 'Økonomi' })],
      ['c2', chunk(2, { title: 'Tildelingsbrev Digdir 2025' })],
      ['c3', chunk(3)],
    ]);
    const out = await run({
      retrieval: retrieval({}, store).impl,
      config: {
        ...baseConfig,
        strategy: { ...baseConfig.strategy, search: { titleOverlapWeight: 5, displayLimit: 2 } },
      },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['tildelingsbrev digdir'] })]),
            () => result('Ferdig.'),
          ],
        },
      },
    });

    const text = toolMessages(out.loops[1])[0] ?? '';
    expect(text).toMatch(/Showing top 2 by rank; 1 lower-ranked chunks omitted\./);
    expect(text.split('\n')[1]).toMatch(/^1\. chunk_id=c2 .* title_match=2$/);
  });

  it('passes a direct answer through by default and re-prompts only when the no-tool-call guard is on', async () => {
    const plain = await run({ scripts: { primary: { loop: [() => result('Svaret er 42.')] } } });
    const guarded = await run({
      config: { ...baseConfig, strategy: { ...baseConfig.strategy, noToolCallRetry: true } },
      scripts: {
        primary: {
          loop: [
            () => result('Svaret er 42.'),
            () => result('Fortsatt 42.'),
            () => result('[SEARCH] Queries: tildelingsbrev'),
          ],
        },
      },
    });

    expect(plain.text).toBe('Svaret er 42.');
    expect(plain.loops).toHaveLength(1);
    expect(systemMessages(guarded.loops.at(-1)).filter((m) => m === noToolCallNudge)).toHaveLength(
      2,
    );
    expect(guarded.text).toBe(noToolCallHonestMiss);
  });

  it('answers with the best-effort fallback after the last iteration', async () => {
    const out = await run({
      config: { ...baseConfig, strategy: { ...baseConfig.strategy, maxIterations: 3 } },
      retrieval: retrieval({ read: async () => [] }).impl,
      scripts: { primary: { loop: [() => result('', [call('search', { queries: ['igjen'] })])] } },
    });

    expect(out.seen.at(-1)?.request.messages.at(-1)?.content).toBe(exhaustionNudge);
    expect(out.text).toBe('Beste svar ut fra det jeg fant.');
    expect(out.notices).toContainEqual(expect.objectContaining({ stage: 'exhausted' }));
  });

  it('streams the synthesised answer as deltas', async () => {
    const out = await run({
      stream: true,
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
          ],
          synth: [() => 'Svar [1].'],
          deltas: ['Svar ', '[1].'],
        },
      },
    });

    expect(
      out.events
        .filter((e) => e.type === 'kernel.part.delta')
        .map((e) => (e.data as { text: string }).text),
    ).toEqual(['Svar ', '[1].']);
    expect(out.text).toBe('Svar [1].');
  });

  it('switches to the fallback model when the primary is rate limited', async () => {
    const out = await run({
      scripts: {
        primary: { loop: [], failFirst: new ModelError('rate_limited', 'slow down') },
        fallback: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
          ],
        },
      },
    });

    expect(out.task.status).toBe('completed');
    expect(new Set(out.seen.map((s) => s.model))).toEqual(new Set(['fallback']));
  });

  it('plans queries and inspects filters with the formats the model expects', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('plan_queries', { query: 'tildelingsbrev' })]),
            () => result('', [call('inspect_filters', { fields: ['orgs_short', 'nope'] })]),
            () => result('Ferdig.'),
          ],
        },
      },
    });

    const [plan, inspect] = toolMessages(out.loops[2]);
    expect(plan).toBe(
      'Generated 4 queries: "hva sier tildelingsbrevet", "tildelingsbrev 2025", "digdir oppdrag", "tildelingsbrev"',
    );
    expect(inspect).toBe(
      'Available filter fields:\n- orgs_short (type: string[], filter-value-type: string)\n\nTop facet options:\n- orgs_short: "DIGDIR"(12)',
    );
  });

  it('lets the gate finalize by synthesis when there is nothing left to read', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [() => result('', [call('rerank_results', { query: 'x' })])],
          synth: [() => 'Svar uten kilder.'],
        },
      },
    });

    expect(out.loops).toHaveLength(1);
    expect(out.seen.map((s) => s.kind)).toEqual(['loop', 'sufficiency', 'synth']);
    expect(out.text).toBe('Svar uten kilder.');
  });

  it('refuses filter values that could escape quoting without searching', async () => {
    const r = retrieval();
    const out = await run({
      retrieval: r.impl,
      scripts: {
        primary: {
          loop: [
            () =>
              result('', [
                call('search', {
                  queries: ['x'],
                  filter_by: { fields: [{ field: 'orgs_short', selected_options: ['a`b'] }] },
                }),
              ]),
            () => result('Ferdig.'),
          ],
        },
      },
    });

    expect(toolMessages(out.loops[1])[0]).toMatch(/^Invalid filter_by, search not run/);
    expect(r.calls.filter((c) => c.op === 'search')).toHaveLength(0);
  });

  it('offers granted tools from the tool port and feeds their results back', async () => {
    const registry = new ToolRegistry().register({
      name: 'klarsprak',
      version: '1',
      description: 'Skriv om til klarspråk',
      input: z.object({ text: z.string() }),
      run: async ({ text }) => ({
        parts: [{ mime: 'text/plain', body: { kind: 'text', text: `Klart: ${text}` } }],
      }),
    });
    const out = await run({
      registry,
      tools: ['klarsprak@1'],
      config: { ...baseConfig, tools: ['rag@1', 'klarsprak@1'] },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('klarsprak', { text: 'vanskelig' })]),
            () => result('Ferdig.'),
          ],
        },
      },
    });

    expect(out.loops[0]?.tools?.map((t) => t.name)).toContain('klarsprak');
    expect(toolMessages(out.loops[1])[0]).toBe('Klart: vanskelig');
  });

  it('ends the task as cancelled when cancelled mid-call', async () => {
    const { provider } = models({
      primary: {
        loop: [
          (_r, signal) =>
            new Promise<ChatResult>((_, reject) =>
              signal.addEventListener('abort', () =>
                reject(new ModelError('cancelled', 'cancelled')),
              ),
            ),
        ],
      },
    });
    const kernel = createKernel({
      strategies: [createAgentLoop({ retrieval: () => retrieval().impl })],
      capabilities: [capability(baseConfig)],
      ports: { model: provider, tools: new ToolRegistry() },
      policy: { decide: async () => ({ allow: true }) },
    });
    const started = await kernel.invoke(kari, 'ka', { data: { query: 'x' } });
    setTimeout(() => void kernel.cancel(kari, started.task), 20);

    await expect(started.result).rejects.toBeDefined();
    expect((await kernel.task(kari, started.task)).status).toBe('cancelled');
  });

  it('accepts the Kunnskapsassistenten example config', () => {
    const file = join(
      import.meta.dirname,
      '..',
      '..',
      'definitions',
      'examples',
      'kunnskapsassistenten.yaml',
    );
    const definition = serviceDefinition.parse(parseYaml(readFileSync(file, 'utf8')));

    expect(agentLoopConfig.safeParse(definition.spec.strategy.config).success).toBe(true);
    for (const compiled of toCapabilities(definition, 1)) {
      expect(agentLoopRuntimeConfig.safeParse(compiled.capability.config).success).toBe(true);
    }
  });
});

describe('agent-loop sources, as headless-rag publishes them', () => {
  it('returns every chunk it read as a source even when the answer cites none', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['tildelingsbrev'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c4', 'c1'] })]),
          ],
          synth: [() => 'Digdir skal digitalisere offentlig sektor.'],
        },
      },
    });

    expect(out.text).toBe('Digdir skal digitalisere offentlig sektor.');
    expect(out.meta).toEqual({ citations: [] });
    expect(out.sources.map((s) => s.chunkId)).toEqual(['c4', 'c1']);
  });

  it('keeps the read chunks as sources when the loop runs out and the fallback answers', async () => {
    const out = await run({
      config: { ...baseConfig, strategy: { ...baseConfig.strategy, maxIterations: 2 } },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['tildelingsbrev'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c2'] })]),
          ],
          read: [() => readSignal('no-support')],
        },
      },
    });

    expect(out.notices).toContainEqual(expect.objectContaining({ stage: 'exhausted' }));
    expect(out.sources.map((s) => s.chunkId)).toEqual(['c2']);
  });

  it('publishes a chunk the reranker added once the answer was numbered against it', async () => {
    const r = retrieval();
    const out = await run({
      retrieval: {
        ...r.impl,
        rerank: async (_query, chunks) => [...chunks, chunk(5)],
      },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['tildelingsbrev'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('rerank_results', { query: 'tildelingsbrev' })]),
            () => result('', [call('generate_response', { query: 'tildelingsbrev' })]),
          ],
          read: [() => readSignal('no-support')],
          synth: [() => 'Svar [2].'],
        },
      },
    });

    expect(out.seen.filter((x) => x.kind === 'loop')).toHaveLength(4);
    expect(out.sources.map((s) => s.chunkId)).toEqual(['c1', 'c5']);
  });

  it('publishes nothing it only saw in search results', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['tildelingsbrev'] })]),
            () => result('Fant ikke noe.'),
          ],
        },
      },
    });

    expect(out.sources).toEqual([]);
  });

  it('reports the filters each search applied, with their source, like headless-rag', async () => {
    const r = retrieval();
    let n = 0;
    const out = await run({
      retrieval: {
        ...r.impl,
        search: async (queries, options, signal) => {
          const base = await r.impl.search(queries, options, signal);
          n += 1;
          return {
            ...base,
            attribution: {
              ...base.attribution,
              ...(n === 1 ? { autoFilter: { field: 'orgs_long', options: ['Digdir'] } } : {}),
            },
          };
        },
      },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['Digdir tildelingsbrev'] })]),
            () =>
              result('', [
                call('search', {
                  queries: ['årsrapport'],
                  filter_by: { fields: [{ field: 'type', selected_options: ['Årsrapport'] }] },
                }),
              ]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
          ],
          synth: [() => 'Svar [1].'],
        },
      },
    });

    expect(out.filtersApplied).toEqual([
      {
        filter: {
          fields: [
            {
              type: 'multiselect',
              field: 'orgs_long',
              'selected-options': ['Digdir'],
              'value-type': 'string',
            },
          ],
        },
        source: 'auto',
        auto_detected: {
          fields: [
            {
              type: 'multiselect',
              field: 'orgs_long',
              'selected-options': ['Digdir'],
              'value-type': 'string',
            },
          ],
        },
      },
      {
        filter: {
          fields: [
            {
              type: 'multiselect',
              field: 'type',
              'selected-options': ['Årsrapport'],
              'value-type': 'string',
            },
          ],
        },
        source: 'explicit',
      },
    ]);
  });
});

describe("what KA reads from the agent's wire output", () => {
  it('streams only the final answer, never the text of a turn that calls tools', async () => {
    const out = await run({
      stream: true,
      scripts: {
        primary: {
          loop: [
            () => result('Jeg søker først.', [call('search', { queries: ['tildelingsbrev'] })]),
            () => result('Fant ikke noe om det.'),
          ],
        },
      },
    });

    const deltas = out.events.filter((e) => e.type === 'kernel.part.delta');
    expect(deltas.map((e) => (e.data as { text: string }).text)).toEqual(['Fant ikke noe om det.']);
    expect(out.notices).toContainEqual(
      expect.objectContaining({ event: 'agent/thinking', reasoning: 'Jeg søker først.' }),
    );
  });

  it('announces each tool call with its tool, arguments and iteration', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['tildelingsbrev 2025'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
          ],
        },
      },
    });

    expect(out.notices.filter((n) => n.event === 'tool/call')[0]).toEqual({
      stage: 'tool',
      tool: 'search',
      iteration: 0,
      event: 'tool/call',
      'tool-call': { tool: 'search', args: { queries: ['tildelingsbrev 2025'] }, iteration: 0 },
    });
  });

  it('publishes insufficient when the last sufficiency decision was not sufficient', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('generate_response', { query: 'x' })]),
          ],
          read: [() => readSignal('gap-remaining', { scope_assessment: 'ambiguous' })],
          sufficiency: [() => decision('insufficient', 'read-more')],
          synth: [() => 'Svar med forbehold [1].'],
        },
      },
    });

    expect(out.insufficient).toBe(true);
  });

  it('publishes insufficient false when the evidence was judged sufficient', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
          ],
          synth: [() => 'Svar [1].'],
        },
      },
    });

    expect(out.insufficient).toBe(false);
  });

  it("publishes execution metadata in headless-rag's setup, react and finalize step shape", async () => {
    const out = await run({
      scripts: {
        primary: { loop: [() => result('Svar uten søk.')] },
      },
    });

    const meta = out.executionMetadata as {
      'steps-executed': number;
      'total-duration-ms': number;
      'step-timings': Record<string, unknown>;
      'stage-timings': { 'step-id': string; 'skill-id': string; status: string }[];
    };
    expect(meta['steps-executed']).toBe(3);
    expect(meta['total-duration-ms']).toBeGreaterThanOrEqual(0);
    expect(meta['stage-timings'].map((s) => [s['step-id'], s['skill-id'], s.status])).toEqual([
      ['setup', 'builtin/agent-setup', 'ok'],
      ['react', 'builtin/agent-iteration-bundled', 'ok'],
      ['finalize', 'builtin/agent-finalize', 'ok'],
    ]);
    expect(meta['step-timings'].react).toMatchObject({
      stage: 'agent-iteration-bundled',
      'loop?': true,
    });
  });

  it('reports each step as headless-rag progress events, with the queries of each turn', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['tildelingsbrev 2025'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
          ],
          synth: [() => 'Svar [1].'],
        },
      },
    });

    const events = out.notices.flatMap((n) =>
      typeof n.event === 'string' && n.event !== 'tool/call' ? [n] : [],
    );
    expect(events.map((e) => e.event)).toEqual([
      'agent/iteration-started',
      'agent/turn-completed',
      'agent/iteration-started',
      'agent/turn-completed',
      'agent/finalized',
    ]);
    expect(events[0]).toEqual({
      event: 'agent/iteration-started',
      iteration: 0,
      'max-iterations': 10,
    });
    expect(events[1]).toMatchObject({
      iteration: 0,
      'tool-calls': [{ tool: 'search', args: { queries: ['tildelingsbrev 2025'] }, 'ok?': true }],
    });
    expect(events[4]).toEqual({ event: 'agent/finalized', iteration: 1, 'response-length': 9 });
  });

  it("streams the agent's own answer as it is written, once, before the result", async () => {
    const out = await run({
      stream: true,
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['tildelingsbrev'] })]),
            () => result('Fant ikke noe om det.'),
          ],
        },
      },
    });

    const deltas = out.events.filter((e) => e.type === 'kernel.part.delta');
    expect(deltas.map((e) => (e.data as { text: string }).text)).toEqual(['Fant ikke noe om det.']);
    const finalized = out.events.findIndex(
      (e) =>
        e.type === 'kernel.notice' && (e.data as { event?: string }).event === 'agent/finalized',
    );
    expect(out.events.indexOf(deltas[0] as (typeof out.events)[number])).toBeLessThan(finalized);
    expect(out.text).toBe('Fant ikke noe om det.');
  });

  it('numbers sources per document in the order KA groups the published chunks', async () => {
    const store = new Map([
      ['c1', chunk(1)],
      ['c2', chunk(2, { document: 'd1', position: 1, title: 'Rapport 1' })],
      ['c3', chunk(3)],
    ]);
    const out = await run({
      retrieval: retrieval({}, store).impl,
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['tildelingsbrev'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c3', 'c2'] })]),
          ],
          synth: [() => 'Først [2], så [1].'],
        },
      },
    });

    const synth = out.seen.find((s) => s.kind === 'synth')?.request.messages[1]?.content;
    expect(synth).toContain(
      '[1] Innhold i chunk 1.\n\nInnhold i chunk 2.\n\n[2] Innhold i chunk 3.',
    );
    expect(out.text).toBe('Først [2], så [1].');
    expect(out.meta).toEqual({
      citations: [
        { index: 1, chunkId: 'c1' },
        { index: 2, chunkId: 'c3' },
      ],
    });
    const documents = [...new Set(out.sources.map((s) => s.document))];
    expect(documents).toEqual(['d1', 'd3']);
  });

  it('publishes chunk text without the page markers the source documents carry', async () => {
    const store = new Map([
      [
        'c1',
        chunk(1, {
          content:
            '{0}\n\n------------------------------------------------\n\n\n\nArbeidstilsynet {82} gis fullmakt.',
        }),
      ],
    ]);
    const out = await run({
      retrieval: retrieval({}, store).impl,
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['fullmakt'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
          ],
          synth: [() => 'Svar [1].'],
        },
      },
    });

    expect(out.sources[0]?.text).toBe('Arbeidstilsynet  gis fullmakt.');
  });

  it("hands the caller's overrides to retrieval and reports the caller filter as explicit", async () => {
    const caller = [
      {
        type: 'multiselect',
        field: 'type',
        'selected-options': ['Evaluering'],
        'value-type': 'string',
      },
    ];
    const r = retrieval();
    const overrides = {
      'retrieve-filter-by': { fields: [{ field: 'type', 'selected-options': ['Evaluering'] }] },
    };
    const out = await run({
      overrides,
      retrieval: {
        ...r.impl,
        search: async (queries, options, signal) => {
          const base = await r.impl.search(queries, options, signal);
          return { ...base, attribution: { ...base.attribution, callerFilter: caller } };
        },
      },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['evaluering'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
          ],
          synth: [() => 'Svar [1].'],
        },
      },
    });

    expect(out.requests).toEqual([{ overrides }]);
    expect(out.filtersApplied).toEqual([{ filter: { fields: caller }, source: 'explicit' }]);
  });
});
