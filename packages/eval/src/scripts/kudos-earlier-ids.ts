/**
 * Maps the numeric ids of today's Kudos index to KUDOS UUIDs (issue 144). Read-only: it reads the
 * index in Typesense and asks kudos.dfo.no where each old id redirects, under KUDOS's limits.
 *
 *   tsx --conditions=source packages/eval/src/scripts/kudos-earlier-ids.ts follow
 *   tsx --conditions=source packages/eval/src/scripts/kudos-earlier-ids.ts check
 *
 * About 10,000 ids take two to three hours at 4,500 requests an hour, then `check` lists the
 * indexed types once (about 300 requests) and reads the few documents the listing did not give.
 *
 * `follow` reads today's ids and follows each `https://kudos.dfo.no/documents/<n>`, appending to
 * `.data/kudos-earlier-ids/redirects.jsonl`, so a stopped run goes on where it stopped. `check`
 * keeps a redirect only when a file sha256 of the old document is among the live document's files
 * (today's index was filled from KUDOS's test copy) and writes
 * `packages/ingest/src/kudos-earlier-ids.json`.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkEarlierId,
  kudosClient,
  kudosListing,
  kudosProd,
  kudosRateLimiter,
  retryAfterMs,
  type EarlierIdsMap,
  type KudosDocument,
} from '@genai/ingest';

const root = join(import.meta.dirname, '..', '..', '..', '..');
const envFile = join(root, '.env.local');
if (readIfThere(envFile) !== undefined) process.loadEnvFile(envFile);

const cache = join(root, '.data', 'kudos-earlier-ids');
const oldFile = join(cache, 'old.json');
const redirectsFile = join(cache, 'redirects.jsonl');
const liveFile = join(cache, 'live.jsonl');
const mapFile = join(root, 'packages', 'ingest', 'src', 'kudos-earlier-ids.json');

const collections = {
  docs: 'KUDOS_preprod_v4_documents_ab897fbdedfa',
  chunks: 'KUDOS_preprod_v4_chunks_ab897fbdedfa',
};

const indexedTypes = [
  'Tildelingsbrev',
  'Årsrapport',
  'Instruks',
  'Proposisjon til Stortinget',
  'Melding til Stortinget',
  'Strategi/plan',
  'Evaluering',
  'Statusrapport',
] as const;

/** Leaves about 500 requests an hour for anything else this machine asks KUDOS. */
const limiter = kudosRateLimiter({ perHour: 4500 });

interface OldDocument {
  id: string;
  sha256: string[];
}

interface Redirect {
  id: string;
  status: number;
  uuid?: string;
}

/** The file's text, or undefined when it is not there yet. */
function readIfThere(file: string) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

const typesense = async (path: string) => {
  const baseURL = process.env.TYPESENSE_URL;
  const key = process.env.TYPESENSE_KEY;
  if (!baseURL || !key)
    throw new Error('TYPESENSE_URL and TYPESENSE_KEY must be set in .env.local');
  const response = await fetch(`${baseURL}${path}`, { headers: { 'X-TYPESENSE-API-KEY': key } });
  if (!response.ok) throw new Error(`Typesense answered HTTP ${response.status} for ${path}`);
  return response.text();
};

/** The ids of today's index: every document, and every document its chunks name. */
const readOld = async (): Promise<OldDocument[]> => {
  const cached = readIfThere(oldFile);
  if (cached !== undefined) return JSON.parse(cached) as OldDocument[];
  const byId = new Map<string, OldDocument>();
  const exported = await typesense(
    `/collections/${collections.docs}/documents/export?include_fields=id,files`,
  );
  for (const line of exported.split('\n')) {
    if (!line.trim()) continue;
    const doc = JSON.parse(line) as { id: string; files?: { sha256?: string }[] };
    byId.set(doc.id, {
      id: doc.id,
      sha256: (doc.files ?? []).flatMap((f) => (f.sha256 ? [f.sha256] : [])),
    });
  }
  const facets = JSON.parse(
    await typesense(
      `/collections/${collections.chunks}/documents/search?q=*&query_by=doc_num&facet_by=doc_num&max_facet_values=100000&per_page=0`,
    ),
  ) as { facet_counts: { counts: { value: string }[] }[] };
  for (const { value } of facets.facet_counts[0]?.counts ?? [])
    if (!byId.has(value)) byId.set(value, { id: value, sha256: [] });
  const old = [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
  mkdirSync(cache, { recursive: true });
  writeFileSync(oldFile, JSON.stringify(old));
  return old;
};

const readLines = <T>(file: string): T[] =>
  (readIfThere(file) ?? '')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);

const uuidPattern = /\/dokument\/([0-9a-f-]{36})(?:[/?#]|$)/;

const followOne = async (id: string): Promise<Redirect> => {
  for (let attempt = 0; ; attempt++) {
    await limiter.take();
    try {
      const response = await fetch(`https://kudos.dfo.no/documents/${id}`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
      });
      await response.body?.cancel();
      if (response.status === 429) {
        limiter.pause(retryAfterMs(response.headers.get('retry-after')));
        continue;
      }
      if (response.status >= 500 && attempt < 3) continue;
      const uuid = uuidPattern.exec(response.headers.get('location') ?? '')?.[1];
      return { id, status: response.status, ...(uuid ? { uuid } : {}) };
    } catch (error) {
      if (attempt >= 3) return { id, status: 0 };
      console.error(JSON.stringify({ id, retry: attempt + 1, error: String(error) }));
    }
  }
};

const follow = async () => {
  const old = await readOld();
  const done = new Set(readLines<Redirect>(redirectsFile).map((r) => r.id));
  const todo = old.filter((d) => !done.has(d.id));
  console.log(JSON.stringify({ ids: old.length, done: done.size, todo: todo.length }));
  let n = 0;
  for (const doc of todo) {
    appendFileSync(redirectsFile, `${JSON.stringify(await followOne(doc.id))}\n`);
    if (++n % 250 === 0) console.log(JSON.stringify({ followed: done.size + n, of: old.length }));
  }
  console.log(JSON.stringify({ followed: old.length }));
};

const reasonOf = (redirect: Redirect) =>
  redirect.status === 0
    ? 'no answer from kudos.dfo.no'
    : redirect.uuid
      ? undefined
      : `HTTP ${redirect.status} without a document to redirect to`;

const check = async () => {
  const old = new Map((await readOld()).map((d) => [d.id, d]));
  const redirects = readLines<Redirect>(redirectsFile);
  const client = kudosClient({ profile: kudosProd, limiter });
  const live = new Map(readLines<KudosDocument>(liveFile).map((d) => [String(d.uuid), d]));
  const keep = (doc: KudosDocument) => {
    if (!doc.uuid || live.has(doc.uuid)) return;
    live.set(doc.uuid, doc);
    appendFileSync(liveFile, `${JSON.stringify({ uuid: doc.uuid, files: doc.files ?? [] })}\n`);
  };
  // Today's index holds these types from 2019 on: one listing finds most documents' files.
  if (live.size === 0)
    for await (const doc of kudosListing(client, {
      types: [...indexedTypes],
      since: '2019-01-01',
    }).documents())
      keep(doc);
  const wanted = [...new Set(redirects.flatMap((r) => (r.uuid ? [r.uuid] : [])))].filter(
    (uuid) => !live.has(uuid),
  );
  console.log(
    JSON.stringify({ redirects: redirects.length, live: live.size, fetch: wanted.length }),
  );
  for (const uuid of wanted) {
    try {
      keep(await client.document(uuid));
    } catch (error) {
      console.error(JSON.stringify({ uuid, error: String(error) }));
    }
  }
  const map: EarlierIdsMap = { ids: {}, unresolved: {} };
  for (const redirect of redirects) {
    const reason = reasonOf(redirect);
    if (reason || !redirect.uuid) {
      map.unresolved[redirect.id] = reason ?? 'no document';
      continue;
    }
    const doc = live.get(redirect.uuid);
    if (!doc) {
      map.unresolved[redirect.id] = `${redirect.uuid} could not be read from KUDOS`;
      continue;
    }
    const checked = checkEarlierId(old.get(redirect.id) ?? { sha256: [] }, doc);
    if ('uuid' in checked) map.ids[redirect.id] = checked.uuid;
    else map.unresolved[redirect.id] = checked.reason;
  }
  const missing = [...old.keys()].filter((id) => !(id in map.ids) && !(id in map.unresolved));
  for (const id of missing) map.unresolved[id] = 'not followed yet';
  writeFileSync(mapFile, `${JSON.stringify(map, null, 2)}\n`);
  console.log(
    JSON.stringify({
      ids: old.size,
      resolved: Object.keys(map.ids).length,
      unresolved: Object.keys(map.unresolved).length,
      out: mapFile,
    }),
  );
};

const [command] = process.argv.slice(2);
if (command === 'follow') await follow();
else if (command === 'check') await check();
else throw new Error('usage: kudos-earlier-ids follow | check');
