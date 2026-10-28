import { authHeaders, type Credential } from '@genai/kernel';

export interface DocumentFile {
  name: string;
  bytes: Uint8Array;
  mimetype?: string;
}

/** What a converter produced besides the text, kept as it came so the text can be rebuilt without converting again. */
export interface RawConversion {
  producer: string;
  version: string;
  settings: unknown;
  output: unknown;
}

export interface Conversion {
  markdown: string;
  raw?: RawConversion;
}

export interface DocumentConverter {
  extensions?: readonly string[];
  toMarkdown(file: DocumentFile): Promise<string>;
  /** The text and the converter's own output; converters that have none only offer toMarkdown. */
  convert?(file: DocumentFile): Promise<Conversion>;
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
  const once = async (file: DocumentFile): Promise<Conversion> => {
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
      json?: unknown;
      metadata?: unknown;
      marker_version?: string;
      settings?: unknown;
    };
    if (!response.ok || !body.success)
      throw new MarkerFailed(
        response.status,
        `Marker conversion failed for ${file.name} with HTTP ${response.status}`,
      );
    const markdown = (body.pages ?? []).join(markerPageSeparator);
    // A service that predates Marker's raw output sends pages alone
    return body.marker_version === undefined
      ? { markdown }
      : {
          markdown,
          raw: {
            producer: 'marker',
            version: body.marker_version,
            settings: body.settings ?? {},
            output: { pages: body.pages ?? [], json: body.json, metadata: body.metadata },
          },
        };
  };
  const convert = async (file: DocumentFile) => {
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
  };
  return {
    extensions: ['.pdf'],
    convert,
    toMarkdown: async (file) => (await convert(file)).markdown,
  };
};

export const byExtension = (
  converters: { converter: DocumentConverter; extensions: readonly string[] }[],
): DocumentConverter => {
  const all = converters.flatMap((c) => c.extensions.map((e) => e.toLowerCase()));
  const choose = (file: DocumentFile) => {
    const ext = (/\.[^./]+$/.exec(file.name.toLowerCase()) ?? [''])[0];
    const mime = (file.mimetype ?? '').split(';')[0]?.trim().toLowerCase();
    const wanted = mime === 'application/pdf' ? '.pdf' : ext;
    const chosen =
      converters.find((c) => c.extensions.includes(wanted)) ?? converters[converters.length - 1];
    if (!chosen) throw new Error(`no converter for ${file.name}`);
    return chosen.converter;
  };
  return {
    extensions: [...new Set(all)],
    toMarkdown: async (file) => choose(file).toMarkdown(file),
    convert: async (file) => {
      const chosen = choose(file);
      return chosen.convert ? chosen.convert(file) : { markdown: await chosen.toMarkdown(file) };
    },
  };
};
