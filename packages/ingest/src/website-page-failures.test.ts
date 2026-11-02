import type { ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryEngine } from '@genai/port-knowledge/testing';
import { testWebsite } from '../../../scripts/test-website.js';
import {
  crawlSitemap,
  guardedFetchBytes,
  runIndexIngest,
  websiteFetchPolicy,
  websiteSource,
  type IngestOptions,
} from './index.js';

let fixture: Awaited<ReturnType<typeof testWebsite>> | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

const setup = async (pages: Record<string, (res: ServerResponse) => void>) => {
  let baseUrl = '';
  fixture = await testWebsite((req, res) => {
    if (req.url === '/sitemap.xml') {
      res.end(
        `<urlset>${Object.keys(pages)
          .map((path) => `<url><loc>${baseUrl}${path}</loc></url>`)
          .join('')}</urlset>`,
      );
    } else pages[req.url ?? '']?.(res);
  });
  const { url, web } = fixture;
  baseUrl = url;
  const policy = websiteFetchPolicy({
    sitemapUrl: `${url}/sitemap.xml`,
    limits: {
      maxMarkdownBytes: 100,
      maxRedirects: 1,
      connectTimeoutMs: 500,
      readTimeoutMs: 100,
    },
  });
  const entries = await crawlSitemap(`${url}/sitemap.xml`, url, policy, web);
  const source = websiteSource({
    entries,
    fetchBody: (entry) => guardedFetchBytes(entry.loc, policy, policy.maxMarkdownBytes, web),
  });
  const engine = memoryEngine();
  const dataset = { id: 'website', filters: {}, options: {} };
  const writer = engine.writer.connect(
    { options: {}, timeoutMs: 1000 },
    { signal: new AbortController().signal },
  );
  const promote = vi.spyOn(writer, 'promote');
  const run = (
    extra: Partial<Pick<IngestOptions, 'maxDocumentFailures' | 'onDocument' | 'parallelism'>> = {},
  ) =>
    runIndexIngest({
      source,
      chunking: {
        strategy: { kind: 'header-based' },
        minimumLength: 1,
        maximumLength: 4000,
        metadataStyle: 'pr',
      },
      target: { needs: { vectors: false }, dataset, writer, generation: 'new' },
      ...extra,
    });
  return { url, run, writer, dataset, promote, policy };
};

const good = (res: ServerResponse) => res.end('# Working page\n\nUseful content.');
const status = (code: number) => (res: ServerResponse) => {
  res.writeHead(code);
  res.end();
};

describe('website page failure rules through guarded HTTP and the ingest pipeline', () => {
  it.each([404, 410])(
    'skips HTTP %s without spending the budget and stores the other pages',
    async (code) => {
      const { url, run, writer, dataset } = await setup({
        '/a.md': good,
        '/missing.md': status(code),
        '/b.md': good,
      });
      const result = await run({ maxDocumentFailures: 1 });
      expect(result).toMatchObject({
        stored: 2,
        skipped: 1,
        failed: [],
        promoted: true,
        skippedDocuments: [{ document: `${url}/missing.md`, reason: 'not_found' }],
      });
      expect((await writer.stats(dataset, 'new')).documents).toBe(2);
    },
  );

  it.each([
    ['HTTP 500', status(500), /HTTP 500/],
    [
      'timeout',
      (res: ServerResponse) => {
        res.write('partial');
      },
      /timeout|abort/i,
    ],
    ['oversize body', (res: ServerResponse) => res.end('x'.repeat(101)), /size limit/],
    [
      'redirect limit',
      (res: ServerResponse) => {
        res.writeHead(302, { location: '/bad.md' });
        res.end();
      },
      /Too many redirects/,
    ],
    ['missing redirect location', status(302), /without a location/],
    ['connection reset', (res: ServerResponse) => res.destroy(), /fetch failed|terminated/],
  ] as const)(
    'counts %s as a document failure and continues below the budget',
    async (_rule, broken, reason) => {
      const { url, run } = await setup({ '/a.md': good, '/bad.md': broken, '/b.md': good });
      const events: unknown[] = [];
      const result = await run({
        maxDocumentFailures: 2,
        onDocument: (event) => {
          events.push(event);
        },
      });
      expect(result).toMatchObject({ stored: 2, skipped: 0, promoted: true });
      expect(result.failed).toHaveLength(1);
      expect(result.failedDocuments).toEqual([
        { document: `${url}/bad.md`, reason: expect.stringMatching(reason) },
      ]);
      expect(events).toContainEqual(
        expect.objectContaining({ status: 'failed', error: expect.any(Error) }),
      );
    },
  );

  it('fails at the failure budget and promotes nothing, even after storing a good page', async () => {
    const { run, promote, writer, dataset } = await setup({
      '/a.md': good,
      '/bad.md': status(500),
      '/b.md': good,
    });
    await expect(run({ maxDocumentFailures: 1 })).rejects.toThrow(/1 documents failed/);
    expect((await writer.stats(dataset, 'new')).documents).toBe(1);
    expect(promote).not.toHaveBeenCalled();
    expect(await writer.active(dataset)).toBeUndefined();
  });

  it.each(['private address', 'disallowed host'])(
    'fails the run for a redirect to a %s regardless of the budget',
    async (rule) => {
      const { run, promote, policy } = await setup({
        '/a.md': good,
        '/bad.md': (res) => {
          res.writeHead(302, {
            location:
              rule === 'private address'
                ? 'https://127.0.0.1/private.md'
                : 'https://other.example.test/private.md',
          });
          res.end();
        },
      });
      policy.allowedHosts.add('127.0.0.1');
      await expect(run({ maxDocumentFailures: 100 })).rejects.toThrow(
        /not allowed|private or reserved/,
      );
      expect(promote).not.toHaveBeenCalled();
    },
  );
});
