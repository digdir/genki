import type { Part, Principal } from '@genai/contracts';

export const documentsField = 'genai_documents';

export const documentLimits = { maxBytes: 2 * 1024 * 1024, maxCount: 5 };

export interface RuntimeDocument {
  name: string;
  mediaType: string;
  body: Uint8Array;
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
