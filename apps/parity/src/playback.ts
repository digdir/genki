import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { JsonValue } from './types.js';

export interface Upstream {
  baseUrl: string;
  apiKey: string;
  auth: 'bearer' | 'api-key';
}

export interface PlaybackOptions {
  mode: 'record' | 'replay';
  cassette: string;
  upstream?: Upstream;
  port?: number;
}

export interface CassetteEntry {
  endpoint: string;
  request: JsonValue;
  status: number;
  contentType: string;
  body: string;
}

export interface Cassette {
  version: 1;
  entries: Record<string, CassetteEntry[]>;
}

export interface Playback {
  url: string;
  misses: string[];
  close(): Promise<void>;
}

const hashedFields = ['messages', 'tools', 'tool_choice', 'response_format', 'stream', 'input'];
const secretKeys = /^(api[_-]?key|authorization|token|secret|password)$/i;

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
};

const scrub = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !secretKeys.test(k))
        .map(([k, v]) => [k, scrub(v)]),
    );
  }
  return value;
};

export const endpointOf = (path: string) =>
  /(chat\/completions|completions|embeddings|responses|messages)$/.exec(
    path.split('?')[0] ?? '',
  )?.[1] ?? 'other';

export const requestHash = (path: string, body: JsonValue) => {
  const fields =
    body && typeof body === 'object' && !Array.isArray(body)
      ? Object.fromEntries(hashedFields.flatMap((f) => (f in body ? [[f, body[f]]] : [])))
      : body;
  return createHash('sha256')
    .update(JSON.stringify(canonical({ endpoint: endpointOf(path), fields })))
    .digest('hex');
};

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });

const parse = (raw: string): JsonValue => {
  try {
    return JSON.parse(raw || 'null') as JsonValue;
  } catch {
    return raw;
  }
};

export const loadCassette = async (path: string): Promise<Cassette> =>
  existsSync(path)
    ? (JSON.parse(await readFile(path, 'utf8')) as Cassette)
    : { version: 1, entries: {} };

const save = async (path: string, cassette: Cassette) => {
  await writeFile(`${path}.tmp`, `${JSON.stringify(cassette, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
};

const forward = async (upstream: Upstream, path: string, raw: string) => {
  const tail = path.replace(/^\/v1(?=\/)/, '');
  const response = await fetch(`${upstream.baseUrl.replace(/\/+$/, '')}${tail}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(upstream.auth === 'bearer'
        ? { authorization: `Bearer ${upstream.apiKey}` }
        : { 'api-key': upstream.apiKey }),
    },
    body: raw,
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? 'application/json',
    body: await response.text(),
  };
};

export const startPlayback = async (options: PlaybackOptions): Promise<Playback> => {
  if (options.mode === 'record' && !options.upstream)
    throw new Error('recording needs an upstream');
  const cassette = await loadCassette(options.cassette);
  const served = new Map<string, number>();
  const misses: string[] = [];
  let writes = Promise.resolve();

  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = req.url ?? '/';
      const raw = await readBody(req);
      const body = parse(raw);
      const hash = requestHash(path, body);
      const reply = (status: number, contentType: string, text: string) => {
        res.writeHead(status, { 'content-type': contentType, 'x-playback-hash': hash });
        res.end(text);
      };

      if (req.method !== 'POST') return reply(405, 'application/json', '{"error":"POST only"}');

      if (options.mode === 'record' && options.upstream) {
        const answer = await forward(options.upstream, path, raw);
        const entry: CassetteEntry = {
          endpoint: endpointOf(path),
          request: scrub(body),
          status: answer.status,
          contentType: answer.contentType,
          body: answer.body,
        };
        cassette.entries[hash] = [...(cassette.entries[hash] ?? []), entry];
        writes = writes.then(() => save(options.cassette, cassette));
        await writes;
        return reply(answer.status, answer.contentType, answer.body);
      }

      const entries = cassette.entries[hash] ?? [];
      const index = served.get(hash) ?? 0;
      const entry = entries[Math.min(index, entries.length - 1)];
      if (!entry) {
        misses.push(hash);
        return reply(
          404,
          'application/json',
          JSON.stringify({
            error: { message: `no recording for request ${hash}`, type: 'playback_miss' },
          }),
        );
      }
      served.set(hash, index + 1);
      return reply(entry.status, entry.contentType, entry.body);
    })().catch((error: unknown) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: { message: (error as Error).message, type: 'playback_error' } }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    misses,
    close: async () => {
      await writes;
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
};
