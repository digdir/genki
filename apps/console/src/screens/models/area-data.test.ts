import { describe, expect, it } from 'vitest';
import { exampleApis, exampleModels } from '../../mock';
import type {
  ConfigEntry,
  EndpointProcessorRecord,
  ModelApi,
  OperationDescriptor,
} from '../../types';
import {
  apisFor,
  beforeProduction,
  filterModels,
  allModels,
  firstOpenStep,
  modelsInUse,
  originOf,
  stepsDone,
  type GuideState,
} from './area-data';

const connection = (id: string, families: Record<string, string>): ConfigEntry => ({
  id,
  version: 1,
  spec: { baseURL: `https://${id}.example`, families },
});

const foundry = connection('foundry', { openai: '/openai/v1', anthropic: '/anthropic' });
const local = connection('local-model', { openai: '' });
const records: EndpointProcessorRecord[] = [
  {
    endpoint: 'foundry',
    record: { agreement: 'DBA-1', subProcessors: [], retention: { days: 0 } },
  },
  { endpoint: 'local-model', record: null },
];
const classify = {
  ...(exampleApis.find((a) => a.id === 'example/classify@1') as ModelApi),
  status: 'review',
};

const review: OperationDescriptor = {
  id: classify.id,
  operation: 'classify',
  status: 'review',
  source: 'uploaded',
  summary: '',
  family: 'openai',
  fixtures: 0,
  contract: null,
};

const guide = (change: Partial<GuideState> = {}): GuideState => ({
  api: classify,
  descriptor: review,
  kind: { kind: 'classify', builtIn: false, maturity: 'test', descriptors: [] },
  models: exampleModels,
  connections: [foundry, local],
  records,
  ...change,
});

describe('the models area', () => {
  it('a connection in use cannot be removed: the models switched on are counted', () => {
    expect(modelsInUse('foundry', exampleModels).map((m) => m.deployment)).toEqual([
      'gpt-4o-2M-tps',
      'gpt-4.1',
      'gpt-image-1.5',
    ]);
    expect(modelsInUse('local-model', exampleModels)).toEqual([]);
  });

  it("a model is offered only APIs in its connection's families", () => {
    expect(apisFor(exampleApis, ['openai'], 'chat').map((a) => a.id)).toEqual([
      'openai/chat-completions@1',
      'openai/responses@1',
    ]);
    expect(apisFor(exampleApis, ['openai', 'anthropic'], 'chat').map((a) => a.id)).toEqual([
      'anthropic/messages@1',
      'openai/chat-completions@1',
      'openai/responses@1',
    ]);
  });

  it('a built-in API with a recipe is told apart from one without', () => {
    const decide = exampleApis.find((a) => a.id === 'openai/decide@1') as ModelApi;
    const responses = exampleApis.find((a) => a.id === 'openai/responses@1') as ModelApi;
    expect(originOf(decide, [review, { ...review, id: decide.id }])).toBe('built-in-described');
    expect(originOf(responses, [])).toBe('built-in');
  });

  it('the model list filters by text, connection, kind and confirmation together', () => {
    const names = (filter: Partial<typeof allModels>) =>
      filterModels(exampleModels, { ...allModels, ...filter }).map((m) => m.deployment);
    expect(names({ text: 'GPT-4' })).toEqual(['gpt-4o-2M-tps', 'gpt-4.1']);
    expect(names({ kind: 'decide' })).toEqual(['gpt-4.1']);
    expect(names({ confirmed: 'unconfirmed' })).toEqual(['gpt-4o-2M-tps']);
    expect(names({ connection: 'local-model' })).toEqual([]);
  });

  it('the guided path starts at the first step that is not done', () => {
    expect(firstOpenStep(guide())).toBe('try');
    const tested = guide({
      descriptor: {
        ...review,
        fixtures: 1,
        contract: { suite: 'operation@1', checks: 7, passed: true, failures: [] },
      },
    });
    expect(stepsDone(tested)).toMatchObject({ try: true, record: true, approve: false });
    expect(firstOpenStep(tested)).toBe('approve');
  });

  it('a missing processor record is listed among what is missing before production', () => {
    const { missing, ready } = beforeProduction(guide());
    expect(missing).toEqual([
      { item: 'approval' },
      { item: 'testCase' },
      { item: 'noModel' },
      { item: 'kindInTest', kind: 'classify' },
      { item: 'processorRecord', connection: 'local-model' },
    ]);
    expect(ready).toContainEqual({ item: 'processorRecord', connection: 'foundry' });
  });

  it('once models bind the API, only their connections are checked for a processor record', () => {
    const bound = exampleModels.map((m) =>
      m.deployment === 'gpt-4.1' ? { ...m, apis: { ...m.apis, classify: classify.id } } : m,
    );
    const { missing } = beforeProduction(guide({ models: bound }));
    expect(missing).not.toContainEqual({ item: 'processorRecord', connection: 'local-model' });
    expect(missing).not.toContainEqual({ item: 'noModel' });
  });
});
