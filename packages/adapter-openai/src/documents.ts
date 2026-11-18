import type { Part, Principal } from '@genai/contracts';

export const documentsField = 'genai_documents';

export const documentLimits = { maxBytes: 2 * 1024 * 1024, maxCount: 5 };

export interface RuntimeDocument {
  name: string;
  mediaType: string;
  body: Uint8Array;
  asFile?: boolean;
}

export interface RuntimeDocumentStore {
  store(
    principal: Principal,
    documents: RuntimeDocument[],
    capability: string,
    conversation?: string,
  ): Promise<Part[]>;
}

export type DocumentProblem = {
  code:
    | 'invalid_documents'
    | 'documents_not_accepted'
    | 'document_too_large'
    | 'unsupported_document_type';
  message: string;
  status: 400 | 413 | 415;
};

const base64 = /^[A-Za-z0-9+/]*={0,2}$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });

const bareType = (mediaType: string) => mediaType.split(';')[0]?.trim().toLowerCase() ?? '';

export const readDocuments = (
  raw: unknown,
  accepts: string[] | undefined,
): RuntimeDocument[] | DocumentProblem => {
  const invalid = (message: string): DocumentProblem => ({
    code: 'invalid_documents',
    message,
    status: 400,
  });
  if (!Array.isArray(raw)) return invalid('`genai_documents` must be a list.');
  if (raw.length === 0) return [];
  if (!accepts?.length)
    return {
      code: 'documents_not_accepted',
      message: 'This service does not take documents.',
      status: 400,
    };
  if (raw.length > documentLimits.maxCount)
    return invalid(`Send at most ${documentLimits.maxCount} documents.`);
  const out: RuntimeDocument[] = [];
  for (const [i, item] of raw.entries()) {
    const { name, media_type: mediaType, data } = (item ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim() || typeof mediaType !== 'string')
      return invalid(`genai_documents[${i}] needs a name and a media_type.`);
    if (typeof data !== 'string' || !base64.test(data))
      return invalid(`genai_documents[${i}].data must be base64.`);
    const type = bareType(mediaType);
    if (!accepts.includes(type))
      return {
        code: 'unsupported_document_type',
        message: `This service takes ${accepts.join(', ')}, not ${type}.`,
        status: 415,
      };
    const body = new Uint8Array(Buffer.from(data, 'base64'));
    if (body.byteLength > documentLimits.maxBytes)
      return {
        code: 'document_too_large',
        message: `Each document can be at most ${documentLimits.maxBytes} bytes.`,
        status: 413,
      };
    try {
      utf8.decode(body);
    } catch {
      return {
        code: 'unsupported_document_type',
        message: `genai_documents[${i}] is not readable text.`,
        status: 415,
      };
    }
    out.push({ name: name.trim().slice(0, 200), mediaType: type, body });
  }
  return out;
};

export const mediaLimits = { maxBytes: 10 * 1024 * 1024, maxCount: 5 };

const audioTypes: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav' };

const dataUrl = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/;

/** Reads `input_audio`, data-URL `image_url` and `file` content parts of a message into files the caller sends. */
export const readMedia = (
  content: unknown,
  accepts: string[] | undefined,
  fileAccepts: string[] | undefined = undefined,
): RuntimeDocument[] | DocumentProblem => {
  if (!Array.isArray(content)) return [];
  const invalid = (message: string): DocumentProblem => ({
    code: 'invalid_documents',
    message,
    status: 400,
  });
  const found: { name: string; mediaType: string; data: string; file: boolean }[] = [];
  for (const part of content) {
    const p = (part ?? {}) as Record<string, unknown>;
    if (p.type === 'input_audio') {
      const { data, format } = (p.input_audio ?? {}) as Record<string, unknown>;
      if (typeof data !== 'string' || typeof format !== 'string')
        return invalid('`input_audio` needs `data` and `format`.');
      const type = audioTypes[format.toLowerCase()] ?? `audio/${format.toLowerCase()}`;
      found.push({ name: `audio.${format.toLowerCase()}`, mediaType: type, data, file: false });
    } else if (p.type === 'image_url') {
      const url = ((p.image_url ?? {}) as Record<string, unknown>).url;
      const match = typeof url === 'string' ? dataUrl.exec(url) : null;
      if (!match) return invalid('`image_url.url` must be a base64 data URL.');
      const type = (match[1] ?? '').toLowerCase();
      found.push({
        name: `image.${type.split('/')[1] ?? 'bin'}`,
        mediaType: type,
        data: match[2] ?? '',
        file: false,
      });
    } else if (p.type === 'file') {
      const { file_data: data, filename } = (p.file ?? {}) as Record<string, unknown>;
      const match = typeof data === 'string' ? dataUrl.exec(data) : null;
      if (!match)
        return invalid('`file.file_data` must be a base64 data URL; `file_id` is not supported.');
      const type = bareType(match[1] ?? '');
      found.push({
        name:
          typeof filename === 'string' && filename.trim()
            ? filename.trim().slice(0, 200)
            : `file.${type.split('/')[1] ?? 'bin'}`,
        mediaType: type,
        data: match[2] ?? '',
        file: true,
      });
    }
  }
  if (found.length === 0) return [];
  if (found.some((f) => !f.file) && !accepts?.length)
    return {
      code: 'documents_not_accepted',
      message: 'This service does not take audio or images.',
      status: 400,
    };
  if (found.some((f) => f.file) && !fileAccepts?.length)
    return {
      code: 'documents_not_accepted',
      message: 'This service does not take files.',
      status: 400,
    };
  if (found.length > mediaLimits.maxCount)
    return invalid(`Send at most ${mediaLimits.maxCount} audio, image or file parts.`);
  const out: RuntimeDocument[] = [];
  for (const item of found) {
    const taken = (item.file ? fileAccepts : accepts) ?? [];
    if (!taken.includes(item.mediaType))
      return {
        code: 'unsupported_document_type',
        message: `This service takes ${taken.join(', ')}, not ${item.mediaType}.`,
        status: 415,
      };
    if (!base64.test(item.data)) return invalid(`${item.name} is not base64.`);
    const body = new Uint8Array(Buffer.from(item.data, 'base64'));
    if (body.byteLength > mediaLimits.maxBytes)
      return {
        code: 'document_too_large',
        message: `Each audio, image or file part can be at most ${mediaLimits.maxBytes} bytes.`,
        status: 413,
      };
    if (item.file && item.mediaType.startsWith('text/'))
      try {
        utf8.decode(body);
      } catch {
        return {
          code: 'unsupported_document_type',
          message: `${item.name} is not readable text.`,
          status: 415,
        };
      }
    out.push({
      name: item.name,
      mediaType: item.mediaType,
      body,
      ...(item.file ? { asFile: true } : {}),
    });
  }
  return out;
};
