import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { acceptWebSocket, type SessionChannels, type SessionEnd } from '@genai/operations';

const closeCodes: Record<SessionEnd | 'error', number> = {
  done: 1000,
  closed: 1000,
  longest: 4001,
  demoted: 4002,
  cancelled: 1001,
  error: 1011,
};

const statusLine = (status: number) =>
  status === 401
    ? 'Unauthorized'
    : status === 403
      ? 'Forbidden'
      : status === 426
        ? 'Upgrade Required'
        : 'Bad Request';

const refuse = async (socket: Duplex, response: Response) => {
  const body = await response.text();
  socket.end(
    `HTTP/1.1 ${response.status} ${statusLine(response.status)}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
};

const requestOf = (request: IncomingMessage) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers))
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  return new Request(`http://${request.headers.host ?? 'localhost'}${request.url ?? '/'}`, {
    method: 'GET',
    headers,
  });
};

/** Sends `GET /v1/sessions` upgrades through the same app as every other route, then hands the socket to the session. */
export const attachSessionUpgrade = (
  server: Pick<Server, 'on'>,
  app: { fetch(request: Request): Response | Promise<Response> },
  channels: SessionChannels,
) => {
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path !== '/v1/sessions') {
      socket.destroy();
      return;
    }
    socket.on('error', () => socket.destroy());
    void (async () => {
      const response = await app.fetch(requestOf(request));
      const task = response.headers.get('genai-session');
      if (response.status !== 200 || !task) return refuse(socket, response);
      const peer = acceptWebSocket(request, socket, head);
      if (!peer) return;
      channels.provide(task, {
        incoming: peer.messages(),
        send: (message) => peer.send(message),
        close: (end) => peer.close(closeCodes[end]),
      });
    })().catch(() => socket.destroy());
  });
};
