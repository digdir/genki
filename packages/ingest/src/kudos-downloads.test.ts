import http from 'node:http';
import net, { type AddressInfo, type LookupFunction, type TcpNetConnectOpts } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeKeptConnections,
  HttpStatusError,
  kudosDownloads,
  kudosDownloadsAtOnce,
  kudosDownloadWaitLimitMs,
  kudosFileDownloader,
  type KudosDownloadWait,
  type KudosRateLimiter,
} from './index.js';

const publicAddress = '93.184.216.34';
const servers: http.Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await closeKeptConnections();
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

const listen = async (server: http.Server, port = 0) => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  servers.push(server);
  return (server.address() as AddressInfo).port;
};

/** A port nothing listens on: connecting to it is refused. */
const freePort = async () => {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
};

/** Real sockets: the public fixture address is routed to loopback only at the OS boundary. */
const localNetwork = () => {
  const route =
    (lookup?: LookupFunction): LookupFunction =>
    (host, options, callback) => {
      const done = () =>
        options.all
          ? callback(null, [{ address: '127.0.0.1', family: 4 }])
          : callback(null, '127.0.0.1', 4);
      if (!lookup) return done();
      lookup(host, options, (error) => (error ? callback(error, '') : done()));
    };
  const connect = net.connect;
  vi.spyOn(net, 'connect').mockImplementation(((options: TcpNetConnectOpts) =>
    connect({ ...options, lookup: route(options.lookup) })) as typeof net.connect);
};

const web = { resolve: async () => [publicAddress] };

const noLimits = (): KudosRateLimiter & { pauses: number[] } => {
  const pauses: number[] = [];
  return { pauses, take: async () => undefined, pause: (ms) => void pauses.push(ms) };
};

/** A clock that only moves when something sleeps: each sleeper wakes at its own deadline. */
const fakeClock = () => {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      const wake = t + ms;
      await Promise.resolve();
      t = Math.max(t, wake);
    },
  };
};

const connectError = (code: string) =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });

const url = 'https://kudos.dfo.no/dokument/abc/filer/def.pdf?token=secret';

describe('KUDOS file downloads', () => {
  it('a KUDOS download that cannot connect waits and tries again without using a try', async () => {
    localNetwork();
    const port = await freePort();
    const waits: KudosDownloadWait[] = [];
    const clock = fakeClock();
    const downloads = kudosDownloads({
      limiter: noLimits(),
      now: clock.now,
      random: () => 1,
      onWait: (w) => waits.push(w),
      // KUDOS comes back while the download waits.
      sleep: async (ms) => {
        if (servers.length === 0)
          await listen(
            http.createServer((_req, res) => res.end('%PDF-1.7')),
            port,
          );
        await clock.sleep(ms);
      },
    });
    const download = kudosFileDownloader({ downloads }, web);

    const bytes = await download(`http://kudos.example.test:${port}/files/abc.pdf`);

    expect(new TextDecoder().decode(bytes)).toBe('%PDF-1.7');
    expect(waits).toEqual([{ host: 'kudos.example.test', cause: 'ECONNREFUSED', waitMs: 5000 }]);
  });

  it('one refused connection holds back every KUDOS download in the worker', async () => {
    const clock = fakeClock();
    const downloads = kudosDownloads({ limiter: noLimits(), ...clock, random: () => 1 });
    const calls: Array<[string, number]> = [];
    let refusedOnce = false;
    const a = downloads.run(url, async () => {
      calls.push(['a', clock.now()]);
      if (!refusedOnce) {
        refusedOnce = true;
        throw connectError('UND_ERR_CONNECT_TIMEOUT');
      }
      return 'a';
    });
    // b starts after a was refused, and waits out the same hold.
    while (!refusedOnce) await Promise.resolve();
    await Promise.resolve();
    const b = downloads.run(url, async () => {
      calls.push(['b', clock.now()]);
      return 'b';
    });

    expect(await Promise.all([a, b])).toEqual(['a', 'b']);
    expect(calls.find(([who]) => who === 'b')?.[1]).toBeGreaterThanOrEqual(5000);
  });

  it('429 and 503 from KUDOS wait like a refused connection, 429 as long as Retry-After asks', async () => {
    const clock = fakeClock();
    const limiter = noLimits();
    const waits: KudosDownloadWait[] = [];
    const downloads = kudosDownloads({
      limiter,
      ...clock,
      random: () => 1,
      onWait: (w) => waits.push(w),
    });
    const answers = [
      new HttpStatusError(429, 'HTTP 429', '60'),
      new HttpStatusError(503, 'HTTP 503'),
    ];

    const result = await downloads.run(url, async () => {
      const next = answers.shift();
      if (next) throw next;
      return 'bytes';
    });

    expect(result).toBe('bytes');
    expect(waits.map((w) => [w.cause, w.waitMs])).toEqual([
      ['HTTP 429', 60_000],
      ['HTTP 503', 10_000],
    ]);
    expect(limiter.pauses).toEqual([60_000]);
  });

  it('a KUDOS download still failing after the total wait fails the try', async () => {
    const clock = fakeClock();
    const downloads = kudosDownloads({ limiter: noLimits(), ...clock, random: () => 1 });
    let tries = 0;

    const error = await downloads
      .run(url, async () => {
        tries += 1;
        throw connectError('UND_ERR_CONNECT_TIMEOUT');
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TypeError);
    expect((error as { cause: { code: string } }).cause.code).toBe('UND_ERR_CONNECT_TIMEOUT');
    expect(clock.now()).toBeLessThanOrEqual(kudosDownloadWaitLimitMs);
    expect(clock.now()).toBeGreaterThan(kudosDownloadWaitLimitMs - 2 * 60_000);
    expect(tries).toBeGreaterThan(10);
  });

  it('a 404 from KUDOS, or a body cut off after it answered, fails at once without waiting', async () => {
    for (const failure of [
      new HttpStatusError(404, 'HTTP 404'),
      new TypeError('terminated', {
        cause: Object.assign(new Error(), { code: 'UND_ERR_SOCKET' }),
      }),
    ]) {
      const waits: KudosDownloadWait[] = [];
      const downloads = kudosDownloads({
        limiter: noLimits(),
        ...fakeClock(),
        onWait: (w) => waits.push(w),
      });
      let tries = 0;
      await expect(
        downloads.run(url, async () => {
          tries += 1;
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(tries).toBe(1);
      expect(waits).toEqual([]);
    }
  });

  it('the worker runs at most 2 KUDOS downloads at once', async () => {
    const downloads = kudosDownloads({ limiter: noLimits(), ...fakeClock() });
    let running = 0;
    let most = 0;
    const release: Array<() => void> = [];
    const all = Array.from({ length: 5 }, (_, i) =>
      downloads.run(url, async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise<void>((resolve) => release.push(resolve));
        running -= 1;
        return i;
      }),
    );
    for (let done = 0; done < 5; done++) {
      while (release.length === 0) await new Promise((r) => setImmediate(r));
      release.shift()?.();
    }

    expect(await Promise.all(all)).toEqual([0, 1, 2, 3, 4]);
    expect(most).toBe(2);
  });

  it('KUDOS downloads reuse kept connections, no more than run at once', async () => {
    localNetwork();
    let connections = 0;
    const server = http.createServer((_req, res) => res.end('%PDF-1.7'));
    server.on('connection', () => (connections += 1));
    const port = await listen(server);
    const download = kudosFileDownloader(
      { downloads: kudosDownloads({ limiter: noLimits() }) },
      web,
    );

    for (let i = 0; i < 5; i++) await download(`http://kudos.example.test:${port}/files/${i}.pdf`);

    expect(connections).toBeLessThanOrEqual(kudosDownloadsAtOnce);
  });

  it("a KUDOS download's wait names its host, cause and wait, never the file's path or query", async () => {
    const waits: KudosDownloadWait[] = [];
    const downloads = kudosDownloads({
      limiter: noLimits(),
      ...fakeClock(),
      random: () => 1,
      onWait: (w) => waits.push(w),
    });
    let refused = false;

    await downloads.run(url, async () => {
      if (!refused) {
        refused = true;
        throw connectError('UND_ERR_CONNECT_TIMEOUT');
      }
      return 'bytes';
    });

    expect(waits).toEqual([
      { host: 'kudos.dfo.no', cause: 'UND_ERR_CONNECT_TIMEOUT', waitMs: 5000 },
    ]);
    expect(JSON.stringify(waits)).not.toMatch(/dokument|secret|def\.pdf/);
  });
});
