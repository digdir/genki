import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { UsageGatewayError, type GatewayUsageRequest, type UsageGateway } from './usage.js';

export interface UsageServer {
  url: string;
  requests: { method: string; path: string; headers: IncomingHttpHeaders; body: string }[];
  failWith(status: number | undefined, headers?: Record<string, string>, body?: string): void;
  answerWith(body: string): void;
  close(): Promise<void>;
}

const problem = (status: number, title: string, errors: unknown[] = []) =>
  JSON.stringify({ type: 'about:blank', title, status, ...(errors.length ? { errors } : {}) });

export const serveUsageGateway = async (
  gateway: UsageGateway,
  options: { token: string },
): Promise<UsageServer> => {
  const requests: UsageServer['requests'] = [];
  let failure: { status: number; headers: Record<string, string>; body?: string } | undefined;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
      const send = (status: number, text: string, headers: Record<string, string> = {}) => {
        res.writeHead(status, {
          'content-type': status < 300 ? 'application/json' : 'application/problem+json',
          ...headers,
        });
        res.end(text);
      };
      if (req.headers.authorization !== `Bearer ${options.token}`)
        return send(401, problem(401, 'Unauthorized'));
      if (failure)
        return send(
          failure.status,
          failure.body ?? problem(failure.status, 'Failed'),
          failure.headers,
        );
      if (req.method !== 'POST' || req.url !== '/usage')
        return send(404, problem(404, 'Not found'));
      let parsed: GatewayUsageRequest;
      try {
        parsed = JSON.parse(body) as GatewayUsageRequest;
      } catch {
        return send(400, problem(400, 'Invalid request'));
      }
      gateway.query(parsed).then(
        (answer) => send(200, JSON.stringify({ ...answer, extraField: 'ignored by genki' })),
        (error: unknown) =>
          error instanceof UsageGatewayError
            ? send(error.status, problem(error.status, error.message, error.errors))
            : send(502, problem(502, 'Bad gateway')),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    failWith: (status, headers = {}, body) => {
      failure =
        status === undefined
          ? undefined
          : { status, headers, ...(body === undefined ? {} : { body }) };
    },
    answerWith: (body) => {
      failure = { status: 200, headers: {}, body };
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
