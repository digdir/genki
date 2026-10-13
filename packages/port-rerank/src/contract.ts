import { envSecrets, type PortContext } from '@genai/kernel';
import {
  check,
  checkEqual,
  checkFailsWith,
  fakeHttp,
  skipped,
  type ContractSuite,
  type ContractTarget,
  type FakeReply,
} from '@genai/plugins';
import type { RerankAdapter } from './adapter.js';
import type { FailureMode, Ranked, RerankPort } from './port.js';
import { RerankRouter } from './router.js';

export const rerankContractVersion = 'rerank@1';

export type RerankScenario = 'score' | 'out-of-range' | { status: number };

export interface RerankContractFixture {
  adapter: RerankAdapter;
  basePath?: string;
  endpointOptions?: Record<string, unknown>;
  rerankerOptions?: Record<string, unknown>;
  inputs(body: Record<string, unknown>): { query: string; documents: string[] };
  ranking(ranked: Ranked[]): FakeReply;
  failure(status: number): FakeReply;
}

export interface RerankContractSubject {
  script?(scenario: RerankScenario): void;
  calls?(): number;
  open(options?: { onFailure?: FailureMode; signal?: AbortSignal }): RerankPort;
}

const overlap = (query: string, document: string) => {
  const words = new Set(query.toLowerCase().split(/\s+/));
  return document
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => words.has(w)).length;
};

export const rerankContractTarget = async (
  fixture: RerankContractFixture,
): Promise<ContractTarget<RerankContractSubject>> => {
  let scenario: RerankScenario = 'score';
  const server = await fakeHttp((body) => {
    if (typeof scenario === 'object') return fixture.failure(scenario.status);
    const { query, documents } = fixture.inputs(body);
    const ranked = documents
      .map((d, index) => ({ index, score: overlap(query, d) + 1 / (index + 2) }))
      .sort((a, b) => b.score - a.score)
      .map((r, i) => ({ ...r, rank: i + 1 }));
    return fixture.ranking(
      scenario === 'out-of-range' ? [...ranked, { index: 99, score: 9, rank: 0 }] : ranked,
    );
  });
  const subject: RerankContractSubject = {
    script: (next) => {
      scenario = next;
    },
    calls: () => server.seen.length,
    open: ({ onFailure = 'fail', signal = new AbortController().signal } = {}) => {
      const router = new RerankRouter({
        catalog: {
          endpoints: {
            contract: {
              engine: fixture.adapter.engine,
              baseURL: `${server.url}${fixture.basePath ?? ''}`,
              auth: { kind: 'api-key', secret: 'secret://env/contract-key' },
              options: fixture.endpointOptions ?? {},
            },
          },
          rerankers: [
            {
              id: 'contract/reranker',
              endpoint: 'contract',
              residency: 'norway',
              onFailure,
              options: fixture.rerankerOptions ?? {},
            },
          ],
        },
        adapters: [fixture.adapter],
        secrets: envSecrets({ CONTRACT_KEY: 'contract-key' }),
        timeoutMs: 5000,
      });
      const ctx: PortContext = {
        tenant: '991825827',
        principal: { kind: 'employee', issuer: 'contract', subject: 'kari', tenant: '991825827' },
        task: 'contract',
        signal,
        meter: async () => undefined,
      };
      return router.open({ kind: 'reranker', id: 'contract/reranker' }, ctx);
    },
  };
  return { subject, close: () => server.close() };
};

const request = {
  query: 'frist for tilskudd',
  documents: ['Reiseregning og diett', 'Frist for tilskudd til kultur', 'Barnehageplass'],
};

export const rerankContract: ContractSuite<RerankContractSubject> = {
  contract: rerankContractVersion,
  checks: [
    {
      name: 'ranking names each document once, best match first',
      run: async (s) => {
        s.script?.('score');
        const { ranking, degraded } = await s.open().rerank(request);
        check(!degraded, 'the ranking is not degraded');
        checkEqual([...ranking.map((r) => r.index)].sort(), [0, 1, 2], 'ranked document indices');
        checkEqual(ranking[0]?.index, 1, 'the best match');
        check(
          ranking.every((r, i) => i === 0 || (ranking[i - 1]?.score ?? 0) >= r.score),
          'scores fall with rank',
        );
      },
    },
    {
      name: 'indices outside the documents are dropped',
      run: async (s) => {
        if (!s.script) return skipped;
        s.script('out-of-range');
        const { ranking } = await s.open().rerank(request);
        check(
          ranking.every((r) => r.index >= 0 && r.index < request.documents.length),
          'every index points at a document',
        );
      },
    },
    {
      name: 'no documents calls nothing upstream',
      run: async (s) => {
        const before = s.calls?.();
        checkEqual((await s.open().rerank({ query: 'x', documents: [] })).ranking, [], 'ranking');
        checkEqual(s.calls?.(), before, 'upstream calls');
      },
    },
    {
      name: 'a failing engine degrades to retrieval order, or fails when the reranker says fail',
      run: async (s) => {
        const script = s.script?.bind(s);
        if (!script) return skipped;
        script({ status: 500 });
        const degraded = await s.open({ onFailure: 'degrade' }).rerank(request);
        checkEqual(degraded.ranking, [], 'degraded ranking');
        check(degraded.degraded?.reason === 'error', 'the result says it is degraded');
        await checkFailsWith(() => s.open().rerank(request), 'unavailable', 'HTTP 500');
        script({ status: 429 });
        await checkFailsWith(() => s.open().rerank(request), 'rate_limited', 'HTTP 429');
      },
    },
    {
      name: 'an aborted signal fails as cancelled, also in degrade mode',
      run: async (s) => {
        s.script?.('score');
        const controller = new AbortController();
        controller.abort();
        await checkFailsWith(
          () => s.open({ onFailure: 'degrade', signal: controller.signal }).rerank(request),
          'cancelled',
          'aborted rerank',
        );
      },
    },
  ],
};
