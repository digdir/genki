import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EgressGuard } from '@genai/providers-mcp-client';
import { afterEach, describe, expect, it } from 'vitest';
import { guardedSend } from './external-search.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

const redirecting = async () => {
  const seen: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers['x-api-key'] as string | undefined);
    res.writeHead(307, { location: '/annet-sok' });
    res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/sok`, seen };
};

describe('an organisation search endpoint', () => {
  it('refuses a redirect, even to the same host, and sends the key once', async () => {
    const server = await redirecting();
    const send = guardedSend(
      new EgressGuard({ testOverride: { allowLoopback: true, allowHttp: true } }),
    );
    await expect(
      send(
        server.url,
        { headers: { 'x-api-key': 'hemmelig' }, body: '{}' },
        AbortSignal.timeout(5000),
      ),
    ).rejects.toMatchObject({ code: 'redirect_refused' });
    expect(server.seen).toEqual(['hemmelig']);
  });
});
