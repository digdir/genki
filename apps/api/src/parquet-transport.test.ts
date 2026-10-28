import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import https from 'node:https';
import { isIP, type AddressInfo, type LookupFunction } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls, { type ConnectionOptions } from 'node:tls';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { blockedAddress, type HostResolver } from '@genai/ingest';
import { parquetReader } from '@genai/providers-parquet';
import { testTlsCertificate } from '../../../scripts/test-tls.js';
import { pipelineSpec } from './ingestion.js';
import { parquetSourceOf } from './parquet-files.js';

const publicAddress = '93.184.216.34';
const fixture = (path: string) =>
  readFileSync(new URL(`../../../packages/${path}`, import.meta.url));
let key: Buffer;
let cert: Buffer;
const shard = fixture('providers-parquet/src/fixtures/shard-a.parquet');
const servers: https.Server[] = [];
const roots: string[] = [];

beforeAll(async () => {
  ({ key, cert } = await testTlsCertificate());
});

const collect = async <T>(rows: AsyncIterable<T>) => {
  const values: T[] = [];
  for await (const row of rows) values.push(row);
  return values;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Keep the real fetch, Agent, TLS verification and decoder. Only the OS socket
// boundary routes the selected address to the local fixture server, recording it
// first. An unpinned transport falls back to the adversarial resolver below.
const networkFixture = async () => {
  const requests: string[] = [];
  const server = https.createServer({ key, cert }, (req, res) => {
    requests.push(req.url ?? '');
    res.end(shard);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  const root = await mkdtemp(join(tmpdir(), 'parquet-transport-test-'));
  roots.push(root);
  const selected: string[] = [];
  const resolve = vi.fn(async () =>
    resolve.mock.calls.length === 1 ? [publicAddress] : ['127.0.0.1'],
  );
  const fallback: LookupFunction = (host, options, callback) => {
    void (resolve as HostResolver)(host).then(
      (addresses) => {
        const results = addresses.map((address) => ({ address, family: isIP(address) }));
        if (options.all) callback(null, results);
        else callback(null, results[0]?.address ?? '', results[0]?.family ?? 0);
      },
      (error: Error) => callback(error, ''),
    );
  };
  const connect = tls.connect;
  vi.spyOn(tls, 'connect').mockImplementation(((options: ConnectionOptions) => {
    const lookup: LookupFunction = (host, lookupOptions, callback) => {
      (options.lookup ?? fallback)(host, lookupOptions, (error, address, family) => {
        if (error) return callback(error, address, family);
        if (Array.isArray(address)) {
          selected.push(...address.map((entry) => entry.address));
          callback(
            null,
            address.map(() => ({ address: '127.0.0.1', family: 4 })),
          );
        } else {
          selected.push(address);
          callback(null, '127.0.0.1', 4);
        }
      });
    };
    return connect({ ...options, ca: cert, lookup });
  }) as typeof tls.connect);
  return {
    requests,
    selected,
    resolve,
    root,
    url: (path: string) => `https://docs.example.test:${port}/${path}`,
  };
};

describe('Parquet downloads through the pinned transport', () => {
  it('pins a shard URL when DNS answers public then private before connection', async () => {
    const state = await networkFixture();
    const spec = pipelineSpec.parse({
      name: 'pinned shard',
      source: {
        kind: 'parquet',
        urls: [state.url('shard.parquet')],
        table: 'train',
        mapping: { fields: { id: 'id', title: 'title', text: ['body'] } },
      },
    });
    if (spec.source.kind !== 'parquet') throw new Error('expected a Parquet source');
    const source = parquetSourceOf(
      { reader: parquetReader(), workingDirectory: state.root },
      spec.source,
      { resolve: state.resolve },
    );

    const documents = await collect(source.documents());

    expect(documents).toHaveLength(2);
    expect(state.requests).toEqual(['/shard.parquet']);
    expect(state.resolve).toHaveBeenCalledTimes(1);
    expect(state.selected).toEqual([publicAddress]);
    expect(state.selected.filter(blockedAddress)).toEqual([]);
    expect(await readdir(state.root)).toEqual([]);
  });
});
