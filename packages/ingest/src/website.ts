import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, Dispatcher1Wrapper } from 'undici';
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
  maxSitemaps: number;
  maxSitemapEntries: number;
}

export const defaultFetchPolicy = {
  connectTimeoutMs: 5000,
  readTimeoutMs: 15000,
  maxSitemapBytes: 5 * 1024 * 1024,
  maxMarkdownBytes: 10 * 1024 * 1024,
  maxRedirects: 5,
  maxSitemapDepth: 5,
  maxSitemaps: 1000,
  maxSitemapEntries: 100_000,
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
  // A zone index only exists on link-local addresses, and URL parsing refuses it.
  if (ip.includes('%')) return true;
  // URL canonicalization handles dotted tails, compression, case and leading zeroes.
  const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const [left = '', right = ''] = normalized.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const words = (
    normalized.includes('::')
      ? [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail]
      : head
  ).map((word) => parseInt(word, 16));
  const first = words[0] ?? 0;
  const zeroPrefix = words.slice(0, 5).every((word) => word === 0);
  // Mapped IPv6 uses the host's IPv4 stack: apply exactly the IPv4 policy.
  if (zeroPrefix && words[5] === 0xffff) {
    const high = words[6] ?? 0;
    const low = words[7] ?? 0;
    return ipv4Blocked([high >> 8, high & 255, low >> 8, low & 255].join('.'));
  }
  // Compatible IPv4 (::/96), unspecified and loopback are not public IPv6 destinations.
  if (zeroPrefix && words[5] === 0) return true;
  // Translated IPv4 and NAT64 prefixes can reach IPv4 destinations behind a translator.
  if (words.slice(0, 4).every((word) => word === 0) && words[4] === 0xffff && words[5] === 0)
    return true;
  if (first === 0x64 && words[1] === 0xff9b) return true;
  // 6to4 and Teredo encapsulate IPv4; refuse the whole transition ranges.
  if (first === 0x2002 || (first === 0x2001 && words[1] === 0)) return true;
  if (first === 0x2001 && ((words[1] ?? 0) & 0xfe00) === 0) return true;
  if ((first & 0xe000) !== 0x2000) return true;
  return (
    (first === 0x2001 && words[1] === 0xdb8) || // Documentation.
    (first === 0x3fff && ((words[1] ?? 0) & 0xf000) === 0) // Documentation (3fff::/20).
  );
};

export const blockedAddress = (ip: string) =>
  isIP(ip) === 4 ? ipv4Blocked(ip) : isIP(ip) === 6 ? ipv6Blocked(ip) : true;

export type HostResolver = (host: string) => Promise<string[]>;

const dnsResolver: HostResolver = async (host) =>
  (await lookup(host, { all: true })).map((a) => a.address);

const validatedFetchTarget = async (url: string, policy: FetchPolicy, resolve: HostResolver) => {
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
  return { parsed, addresses: [...addresses] };
};

export const validateFetchUrl = async (url: string, policy: FetchPolicy, resolve: HostResolver) =>
  (await validatedFetchTarget(url, policy, resolve)).parsed;

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
  /** For tests: it must honour `init.dispatcher`, or the address pin is bypassed. */
  fetch?: typeof fetch;
  resolve?: HostResolver;
  signal?: AbortSignal;
}

export interface FetchedBody {
  bytes: Uint8Array;
  contentType?: string;
}

/** Consume a guarded response with backpressure, without buffering the full body. */
export const guardedFetchStream = async (
  url: string,
  policy: FetchPolicy,
  maxBytes: number,
  consume: (chunk: Uint8Array) => Promise<void>,
  options: GuardedFetchOptions = {},
): Promise<Headers> => {
  options.signal?.throwIfAborted();
  const send = options.fetch ?? fetch;
  const resolve = options.resolve ?? dnsResolver;
  let current = url;
  for (let redirects = 0; ; redirects += 1) {
    options.signal?.throwIfAborted();
    const { parsed, addresses } = await validatedFetchTarget(current, policy, resolve);
    options.signal?.throwIfAborted();
    current = parsed.toString();
    // A fresh agent per hop pins this hop's addresses; Host, SNI and certificates keep the URL name.
    const dispatcher = new Agent({
      connect: {
        timeout: policy.connectTimeoutMs,
        lookup: (_host, lookupOptions, callback) => {
          const pinned = addresses.map((address) => ({ address, family: isIP(address) }));
          if (lookupOptions.all) callback(null, pinned);
          else callback(null, pinned[0]?.address ?? '', pinned[0]?.family ?? 0);
        },
      },
    });
    const timeout = AbortSignal.timeout(policy.connectTimeoutMs + policy.readTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const init = {
        // Adapt undici 8's handler protocol to Node's bundled fetch protocol.
        dispatcher: new Dispatcher1Wrapper(dispatcher),
        redirect: 'manual' as const,
        headers: { accept: 'application/xml,text/xml,text/markdown,text/plain;q=0.9,*/*;q=0.1' },
        signal,
      };
      // DOM and Node declarations disagree on dispatcher; the wrapper adapts its runtime protocol.
      const response = await send(current, init as unknown as RequestInit);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (redirects >= policy.maxRedirects)
          throw new Error(`Too many redirects while fetching ${url}`);
        const location = response.headers.get('location');
        if (!location) throw new Error(`Redirect without a location from ${current}`);
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new HttpStatusError(
          response.status,
          `Website answered HTTP ${response.status} for ${current}`,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) return response.headers;
      const abort = () => {
        void reader.cancel(signal.reason).catch(() => undefined);
      };
      signal.addEventListener('abort', abort, { once: true });
      let total = 0;
      let complete = false;
      try {
        for (;;) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          signal.throwIfAborted();
          if (done) {
            complete = true;
            break;
          }
          total += value.byteLength;
          if (total > maxBytes)
            throw new Error(`Website response exceeds size limit of ${maxBytes} bytes`);
          await consume(value);
        }
        return response.headers;
      } finally {
        signal.removeEventListener('abort', abort);
        if (!complete) await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    } finally {
      await dispatcher.destroy();
    }
  }
};

export const guardedFetchBytes = async (
  url: string,
  policy: FetchPolicy,
  maxBytes: number,
  options: GuardedFetchOptions = {},
): Promise<FetchedBody & { headers: Headers }> => {
  const parts: Uint8Array[] = [];
  const headers = await guardedFetchStream(
    url,
    policy,
    maxBytes,
    async (chunk) => {
      parts.push(chunk);
    },
    options,
  );
  const contentType = headers.get('content-type') ?? undefined;
  return {
    bytes: new Uint8Array(Buffer.concat(parts)),
    headers,
    ...(contentType ? { contentType } : {}),
  };
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

const blocks = function* (xml: string, tag: string) {
  const open = new RegExp(`<(?:[\\w-]+:)?${tag}\\b`, 'g');
  const close = new RegExp(`</(?:[\\w-]+:)?${tag}>`, 'g');
  for (;;) {
    const opened = open.exec(xml);
    if (!opened) return;
    const start = xml.indexOf('>', open.lastIndex);
    if (start === -1) return;
    close.lastIndex = start + 1;
    const closed = close.exec(xml);
    if (!closed) return;
    yield xml.slice(start + 1, closed.index);
    open.lastIndex = close.lastIndex;
  }
};

const firstTag = (xml: string, tag: string) => {
  for (const block of blocks(xml, tag)) return decodeXml(block.trim());
  return undefined;
};

const allBlocks = (xml: string, tag: string) => [...blocks(xml, tag)];

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
  const visited = new Set<string>();
  const out: SitemapEntry[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > policy.maxSitemapDepth)
      throw new Error(`Sitemap nesting exceeds depth limit at ${current}`);
    if (visited.has(current)) return;
    if (visited.size >= policy.maxSitemaps)
      throw new Error(`Sitemap has more than ${policy.maxSitemaps} sitemaps`);
    visited.add(current);
    const parsed = parseSitemapXml(
      await guardedFetchText(current, policy, policy.maxSitemapBytes, options),
      baseUrl,
    );
    if (parsed.kind === 'index') {
      for (const child of parsed.sitemaps)
        await walk(new URL(child, current).toString(), depth + 1);
      return;
    }
    for (const entry of parsed.entries) {
      if (!entry.loc.endsWith('.md') && options.includeHtml !== true) continue;
      if (out.length >= policy.maxSitemapEntries)
        throw new Error(`Sitemap has more than ${policy.maxSitemapEntries} entries`);
      out.push(entry);
    }
  };
  await walk(makeAbsoluteUrl(baseUrl, url), 0);
  return out;
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

const scalar = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';

const frontmatterLanguages: Record<string, string> = { nb: 'nb', no: 'nb', nn: 'nn', en: 'en' };

/** `nb`, `nb-NO`, `no`, `nn`, `en-GB` and the like; anything else is not a language we store. */
const frontmatterLanguage = (value: unknown) =>
  frontmatterLanguages[scalar(value).toLowerCase().split(/[-_]/)[0] ?? ''];

/**
 * A non-empty frontmatter `title` also replaces the title derived from the URL, and `lang` or
 * `language` fills in a language the URL did not give. `product` is kept as a field.
 */
export const mergeFrontmatter = <D extends object>(doc: D, markdown: string) => {
  const fm = parseFrontmatter(markdown) ?? {};
  const title = scalar(fm.title);
  const product = scalar(fm.product);
  const language = frontmatterLanguage(fm.lang ?? fm.language);
  const urlLanguage = (doc as { language?: unknown }).language;
  return {
    ...doc,
    ...(fm.linktitle !== undefined && fm.linktitle !== null
      ? { linktitle: String(fm.linktitle) }
      : {}),
    ...(fm.title !== undefined && fm.title !== null ? { frontmatter_title: String(fm.title) } : {}),
    ...(title ? { title } : {}),
    ...(fm.diataxis !== undefined && fm.diataxis !== null
      ? { diataxis: String(fm.diataxis).replace(/^diataxis_/, '') }
      : {}),
    ...(product ? { product } : {}),
    ...(language && !urlLanguage ? { language } : {}),
  };
};

const websiteDocFields = [
  'id',
  'doc_num',
  'title',
  'linktitle',
  'frontmatter_title',
  'diataxis',
  'product',
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
    ]),
    id: c.chunk_id,
    url: makeRelativeUrl(baseUrl, c.url ?? ''),
  }));
