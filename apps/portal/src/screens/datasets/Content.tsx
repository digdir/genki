import {
  Alert,
  Button,
  Chip,
  Field,
  Heading,
  Label,
  Paragraph,
  Search,
  Select,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import type {
  DatasetDetailView,
  DatasetDocument,
  DatasetDocumentsPage,
  DocumentsRequest,
} from '../../api/datasets';
import {
  documentSorts,
  documentStatuses,
  documentStatusKeys,
  documentsParams,
  documentsViewOf,
  type DocumentsView,
} from '../../data/datasets';
import { parseRoute, useAsync } from '../../hooks';
import { useT, type PlainKey, type T } from '../../i18n';
import { Loading } from '../../states';
import type { FacetField } from '../../types';
import { DocumentPanel, saveOriginal } from './DocumentPanel';
import { DocumentsPager, DocumentsTable, RemoveFilesDialog, SelectionBar } from './DocumentsTable';
import { isOwnEndpoint } from './live-model';
import { datasetTabPath } from './model';

const searchDelayMs = 300;

const facetLabels: Record<string, PlainKey> = {
  type: 'datasets.facetType',
  doc_type: 'datasets.facetType',
  year: 'datasets.facetYear',
  unit: 'datasets.facetUnit',
  orgs_long: 'datasets.facetOrganisation',
};

export const facetLabel = (t: T, field: string) =>
  facetLabels[field] ? t(facetLabels[field]) : field;

export const filtersOf = (
  chosen: Record<string, string>,
  valueTypes: DatasetDetailView['valueTypes'] = {},
): Record<string, (string | number)[]> =>
  Object.fromEntries(
    Object.entries(chosen)
      .filter(([, value]) => value !== '')
      .map(([field, value]) => [field, [valueTypes[field] === 'integer' ? Number(value) : value]]),
  );

const problemOf = (error: unknown) => (error instanceof ApiError ? error.problem : undefined);

const invalidPaths = (error: unknown) =>
  error instanceof ApiError && error.status === 422
    ? (problemOf(error)?.errors?.map((e) => e.path) ?? [])
    : [];

const problemText = (t: T, error: unknown) => {
  if (!(error instanceof ApiError) || error.status !== 422) return t('datasets.contentFailedText');
  const field = invalidPaths(error)
    .map((path) => /^filters\.(.+)$/.exec(path)?.[1])
    .find(Boolean);
  if (field) return t('datasets.filtersUndeclared', { field });
  if (invalidPaths(error).some((p) => p.startsWith('filters'))) return t('datasets.filtersInvalid');
  return t('datasets.contentUnsupported');
};

const unlistable = (error: unknown) =>
  error instanceof ApiError && error.status === 422 && invalidPaths(error).length === 0;

const viewFromAddress = () => documentsViewOf(parseRoute(window.location.hash).query);

const unsorted = ({ sort: _, ...rest }: DocumentsView): DocumentsView => rest;

const withoutField = (filters: Record<string, string>, field: string) =>
  Object.fromEntries(Object.entries(filters).filter(([name]) => name !== field));

const sortValue = (sort: DocumentsView['sort']) => (sort ? `${sort.key}-${sort.order}` : '');

export const Content = ({
  api,
  tenant,
  view,
  canUpload,
  canManage,
  onUpload,
}: {
  api: ApiClient;
  tenant: string;
  view: DatasetDetailView;
  canUpload: boolean;
  canManage: boolean;
  onUpload: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const [docs, setDocs] = useState(viewFromAddress);
  const [typed, setTyped] = useState(docs.query);
  const [open, setOpen] = useState<DatasetDocument>();
  const [selected, setSelected] = useState<ReadonlyMap<string, DatasetDocument>>(new Map());
  const [asking, setAsking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string }[]>([]);
  const fields = view.facets ?? [];
  const endpoint = isOwnEndpoint(view);

  useEffect(() => {
    const follow = () => {
      if (parseRoute(window.location.hash).segments[0] !== 'datasets') return;
      const next = viewFromAddress();
      setDocs(next);
      setTyped(next.query);
    };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);

  const show = (next: DocumentsView, push = true) => {
    setDocs(next);
    const [path = '/', query = ''] = window.location.hash.replace(/^#/, '').split('?');
    const search = documentsParams(next, new URLSearchParams(query)).toString();
    const target = `#${path}${search ? `?${search}` : ''}`;
    if (target === window.location.hash) return;
    if (push) window.location.hash = target;
    else window.history.replaceState(window.history.state, '', target);
  };

  useEffect(() => {
    const asked = typed.trim();
    if (asked === docs.query) return;
    const timer = setTimeout(() => show({ ...docs, query: asked, page: 1 }, false), searchDelayMs);
    return () => clearTimeout(timer);
  });

  const indexed = docs.status === 'indexed';
  const filters = filtersOf(docs.filters, view.valueTypes);
  const request: DocumentsRequest = {
    limit: docs.size,
    offset: (docs.page - 1) * docs.size,
    status: docs.status,
    ...(docs.query ? { query: docs.query } : {}),
    ...(indexed && docs.sort ? { sort: docs.sort } : {}),
    ...(indexed && Object.keys(filters).length ? { filters } : {}),
  };
  const requestKey = JSON.stringify(request);
  const [page, retry, pending] = useAsync(
    (signal): Promise<DatasetDocumentsPage | undefined> =>
      endpoint
        ? Promise.resolve(undefined)
        : api.datasets.documents(
            tenant,
            view.id,
            JSON.parse(requestKey) as DocumentsRequest,
            signal,
          ),
    [api, tenant, view.id, endpoint, requestKey],
    { keepPreviousFor: view.id },
  );
  const [facets] = useAsync(
    (signal): Promise<FacetField[]> =>
      fields.length && !endpoint
        ? api.facets(view.fullId, tenant, fields, signal)
        : Promise.resolve([]),
    [api, tenant, view.fullId, fields.join(','), endpoint],
  );

  const refused = page.status === 'error' ? invalidPaths(page.error) : [];
  const dropQuery = refused.includes('query') && docs.query !== '';
  const dropSort = refused.includes('sort') && docs.sort !== undefined;
  const data = page.status === 'ready' ? page.data : undefined;
  const lastPage = data?.totalExact ? Math.max(1, Math.ceil(data.total / docs.size)) : undefined;
  const pastEnd =
    data !== undefined &&
    !pending &&
    data.documents.length === 0 &&
    docs.page > 1 &&
    lastPage !== undefined &&
    docs.page > lastPage;

  useEffect(() => {
    if (!dropQuery && !dropSort && !pastEnd) return;
    show(
      {
        ...(dropSort ? unsorted(docs) : docs),
        ...(dropQuery ? { query: '' } : {}),
        page: pastEnd && lastPage ? lastPage : 1,
      },
      false,
    );
    if (dropQuery) setTyped('');
  });

  const select = (picked: DatasetDocument[], on: boolean) =>
    setSelected((current) => {
      const next = new Map(current);
      for (const doc of picked) {
        if (on) next.set(doc.id, doc);
        else next.delete(doc.id);
      }
      return next;
    });
  const chosenFiles = [...selected.values()].flatMap((d) => (d.original ? [d.original.name] : []));

  const downloadChosen = async () => {
    if (downloading) return;
    setDownloading(true);
    setOutcome([]);
    const failed: string[] = [];
    for (const name of chosenFiles) {
      try {
        await saveOriginal(api, tenant, view.id, name);
      } catch {
        failed.push(name);
      }
    }
    setDownloading(false);
    if (failed.length)
      setOutcome([
        { ok: false, text: t('datasets.downloadSomeFailed', { names: failed.join(', ') }) },
      ]);
  };

  const removeChosen = async () => {
    if (removing) return;
    setRemoving(true);
    const removed: string[] = [];
    const failed: string[] = [];
    for (const [id, doc] of selected) {
      const name = doc.original?.name;
      if (!name) continue;
      try {
        await api.datasets.removeUpload(
          tenant,
          view.id,
          name,
          t('datasets.removeReason', { name, dataset: view.name }),
        );
        removed.push(id);
      } catch {
        failed.push(name);
      }
    }
    setRemoving(false);
    setAsking(false);
    setSelected((current) => new Map([...current].filter(([id]) => !removed.includes(id))));
    setOutcome([
      ...(removed.length
        ? [{ ok: true, text: t('datasets.removedFiles', { count: removed.length }) }]
        : []),
      ...(failed.length
        ? [{ ok: false, text: t('datasets.removeFailed', { names: failed.join(', ') }) }]
        : []),
    ]);
    if (removed.length) retry();
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
  const skeleton = (
    <Loading
      label={t('datasets.loadingDocuments')}
      shape="table"
      columns={[
        t('datasets.columnTitle'),
        t('datasets.columnType'),
        t('datasets.columnSource'),
        t('datasets.columnChunks'),
        t('datasets.columnStatus'),
      ]}
      onRetry={retry}
    />
  );
  if (page.status === 'loading') return skeleton;
  if (page.status === 'error' && unlistable(page.error))
    return (
      <section className="stack-sm" aria-labelledby="content-unlisted-h">
        <Heading level={2} data-size="xs" id="content-unlisted-h">
          {t('datasets.tabContent')}
        </Heading>
        <Paragraph data-size="sm">{t('datasets.contentUnsupported')}</Paragraph>
      </section>
    );
  if (page.status === 'error' && (dropQuery || dropSort)) return skeleton;
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
  if (!page.data) return null;

  const answer = page.data;
  const counts = answer.statusCounts;
  const narrowed = docs.query !== '' || Object.keys(docs.filters).length > 0;
  const anyFilter = narrowed || !indexed;
  if (
    !anyFilter &&
    answer.total === 0 &&
    (counts.indexed ?? 0) === 0 &&
    counts.failed === 0 &&
    counts.pending === 0
  )
    return (
      <section className="stack-sm docs-empty" aria-labelledby="content-empty-h">
        <Heading level={2} data-size="xs" id="content-empty-h">
          {t('datasets.contentEmptyTitle')}
        </Heading>
        <Paragraph data-size="sm">
          {t(view.source === 'upload' ? 'datasets.contentEmptyUpload' : 'datasets.contentEmpty')}
        </Paragraph>
        <div className="row-wrap">
          {canUpload ? (
            <Button variant="primary" data-size="sm" onClick={onUpload}>
              {t('datasets.uploadFiles')}
            </Button>
          ) : null}
          {view.editable ? (
            <Button asChild variant="secondary" data-size="sm">
              <a href={`#${datasetTabPath(view.fullId, 'ingestions')}`}>
                {t('datasets.seeIngestions')}
              </a>
            </Button>
          ) : null}
        </div>
      </section>
    );

  const canQuery = answer.listing.query || !indexed;
  const sorts = indexed ? documentSorts.filter((s) => answer.listing.sort.includes(s.key)) : [];
  const facetOptions = facets.status === 'ready' ? facets.data : [];
  const statusLabel = (status: (typeof documentStatuses)[number]) => {
    const label = t(documentStatusKeys[status]);
    const count = counts[status];
    return count === null
      ? label
      : t('datasets.docOptionCount', { label, amount: f.number(count) });
  };
  const chips = [
    ...(indexed
      ? []
      : [
          {
            key: 'status',
            name: t('datasets.docStatusLabel'),
            value: t(documentStatusKeys[docs.status]),
            clear: () => show({ ...docs, status: 'indexed', page: 1 }),
          },
        ]),
    ...Object.entries(docs.filters).map(([field, value]) => ({
      key: `filter-${field}`,
      name: facetLabel(t, field),
      value,
      clear: () => {
        show({ ...docs, filters: withoutField(docs.filters, field), page: 1 });
      },
    })),
  ];
  const reset = () => {
    setTyped('');
    show({ ...docs, query: '', filters: {}, status: 'indexed', page: 1 });
  };
  const from = answer.documents.length ? answer.offset + 1 : 0;
  const to = answer.offset + answer.documents.length;
  const range = {
    from: f.number(from),
    to: f.number(to),
    total: f.number(answer.total),
  };
  const rangeText = narrowed
    ? answer.totalExact
      ? t('datasets.docRangeMatching', range)
      : t('datasets.docRangeMatchingAbout', range)
    : answer.totalExact
      ? t('datasets.docRange', range)
      : t('datasets.docRangeAbout', range);
  const statusText = pending
    ? t('datasets.docLoadingPage', { page: f.number(docs.page) })
    : answer.documents.length === 0
      ? t('datasets.noMatchStatus')
      : rangeText;
  const pages = Math.max(1, Math.ceil(answer.total / docs.size));

  return (
    <div className="stack-sm docs-tab">
      <section className="stack-sm" aria-labelledby="docs-h">
        <h2 id="docs-h" className="visually-hidden">
          {t('datasets.documentsTable')}
        </h2>
        <div className="docs-toolbar">
          {canQuery ? (
            <div role="search" className="docs-search">
              <Label htmlFor="docs-q">{t('datasets.docSearchLabel')}</Label>
              <Search>
                <Search.Input
                  id="docs-q"
                  placeholder={t('datasets.docSearchPlaceholder')}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                />
                <Search.Clear onClick={() => setTyped('')} />
              </Search>
            </div>
          ) : null}
          <Field className="docs-select">
            <Label htmlFor="docs-status">{t('datasets.docStatusLabel')}</Label>
            <Select
              id="docs-status"
              value={docs.status}
              onChange={(e) => {
                const status = documentStatuses.find((s) => s === e.target.value) ?? 'indexed';
                show(
                  status === 'indexed'
                    ? { ...docs, status, page: 1 }
                    : { ...unsorted(docs), status, filters: {}, page: 1 },
                );
              }}
            >
              {documentStatuses.map((s) => (
                <Select.Option key={s} value={s}>
                  {statusLabel(s)}
                </Select.Option>
              ))}
            </Select>
          </Field>
          {indexed
            ? fields.map((field) => {
                const options = facetOptions.find((x) => x.field === field)?.options ?? [];
                const chosen = docs.filters[field] ?? '';
                return (
                  <Field key={field} className="docs-select">
                    <Label htmlFor={`docs-filter-${field}`}>{facetLabel(t, field)}</Label>
                    <Select
                      id={`docs-filter-${field}`}
                      value={chosen}
                      onChange={(e) =>
                        show({
                          ...docs,
                          filters: { ...docs.filters, [field]: e.target.value },
                          page: 1,
                        })
                      }
                    >
                      <Select.Option value="">{t('datasets.docFilterAll')}</Select.Option>
                      {chosen && !options.some((o) => o.value === chosen) ? (
                        <Select.Option value={chosen}>{chosen}</Select.Option>
                      ) : null}
                      {options.map((o) => (
                        <Select.Option key={o.value} value={o.value}>
                          {t('datasets.docOptionCount', {
                            label: o.value,
                            amount: f.number(o.count),
                          })}
                        </Select.Option>
                      ))}
                    </Select>
                  </Field>
                );
              })
            : null}
          {sorts.length ? (
            <Field className="docs-select">
              <Label htmlFor="docs-sort">{t('datasets.docSortLabel')}</Label>
              <Select
                id="docs-sort"
                value={sortValue(docs.sort)}
                onChange={(e) => {
                  const sort = sorts.find((s) => sortValue(s) === e.target.value);
                  show(
                    sort
                      ? { ...docs, sort: { key: sort.key, order: sort.order }, page: 1 }
                      : { ...unsorted(docs), page: 1 },
                  );
                }}
              >
                <Select.Option value="">{t('datasets.docSortDefault')}</Select.Option>
                {sorts.map((s) => (
                  <Select.Option key={s.key} value={sortValue(s)}>
                    {t(s.label)}
                  </Select.Option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>
        <div className="docs-summary">
          <p role="status" className="meta numeric">
            {statusText}
          </p>
          {chips.map((chip) => (
            <Chip.Removable
              key={chip.key}
              data-size="sm"
              aria-label={t('datasets.docChipRemove', { name: chip.name, value: chip.value })}
              onClick={chip.clear}
            >
              {t('datasets.docChip', { name: chip.name, value: chip.value })}
            </Chip.Removable>
          ))}
          {anyFilter ? (
            <Button variant="tertiary" data-size="sm" onClick={reset}>
              {t('datasets.docReset')}
            </Button>
          ) : null}
        </div>
        {answer.documents.length === 0 ? (
          <section className="stack-xs docs-none" aria-labelledby="docs-none-h">
            <Heading level={3} data-size="2xs" id="docs-none-h">
              {t('datasets.noMatchTitle')}
            </Heading>
            <Paragraph data-size="sm">{t('datasets.contentNoMatchText')}</Paragraph>
            <div className="row-wrap">
              {chips.map((chip) => (
                <Button key={chip.key} variant="secondary" data-size="sm" onClick={chip.clear}>
                  {t('datasets.removeFilter', { name: chip.name })}
                </Button>
              ))}
              <Button variant="tertiary" data-size="sm" onClick={reset}>
                {t('datasets.resetAll')}
              </Button>
            </div>
          </section>
        ) : (
          <>
            {selected.size ? (
              <SelectionBar
                count={selected.size}
                canRemove={canManage}
                downloading={downloading}
                removing={removing}
                onDownload={() => void downloadChosen()}
                onRemove={() => setAsking(true)}
                onClear={() => setSelected(new Map())}
              />
            ) : null}
            {outcome.map((o) => (
              <Alert
                key={o.text}
                data-color={o.ok ? 'success' : 'danger'}
                data-size="sm"
                role={o.ok ? 'status' : 'alert'}
              >
                {o.text}
              </Alert>
            ))}
            <DocumentsTable
              documents={answer.documents}
              openId={open?.id}
              busy={pending}
              onOpen={setOpen}
              selected={new Set(selected.keys())}
              onSelect={select}
            />
            <DocumentsPager
              page={docs.page}
              pages={pages}
              exact={answer.totalExact}
              hasNext={answer.documents.length === docs.size}
              size={docs.size}
              onPage={(n) => show({ ...docs, page: n })}
              onSize={(size) => show({ ...docs, size, page: 1 })}
            />
          </>
        )}
      </section>
      {asking ? (
        <RemoveFilesDialog
          count={selected.size}
          removing={removing}
          onKeep={() => !removing && setAsking(false)}
          onRemove={() => void removeChosen()}
        />
      ) : null}
      {open ? (
        <DocumentPanel
          key={open.id}
          api={api}
          tenant={tenant}
          dataset={view.id}
          doc={open}
          onClose={() => setOpen(undefined)}
        />
      ) : null}
    </div>
  );
};
