import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SeenRequest {
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

export interface FakeReply {
  status: number;
  json?: unknown;
  sse?: { event?: string; data: unknown }[];
  delayMs?: number;
}

export interface FakeServer {
  url: string;
  seen: SeenRequest[];
  close(): Promise<void>;
}

export const fakeHttp = async (
  reply: (body: Record<string, unknown>, attempt: number, path: string) => FakeReply,
): Promise<FakeServer> => {
  const seen: SeenRequest[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      seen.push({ path: req.url ?? '', headers: req.headers, body });
      const r = reply(body, seen.length, req.url ?? '');
      setTimeout(() => {
        if (r.sse) {
          res.writeHead(r.status, { 'content-type': 'text/event-stream' });
          for (const frame of r.sse) {
            const data = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
            res.write(`${frame.event ? `event: ${frame.event}\n` : ''}data: ${data}\n\n`);
          }
          res.end();
          return;
        }
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.json ?? {}));
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
