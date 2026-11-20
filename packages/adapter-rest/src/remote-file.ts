import type { DocumentSummary } from '@genai/port-knowledge';

export interface RemoteFileOptions {
  origins: readonly string[];
  fetch?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
}

export const remoteFileMaxBytes = 50 * 1024 * 1024;
export const remoteFileTimeoutMs = 60_000;

const PDF_START = [0x25, 0x50, 0x44, 0x46, 0x2d];
const pdfType = /^application\/pdf\s*(?:;|$)/i;

export const remoteFileOriginsFrom = (text: string | undefined): string[] =>
  (text ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .flatMap((entry) => {
      try {
        const url = new URL(entry);
        return url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          (entry === url.origin || entry === `${url.origin}/`)
          ? [url.origin]
          : [];
      } catch {
        return [];
      }
    });

const httpsPdf = (raw: unknown, mimetype: unknown, origins: readonly string[]) => {
  if (typeof raw !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return undefined;
  if (!origins.includes(url.origin)) return undefined;
  const pdf =
    typeof mimetype === 'string'
      ? pdfType.test(mimetype)
      : url.pathname.toLowerCase().endsWith('.pdf');
  if (!pdf) return undefined;
  url.hash = '';
  return url.href;
};

export const listedPdf = (
  document: DocumentSummary,
  asked: string | undefined,
  origins: readonly string[],
): string | undefined => {
  const files = Array.isArray(document.fields.files) ? (document.fields.files as unknown[]) : [];
  const listed = files.flatMap((file) => {
    if (typeof file !== 'object' || file === null) return [];
    const { url, mimetype } = file as { url?: unknown; mimetype?: unknown };
    const pdf = httpsPdf(url, mimetype, origins);
    return pdf ? [pdf] : [];
  });
  const own = httpsPdf(document.url, undefined, origins);
  const all = own ? [...listed, own] : listed;
  if (asked === undefined) return all[0];
  const wanted = normalised(asked);
  return wanted === undefined ? undefined : all.find((url) => url === wanted);
};

const normalised = (raw: string) => {
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
};

export const fileNameOf = (url: string) => {
  const last = new URL(url).pathname.split('/').at(-1) || 'document.pdf';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

export class RemoteFileError extends Error {}

const startsAsPdf = (bytes: Uint8Array) => PDF_START.every((byte, i) => bytes[i] === byte);

export const openRemotePdf = async (
  url: string,
  options: RemoteFileOptions,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> => {
  const maxBytes = options.maxBytes ?? remoteFileMaxBytes;
  const response = await (options.fetch ?? fetch)(url, {
    redirect: 'manual',
    headers: { accept: 'application/pdf' },
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(options.timeoutMs ?? remoteFileTimeoutMs),
    ]),
  });
  const length = Number(response.headers.get('content-length') ?? '0');
  if (
    response.status !== 200 ||
    !response.body ||
    !pdfType.test(response.headers.get('content-type') ?? '') ||
    length > maxBytes
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new RemoteFileError(`the source answered ${response.status}`);
  }
  const reader = response.body.getReader();
  const head: number[] = [];
  let seen = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        if (head.length < PDF_START.length) controller.error(new RemoteFileError('not a PDF'));
        else controller.close();
        return;
      }
      seen += value.byteLength;
      if (seen > maxBytes) {
        await reader.cancel().catch(() => undefined);
        controller.error(new RemoteFileError('the file is too large'));
        return;
      }
      if (head.length < PDF_START.length) {
        head.push(...value.subarray(0, PDF_START.length - head.length));
        if (head.length >= PDF_START.length && !startsAsPdf(Uint8Array.from(head))) {
          await reader.cancel().catch(() => undefined);
          controller.error(new RemoteFileError('not a PDF'));
          return;
        }
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
};
