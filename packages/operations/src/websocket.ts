import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

export type WsMessage = { kind: 'text'; text: string } | { kind: 'binary'; bytes: Uint8Array };

export interface WsPeer {
  messages(): AsyncIterable<WsMessage>;
  send(message: WsMessage): void;
  close(code?: number, reason?: string): void;
}

const guid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const queue = <T>() => {
  const items: T[] = [];
  let waiting: ((r: IteratorResult<T>) => void) | undefined;
  let done = false;
  return {
    push(item: T) {
      if (waiting) {
        const w = waiting;
        waiting = undefined;
        w({ value: item, done: false });
      } else items.push(item);
    },
    end() {
      done = true;
      if (waiting) {
        const w = waiting;
        waiting = undefined;
        w({ value: undefined, done: true });
      }
    },
    iterable: {
      [Symbol.asyncIterator]: (): AsyncIterator<T> => ({
        next: () =>
          items.length > 0
            ? Promise.resolve({ value: items.shift() as T, done: false })
            : done
              ? Promise.resolve({ value: undefined, done: true })
              : new Promise((resolve) => {
                  waiting = resolve;
                }),
      }),
    } as AsyncIterable<T>,
  };
};

const frame = (opcode: number, payload: Buffer): Buffer => {
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65_536
        ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
        : Buffer.concat([
            Buffer.from([0x80 | opcode, 127]),
            (() => {
              const b = Buffer.alloc(8);
              b.writeBigUInt64BE(BigInt(length));
              return b;
            })(),
          ]);
  return Buffer.concat([header, payload]);
};

const refuseUpgrade = (socket: Duplex, status: number, text: string) => {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
};

export const rejectUpgrade = refuseUpgrade;

/** Completes the handshake of a WebSocket upgrade and reads frames from the client; for the server side of a relay. */
export const acceptWebSocket = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: { maxBytes?: number } = {},
): WsPeer | undefined => {
  const key = request.headers['sec-websocket-key'];
  if (
    request.headers.upgrade?.toLowerCase() !== 'websocket' ||
    typeof key !== 'string' ||
    request.headers['sec-websocket-version'] !== '13'
  ) {
    refuseUpgrade(socket, 400, 'Bad Request');
    return undefined;
  }
  const maxBytes = options.maxBytes ?? 1_048_576;
  const accept = createHash('sha1').update(`${key}${guid}`).digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const inbox = queue<WsMessage>();
  let buffer: Buffer = Buffer.from(head);
  let parts: Buffer[] = [];
  let kind: 'text' | 'binary' | undefined;
  let closed = false;
  const close = (code = 1000, reason = '') => {
    if (closed) return;
    closed = true;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    socket.write(frame(8, body), () => socket.end());
    inbox.end();
  };
  const read = () => {
    for (;;) {
      if (buffer.length < 2) return;
      const first = buffer[0] as number;
      const second = buffer[1] as number;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let at = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(maxBytes)) return close(1009, 'message too big');
        length = Number(big);
        at = 10;
      }
      if (!masked) return close(1002, 'client frames are masked');
      if (length > maxBytes) return close(1009, 'message too big');
      if (buffer.length < at + 4 + length) return;
      const mask = buffer.subarray(at, at + 4);
      const payload = Buffer.from(buffer.subarray(at + 4, at + 4 + length));
      for (let i = 0; i < payload.length; i += 1)
        payload[i] = (payload[i] as number) ^ (mask[i % 4] as number);
      buffer = buffer.subarray(at + 4 + length);
      const opcode = first & 0x0f;
      const fin = (first & 0x80) !== 0;
      if (opcode === 8) return close(1000);
      if (opcode === 9) {
        socket.write(frame(10, payload));
        continue;
      }
      if (opcode === 10) continue;
      if (opcode === 1 || opcode === 2) {
        if (kind) return close(1002, 'a new message began inside another');
        kind = opcode === 1 ? 'text' : 'binary';
        parts = [];
      } else if (opcode !== 0 || !kind) return close(1002, 'unexpected frame');
      parts.push(payload);
      if (parts.reduce((n, p) => n + p.length, 0) > maxBytes) return close(1009, 'message too big');
      if (fin) {
        const all = Buffer.concat(parts);
        inbox.push(
          kind === 'text'
            ? { kind: 'text', text: all.toString('utf8') }
            : { kind: 'binary', bytes: new Uint8Array(all) },
        );
        kind = undefined;
        parts = [];
      }
    }
  };
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    read();
  });
  socket.on('close', () => {
    closed = true;
    inbox.end();
  });
  socket.on('error', () => {
    closed = true;
    inbox.end();
  });
  if (buffer.length > 0) read();
  return {
    messages: () => inbox.iterable,
    send: (message) => {
      if (closed) return;
      socket.write(
        message.kind === 'text'
          ? frame(1, Buffer.from(message.text, 'utf8'))
          : frame(2, Buffer.from(message.bytes)),
      );
    },
    close,
  };
};

export interface ProviderSocket {
  messages(): AsyncIterable<WsMessage>;
  send(message: WsMessage): void;
  close(): void;
}

export type ConnectProvider = (
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
) => Promise<ProviderSocket>;

/** Opens a client WebSocket with the platform's own implementation; the endpoint's connect replaces it in tests. */
export const connectWebSocket: ConnectProvider = (url, headers, signal) =>
  new Promise((resolve, reject) => {
    const socket = new (
      WebSocket as unknown as new (
        url: string,
        options: { headers: Record<string, string> },
      ) => WebSocket
    )(url, { headers });
    socket.binaryType = 'arraybuffer';
    const inbox = queue<WsMessage>();
    const fail = (message: string) => reject(new Error(message));
    signal?.addEventListener('abort', () => socket.close());
    socket.addEventListener('open', () =>
      resolve({
        messages: () => inbox.iterable,
        send: (message) =>
          socket.send(
            message.kind === 'text' ? message.text : (message.bytes as Uint8Array<ArrayBuffer>),
          ),
        close: () => socket.close(),
      }),
    );
    socket.addEventListener('message', (event) => {
      const data = event.data as string | ArrayBuffer;
      inbox.push(
        typeof data === 'string'
          ? { kind: 'text', text: data }
          : { kind: 'binary', bytes: new Uint8Array(data) },
      );
    });
    socket.addEventListener('close', () => inbox.end());
    socket.addEventListener('error', () => {
      fail('the provider did not accept the session');
      inbox.end();
    });
  });
