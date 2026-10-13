import type { ApiClient } from '../../api';
import type {
  PlaygroundOptions,
  PlaygroundRunRequest,
  PlaygroundRunResponse,
  PlaygroundStreamEvent,
  TestCaseCandidate,
  TestCaseCandidateRequest,
} from '../../api/playground';
import { examplePlaygroundOptions, exampleRun, exampleStreamEvents } from '../../data/playground';

export interface PlaygroundBackend {
  options: (signal: AbortSignal) => Promise<PlaygroundOptions>;
  run: (body: PlaygroundRunRequest) => Promise<PlaygroundRunResponse>;
  stream: (
    body: PlaygroundRunRequest,
    onEvent: (event: PlaygroundStreamEvent) => void,
    signal?: AbortSignal,
  ) => Promise<void>;
  proposeTestCase: (body: TestCaseCandidateRequest) => Promise<TestCaseCandidate>;
}

export const apiBackend = (api: ApiClient, tenant: string): PlaygroundBackend => ({
  options: (signal) => api.playground.options(tenant, signal),
  run: (body) => api.playground.run(tenant, body),
  stream: (body, onEvent, signal) => api.playground.runStream(tenant, body, onEvent, signal),
  proposeTestCase: (body) => api.playground.proposeTestCase(tenant, body),
});

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

export const exampleBackend: PlaygroundBackend = {
  options: async () => examplePlaygroundOptions,
  run: async (body) => exampleRun(examplePlaygroundOptions, body),
  stream: async (body, onEvent, signal) => {
    for (const event of exampleStreamEvents(examplePlaygroundOptions, body)) {
      if (signal?.aborted) return;
      onEvent(event);
      await pause(event.event === 'delta' ? 10 : 40, signal);
    }
  },
  proposeTestCase: async (body) => ({
    id: `fb-${body.task}`,
    task: body.task,
    question: body.question,
    answer: body.answer,
    status: 'pending-review',
    targetTestSet: body.testSet,
    origin: body.origin,
  }),
};
