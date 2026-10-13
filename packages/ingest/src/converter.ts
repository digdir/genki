import { authHeaders, type Credential } from '@genai/kernel';

export interface DocumentFile {
  name: string;
  bytes: Uint8Array;
  mimetype?: string;
}

export interface DocumentConverter {
  extensions?: readonly string[];
  toMarkdown(file: DocumentFile): Promise<string>;
}

export class NoTextLayerError extends Error {
  override readonly name = 'NoTextLayerError';
  constructor(document: string) {
    super(`${document} has no text layer; it needs OCR`);
  }
}

export class DocumentTooLargeError extends Error {
  override readonly name = 'DocumentTooLargeError';
  constructor(document: string, maxBytes: number) {
    super(`${document} exceeds the conversion size limit of ${maxBytes} bytes`);
  }
}

export const markerPageSeparator = '\n\n------------------------------------------------\n\n';

export const markerRetryDelaysMs = [
  60_000,
  10 * 60_000,
  30 * 60_000,
  60 * 60_000,
  120 * 60_000,
  24 * 60 * 60_000,
];

export const markerTimeoutMs = 6 * 60 * 60 * 1000;

const retryableMarkerStatuses = new Set([429, 502, 503]);

export class MarkerFailed extends Error {
  override readonly name = 'MarkerFailed';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface MarkerOptions {
  url: string;
  credential: Credential;
  timeoutMs?: number;
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const markerConverter = (options: MarkerOptions): DocumentConverter => {
  const once = async (file: DocumentFile) => {
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(file.bytes)], { type: file.mimetype ?? 'application/pdf' }),
      file.name,
    );
    const url = new URL(options.url);
    url.searchParams.set('cache', 'true');
    const response = await (options.fetch ?? fetch)(url, {
      method: 'POST',
      body: form,
      headers: await authHeaders(options.credential, 'x-api-key'),
      signal: AbortSignal.timeout(options.timeoutMs ?? markerTimeoutMs),
    });
    const body = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      pages?: string[];
    };
    if (!response.ok || !body.success)
      throw new MarkerFailed(
        response.status,
        `Marker conversion failed for ${file.name} with HTTP ${response.status}`,
      );
    return (body.pages ?? []).join(markerPageSeparator);
  };
  return {
    extensions: ['.pdf'],
    toMarkdown: async (file) => {
      const delays = [...(options.retryDelaysMs ?? markerRetryDelaysMs)];
      for (;;) {
        try {
          return await once(file);
        } catch (error) {
          const delay = delays.shift();
          if (
            delay === undefined ||
            !(error instanceof MarkerFailed && retryableMarkerStatuses.has(error.status))
          )
            throw error;
          await (options.sleep ?? pause)(delay);
        }
      }
    },
  };
};

export const byExtension = (
  converters: { converter: DocumentConverter; extensions: readonly string[] }[],
): DocumentConverter => {
  const all = converters.flatMap((c) => c.extensions.map((e) => e.toLowerCase()));
  return {
    extensions: [...new Set(all)],
    toMarkdown: async (file) => {
      const ext = (/\.[^./]+$/.exec(file.name.toLowerCase()) ?? [''])[0];
      const mime = (file.mimetype ?? '').split(';')[0]?.trim().toLowerCase();
      const wanted = mime === 'application/pdf' ? '.pdf' : ext;
      const chosen =
        converters.find((c) => c.extensions.includes(wanted)) ?? converters[converters.length - 1];
      if (!chosen) throw new Error(`no converter for ${file.name}`);
      return chosen.converter.toMarkdown(file);
    },
  };
};
