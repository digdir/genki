import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo, type LookupFunction, type TcpNetConnectOpts } from 'node:net';
import tls, { type ConnectionOptions } from 'node:tls';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { testTlsCertificate } from '../../../scripts/test-tls.js';
import {
  blockedAddress,
  defaultFetchPolicy,
  guardedFetchBytes,
  guardedFetchStream,
  guardedFetchText,
  type HostResolver,
} from './website.js';

const publicAddress = '93.184.216.34';
const policy = { ...defaultFetchPolicy, allowedHosts: new Set<string>() };
let key: Buffer;
let cert: Buffer;
const servers: http.Server[] = [];

beforeAll(async () => {
  ({ key, cert } = await testTlsCertificate());
});

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
});

const listen = async (server: http.Server) => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.push(server);
  return (server.address() as AddressInfo).port;
};

// Exercise the real Agent, HTTP/TLS sockets and fetch body handling without real DNS
// or external traffic. At the OS boundary only, route public fixture addresses to
// loopback; record the original selected address before that routing. If pinning is
// removed, the simulated OS resolver uses the same adversarial DNS answers.
const localNetwork = (resolve: HostResolver) => {
  const selected: string[] = [];
  const names: Array<string | undefined> = [];
  const fallback: LookupFunction = (host, options, callback) => {
    void resolve(host).then(
      (addresses) => {
        const results = addresses.map((address) => ({ address, family: net.isIP(address) }));
        if (options.all) callback(null, results);
        else callback(null, results[0]?.address ?? '', results[0]?.family ?? 0);
      },
      (error: Error) => callback(error, ''),
    );
  };
  const route =
    (lookup: LookupFunction = fallback): LookupFunction =>
    (host, options, callback) => {
      lookup(host, options, (error, address, family) => {
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
  const connect = net.connect;
  vi.spyOn(net, 'connect').mockImplementation(((options: TcpNetConnectOpts) =>
    connect({ ...options, lookup: route(options.lookup) })) as typeof net.connect);
  const secureConnect = tls.connect;
  vi.spyOn(tls, 'connect').mockImplementation(((options: ConnectionOptions) => {
    names.push(options.servername);
    return secureConnect({ ...options, ca: cert, lookup: route(options.lookup) });
  }) as typeof tls.connect);
  return { selected, names };
};

describe('guarded fetch transport', () => {
  it.each(['buffered', 'streaming'])(
    'pins %s connections when a resolver answers public then private',
    async (mode) => {
      const requests: string[] = [];
      const port = await listen(
        http.createServer((req, res) => {
          requests.push(req.headers.host ?? '');
          res.end('public response');
        }),
      );
      const resolve = vi.fn(async () =>
        resolve.mock.calls.length === 1 ? [publicAddress] : ['127.0.0.1'],
      );
      const network = localNetwork(resolve);

      const url = `http://rebind.example.test:${port}/`;
      if (mode === 'buffered') {
        await expect(guardedFetchText(url, policy, 100, { resolve })).resolves.toBe(
          'public response',
        );
      } else {
        const chunks: Uint8Array[] = [];
        await guardedFetchStream(
          url,
          policy,
          100,
          async (chunk) => {
            chunks.push(chunk);
          },
          { resolve },
        );
        expect(Buffer.concat(chunks).toString()).toBe('public response');
      }

      expect(resolve).toHaveBeenCalledTimes(1);
      expect(network.selected).toEqual([publicAddress]);
      expect(network.selected.filter(blockedAddress)).toEqual([]);
      expect(requests).toEqual([`rebind.example.test:${port}`]);
    },
  );

  it('fetches normal public HTTP and HTTPS with the original Host and TLS SNI', async () => {
    const hosts: string[] = [];
    const handle: http.RequestListener = (req, res) => {
      hosts.push(req.headers.host ?? '');
      res.setHeader('content-type', 'text/plain');
      res.end('normal public response');
    };
    const httpPort = await listen(http.createServer(handle));
    const httpsPort = await listen(https.createServer({ key, cert }, handle));
    const resolve = vi.fn(async () => [publicAddress]);
    const network = localNetwork(resolve);

    for (const [protocol, port] of [
      ['http', httpPort],
      ['https', httpsPort],
    ] as const) {
      const result = await guardedFetchBytes(
        `${protocol}://docs.example.test:${port}/data`,
        policy,
        100,
        { resolve },
      );
      expect(new TextDecoder().decode(result.bytes)).toBe('normal public response');
      expect(result.contentType).toBe('text/plain');
      expect(result.headers.get('content-type')).toBe('text/plain');
    }
    expect(hosts).toEqual([`docs.example.test:${httpPort}`, `docs.example.test:${httpsPort}`]);
    expect(network.names).toEqual(['docs.example.test']);
    expect(network.selected).toEqual([publicAddress, publicAddress]);
  });

  it('enforces TLS name verification against the URL hostname', async () => {
    let requests = 0;
    const port = await listen(
      https.createServer({ key, cert }, (_req, res) => {
        requests++;
        res.end('must not be read');
      }),
    );
    const resolve = async () => [publicAddress];
    const network = localNetwork(resolve);

    await expect(
      guardedFetchText(`https://wrong.example.test:${port}/`, policy, 100, { resolve }),
    ).rejects.toMatchObject({ cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } });
    expect(network.names).toEqual(['wrong.example.test']);
    expect(requests).toBe(0);
  });

  it.each(['same host', 'another host'])(
    'revalidates redirects to %s before another connection',
    async (destination) => {
      const requests: string[] = [];
      const port = await listen(
        http.createServer((req, res) => {
          requests.push(req.url ?? '');
          if (req.url === '/') {
            res.writeHead(302, {
              location:
                destination === 'same host'
                  ? '/private'
                  : `http://private.example.test:${port}/private`,
            });
          }
          res.end('redirect body');
        }),
      );
      const resolve = vi.fn(async () =>
        resolve.mock.calls.length === 1 ? [publicAddress] : ['127.0.0.1'],
      );
      const network = localNetwork(resolve);

      await expect(
        guardedFetchText(`http://docs.example.test:${port}/`, policy, 100, { resolve }),
      ).rejects.toThrow(/private or reserved/);
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(network.selected).toEqual([publicAddress]);
      expect(requests).toEqual(['/']);
    },
  );

  it('pins a newly validated public address after a redirect', async () => {
    const port = await listen(
      http.createServer((req, res) => {
        if (req.url === '/') res.writeHead(302, { location: '/next' });
        res.end(req.url === '/' ? 'redirect' : 'next public response');
      }),
    );
    const resolve = vi.fn(async () =>
      resolve.mock.calls.length === 1 ? [publicAddress] : ['8.8.8.8'],
    );
    const network = localNetwork(resolve);

    await expect(
      guardedFetchText(`http://docs.example.test:${port}/`, policy, 100, { resolve }),
    ).resolves.toBe('next public response');
    expect(network.selected).toEqual([publicAddress, '8.8.8.8']);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('refuses a mixed public and private DNS answer before connecting', async () => {
    const send = vi.fn<typeof fetch>();
    await expect(
      guardedFetchBytes('http://docs.example.test/', policy, 100, {
        resolve: async () => [publicAddress, '::ffff:7f00:1'],
        fetch: send,
      }),
    ).rejects.toThrow(/private or reserved/);
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps redirect and byte limits on the pinned transport', async () => {
    const port = await listen(
      http.createServer((req, res) => {
        if (req.url === '/loop') res.writeHead(302, { location: '/loop' });
        res.end('x'.repeat(200));
      }),
    );
    const resolve = async () => [publicAddress];
    const network = localNetwork(resolve);
    await expect(
      guardedFetchText(
        `http://docs.example.test:${port}/loop`,
        { ...policy, maxRedirects: 1 },
        100,
        { resolve },
      ),
    ).rejects.toThrow(/Too many redirects/);
    expect(network.selected).toHaveLength(2);
    await expect(
      guardedFetchText(`http://docs.example.test:${port}/large`, policy, 100, { resolve }),
    ).rejects.toThrow(/size limit/);
  });

  it('cancels a pinned response body when the caller aborts', async () => {
    const controller = new AbortController();
    const port = await listen(
      http.createServer((_req, res) => {
        res.write('partial');
        controller.abort(new Error('execution cancelled'));
      }),
    );
    const resolve = async () => [publicAddress];
    localNetwork(resolve);
    await expect(
      guardedFetchText(`http://docs.example.test:${port}/`, policy, 100, {
        resolve,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/execution cancelled/);
  });

  it('times out a pinned response body', async () => {
    const port = await listen(
      http.createServer((_req, res) => {
        res.write('partial');
      }),
    );
    const resolve = async () => [publicAddress];
    localNetwork(resolve);
    await expect(
      guardedFetchText(
        `http://docs.example.test:${port}/`,
        {
          ...policy,
          connectTimeoutMs: 1000,
          readTimeoutMs: 10,
        },
        100,
        { resolve },
      ),
    ).rejects.toThrow(/abort|timeout/i);
  });
});

const blockedIpv6 = [
  ['mapped loopback, hex', '::ffff:7f00:1'],
  ['mapped private, dotted', '::ffff:10.0.0.1'],
  ['mapped metadata', '::ffff:a9fe:a9fe'],
  ['mapped expanded', '0:0:0:0:0:ffff:7f00:1'],
  ['compatible loopback', '::127.0.0.1'],
  ['compatible private, hex', '::a00:1'],
  ['translated IPv4', '::ffff:0:127.0.0.1'],
  ['NAT64 loopback', '64:ff9b::127.0.0.1'],
  ['NAT64 private, hex', '64:ff9b::a00:1'],
  ['NAT64 local prefix', '64:ff9b:1::a00:1'],
  ['6to4 private gateway', '2002:a00:1::1'],
  ['6to4 public gateway, private suffix', '2002:5db8:d822::a00:1'],
  ['Teredo', '2001:0:4136:e378:8000:63bf:f5ff:fffe'],
  ['benchmarking', '2001:2::1'],
  ['ORCHID', '2001:10::1'],
  ['ORCHIDv2', '2001:20::1'],
  ['ULA fc00', 'fc00::1'],
  ['ULA fd00', 'fd00::1'],
  ['link-local lower bound', 'fe80::1'],
  ['link-local upper bound', 'febf::1'],
  ['deprecated site-local', 'fec0::1'],
  ['unspecified', '::'],
  ['expanded unspecified', '0:0:0:0:0:0:0:0'],
  ['loopback', '::1'],
  ['expanded loopback', '0:0:0:0:0:0:0:1'],
  ['multicast', 'ff02::1'],
  ['documentation', '2001:db8::1'],
] as const;

describe('IPv6 destination rules', () => {
  it.each(blockedIpv6)('refuses %s in URL literals and DNS answers', async (_rule, address) => {
    const send = vi.fn<typeof fetch>();
    expect(blockedAddress(address)).toBe(true);
    for (const url of [`http://[${address}]/`, 'http://docs.example.test/']) {
      await expect(
        guardedFetchBytes(url, policy, 100, {
          resolve: async () => [address],
          fetch: send,
        }),
      ).rejects.toThrow(/private or reserved/);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:93.184.216.34',
    '::ffff:5db8:d822',
  ])('allows public IPv6 or mapped IPv4 %s', (address) => {
    expect(blockedAddress(address)).toBe(false);
  });
});
