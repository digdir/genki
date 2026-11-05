import { createHash } from 'node:crypto';
import { encodeBase64, isMediaInput, type MediaInput } from '@genai/kernel';
import type { RequestEncoding, ResponseEncoding } from './descriptor.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const base64Media = (value: unknown): unknown => {
  if (isMediaInput(value)) return encodeBase64(value.body);
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

/** A file name a provider can read the format from: the part name and the media subtype. */
export const fileNameOf = (part: string, mediaType: string) =>
  `${part.replace(/\[\]$/, '')}.${(mediaType.split('/')[1] ?? 'bin').replace(/^x-/, '').split('+')[0]}`;

const blobOf = (media: MediaInput) =>
  new Blob([media.body as Uint8Array<ArrayBuffer>], { type: media.mediaType });

export interface EncodedBody {
  body?: RequestInit['body'];
  contentType?: string;
}

/** Encodes a walked request body as its step declares; media is already read by the gate. */
export const encodeBody = (encoding: RequestEncoding, value: unknown): EncodedBody => {
  if (value === undefined) return {};
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
      for (const [name, v] of Object.entries(value as Record<string, unknown>))
        if (v !== undefined) form.append(name, fieldText(v));
      return { body: form };
    }
    case 'multipart': {
      const form = new FormData();
      for (const [name, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined) continue;
        if (isMediaInput(v)) form.append(name, blobOf(v), fileNameOf(name, v.mediaType));
        else if (Array.isArray(v)) for (const item of v) form.append(name, fieldText(item));
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
  mediaType?: string,
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
      return type === mediaType;
  }
};

export const acceptOf = (encoding: ResponseEncoding, mediaType?: string) =>
  encoding === 'json'
    ? 'application/json'
    : encoding === 'ndjson'
      ? 'application/x-ndjson'
      : encoding === 'binary'
        ? (mediaType ?? '*/*')
        : 'text/plain';

export class AnswerFormatError extends Error {}

/** Reads an answer body as its step declares; bytes become base64, which the gate keeps as a blob. */
export const decodeAnswer = async (
  encoding: ResponseEncoding,
  response: Response,
  maxBytes: number,
): Promise<unknown> => {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes)
    throw new AnswerFormatError(
      `the answer is ${bytes.byteLength} bytes, over the cap of ${maxBytes}`,
    );
  if (encoding === 'binary') return encodeBase64(bytes);
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
