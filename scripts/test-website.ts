import https from 'node:https';
import type { RequestListener } from 'node:http';
import type { AddressInfo, LookupFunction } from 'node:net';
import tls, { type ConnectionOptions } from 'node:tls';
import { vi } from 'vitest';
import { testTlsCertificate } from './test-tls.js';

/** Real HTTPS fixture; only the final socket lookup routes a validated public IP to loopback. */
export const testWebsite = async (handle: RequestListener) => {
  const { key, cert } = await testTlsCertificate();
  const server = https.createServer({ key, cert }, handle);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const connect = tls.connect;
  const spy = vi.spyOn(tls, 'connect').mockImplementation(((options: ConnectionOptions) => {
    const lookup: LookupFunction = (_host, lookupOptions, callback) => {
      if (lookupOptions.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
      else callback(null, '127.0.0.1', 4);
    };
    return connect({ ...options, ca: cert, lookup });
  }) as typeof tls.connect);
  return {
    url: `https://docs.example.test:${(server.address() as AddressInfo).port}`,
    web: { resolve: async () => ['93.184.216.34'] },
    close: async () => {
      spy.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
};
