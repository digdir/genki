import {
  envSecrets,
  type EndpointAuth,
  type PortContext,
  type SecretResolver,
} from '@genai/kernel';
import { check, checkEqual, checkFailsWith, skipped, type ContractSuite } from '@genai/plugins';
import type { KnowledgeAdapter } from './adapter.js';
import { type KnowledgePort } from './port.js';
import { KnowledgeRouter } from './router.js';
import { fixtureDocuments, fixtureFilters, fixtureQueries, rangeCase } from './testing/corpus.js';

export const knowledgeContractVersion = 'knowledge@1';

export interface KnowledgeContractSubject {
  open(signal?: AbortSignal): KnowledgePort;
  writes?(): number;
}

export interface KnowledgeContractEndpoint {
  adapter: KnowledgeAdapter;
  baseURL?: string;
  auth?: EndpointAuth;
  datasetOptions: Record<string, unknown>;
  secrets?: SecretResolver;
}

export const knowledgeContractSubject = (
  endpoint: KnowledgeContractEndpoint,
  writes?: () => number,
): KnowledgeContractSubject => {
  const router = new KnowledgeRouter({
    catalog: {
      endpoints: {
        contract: {
          engine: endpoint.adapter.engine,
          ...(endpoint.baseURL ? { baseURL: endpoint.baseURL } : {}),
          ...(endpoint.auth ? { auth: endpoint.auth } : {}),
          options: {},
        },
      },
      datasets: [
        {
          id: 'contract/runtime',
          endpoint: 'contract',
          residency: 'norway',
          filters: fixtureFilters,
          options: endpoint.datasetOptions,
        },
      ],
    },
    adapters: [endpoint.adapter],
    secrets: endpoint.secrets ?? envSecrets({}),
  });
  const contextFor = (signal: AbortSignal): PortContext => ({
    tenant: '991825827',
    principal: { kind: 'employee', issuer: 'contract', subject: 'kari', tenant: '991825827' },
    task: 'contract',
    signal,
    meter: async () => undefined,
  });
  return {
    open: (signal = new AbortController().signal) =>
      router.open({ kind: 'dataset', id: 'contract/runtime' }, contextFor(signal)),
    ...(writes ? { writes } : {}),
  };
};

const declares = (port: KnowledgePort, capability: string) =>
  (port.info().capabilities ?? []).some((c) => c === capability);

const sorted = (values: string[]) => [...new Set(values)].sort();

export const knowledgeContract: ContractSuite<KnowledgeContractSubject> = {
  contract: knowledgeContractVersion,
  checks: [
    {
      name: 'a search finds the one chunk that mentions a rare word',
      run: async (s) => {
        const { hits } = await s.open().search({ query: fixtureQueries.unique.query, limit: 5 });
        checkEqual(hits[0]?.id, fixtureQueries.unique.chunk, 'first hit');
        check((hits[0]?.text ?? '').length > 0, 'the hit carries its text');
      },
    },
    {
      name: 'fetch returns chunks in request order and drops unknown ids',
      run: async (s) => {
        const port = s.open();
        if (!declares(port, 'fetch')) return skipped;
        const fetched = await port.fetch(['dok-2-1', 'finnes-ikke', 'dok-1-0']);
        checkEqual(
          fetched.map((h) => h.id),
          ['dok-2-1', 'dok-1-0'],
          'fetched ids',
        );
      },
    },
    {
      name: "range returns one document's chunks in position order",
      run: async (s) => {
        const port = s.open();
        if (!declares(port, 'range')) return skipped;
        const hits = await port.range(rangeCase.document, rangeCase.from, rangeCase.to);
        checkEqual(
          hits.map((h) => h.id),
          rangeCase.chunks,
          'range',
        );
      },
    },
    {
      name: 'a select filter narrows the hits to its documents',
      run: async (s) => {
        const port = s.open();
        if (!declares(port, 'filter.select')) return skipped;
        const { hits } = await port.search({
          query: fixtureQueries.everywhere,
          filters: { kategori: 'Rapport' },
          limit: 50,
        });
        checkEqual(sorted(hits.map((h) => h.document ?? '')), ['dok-2', 'dok-5'], 'documents');
      },
    },
    {
      name: 'facets count values, or fail as unsupported when not declared',
      run: async (s) => {
        const port = s.open();
        if (!declares(port, 'facets')) {
          await checkFailsWith(() => port.facets(['kategori']), 'unsupported', 'facets');
          return;
        }
        const facets = await port.facets(['kategori']);
        checkEqual(
          [...(facets.kategori ?? [])].sort((a, b) => a.value.localeCompare(b.value)),
          [
            { value: 'Rapport', count: 2 },
            { value: 'Rundskriv', count: 1 },
            { value: 'Veiledning', count: 2 },
          ],
          'kategori',
        );
      },
    },
    {
      name: 'an unknown profile is bad_request',
      run: async (s) => {
        await checkFailsWith(
          () => s.open().search({ query: 'x', profile: 'finnes-ikke' }),
          'bad_request',
          'unknown profile',
        );
      },
    },
    {
      name: 'an aborted signal fails as cancelled',
      run: async (s) => {
        const controller = new AbortController();
        controller.abort();
        await checkFailsWith(
          () => s.open(controller.signal).search({ query: fixtureQueries.everywhere }),
          'cancelled',
          'aborted search',
        );
      },
    },
    {
      name: 'an export hands over every document with its chunks',
      run: async (s) => {
        const exporter = s.open().export;
        if (!exporter) return skipped;
        const seen = [];
        for await (const doc of exporter.documents()) seen.push(doc);
        checkEqual(
          sorted(seen.map((d) => d.id)),
          sorted(fixtureDocuments.map((d) => d.id)),
          'documents',
        );
        const first = seen.find((d) => d.id === 'dok-1');
        checkEqual(first?.chunks.length, fixtureDocuments[0]?.chunks.length, 'chunks of dok-1');
        checkEqual(await exporter.count(100), fixtureDocuments.length, 'count');
      },
    },
    {
      name: 'the engine is never written to',
      run: async (s) => {
        if (!s.writes) return skipped;
        checkEqual(s.writes(), 0, 'writes');
      },
    },
  ],
};

export { fixtureDocuments, fixtureFilters } from './testing/corpus.js';
