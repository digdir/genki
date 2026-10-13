import type {
  PlaygroundOptions,
  PlaygroundRefusal,
  PlaygroundRunRequest,
  TestCaseCandidate,
  TestCaseCandidateRequest,
} from '../api/playground';
import {
  examplePlaygroundOptions,
  exampleRun,
  exampleStreamEvents,
  sseOf,
} from '../data/playground';
import type { MockHandler } from '../mock';

export interface PlaygroundMockOptions {
  options?: PlaygroundOptions;
  failRuns?: number;
  failure?: { code: string; title: string; step?: string; detail?: string; runId?: string };
  quotaExhausted?: boolean;
  runs?: PlaygroundRunRequest[];
  candidates?: TestCaseCandidateRequest[];
}

const tenantRoute =
  /^\/tenants\/([^/]+)\/(playground\/options|playground\/runs(?:\/stream)?|testcase-candidates)$/;

const unavailableTitle =
  'Vi fikk ikke svar fra modellen. Ingenting er lagret, og kjøringen er ikke telt i kvoten.';
const quotaTitle =
  'Kvoten for måneden er brukt opp. Kjøringen er ikke startet, og ingenting er lagret. En administrator kan øke «Tokens per måned» under Innstillinger.';

const sse = (body: string) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

export const playgroundMock = (mockOptions: PlaygroundMockOptions = {}): MockHandler => {
  const options = mockOptions.options ?? examplePlaygroundOptions;
  let failures = mockOptions.failRuns ?? 0;
  return (request) => {
    const match = tenantRoute.exec(request.path);
    if (!match) return undefined;
    const route = match[2];
    if (route === 'playground/options' && request.method === 'GET') return request.json(options);
    const streaming = route === 'playground/runs/stream';
    if ((route === 'playground/runs' || streaming) && request.method === 'POST') {
      const body = request.body<PlaygroundRunRequest>();
      mockOptions.runs?.push(body);
      if (mockOptions.quotaExhausted)
        return request.json(
          {
            type: 'about:blank',
            title: quotaTitle,
            status: 429,
            quota: { ...options.quota, usedPercent: 100 },
          },
          429,
        );
      for (const [setup, value] of [
        ['setup', body.setup],
        ['compareWith', body.compareWith],
      ] as const) {
        const model = value && options.models.find((m) => m.id === value.model);
        if (model && model.status !== 'allowed') {
          const refusal: PlaygroundRefusal = {
            type: 'about:blank',
            title: `${model.id} kan ikke brukes i prøveområdet`,
            status: 403,
            setup,
            policy: model.policy ?? {
              block: model.id,
              rule: `${model.id} er ikke tillatt hos dere.`,
              ownedBy: 'Digdir',
              link: '#/building-blocks',
            },
          };
          return request.json(refusal, 403);
        }
      }
      if (failures > 0) {
        failures -= 1;
        const problem = {
          type: 'urn:genai:problem:playground-unavailable',
          status: 502,
          title: unavailableTitle,
          code: 'model_error',
          setup: 'setup' as const,
          ...mockOptions.failure,
        };
        if (!streaming) return request.json(problem, 502);
        return sse(
          sseOf([
            { event: 'status', setup: 'setup', status: 'failed' },
            { event: 'failed', setup: 'setup', problem },
            { event: 'done', quota: options.quota },
          ]),
        );
      }
      if (streaming) return sse(sseOf(exampleStreamEvents(options, body)));
      return request.json(exampleRun(options, body));
    }
    if (route === 'testcase-candidates' && request.method === 'POST') {
      const body = request.body<TestCaseCandidateRequest>();
      mockOptions.candidates?.push(body);
      const candidate: TestCaseCandidate = {
        id: `fb-${body.task}`,
        task: body.task,
        question: body.question,
        answer: body.answer,
        status: 'pending-review',
        ...(body.service ? { service: body.service } : {}),
        targetTestSet: body.testSet,
        origin: body.origin,
      };
      return request.json(candidate, 201);
    }
    return undefined;
  };
};
