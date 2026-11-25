import {
  Button,
  Heading,
  Paragraph,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import type { ApiClient } from '../api';
import { useAsync } from '../hooks';
import { useT } from '../i18n';
import { useReason } from '../reason';
import { ErrorState, Loading } from '../states';
import { Flash, formatWhen, PageHeader, TableRegion, useFlash } from '../ui';
import { formatOrgNumber } from './Tenants';

interface Review {
  id: string;
  tenant: string;
  tenantName: string;
  block: string;
  version: number;
  requestedBy: string;
  requestedAt: string;
  reason: string;
  title: { nb?: string; en?: string };
  reads: string[];
  events: string[];
  bytes: number;
}

interface ReviewDetail extends Review {
  bundle: string;
  sources: Record<string, string>;
}

const nameOf = (review: Review) => review.title.nb ?? review.title.en ?? review.block;
const base = '/operator/block-share-requests';

const Detail = ({
  api,
  review,
  onDecided,
}: {
  api: ApiClient;
  review: Review;
  onDecided: (approved: boolean, version?: number) => void;
}) => {
  const t = useT();
  const reason = useReason();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [state] = useAsync(
    async (signal) =>
      (await api.getJson(`${base}/${encodeURIComponent(review.id)}`, signal)) as ReviewDetail,
    [api, review.id],
  );

  const shown = state.status === 'ready';
  const decide = async (approve: boolean) => {
    if (busy || !shown) return;
    const why = reason.require();
    if (!why) return;
    setBusy(true);
    setFailed(false);
    try {
      const path = `${base}/${encodeURIComponent(review.id)}/${approve ? 'approve' : 'decline'}`;
      const answer = (await api.configPost(path, why)) as { version?: number };
      onDecided(approve, answer.version);
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  const name = nameOf(review);
  const list = (items: string[]) =>
    items.length === 0 ? (
      <Paragraph>{t('blockReviews.none')}</Paragraph>
    ) : (
      <ul>
        {items.map((item) => (
          <li key={item}>
            <code>{item}</code>
          </li>
        ))}
      </ul>
    );

  return (
    <section className="card stack" aria-labelledby="block-review-h">
      <Heading level={2} data-size="sm" id="block-review-h">
        {t('blockReviews.detailTitle', { name, version: review.version })}
      </Heading>
      <Paragraph>
        {t('blockReviews.requestReason', { who: review.requestedBy, reason: review.reason })}
      </Paragraph>
      <Heading level={3} data-size="xs">
        {t('blockReviews.reads')}
      </Heading>
      {list(review.reads)}
      <Heading level={3} data-size="xs">
        {t('blockReviews.events')}
      </Heading>
      {list(review.events)}
      <Paragraph>{t('blockReviews.size', { bytes: review.bytes })}</Paragraph>
      {state.status === 'loading' ? (
        <Loading label={t('blockReviews.loading')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} />
      ) : (
        <>
          <Heading level={3} data-size="xs">
            {t('blockReviews.bundle')}
          </Heading>
          <Paragraph data-size="sm">{t('blockReviews.bundleIsApproved')}</Paragraph>
          <pre className="code" tabIndex={0} aria-label={t('blockReviews.bundle')}>
            {state.data.bundle}
          </pre>
          {Object.entries(state.data.sources).map(([path, text]) => (
            <div key={path}>
              <Heading level={3} data-size="xs">
                {t('blockReviews.source', { path })}
              </Heading>
              <pre className="code" tabIndex={0} aria-label={t('blockReviews.source', { path })}>
                {text}
              </pre>
            </div>
          ))}
        </>
      )}
      {reason.field('')}
      {failed ? <Paragraph role="alert">{t('blockReviews.failed')}</Paragraph> : null}
      <div className="actions-row">
        <Button loading={busy} disabled={busy || !shown} onClick={() => void decide(true)}>
          {t('blockReviews.approve')}
        </Button>
        <Button
          variant="secondary"
          loading={busy}
          disabled={busy || !shown}
          onClick={() => void decide(false)}
        >
          {t('blockReviews.decline')}
        </Button>
      </div>
    </section>
  );
};

export const BlockReviews = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const f = useFormat();
  const flash = useFlash();
  const [state, retry] = useAsync(
    async (signal) => (await api.getJson(`${base}?status=pending`, signal)) as { data: Review[] },
    [api],
  );
  const [chosen, setChosen] = useState<string | undefined>();
  const [decided, setDecided] = useState<Set<string>>(() => new Set());

  const pending = state.status === 'ready' ? state.data.data.filter((r) => !decided.has(r.id)) : [];
  const selected = pending.find((r) => r.id === chosen);

  const onDecided = (review: Review) => (approved: boolean, version?: number) => {
    setDecided((all) => new Set(all).add(review.id));
    setChosen(undefined);
    flash.show(
      approved
        ? t('blockReviews.approved', { name: nameOf(review), version: version ?? review.version })
        : t('blockReviews.declined', { name: nameOf(review) }),
    );
  };

  return (
    <>
      <PageHeader title={t('blockReviews.title')} />
      <Flash message={flash.message} />
      {state.status === 'loading' ? (
        <Loading label={t('blockReviews.loading')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : pending.length === 0 ? (
        <Paragraph>{t('blockReviews.empty')}</Paragraph>
      ) : (
        <TableRegion label={t('blockReviews.tableLabel')}>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t('blockReviews.colOrganisation')}</TableHeaderCell>
                <TableHeaderCell>{t('blockReviews.colBlock')}</TableHeaderCell>
                <TableHeaderCell>{t('blockReviews.colVersion')}</TableHeaderCell>
                <TableHeaderCell>{t('blockReviews.colSent')}</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {pending.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    {r.tenantName}
                    <div className="muted">{formatOrgNumber(r.tenant)}</div>
                  </TableCell>
                  <TableCell>{nameOf(r)}</TableCell>
                  <TableCell>{r.version}</TableCell>
                  <TableCell>{formatWhen(r.requestedAt, f, t)}</TableCell>
                  <TableCell>
                    <Button
                      variant="secondary"
                      data-size="sm"
                      aria-label={t('blockReviews.openFor', { name: nameOf(r) })}
                      onClick={() => setChosen(r.id)}
                    >
                      {t('blockReviews.open')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableRegion>
      )}
      {selected ? (
        <Detail key={selected.id} api={api} review={selected} onDecided={onDecided(selected)} />
      ) : null}
    </>
  );
};
