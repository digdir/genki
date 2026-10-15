import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocumentConverter } from '@genai/ingest';
import { mayUseModels } from '@genai/composition';
import type { Principal } from '@genai/contracts';
import { envSecrets } from '@genai/kernel';
import { InMemoryBlobStore } from '@genai/port-blob';
import { IndexWriterRouter, KnowledgeRouter } from '@genai/port-knowledge';
import { memoryEngine } from '@genai/port-knowledge/testing';
import {
  estimateKudos,
  indexIngestionBackend,
  kudosProfileFor,
  uploadPrefix,
} from './index-ingestion.js';
import { pipelineSpec, type IngestionJob } from './ingestion.js';

const engine = memoryEngine();
const writers = new IndexWriterRouter({
  catalog: {
    endpoints: { local: { engine: 'memory' } },
    datasets: [
      { id: 'testetaten/rapporter', endpoint: 'local', residency: 'norway' },
      { id: '991825827/opplastet', endpoint: 'local', residency: 'norway' },
    ],
  },
  adapters: [engine.writer],
  knowledgeAdapters: [engine.adapter],
  secrets: envSecrets({}),
});

const jobFor = (
  source: unknown,
  dataset = 'testetaten/rapporter',
  tenant?: string,
): IngestionJob => ({
  execution: 'x1',
  pipeline: {
    dataset,
    id: 'p1',
    version: 1,
    spec: pipelineSpec.parse({ name: 'Rapporter', source, chunking: { minimumLength: 1 } }),
    by: 'kari',
    at: '2026-10-07T10:00:00.000Z',
    reason: 'test',
  },
  target: { dataset, endpoint: 'local', collections: {} },
  ...(tenant ? { tenant } : {}),
});

const converted: string[] = [];
const converter: DocumentConverter = {
  toMarkdown: async (file) => {
    converted.push(file.name);
    return `# ${file.name}\n\nKonvertert tekst fra ${file.name}.`;
  },
};

const web = (pages: Record<string, string>) => ({
  resolve: async () => ['93.184.216.34'],
  fetch: (async (url: string | URL | Request) => {
    const body = pages[String(url)];
    if (body === undefined) return new Response('', { status: 404 });
    return String(url).endsWith('.pdf')
      ? new Response(body, { headers: { 'content-type': 'application/pdf' } })
      : new Response(body);
  }) as typeof fetch,
});

const storedDocs = async (dataset: string) => {
  const route = writers.open(dataset, { signal });
  const generation = await route.writer.active(route.dataset);
  return generation === undefined
    ? 0
    : (await route.writer.stats(route.dataset, generation)).documents;
};

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const signal = new AbortController().signal;

const pdfSha = createHash('sha256').update('%PDF-1.7').digest('hex');

describe('kudos profiles', () => {
  it('ships only the public Kudos host and reaches other profiles through configuration', () => {
    const preprod = {
      name: 'preprod' as const,
      baseUrl: 'https://kudos-preprod.example.no',
      listPath: '/api/v0/documents',
      documentPath: '/api/v0/documents',
      retryDelaysMs: [1],
    };

    expect(kudosProfileFor({}).baseUrl).toBe('https://kudos.dfo.no');
    expect(() => kudosProfileFor({}, 'preprod')).toThrow(/preprod is not configured/);
    expect(kudosProfileFor({ profiles: { preprod } }, 'preprod')).toBe(preprod);
  });
});

describe('index ingestion', () => {
  it('ingestion reports why each skipped document was skipped', async () => {
    root = await mkdtemp(join(tmpdir(), 'ingest-'));
    await mkdir(join(root, 'rapporter'));
    await writeFile(
      join(root, 'rapporter', 'veiledning.md'),
      '# Veiledning\n\nDigital veiledning.',
    );
    await writeFile(join(root, 'rapporter', 'skannet.md'), '   \n');
    await writeFile(join(root, 'rapporter', 'vedlegg.xlsx'), 'binary');
    const folder = indexIngestionBackend({
      writers,
      residencyOf: () => 'norway',
      folderRoot: root,
      platformTenant: 'digdir',
    });

    const fromFolder = await folder.run(
      jobFor({ kind: 'folder', path: 'rapporter', include: ['**/*'] }),
      signal,
    );

    expect(fromFolder).toMatchObject({ stored: 1, skipped: 2, failed: [] });
    expect(fromFolder.skippedDocuments).toEqual(
      expect.arrayContaining([
        { document: 'vedlegg.xlsx', reason: 'unsupported_type' },
        { document: 'skannet.md', reason: 'no_text' },
      ]),
    );

    const pages: Record<string, string> = {
      'https://www.example.no/sitemap.xml': `<urlset>${[
        'https://www.example.no/veiledning.md',
        'https://www.example.no/rapport.pdf',
        'https://annen.example.com/notat.md',
      ]
        .map((loc) => `<url><loc>${loc}</loc></url>`)
        .join('')}</urlset>`,
      'https://www.example.no/veiledning.md': '# Veiledning\n\nDigital veiledning.',
    };
    const website = indexIngestionBackend({
      writers,
      residencyOf: () => 'norway',
      platformTenant: 'digdir',
      web: {
        resolve: async () => ['93.184.216.34'],
        fetch: async (url) => {
          const body = pages[String(url)];
          return body === undefined ? new Response('', { status: 404 }) : new Response(body);
        },
      },
    });

    const fromWebsite = await website.run(
      jobFor({ kind: 'website', sitemap: 'https://www.example.no/sitemap.xml' }),
      signal,
    );

    expect(fromWebsite).toMatchObject({ stored: 1, skipped: 2, failed: [] });
    expect(fromWebsite.skippedDocuments).toEqual([
      { document: 'https://www.example.no/rapport.pdf', reason: 'unsupported_type' },
      { document: 'https://annen.example.com/notat.md', reason: 'outside_access' },
    ]);
  });

  it('converts PDF and DOCX from websites and folders when a converter is configured', async () => {
    root = await mkdtemp(join(tmpdir(), 'ingest-'));
    await mkdir(join(root, 'rapporter'));
    await writeFile(join(root, 'rapporter', 'arsrapport.docx'), 'docx-bytes');
    await writeFile(join(root, 'rapporter', 'vedlegg.xlsx'), 'binary');
    const folder = indexIngestionBackend({
      writers,
      residencyOf: () => 'norway',
      folderRoot: root,
      platformTenant: 'digdir',
      converter,
    });

    const fromFolder = await folder.run(
      jobFor({ kind: 'folder', path: 'rapporter', include: ['**/*'] }),
      signal,
    );

    expect(fromFolder).toMatchObject({ stored: 1, skipped: 1, failed: [] });
    expect(fromFolder.skippedDocuments).toEqual([
      { document: 'vedlegg.xlsx', reason: 'unsupported_type' },
    ]);

    const website = indexIngestionBackend({
      writers,
      residencyOf: () => 'norway',
      platformTenant: 'digdir',
      converter,
      web: web({
        'https://www.example.no/sitemap.xml':
          '<urlset><url><loc>https://www.example.no/rapport.pdf</loc></url></urlset>',
        'https://www.example.no/rapport.pdf': '%PDF-1.7',
      }),
    });

    const fromWebsite = await website.run(
      jobFor({ kind: 'website', sitemap: 'https://www.example.no/sitemap.xml' }),
      signal,
    );

    expect(fromWebsite).toMatchObject({ stored: 1, skipped: 0, failed: [] });
    expect(converted.splice(0)).toEqual([
      expect.stringMatching(/arsrapport\.docx$/),
      '/rapport.pdf',
    ]);
  });

  it('reads uploaded files from the dataset upload prefix of the tenant', async () => {
    const tenant = '991825827';
    const blobs = new InMemoryBlobStore();
    const prefix = uploadPrefix(`${tenant}/opplastet`, tenant);
    await blobs.put(
      { tenant, path: `${prefix}veileder.md` },
      new TextEncoder().encode('# Veileder\n\nSlik søker du.'),
      'text/markdown',
    );
    await blobs.put(
      { tenant, path: `${prefix}notat.pdf` },
      new Uint8Array([1, 2]),
      'application/pdf',
    );
    await blobs.put(
      { tenant, path: 'datasets/annet/uploads/annet.md' },
      new TextEncoder().encode('# Annet\n\nIkke dette datasettet.'),
      'text/markdown',
    );
    const backend = indexIngestionBackend({
      writers,
      residencyOf: () => 'norway',
      platformTenant: 'digdir',
      uploads: blobs,
      converter,
    });

    const report = await backend.run(
      jobFor({ kind: 'upload' }, `${tenant}/opplastet`, tenant),
      signal,
    );

    expect(prefix).toBe('datasets/opplastet/uploads/');
    expect(report).toMatchObject({ stored: 2, skipped: 0, failed: [] });
    expect(converted.splice(0)).toEqual(['notat.pdf']);
    expect(await storedDocs(`${tenant}/opplastet`)).toBe(2);
    expect(
      indexIngestionBackend({
        writers,
        residencyOf: () => 'norway',
        platformTenant: 'digdir',
      }).unavailableFor?.(jobFor({ kind: 'upload' }).target, jobFor({ kind: 'upload' }).pipeline),
    ).toBe('uploads are turned off on this platform');
  });

  it('stamps each stored document with the date of the ingestion run, so sources can show it', async () => {
    const tenant = '991825827';
    const blobs = new InMemoryBlobStore();
    await blobs.put(
      { tenant, path: `${uploadPrefix(`${tenant}/opplastet`, tenant)}frister.md` },
      new TextEncoder().encode('# Frister\n\nFristen for innsyn er tre virkedager.'),
      'text/markdown',
    );
    const before = new Date().toISOString();
    await indexIngestionBackend({
      writers,
      residencyOf: () => 'norway',
      platformTenant: 'digdir',
      uploads: blobs,
    }).run(jobFor({ kind: 'upload' }, `${tenant}/opplastet`, tenant), signal);

    const port = new KnowledgeRouter({
      catalog: {
        endpoints: { local: { engine: 'memory' } },
        datasets: [{ id: `${tenant}/opplastet`, endpoint: 'local', residency: 'norway' }],
      },
      adapters: [engine.adapter],
      secrets: envSecrets({}),
    }).open(
      { kind: 'dataset', id: `${tenant}/opplastet` },
      {
        tenant,
        principal: { kind: 'employee', issuer: 'test', subject: 'kari', tenant },
        task: 't1',
        signal,
        meter: async () => undefined,
      },
    );
    const found = await port.search({ query: 'innsyn', profile: port.info().profiles[0] ?? '' });
    const at = found.hits[0]?.fields.ingested_at;

    expect(typeof at).toBe('string');
    expect(String(at) >= before).toBe(true);
  });

  it.each([
    { admitted: true, rule: 'lets an ingestion run that lockdown admitted use its phrase model' },
    { admitted: false, rule: 'keeps the phrase model of an ingestion run nobody admitted locked' },
  ])('$rule', async ({ admitted }) => {
    const tenant = '991825827';
    const blobs = new InMemoryBlobStore();
    await blobs.put(
      { tenant, path: `${uploadPrefix(`${tenant}/opplastet`, tenant)}frister.md` },
      new TextEncoder().encode('# Frister\n\nFristen for innsyn er tre virkedager.'),
      'text/markdown',
    );
    const asked: Principal[] = [];
    const job = jobFor({ kind: 'upload' }, `${tenant}/opplastet`, tenant);
    job.pipeline.spec = pipelineSpec.parse({
      name: 'Rapporter',
      source: { kind: 'upload' },
      chunking: { minimumLength: 1 },
      phrases: { model: 'fake/gpt' },
    });

    await indexIngestionBackend({
      writers,
      residencyOf: () => 'norway',
      platformTenant: 'digdir',
      uploads: blobs,
      models: {
        open: (_ref, ctx) => {
          asked.push(ctx.principal);
          throw new Error('the environment is locked');
        },
      },
    })
      .run({ ...job, ...(admitted ? { admitted } : {}) }, signal)
      .catch(() => undefined);

    expect(asked.map(mayUseModels)).toEqual([admitted]);
  });

  it('ingests Kudos documents of the chosen types, since a date and from the chosen orgs', async () => {
    const owner = (name: string) => ({ alternative_names: [{ name, type: 'display' }] });
    const doc = (id: number, type: string, date: string, org: string) => ({
      id,
      title: `Dokument ${id}`,
      type,
      publish_date: date,
      owners: [owner(org)],
      files: [
        {
          url: `https://files.kudos.example/${id}.pdf`,
          mimetype: 'application/pdf',
          sha256: pdfSha,
        },
      ],
    });
    const pages: Record<string, unknown> = {
      'https://kudos.dfo.no/api/v0/documents/search?page=1&type=Tildelingsbrev&query=Digitaliseringsdirektoratet':
        {
          data: [
            doc(1, 'Tildelingsbrev', '2025-02-01', 'Digitaliseringsdirektoratet'),
            doc(2, 'Årsrapport', '2025-03-01', 'Digitaliseringsdirektoratet'),
          ],
          meta: { current_page: 1, last_page: 2 },
        },
      'https://kudos.dfo.no/api/v0/documents/search?page=2&type=Tildelingsbrev&query=Digitaliseringsdirektoratet':
        {
          data: [
            doc(3, 'Tildelingsbrev', '2020-01-01', 'Digitaliseringsdirektoratet'),
            doc(4, 'Tildelingsbrev', '2025-05-01', 'Skatteetaten'),
          ],
          meta: { current_page: 2, last_page: 2 },
        },
    };
    const fetched: string[] = [];
    const fake = (async (input: string | URL | Request) => {
      const url = String(input);
      fetched.push(url);
      if (url in pages) return Response.json(pages[url]);
      if (url.startsWith('https://files.kudos.example/')) return new Response('%PDF-1.7');
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const options = {
      writers,
      residencyOf: () => 'norway' as const,
      platformTenant: 'digdir',
      web: { resolve: async () => ['93.184.216.34'] },
      kudos: { fetch: fake, sleep: async () => undefined },
    };
    const source = {
      kind: 'kudos',
      types: ['Tildelingsbrev'],
      since: '2024-01-01',
      orgs: ['Digitaliseringsdirektoratet'],
    };

    expect(
      indexIngestionBackend(options).unavailableFor?.(
        jobFor(source).target,
        jobFor(source).pipeline,
      ),
    ).toMatch(/document converter/);
    const backend = indexIngestionBackend({ ...options, converter });
    const unbounded = jobFor({ kind: 'kudos' });
    expect(backend.unavailableFor?.(unbounded.target, unbounded.pipeline)).toMatch(/avgrenses/);

    const report = await backend.run(jobFor(source), signal);

    expect(report).toMatchObject({ stored: 1, failed: [] });
    expect(fetched.filter((u) => u.includes('/documents/search'))).toEqual([
      'https://kudos.dfo.no/api/v0/documents/search?page=1&type=Tildelingsbrev&query=Digitaliseringsdirektoratet',
      'https://kudos.dfo.no/api/v0/documents/search?page=2&type=Tildelingsbrev&query=Digitaliseringsdirektoratet',
    ]);
    expect(fetched.filter((u) => u.includes('files.kudos'))).toEqual([
      'https://files.kudos.example/1.pdf',
    ]);
  });

  it('estimates the Kudos documents a pipeline reads from the first list page', async () => {
    const fake = (async () =>
      Response.json({
        data: [
          { id: 1, type: 'Tildelingsbrev', publish_date: '2025-01-01' },
          { id: 2, type: 'Årsrapport', publish_date: '2025-01-01' },
          { id: 3, type: 'Tildelingsbrev', publish_date: '2019-01-01' },
          { id: 4, type: 'Tildelingsbrev', publish_date: '2024-06-01' },
        ],
        meta: { current_page: 1, last_page: 50 },
      })) as unknown as typeof fetch;

    expect(
      await estimateKudos({ fetch: fake }, { types: ['tildelingsbrev'], since: '2024-01-01' }),
    ).toEqual({ documents: 100, exact: false, basis: { listed: 200, sampled: 4, matching: 2 } });
  });
});
