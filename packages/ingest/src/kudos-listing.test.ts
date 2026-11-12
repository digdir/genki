import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConversionPending, onePage } from './converter.js';
import { storedConverter } from './stored-converter.js';
import { planRun, type ListedDocument, type Listing } from './document-records.js';
import { kudosRateLimiter } from './kudos-rate.js';
import { kudosClient, kudosProd, type KudosDocument } from './kudos.js';
import { knowledgeListingOf, pipelineSpec, type KudosAccess } from './pipeline-sources.js';

const signal = new AbortController().signal;
const scope = { tenant: '991825827', dataset: 'digdir/kudos', owner: 'digdir' };
const converter = { convert: async () => onePage('Tekst fra rapporten.') };

const spec = (source: Record<string, unknown>) =>
  pipelineSpec.parse({ name: 'Kudos', source: { kind: 'kudos', ...source } });

const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.7 ${text}`);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const doc = (n: number, fields: Partial<KudosDocument> = {}): KudosDocument => {
  const bytes = pdf(`dokument ${n}`);
  return {
    uuid: uuid(n),
    title: `Årsrapport ${n}`,
    type: 'Årsrapport',
    publish_date: `2021-0${(n % 9) + 1}-01`,
    files: [
      {
        uuid: `f${n}`,
        url: `https://kudos.dfo.no/dokument/${uuid(n)}/filer/f${n}.pdf`,
        sha256: sha(bytes),
        size: bytes.length,
        mimetype: 'application/pdf',
      },
    ],
    ...fields,
  };
};

interface FakeKudos {
  docs: KudosDocument[];
  /** The order a pass returns, by its sort; repeats and skips stand for KUDOS's unstable order. */
  order?: (docs: KudosDocument[], sort: string) => KudosDocument[];
  perPage?: number;
  status?: (url: URL, attempt: number) => Response | undefined;
  /** Leave `meta.total` out, as an older KUDOS did. */
  noTotal?: boolean;
}

const fakeKudos = (fake: FakeKudos) => {
  const calls: URL[] = [];
  const attempts = new Map<string, number>();
  const perPage = fake.perPage ?? 2;
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    const attempt = (attempts.get(url.href) ?? 0) + 1;
    attempts.set(url.href, attempt);
    const answered = fake.status?.(url, attempt);
    if (answered) return answered;
    const one = /^\/api\/v0\/documents\/([^/]+)$/.exec(url.pathname)?.[1];
    if (one) {
      const found = fake.docs.find((d) => d.uuid === one);
      return found ? Response.json(found) : new Response('{}', { status: 404 });
    }
    if (url.pathname === '/api/v0/documents') {
      const p = url.searchParams;
      const from = Number(p.get('published_year_from') ?? 0);
      const to = Number(p.get('published_year_to') ?? 9999);
      const matching = fake.docs.filter((d) => {
        const year = Number(String(d.publish_date).slice(0, 4));
        return (
          (!p.get('type') || d.type === p.get('type')) &&
          (!p.get('actor_name') ||
            (d.owners ?? []).some((o) =>
              (o.alternative_names ?? []).some(
                (n) => n.name.toLowerCase() === p.get('actor_name')?.toLowerCase(),
              ),
            )) &&
          year >= from &&
          year <= to
        );
      });
      const sort = p.get('sort') ?? 'newest';
      const ordered = fake.order ? fake.order(matching, sort) : matching;
      const page = Number(p.get('page') ?? 1);
      const last = Math.max(1, Math.ceil(ordered.length / perPage));
      return Response.json({
        data: ordered.slice((page - 1) * perPage, page * perPage),
        meta: {
          current_page: page,
          last_page: last,
          per_page: perPage,
          ...(fake.noTotal ? {} : { total: matching.length }),
        },
      });
    }
    const file = fake.docs.flatMap((d) => d.files ?? []).find((f) => f.url === url.href);
    if (file) return new Response(pdf(`dokument ${Number(file.uuid?.slice(1))}`));
    return new Response('', { status: 404 });
  }) as typeof globalThis.fetch;
  const access: KudosAccess = {
    fetch,
    sleep: async () => undefined,
    limiter: kudosRateLimiter({ sleep: async () => undefined }),
  };
  return { calls, access };
};

const all = async (listing: Listing) => {
  const out: ListedDocument[] = [];
  for await (const d of listing.documents()) out.push(d);
  return out;
};

const listingFor = (source: Record<string, unknown>, access: KudosAccess) =>
  knowledgeListingOf(spec(source), { kudos: access, converter }, scope, signal);

/** Newest first repeats the second document and skips the third; oldest first is whole. */
const unstable = (docs: KudosDocument[], sort: string) =>
  sort === 'newest' ? [docs[3], docs[1], docs[1], docs[0]].filter((d) => d !== undefined) : docs;

describe('a Kudos listing', () => {
  it("a Kudos document's id is kudos: and its UUID, and its url is its Kudos page", async () => {
    const { access } = fakeKudos({ docs: [doc(1)] });
    const listing = await listingFor({ types: ['Årsrapport'] }, access);
    const [listed] = await all(listing);

    expect(listed?.id).toBe(`kudos:${uuid(1)}`);
    const loaded = await listing.load(listed?.record ?? {});
    expect(loaded.key).toBe(`kudos:${uuid(1)}`);
    expect(loaded.url).toBe(`https://kudos.dfo.no/dokument/${uuid(1)}`);
  });

  it('a Kudos file is keyed by its KUDOS uuid with its sha256, and converts', async () => {
    const { access } = fakeKudos({ docs: [doc(1)] });
    const [listed] = await all(await listingFor({ types: ['Årsrapport'] }, access));

    expect(listed?.files).toEqual([
      { name: 'f1', sha256: doc(1).files?.[0]?.sha256, converts: true },
    ]);
  });

  it('a convert job fetches a Kudos file by the sha256 its record names', async () => {
    const { access } = fakeKudos({ docs: [doc(1)] });
    const listing = await listingFor({ types: ['Årsrapport'] }, access);
    const [listed] = await all(listing);
    const sha256 = doc(1).files?.[0]?.sha256 as string;

    const file = await listing.file?.(listed?.record ?? {}, sha256);
    expect(file).toMatchObject({ name: 'f1.pdf', mimetype: 'application/pdf' });
    expect(sha(file?.bytes ?? new Uint8Array())).toBe(sha256);
    await expect(listing.file?.(listed?.record ?? {}, 'c'.repeat(64))).rejects.toThrow(
      /no longer lists the file/,
    );
  });

  it("an index job reads a Kudos file's stored conversion without downloading it", async () => {
    const { access, calls } = fakeKudos({ docs: [doc(1), doc(2)] });
    const kept = doc(1).files?.[0]?.sha256 as string;
    const stored = storedConverter(
      { extensions: ['.pdf'] },
      {
        find: async (sha256) =>
          sha256 === kept
            ? {
                sha256,
                converter: 'text-layer',
                version: '1',
                settings: {},
                derivation: { name: 'text-layer', version: 1 },
                pages: ['Side en', 'Side to'],
              }
            : undefined,
      },
      [{ converter: 'text-layer', derivation: { name: 'text-layer', version: 1 } }],
    );
    const listing = await knowledgeListingOf(
      spec({ types: ['Årsrapport'] }),
      { kudos: access, converter: stored },
      scope,
      signal,
    );
    const [one, two] = await all(listing);

    const loaded = await listing.load(one?.record ?? {});
    expect(loaded.files).toEqual([{ name: 'f1.pdf', sha256: kept, pages: ['Side en', 'Side to'] }]);
    expect(calls.some((c) => c.pathname.endsWith('.pdf'))).toBe(false);
    await expect(listing.load(two?.record ?? {})).rejects.toBeInstanceOf(ConversionPending);
  });

  it('a Kudos listing asks KUDOS by type and publish year, 50 a page', async () => {
    const { access, calls } = fakeKudos({ docs: [doc(1)] });
    await all(
      await listingFor(
        { types: ['Årsrapport', 'Instruks'], since: '2020-03-01', until: '2024-06-30' },
        access,
      ),
    );

    const lists = calls.filter((c) => c.pathname === '/api/v0/documents');
    expect(lists.map((c) => c.searchParams.get('type'))).toEqual(['Årsrapport', 'Instruks']);
    for (const c of lists) {
      expect(c.searchParams.get('published_year_from')).toBe('2020');
      expect(c.searchParams.get('published_year_to')).toBe('2024');
      expect(c.searchParams.get('per_page')).toBe('50');
      expect(c.searchParams.get('query')).toBeNull();
    }
  });

  it('a Kudos pipeline with orgs lists each org by actor_name', async () => {
    const owned = (n: number, name: string) =>
      doc(n, { owners: [{ alternative_names: [{ name, type: 'display' }] }] });
    const { access, calls } = fakeKudos({ docs: [owned(1, 'Digdir'), owned(2, 'NAV')] });
    const listed = await all(
      await listingFor({ types: ['Årsrapport'], orgs: ['Digdir', 'Skatteetaten'] }, access),
    );

    expect(
      calls
        .filter((c) => c.pathname === '/api/v0/documents')
        .map((c) => c.searchParams.get('actor_name')),
    ).toEqual(['Digdir', 'Skatteetaten']);
    expect(listed.map((d) => d.id)).toEqual([`kudos:${uuid(1)}`]);
  });

  it('a Kudos listing is complete only when every page came back and its distinct UUIDs reach meta.total', async () => {
    const docs = [1, 2, 3, 4].map((n) => doc(n));
    const repeating = fakeKudos({
      docs,
      order: (d) => [d[0], d[1], d[1], d[3]].filter((x) => x !== undefined),
    });
    const short = await listingFor({ types: ['Årsrapport'] }, repeating.access);
    expect(await all(short)).toHaveLength(3);
    expect(short.complete()).toBe(false);

    const whole = await listingFor({ types: ['Årsrapport'] }, fakeKudos({ docs }).access);
    expect(await all(whole)).toHaveLength(4);
    expect(whole.complete()).toBe(true);

    const failing = fakeKudos({
      docs,
      status: (url) =>
        url.searchParams.get('page') === '2' ? new Response('{}', { status: 500 }) : undefined,
    });
    const broken = await listingFor(
      { types: ['Årsrapport'] },
      { ...failing.access, profiles: { prod: { ...kudosProd, retryDelaysMs: [] } } },
    );
    await expect(all(broken)).rejects.toThrow(/could not be read/);
    expect(broken.complete()).toBe(false);
  });

  it('a Kudos search that comes back short is walked again in the other order, up to three passes', async () => {
    const docs = [1, 2, 3, 4].map((n) => doc(n));
    const twice = fakeKudos({ docs, order: unstable });
    const listing = await listingFor({ types: ['Årsrapport'] }, twice.access);
    const listed = await all(listing);

    expect(listed.map((d) => d.id).sort()).toEqual(docs.map((d) => `kudos:${d.uuid}`).sort());
    expect(listing.complete()).toBe(true);
    expect(
      twice.calls
        .filter((c) => c.pathname === '/api/v0/documents' && c.searchParams.get('page') === '1')
        .map((c) => c.searchParams.get('sort')),
    ).toEqual(['newest', 'oldest']);

    const never = fakeKudos({
      docs,
      order: (d) => [d[0], d[1], d[1], d[3]].filter((x) => x !== undefined),
    });
    const short = await listingFor({ types: ['Årsrapport'] }, never.access);
    await all(short);
    expect(short.complete()).toBe(false);
    expect(
      never.calls.filter(
        (c) => c.pathname === '/api/v0/documents' && c.searchParams.get('page') === '1',
      ),
    ).toHaveLength(3);
  });

  it('a listed source deletes only after two complete listings, with a Kudos listing one short', async () => {
    const docs = [1, 2, 3, 4].map((n) => doc(n));
    const short = fakeKudos({
      docs,
      order: (d) => [d[0], d[1], d[1], d[3]].filter((x) => x !== undefined),
    });
    const listing = await listingFor({ types: ['Årsrapport'] }, short.access);
    const listed = await all(listing);
    const owned = docs.map((d, i) => ({
      number: String(i + 1),
      id: `kudos:${d.uuid}`,
      metadataHash: 'h',
      files: [],
      state: 'stored' as const,
      missing: 1,
      change: 1,
      applied: 1,
    }));

    const plan = planRun(listed, owned, { complete: listing.complete(), deletes: 'listed' });
    expect(plan.counts.deleted).toBe(0);
    expect(plan.writes.filter((w) => w.kind === 'delete' || w.kind === 'missing')).toEqual([]);
  });

  it('the Kudos client waits as long as Retry-After asks after a 429', async () => {
    const sleeps: number[] = [];
    let now = 0;
    const limiter = kudosRateLimiter({
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    let limited = 0;
    const client = kudosClient({
      profile: kudosProd,
      limiter,
      sleep: async () => {
        throw new Error('a 429 must not use the retry ladder');
      },
      fetch: async () =>
        limited++ === 0
          ? new Response('', { status: 429, headers: { 'retry-after': '30' } })
          : Response.json({ data: [], meta: { current_page: 1, last_page: 1, total: 0 } }),
    });

    await client.page(1, { type: 'Årsrapport' });
    expect(sleeps).toEqual([30_000]);
  });

  it('a Kudos file over the size limit is skipped as too_large', async () => {
    const big = doc(1);
    const file = big.files?.[0];
    if (!file) throw new Error('the test document has no file');
    const huge = doc(2, { files: [{ ...file, uuid: 'f2', size: 60 * 1024 * 1024 }] });
    const { access, calls } = fakeKudos({ docs: [huge] });
    const listing = await listingFor({ types: ['Årsrapport'] }, access);
    const [listed] = await all(listing);
    const loaded = await listing.load(listed?.record ?? {});

    expect(loaded.skip).toBe('too_large');
    expect(calls.filter((c) => c.pathname.includes('/filer/'))).toEqual([]);
  });

  it('a Kudos document whose readable file is too large is skipped as too_large, not no_text', async () => {
    const base = doc(3);
    const file = base.files?.[0];
    if (!file) throw new Error('the test document has no file');
    const mixed = doc(3, {
      files: [
        { ...file, uuid: 'f3', size: 60 * 1024 * 1024 },
        { ...file, uuid: 'f3b', url: `${file.url}?blank` },
      ],
    });
    const { access } = fakeKudos({
      docs: [mixed],
      status: (url) => (url.search === '?blank' ? new Response(pdf('dokument 3')) : undefined),
    });
    const listing = await knowledgeListingOf(
      spec({ types: ['Årsrapport'] }),
      { kudos: access, converter: { convert: async () => onePage('') } },
      scope,
      signal,
    );
    const [listed] = await all(listing);

    expect((await listing.load(listed?.record ?? {})).skip).toBe('too_large');
  });

  it('a Kudos pipeline lists only documents published between since and until', async () => {
    const docs = [
      doc(1, { publish_date: '2020-02-29' }),
      doc(2, { publish_date: '2020-03-01' }),
      doc(3, { publish_date: '2024-06-30' }),
      doc(4, { publish_date: '2024-07-01' }),
    ];
    const { access } = fakeKudos({ docs });
    const listing = await listingFor(
      { types: ['Årsrapport'], since: '2020-03-01', until: '2024-06-30' },
      access,
    );

    expect((await all(listing)).map((d) => d.id)).toEqual([`kudos:${uuid(2)}`, `kudos:${uuid(3)}`]);
    expect(listing.complete()).toBe(true);
  });

  it('a Kudos pipeline with documents lists only those UUIDs', async () => {
    const { access, calls } = fakeKudos({ docs: [1, 2, 3].map((n) => doc(n)) });
    const listing = await listingFor({ documents: [uuid(1), uuid(3), uuid(9)] }, access);

    expect((await all(listing)).map((d) => d.id)).toEqual([`kudos:${uuid(1)}`, `kudos:${uuid(3)}`]);
    expect(listing.complete()).toBe(true);
    expect(calls.some((c) => c.pathname === '/api/v0/documents')).toBe(false);
  });

  it('a Kudos pipeline refuses a document that is not a UUID', () => {
    const parsed = pipelineSpec.safeParse({
      name: 'Kudos',
      source: { kind: 'kudos', documents: [uuid(1), '377252'] },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['source', 'documents', 1]);
  });

  it('a Kudos search without meta.total is never complete', async () => {
    const docs = [1, 2, 3, 4].map((n) => doc(n));
    const { access, calls } = fakeKudos({ docs, noTotal: true });
    const listing = await listingFor({ types: ['Årsrapport'] }, access);

    expect(await all(listing)).toHaveLength(4);
    expect(listing.complete()).toBe(false);
    // Another pass cannot make it complete, so it is walked once.
    expect(calls.filter((c) => c.searchParams.get('page') === '1')).toHaveLength(1);
  });

  it('a Kudos listing from a later page walks once, from that page', async () => {
    const docs = [1, 2, 3, 4].map((n) => doc(n));
    const { access, calls } = fakeKudos({ docs });
    const listing = await listingFor({ types: ['Årsrapport'], startingPage: 2 }, access);

    expect((await all(listing)).map((d) => d.id)).toEqual([`kudos:${uuid(3)}`, `kudos:${uuid(4)}`]);
    expect(listing.complete()).toBe(false);
    expect(calls.filter((c) => c.searchParams.get('page') === '1')).toEqual([]);
  });

  it("a Kudos listing carries each document's earlier ids from the map", async () => {
    const { access } = fakeKudos({ docs: [doc(1), doc(2)] });
    const earlierIds = new Map([[`kudos:${uuid(1)}`, ['377252']]]);
    const listed = await all(
      await listingFor({ types: ['Årsrapport'] }, { ...access, earlierIds }),
    );

    expect(listed.map((d) => d.earlierIds)).toEqual([['377252'], undefined]);
  });

  it('a Kudos file download takes a turn from the limiter', async () => {
    const { access, calls } = fakeKudos({ docs: [doc(1)] });
    let turns = 0;
    const limiter = { take: async () => void turns++, pause: () => undefined };
    const listing = await listingFor({ types: ['Årsrapport'] }, { ...access, limiter });
    const [listed] = await all(listing);
    await listing.load(listed?.record ?? {});

    expect(calls.some((c) => c.pathname.includes('/filer/'))).toBe(true);
    expect(turns).toBe(calls.length);
  });

  it('a Kudos file download waits as long as Retry-After asks after a 429', async () => {
    const paused: number[] = [];
    const { access } = fakeKudos({
      docs: [doc(1)],
      status: (url, attempt) =>
        url.pathname.includes('/filer/') && attempt === 1
          ? new Response('', { status: 429, headers: { 'retry-after': '20' } })
          : undefined,
    });
    const limiter = { take: async () => undefined, pause: (ms: number) => void paused.push(ms) };
    const listing = await listingFor({ types: ['Årsrapport'] }, { ...access, limiter });
    const [listed] = await all(listing);
    const loaded = await listing.load(listed?.record ?? {});

    expect(paused).toEqual([20_000]);
    expect(loaded.skip).toBeUndefined();
    expect(loaded.texts).toEqual(['Tekst fra rapporten.']);
  });
});
