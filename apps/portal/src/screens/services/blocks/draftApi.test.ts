import { HttpError, profileOf } from '@genai/ui-assembly';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../api/error';
import type { PlaygroundStreamEvent } from '../../../api/playground';
import { answered, definition, fakeClient as fake, result } from './draft.test-utils';
import { createDraftApi, narrowedDefinition, type DraftApiOptions } from './draftApi';
import type { DraftSource, RunProblem } from './draftService';

const at = '2026-10-07T10:00:00Z';
const now = () => new Date(at).getTime();

const drain = async <E>(events: AsyncGenerator<E, void>) => {
  const all: E[] = [];
  for await (const event of events) all.push(event);
  return all;
};

type Asked = Partial<Parameters<ReturnType<typeof createDraftApi>['ask']>[0]>;

const ask = (draftApi: ReturnType<typeof createDraftApi>, question: string, more: Asked = {}) =>
  drain(
    draftApi.ask({
      question,
      model: 'byggesak__default',
      steps: true,
      signal: new AbortController().signal,
      ...more,
    }),
  );

const draft = (
  source: DraftSource | undefined,
  events = answered('Svar'),
  more: Parameters<typeof fake>[1] = {},
  options: Partial<DraftApiOptions> = {},
) => {
  const made = fake(events, more);
  return {
    ...made,
    draftApi: createDraftApi({
      api: made.api,
      tenant: 'eksempel',
      source: () => source,
      name: 'Prøveområde',
      now,
      ...options,
    }),
  };
};

describe('the draft API for the try view', () => {
  it('runs each question as a playground run of the draft, with the turns so far as history', async () => {
    const { draftApi, requests } = draft({ definition, files: { 'instruks.md': 'Svar kort.' } });
    await ask(draftApi, 'Trenger jeg søknad for en garasje?');
    await ask(draftApi, 'Og for en carport?', { conversationId: 'draft-1' });
    expect(requests[0]?.setup.service).toEqual({
      id: 'byggesak',
      version: 'draft',
      variant: 'default',
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

  it('asks each question of the draft as it is when the question is asked', async () => {
    let current: DraftSource = { definition };
    const made = fake(answered('Svar'));
    const draftApi = createDraftApi({
      api: made.api,
      tenant: 'eksempel',
      source: () => current,
      now,
    });
    await ask(draftApi, 'Hei');
    const edited = { ...definition, spec: { ...definition.spec, model: { primary: 'modell-a' } } };
    current = { definition: edited };
    await ask(draftApi, 'Hei igjen', { conversationId: 'draft-1' });
    expect(made.requests[1]?.setup.service?.definition).toEqual(edited);
    expect(made.requests[1]?.setup.model).toBe('modell-a');
  });

  it('keeps the history to the last 20 turns', async () => {
    const { draftApi, requests } = draft({ definition });
    for (let n = 0; n < 12; n += 1)
      await ask(draftApi, `Spørsmål ${n}`, n ? { conversationId: 'draft-1' } : {});
    expect(requests.at(-1)?.history).toHaveLength(20);
    expect(requests.at(-1)?.history?.[0]).toEqual({ role: 'user', text: 'Spørsmål 1' });
  });

  it('streams the run’s text, each step once, a retraction, and the answer with its sources by document', async () => {
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
      { event: 'delta', setup: 'setup', text: 'Nei', channel: 'answer' },
      { event: 'retract', setup: 'setup', reason: 'guardrail' },
      { event: 'delta', setup: 'compareWith', text: 'Annet', channel: 'answer' },
      { event: 'delta', setup: 'setup', text: 'Ja', channel: 'answer' },
      result('Ja'),
    ]);
    const events = await ask(draftApi, 'Trenger jeg søknad?');
    expect(events.map((e) => e.type)).toEqual([
      'conversation',
      'step',
      'reasoning',
      'text',
      'retract',
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

  it('answers with the clarifying question when the run asks one, and says when it found no answer', async () => {
    const asking = result('');
    if (asking.event === 'result')
      asking.result = {
        ...asking.result,
        clarification: { question: 'Hvilken kommune?', options: [] },
      };
    const empty = result('');
    if (empty.event === 'result') empty.result = { ...empty.result, noAnswer: true };
    const done = (await ask(draft({ definition }, () => [asking]).draftApi, 'Hei')).at(-1);
    expect(done?.type === 'done' && done.answer.text).toBe('Hvilken kommune?');
    const none = (await ask(draft({ definition }, () => [empty]).draftApi, 'Hei')).at(-1);
    expect(none?.type === 'done' && none.answer.noAnswer).toBe(true);
  });

  it('fails a question the run fails, with the status it failed with', async () => {
    const { draftApi } = draft({ definition }, () => [
      { event: 'failed', setup: 'setup', problem: { status: 429, title: 'Kvoten er brukt opp' } },
    ]);
    const failed = await ask(draftApi, 'Hei').catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(HttpError);
    expect((failed as HttpError).status).toBe(429);
  });

  it('gives a refused request its status, so the assistant says why', async () => {
    const { draftApi } = draft({ definition }, () => {
      throw new ApiError(403, undefined);
    });
    const failed = await ask(draftApi, 'Hei').catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(HttpError);
    expect((failed as HttpError).status).toBe(403);
  });

  it('fails a stopped question and keeps no answer for it, so it is not left streaming', async () => {
    const stop = new AbortController();
    const { draftApi } = draft({ definition }, (): PlaygroundStreamEvent[] => {
      stop.abort();
      return [{ event: 'delta', setup: 'setup', text: 'Ja', channel: 'answer' }, result('Ja')];
    });
    const failed = await ask(draftApi, 'Hei', { signal: stop.signal }).catch((e: unknown) => e);
    expect((failed as Error).name).toBe('AbortError');
    expect(await draftApi.loadThreads()).toEqual([]);
  });

  it('keeps no thread for a run the playground refuses, and reports its reason as a refusal', async () => {
    const reported: (RunProblem | undefined)[] = [];
    const errors = [{ path: 'setup.spec.purpose', message: 'Too small' }];
    const { draftApi } = draft(
      { definition },
      () => {
        throw new ApiError(422, {
          type: 'about:blank',
          title: 'Invalid setup',
          status: 422,
          errors,
        });
      },
      {},
      { onProblem: (problem) => reported.push(problem) },
    );
    const events: unknown[] = [];
    const failed = await (async () => {
      for await (const event of draftApi.ask({
        question: 'Hei',
        model: 'byggesak__default',
        steps: true,
        signal: new AbortController().signal,
      }))
        events.push(event);
    })().catch((error: unknown) => error);
    expect((failed as HttpError).status).toBe(422);
    expect(events).toEqual([]);
    expect(reported).toEqual([{ title: 'Invalid setup', errors, refused: true }]);
    expect(await draftApi.loadThreads()).toEqual([]);
  });

  it('reports a run that fails before it starts as a refusal, and one that fails after as not', async () => {
    const reported: (RunProblem | undefined)[] = [];
    const failed = { event: 'failed', setup: 'setup', problem: { status: 502, title: 'Feil' } };
    let started = false;
    const { draftApi } = draft(
      { definition },
      (): PlaygroundStreamEvent[] =>
        started
          ? [{ event: 'delta', setup: 'setup', text: 'Ja', channel: 'answer' }, failed as never]
          : [failed as never],
      {},
      { onProblem: (problem) => reported.push(problem) },
    );
    await ask(draftApi, 'Hei').catch(() => undefined);
    expect(await draftApi.loadThreads()).toEqual([]);
    started = true;
    await ask(draftApi, 'Hei igjen').catch(() => undefined);
    expect(reported).toEqual([
      { title: 'Feil', errors: [], refused: true },
      { title: 'Feil', errors: [] },
    ]);
    expect((await draftApi.loadThreads()).map((t) => t.title)).toEqual(['Hei igjen']);
  });

  it('fails a run that ends without an answer', async () => {
    const { draftApi } = draft({ definition }, () => [
      { event: 'delta', setup: 'setup', text: 'Ja', channel: 'answer' },
    ]);
    await expect(ask(draftApi, 'Hei')).rejects.toThrow('without an answer');
  });

  it('asks for the playground’s options again after a failed call', async () => {
    const { draftApi, requests } = draft({ definition }, answered('Svar'), { optionsFail: 1 });
    await expect(ask(draftApi, 'Hei')).rejects.toThrow('options failed');
    await ask(draftApi, 'Hei igjen', { conversationId: 'draft-1' });
    expect(requests).toHaveLength(1);
  });

  it('keeps this visit’s threads only, newest first, and finds no other', async () => {
    const { draftApi } = draft({ definition });
    await ask(draftApi, 'Trenger jeg søknad for en garasje?');
    await ask(draftApi, 'Og for et tilbygg?');
    expect((await draftApi.loadThreads()).map((t) => [t.id, t.title, t.updatedAt])).toEqual([
      ['draft-2', 'Og for et tilbygg', now()],
      ['draft-1', 'Trenger jeg søknad for en garasje', now()],
    ]);
    const thread = await draftApi.loadThread('draft-1');
    expect(thread.turns.map((turn) => [turn.question, turn.answer?.text])).toEqual([
      ['Trenger jeg søknad for en garasje?', 'Svar'],
    ]);
    await expect(draftApi.loadThread('annen')).rejects.toMatchObject({ status: 404 });
  });

  it('runs the variant the reader picked', async () => {
    const { draftApi, requests } = draft({ definition });
    await ask(draftApi, 'Hei', { model: 'byggesak__kort' });
    expect(requests[0]?.setup.service?.variant).toBe('kort');
  });

  it('offers the draft’s own collections only, and searches only the one the reader chose', async () => {
    const { draftApi, requests } = draft({ definition });
    expect(await draftApi.loadCorpora()).toEqual([
      { key: 'byggeregler', label: 'Byggeregler' },
      { key: 'plankart', label: 'plankart' },
    ]);
    await ask(draftApi, 'Hei', { dataset: { tenant: 'felles', key: 'plankart' } });
    const sent = requests[0]?.setup.service?.definition as typeof definition;
    expect(sent.spec.knowledge.datasets).toEqual([{ dataset: 'felles/plankart' }]);
  });

  it('narrows a question with the reader’s filter added to the draft’s own, never widening it', async () => {
    const { draftApi, requests } = draft({ definition });
    const filters = {
      fields: [{ field: 'kommune', type: 'multiselect' as const, 'selected-options': ['Oslo'] }],
    };
    await ask(draftApi, 'Hei', { filters, steps: false });
    const sent = requests[0]?.setup.service?.definition as typeof definition;
    expect(sent.spec.variants).toEqual([
      { id: 'default', filters },
      { id: 'kort', filters },
    ]);
    const fixed = { fields: [{ field: 'aar', 'selected-options': ['2026'] }] };
    const own = {
      ...definition,
      spec: { ...definition.spec, variants: [{ id: 'kort', filters: fixed }] },
    };
    expect(narrowedDefinition(own, filters).spec.variants).toEqual([
      { id: 'kort', filters: { fields: [...fixed.fields, ...filters.fields] } },
    ]);
  });

  it('lists the draft as its `/v1/models` rows, with each dataset’s own multiselect fields', async () => {
    const { draftApi } = draft({ definition });
    expect((await draftApi.loadModels()).map((row) => row.id)).toEqual([
      'byggesak__default',
      'byggesak__kort',
    ]);
    expect(await draftApi.loadFields('byggeregler')).toEqual([
      { id: 'kommune', label: 'kommune' },
      { id: 'aar', label: 'aar', integer: true },
    ]);
  });

  it('names the collections, chooses and words the fields, and links a kept answer from the layout’s profile', async () => {
    const profile = profileOf({
      profile: {
        corpora: {
          byggeregler: {
            label: 'Regler for bygg',
            description: 'Lover og forskrifter',
            fields: [{ id: 'aar', label: 'År', heading: 'Årstall', kind: 'year' }],
            documentLinks: { any: 'https://regler.example/dok/{id}' },
          },
        },
      },
    });
    const { draftApi } = draft({ definition }, answered('Svar'), {}, { profile: () => profile });
    expect(await draftApi.loadCorpora()).toEqual([
      { key: 'byggeregler', label: 'Regler for bygg', description: 'Lover og forskrifter' },
      { key: 'plankart', label: 'plankart' },
    ]);
    expect(await draftApi.loadFields('byggeregler')).toEqual([
      { id: 'aar', label: 'År', heading: 'Årstall', kind: 'year', integer: true },
    ]);
    await ask(draftApi, 'Hei', { dataset: { tenant: 'felles', key: 'byggeregler' } });
    const [turn] = (await draftApi.loadThread('draft-1')).turns;
    expect(turn?.answer?.sources?.[0]?.url).toBe('https://regler.example/dok/pbl');
  });

  it('asks for each dataset’s filter fields by the id the draft names, tenant included', async () => {
    const { draftApi, paths } = draft({ definition });
    await draftApi.loadFields('byggeregler');
    expect(paths.filter((path) => path.startsWith('/api/datasets/'))).toEqual([
      '/api/datasets/felles/byggeregler',
      '/api/datasets/felles/plankart',
    ]);
  });

  it('counts each facet narrowed by the other fields only, in the dataset’s tenant', async () => {
    const { draftApi, paths } = draft({ definition });
    const fields = [
      { id: 'kommune', label: 'kommune' },
      { id: 'aar', label: 'aar', integer: true },
    ];
    await draftApi.loadFacets({ kommune: ['Oslo'], aar: ['2026'] }, 'byggeregler', fields);
    const queries = paths
      .filter((path) => path.startsWith('/api/facets'))
      .map((path) => new URLSearchParams(path.split('?')[1]));
    expect(queries.map((q) => [q.get('tenant'), q.get('fields')])).toEqual([
      ['felles', 'kommune'],
      ['felles', 'aar'],
    ]);
    expect(JSON.parse(queries[0]?.get('filter') ?? '{}')).toEqual({
      fields: [
        { field: 'aar', type: 'multiselect', 'value-type': 'integer', 'selected-options': [2026] },
      ],
    });
  });

  it('runs the playground’s first setup when there is no draft, named in the reader’s language', async () => {
    const { draftApi, requests } = draft(undefined);
    await ask(draftApi, 'Hei', { model: 'playground__default' });
    expect(requests[0]?.setup.service).toBeUndefined();
    expect((await draftApi.loadModels()).map((row) => [row._service, row.title])).toEqual([
      ['playground', 'Prøveområde'],
    ]);
  });
});
