import { authHeaders, type Credential } from '@genai/kernel';
import { Agent, fetch, FormData } from 'undici';
import {
  ConversionRefused,
  type ConverterIdentity,
  type DocumentConverter,
  type DocumentFile,
} from './converter.js';
import { doclingPages, type DoclingDocument } from './docling-pages.js';

/**
 * Docling as the knowledge worker's PDF converter (ADR 0042, "Conversion"): the server of
 * `docker/docling`, its version as `docker/docling/requirements.txt` pins it, and the settings each
 * request asks for. The server reports neither, so the client names them; they are part of each
 * conversion's key and Blob path, beside the seeded export's Docling 2.123.1 with EasyOCR.
 */
export const doclingIdentity: ConverterIdentity = {
  name: 'docling',
  version: '2.146.0',
  settings: { pipeline: 'standard', ocr: 'tesseract', languages: ['nor'], tableformer: 'accurate' },
};

/**
 * How long Docling may work on one file before it stops on its own: 5 h 50 min, below the server's
 * own wait of 6 h (`DOCLING_SERVE_MAX_SYNC_WAIT`). The server does not stop a conversion when it
 * gives up waiting or the client leaves, so without this an abandoned file holds its replica (one
 * conversion each) and later requests queue behind it.
 */
export const doclingDocumentTimeoutSeconds = 21_000;

/** How long the client waits for an answer: a minute past the server's 6 h wait. */
export const doclingHeadersTimeoutMs = 21_660_000;

/** TCP keepalive probes on a connection that sends nothing while Docling works (infra/README.md). */
export const doclingKeepAliveMs = 30_000;

/**
 * An answer that is not about the file: a status, a body the client cannot read or a failure of a
 * kind it does not know. Its job is tried again and then dead-lettered (ADR 0042). The message
 * names no file, since the server's details can.
 */
export class DoclingFailed extends Error {
  override readonly name = 'DoclingFailed';
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Docling answered HTTP ${status}: ${detail}`);
  }
}

export interface DoclingOptions {
  /** The server, `DOCLING_URL`. */
  url: string;
  /** The key the server asks for in `X-Api-Key`, `DOCLING_API_KEY`. */
  credential: Credential;
  headersTimeoutMs?: number;
  documentTimeoutSeconds?: number;
}

interface DoclingError {
  component_type?: string;
  category?: string;
}

interface DoclingAnswer {
  status?: string;
  errors?: DoclingError[];
  document?: { json_content?: unknown };
}

type RawJson = (source: string) => unknown;
type SourceReviver = (key: string, value: unknown, context?: { source?: string }) => unknown;

/**
 * JSON read so integers beyond 2^53 keep their digits: Docling writes `origin.binary_hash` as a
 * 64-bit integer, and the native output is written back as the server gave it.
 */
const exactJson = (text: string): unknown => {
  const rawJSON = (JSON as unknown as { rawJSON?: RawJson }).rawJSON;
  const reviver: SourceReviver = (_key, value, context) =>
    typeof value === 'number' &&
    !Number.isSafeInteger(value) &&
    rawJSON &&
    context?.source !== undefined &&
    /^-?\d+$/.test(context.source)
      ? rawJSON(context.source)
      : value;
  return JSON.parse(text, reviver as Parameters<typeof JSON.parse>[1]);
};

const categories = (answer: DoclingAnswer) =>
  (answer.errors ?? []).map((e) => e.category ?? 'none');

/**
 * What a failure body means: a file Docling cannot open (`backend_failure` from the user's input)
 * is `conversion_failed`; one over the server's limits (`policy`) or its document timeout
 * (`partial_success` with `timeout` errors) is `too_large`. Anything else is not about the file.
 */
const refusalOf = (answer: DoclingAnswer) => {
  const errors = answer.errors ?? [];
  const kinds = categories(answer);
  if (answer.status === 'failure' && kinds.includes('policy')) return 'too_large';
  if (
    answer.status === 'failure' &&
    errors.length > 0 &&
    errors.every((e) => e.category === 'backend_failure' && e.component_type === 'user_input')
  )
    return 'conversion_failed';
  if (answer.status === 'partial_success' && kinds.includes('timeout')) return 'too_large';
  return undefined;
};

/**
 * Whether a file is a PDF by its first bytes: the header `%PDF-` within its first 1,024 bytes. A
 * KUDOS file is named by its id alone, and a download may come without a media type.
 */
const looksLikePdf = (bytes: Uint8Array) => {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  return head.includes('%PDF-');
};

const isDoclingDocument = (value: unknown): value is DoclingDocument =>
  typeof value === 'object' &&
  value !== null &&
  (value as { schema_name?: unknown }).schema_name === 'DoclingDocument';

export const doclingConverter = (options: DoclingOptions): DocumentConverter => {
  const headersTimeout = options.headersTimeoutMs ?? doclingHeadersTimeoutMs;
  const dispatcher = new Agent({
    headersTimeout,
    bodyTimeout: headersTimeout,
    connect: { keepAlive: true, keepAliveInitialDelay: doclingKeepAliveMs },
  });
  const route = new URL('/v1/convert/file', options.url);
  const documentTimeout = String(options.documentTimeoutSeconds ?? doclingDocumentTimeoutSeconds);

  const convert = async (file: DocumentFile) => {
    // Docling reads PDFs here; any other file goes to the text layer as a refusal (ADR 0042).
    if (!looksLikePdf(file.bytes)) throw new ConversionRefused(file.name, 'unsupported_type');
    const form = new FormData();
    // A name that says nothing: the server logs the name of a file it fails to read.
    form.append(
      'files',
      new Blob([new Uint8Array(file.bytes)], { type: 'application/pdf' }),
      'document.pdf',
    );
    form.append('to_formats', 'json');
    form.append('ocr_preset', 'tesseract');
    form.append('ocr_lang', 'nor');
    form.append('table_mode', 'accurate');
    form.append('image_export_mode', 'placeholder');
    form.append('document_timeout', documentTimeout);
    // One request per job, on the synchronous route: no task or result is left to fetch later,
    // and the queue's retries stand in for a retry ladder (ADR 0041).
    const response = await fetch(route, {
      method: 'POST',
      body: form,
      headers: await authHeaders(options.credential, 'x-api-key'),
      dispatcher,
    });
    const text = await response.text();
    if (response.status !== 200) throw new DoclingFailed(response.status, 'not a conversion');
    let answer: DoclingAnswer;
    try {
      answer = exactJson(text) as DoclingAnswer;
    } catch {
      throw new DoclingFailed(response.status, 'a body that is not JSON');
    }
    const refusal = refusalOf(answer);
    if (refusal) throw new ConversionRefused(file.name, refusal);
    const document = answer.document?.json_content;
    if (answer.status !== 'success' || !isDoclingDocument(document))
      throw new DoclingFailed(
        response.status,
        `status ${String(answer.status)} with errors ${categories(answer).join(', ') || 'none'}`,
      );
    return {
      pages: doclingPages(document),
      output: new TextEncoder().encode(JSON.stringify(document)),
      converter: doclingIdentity,
    };
  };

  return { extensions: ['.pdf'], convert };
};
