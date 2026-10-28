import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localWebsite } from '../../../scripts/test-website.js';
import {
  crawlSitemap,
  documentId,
  guardedFetchBytes,
  runIngest,
  websiteFetchPolicy,
  websiteSource,
  type WebsiteSourceOptions,
} from './index.js';

let site: Awaited<ReturnType<typeof localWebsite>>;
beforeEach(async () => {
  site = await localWebsite();
});
afterEach(async () => {
  await site?.close();
});

const ingest = async (
  root: string,
  paths: string[],
  options: Partial<WebsiteSourceOptions> = {},
  relativeStorage = true,
) => {
  const sitemap = `${root}sitemap.xml`;
  site.pages.set(
    sitemap,
    `<urlset>${paths.map((path) => `<url><loc>${root}${path}</loc></url>`).join('')}</urlset>`,
  );
  for (const path of paths)
    site.pages.set(`${root}${path}`, '# Authorization\n\nA public guide to authorization.');
  const policy = websiteFetchPolicy({ sitemapUrl: sitemap, baseUrl: root });
  const entries = await crawlSitemap(sitemap, root, policy, site.web);
  const stored: { doc: Record<string, unknown>; chunks: Record<string, unknown>[] }[] = [];
  const report = await runIngest({
    source: websiteSource({
      entries,
      ...(relativeStorage ? { baseUrl: root } : {}),
      fetchBody: (entry) => guardedFetchBytes(entry.loc, policy, policy.maxMarkdownBytes, site.web),
      ...options,
    }),
    chunking: {
      strategy: { kind: 'header-based' },
      minimumLength: 1,
      maximumLength: 4000,
      metadataStyle: 'pr',
    },
    collections: { docs: 'd', chunks: 'c', phrases: 'p' },
    sink: {
      ensureCollections: async () => {},
      storeDocument: async (_names, _id, doc, chunks) => {
        stored.push({ doc, chunks });
      },
    },
  });
  expect(report).toMatchObject({ stored: paths.length, failed: [] });
  return stored;
};

describe('website citation storage', () => {
  it('stores the absolute citation URL on documents and every chunk without fetching the cited host', async () => {
    const url = 'https://public.example.test/manual/en/authorization.md';
    const [stored] = await ingest(site.mirror, ['en/authorization.md'], {
      cite: {
        baseUrl: 'https://public.example.test/manual/',
        fetchBaseUrl: site.mirror,
        dropIndexMd: false,
      },
    });
    expect(stored?.doc.url).toBe(url);
    expect(stored?.doc.id).toBe(documentId(url));
    expect(stored?.doc.language).toBe('en');
    expect(stored?.chunks.length).toBeGreaterThan(0);
    for (const chunk of stored?.chunks ?? []) expect(chunk.url).toBe(url);
    expect(site.requests).toEqual([
      `${site.mirror}sitemap.xml`,
      `${site.mirror}en/authorization.md`,
    ]);
  });

  it('drops index.md and maps other Markdown files to trailing-slash pages', async () => {
    const paths = ['index.md', 'en/authorization/index.md', 'nb/guide.md'];
    const stored = await ingest(site.mirror, paths, {
      cite: {
        baseUrl: 'https://docs.altinn.studio/',
        fetchBaseUrl: site.mirror,
        dropIndexMd: true,
      },
    });
    const urls = [
      'https://docs.altinn.studio/',
      'https://docs.altinn.studio/en/authorization/',
      'https://docs.altinn.studio/nb/guide/',
    ];
    expect(stored.map((s) => s.doc.url)).toEqual(urls);
    stored.forEach((s, i) => {
      for (const chunk of s.chunks) expect(chunk.url).toBe(urls[i]);
    });
    expect(stored.map((s) => s.doc.language)).toEqual([null, 'en', 'nb']);
  });

  it('maps other Markdown files to .html pages with pageSuffix, and index.md still to its directory', async () => {
    const paths = ['index.md', 'docs/idporten/oidc_guide.md', 'resources/begrep/index.md'];
    const stored = await ingest(site.mirror, paths, {
      cite: {
        baseUrl: 'https://docs.digdir.no/',
        fetchBaseUrl: site.mirror,
        dropIndexMd: true,
        pageSuffix: '.html',
      },
    });
    const urls = [
      'https://docs.digdir.no/',
      'https://docs.digdir.no/docs/idporten/oidc_guide.html',
      'https://docs.digdir.no/resources/begrep/',
    ];
    expect(stored.map((s) => s.doc.url)).toEqual(urls);
    stored.forEach((s, i) => {
      for (const chunk of s.chunks) expect(chunk.url).toBe(urls[i]);
    });
  });

  it('keeps document and chunk ids stable when switching from mirror to the real host', async () => {
    const cite = { baseUrl: site.real, fetchBaseUrl: site.mirror, dropIndexMd: true };
    const mirror = await ingest(site.mirror, ['en/authorization/index.md'], { cite });
    const real = await ingest(site.real, ['en/authorization/index.md'], {
      cite: { ...cite, fetchBaseUrl: site.real },
    });
    expect(mirror).toEqual(real);
    expect(mirror[0]?.doc.id).toBe(documentId(`${site.real}en/authorization/`));
  });

  it('without cite preserves relative storage and ids hashed from the absolute fetch URL', async () => {
    const [stored] = await ingest(site.mirror, ['en/authorization/index.md']);
    expect(stored?.doc.url).toBe('en/authorization/index.md');
    expect(stored?.doc.id).toBe(documentId(`${site.mirror}en/authorization/index.md`));
    expect(stored?.doc.language).toBeNull();
    for (const chunk of stored?.chunks ?? []) expect(chunk.url).toBe('en/authorization/index.md');
    const [absolute] = await ingest(site.real, ['nb/guide.md'], {}, false);
    expect(absolute?.doc.url).toBe(`${site.real}nb/guide.md`);
    expect(absolute?.doc.id).toBe(documentId(`${site.real}nb/guide.md`));
    expect(absolute?.doc.language).toBe('nb');
  });
});
