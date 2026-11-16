import { HttpError, NotAsked, profileOf } from '@genai/ui-assembly';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../api/error';
import type { PlaygroundStreamEvent } from '../../../api/playground';
import { answered, definition, fakeClient as fake, gate, result } from './draft.test-utils';
import { createDraftApi, narrowedDefinition, type DraftApiOptions } from './draftApi';
import type { DraftSource, RunProblem } from './draftService';

const at = '2026-10-07T10:00:00Z';
const now = () => new Date(at).getTime();

const failed: PlaygroundStreamEvent = {
  event: 'failed',
  setup: 'setup',
  problem: { status: 502, title: 'Feil' },
};

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
  events: Parameters<typeof fake>[0] = answered('Svar'),
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
      { event: 'delta', setup: 'setup', text: 'Ja', channel: 'answer' },
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

  it('keeps a question stopped on its way in its thread, with the text that had come', async () => {
    const stop = new AbortController();
    const { draftApi } = draft({ definition }, () => [
      { event: 'delta', setup: 'setup', text: 'Ja, ', channel: 'answer' },
      new Promise<void>((resolve) => setTimeout(() => (stop.abort(), resolve()), 0)),
      { event: 'delta', setup: 'setup', text: 'men', channel: 'answer' },
      result('Ja, men'),
    ]);
    const failed = await ask(draftApi, 'Hei', { signal: stop.signal }).catch((e: unknown) => e);
    expect((failed as Error).name).toBe('AbortError');
    expect((await draftApi.loadThread('draft-1')).turns).toEqual([
      {
        id: 'draft-1-1',
        question: 'Hei',
        askedAt: now(),
        answer: { text: 'Ja, ', status: 'aborted', created: now() },
      },
    ]);
  });

  it('keeps a question stopped after its answer came as stopped, as the reader saw it', async () => {
    const stop = new AbortController();
    const { draftApi } = draft({ definition }, () => [
      { event: 'delta', setup: 'setup', text: 'Ja', channel: 'answer' },
      result('Ja'),
      new Promise<void>((resolve) => setTimeout(() => (stop.abort(), resolve()), 0)),
      { event: 'done', quota: { usedPercent: 0, monthlyTokens: 0 } },
    ]);
    await ask(draftApi, 'Hei', { signal: stop.signal }).catch(() => undefined);
    const [turn] = (await draftApi.loadThread('draft-1')).turns;
    expect(turn?.answer).toEqual({ text: 'Ja', status: 'aborted', created: now() });
  });

  it('keeps a question whose answer failed on its way, with the answer’s text that stood and why it failed', async () => {
    const { draftApi } = draft({ definition }, () => [
      { event: 'delta', setup: 'setup', text: 'Tenker', channel: 'reasoning' },
      { event: 'delta', setup: 'setup', text: 'Nei', channel: 'answer' },
      { event: 'retract', setup: 'setup', reason: 'guardrail' },
      { event: 'delta', setup: 'setup', text: 'Ja', channel: 'answer' },
      { event: 'failed', setup: 'setup', problem: { status: 429, title: 'Kvoten er brukt opp' } },
    ]);
    await ask(draftApi, 'Hei').catch(() => undefined);
    expect((await draftApi.loadThread('draft-1')).turns).toEqual([
      {
        id: 'draft-1-1',
        question: 'Hei',
        askedAt: now(),
        answer: { text: 'Ja', status: 'failed', created: now(), failure: { kind: 'busy' } },
      },
    ]);
  });

  it('reads a copy of a thread’s turns, so one read before its answer ends stays as it was read', async () => {
    const held = gate();
    const { draftApi } = draft({ definition }, () => [
      { event: 'delta', setup: 'setup', text: 'Ja', channel: 'answer' },
      held.shut,
      result('Ja'),
    ]);
    const asking = ask(draftApi, 'Hei');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [read] = (await draftApi.loadThread('draft-1')).turns;
    held.open();
    await asking;
    expect(read?.answer).toBeUndefined();
    expect((await draftApi.loadThread('draft-1')).turns[0]?.answer?.status).toBe('complete');
  });

  it('keeps the question of an answer the reader stops reading, as stopped', async () => {
    const { draftApi } = draft({ definition }, answered('Svar'));
    const answering = draftApi.ask({
      question: 'Hei',
      model: 'byggesak__default',
      steps: true,
      signal: new AbortController().signal,
    });
    await answering.next();
    await answering.return(undefined);
    expect((await draftApi.loadThread('draft-1')).turns).toEqual([
      {
        id: 'draft-1-1',
        question: 'Hei',
        askedAt: now(),
        answer: { text: '', status: 'aborted', created: now() },
      },
    ]);
  });

  it('reads a question asked again in its thread as its latest attempt, as genki’s threads read', async () => {
    let fails = true;
    const { draftApi } = draft({ definition }, () =>
      fails
        ? [{ event: 'delta', setup: 'setup', text: 'Ja', channel: 'answer' }, failed]
        : answered('Svar')(),
    );
    await ask(draftApi, 'Hei  du').catch(() => undefined);
    fails = false;
    await ask(draftApi, ' Hei du ', { conversationId: 'draft-1' });
    expect(
      (await draftApi.loadThread('draft-1')).turns.map((t) => [t.question, t.answer?.status]),
    ).toEqual([[' Hei du ', 'complete']]);
  });

  it('sends only answers that came as history, not one stopped or failed on its way', async () => {
    const stop = new AbortController();
    const { draftApi, requests } = draft({ definition }, (request) =>
      'text' in request.input && request.input.text === 'Feiler'
        ? [{ event: 'delta', setup: 'setup', text: 'Halvt', channel: 'answer' }, failed]
        : 'text' in request.input && request.input.text === 'Stoppes'
          ? [
              { event: 'delta', setup: 'setup', text: 'Halvt', channel: 'answer' },
              new Promise<void>((resolve) => setTimeout(() => (stop.abort(), resolve()), 0)),
            ]
          : answered('Svar')(),
    );
    await ask(draftApi, 'Feiler').catch(() => undefined);
    await ask(draftApi, 'Stoppes', { conversationId: 'draft-1', signal: stop.signal }).catch(
      () => undefined,
    );
    await ask(draftApi, 'Hei', { conversationId: 'draft-1' });
    expect(
      (await draftApi.loadThread('draft-1')).turns.map((t) => [t.question, t.answer?.status]),
    ).toEqual([
      ['Feiler', 'failed'],
      ['Stoppes', 'aborted'],
      ['Hei', 'complete'],
    ]);
    expect(requests[2]?.history).toBeUndefined();
  });

  it('asks nothing and keeps no thread for a run the playground refuses', async () => {
    const { draftApi } = draft({ definition }, () => {
      throw new ApiError(422, {
        type: 'about:blank',
        title: 'Invalid setup',
        status: 422,
        errors: [{ path: 'setup.spec.purpose', message: 'Too small' }],
      });
    });
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
    expect(failed).toBeInstanceOf(NotAsked);
    expect(events).toEqual([]);
    expect(await draftApi.loadThreads()).toEqual([]);
  });

  it('asks nothing and keeps no thread for a run that fails before it starts', async () => {
    const { draftApi } = draft({ definition }, () => [failed]);
    expect(await ask(draftApi, 'Hei').catch((error: unknown) => error)).toBeInstanceOf(NotAsked);
    expect(await draftApi.loadThreads()).toEqual([]);
  });

  it('reports a refusal as the draft’s, with no thread, and a failure after the run started as its thread’s', async () => {
    const reported: [RunProblem, string | undefined][] = [];
    let started = false;
    const { draftApi } = draft(
      { definition },
      () =>
        started
          ? [{ event: 'delta', setup: 'setup', text: 'Ja', channel: 'answer' }, failed]
          : [failed],
      {},
      { onProblem: (problem, thread) => problem && reported.push([problem, thread]) },
    );
    await ask(draftApi, 'Hei').catch(() => undefined);
    started = true;
    await ask(draftApi, 'Hei igjen').catch(() => undefined);
    expect(reported).toEqual([
      [{ title: 'Feil', errors: [] }, undefined],
      [{ title: 'Feil', errors: [] }, 'draft-2'],
    ]);
  });

  it('reports no refusal of a question once a later one has been asked', async () => {
    const reported: RunProblem[] = [];
    const held = gate();
    const { draftApi } = draft(
      { definition },
      (request) =>
        'text' in request.input && request.input.text === 'Først'
          ? [held.shut, failed]
          : answered('Ja')(),
      {},
      { onProblem: (problem) => problem && reported.push(problem) },
    );
    const first = ask(draftApi, 'Først').catch((error: unknown) => error);
    await ask(draftApi, 'Så');
    held.open();
    expect(await first).toBeInstanceOf(NotAsked);
    expect(reported).toEqual([]);
  });

  it('fails a run that ends without an answer, and keeps its question as failed', async () => {
    const { draftApi } = draft({ definition }, () => [
      { event: 'delta', setup: 'setup', text: 'Ja', channel: 'answer' },
    ]);
    await expect(ask(draftApi, 'Hei')).rejects.toThrow('without an answer');
    const [turn] = (await draftApi.loadThread('draft-1')).turns;
    expect(turn?.answer?.status).toBe('failed');
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
