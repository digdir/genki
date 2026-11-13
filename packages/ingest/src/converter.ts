import { authHeaders, type Credential } from '@genai/kernel';

export interface DocumentFile {
  name: string;
  bytes: Uint8Array;
  mimetype?: string;
}

/** Which converter made a conversion: part of its stored key (ADR 0042, "Conversion"). */
export interface ConverterIdentity {
  name: string;
  version: string;
  settings: Readonly<Record<string, unknown>>;
}

/**
 * A file as a converter returns it: markdown per page, the converter's own output when it has one,
 * and the converter that made it. A converter without pages gives the whole file as one page.
 */
export interface Conversion {
  pages: string[];
  output?: Uint8Array;
  converter: ConverterIdentity;
}

export interface DocumentConverter {
  extensions?: readonly string[];
  convert(file: DocumentFile): Promise<Conversion>;
  /**
   * The conversion kept for a file, by the sha256 its source lists, before the file is downloaded
   * (ADR 0042). Throws `ConversionPending` when none is kept yet. Only stored conversions have it.
   */
  stored?(file: { name: string; sha256: string }): Promise<Conversion>;
}

/**
 * A file its converter refused, as its stored conversion records: documents skip the file with the
 * reason, and it is not converted again (ADR 0042).
 */
export class ConversionRefused extends Error {
  override readonly name = 'ConversionRefused';
  constructor(
    readonly file: string,
    readonly reason: 'too_large' | 'unsupported_type' | 'conversion_failed',
  ) {
    super(`the converter refused a file: ${reason}`);
  }
}

/**
 * Files with no stored conversion yet: an index job that meets them makes its record wait and sends
 * their convert jobs instead of converting (ADR 0042, "Ingestion runs").
 */
export class ConversionPending extends Error {
  override readonly name = 'ConversionPending';
  constructor(readonly files: { name: string; sha256: string }[]) {
    super(`${files.length} file(s) have no stored conversion yet`);
  }
}

/** The PDF text layer and the local readers of other types, which run inside the platform. */
export const textLayer: ConverterIdentity = { name: 'text-layer', version: '1', settings: {} };

/** A conversion of one page, as a converter without pages returns it. */
export const onePage = (
  markdown: string,
  converter: ConverterIdentity = textLayer,
): Conversion => ({
  pages: [markdown],
  converter,
});

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

/** A conversion's pages as one string, for callers that want one: Marker's page separator between them. */
export const joinPages = (pages: readonly string[]) => pages.join(markerPageSeparator);

/** Whether a file is a PDF, by its media type or else its extension. */
export const isPdfFile = (file: Pick<DocumentFile, 'name' | 'mimetype'>) => {
  const mime = (file.mimetype ?? '').split(';')[0]?.trim().toLowerCase();
  return mime ? mime === 'application/pdf' : /\.pdf$/i.test(file.name);
};

/**
 * A file converted to one markdown string. A PDF whose pages are all empty has no text layer and
 * throws `NoTextLayerError`, so callers skip it as `no_text`.
 */
export const toMarkdown = async (converter: DocumentConverter, file: DocumentFile) => {
  const conversion = await converter.convert(file);
  if (isPdfFile(file) && conversion.pages.every((p) => p.trim() === ''))
    throw new NoTextLayerError(file.name);
  return joinPages(conversion.pages);
};

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

/** Marker as a converter: its version and settings are not reported by the host. */
export const markerIdentity: ConverterIdentity = { name: 'marker', version: '1', settings: {} };

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
    return { pages: body.pages ?? [], converter: markerIdentity };
  };
  return {
    extensions: ['.pdf'],
    convert: async (file) => {
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
    convert: async (file) => {
      const ext = (/\.[^./]+$/.exec(file.name.toLowerCase()) ?? [''])[0];
      const mime = (file.mimetype ?? '').split(';')[0]?.trim().toLowerCase();
      const wanted = mime === 'application/pdf' ? '.pdf' : ext;
      const chosen =
        converters.find((c) => c.extensions.includes(wanted)) ?? converters[converters.length - 1];
      if (!chosen) throw new Error(`no converter for ${file.name}`);
      return chosen.converter.convert(file);
    },
  };
};
