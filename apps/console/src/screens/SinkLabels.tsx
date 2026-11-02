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
  Tag,
} from '@digdir/designsystemet-react';
import { useId, useState } from 'react';
import type { ApiClient } from '../api';
import { useT } from '../i18n';
import { useAsync } from '../hooks';
import { EmptyState, ErrorState, Loading } from '../states';
import type { SinkLabelBatch } from '../types';
import { Flash, ReasonDialog, useFlash } from '../ui';

const Batch = ({
  batch,
  onDecide,
}: {
  batch: SinkLabelBatch;
  onDecide: (decision: 'accept' | 'reject') => void;
}) => {
  const t = useT();
  const id = useId();
  const verdict = (label: string | undefined) =>
    label === undefined
      ? t('qualityMatrix.sinkNoJudgeScore')
      : label === 'good'
        ? t('qualityMatrix.good')
        : label === 'bad'
          ? t('qualityMatrix.bad')
          : label;
  return (
    <section className="card stack" aria-labelledby={`${id}-h`}>
      <Heading level={3} data-size="2xs" id={`${id}-h`}>
        {t('qualityMatrix.sinkBatchTitle', {
          name: batch.name,
          tenant: batch.tenant,
          connection: batch.connection,
        })}
      </Heading>
      <Paragraph data-size="sm">
        {[
          `${t('qualityMatrix.sinkPending', { count: batch.labels.length })}: ${t(
            'qualityMatrix.sinkSplit',
            {
              alike: batch.alike,
              unlike: batch.paired - batch.alike,
              unpaired: batch.unpaired,
            },
          )}`,
          t('qualityMatrix.sinkLabellers', { count: batch.labellers }),
        ].join(' · ')}
      </Paragraph>
      <Table data-size="sm" zebra>
        <TableHead>
          <TableRow>
            <TableHeaderCell scope="col">{t('qualityMatrix.sinkCase')}</TableHeaderCell>
            <TableHeaderCell scope="col">{t('qualityMatrix.sinkHuman')}</TableHeaderCell>
            <TableHeaderCell scope="col">{t('qualityMatrix.sinkJudge')}</TableHeaderCell>
            <TableHeaderCell scope="col">{t('qualityMatrix.sinkLabeller')}</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {batch.labels.map((l) => (
            <TableRow key={`${l.run}/${l.case}/${l.repeat}/${l.labeller}`}>
              <TableCell>
                {l.case} <span className="meta">({l.run})</span>
              </TableCell>
              <TableCell>{verdict(l.humanLabel)}</TableCell>
              <TableCell>{verdict(l.judgeLabel)}</TableCell>
              <TableCell>{l.labeller}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="actions-row">
        <Button data-size="sm" onClick={() => onDecide('accept')}>
          {t('qualityMatrix.sinkAccept')}
        </Button>
        <Button data-size="sm" variant="secondary" onClick={() => onDecide('reject')}>
          {t('qualityMatrix.sinkReject')}
        </Button>
      </div>
    </section>
  );
};

/**
 * Labels people made in agencies' Langfuse projects: fetched per connection, and counted in a
 * judge's agreement only once an operator accepts the batch with a reason (ADR 0040).
 */
export const SinkLabels = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const [state, retry] = useAsync((signal) => api.sinkLabels(signal), [api]);
  const flash = useFlash();
  const [deciding, setDeciding] = useState<
    { batch: SinkLabelBatch; decision: 'accept' | 'reject' } | undefined
  >();
  const fetchFrom = async (tenant: string, connection: string) => {
    try {
      const { pending } = await api.fetchSinkLabels(tenant, connection);
      flash.show(t('qualityMatrix.sinkFetched', { count: pending, connection }));
      retry();
    } catch {
      flash.show(t('qualityMatrix.sinkFetchFailed', { connection }), 'danger');
    }
  };
  if (state.status === 'loading') return <Loading label={t('qualityMatrix.sinkLoading')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const { connections, batches } = state.data;
  return (
    <div className="stack">
      <Paragraph>{t('qualityMatrix.sinkIntro')}</Paragraph>
      <Flash message={flash.message} />
      {connections.length > 0 ? (
        <ul className="stack-xs">
          {connections.map((c) => (
            <li key={`${c.tenant}/${c.connection}`} className="row-gap">
              <span>
                {c.tenant} / {c.connection}
              </span>
              {c.labels ? (
                <Button
                  data-size="sm"
                  variant="secondary"
                  onClick={() => void fetchFrom(c.tenant, c.connection)}
                >
                  {t('qualityMatrix.sinkFetch')}
                </Button>
              ) : (
                <Tag data-size="sm" data-color="neutral">
                  {t('qualityMatrix.sinkSwitchOff')}
                </Tag>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {batches.length === 0 ? (
        <EmptyState title={t('qualityMatrix.sinkNoneTitle')}>
          <Paragraph>{t('qualityMatrix.sinkNoneText')}</Paragraph>
        </EmptyState>
      ) : (
        batches.map((b) => (
          <Batch
            key={`${b.tenant}/${b.connection}/${b.judge}`}
            batch={b}
            onDecide={(decision) => setDeciding({ batch: b, decision })}
          />
        ))
      )}
      <ReasonDialog
        open={deciding !== undefined}
        title={t(
          deciding?.decision === 'reject'
            ? 'qualityMatrix.sinkRejectTitle'
            : 'qualityMatrix.sinkAcceptTitle',
          { name: deciding?.batch.name ?? '' },
        )}
        text={t(
          deciding?.decision === 'reject'
            ? 'qualityMatrix.sinkRejectText'
            : 'qualityMatrix.sinkAcceptText',
        )}
        confirmLabel={t(
          deciding?.decision === 'reject'
            ? 'qualityMatrix.sinkRejectConfirm'
            : 'qualityMatrix.sinkAcceptConfirm',
        )}
        onClose={() => setDeciding(undefined)}
        onConfirm={async (reason) => {
          if (!deciding) return;
          const done = await api.decideSinkLabels(deciding.batch, deciding.decision, reason);
          flash.show(
            done.accepted !== undefined
              ? t('qualityMatrix.sinkAccepted', { count: done.accepted })
              : t('qualityMatrix.sinkRejected', { count: done.rejected ?? 0 }),
          );
          retry();
        }}
      />
    </div>
  );
};
