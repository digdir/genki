import https from 'node:https';
import type { AddressInfo } from 'node:net';
import tls, { type ConnectionOptions } from 'node:tls';
import { vi } from 'vitest';
import { testTlsCertificate } from './test-tls.js';

/** Public fixture hosts use real TLS sockets, routed to loopback at the OS boundary. */
export const localWebsite = async () => {
  const { key, cert } = await testTlsCertificate(['docs.example.test', 'mirror.example.test']);
  const pages = new Map<string, string>();
  const redirects = new Map<string, string>();
  const requests: string[] = [];
  const server = https.createServer({ key, cert }, (req, res) => {
    const url = `https://${req.headers.host}${req.url}`;
    requests.push(url);
    const redirect = redirects.get(url);
    if (redirect) {
      res.writeHead(302, { location: redirect });
      res.end();
      return;
    }
    const body = pages.get(url);
    res.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/plain' });
    res.end(body ?? 'missing fixture');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const connect = tls.connect;
  const connection = vi.spyOn(tls, 'connect').mockImplementation(((options: ConnectionOptions) =>
    connect({
      ...options,
      ca: cert,
      lookup: (_host, lookupOptions, callback) => {
        if (lookupOptions.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
        else callback(null, '127.0.0.1', 4);
      },
    })) as typeof tls.connect);
  return {
    pages,
    redirects,
    requests,
    mirror: `https://mirror.example.test:${port}/altinn-studio-docs/`,
    real: `https://docs.example.test:${port}/`,
    web: { resolve: async () => ['93.184.216.34'] },
    close: async () => {
      connection.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
};
