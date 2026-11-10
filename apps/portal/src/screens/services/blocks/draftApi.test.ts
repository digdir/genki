import { HttpError } from '@genai/ui-assembly';
import { describe, expect, it } from 'vitest';
import { answered, definition, fakeClient as fake, result } from './draft.test-utils';
import { createDraftApi, narrowedDefinition } from './draftApi';
import type { DraftSource } from './draftService';

const at = '2026-10-07T10:00:00Z';
const now = () => new Date(at).getTime();

const drain = async <E>(events: AsyncGenerator<E, void>) => {
  const all: E[] = [];
  for await (const event of events) all.push(event);
  return all;
};

const ask = (
  draftApi: ReturnType<typeof createDraftApi>,
  question: string,
  conversationId?: string,
) =>
  drain(
    draftApi.ask({
      question,
      model: 'byggesak__default',
      conversationId,
      steps: true,
      signal: new AbortController().signal,
    }),
  );

const draft = (source: DraftSource | undefined, events = answered('Svar')) => {
  const made = fake(events);
  return {
    ...made,
    draftApi: createDraftApi({ api: made.api, tenant: 'eksempel', source: () => source, now }),
  };
};

describe('the draft API for the try view', () => {
  it('runs each question as a playground run of the draft, with the turns so far as history', async () => {
    const { draftApi, requests } = draft({ definition, files: { 'instruks.md': 'Svar kort.' } });
    await ask(draftApi, 'Trenger jeg søknad for en garasje?');
    await ask(draftApi, 'Og for en carport?', 'draft-1');
    expect(requests[0]?.setup.service).toEqual({
      id: 'byggesak',
      version: 'draft',
      definition,
      files: { 'instruks.md': 'Svar kort.' },
    });
    expect(requests[0]?.setup.model).toBe('modell-b');
    expect(requests[0]?.history).toBeUndefined();
    expect(requests[1]?.history).toEqual([
      { role: 'user', text: 'Trenger jeg søknad for en garasje?' },
      { role: 'assistant', text: 'Svar' },
    ]);
  });

  it('streams the run’s text, each step once and the answer with its sources by document', async () => {
    const step = {
      id: 's1',
      type: 'search',
      title: 'Søkte i byggereglene',
      summary: '',
      at: 0,
      blocks: [],
    };
    const { draftApi } = draft({ definition }, () => [
      { event: 'step', setup: 'setup', step },
      { event: 'step', setup: 'setup', step: { ...step, summary: 'ferdig' } },
      { event: 'delta', setup: 'setup', text: 'Tenk', channel: 'reasoning' },
      { event: 'delta', setup: 'setup', text: 'Ja', channel: 'answer' },
      result('Ja'),
    ]);
    const events = await ask(draftApi, 'Trenger jeg søknad?');
    expect(events.map((e) => e.type)).toEqual([
      'conversation',
      'step',
      'reasoning',
      'text',
      'done',
    ]);
    expect(events[1]).toEqual({
      type: 'step',
      step: { event: 'step', label: 'Søkte i byggereglene' },
    });
    const done = events.at(-1);
    expect(done?.type === 'done' && done.answer.sources).toEqual([
      {
        title: 'Plan- og bygningsloven',
        documentId: 'pbl',
        excerpts: [
          { chunkId: 'c1', text: 'Første utdrag', position: 0 },
          { chunkId: 'c2', text: 'Andre utdrag', position: 3 },
        ],
      },
    ]);
  });

  it('fails a question the run fails, with the status it failed with', async () => {
    const { draftApi } = draft({ definition }, () => [
      { event: 'failed', setup: 'setup', problem: { status: 429, title: 'Kvoten er brukt opp' } },
    ]);
    const failed = await ask(draftApi, 'Hei').catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(HttpError);
    expect((failed as HttpError).status).toBe(429);
  });

  it('keeps this visit’s threads only, and finds no other', async () => {
    const { draftApi } = draft({ definition });
    await ask(draftApi, 'Trenger jeg søknad for en garasje?');
    expect(await draftApi.loadThreads()).toEqual([
      {
        id: 'draft-1',
        title: 'Trenger jeg søknad for en garasje',
        updatedAt: now(),
        service: 'byggesak',
      },
    ]);
    const thread = await draftApi.loadThread('draft-1');
    expect(thread.turns.map((turn) => [turn.question, turn.answer?.text])).toEqual([
      ['Trenger jeg søknad for en garasje?', 'Svar'],
    ]);
    await expect(draftApi.loadThread('annen')).rejects.toMatchObject({ status: 404 });
  });

  it('narrows a question with the reader’s filter added to the draft’s own, never widening it', async () => {
    const { draftApi, requests } = draft({ definition });
    const filters = {
      fields: [{ field: 'kommune', type: 'multiselect' as const, 'selected-options': ['Oslo'] }],
    };
    await drain(
      draftApi.ask({
        question: 'Hei',
        model: 'byggesak__default',
        filters,
        steps: false,
        signal: new AbortController().signal,
      }),
    );
    const sent = requests[0]?.setup.service?.definition as typeof definition;
    expect(sent.spec.variants).toEqual([{ id: 'default', filters }]);
    const fixed = { fields: [{ field: 'aar', 'selected-options': ['2026'] }] };
    const own = {
      ...definition,
      spec: { ...definition.spec, variants: [{ id: 'kort', filters: fixed }] },
    };
    expect(narrowedDefinition(own, filters).spec.variants).toEqual([
      { id: 'kort', filters: { fields: [...fixed.fields, ...filters.fields] } },
    ]);
  });

  it('lists the draft as its `/v1/models` rows, with its filter fields from the definition', async () => {
    const { draftApi } = draft({ definition });
    expect((await draftApi.loadModels()).map((row) => row.id)).toEqual(['byggesak__default']);
    expect(await draftApi.loadFields('byggeregler')).toEqual([
      { id: 'kommune', label: 'kommune' },
      { id: 'aar', label: 'aar' },
    ]);
  });

  it('counts each facet narrowed by the other fields only, in the dataset’s tenant', async () => {
    const { draftApi, paths } = draft({ definition });
    const fields = [
      { id: 'kommune', label: 'kommune' },
      { id: 'aar', label: 'aar' },
    ];
    await draftApi.loadFacets({ kommune: ['Oslo'], aar: ['2026'] }, 'byggeregler', fields);
    const queries = paths.map((path) => new URLSearchParams(path.split('?')[1]));
    expect(queries.map((q) => [q.get('tenant'), q.get('fields')])).toEqual([
      ['felles', 'kommune'],
      ['felles', 'aar'],
    ]);
    expect(
      JSON.parse(queries[0]?.get('filter') ?? '{}').fields.map((f: { field: string }) => f.field),
    ).toEqual(['aar']);
  });

  it('runs the playground’s first setup when there is no draft, and names it the playground', async () => {
    const { draftApi, requests } = draft(undefined);
    await ask(draftApi, 'Hei');
    expect(requests[0]?.setup.service).toBeUndefined();
    expect((await draftApi.loadModels()).map((row) => row._service)).toEqual(['playground']);
  });
});
