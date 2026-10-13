import type { Ref, Usage } from '@genai/contracts';
import { envSecrets, type PortContext } from '@genai/kernel';
import {
  check,
  checkEqual,
  checkFailsWith,
  fakeHttp,
  type ContractSuite,
  type ContractTarget,
  type FakeReply,
} from '@genai/plugins';
import type { EmbeddingAdapter } from './adapter.js';
import type { EmbeddingPort } from './port.js';
import { EmbeddingRouter } from './router.js';
import { fakeVector } from './testing.js';

export const embeddingContractVersion = 'embedding@1';

export type EmbeddingScenario = 'echo' | 'short' | { status: number };

export interface EmbeddingContractFixture {
  adapter: EmbeddingAdapter;
  basePath?: string;
  endpointOptions?: Record<string, unknown>;
  modelOptions?: Record<string, unknown>;
  inputs(body: Record<string, unknown>): string[];
  vectors(vectors: number[][], inputTokens: number): FakeReply;
  failure(status: number): FakeReply;
}

export interface EmbeddingContractSubject {
  dimensions: number;
  script(scenario: EmbeddingScenario): void;
  calls(): number;
  open(options?: { maxBatch?: number; signal?: AbortSignal }): {
    port: EmbeddingPort;
    metered: { usage: Usage; model?: Ref }[];
  };
}

const dimensions = 8;

export const embeddingContractTarget = async (
  fixture: EmbeddingContractFixture,
): Promise<ContractTarget<EmbeddingContractSubject>> => {
  let scenario: EmbeddingScenario = 'echo';
  const server = await fakeHttp((body) => {
    if (typeof scenario === 'object') return fixture.failure(scenario.status);
    const texts = fixture.inputs(body);
    const vectors = texts.map((t) => fakeVector(t, dimensions));
    return fixture.vectors(scenario === 'short' ? vectors.slice(1) : vectors, texts.length * 3);
  });
  const subject: EmbeddingContractSubject = {
    dimensions,
    script: (next) => {
      scenario = next;
    },
    calls: () => server.seen.length,
    open: ({ maxBatch, signal = new AbortController().signal } = {}) => {
      const router = new EmbeddingRouter({
        catalog: {
          endpoints: {
            contract: {
              protocol: fixture.adapter.protocol,
              baseURL: `${server.url}${fixture.basePath ?? ''}`,
              auth: { kind: 'bearer', secret: 'secret://env/contract-key' },
              options: fixture.endpointOptions ?? {},
            },
          },
          models: [
            {
              id: 'contract/embedder',
              endpoint: 'contract',
              deployment: 'contract-embedder',
              dimensions,
              residency: 'norway',
              ...(maxBatch === undefined ? {} : { maxBatch }),
              options: fixture.modelOptions ?? {},
            },
          ],
        },
        adapters: [fixture.adapter],
        secrets: envSecrets({ CONTRACT_KEY: 'contract-key' }),
        maxRetries: 0,
        timeoutMs: 5000,
      });
      const metered: { usage: Usage; model?: Ref }[] = [];
      const ctx: PortContext = {
        tenant: '991825827',
        principal: { kind: 'employee', issuer: 'contract', subject: 'kari', tenant: '991825827' },
        task: 'contract',
        signal,
        meter: async (usage, model) => {
          metered.push({ usage, ...(model ? { model } : {}) });
        },
      };
      return { port: router.open({ kind: 'embedder', id: 'contract/embedder' }, ctx), metered };
    },
  };
  return { subject, close: () => server.close() };
};

const texts = ['Tilskudd til kultur', 'Søknadsfrist for barnehage', 'Reiseregning'];

export const embeddingContract: ContractSuite<EmbeddingContractSubject> = {
  contract: embeddingContractVersion,
  checks: [
    {
      name: 'embed returns one vector per text, in input order, with the declared dimensions',
      run: async (s) => {
        s.script('echo');
        const { port, metered } = s.open();
        const result = await port.embed(texts);
        checkEqual(result.vectors.length, texts.length, 'vectors');
        texts.forEach((text, i) => {
          const vector = result.vectors[i] ?? [];
          checkEqual(vector.length, s.dimensions, `dimensions of vector ${i}`);
          const expected = fakeVector(text, s.dimensions);
          check(
            vector.every((v, j) => Math.abs(v - (expected[j] ?? 0)) < 1e-6),
            `vector ${i} belongs to "${text}"`,
          );
        });
        check(result.usage.inputTokens > 0, 'input tokens are counted');
        checkEqual(metered.length, 1, 'metered usage');
      },
    },
    {
      name: 'a batch limit splits the call and keeps the order',
      run: async (s) => {
        s.script('echo');
        const { port } = s.open({ maxBatch: 2 });
        const before = s.calls();
        const result = await port.embed(texts);
        checkEqual(s.calls() - before, 2, 'upstream calls');
        const last = fakeVector(texts[2] ?? '', s.dimensions);
        check(
          (result.vectors[2] ?? []).every((v, j) => Math.abs(v - (last[j] ?? 0)) < 1e-6),
          'the third vector belongs to the third text',
        );
      },
    },
    {
      name: 'an empty input calls nothing upstream',
      run: async (s) => {
        const { port } = s.open();
        const before = s.calls();
        checkEqual((await port.embed([])).vectors, [], 'vectors');
        checkEqual(s.calls(), before, 'upstream calls');
      },
    },
    {
      name: 'a response with the wrong number of vectors fails as invalid_response',
      run: async (s) => {
        s.script('short');
        const { port } = s.open();
        await checkFailsWith(() => port.embed(texts), 'invalid_response', 'short response');
      },
    },
    {
      name: 'upstream refusals map to rate_limited, unauthorized and unavailable',
      run: async (s) => {
        const { port } = s.open();
        for (const [status, code] of [
          [429, 'rate_limited'],
          [401, 'unauthorized'],
          [500, 'unavailable'],
        ] as const) {
          s.script({ status });
          await checkFailsWith(() => port.embed(texts), code, `HTTP ${status}`);
        }
      },
    },
    {
      name: 'an aborted signal fails as cancelled',
      run: async (s) => {
        s.script('echo');
        const controller = new AbortController();
        controller.abort();
        const { port } = s.open({ signal: controller.signal });
        await checkFailsWith(() => port.embed(texts), 'cancelled', 'aborted embed');
      },
    },
  ],
};
