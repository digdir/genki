import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { EgressGuard } from './egress.js';

describe('the egress guard', () => {
  it('returns the raw bytes of a response beside its text', async () => {
    const zipStart = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0xe6]);
    const server = createServer((_req, res) => res.end(zipStart));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const guard = new EgressGuard({ testOverride: { allowLoopback: true, allowHttp: true } });

    const response = await guard.request(
      [{ host: '127.0.0.1', port }],
      `http://127.0.0.1:${port}/statsregnskapet.zip`,
      { method: 'GET' },
    );
    await new Promise((resolve) => server.close(resolve));

    expect(response.status).toBe(200);
    expect(Buffer.from(response.bytes ?? new Uint8Array())).toEqual(zipStart);
    expect(response.body).toBe(zipStart.toString('utf8'));
  });
});
