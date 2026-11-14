import type { ApiClient } from '../../../api';
import type {
  PlaygroundOptions,
  PlaygroundRunRequest,
  PlaygroundStreamEvent,
} from '../../../api/playground';

// An invented draft that answers in a chat and searches one dataset, which has two filter fields.
export const definition = {
  kind: 'Service',
  metadata: { id: 'byggesak', name: 'Byggesaksveileder', tenant: 'eksempel' },
  spec: {
    output: { kind: 'answer' },
    exposure: { chat: true },
    model: { primary: 'modell-b' },
    variants: ['default', 'kort'],
    knowledge: { datasets: [{ dataset: 'felles/byggeregler' }, { dataset: 'felles/plankart' }] },
  },
};

const declared = {
  byggeregler: [
    { field: 'kommune', kinds: ['multiselect'] },
    { field: 'aar', kinds: ['multiselect'], 'value-type': 'integer' },
    { field: 'tekst', kinds: ['contains'] },
  ],
  plankart: [],
};

type PlaygroundServices = PlaygroundOptions['services'];

const options: PlaygroundOptions = {
  services: [],
  models: [
    { id: 'modell-a', name: 'Modell A', dataLocation: 'eu', status: 'allowed' },
    { id: 'modell-b', name: 'Modell B', dataLocation: 'eu', status: 'allowed' },
  ],
  datasets: [{ id: 'felles/byggeregler', name: 'Byggeregler' }],
  skills: [],
  blocks: [],
  testSets: [],
  quota: { usedPercent: 0, monthlyTokens: 0 },
};

export const result = (text: string): PlaygroundStreamEvent => ({
  event: 'result',
  setup: 'setup',
  result: {
    runId: 'run-1',
    text,
    sources: [
      {
        chunkId: 'c1',
        title: 'Plan- og bygningsloven',
        document: 'pbl',
        text: 'Første utdrag',
        position: 0,
      },
      {
        chunkId: 'c2',
        title: 'Plan- og bygningsloven',
        document: 'pbl',
        text: 'Andre utdrag',
        position: 3,
      },
    ],
    searchNotes: [],
    timeMs: 10,
    tokensIn: 1,
    tokensOut: 1,
    costNok: null,
    dataLocation: null,
  },
});

/** A run that answers with the text and two excerpts of one document. */
export const answered = (text: string) => (): PlaygroundStreamEvent[] => [
  { event: 'delta', setup: 'setup', text, channel: 'answer' },
  result(text),
  { event: 'done', quota: { usedPercent: 0, monthlyTokens: 0 } },
];

/** The portal client's parts the try view calls; a run sends nothing once its signal is aborted. */
export const fakeClient = (
  events: (request: PlaygroundRunRequest) => PlaygroundStreamEvent[],
  { optionsFail = 0, services = [] }: { optionsFail?: number; services?: PlaygroundServices } = {},
) => {
  const requests: PlaygroundRunRequest[] = [];
  const paths: string[] = [];
  let failing = optionsFail;
  const api = {
    playground: {
      options: async () => {
        if (failing > 0) {
          failing -= 1;
          throw new Error('options failed');
        }
        return { ...options, services };
      },
      runStream: async (
        _tenant: string,
        body: PlaygroundRunRequest,
        onEvent: (event: PlaygroundStreamEvent) => void,
        signal?: AbortSignal,
      ) => {
        requests.push(structuredClone(body));
        for (const event of events(body)) {
          if (signal?.aborted) return;
          onEvent(event);
        }
      },
    },
    getJson: async (path: string) => {
      paths.push(path);
      // Only a dataset named with its tenant, as the draft names it, is found.
      const dataset = /^\/api\/datasets\/felles\/([a-z]+)$/.exec(path)?.[1];
      if (dataset) return { dataset: { filters: declared[dataset as keyof typeof declared] } };
      return { fields: [{ field: 'kommune', options: [{ value: 'Oslo', count: 3 }] }] };
    },
  } as unknown as ApiClient;
  return { api, requests, paths };
};
