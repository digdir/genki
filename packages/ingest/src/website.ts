import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { parse as parseYaml } from 'yaml';
import type { Chunk } from './chunk-document.js';
import { documentId } from './ids.js';
import { capitalize, javaSplit } from './text.js';

export interface FetchPolicy {
  allowedHosts: Set<string>;
  connectTimeoutMs: number;
  readTimeoutMs: number;
  maxSitemapBytes: number;
  maxMarkdownBytes: number;
  maxRedirects: number;
  maxSitemapDepth: number;
}

export const defaultFetchPolicy = {
  connectTimeoutMs: 5000,
  readTimeoutMs: 15000,
  maxSitemapBytes: 5 * 1024 * 1024,
  maxMarkdownBytes: 10 * 1024 * 1024,
  maxRedirects: 5,
  maxSitemapDepth: 5,
};

export const makeRelativeUrl = (baseUrl: string | undefined, url: string) =>
  baseUrl && url.startsWith(baseUrl) ? url.slice(baseUrl.length) : url;

export const makeAbsoluteUrl = (baseUrl: string | undefined, url: string) =>
  baseUrl && !url.startsWith('http') ? `${baseUrl}${url}` : url;

const hostOf = (value: string) => {
  try {
    return value.includes('://')
      ? new URL(value).hostname.toLowerCase().replace(/\.$/, '')
      : value.toLowerCase().replace(/\.$/, '');
  } catch {
    return undefined;
  }
};

export const websiteFetchPolicy = (config: {
  baseUrl?: string;
  sitemapUrl: string;
  allowedHosts?: string[];
  limits?: Partial<typeof defaultFetchPolicy>;
}): FetchPolicy => ({
  ...defaultFetchPolicy,
  ...config.limits,
  allowedHosts: new Set(
    [
      config.baseUrl,
      makeAbsoluteUrl(config.baseUrl, config.sitemapUrl),
      ...(config.allowedHosts ?? []),
    ]
      .flatMap((v) => (v ? [hostOf(v)] : []))
      .filter((h): h is string => Boolean(h)),
  ),
});

const ipv4Blocked = (ip: string) => {
  const [a = 0, b = 0, c = 0] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
};

const ipv6Blocked = (ip: string) => {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return ipv4Blocked(mapped[1] as string);
  const first = parseInt(lower.split(':')[0] || '0', 16);
  return (
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    lower.startsWith('2001:db8:')
  );
};

export const blockedAddress = (ip: string) =>
  isIP(ip) === 4 ? ipv4Blocked(ip) : isIP(ip) === 6 ? ipv6Blocked(ip) : true;

export type HostResolver = (host: string) => Promise<string[]>;

const dnsResolver: HostResolver = async (host) =>
  (await lookup(host, { all: true })).map((a) => a.address);

export const validateFetchUrl = async (url: string, policy: FetchPolicy, resolve: HostResolver) => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid website fetch URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new Error(`Website fetch URL must use HTTP or HTTPS: ${url}`);
  const host = parsed.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
  if (!host || parsed.username || parsed.password)
    throw new Error(`Website fetch URL has an invalid authority: ${url}`);
  if (policy.allowedHosts.size > 0 && !policy.allowedHosts.has(host))
    throw new Error(`Website fetch host is not allowed: ${host}`);
  const addresses = isIP(host) ? [host] : await resolve(host);
  if (addresses.length === 0)
    throw new Error(`Website fetch host resolved to no addresses: ${host}`);
  const blocked = addresses.find(blockedAddress);
  if (blocked) throw new Error(`Website fetch resolved to a private or reserved address: ${host}`);
  return parsed;
};

export class HttpStatusError extends Error {
  override readonly name = 'HttpStatusError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GuardedFetchOptions {
  fetch?: typeof fetch;
  resolve?: HostResolver;
}

export interface FetchedBody {
  bytes: Uint8Array;
  contentType?: string;
}

export const guardedFetchBytes = async (
  url: string,
  policy: FetchPolicy,
  maxBytes: number,
  options: GuardedFetchOptions = {},
): Promise<FetchedBody> => {
  const send = options.fetch ?? fetch;
  const resolve = options.resolve ?? dnsResolver;
  let current = (await validateFetchUrl(url, policy, resolve)).toString();
  for (let redirects = 0; ; redirects += 1) {
    const response = await send(current, {
      redirect: 'manual',
      headers: { accept: 'application/xml,text/xml,text/markdown,text/plain;q=0.9,*/*;q=0.1' },
      signal: AbortSignal.timeout(policy.connectTimeoutMs + policy.readTimeoutMs),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects >= policy.maxRedirects)
        throw new Error(`Too many redirects while fetching ${url}`);
      const location = response.headers.get('location');
      if (!location) throw new Error(`Redirect without a location from ${current}`);
      current = (
        await validateFetchUrl(new URL(location, current).toString(), policy, resolve)
      ).toString();
      continue;
    }
    if (!response.ok)
      throw new HttpStatusError(
        response.status,
        `Website answered HTTP ${response.status} for ${current}`,
      );
    const contentType = response.headers.get('content-type') ?? undefined;
    const reader = response.body?.getReader();
    if (!reader) return { bytes: new Uint8Array(), ...(contentType ? { contentType } : {}) };
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Website response exceeds size limit of ${maxBytes} bytes`);
      }
      parts.push(value);
    }
    return {
      bytes: new Uint8Array(Buffer.concat(parts)),
      ...(contentType ? { contentType } : {}),
    };
  }
};

export const guardedFetchText = async (
  url: string,
  policy: FetchPolicy,
  maxBytes: number,
  options: GuardedFetchOptions = {},
) => new TextDecoder().decode((await guardedFetchBytes(url, policy, maxBytes, options)).bytes);

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const firstTag = (xml: string, tag: string) => {
  const m = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`).exec(xml);
  return m ? decodeXml((m[1] as string).trim()) : undefined;
};

const allBlocks = (xml: string, tag: string) =>
  [
    ...xml.matchAll(
      new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'g'),
    ),
  ].map((m) => m[1] as string);

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
}

export const parseSitemapXml = (xml: string, baseUrl?: string) => {
  if (/<(?:[\w-]+:)?sitemapindex\b/.test(xml))
    return {
      kind: 'index' as const,
      sitemaps: allBlocks(xml, 'sitemap').flatMap((s) => {
        const loc = firstTag(s, 'loc');
        return loc ? [loc] : [];
      }),
    };
  return {
    kind: 'urlset' as const,
    entries: allBlocks(xml, 'url').flatMap((u): SitemapEntry[] => {
      const loc = firstTag(u, 'loc');
      if (!loc) return [];
      const lastmod = firstTag(u, 'lastmod');
      return [
        { loc: makeAbsoluteUrl(baseUrl, loc), ...(lastmod === undefined ? {} : { lastmod }) },
      ];
    }),
  };
};

export const crawlSitemap = async (
  url: string,
  baseUrl: string | undefined,
  policy: FetchPolicy,
  options: GuardedFetchOptions & { includeHtml?: boolean } = {},
): Promise<SitemapEntry[]> => {
  const walk = async (
    current: string,
    depth: number,
    visited: Set<string>,
  ): Promise<SitemapEntry[]> => {
    if (depth > policy.maxSitemapDepth)
      throw new Error(`Sitemap nesting exceeds depth limit at ${current}`);
    if (visited.has(current)) return [];
    const parsed = parseSitemapXml(
      await guardedFetchText(current, policy, policy.maxSitemapBytes, options),
      baseUrl,
    );
    const next = new Set([...visited, current]);
    if (parsed.kind === 'index') {
      const out: SitemapEntry[] = [];
      for (const child of parsed.sitemaps)
        out.push(...(await walk(new URL(child, current).toString(), depth + 1, next)));
      return out;
    }
    return parsed.entries.filter((e) => e.loc.endsWith('.md') || options.includeHtml === true);
  };
  return walk(makeAbsoluteUrl(baseUrl, url), 0, new Set());
};

export const extractTitleFromUrl = (url: string) => {
  const parts = javaSplit(
    url
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(/\/index\.md$/, '')
      .replace(/\.md$/, ''),
    /\//,
  );
  return capitalize((parts[parts.length - 1] ?? '').replace(/-/g, ' ').replace(/_/g, ' '));
};

export const deriveLanguageFromUrl = (url: string) => {
  const path = url.replace(/^https?:\/\/[^/]+/, '');
  if (path.startsWith('/en/')) return 'en';
  if (path.startsWith('/nb/')) return 'nb';
  return undefined;
};

export const urlToDoc = (entry: SitemapEntry) => {
  const id = documentId(entry.loc);
  const language = deriveLanguageFromUrl(entry.loc);
  return {
    id,
    doc_num: id,
    url: entry.loc,
    lastmod: entry.lastmod ?? null,
    title: extractTitleFromUrl(entry.loc),
    ...(language ? { language } : { language: null }),
    type: 'website',
  };
};

const frontmatterBody = (markdown: string) => {
  const lines = markdown.split('\n');
  if (lines[0]?.trim() !== '---') return undefined;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  return end === -1 ? undefined : lines.slice(1, end).join('\n');
};

export const parseFrontmatter = (markdown: string): Record<string, unknown> | undefined => {
  if (!markdown.startsWith('---')) return undefined;
  const body = frontmatterBody(markdown);
  if (body === undefined) return undefined;
  try {
    const parsed: unknown = parseYaml(body);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export const mergeFrontmatter = <D extends object>(doc: D, markdown: string) => {
  const fm = parseFrontmatter(markdown) ?? {};
  return {
    ...doc,
    ...(fm.linktitle !== undefined && fm.linktitle !== null
      ? { linktitle: String(fm.linktitle) }
      : {}),
    ...(fm.title !== undefined && fm.title !== null ? { frontmatter_title: String(fm.title) } : {}),
    ...(fm.diataxis !== undefined && fm.diataxis !== null
      ? { diataxis: String(fm.diataxis).replace(/^diataxis_/, '') }
      : {}),
  };
};

const websiteDocFields = [
  'id',
  'doc_num',
  'title',
  'linktitle',
  'frontmatter_title',
  'diataxis',
  'language',
  'url',
  'lastmod',
  'type',
  'total_chunks',
];

const pick = (record: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.flatMap((k) => (k in record ? [[k, record[k]]] : [])));

export const prepareWebsiteDoc = (baseUrl: string | undefined, doc: Record<string, unknown>) =>
  pick({ ...doc, url: makeRelativeUrl(baseUrl, String(doc.url)) }, websiteDocFields);

export const prepareWebsiteChunks = (baseUrl: string | undefined, chunks: Chunk[]) =>
  chunks.map((c) => ({
    ...pick(c as unknown as Record<string, unknown>, [
      'chunk_id',
      'doc_num',
      'chunk_index',
      'content_markdown',
      'content_length',
      'metadata',
      'page',
    ]),
    id: c.chunk_id,
    url: makeRelativeUrl(baseUrl, c.url ?? ''),
  }));
