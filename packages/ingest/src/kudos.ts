import { createHash } from 'node:crypto';

export interface KudosProfile {
  name: 'prod' | 'preprod';
  baseUrl: string;
  listPath: string;
  documentPath: string;
  retryDelaysMs: number[];
}

const retryDelaysMs = [1000, 3000, 7000, 60000];

export const kudosProd: KudosProfile = {
  name: 'prod',
  baseUrl: 'https://kudos.dfo.no',
  listPath: '/api/v0/documents/search',
  documentPath: '/api/v0/documents',
  retryDelaysMs,
};

export interface KudosOrganisation {
  alternative_names?: { name: string; type: string }[];
  [key: string]: unknown;
}

export interface KudosFile {
  url: string;
  sha256?: string;
  size?: number;
  mimetype?: string;
  pages?: number;
  path?: string;
  [key: string]: unknown;
}

export interface KudosDocument {
  id?: number | string;
  uuid?: string;
  title?: string;
  type?: string;
  publish_date?: string;
  language?: string;
  authors?: unknown;
  owners?: KudosOrganisation[];
  recipients?: KudosOrganisation[];
  publishers?: KudosOrganisation[];
  files?: KudosFile[];
  concerned_year?: number;
  concerned_year_from?: number;
  concerned_year_to?: number;
  [key: string]: unknown;
}

export interface KudosPage {
  data: KudosDocument[];
  meta: { current_page: number; last_page: number; total?: number };
}

export interface KudosSearch {
  type?: string;
  query?: string;
}

const searchParams = (n: number, search: KudosSearch) => {
  const params = new URLSearchParams({ page: String(n) });
  if (search.type) params.set('type', search.type);
  if (search.query) params.set('query', search.query);
  return params.toString();
};

export const kudosProfiles: Partial<Record<KudosProfile['name'], KudosProfile>> = {
  prod: kudosProd,
};

export class KudosPageFailed extends Error {
  override readonly name = 'KudosPageFailed';
  constructor(
    readonly profile: string,
    readonly page: number,
    cause: unknown,
  ) {
    super(
      `Kudos ${profile} list page ${page} could not be read after retrying; the run stopped so the index in use is kept`,
      { cause },
    );
  }
}

export interface KudosClientOptions {
  profile: KudosProfile;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const kudosClient = (options: KudosClientOptions) => {
  const send = options.fetch ?? fetch;
  const sleep = options.sleep ?? pause;
  const getJson = async <T>(url: string): Promise<T> => {
    let lastError: unknown;
    for (const delay of [...options.profile.retryDelaysMs, undefined]) {
      try {
        const response = await send(url, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`Kudos answered HTTP ${response.status} for ${url}`);
        return (await response.json()) as T;
      } catch (error) {
        lastError = error;
        if (delay === undefined) break;
        await sleep(delay);
      }
    }
    throw lastError;
  };

  return {
    page: (n: number, search: KudosSearch = {}) =>
      getJson<KudosPage>(
        `${options.profile.baseUrl}${options.profile.listPath}?${searchParams(n, search)}`,
      ),

    async *documents(startingPage = 1, search: KudosSearch = {}): AsyncIterable<KudosDocument> {
      for (let n = startingPage; ; n += 1) {
        let page: KudosPage;
        try {
          page = await this.page(n, search);
        } catch (error) {
          throw new KudosPageFailed(options.profile.name, n, error);
        }
        yield* page.data;
        if (page.meta.last_page <= page.meta.current_page) return;
      }
    },

    document: (id: number | string) =>
      getJson<KudosDocument>(`${options.profile.baseUrl}${options.profile.documentPath}/${id}`),
  };
};

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

export const concernedYears = (doc: KudosDocument): number[] => {
  const { concerned_year_from: from, concerned_year_to: to, concerned_year: year } = doc;
  if (from !== undefined && from !== null && to !== undefined && to !== null)
    return range(from, to);
  if (from !== undefined && from !== null) return [from];
  if (to !== undefined && to !== null) return [to];
  if (year !== undefined && year !== null) return [year];
  return [];
};

export const kudosDocumentId = (doc: KudosDocument) => String(doc.id ?? doc.uuid);

export const kudosPublicUrl = (id: string | number, profile: KudosProfile = kudosProd) =>
  `${profile.baseUrl}/dokument/${encodeURIComponent(String(id))}`;

export const fillInKudosFields = (doc: KudosDocument) => ({
  ...doc,
  id: kudosDocumentId(doc),
  doc_num: kudosDocumentId(doc),
  concerned_years: concernedYears(doc),
});

export const displayNames = (orgs: KudosOrganisation[]) =>
  orgs
    .flatMap((o) => o.alternative_names ?? [])
    .filter((n) => n.type === 'display')
    .map((n) => n.name);

const kudosStoredFields = [
  'id',
  'doc_num',
  'title',
  'authors',
  'orgs_long',
  'concerned_year',
  'concerned_year_from',
  'concerned_year_to',
  'files',
  'file_sha256',
  'publish_date',
  'type',
  'language',
  'concerned_years',
  'total_chunks',
  'last_retrieval_success_at',
  'first_retrieval_failure_at',
  'last_retrieval_failure_at',
  'consecutive_retrieval_failures',
  'retrieval_attempts',
];

export const prepareKudosDoc = (
  doc: ReturnType<typeof fillInKudosFields> & Record<string, unknown>,
  totalChunks: number,
) => {
  const orgs = [...(doc.owners ?? []), ...(doc.recipients ?? []), ...(doc.publishers ?? [])];
  const files = (doc.files ?? []).map(
    (f) =>
      Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'path')) as Omit<
        KudosFile,
        'path'
      >,
  );
  const enriched: Record<string, unknown> = {
    ...doc,
    orgs_long: [...new Set(displayNames(orgs))],
    files,
    file_sha256: [...new Set(files.flatMap((f) => (f.sha256 ? [f.sha256] : [])))],
    total_chunks: totalChunks,
  };
  return Object.fromEntries(
    kudosStoredFields.flatMap((k) => (k in enriched ? [[k, enriched[k]]] : [])),
  );
};

export const prepareKudosChunks = <C extends { chunk_id: string }>(
  chunks: (C & { searchPhrases?: unknown; embedding?: unknown })[],
) =>
  chunks.map(({ searchPhrases: _phrases, embedding: _embedding, ...chunk }) => ({
    ...chunk,
    id: chunk.chunk_id,
  }));

export class FileUnreachable extends Error {
  override readonly name = 'FileUnreachable';
}

export const isPdf = (bytes: Uint8Array) =>
  bytes.length >= 4 && new TextDecoder('ascii').decode(bytes.subarray(0, 4)) === '%PDF';

const citationPatterns = [
  /citation_pdf_url"?[^<>]{0,500}?content="([^"<>]{1,2000})"/i,
  /content="([^"<>]{1,2000})"[^<>]{0,500}?citation_pdf_url/i,
];

export const citationPdfUrl = (html: string) => {
  for (const pattern of citationPatterns) {
    const found = pattern.exec(html)?.[1];
    if (found) return found;
  }
  return undefined;
};

export const verifyKudosFile = (file: KudosFile, bytes: Uint8Array, source: string) => {
  if (!file.sha256)
    throw new Error(
      `Refusing unverified bytes from ${file.url} (${source}): the file entry has no sha256`,
    );
  if (file.size !== undefined && file.size !== null && Number(file.size) !== bytes.length)
    throw new Error(
      `The file from ${file.url} (${source}) is ${bytes.length} bytes, but Kudos lists ${file.size}`,
    );
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== file.sha256)
    throw new Error(`The file from ${file.url} (${source}) does not match the sha256 Kudos lists`);
  return bytes;
};

const deterministicStatuses = new Set([404, 410]);

export const fetchKudosFile = async (
  file: KudosFile,
  getBytes: (url: string) => Promise<Uint8Array>,
): Promise<Uint8Array> => {
  const get = async (url: string) => {
    try {
      return await getBytes(url);
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (typeof status === 'number' && deterministicStatuses.has(status))
        throw new FileUnreachable(`The file is unreachable at the indexed url (HTTP ${status})`, {
          cause: error,
        });
      throw error;
    }
  };
  const body = await get(file.url);
  if (isPdf(body)) return verifyKudosFile(file, body, 'direct');
  const html = new TextDecoder().decode(body);
  const hop = citationPdfUrl(html);
  if (!hop) {
    if (html.includes('citation_pdf_url'))
      throw new Error(
        `The landing page ${file.url} declares citation_pdf_url, but it could not be extracted`,
      );
    throw new FileUnreachable(
      `The indexed url ${file.url} served a landing page with no citation_pdf_url`,
    );
  }
  const hopped = await get(new URL(hop, file.url).toString());
  if (!isPdf(hopped)) throw new Error(`citation_pdf_url ${hop} did not yield a PDF`);
  return verifyKudosFile(file, hopped, 'citation_pdf_url');
};
