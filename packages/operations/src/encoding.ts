import { createHash } from 'node:crypto';
import { encodeBase64, isMediaInput, type MediaInput } from '@genai/kernel';
import type { RequestEncoding, ResponseEncoding } from './descriptor.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const base64Media = (value: unknown): unknown => {
  if (isMediaInput(value))
    return (value as { dataUrl?: true }).dataUrl
      ? `data:${value.mediaType};base64,${encodeBase64(value.body)}`
      : encodeBase64(value.body);
  if (Array.isArray(value)) return value.map(base64Media);
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, base64Media(v)]));
  return value;
};

const fieldText = (value: unknown) =>
  typeof value === 'string'
    ? value
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);

/** A file name from a descriptor, cut to a plain name without a path. */
export const safeFileName = (name: string) =>
  name
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/\u0000-\u001f"]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);

/** A file name a provider can read the format from: the part name and the media subtype. */
export const fileNameOf = (part: string, mediaType: string) =>
  `${part.replace(/\[\]$/, '')}.${(mediaType.split('/')[1] ?? 'bin').replace(/^x-/, '').split('+')[0]}`;

const blobOf = (media: MediaInput) =>
  new Blob([media.body as Uint8Array<ArrayBuffer>], { type: media.mediaType });

export interface EncodedBody {
  body?: RequestInit['body'];
  contentType?: string;
}

export interface EncodeOptions {
  /** File names for multipart parts, by part; a part without one is named after its media type. */
  filenames?: Record<string, string>;
  /** Fields the gate adds to a form body, such as a credential. */
  fields?: Record<string, string>;
}

/** Encodes a walked request body as its step declares; media is already read by the gate. */
export const encodeBody = (
  encoding: RequestEncoding,
  value: unknown,
  options: EncodeOptions = {},
): EncodedBody => {
  if (value === undefined && !(encoding === 'form' && options.fields)) return {};
  switch (encoding) {
    case 'json':
      return { body: JSON.stringify(base64Media(value)), contentType: 'application/json' };
    case 'ndjson':
      return {
        body: (value as unknown[]).map((v) => `${JSON.stringify(base64Media(v))}\n`).join(''),
        contentType: 'application/x-ndjson',
      };
    case 'text':
      return { body: String(value), contentType: 'text/plain; charset=utf-8' };
    case 'binary': {
      const media = value as MediaInput;
      return { body: blobOf(media), contentType: media.mediaType };
    }
    case 'form': {
      const form = new URLSearchParams();
      for (const [name, v] of Object.entries((value ?? {}) as Record<string, unknown>))
        if (v !== undefined) form.append(name, fieldText(v));
      for (const [name, v] of Object.entries(options.fields ?? {})) form.set(name, v);
      return { body: form };
    }
    case 'multipart': {
      const form = new FormData();
      for (const [name, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined) continue;
        const given = options.filenames?.[name];
        if (isMediaInput(v))
          form.append(name, blobOf(v), given ? safeFileName(given) : fileNameOf(name, v.mediaType));
        else if (Array.isArray(v))
          for (const item of v)
            if (isMediaInput(item))
              form.append(
                name,
                blobOf(item),
                given ? safeFileName(given) : fileNameOf(name, item.mediaType),
              );
            else form.append(name, fieldText(item));
        else form.append(name, fieldText(v));
      }
      return { body: form };
    }
  }
};

const digest = (mediaType: string, bytes: Uint8Array) => ({
  mediaType,
  bytes: bytes.byteLength,
  sha256: createHash('sha256').update(bytes).digest('hex'),
});

const added = (out: Record<string, unknown>, name: string, value: unknown) => {
  const before = out[name];
  out[name] =
    before === undefined ? value : Array.isArray(before) ? [...before, value] : [before, value];
};

/** What a request body held, as a fixture records it: media as its type, size and SHA-256. */
export const recordedBody = async (
  body: RequestInit['body'],
  contentType: string | null,
): Promise<unknown> => {
  if (body === undefined || body === null) return undefined;
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (body instanceof FormData) {
    const out: Record<string, unknown> = {};
    for (const [name, value] of body.entries())
      added(
        out,
        name,
        typeof value === 'string'
          ? value
          : digest(value.type, new Uint8Array(await value.arrayBuffer())),
      );
    return out;
  }
  if (body instanceof URLSearchParams) {
    const out: Record<string, unknown> = {};
    for (const [name, value] of body.entries()) added(out, name, value);
    return out;
  }
  if (body instanceof Blob)
    return digest(body.type || type, new Uint8Array(await body.arrayBuffer()));
  if (body instanceof Uint8Array) return digest(type, body);
  const text = String(body);
  if (type === 'application/json') return JSON.parse(text) as unknown;
  if (type === 'application/x-ndjson')
    return text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as unknown);
  return text;
};

const ndjsonTypes = new Set([
  'application/x-ndjson',
  'application/ndjson',
  'application/jsonl',
  'application/x-jsonlines',
  'application/jsonlines',
]);

/** Whether an answer's content type is the one its step declares. */
export const contentTypeFits = (
  encoding: ResponseEncoding,
  contentType: string | null,
  mediaTypes: readonly string[] = [],
): boolean => {
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  switch (encoding) {
    case 'json':
      return type === 'application/json' || /^application\/[a-z0-9.-]+\+json$/.test(type);
    case 'ndjson':
      return ndjsonTypes.has(type);
    case 'text':
      return type.startsWith('text/');
    case 'binary':
      return mediaTypes.includes(type);
  }
};

export const acceptOf = (encoding: ResponseEncoding, mediaTypes: readonly string[] = []) =>
  encoding === 'json'
    ? 'application/json'
    : encoding === 'ndjson'
      ? 'application/x-ndjson'
      : encoding === 'binary'
        ? mediaTypes.length > 0
          ? mediaTypes.join(', ')
          : '*/*'
        : 'text/plain';

export class AnswerFormatError extends Error {}

/** Reads an answer body as its step declares; bytes become base64, which the gate keeps as a blob. */
export const decodeAnswer = async (
  encoding: ResponseEncoding,
  response: Response,
  maxBytes: number,
  mediaTypes: readonly string[] = [],
): Promise<unknown> => {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes)
    throw new AnswerFormatError(
      `the answer is ${bytes.byteLength} bytes, over the cap of ${maxBytes}`,
    );
  if (encoding === 'binary') {
    const data = encodeBase64(bytes);
    if (mediaTypes.length < 2) return data;
    return {
      mediaType: (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase(),
      data,
    };
  }
  const text = new TextDecoder().decode(bytes);
  if (encoding === 'text') return text;
  try {
    if (encoding === 'json') return JSON.parse(text) as unknown;
    return text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as unknown);
  } catch {
    throw new AnswerFormatError(`the answer is not ${encoding}`);
  }
};

export interface Frame {
  event?: string;
  data: string;
}

/** Reads a streamed answer frame by frame, never holding more than the byte cap. */
export async function* readFrames(
  response: Response,
  framing: 'sse' | 'ndjson' | 'lines',
  maxBytes: number,
): AsyncGenerator<Frame> {
  if (!response.body) return;
  const decoder = new TextDecoder();
  let total = 0;
  let buffer = '';
  let event: string | undefined;
  let data: string[] = [];
  const line = function* (text: string): Generator<Frame> {
    if (framing !== 'sse') {
      if (text.trim()) yield { data: text };
      return;
    }
    if (text === '') {
      if (data.length > 0) yield { ...(event ? { event } : {}), data: data.join('\n') };
      event = undefined;
      data = [];
    } else if (!text.startsWith(':')) {
      const at = text.indexOf(':');
      const field = at === -1 ? text : text.slice(0, at);
      const value = at === -1 ? '' : text.slice(at + 1).replace(/^ /, '');
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
    }
  };
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes)
        throw new AnswerFormatError(`the stream is over the cap of ${maxBytes} bytes`);
      buffer += decoder.decode(value, { stream: true });
      let at = buffer.search(/\r\n|\n|\r/);
      while (at !== -1 && !(at === buffer.length - 1 && buffer[at] === '\r')) {
        const width = buffer.startsWith('\r\n', at) ? 2 : 1;
        yield* line(buffer.slice(0, at));
        buffer = buffer.slice(at + width);
        at = buffer.search(/\r\n|\n|\r/);
      }
    }
    buffer += decoder.decode();
    if (buffer) yield* line(buffer);
    if (framing === 'sse' && data.length > 0)
      yield { ...(event ? { event } : {}), data: data.join('\n') };
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const sseTypes = new Set(['text/event-stream']);

/** Whether a streamed answer's content type is the one its framing names. */
export const streamTypeFits = (framing: 'sse' | 'ndjson' | 'lines', contentType: string | null) => {
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return framing === 'sse'
    ? sseTypes.has(type)
    : framing === 'ndjson'
      ? ndjsonTypes.has(type)
      : type.startsWith('text/');
};
