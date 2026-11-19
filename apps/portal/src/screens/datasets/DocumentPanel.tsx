import { ExternalLinkIcon } from '@navikt/aksel-icons';
import { Alert, Button, Heading, Paragraph, Tag } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import type { DatasetDocument, DocumentChunk } from '../../api/datasets';
import { AnswerMarkdown } from '../../components/AnswerMarkdown';
import { Icon } from '../../components/Icon';
import { SidePanel } from '../../components/SidePanel';
import { documentStatusColors, documentStatusKeys } from '../../data/datasets';
import { useAsync } from '../../hooks';
import { useT, type PlainKey, type T } from '../../i18n';
import { sourceOf, typeOf, unitOf, yearOf } from './DocumentsTable';
import { readableText, reasonText } from './live-model';

export const firstChunks = 3;
export const moreChunksStep = 10;

const downloadProblems: Record<string, PlainKey> = {
  'urn:genai:problem:original-not-kept': 'datasets.originalNotKept',
  'urn:genai:problem:upload-people-only': 'datasets.uploadPeopleOnly',
};

export const saveOriginal = async (
  api: ApiClient,
  tenant: string,
  dataset: string,
  name: string,
) => {
  const blob = await api.datasets.original(tenant, dataset, name);
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 0);
};

const problemType = (error: unknown) =>
  error instanceof ApiError ? (error.problem?.type ?? '') : '';

const chunkLabel = (t: T, chunk: DocumentChunk, index: number, total: number | undefined) => {
  const n = (chunk.position ?? index) + 1;
  const head =
    total === undefined ? t('datasets.chunkN', { n }) : t('datasets.chunkOf', { n, total });
  const page =
    chunk.page === undefined
      ? undefined
      : chunk.pageEnd !== undefined && chunk.pageEnd !== chunk.page
        ? t('datasets.chunkPages', { from: chunk.page, to: chunk.pageEnd })
        : t('datasets.chunkPage', { page: chunk.page });
  return page ? `${head} · ${page}` : head;
};

export const DocumentPanel = ({
  api,
  tenant,
  dataset,
  doc,
  onClose,
}: {
  api: ApiClient;
  tenant: string;
  dataset: string;
  doc: DatasetDocument;
  onClose: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const indexed = doc.status === 'indexed';
  const [detail] = useAsync(
    async (signal) => {
      if (!indexed) return undefined;
      try {
        const read = await api.datasets.document(tenant, dataset, doc.id, signal, {
          from: 0,
          to: firstChunks - 1,
        });
        return { read, chunks: true };
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 422) throw error;
        return {
          read: await api.datasets.document(tenant, dataset, doc.id, signal),
          chunks: false,
        };
      }
    },
    [api, tenant, dataset, doc.id, indexed],
  );
  const [more, setMore] = useState<DocumentChunk[]>([]);
  const [ended, setEnded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [failure, setFailure] = useState('');

  const read = detail.status === 'ready' ? detail.data?.read : undefined;
  const shown: DatasetDocument = { ...doc, ...(read ?? {}) };
  const file = shown.original;
  const chunks = [...(read?.chunks ?? []), ...more];
  const total = shown.chunkCount;
  const firstFull = (read?.chunks?.length ?? 0) >= firstChunks;
  const hasMore =
    total !== undefined ? chunks.length < total : !ended && firstFull && chunks.length > 0;
  const gone =
    detail.status === 'error' &&
    problemType(detail.error) === 'urn:genai:problem:dataset-document-not-found';

  const loadMore = async () => {
    if (loadingMore) return;
    const from = chunks.length;
    const to = Math.min(from + moreChunksStep, total ?? Infinity) - 1;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const next = await api.datasets.document(tenant, dataset, doc.id, undefined, { from, to });
      const got = next.chunks ?? [];
      setMore((m) => [...m, ...got]);
      if (got.length < to - from + 1) setEnded(true);
    } catch {
      setMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const download = async () => {
    if (!file || downloading) return;
    setDownloading(true);
    setFailure('');
    try {
      await saveOriginal(api, tenant, dataset, file.name);
    } catch (error) {
      setFailure(t(downloadProblems[problemType(error)] ?? 'datasets.downloadFailed'));
    } finally {
      setDownloading(false);
    }
  };

  const facts: [string, string][] = [
    [t('datasets.facetUnit'), unitOf(shown)],
    [t('datasets.facetYear'), yearOf(shown)],
    [t('datasets.columnSource'), sourceOf(t, shown)],
    [t('datasets.factDocumentId'), shown.id],
    [
      t('datasets.factOriginal'),
      file ? t('datasets.originalValue', { name: file.name, size: f.bytes(file.size) }) : undefined,
    ],
  ].filter((fact): fact is [string, string] => fact[1] !== undefined);
  const type = typeOf(shown);

  return (
    <SidePanel title={shown.title ?? shown.id} onClose={onClose} width={440}>
      <div className="stack-sm doc-panel">
        <div className="tag-row">
          <Tag data-size="sm" data-color={documentStatusColors[shown.status]}>
            {t(documentStatusKeys[shown.status])}
          </Tag>
          {type ? (
            <Tag data-size="sm" data-color="neutral">
              {type}
            </Tag>
          ) : null}
        </div>
        {shown.url || file ? (
          <div className="row-wrap">
            {shown.url ? (
              <Button asChild variant="primary" data-size="sm">
                <a href={shown.url} target="_blank" rel="noreferrer">
                  {t('datasets.openSource')}
                  <Icon icon={ExternalLinkIcon} />
                </a>
              </Button>
            ) : null}
            {file ? (
              <Button
                variant="secondary"
                data-size="sm"
                aria-disabled={downloading || undefined}
                onClick={() => void download()}
              >
                {t('datasets.downloadOriginal', { file: file.name })}
              </Button>
            ) : null}
          </div>
        ) : null}
        {failure ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {failure}
          </Alert>
        ) : null}
        <dl className="facts">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd className="fact-text">{value}</dd>
            </div>
          ))}
        </dl>
        {shown.status === 'failed' ? (
          <Alert data-color="danger" data-size="sm">
            {reasonText(t, shown.reason ?? 'failed')}
          </Alert>
        ) : null}
        {shown.status === 'pending' ? (
          <Alert data-color="info" data-size="sm">
            {t('datasets.pendingNote')}
          </Alert>
        ) : null}
        {indexed ? (
          <section className="stack-xs" aria-labelledby="doc-excerpt">
            <Heading level={3} data-size="2xs" id="doc-excerpt">
              {t('datasets.textStart')}
            </Heading>
            {read?.excerpt && !gone ? (
              <div className="doc-excerpt doc-text">
                <AnswerMarkdown text={readableText(read.excerpt)} />
              </div>
            ) : (
              <Paragraph data-size="sm" className="doc-excerpt">
                {gone
                  ? t('datasets.documentNotFound')
                  : detail.status === 'loading'
                    ? t('datasets.loadingExcerpt')
                    : t('datasets.noExcerpt')}
              </Paragraph>
            )}
          </section>
        ) : null}
        {indexed && !gone && (detail.status !== 'ready' || detail.data?.chunks) ? (
          <section className="stack-xs" aria-labelledby="doc-chunks">
            <div className="row-wrap doc-chunks-head">
              <Heading level={3} data-size="2xs" id="doc-chunks">
                {t('datasets.chunksHeading')}
              </Heading>
              {total !== undefined ? (
                <span className="meta">{t('datasets.chunksCount', { count: total })}</span>
              ) : null}
            </div>
            {detail.status === 'loading' ? (
              <p className="meta">{t('datasets.loadingChunks')}</p>
            ) : detail.status === 'error' ? (
              <p className="meta">{t('datasets.chunksFailed')}</p>
            ) : chunks.length === 0 ? (
              <p className="meta">{t('datasets.noChunks')}</p>
            ) : (
              <ol className="doc-chunks">
                {chunks.map((chunk, i) => (
                  <li key={chunk.id}>
                    <span className="meta">{chunkLabel(t, chunk, i, total)}</span>
                    <div className="doc-text">
                      <AnswerMarkdown text={readableText(chunk.text)} />
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {moreFailed ? (
              <Alert data-color="danger" data-size="sm" role="alert">
                {t('datasets.chunksFailed')}
              </Alert>
            ) : null}
            {detail.status === 'ready' && hasMore ? (
              <Button
                variant="tertiary"
                data-size="sm"
                className="align-start"
                aria-disabled={loadingMore || undefined}
                onClick={() => void loadMore()}
              >
                {loadingMore ? t('datasets.loadingChunks') : t('datasets.moreChunks')}
              </Button>
            ) : null}
          </section>
        ) : null}
      </div>
    </SidePanel>
  );
};
