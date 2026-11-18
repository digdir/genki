import type { DocumentSortKey, DocumentStatus, SortOrder } from '../api/datasets';
import type { PlainKey } from '../i18n';

export type DatasetStatus =
  | 'Klar'
  | 'Delvis lest inn'
  | 'Feilet'
  | 'Innlesing pågår'
  | 'I kø'
  | 'Venter'
  | 'Ikke lest inn'
  | 'Utenfor plattformen'
  | 'Eget endepunkt';

export const statusKeys: Record<DatasetStatus, PlainKey> = {
  Klar: 'datasets.statusReady',
  'Delvis lest inn': 'datasets.statusPartial',
  Feilet: 'datasets.statusIngestionFailed',
  'Innlesing pågår': 'datasets.statusRunning',
  'I kø': 'datasets.statusQueued',
  Venter: 'datasets.statusWaiting',
  'Ikke lest inn': 'datasets.statusNotRead',
  'Utenfor plattformen': 'datasets.statusExternal',
  'Eget endepunkt': 'datasets.statusEndpoint',
};

export const statusColors: Record<
  DatasetStatus,
  'success' | 'warning' | 'danger' | 'info' | 'neutral'
> = {
  Klar: 'success',
  'Delvis lest inn': 'warning',
  Feilet: 'danger',
  'Innlesing pågår': 'info',
  'I kø': 'info',
  Venter: 'info',
  'Ikke lest inn': 'neutral',
  'Utenfor plattformen': 'info',
  'Eget endepunkt': 'info',
};

export const kudosDocumentTypes = [
  'Tildelingsbrev',
  'Årsrapport',
  'Evaluering',
  'Statusrapport',
  'Strategi/plan',
  'Instruks',
  'Melding',
  'Proposisjon til Stortinget',
];

export const documentPageSizes = [25, 50, 100] as const;
export type DocumentPageSize = (typeof documentPageSizes)[number];
export const defaultDocumentPageSize: DocumentPageSize = 50;

export const documentStatuses: readonly DocumentStatus[] = ['indexed', 'failed', 'pending'];

export const documentStatusKeys: Record<DocumentStatus, PlainKey> = {
  indexed: 'datasets.docStatusIndexed',
  failed: 'datasets.docStatusFailed',
  pending: 'datasets.docStatusPending',
};

export const documentStatusColors: Record<DocumentStatus, 'success' | 'danger' | 'warning'> = {
  indexed: 'success',
  failed: 'danger',
  pending: 'warning',
};

export const documentSorts: readonly {
  key: DocumentSortKey;
  order: SortOrder;
  label: PlainKey;
}[] = [
  { key: 'updated', order: 'desc', label: 'datasets.sortUpdated' },
  { key: 'title', order: 'asc', label: 'datasets.sortTitle' },
  { key: 'year', order: 'desc', label: 'datasets.sortYear' },
];

export interface DocumentsView {
  page: number;
  size: DocumentPageSize;
  query: string;
  sort?: { key: DocumentSortKey; order: SortOrder };
  status: DocumentStatus;
  filters: Record<string, string>;
}

const filterPrefix = 'filter.';

export const documentsViewOf = (params: URLSearchParams): DocumentsView => {
  const page = Number(params.get('page'));
  const size = Number(params.get('size'));
  const sort = documentSorts.find((s) => s.key === params.get('sort'));
  const order = params.get('order');
  const status = documentStatuses.find((s) => s === params.get('status')) ?? 'indexed';
  const filters = Object.fromEntries(
    [...params.entries()]
      .filter(([k, v]) => k.startsWith(filterPrefix) && k.length > filterPrefix.length && v)
      .map(([k, v]) => [k.slice(filterPrefix.length), v]),
  );
  return {
    page: Number.isInteger(page) && page > 0 ? page : 1,
    size: documentPageSizes.find((s) => s === size) ?? defaultDocumentPageSize,
    query: params.get('q') ?? '',
    ...(sort
      ? { sort: { key: sort.key, order: order === 'asc' || order === 'desc' ? order : sort.order } }
      : {}),
    status,
    filters,
  };
};

export const documentsParams = (view: DocumentsView, keep: URLSearchParams) => {
  const params = new URLSearchParams(
    [...keep.entries()].filter(
      ([k]) =>
        !k.startsWith(filterPrefix) &&
        !['page', 'size', 'q', 'sort', 'order', 'status'].includes(k),
    ),
  );
  if (view.page > 1) params.set('page', String(view.page));
  if (view.size !== defaultDocumentPageSize) params.set('size', String(view.size));
  if (view.query) params.set('q', view.query);
  if (view.sort) {
    params.set('sort', view.sort.key);
    params.set('order', view.sort.order);
  }
  if (view.status !== 'indexed') params.set('status', view.status);
  for (const [field, value] of Object.entries(view.filters))
    if (value) params.set(`${filterPrefix}${field}`, value);
  return params;
};
