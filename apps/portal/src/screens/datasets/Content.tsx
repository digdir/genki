import {
  Alert,
  Button,
  Checkbox,
  Fieldset,
  Heading,
  Label,
  Paragraph,
  Search,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import type {
  DatasetDetailView,
  DatasetDocument,
  DatasetDocumentsPage,
  OriginalFile,
} from '../../api/datasets';
import { useAsync } from '../../hooks';
import { useT, type PlainKey, type T } from '../../i18n';
import { useRights } from '../../Shell';
import { Loading } from '../../states';
import type { FacetField } from '../../types';
import { isOwnEndpoint } from './live-model';
import { datasetTabPath } from './model';

export const pageSize = 50;
const searchDelayMs = 300;

export interface ContentRow {
  id: string;
  title: string;
  url?: string;
  fields: Record<string, unknown>;
  original?: OriginalFile;
  excerpt?: string;
}

const facetLabels: Record<string, PlainKey> = {
  type: 'datasets.facetType',
  doc_type: 'datasets.facetType',
  year: 'datasets.facetYear',
  unit: 'datasets.facetUnit',
  orgs_long: 'datasets.facetOrganisation',
};

export const facetLabel = (t: T, field: string) =>
  facetLabels[field] ? t(facetLabels[field]) : field;

const text = (value: unknown) =>
  value === undefined || value === null || value === ''
    ? undefined
    : Array.isArray(value)
      ? value.join(', ')
      : String(value);

const fieldOf = (row: Pick<ContentRow, 'fields'>, ...names: string[]) =>
  names.map((n) => text(row.fields[n])).find((v) => v !== undefined);

export const typeOf = (row: Pick<ContentRow, 'fields'>) => fieldOf(row, 'type', 'doc_type');
export const yearOf = (row: Pick<ContentRow, 'fields'>) => fieldOf(row, 'year');
export const unitOf = (row: Pick<ContentRow, 'fields'>) => fieldOf(row, 'unit', 'orgs_long');

const rowOf = (d: DatasetDocument): ContentRow => ({
  id: d.id,
  title: d.title ?? d.id,
  fields: d.fields,
  ...(d.url ? { url: d.url } : {}),
  ...(d.original ? { original: d.original } : {}),
});

export const filtersOf = (
  chosen: Record<string, string[]>,
  valueTypes: DatasetDetailView['valueTypes'] = {},
): Record<string, (string | number)[]> =>
  Object.fromEntries(
    Object.entries(chosen)
      .filter(([, values]) => values.length > 0)
      .map(([field, values]) => [
        field,
        valueTypes[field] === 'integer' ? values.map(Number) : values,
      ]),
  );

const problemOf = (error: unknown) => (error instanceof ApiError ? error.problem : undefined);

const problemText = (t: T, error: unknown) => {
  if (!(error instanceof ApiError) || error.status !== 422) return t('datasets.contentFailedText');
  const field = problemOf(error)
    ?.errors?.map((e) => /^filters\.(.+)$/.exec(e.path)?.[1])
    .find(Boolean);
  if (field) return t('datasets.filtersUndeclared', { field });
  if (problemOf(error)?.errors?.some((e) => e.path.startsWith('filters')))
    return t('datasets.filtersInvalid');
  return t('datasets.contentUnsupported');
};

const unlistable = (error: unknown) =>
  error instanceof ApiError &&
  error.status === 422 &&
  !problemOf(error)?.errors?.some((e) => e.path.startsWith('filters'));

const downloadProblems: Record<string, PlainKey> = {
  'urn:genai:problem:original-not-kept': 'datasets.originalNotKept',
  'urn:genai:problem:upload-people-only': 'datasets.uploadPeopleOnly',
};

const Drawer = ({
  api,
  tenant,
  dataset,
  row,
  onClose,
}: {
  api: ApiClient;
  tenant: string;
  dataset: string;
  row: ContentRow;
  onClose: () => void;
}) => {
  const t = useT();
  const close = useRef<HTMLButtonElement>(null);
  const [detail] = useAsync(
    (signal) => api.datasets.document(tenant, dataset, row.id, signal),
    [api, tenant, dataset, row.id],
  );
  const [downloading, setDownloading] = useState(false);
  const [failure, setFailure] = useState('');
  useEffect(() => close.current?.focus(), [row.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const known: ContentRow | undefined = detail.status === 'ready' ? rowOf(detail.data) : undefined;
  const shown: ContentRow = { ...row, ...(known ?? {}) };
  const excerpt = (detail.status === 'ready' ? detail.data.excerpt : undefined) ?? row.excerpt;
  const file = shown.original;

  const download = async () => {
    if (!file || downloading) return;
    setDownloading(true);
    setFailure('');
    try {
      const blob = await api.datasets.original(tenant, dataset, file.name);
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = href;
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(href), 0);
    } catch (error) {
      const known = downloadProblems[problemOf(error)?.type ?? ''];
      setFailure(t(known ?? 'datasets.downloadFailed'));
    } finally {
      setDownloading(false);
    }
  };

  const facts: [string, React.ReactNode][] = [
    [t('datasets.columnType'), typeOf(shown) ?? '–'],
    [t('datasets.facetUnit'), unitOf(shown) ?? '–'],
    [t('datasets.facetYear'), yearOf(shown) ?? '–'],
    [
      t('datasets.columnFile'),
      file ? (
        file.name
      ) : shown.url ? (
        <a href={shown.url} target="_blank" rel="noreferrer">
          {shown.url}
        </a>
      ) : (
        '–'
      ),
    ],
  ];
  const gone =
    detail.status === 'error' &&
    problemOf(detail.error)?.type === 'urn:genai:problem:dataset-document-not-found';

  return (
    <aside
      className="content-drawer stack-sm"
      role="dialog"
      aria-modal="false"
      aria-labelledby="doc-title"
    >
      <div className="row-wrap content-drawer-head">
        <Heading level={2} data-size="xs" id="doc-title">
          {shown.title}
        </Heading>
        <Button ref={close} variant="secondary" data-size="sm" onClick={onClose}>
          {t('datasets.close')}
        </Button>
      </div>
      <dl className="facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="fact-text">{value}</dd>
          </div>
        ))}
      </dl>
      <section className="stack-xs" aria-labelledby="doc-excerpt">
        <Heading level={3} data-size="2xs" id="doc-excerpt">
          {t('datasets.excerpt')}
        </Heading>
        <Paragraph data-size="sm">
          {gone
            ? t('datasets.documentNotFound')
            : (excerpt ??
              (detail.status === 'loading'
                ? t('datasets.loadingExcerpt')
                : t('datasets.noExcerpt')))}
        </Paragraph>
      </section>
      {file ? (
        <button
          type="button"
          className="link-button align-start"
          aria-disabled={downloading || undefined}
          onClick={() => void download()}
        >
          {t('datasets.downloadOriginal', { file: file.name })}
        </button>
      ) : null}
      {failure ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          {failure}
        </Alert>
      ) : null}
    </aside>
  );
};

const SkippedNote = ({ view }: { view: DatasetDetailView }) => {
  const t = useT();
  const skipped = view.skipped ?? [];
  const count = skipped.length || view.lastExecution?.skipped || 0;
  if (!count) return null;
  const total = count + (view.lastExecution?.stored ?? view.documents ?? 0);
  const scanned = skipped.length > 0 && skipped.every((s) => s.reason === 'no_text');
  return (
    <Paragraph data-size="sm" className="content-note">
      {t(scanned ? 'datasets.contentSkippedScanned' : 'datasets.contentSkipped', {
        count,
        total,
      })}{' '}
      <a href={`#${datasetTabPath(view.fullId, 'ingestions')}`}>{t('datasets.contentSeeFiles')}</a>
    </Paragraph>
  );
};

export const Content = ({
  api,
  tenant,
  view,
  canUpload,
  onUpload,
}: {
  api: ApiClient;
  tenant: string;
  view: DatasetDetailView;
  canUpload: boolean;
  onUpload: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const { has } = useRights();
  const canSearch = has('manage-services') || has('manage-datasets');
  const [query, setQuery] = useState('');
  const [asked, setAsked] = useState('');
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [open, setOpen] = useState<ContentRow>();
  const fields = view.facets ?? [];

  useEffect(() => {
    const timer = setTimeout(() => setAsked(query.trim()), searchDelayMs);
    return () => clearTimeout(timer);
  }, [query]);

  const endpoint = isOwnEndpoint(view);
  const [page, retry] = useAsync(
    (signal): Promise<DatasetDocumentsPage> =>
      endpoint
        ? Promise.resolve({ dataset: view.id, limit: pageSize, offset: 0, documents: [] })
        : api.datasets.documents(tenant, view.id, { limit: pageSize, offset: 0 }, signal),
    [api, tenant, view.id, endpoint],
  );
  const filters = filtersOf(chosen, view.valueTypes);
  const filterKey = JSON.stringify(filters);
  const filtering = Object.keys(filters).length > 0;
  const searching = canSearch && asked !== '';
  const [filtered, retryFiltered] = useAsync(
    (signal): Promise<DatasetDocumentsPage | undefined> =>
      filtering && !searching
        ? api.datasets.documents(
            tenant,
            view.id,
            { limit: pageSize, offset: 0, filters: JSON.parse(filterKey) as typeof filters },
            signal,
          )
        : Promise.resolve(undefined),
    [api, tenant, view.id, filterKey, filtering, searching],
  );
  const [facets] = useAsync(
    (signal): Promise<FacetField[]> =>
      fields.length ? api.facets(view.fullId, tenant, fields, signal) : Promise.resolve([]),
    [api, tenant, view.fullId, fields.join(',')],
  );
  const [hits, retryHits] = useAsync(async (): Promise<ContentRow[] | undefined> => {
    if (!searching) return undefined;
    const answer = await api.datasets.search(tenant, view.id, {
      query: asked,
      limit: 100,
      ...(filtering ? { filters: JSON.parse(filterKey) as typeof filters } : {}),
    });
    const byDocument = new Map<string, ContentRow>();
    for (const hit of answer.hits) {
      const id = hit.document ?? hit.id;
      if (byDocument.has(id)) continue;
      byDocument.set(id, {
        id,
        title: hit.title ?? id,
        fields: hit.fields,
        excerpt: hit.text,
        ...(hit.url ? { url: hit.url } : {}),
      });
    }
    return [...byDocument.values()];
  }, [api, tenant, view.id, asked, searching, filterKey]);

  const anyFilter = query.trim() !== '' || filtering;
  const reset = () => {
    setQuery('');
    setAsked('');
    setChosen({});
  };

  if (endpoint)
    return (
      <section className="stack-sm" aria-labelledby="content-endpoint-h">
        <Heading level={2} data-size="xs" id="content-endpoint-h">
          {t('datasets.endpointContentTitle')}
        </Heading>
        <Paragraph data-size="sm">{t('datasets.endpointContent')}</Paragraph>
      </section>
    );
  if (page.status === 'loading') return <Loading label={t('datasets.loadingDocuments')} />;
  if (page.status === 'error' && unlistable(page.error))
    return (
      <section className="stack-sm" aria-labelledby="content-unlisted-h">
        <Heading level={2} data-size="xs" id="content-unlisted-h">
          {t('datasets.tabContent')}
        </Heading>
        <Paragraph data-size="sm">{t('datasets.contentUnsupported')}</Paragraph>
      </section>
    );
  if (page.status === 'error')
    return (
      <Alert data-color="danger" role="alert">
        <Heading level={2} data-size="2xs">
          {t('datasets.contentFailed')}
        </Heading>
        <Paragraph data-size="sm">{problemText(t, page.error)}</Paragraph>
        <Button variant="secondary" data-size="sm" onClick={retry}>
          {t('common.tryAgain')}
        </Button>
      </Alert>
    );

  const loaded = page.data.documents.map(rowOf);
  const total = page.data.found ?? view.documents ?? loaded.length;
  if (loaded.length === 0 && total === 0)
    return (
      <section className="stack-sm" aria-labelledby="content-empty-h">
        <Heading level={2} data-size="xs" id="content-empty-h">
          {t('datasets.contentEmptyTitle')}
        </Heading>
        <Paragraph data-size="sm">
          {t(view.source === 'upload' ? 'datasets.contentEmptyUpload' : 'datasets.contentEmpty')}
        </Paragraph>
        {canUpload ? (
          <Button variant="primary" data-size="sm" className="align-start" onClick={onUpload}>
            {t('datasets.uploadFiles')}
          </Button>
        ) : null}
      </section>
    );

  const narrowed = searching ? hits : filtering ? filtered : undefined;
  const filteredPage = filtered.status === 'ready' ? filtered.data : undefined;
  const rows = searching
    ? hits.status === 'ready'
      ? (hits.data ?? [])
      : []
    : filtering
      ? (filteredPage?.documents.map(rowOf) ?? [])
      : loaded;
  const counted = searching
    ? rows.length
    : filtering
      ? (filteredPage?.found ?? rows.length)
      : total;
  const status =
    narrowed?.status === 'loading'
      ? t('datasets.contentSearching')
      : narrowed
        ? t('datasets.contentMatches', { amount: f.number(counted), total: f.number(total) })
        : t('datasets.contentCount', { count: total });
  const facetOptions = facets.status === 'ready' ? facets.data : [];

  return (
    <div className="stack content-tab">
      <SkippedNote view={view} />
      {canSearch ? (
        <div role="search" className="content-search stack-xs">
          <Label htmlFor="content-q">{t('datasets.contentSearchLabel')}</Label>
          <Search>
            <Search.Input
              id="content-q"
              placeholder={t('datasets.contentSearchPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Search.Clear onClick={() => setQuery('')} />
          </Search>
        </div>
      ) : null}
      <div className="content-layout">
        {fields.length ? (
          <div className="stack-sm content-facets">
            {fields.map((field) => {
              const options = facetOptions.find((x) => x.field === field)?.options ?? [];
              return (
                <Fieldset key={field} data-size="sm">
                  <Fieldset.Legend>{facetLabel(t, field)}</Fieldset.Legend>
                  {options.length === 0 ? (
                    <span className="meta">
                      {facets.status === 'loading'
                        ? t('datasets.loadingValues')
                        : t('datasets.valuesUnavailable')}
                    </span>
                  ) : (
                    options.map((o) => {
                      const on = (chosen[field] ?? []).includes(o.value);
                      return (
                        <div key={o.value} className="content-facet-option">
                          <Checkbox
                            label={o.value}
                            value={o.value}
                            checked={on}
                            onChange={() =>
                              setChosen((c) => ({
                                ...c,
                                [field]: on
                                  ? (c[field] ?? []).filter((v) => v !== o.value)
                                  : [...(c[field] ?? []), o.value],
                              }))
                            }
                          />
                          <span className="meta numeric">{f.number(o.count)}</span>
                        </div>
                      );
                    })
                  )}
                </Fieldset>
              );
            })}
            {anyFilter ? (
              <Button variant="tertiary" data-size="sm" className="align-start" onClick={reset}>
                {t('datasets.resetSearch')}
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="stack-sm content-results">
          <p role="status" className="meta">
            {status}
          </p>
          {!fields.length && anyFilter && rows.length > 0 ? (
            <Button variant="tertiary" data-size="sm" className="align-start" onClick={reset}>
              {t('datasets.resetSearch')}
            </Button>
          ) : null}
          {narrowed?.status === 'error' ? (
            <Alert data-color="danger" data-size="sm" role="alert">
              <Paragraph data-size="sm">
                {searching ? t('datasets.contentSearchFailed') : problemText(t, narrowed.error)}
              </Paragraph>
              <Button
                variant="secondary"
                data-size="sm"
                onClick={searching ? retryHits : retryFiltered}
              >
                {t('common.tryAgain')}
              </Button>
            </Alert>
          ) : rows.length > 0 ? (
            <>
              <div className="table-scroll">
                <Table aria-label={t('datasets.tabContent')}>
                  <TableHead>
                    <TableRow>
                      <TableHeaderCell scope="col">{t('datasets.columnTitle')}</TableHeaderCell>
                      <TableHeaderCell scope="col">{t('datasets.columnType')}</TableHeaderCell>
                      <TableHeaderCell scope="col">{t('datasets.facetYear')}</TableHeaderCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow
                        key={row.id}
                        className={open?.id === row.id ? 'content-row open' : 'content-row'}
                      >
                        <TableCell>
                          <button
                            type="button"
                            className="link-button"
                            aria-haspopup="dialog"
                            onClick={() => setOpen(row)}
                          >
                            {row.title}
                          </button>
                          {unitOf(row) ? (
                            <>
                              <br />
                              <span className="meta">{unitOf(row)}</span>
                            </>
                          ) : null}
                        </TableCell>
                        <TableCell>{typeOf(row) ?? '–'}</TableCell>
                        <TableCell>{yearOf(row) ?? '–'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {!searching && rows.length < counted ? (
                <p className="meta">
                  {t('datasets.contentMore', {
                    amount: f.number(rows.length),
                    total: f.number(counted),
                  })}
                </p>
              ) : null}
            </>
          ) : narrowed?.status === 'loading' ? null : (
            <section className="stack-xs" aria-labelledby="content-none-h">
              <Heading level={2} data-size="2xs" id="content-none-h">
                {t('datasets.contentNoMatch')}
              </Heading>
              <Paragraph data-size="sm">{t('datasets.contentNoMatchText')}</Paragraph>
              <Button variant="secondary" data-size="sm" className="align-start" onClick={reset}>
                {t('datasets.resetSearch')}
              </Button>
            </section>
          )}
        </div>
      </div>
      {open ? (
        <Drawer
          api={api}
          tenant={tenant}
          dataset={view.id}
          row={open}
          onClose={() => setOpen(undefined)}
        />
      ) : null}
    </div>
  );
};
