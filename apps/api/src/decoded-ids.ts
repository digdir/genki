import type { Env, Hono } from 'hono';
import { blockKinds } from './building-blocks.js';
import { catalogKinds } from './catalog-registry.js';

type Segment = string | ReadonlySet<string> | undefined;

export interface DecodedIdFamily {
  prefix: readonly Segment[];
  subPaths: ReadonlySet<string>;
}

const anyTenant = undefined;
const datasetSubPaths = new Set([
  'pipelines',
  'engine',
  'engine-switches',
  'enrichment',
  'uploads',
]);
const catalogSubPaths = new Set(['versions']);

export const decodedIdFamilies: readonly DecodedIdFamily[] = [
  { prefix: ['operator', 'datasets'], subPaths: datasetSubPaths },
  { prefix: ['tenants', anyTenant, 'datasets'], subPaths: datasetSubPaths },
  { prefix: ['operator', 'catalog', new Set(catalogKinds)], subPaths: catalogSubPaths },
  { prefix: ['tenants', anyTenant, 'catalog', new Set(catalogKinds)], subPaths: catalogSubPaths },
  {
    prefix: ['tenants', anyTenant, 'building-blocks', new Set(blockKinds)],
    subPaths: new Set(['adopt', 'approval-requests', 'settings', 'versions']),
  },
  { prefix: ['operator', 'knowledge', 'endpoints'], subPaths: new Set() },
  { prefix: ['operator', 'model-endpoints'], subPaths: new Set() },
];

const matches = (segment: string, expected: Segment) =>
  segment !== '' &&
  (expected === undefined ||
    (typeof expected === 'string' ? segment === expected : expected.has(segment)));

const idStart = (segments: readonly string[], prefix: readonly Segment[]) =>
  prefix.every((expected, i) => matches(segments[i + 1] ?? '', expected)) ? prefix.length + 1 : -1;

export const encodeDecodedIds = (pathname: string): string => {
  const segments = pathname.split('/');
  for (const family of decodedIdFamilies) {
    const start = idStart(segments, family.prefix);
    if (start < 0) continue;
    let end = start;
    while (end < segments.length) {
      const segment = segments[end] ?? '';
      if (segment === '' || (end > start && family.subPaths.has(segment))) break;
      end++;
    }
    if (end - start < 2) return pathname;
    return [
      ...segments.slice(0, start),
      segments.slice(start, end).join('%2F'),
      ...segments.slice(end),
    ].join('/');
  }
  return pathname;
};

const withEncodedIds = (request: Request): Request => {
  const url = new URL(request.url);
  const pathname = encodeDecodedIds(url.pathname);
  if (pathname === url.pathname) return request;
  url.pathname = pathname;
  const bodyless = request.method === 'GET' || request.method === 'HEAD';
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
    ...(bodyless ? {} : { body: request.body, duplex: 'half' }),
  } as RequestInit);
};

export const acceptDecodedIds = <E extends Env>(app: Pick<Hono<E>, 'fetch'>) => {
  const fetch = app.fetch;
  app.fetch = (request, ...rest) => fetch(withEncodedIds(request), ...rest);
};
