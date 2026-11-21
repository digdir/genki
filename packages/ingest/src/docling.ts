import { authHeaders, type Credential } from '@genai/kernel';
import { Client, fetch, FormData } from 'undici';
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
 * How long Docling may work on one file before it stops on its own: 5 h 50 min. The server does
 * not stop a conversion when the client leaves, and has no route to cancel one, so without this an
 * abandoned file holds its replica (one conversion each) and later requests queue behind it.
 */
export const doclingDocumentTimeoutSeconds = 21_000;

/**
 * How long one request may take: a submit waits for a replica to start (74 s in genki-test) and
 * uploads the file, and a result can be large. A poll is answered at once.
 */
export const doclingHeadersTimeoutMs = 15 * 60_000;

/**
 * How often the client asks for its task's status. genki-test closes a TCP connection that sends
 * nothing for 300 s (issue 906), and docling-serve closes an idle keep-alive connection after
 * 60 s; `local`, the server's engine, ignores the poll route's `wait`, so the client waits here.
 */
export const doclingPollIntervalMs = 30_000;

/**
 * How many new connections the client opens to find its task after its own connection is lost.
 * Tasks live in the memory of the replica that took them, and each new connection reaches a
 * replica the ingress picks; the others answer 404.
 */
export const doclingTaskSearchConnections = 16;

/**
 * How many times, in all, a try submits its file: again when no replica knows its task any more,
 * such as after Azure stopped the replica (scale-in). Then the job fails and the queue tries it again.
 */
export const doclingSubmitsPerTry = 3;

/** How many polls in a row the server may fail (5xx, about 5 minutes) before the try fails. */
export const doclingServerErrorsInARow = 10;

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
  pollIntervalMs?: number;
  now?: () => Date;
  /** Told each time no replica knows the try's task any more, the last time too. */
  onTaskLost?: (event: { submits: number }) => void;
}

interface TaskStatus {
  task_id?: unknown;
  task_status?: unknown;
}

interface Answer {
  status: number;
  text: string;
}

/** The task statuses a task leaves; docling-serve reports these while it works on one. */
const working = new Set(['pending', 'started']);

/** A task id goes into a path: only the server's own form (a UUID) is accepted. */
const taskIdPattern = /^[\w-]{1,100}$/;

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
export const looksLikePdf = (bytes: Uint8Array) => {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  return head.includes('%PDF-');
};

const isDoclingDocument = (value: unknown): value is DoclingDocument =>
  typeof value === 'object' &&
  value !== null &&
  (value as { schema_name?: unknown }).schema_name === 'DoclingDocument';

const parsed = <T>(answer: Answer, what: string): T => {
  try {
    return exactJson(answer.text) as T;
  } catch {
    throw new DoclingFailed(answer.status, `${what} that is not JSON`);
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A poll the server failed to answer (5xx): the task may still run, so the client asks again. */
const unanswered = 'unanswered';

const pastDeadline = () => new DoclingFailed(200, 'a task past its document timeout');

/** The `detail` of an error body, or nothing. */
const detailOf = (answer: Answer) => {
  try {
    const detail = (JSON.parse(answer.text) as { detail?: unknown }).detail;
    return typeof detail === 'string' ? detail : '';
  } catch {
    return '';
  }
};

export const doclingConverter = (options: DoclingOptions): DocumentConverter => {
  const timeout = options.headersTimeoutMs ?? doclingHeadersTimeoutMs;
  const interval = options.pollIntervalMs ?? doclingPollIntervalMs;
  const documentTimeoutSeconds = options.documentTimeoutSeconds ?? doclingDocumentTimeoutSeconds;
  const base = new URL(options.url);
  const now = options.now ?? (() => new Date());

  // One connection: a job's polls must reach the replica that holds its task, and the ingress
  // picks a replica per connection. Kept open between polls, 15 s longer than the gap between
  // them and below the server's 60 s.
  const connection = () =>
    new Client(base.origin, {
      headersTimeout: timeout,
      bodyTimeout: timeout,
      keepAliveTimeout: interval + 15_000,
      keepAliveMaxTimeout: interval + 15_000,
      pipelining: 1,
    });

  const send = async (client: Client, path: string, body?: FormData): Promise<Answer> => {
    const response = await fetch(new URL(path, base), {
      method: body ? 'POST' : 'GET',
      ...(body ? { body } : {}),
      headers: await authHeaders(options.credential, 'x-api-key'),
      dispatcher: client,
    });
    return { status: response.status, text: await response.text() };
  };

  /** The form of one submit, asking Docling to stop after `seconds`: the time left in the try. */
  const form = (file: DocumentFile, seconds: number) => {
    const data = new FormData();
    // A name that says nothing: the server logs the name of a file it fails to read.
    data.append(
      'files',
      new Blob([new Uint8Array(file.bytes)], { type: 'application/pdf' }),
      'document.pdf',
    );
    data.append('to_formats', 'json');
    data.append('ocr_preset', 'tesseract');
    data.append('ocr_lang', 'nor');
    data.append('table_mode', 'accurate');
    data.append('image_export_mode', 'placeholder');
    data.append('document_timeout', String(seconds));
    return data;
  };

  /**
   * The task's status on this connection: undefined when the connection or its replica lost it,
   * `unanswered` when the server failed to answer (5xx), which the next poll asks again.
   */
  const statusOn = async (client: Client, id: string) => {
    let answer: Answer;
    try {
      answer = await send(client, `/v1/status/poll/${id}`);
    } catch {
      return undefined;
    }
    if (answer.status === 404) return undefined;
    if (answer.status >= 500) return unanswered;
    if (answer.status !== 200) throw new DoclingFailed(answer.status, 'not a task status');
    const status = parsed<TaskStatus>(answer, 'a task status').task_status;
    if (typeof status !== 'string') throw new DoclingFailed(answer.status, 'not a task status');
    return status;
  };

  /** A new connection that reaches the replica holding the task, if one of a few does. */
  const search = async (id: string, opened: Client[]) => {
    for (let n = 0; n < doclingTaskSearchConnections; n += 1) {
      const client = connection();
      opened.push(client);
      const status = await statusOn(client, id);
      // A 5xx comes from a replica that knows the task, or may: its connection is kept.
      if (status !== undefined) return { client, status };
      await client.destroy();
    }
    return undefined;
  };

  /**
   * Follows a task to its result: polls on the job's connection, and after a lost connection
   * looks for the task on new ones. Undefined when no replica knows the task any more.
   */
  const follow = async (first: Client, id: string, opened: Client[], deadline: number) => {
    let client = first;
    let status = await statusOn(client, id);
    let resultTries = 0;
    let errors = 0;
    for (;;) {
      if (status === undefined) {
        const found = await search(id, opened);
        if (!found) return undefined;
        ({ client, status } = found);
      }
      errors = status === unanswered ? errors + 1 : 0;
      if (errors >= doclingServerErrorsInARow)
        throw new DoclingFailed(503, `${errors} server errors in a row`);
      if (status === unanswered || working.has(status)) {
        if (now().getTime() > deadline) throw pastDeadline();
        await sleep(interval);
        status = await statusOn(client, id);
        continue;
      }
      let answer: Answer | undefined;
      try {
        answer = await send(client, `/v1/result/${id}`);
      } catch {
        answer = undefined;
      }
      if (answer && answer.status !== 404) return answer;
      // docling-serve keeps no result for a task whose conversion raised: the task is there,
      // so it is not lost, and the file is not submitted again.
      if (answer && /^Task result not found/.test(detailOf(answer)))
        throw new DoclingFailed(404, 'a task that ended without a result');
      // The connection was lost between the status and the result.
      resultTries += 1;
      if (resultTries >= 2) throw new DoclingFailed(answer?.status ?? 404, 'no task result');
      status = undefined;
    }
  };

  const convert = async (file: DocumentFile) => {
    // Docling reads PDFs here; any other file goes to the text layer as a refusal (ADR 0042).
    if (!looksLikePdf(file.bytes)) throw new ConversionRefused(file.name, 'unsupported_type');
    let answer: Answer | undefined;
    // One deadline for the whole try, from its first submit: the server stops a task at its
    // document timeout, and the try ends ten minutes after that, within the job's expiry.
    const stopBy = now().getTime() + documentTimeoutSeconds * 1000;
    const deadline = stopBy + 10 * 60_000;
    for (let submits = 1; !answer; submits += 1) {
      if (now().getTime() > deadline) throw pastDeadline();
      // The async route: the client polls its task, so no connection is idle for long (issue
      // 906). A task no replica knows any more is submitted again, a few times a try.
      const opened = [connection()];
      try {
        const first = opened[0] as Client;
        // A file submitted again asks only for the time left, so Docling stops by the try's end.
        const left = Math.max(1, Math.floor((stopBy - now().getTime()) / 1000));
        const submitted = await send(first, '/v1/convert/file/async', form(file, left));
        if (submitted.status !== 200) throw new DoclingFailed(submitted.status, 'not a task');
        const id = parsed<TaskStatus>(submitted, 'a task').task_id;
        if (typeof id !== 'string' || !taskIdPattern.test(id))
          throw new DoclingFailed(submitted.status, 'not a task');
        answer = await follow(first, id, opened, deadline);
      } finally {
        await Promise.all(opened.map((client) => client.destroy()));
      }
      if (answer) break;
      options.onTaskLost?.({ submits });
      if (submits >= doclingSubmitsPerTry)
        throw new DoclingFailed(404, `the task was lost ${submits} times`);
    }
    if (answer.status !== 200) throw new DoclingFailed(answer.status, 'not a conversion');
    const conversion = parsed<DoclingAnswer>(answer, 'a body');
    const refusal = refusalOf(conversion);
    if (refusal) throw new ConversionRefused(file.name, refusal);
    const document = conversion.document?.json_content;
    if (conversion.status !== 'success' || !isDoclingDocument(document))
      throw new DoclingFailed(
        answer.status,
        `status ${String(conversion.status)} with errors ${categories(conversion).join(', ') || 'none'}`,
      );
    return {
      pages: doclingPages(document),
      output: new TextEncoder().encode(JSON.stringify(document)),
      converter: doclingIdentity,
    };
  };

  return { extensions: ['.pdf'], convert };
};
