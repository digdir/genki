import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import {
  cidrContains,
  isAllowableRange,
  isLoopbackAddress,
  isPrivateAddress,
  isReservedAddress,
  parseCidr,
  type Cidr,
} from './ranges.js';

export interface AllowedHost {
  host: string;
  port?: number | undefined;
}

export type EgressErrorCode =
  | 'not_allowed'
  | 'private_address'
  | 'insecure'
  | 'redirect_refused'
  | 'too_large'
  | 'timeout'
  | 'cancelled'
  | 'network';

export class EgressError extends Error {
  constructor(
    readonly code: EgressErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EgressError';
  }
}

export type Lookup = (hostname: string) => Promise<string[]>;

export interface EgressOptions {
  platformHosts?: string[];
  lookup?: Lookup;
  maxResponseBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  testOverride?: { allowLoopback?: boolean; allowHttp?: boolean };
}

export interface EgressRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface EgressResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export type PrivateNetworkEntry = { kind: 'cidr'; cidr: Cidr } | { kind: 'host'; host: string };

const hostName =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export const privateNetworkEntry = (
  text: string,
): { ok: true; entry: PrivateNetworkEntry } | { ok: false; message: string } => {
  const value = text.trim().toLowerCase();
  const cidr = parseCidr(value);
  if (cidr)
    return isAllowableRange(cidr)
      ? { ok: true, entry: { kind: 'cidr', cidr } }
      : {
          ok: false,
          message: `${value} is not inside a private network range that can be allowed`,
        };
  if (value.includes('/') || isIP(value) || /^[\d.]+$/.test(value))
    return { ok: false, message: `${value} is not a valid address or CIDR range` };
  if (!hostName.test(value) || value === 'localhost' || value.endsWith('.localhost'))
    return { ok: false, message: `${value} is not a host name that can be allowed` };
  return { ok: true, entry: { kind: 'host', host: value } };
};

export type HostNetwork = 'public' | 'private' | 'blocked' | 'unknown';

const systemLookup: Lookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

const defaultPort = (url: URL) =>
  url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;

const bareHost = (url: URL) => url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

export class EgressGuard {
  readonly #lookup: Lookup;
  readonly #platformHosts: Set<string>;
  #platformAddresses: Promise<Set<string>> | undefined;

  constructor(private readonly options: EgressOptions = {}) {
    this.#lookup = options.lookup ?? systemLookup;
    this.#platformHosts = new Set((options.platformHosts ?? []).map((h) => h.toLowerCase()));
  }

  #resolvedPlatform(): Promise<Set<string>> {
    this.#platformAddresses ??= Promise.all(
      [...this.#platformHosts]
        .map((h) => h.replace(/:\d+$/, ''))
        .filter((h) => !isIP(h))
        .map((h) => this.#lookup(h).catch(() => [] as string[])),
    ).then((all) => new Set(all.flat().map((a) => a.toLowerCase())));
    return this.#platformAddresses;
  }

  async #addressFor(url: URL, allow: AllowedHost[]): Promise<string> {
    const insecureOk = this.options.testOverride?.allowHttp === true;
    if (url.protocol !== 'https:' && !(insecureOk && url.protocol === 'http:'))
      throw new EgressError('insecure', 'tool connections must use HTTPS');
    if (url.username || url.password)
      throw new EgressError('not_allowed', 'credentials in the URL are not allowed');
    const host = bareHost(url);
    const port = defaultPort(url);
    if (!allow.some((a) => a.host.toLowerCase() === host && (a.port ?? 443) === port))
      throw new EgressError('not_allowed', `${host}:${port} is not on the connection's allowlist`);
    return this.address(host);
  }

  async address(hostname: string, allowPrivate: readonly string[] = []): Promise<string> {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (this.#platformHosts.has(host))
      throw new EgressError('not_allowed', `${host} is a platform host`);
    const addresses = isIP(host) ? [host] : await this.#lookup(host);
    if (addresses.length === 0) throw new EgressError('network', `${host} did not resolve`);
    const loopbackOk = this.options.testOverride?.allowLoopback === true;
    const entries = allowPrivate.flatMap((text) => {
      const parsed = privateNetworkEntry(text);
      return parsed.ok ? [parsed.entry] : [];
    });
    for (const address of addresses) {
      const lowered = address.toLowerCase();
      if (this.#platformHosts.has(lowered))
        throw new EgressError('not_allowed', `${host} resolves to a platform host`);
      if (!isPrivateAddress(address) && !isReservedAddress(address)) continue;
      if (loopbackOk && isLoopbackAddress(address)) continue;
      if (isReservedAddress(address))
        throw new EgressError('private_address', `${host} resolves to a reserved private address`);
      if ((await this.#resolvedPlatform()).has(lowered))
        throw new EgressError('not_allowed', `${host} resolves to a platform host`);
      const allowed = entries.some((e) =>
        e.kind === 'host' ? e.host === host : cidrContains(e.cidr, address),
      );
      if (!allowed)
        throw new EgressError('private_address', `${host} resolves to a private address`);
    }
    return addresses[0] as string;
  }

  async network(
    hostname: string,
    allowPrivate: readonly string[] = [],
  ): Promise<{ network: HostNetwork; allowed: boolean }> {
    try {
      await this.address(hostname, allowPrivate);
      const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
      const addresses = isIP(host) ? [host] : await this.#lookup(host);
      return { network: addresses.some(isPrivateAddress) ? 'private' : 'public', allowed: true };
    } catch (error) {
      if (!(error instanceof EgressError)) return { network: 'unknown', allowed: false };
      if (error.code === 'network') return { network: 'unknown', allowed: false };
      if (error.code === 'private_address' && !error.message.includes('reserved'))
        return { network: 'private', allowed: false };
      return { network: 'blocked', allowed: false };
    }
  }

  fetch(allow: AllowedHost[]): typeof fetch {
    return async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      await this.#addressFor(url, allow);
      const response = await fetch(input, { ...init, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400)
        throw new EgressError('redirect_refused', 'redirects are not followed');
      return response;
    };
  }

  async request(
    allow: AllowedHost[],
    target: string,
    init: EgressRequest,
    signal?: AbortSignal,
  ): Promise<EgressResponse> {
    let url = new URL(target);
    for (let hop = 0; ; hop += 1) {
      const response = await this.#once(allow, url, init, signal);
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.location;
      if (!location) return response;
      const next = new URL(location, url);
      if (
        next.protocol !== url.protocol ||
        bareHost(next) !== bareHost(url) ||
        defaultPort(next) !== defaultPort(url)
      )
        throw new EgressError('redirect_refused', 'redirects to another host are not followed');
      if (hop >= (this.options.maxRedirects ?? 3))
        throw new EgressError('redirect_refused', 'too many redirects');
      url = next;
    }
  }

  async #once(
    allow: AllowedHost[],
    url: URL,
    init: EgressRequest,
    signal?: AbortSignal,
  ): Promise<EgressResponse> {
    if (signal?.aborted) throw new EgressError('cancelled', 'the request was cancelled');
    const address = await this.#addressFor(url, allow);
    const limit = init.maxResponseBytes ?? this.options.maxResponseBytes ?? 1024 * 1024;
    const timeoutMs = init.timeoutMs ?? this.options.timeoutMs ?? 10_000;
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const host = bareHost(url);

    return new Promise<EgressResponse>((resolve, reject) => {
      let settled = false;
      const finish = (error: EgressError | undefined, value?: EgressResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(value as EgressResponse);
      };
      const req = send(
        {
          host: address,
          port: defaultPort(url),
          path: `${url.pathname}${url.search}`,
          method: init.method,
          servername: isIP(host) ? undefined : host,
          headers: { ...init.headers, host: url.host },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) {
              req.destroy();
              finish(new EgressError('too_large', `the response is larger than ${limit} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            finish(undefined, {
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
          res.on('error', () => finish(new EgressError('network', 'the response failed')));
        },
      );
      const timer = setTimeout(() => {
        req.destroy();
        finish(new EgressError('timeout', `no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      const onAbort = () => {
        req.destroy();
        finish(new EgressError('cancelled', 'the request was cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('error', (error) => finish(new EgressError('network', error.message)));
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
  }
}
