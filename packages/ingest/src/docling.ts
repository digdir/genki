import { createHash } from 'node:crypto';
import { authHeaders, type Credential } from '@genai/kernel';
import { type buildConnector, Client, fetch, FormData } from 'undici';
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
  settings: { pipeline: 'standard', ocr: 'tesseract', languages: ['nor'], tableformer: 'fast' },
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

/**
 * After this many lost tasks in a try, the file is submitted with pypdfium2 as Docling's PDF reader
 * (`pdf_backend`). A lost task is most often a replica killed out of memory (exit 137): one Kudos
 * page took docling-parse past 16 GiB, while pypdfium2 read the whole file in 4 GiB (issue 922).
 */
export const doclingLostBeforePdfium = 2;

/**
 * How long a job waits before it submits its file again on a new connection after a replica
 * answered that it is busy (503), or the connection ended before an answer, as while a replica
 * restarts (issue 922). A busy answer starts nothing, so it is not a submit.
 */
export const doclingBusyWaitMs = 15_000;

/**
 * How long a try may wait for a replica to take its file: within the job's 7-hour expiry, beside
 * the document timeout (5 h 50 min) and the 10 minutes after it.
 */
export const doclingBusyLimitMs = 50 * 60_000;

/** How many submits in a row may end without an answer before the try fails: about 2 minutes. */
export const doclingUnansweredSubmitsInARow = 8;

/**
 * How a Docling task ended: converted, converted with pages it could not parse (`partial`), refused
 * about the file, failed otherwise, or lost.
 */
export type DoclingTaskResult =
  'success' | 'partial' | 'too_large' | 'conversion_failed' | 'failed' | 'lost';

/**
 * One Docling task, told when it ends (issue 922): the worker logs it, so a replica's kill can be
 * matched to the files it held. Names no file: the sha256 is the file's key in stored conversions.
 */
export interface DoclingTaskEvent {
  task: string;
  sha256: string;
  /** The PDF's page count, read before the submit; absent when it could not be read. */
  pages?: number;
  /** Which submit of the try this task was, from 1. */
  submit: number;
  /** The replica that took the task, as its answer named it. */
  replica?: string;
  /** From the submit until a poll first saw the task started, to the poll interval. */
  queuedMs: number;
  /** From then until the task ended. */
  convertingMs: number;
  result: DoclingTaskResult;
  /** Busy answers and unanswered submits before this task was taken. */
  busyWaits: number;
  /**
   * The PDF reader Docling was asked for, when not its own: `pypdfium2` after lost tasks or pages
   * its own reader could not parse.
   */
  pdfBackend?: 'pypdfium2';
}

/** How many polls in a row the server may fail (5xx, about 5 minutes) before the try fails. */
export const doclingServerErrorsInARow = 10;

/**
 * An answer that is not about the file: a status, a body the client cannot read or a failure of a
 * kind it does not know. Its job is tried again and then dead-lettered (ADR 0042). The message
 * names no file, since the server's details can: its detail is fixed text, numbers and Docling's
 * status and error categories, so the dead letter can carry it (issue 951).
 */
export class DoclingFailed extends Error {
  override readonly name = 'DoclingFailed';
  readonly detail: string;
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Docling answered HTTP ${status}: ${detail}`);
    this.detail = `HTTP ${status}: ${detail}`;
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
  busyWaitMs?: number;
  /** Counts a PDF's pages before it is submitted, for the task line; never throws on a bad file. */
  countPages?: (bytes: Uint8Array) => Promise<number | undefined>;
  /** Told once for each task when it ends. */
  onTask?: (event: DoclingTaskEvent) => void;
  /** How the client opens a connection; undici's own by default. Tests time connects out with it. */
  connect?: buildConnector.connector;
}

interface TaskStatus {
  task_id?: unknown;
  task_status?: unknown;
}

interface Answer {
  status: number;
  text: string;
  /** The replica that answered, when it names itself (`X-Docling-Replica`, docker/docling). */
  replica?: string;
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

/** A category as Docling names one, such as `backend_failure`: one word, never a sentence. */
const categoryShape = /^[a-z][a-z_]{0,39}$/;

/**
 * The answer's error categories, each once and one word or `other`: they go into a dead letter
 * (issue 951), and Docling reports one error per page.
 */
const categories = (answer: DoclingAnswer) => [
  ...new Set(
    (answer.errors ?? []).map((e) =>
      e.category === undefined
        ? 'none'
        : typeof e.category === 'string' && categoryShape.test(e.category)
          ? e.category
          : 'other',
    ),
  ),
];

/**
 * A page Docling's own reader could not parse, the same way each try: `partial_success` whose
 * errors are all `backend_failure`. pypdfium2 read such a Kudos file whole (issue 951).
 */
const unparsedPages = (answer: DoclingAnswer) =>
  answer.status === 'partial_success' && onlyBackendFailures(answer);

/** Whether every error of the answer, and there is one, is a reader's `backend_failure`. */
const onlyBackendFailures = (answer: DoclingAnswer) =>
  (answer.errors ?? []).length > 0 &&
  (answer.errors ?? []).every((e) => e.category === 'backend_failure');

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

/** Codes of a connection refused, reset or closed before its answer, as a restarting replica's are. */
const earlyEnds = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']);

const causeCode = (error: unknown) => {
  const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  return typeof code === 'string' ? code : undefined;
};

const endedEarly = (error: unknown) => earlyEnds.has(causeCode(error) ?? '');

/**
 * A connection the ingress did not open in time: it holds one while every replica is taken and
 * the next starts (about 75 s in genki-test), longer than undici's 10 s to connect (issue 922).
 */
const notConnected = (error: unknown) => causeCode(error) === 'UND_ERR_CONNECT_TIMEOUT';

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
  const busyWait = options.busyWaitMs ?? doclingBusyWaitMs;
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
      ...(options.connect ? { connect: options.connect } : {}),
    });

  const send = async (client: Client, path: string, body?: FormData): Promise<Answer> => {
    const response = await fetch(new URL(path, base), {
      method: body ? 'POST' : 'GET',
      ...(body ? { body } : {}),
      headers: await authHeaders(options.credential, 'x-api-key'),
      dispatcher: client,
    });
    const replica = response.headers.get('x-docling-replica');
    return {
      status: response.status,
      text: await response.text(),
      ...(replica ? { replica } : {}),
    };
  };

  /** The form of one submit, asking Docling to stop after `seconds`: the time left in the try. */
  const form = (file: DocumentFile, seconds: number, pdfBackend?: 'pypdfium2') => {
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
    // fast, not accurate: 17% faster on 11 Kudos files with the same table and text page-test scores (issue 922).
    data.append('table_mode', 'fast');
    data.append('image_export_mode', 'placeholder');
    data.append('document_timeout', String(seconds));
    if (pdfBackend) data.append('pdf_backend', pdfBackend);
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
  const follow = async (
    first: Client,
    id: string,
    opened: Client[],
    deadline: number,
    seen: (status: string) => void,
  ) => {
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
      if (status !== unanswered) seen(status);
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

  /**
   * Submits the file on new connections until a replica takes it: a busy replica (503) and a
   * connection that ends without an answer, as while a replica restarts, start nothing, so the job
   * waits and asks again (issue 922). Unanswered submits in a row are bounded; busy answers last
   * until the try's deadline.
   */
  const place = async (
    file: DocumentFile,
    seconds: () => number,
    opened: Client[],
    until: number,
    past: () => Error,
    pdfBackend?: 'pypdfium2',
  ) => {
    let waits = 0;
    let unansweredInARow = 0;
    // A refused connection stays open through the wait, so a waiting job still counts toward the
    // replicas the ingress scales to (one a connection); it is closed once the next ask is answered.
    let held: Client | undefined;
    const release = async () => {
      await held?.destroy();
      held = undefined;
    };
    for (;;) {
      if (now().getTime() > until) {
        await release();
        throw past();
      }
      const client = connection();
      opened.push(client);
      let submitted: Answer;
      const sentAt = now().getTime();
      try {
        submitted = await send(client, '/v1/convert/file/async', form(file, seconds(), pdfBackend));
      } catch (error) {
        await release();
        // No connection yet, as while replicas start: the job waits for one as for a busy replica.
        if (notConnected(error)) {
          await client.destroy();
          waits += 1;
          await sleep(busyWait);
          continue;
        }
        // Only a connection refused or ended before an answer: a headers timeout already waited long.
        unansweredInARow += 1;
        if (!endedEarly(error) || unansweredInARow >= doclingUnansweredSubmitsInARow) throw error;
        await client.destroy();
        waits += 1;
        await sleep(busyWait);
        continue;
      }
      await release();
      unansweredInARow = 0;
      // Busy is genki's middleware in docker/docling, which names its replica; any other 503 is not.
      if (submitted.status === 503 && submitted.replica) {
        held = client;
        waits += 1;
        await sleep(busyWait);
        continue;
      }
      if (submitted.status !== 200) throw new DoclingFailed(submitted.status, 'not a task');
      const id = parsed<TaskStatus>(submitted, 'a task').task_id;
      if (typeof id !== 'string' || !taskIdPattern.test(id))
        throw new DoclingFailed(submitted.status, 'not a task');
      return { client, id, replica: submitted.replica, waits, sentAt };
    }
  };

  const convert = async (file: DocumentFile) => {
    // Docling reads PDFs here; any other file goes to the text layer as a refusal (ADR 0042).
    if (!looksLikePdf(file.bytes)) throw new ConversionRefused(file.name, 'unsupported_type');
    const sha256 = createHash('sha256').update(file.bytes).digest('hex');
    const pages = await options.countPages?.(file.bytes).catch(() => undefined);
    let answer: Answer | undefined;
    // One deadline for the whole try, from the submit a replica first took: the server stops a task
    // at its document timeout, and the try ends ten minutes after that. Before a replica takes the
    // file, the try waits at most `doclingBusyLimitMs`, so all of it fits in the job's expiry.
    const waitUntil = now().getTime() + doclingBusyLimitMs;
    let stopBy: number | undefined;
    let deadline = waitUntil;
    // The task the try is on, told once when it ends.
    let task:
      | {
          id: string;
          submit: number;
          replica?: string;
          waits: number;
          at: number;
          started?: number;
          pdfBackend?: 'pypdfium2';
        }
      | undefined;
    const told = (result: DoclingTaskResult) => {
      if (!task) return;
      const end = now().getTime();
      const started = task.started ?? task.at;
      options.onTask?.({
        task: task.id,
        sha256,
        ...(pages === undefined ? {} : { pages }),
        submit: task.submit,
        ...(task.replica ? { replica: task.replica } : {}),
        queuedMs: started - task.at,
        convertingMs: end - started,
        result,
        busyWaits: task.waits,
        ...(task.pdfBackend ? { pdfBackend: task.pdfBackend } : {}),
      });
      task = undefined;
    };
    // Set once Docling's own reader left pages unparsed: the try submits the file again with pdfium.
    let unparsed = false;
    let lost = 0;
    try {
      for (let submits = 1; ; submits += 1) {
        if (now().getTime() > deadline) throw pastDeadline();
        // The async route: the client polls its task, so no connection is idle for long (issue
        // 906). A task no replica knows any more is submitted again, a few times a try.
        const opened: Client[] = [];
        try {
          // A file submitted again asks only for the time left, so Docling stops by the try's end.
          const left = () =>
            stopBy === undefined
              ? documentTimeoutSeconds
              : Math.max(1, Math.ceil((stopBy - now().getTime()) / 1000));
          const pdfBackend =
            unparsed || submits > doclingLostBeforePdfium ? 'pypdfium2' : undefined;
          const placed = await place(
            file,
            left,
            opened,
            deadline,
            () =>
              stopBy === undefined
                ? new DoclingFailed(503, 'no replica took the file within the wait limit')
                : pastDeadline(),
            pdfBackend,
          );
          if (stopBy === undefined) {
            stopBy = placed.sentAt + documentTimeoutSeconds * 1000;
            deadline = stopBy + 10 * 60_000;
          }
          task = {
            id: placed.id,
            submit: submits,
            waits: placed.waits,
            at: now().getTime(),
            ...(placed.replica ? { replica: placed.replica } : {}),
            ...(pdfBackend ? { pdfBackend } : {}),
          };
          const current = task;
          answer = await follow(placed.client, placed.id, opened, deadline, (status) => {
            if (status === 'started' && current.started === undefined)
              current.started = now().getTime();
          });
        } finally {
          await Promise.all(opened.map((client) => client.destroy()));
        }
        if (!answer) {
          told('lost');
          lost += 1;
          options.onTaskLost?.({ submits });
          if (submits >= doclingSubmitsPerTry)
            throw new DoclingFailed(404, `the task was lost ${lost} times`);
          continue;
        }
        if (answer.status !== 200) throw new DoclingFailed(answer.status, 'not a conversion');
        const conversion = parsed<DoclingAnswer>(answer, 'a body');
        const refusal = refusalOf(conversion);
        if (refusal) {
          told(refusal);
          throw new ConversionRefused(file.name, refusal);
        }
        const document = conversion.document?.json_content;
        if (conversion.status === 'success' && isDoclingDocument(document)) {
          told('success');
          return converted(document);
        }
        const withPdfium = task?.pdfBackend === 'pypdfium2';
        // Docling's own reader left pages unparsed: the same try submits the file once more with
        // pdfium, as after lost tasks; the submit counts among the try's (issue 951).
        if (!withPdfium && unparsedPages(conversion)) {
          told('partial');
          unparsed = true;
          answer = undefined;
          continue;
        }
        // Only after unparsed pages: a file sent to pdfium after lost tasks fails as before (issue 944).
        if (unparsed && conversion.status === 'partial_success' && isDoclingDocument(document)) {
          // No reader is left to try: the pages pdfium parsed are kept, the others are empty.
          told('partial');
          return converted(document);
        }
        if (
          unparsed &&
          (conversion.status === 'partial_success' || conversion.status === 'failure') &&
          onlyBackendFailures(conversion)
        ) {
          // pdfium could not parse it either: the text layer is stored instead (ADR 0042). Any other
          // failure, such as a model's, is tried again.
          told('conversion_failed');
          throw new ConversionRefused(file.name, 'conversion_failed');
        }
        throw new DoclingFailed(
          answer.status,
          `status ${statusOf(conversion)} with errors ${categories(conversion).join(', ') || 'none'}`,
        );
      }
    } catch (error) {
      told('failed');
      throw error;
    }
  };

  return { extensions: ['.pdf'], convert };
};

const converted = (document: DoclingDocument) => ({
  pages: doclingPages(document),
  output: new TextEncoder().encode(JSON.stringify(document)),
  converter: doclingIdentity,
});

/** Docling's status for the conversion, one word or `other`: it goes into a dead letter. */
const statusOf = (answer: DoclingAnswer) =>
  typeof answer.status === 'string' && categoryShape.test(answer.status)
    ? answer.status
    : answer.status === undefined
      ? 'none'
      : 'other';
