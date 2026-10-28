import type { ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { envSecrets } from '@genai/kernel';
import { IndexWriterRouter } from '@genai/port-knowledge';
import { memoryEngine } from '@genai/port-knowledge/testing';
import { testWebsite } from '../../../scripts/test-website.js';
import { InMemoryConfigEntryStore } from './config-store.js';
import { indexIngestionBackend } from './index-ingestion.js';
import { IngestionService, InMemoryExecutionStore, pipelineSpec } from './ingestion.js';

let fixture: Awaited<ReturnType<typeof testWebsite>> | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

const setup = async (sitemapStatus = 200) => {
  const pages: Record<string, number> = {
    '/a.md': 200,
    '/missing.md': 404,
    '/broken.md': 500,
    '/b.md': 200,
  };
  let baseUrl = '';
  fixture = await testWebsite((req, res: ServerResponse) => {
    if (req.url === '/sitemap.xml') {
      res.writeHead(sitemapStatus);
      res.end(
        `<urlset>${Object.keys(pages)
          .map((path) => `<url><loc>${baseUrl}${path}</loc></url>`)
          .join('')}</urlset>`,
      );
    } else {
      res.writeHead(pages[req.url ?? ''] ?? 404, { 'content-type': 'text/markdown' });
      res.end('# Page\n\nUseful documentation.');
    }
  });
  const { url, web } = fixture;
  baseUrl = url;
  const engine = memoryEngine();
  const writers = new IndexWriterRouter({
    catalog: {
      endpoints: { local: { engine: 'memory' } },
      datasets: [{ id: 'tenant/docs', endpoint: 'local', residency: 'norway' }],
    },
    adapters: [engine.writer],
    knowledgeAdapters: [engine.adapter],
    secrets: envSecrets({}),
  });
  const executions = new InMemoryExecutionStore();
  const service = new IngestionService({
    store: new InMemoryConfigEntryStore(),
    executions,
    backend: indexIngestionBackend({
      writers,
      residencyOf: () => 'norway',
      platformTenant: 'tenant',
      web,
    }),
  });
  const run = async (budget: number, exclude: string[] = []) => {
    const started = await service.execute({
      pipeline: {
        dataset: 'tenant/docs',
        id: 'pages',
        version: 1,
        by: 'test',
        at: '',
        reason: 'test',
        spec: pipelineSpec.parse({
          name: 'Website',
          source: { kind: 'website', sitemap: `${url}/sitemap.xml`, exclude },
          chunking: { minimumLength: 1, metadataStyle: 'none' },
          maxDocumentFailures: budget,
          parallelism: 1,
        }),
      },
      target: { dataset: 'tenant/docs', endpoint: 'local', collections: {} },
      by: 'test',
    });
    if (!started.ok) throw new Error(JSON.stringify(started.errors));
    await started.done;
    const execution = await executions.get(started.value.id);
    if (!execution) throw new Error('execution was not persisted');
    return execution;
  };
  const route = writers.open('tenant/docs', { signal: new AbortController().signal });
  return { url, run, ...route };
};

describe('website execution reports through local HTTP', () => {
  it('succeeds after a 404 skip and stores the other pages', async () => {
    const { url, run, writer, dataset } = await setup();
    const execution = await run(1, ['/broken.md']);
    expect(execution).toMatchObject({
      status: 'succeeded',
      report: {
        stored: 2,
        skipped: 1,
        failed: [],
        promoted: true,
        skippedDocuments: [{ document: `${url}/missing.md`, reason: 'not_found' }],
      },
    });
    expect((await writer.stats(dataset, execution.id)).documents).toBe(2);
  });

  it('lists skipped and failed URLs and reasons in the persisted execution report', async () => {
    const { url, run, writer, dataset } = await setup();
    const execution = await run(2);
    expect(execution).toMatchObject({
      status: 'succeeded',
      report: {
        stored: 2,
        skipped: 1,
        promoted: true,
        skippedDocuments: [{ document: `${url}/missing.md`, reason: 'not_found' }],
        failedDocuments: [
          { document: `${url}/broken.md`, reason: expect.stringContaining('HTTP 500') },
        ],
      },
    });
    expect(execution.report?.failed).toHaveLength(1);
    const documents = [];
    if (!writer.read) throw new Error('fixture writer must support reading');
    for await (const doc of writer.read(dataset, execution.id)) documents.push(doc);
    expect(documents).toHaveLength(2);
    expect(documents[0]?.fields.ingested_at).toEqual(expect.any(String));
    expect(documents[0]?.chunks[0]?.metadata).not.toHaveProperty('metadata');
  });

  it('fails when the budget is reached, retains URL details, and preserves the active generation', async () => {
    const { url, run, writer, dataset } = await setup();
    const previous = await run(2);
    const execution = await run(1);
    expect(execution).toMatchObject({
      status: 'failed',
      report: {
        stored: 1,
        skipped: 1,
        promoted: false,
        skippedDocuments: [{ document: `${url}/missing.md`, reason: 'not_found' }],
        failedDocuments: [
          { document: `${url}/broken.md`, reason: expect.stringContaining('HTTP 500') },
        ],
      },
    });
    expect(await writer.active(dataset)).toBe(previous.id);
  });

  it.each([404, 500])(
    'fails the run for a sitemap HTTP %s and promotes nothing',
    async (status) => {
      const { run, writer, dataset } = await setup(status);
      const execution = await run(100);
      expect(execution).toMatchObject({
        status: 'failed',
        error: expect.stringContaining(`HTTP ${status}`),
      });
      expect(await writer.active(dataset)).toBeUndefined();
    },
  );
});
