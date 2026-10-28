import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { documentId } from '@genai/ingest';
import { envSecrets } from '@genai/kernel';
import { IndexWriterRouter, type IndexDocument } from '@genai/port-knowledge';
import { memoryEngine } from '@genai/port-knowledge/testing';
import { localWebsite } from '../../../scripts/test-website.js';
import { indexIngestionBackend } from './index-ingestion.js';
import { pipelineSpec } from './ingestion.js';
import { translateMessage } from './i18n/index.js';

let site: Awaited<ReturnType<typeof localWebsite>>;

const setup = () => {
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
  const backend = indexIngestionBackend({
    writers,
    residencyOf: () => 'norway',
    platformTenant: 'tenant',
    web: site.web,
  });
  const signal = new AbortController().signal;
  return async (source: unknown) => {
    const report = await backend.run(
      {
        execution: 'citation-test',
        pipeline: {
          dataset: 'tenant/docs',
          id: 'docs',
          version: 1,
          spec: pipelineSpec.parse({ name: 'Docs', source, chunking: { minimumLength: 1 } }),
          by: 'test',
          at: '2026-10-28T00:00:00.000Z',
          reason: 'test',
        },
        target: { dataset: 'tenant/docs', endpoint: 'local', collections: {} },
      },
      signal,
    );
    const route = writers.open('tenant/docs', { signal });
    const docs: IndexDocument[] = [];
    if (!route.writer.read) throw new Error('fixture needs a readable writer');
    for await (const doc of route.writer.read(route.dataset)) docs.push(doc);
    return { report, docs };
  };
};

const list = (sitemap: string, urls: string[]) => {
  site.pages.set(
    sitemap,
    `<urlset>${urls.map((url) => `<url><loc>${url}</loc></url>`).join('')}</urlset>`,
  );
  for (const url of urls) site.pages.set(url, '# Authorization\n\nA public authorization guide.');
};

describe('website pipeline citation rules', () => {
  beforeEach(async () => {
    site = await localWebsite();
  });
  afterEach(async () => {
    await site?.close();
  });
  it('matches include and exclude against the mirror-root-relative fetch path and derives language there', async () => {
    const sitemap = `${site.mirror}sitemap.xml`;
    list(
      sitemap,
      ['en/authorization/index.md', 'en/private/index.md', 'nb/guide.md', 'other/en/guide.md'].map(
        (path) => `${site.mirror}${path}`,
      ),
    );
    const { report, docs } = await setup()({
      kind: 'website',
      sitemap,
      include: ['en/**', 'nb/**'],
      exclude: ['en/private/**'],
      cite: { baseUrl: 'https://public.example.test/handbook/', dropIndexMd: true },
    });
    expect(report).toMatchObject({ stored: 2, failed: [] });
    expect(docs.map((doc) => doc.url)).toEqual([
      'https://public.example.test/handbook/en/authorization/',
      'https://public.example.test/handbook/nb/guide/',
    ]);
    expect(docs.map((doc) => doc.fields.language)).toEqual(['en', 'nb']);
    expect(docs.map((doc) => doc.id)).toEqual(docs.map((doc) => documentId(String(doc.url))));
    for (const doc of docs) {
      expect(doc.chunks.length).toBeGreaterThan(0);
      for (const chunk of doc.chunks) expect(chunk.metadata?.url).toBe(doc.url);
    }
    expect(site.requests).toEqual([
      sitemap,
      `${site.mirror}en/authorization/index.md`,
      `${site.mirror}nb/guide.md`,
    ]);
  });

  it('uses explicit fetchBaseUrl when the sitemap lives in another directory', async () => {
    const sitemap = `${site.mirror}sitemaps/markdown.xml`;
    list(sitemap, [`${site.mirror}en/guide.md`]);
    const result = setup()({
      kind: 'website',
      sitemap,
      include: ['en/*.md'],
      cite: { baseUrl: 'https://docs.altinn.studio/', fetchBaseUrl: site.mirror },
    });
    await expect(result).resolves.toMatchObject({
      report: { stored: 1 },
      docs: [{ url: 'https://docs.altinn.studio/en/guide.md' }],
    });
  });

  it('keeps ids when the API pipeline switches from a prefixed mirror to the real host', async () => {
    const run = setup();
    const cite = { baseUrl: site.real, dropIndexMd: true };
    const ingest = async (root: string) => {
      const sitemap = `${root}sitemap.xml`;
      list(sitemap, [`${root}en/authorization/index.md`]);
      return run({ kind: 'website', sitemap, cite });
    };
    const mirror = await ingest(site.mirror);
    const real = await ingest(site.real);
    expect(mirror.report.stored).toBe(1);
    expect(real.report.stored).toBe(1);
    const identities = (docs: IndexDocument[]) =>
      docs.map((doc) => ({
        id: doc.id,
        url: doc.url,
        chunks: doc.chunks.map((chunk) => chunk.id),
      }));
    expect(identities(mirror.docs)).toEqual(identities(real.docs));
    expect(real.docs[0]?.id).toBe(documentId(`${site.real}en/authorization/`));
  });

  it('without cite keeps full fetch-path globs, relative URLs and fetch-URL ids', async () => {
    const sitemap = `${site.mirror}sitemap.xml`;
    list(sitemap, [`${site.mirror}en/guide.md`, `${site.mirror}nb/guide.md`]);
    const { docs, report } = await setup()({
      kind: 'website',
      sitemap,
      baseUrl: site.mirror,
      include: ['/altinn-studio-docs/en/**'],
    });
    expect(report.stored).toBe(1);
    expect(docs[0]?.url).toBe('en/guide.md');
    expect(docs[0]?.id).toBe(documentId(`${site.mirror}en/guide.md`));
    expect(docs[0]?.fields).not.toHaveProperty('language');
    expect(docs[0]?.chunks[0]?.metadata?.url).toBe('en/guide.md');
  });

  it('does not grant fetch access to the cited host, including redirects', async () => {
    const sitemap = `${site.mirror}sitemap.xml`;
    const page = `${site.mirror}en/guide.md`;
    list(sitemap, [page]);
    site.redirects.set(page, `${site.real}en/guide.md`);
    await expect(
      setup()({ kind: 'website', sitemap, cite: { baseUrl: site.real } }),
    ).rejects.toThrow('Website fetch host is not allowed: docs.example.test');
    expect(site.requests).toEqual([sitemap, page]);
  });

  it.each(['en/guide.md', 'altinn-studio-docs-other/en/guide.md'])(
    'rejects a listed page outside the fetch root: %s',
    async (path) => {
      const sitemap = `${site.mirror}sitemap.xml`;
      list(sitemap, [`${new URL(site.mirror).origin}/${path}`]);
      await expect(
        setup()({ kind: 'website', sitemap, cite: { baseUrl: site.real } }),
      ).rejects.toThrow('outside the citation fetch root');
      expect(site.requests).toEqual([sitemap]);
    },
  );
});

describe('website citation validation', () => {
  it.each(['baseUrl', 'fetchBaseUrl'])(
    'requires %s to be an HTTPS directory without credentials, query or fragment',
    (field) => {
      for (const value of [
        'http://example.test/',
        'ftp://example.test/',
        'https://example.test/docs',
        'https://user:secret@example.test/',
        'https://example.test/?q=1',
        'https://example.test/#part',
        'https://example.test/?',
        'https://example.test/#',
        'not a URL',
      ]) {
        const result = pipelineSpec.safeParse({
          name: 'Docs',
          source: {
            kind: 'website',
            sitemap: 'https://mirror.example.test/sitemap.xml',
            cite: { baseUrl: 'https://docs.example.test/', [field]: value },
          },
        });
        expect(result.success, `${field}=${value}`).toBe(false);
        expect(
          result.error?.issues.some((issue) => issue.path.join('.') === `source.cite.${field}`),
        ).toBe(true);
      }
    },
  );

  it('rejects unknown citation fields and non-boolean dropIndexMd', () => {
    for (const extra of [{ dropIndexMd: 'true' }, { typo: true }, { baseUrl: undefined }])
      expect(
        pipelineSpec.safeParse({
          name: 'Docs',
          source: {
            kind: 'website',
            sitemap: 'https://mirror.example.test/sitemap.xml',
            cite: { baseUrl: 'https://docs.example.test/', ...extra },
          },
        }).success,
      ).toBe(false);
  });

  it('translates the directory validation error into Bokmål and English', () => {
    const result = pipelineSpec.safeParse({
      name: 'Docs',
      source: {
        kind: 'website',
        sitemap: 'https://mirror.example.test/sitemap.xml',
        cite: { baseUrl: 'https://docs.example.test/no-slash' },
      },
    });
    const message = result.error?.issues[0]?.message ?? '';
    expect(message).toBe(
      'Use an HTTPS directory URL ending in /, without credentials, query or fragment',
    );
    expect(translateMessage(message, 'nb')).toBe(
      'Bruk en HTTPS-mappeadresse som slutter med /, uten brukernavn, passord, spørring eller fragment',
    );
    expect(translateMessage(translateMessage(message, 'nb'), 'en')).toBe(message);
    expect(
      translateMessage(
        'Website URL is outside the citation fetch root: https://mirror.example.test/other.md',
        'nb',
      ),
    ).toBe(
      'Nettadressen er utenfor hentemappen for kildehenvisninger: https://mirror.example.test/other.md',
    );
  });
});
