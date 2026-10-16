import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatResult, ModelPort } from '@genai/port-model';
import {
  blockedAddress,
  concernedYears,
  crawlSitemap,
  documentId,
  fillInKudosFields,
  findFolderFiles,
  folderSource,
  generatePhrases,
  guardedFetchText,
  kudosClient,
  memoryPhraseCache,
  mergeFrontmatter,
  pathToDoc,
  prepareKudosDoc,
  runIngest,
  urlToDoc,
  websiteFetchPolicy,
  type IndexSink,
  type IngestSource,
  type KudosProfile,
} from './index.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('kudos client', () => {
  const profile: KudosProfile = {
    name: 'preprod',
    baseUrl: 'https://kudos-preprod.example.no',
    listPath: '/api/v0/documents',
    documentPath: '/api/v0/documents',
    retryDelaysMs: [1, 2],
  };

  it('pages until the last page and retries a failing request before giving up', async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    let flaky = 0;
    const client = kudosClient({
      profile,
      sleep: async (ms) => void sleeps.push(ms),
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith('page=2') && flaky++ < 2) return json({}, 503);
        const n = Number(url.split('page=')[1]);
        return json({ data: [{ id: n }], meta: { current_page: n, last_page: 3 } });
      },
    });

    const ids: number[] = [];
    for await (const doc of client.documents()) ids.push(Number(doc.id));

    expect(ids).toEqual([1, 2, 3]);
    expect(sleeps).toEqual([1, 2]);
    expect(
      calls.every((c) => c.startsWith('https://kudos-preprod.example.no/api/v0/documents?page=')),
    ).toBe(true);
  });

  it('stops the run with the page number when a list page still fails after the retries, instead of skipping it', async () => {
    const client = kudosClient({
      profile: { ...profile, retryDelaysMs: [] },
      fetch: async (input) => {
        const n = Number(String(input).split('page=')[1]);
        return n === 1
          ? json({ data: [{ id: 1 }], meta: { current_page: 1, last_page: 9 } })
          : json({}, 500);
      },
    });

    const ids: unknown[] = [];
    await expect(async () => {
      for await (const doc of client.documents()) ids.push(doc.id);
    }).rejects.toThrow(/Kudos preprod list page 2 could not be read/);
    expect(ids).toEqual([1]);
  });
});

describe('kudos documents', () => {
  it('derives concerned years from a range, a single bound or the legacy year', () => {
    expect(concernedYears({ id: 1, concerned_year_from: 2022, concerned_year_to: 2024 })).toEqual([
      2022, 2023, 2024,
    ]);
    expect(concernedYears({ id: 1, concerned_year_to: 2024 })).toEqual([2024]);
    expect(concernedYears({ id: 1, concerned_year: 2020 })).toEqual([2020]);
    expect(concernedYears({ id: 1 })).toEqual([]);
  });

  it('keeps only stored fields, deduplicates display names and hashes, and drops local file paths', () => {
    const doc = prepareKudosDoc(
      {
        ...fillInKudosFields({
          id: 7,
          title: 'Årsrapport',
          owners: [
            {
              alternative_names: [
                { name: 'Digdir', type: 'display' },
                { name: 'DD', type: 'short' },
              ],
            },
          ],
          recipients: [{ alternative_names: [{ name: 'Digdir', type: 'display' }] }],
          files: [
            { url: 'u1', sha256: 'h', path: '/tmp/a.pdf' },
            { url: 'u2', sha256: 'h' },
          ],
        }),
        internal_only: true,
      },
      3,
    );

    expect(doc).toEqual({
      id: '7',
      doc_num: '7',
      title: 'Årsrapport',
      orgs_long: ['Digdir'],
      files: [
        { url: 'u1', sha256: 'h' },
        { url: 'u2', sha256: 'h' },
      ],
      file_sha256: ['h'],
      concerned_years: [],
      total_chunks: 3,
    });
  });
});

describe('website loader', () => {
  const policy = websiteFetchPolicy({
    baseUrl: 'https://docs.example.no/',
    sitemapUrl: 'sitemap.xml',
  });
  const resolve = async (host: string) =>
    host === 'docs.example.no' ? ['93.184.216.34'] : ['10.0.0.5'];

  it('blocks private, loopback, link-local and mapped addresses', () => {
    for (const ip of [
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '192.168.1.1',
      '::1',
      'fd00::1',
      '::ffff:10.0.0.1',
    ])
      expect(blockedAddress(ip), ip).toBe(true);
    expect(blockedAddress('93.184.216.34')).toBe(false);
  });

  it('refuses hosts outside the allowlist and redirects that lead to them', async () => {
    const fetchRedirect = async () =>
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/x' } });
    await expect(
      guardedFetchText('https://evil.example/', policy, 100, { resolve }),
    ).rejects.toThrow(/not allowed/);
    await expect(
      guardedFetchText('https://docs.example.no/a.md', policy, 100, {
        resolve,
        fetch: fetchRedirect,
      }),
    ).rejects.toThrow(/not allowed/);
    const open = { ...policy, allowedHosts: new Set<string>() };
    await expect(
      guardedFetchText('https://docs.example.no/a.md', open, 100, {
        resolve,
        fetch: fetchRedirect,
      }),
    ).rejects.toThrow(/private or reserved/);
  });

  it('stops reading a response over the size limit', async () => {
    const big = async () => new Response('x'.repeat(200));
    await expect(
      guardedFetchText('https://docs.example.no/a.md', policy, 100, { resolve, fetch: big }),
    ).rejects.toThrow(/size limit/);
  });

  it('walks sitemap indexes and keeps markdown entries unless HTML is asked for', async () => {
    const pages: Record<string, string> = {
      'https://docs.example.no/sitemap.xml':
        '<sitemapindex><sitemap><loc>https://docs.example.no/a.xml</loc></sitemap></sitemapindex>',
      'https://docs.example.no/a.xml':
        '<urlset><url><loc>nb/om-oss.md</loc><lastmod>2025-01-01</lastmod></url><url><loc>nb/side</loc></url></urlset>',
    };
    const fetchPage = async (input: string | URL | Request) =>
      new Response(pages[String(input)] ?? '', { status: 200 });

    const entries = await crawlSitemap('sitemap.xml', 'https://docs.example.no/', policy, {
      resolve,
      fetch: fetchPage,
    });
    const all = await crawlSitemap('sitemap.xml', 'https://docs.example.no/', policy, {
      resolve,
      fetch: fetchPage,
      includeHtml: true,
    });

    expect(entries).toEqual([
      { loc: 'https://docs.example.no/nb/om-oss.md', lastmod: '2025-01-01' },
    ]);
    expect(all).toHaveLength(2);
    expect(urlToDoc(entries[0] as { loc: string })).toMatchObject({
      id: documentId('https://docs.example.no/nb/om-oss.md'),
      title: 'Om oss',
      language: 'nb',
      type: 'website',
    });
  });

  it('merges frontmatter titles and strips the diataxis prefix', () => {
    const markdown =
      '---\ntitle: Kom i gang\nlinktitle: Start\ndiataxis: diataxis_tutorial\n---\n# Hei\n';
    expect(mergeFrontmatter({ id: 'x' }, markdown)).toEqual({
      id: 'x',
      linktitle: 'Start',
      frontmatter_title: 'Kom i gang',
      diataxis: 'tutorial',
    });
  });
});

describe('folder loader', () => {
  it('finds supported files in sorted order and titles them from the file name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ingest-folder-'));
    try {
      await mkdir(join(root, 'b'));
      await writeFile(join(root, 'b', 'vei_til-maal.md'), '# x');
      await writeFile(join(root, 'a.html'), '<p>x</p>');
      await writeFile(join(root, 'skip.pdf'), 'x');

      const files = await findFolderFiles(root);

      expect(files.map((f) => f.path)).toEqual([
        join(root, 'a.html'),
        join(root, 'b', 'vei_til-maal.md'),
      ]);
      expect(pathToDoc(files[1] as { path: string; lastmod: string })).toMatchObject({
        id: documentId(join(root, 'b', 'vei_til-maal.md')),
        title: 'Vei til maal',
        type: 'folder',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('links a folder document to its file with the extension kept and titles it by its first heading', async () => {
    const files: Record<string, string> = {
      '/repo/docs/adr/0033-locked.md': 'Intro.\n\n# 0033 Locked test environment\n\n## Why\n',
      '/repo/notes.md': 'No heading here.',
    };
    const source = folderSource({
      entries: Object.keys(files).map((path) => ({ path, lastmod: '1' })),
      basePath: '/repo/',
      baseUrl: 'https://github.com/digdir/genki/blob/main/',
      keepExtension: true,
      titleFrom: 'heading',
      read: async (path) => files[path] ?? '',
    });
    const stored = [];
    for await (const document of source.documents()) stored.push(document.stored([]));

    expect(stored).toMatchObject([
      {
        title: '0033 Locked test environment',
        path: 'docs/adr/0033-locked.md',
        url: 'https://github.com/digdir/genki/blob/main/docs/adr/0033-locked.md',
      },
      { title: 'Notes', url: 'https://github.com/digdir/genki/blob/main/notes.md' },
    ]);
  });

  it('drops .md from folder links unless told to keep it', async () => {
    const source = folderSource({
      entries: [{ path: '/site/guide/start.md', lastmod: '1' }],
      basePath: '/site/',
      baseUrl: 'https://www.example.no/',
      read: async () => '# Start',
    });
    for await (const document of source.documents())
      expect(document.stored([])).toMatchObject({
        title: 'Start',
        url: 'https://www.example.no/guide/start',
      });
  });
});

const reply = (content: string, finishReason: ChatResult['finishReason'] = 'stop'): ChatResult => ({
  content,
  toolCalls: [],
  finishReason,
  usage: { inputTokens: 1, outputTokens: 1, requests: 1 },
  servedModel: 'stub',
});

const model = (answer: () => Promise<ChatResult>, prompts: string[] = []): ModelPort => ({
  info: () => ({ id: 'stub', residency: 'norway', capabilities: [] }),
  chat: async (request) => {
    prompts.push(request.messages[0]?.content ?? '');
    return answer();
  },
  chatStream: async function* () {
    yield* [];
  },
});

describe('phrase generation', () => {
  it('fills the prompt, caches found phrases and answers the next call from the cache', async () => {
    const prompts: string[] = [];
    const cache = memoryPhraseCache();
    const primary = model(async () => reply('{"phrases":["a b","c d"]}'), prompts);
    const options = { prompt: 'Lag fraser:\nREPLACE_ME', identity: 'stub', cache };

    expect(await generatePhrases(primary, 'innhold', options)).toEqual(['a b', 'c d']);
    expect(await generatePhrases(primary, 'innhold', options)).toEqual(['a b', 'c d']);
    expect(prompts).toEqual(['Lag fraser:\ninnhold']);
  });

  it('uses the fallback when the primary fails, and does not cache an empty fallback answer', async () => {
    const cache = memoryPhraseCache();
    const prompts: string[] = [];
    const failing = model(async () => {
      throw new Error('down');
    });
    const fallback = model(async () => reply('{"phrases":[]}'), prompts);
    const options = { prompt: 'REPLACE_ME', identity: 'stub', cache, fallback };

    expect(await generatePhrases(failing, 'x', options)).toEqual([]);
    expect(await generatePhrases(failing, 'x', options)).toEqual([]);
    expect(prompts).toHaveLength(2);
  });

  it('caches an empty answer only when the primary finished normally', async () => {
    const prompts: string[] = [];
    const cache = memoryPhraseCache();
    const truncated = model(async () => reply('', 'length'), prompts);
    const finished = model(async () => reply('{"phrases":[]}'), prompts);

    await generatePhrases(truncated, 'x', { prompt: 'REPLACE_ME', identity: 'a', cache });
    await generatePhrases(truncated, 'x', { prompt: 'REPLACE_ME', identity: 'a', cache });
    await generatePhrases(finished, 'x', { prompt: 'REPLACE_ME', identity: 'b', cache });
    await generatePhrases(finished, 'x', { prompt: 'REPLACE_ME', identity: 'b', cache });

    expect(prompts).toHaveLength(3);
  });
});

describe('ingest run', () => {
  const source = (keys: string[], broken: Set<string> = new Set()): IngestSource => ({
    kind: 'folder',
    phraseRows: 'pipeline',
    documents: async function* () {
      for (const key of keys)
        yield {
          key,
          docNum: key,
          texts: ['# Tittel\n\nNoe tekst her.'],
          stored: () => {
            if (broken.has(key)) throw new Error('broken');
            return { id: key };
          },
          storedChunks: (chunks) => chunks.map((c) => ({ id: c.chunk_id })),
        };
    },
  });
  const sink = (): IndexSink & { stored: string[] } => {
    const stored: string[] = [];
    return {
      stored,
      ensureCollections: async () => {},
      storeDocument: async (_n, docNum) => void stored.push(docNum),
    };
  };
  const base = {
    chunking: {
      strategy: { kind: 'header-based' as const },
      minimumLength: 1,
      maximumLength: 1000,
      metadataStyle: 'pr' as const,
    },
    collections: { docs: 'd', chunks: 'c', phrases: 'p' },
  };

  it('skips documents already done and records new ones in the done set', async () => {
    const done = new Set(['a']);
    const target = sink();

    const result = await runIngest({ ...base, source: source(['a', 'b']), sink: target, done });

    expect(result).toEqual({ stored: 1, skipped: 1, failed: [] });
    expect(target.stored).toEqual(['b']);
    expect([...done]).toEqual(['a', 'b']);
  });

  it('carries on past failing documents and stops once the failure limit is reached', async () => {
    const tolerant = await runIngest({
      ...base,
      source: source(['a', 'b', 'c'], new Set(['b'])),
      sink: sink(),
    });
    expect(tolerant).toEqual({ stored: 2, skipped: 0, failed: ['b'] });

    await expect(
      runIngest({
        ...base,
        source: source(['a', 'b', 'c'], new Set(['a', 'b'])),
        sink: sink(),
        maxDocumentFailures: 2,
      }),
    ).rejects.toThrow(/2 documents failed/);
  });
});
