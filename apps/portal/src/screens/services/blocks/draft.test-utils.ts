import type { ApiClient } from '../../../api';
import type {
  PlaygroundOptions,
  PlaygroundRunRequest,
  PlaygroundStreamEvent,
} from '../../../api/playground';

// An invented draft that searches one dataset with two filter fields.
export const definition = {
  kind: 'Service',
  metadata: { id: 'byggesak', name: 'Byggesaksveileder', tenant: 'eksempel' },
  spec: {
    output: { kind: 'answer' },
    model: { primary: 'modell-b' },
    variants: ['default'],
    knowledge: {
      datasets: [
        { dataset: 'felles/byggeregler', filters: { kommune: 'multiselect', aar: 'multiselect' } },
      ],
    },
  },
};

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

/** The parts of the portal's client the try view calls, with what they were asked. */
export const fakeClient = (events: (request: PlaygroundRunRequest) => PlaygroundStreamEvent[]) => {
  const requests: PlaygroundRunRequest[] = [];
  const paths: string[] = [];
  const api = {
    playground: {
      options: async () => options,
      runStream: async (
        _tenant: string,
        body: PlaygroundRunRequest,
        onEvent: (event: PlaygroundStreamEvent) => void,
      ) => {
        requests.push(structuredClone(body));
        for (const event of events(body)) onEvent(event);
      },
    },
    listDatasets: async () => [{ id: 'felles/byggeregler', name: 'Byggeregler', description: '' }],
    getJson: async (path: string) => {
      paths.push(path);
      return { fields: [{ field: 'kommune', options: [{ value: 'Oslo', count: 3 }] }] };
    },
  } as unknown as ApiClient;
  return { api, requests, paths };
};
