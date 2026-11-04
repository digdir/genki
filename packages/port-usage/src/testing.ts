import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { UsageGatewayError, type UsageBucket, type UsageGateway } from './usage.js';

export interface UsageServer {
  url: string;
  requests: { path: string; headers: IncomingHttpHeaders }[];
  failWith(status: number | undefined, headers?: Record<string, string>): void;
  close(): Promise<void>;
}

const problem = (status: number, title: string, errors: unknown[] = []) =>
  JSON.stringify({ type: 'about:blank', title, status, ...(errors.length ? { errors } : {}) });

/** Serves a gateway's `GET /v1/usage` over HTTP as the contract describes, behind a client key. */
export const serveUsageGateway = async (
  gateway: UsageGateway,
  options: { clientKey: string },
): Promise<UsageServer> => {
  const requests: UsageServer['requests'] = [];
  let failure: { status: number; headers: Record<string, string> } | undefined;
  const server = createServer((req, res) => {
    requests.push({ path: req.url ?? '', headers: req.headers });
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, {
        'content-type': status < 300 ? 'application/json' : 'application/problem+json',
        ...headers,
      });
      res.end(body);
    };
    if (req.headers.authorization !== `Bearer ${options.clientKey}`)
      return send(401, problem(401, 'Unauthorized'));
    if (failure) return send(failure.status, problem(failure.status, 'Failed'), failure.headers);
    const url = new URL(req.url ?? '/', 'http://gateway');
    if (req.method !== 'GET' || url.pathname !== '/v1/usage')
      return send(404, problem(404, 'Not found'));
    const p = url.searchParams;
    const known = ['from', 'to', 'bucket', 'groupBy', 'subject', 'org', 'cursor'];
    const unknown = [...p.keys()].filter((k) => !known.includes(k));
    if (unknown.length > 0)
      return send(
        400,
        problem(
          400,
          'Invalid request',
          unknown.map((path) => ({ path, message: 'is not a parameter' })),
        ),
      );
    const optional = (name: string) => {
      const value = p.get(name);
      return value === null ? {} : { [name]: value };
    };
    gateway
      .query({
        from: new Date(p.get('from') ?? ''),
        to: new Date(p.get('to') ?? ''),
        bucket: (p.get('bucket') ?? '') as UsageBucket,
        ...(p.get('groupBy') ? { groupBy: (p.get('groupBy') ?? '').split(',') } : {}),
        ...optional('subject'),
        ...optional('org'),
        ...optional('cursor'),
      })
      .then(
        (page) => send(200, JSON.stringify({ ...page, extraField: 'ignored by genki' })),
        (error: unknown) =>
          error instanceof UsageGatewayError
            ? send(error.status, problem(error.status, error.message, error.errors))
            : send(502, problem(502, 'Bad gateway')),
      );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    failWith: (status, headers = {}) => {
      failure = status === undefined ? undefined : { status, headers };
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
