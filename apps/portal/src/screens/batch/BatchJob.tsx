import {
  Alert,
  Button,
  Chip,
  Details,
  Dialog,
  Fieldset,
  Heading,
  Paragraph,
  Table,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useRef, useState } from 'react';
import type { ApiClient } from '../../api';
import {
  isActiveBatch,
  type BatchItem,
  type BatchRun,
  type BatchRunDetail,
  type BatchSourceDataset,
} from '../../api/batch-runs';
import { useT, type Format, type T } from '../../i18n';
import { useNarrow } from '../../hooks';
import { problemTitle } from '../quality/shared';
import {
  fieldLabel,
  itemStatus,
  kroner,
  reasonError,
  selectionName,
  failureText,
  startedByLabel,
} from './shared';

const filterText = (t: T, run: Pick<BatchRun, 'filters'>) =>
  Object.entries(run.filters)
    .map(([field, values]) => `${fieldLabel(t, field)}: ${values.join(', ')}`)
    .join(' · ') || t('batch.noFilters');

const estimateText = (t: T, f: Format, run: BatchRun) => {
  const per = run.perItem?.costMicroNok;
  if (!per) return '';
  const low = kroner(t, f, per.low * run.total);
  const high = kroner(t, f, per.high * run.total);
  return low === high ? low : `${low}–${high}`;
};

const filters = ['all', 'succeeded', 'notFound', 'failed', 'running', 'queued', 'skipped'] as const;
type Filter = (typeof filters)[number];
const pageSize = 12;

const failGroups = (t: T, items: BatchItem[]) => {
  const groups = new Map<string, number[]>();
  for (const i of items)
    if (i.status === 'failed') {
      const key = failureText(t, i.errorCode, i.error);
      groups.set(key, [...(groups.get(key) ?? []), i.index]);
    }
  return [...groups].map(([error, indexes]) => ({ error, indexes }));
};

const ItemStatusCell = ({ item }: { item: BatchItem }) => {
  const t = useT();
  const [text, tone] = itemStatus[item.status];
  return (
    <span className="batch-item-status">
      <span className="tag-row">
        <Tag data-size="sm" data-color={tone}>
          {t(text)}
        </Tag>
        {item.truncated ? (
          <Tag data-size="sm" data-color="warning">
            {t('batch.truncated')}
          </Tag>
        ) : null}
      </span>
      {item.error ? <span className="small">{item.error}</span> : null}
    </span>
  );
};

const runLink = (t: T, item: BatchItem) =>
  item.task ? (
    <a
      href={`#/log/${encodeURIComponent(item.task)}`}
      aria-label={t('batch.seeRunFor', { title: item.document.title })}
    >
      {t('batch.seeRun')}
    </a>
  ) : null;

export const BatchJob = ({
  api,
  tenant,
  serviceId,
  run,
  sources,
  canManage,
  onChanged,
  setFlash,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  run: BatchRunDetail;
  sources: BatchSourceDataset[];
  canManage: boolean;
  onChanged: () => void;
  setFlash: (text: string, color?: 'success' | 'info' | 'danger' | 'warning') => void;
}) => {
  const t = useT();
  const f = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const narrow = useNarrow();
  const [filter, setFilter] = useState<Filter>('all');
  const [shown, setShown] = useState(pageSize);
  const [busy, setBusy] = useState(false);
  const [raising, setRaising] = useState(false);
  const [limit, setLimit] = useState('');
  const [limitError, setLimitError] = useState('');
  const [why, setWhy] = useState('');
  const [whyError, setWhyError] = useState('');

  const { counts, total } = run;
  const finished = counts.succeeded + (counts.notFound ?? 0) + counts.failed;
  const active = isActiveBatch(run);
  const pct = total ? Math.round((finished / total) * 100) : 0;
  const live = active ? Math.floor((finished / Math.max(total, 1)) * 10) * 10 : pct;
  const list = run.items.filter((i) => filter === 'all' || i.status === filter);
  const visible = list.slice(0, shown);
  const groups = failGroups(t, run.items);
  const failed = groups.flatMap((g) => g.indexes);
  const costShown = run.tokens !== undefined;
  const perItem = run.perItem?.costMicroNok;
  const estimate = estimateText(t, f, run);
  const capNok = run.cap?.costMicroNok;
  const left = counts.skipped + counts.queued;

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setFlash(problemTitle(e, tRef.current), 'danger');
    } finally {
      setBusy(false);
    }
  };

  const cancel = () =>
    act(async () => {
      await api.batchRuns.cancel(tenant, serviceId, run.id, 'Avbrøt samlet jobb');
      setFlash(tRef.current('batch.cancelFlash'), 'info');
      onChanged();
    });

  const retryFailed = () =>
    act(async () => {
      const cap = perItem
        ? { maxCostNok: Math.max(1, Math.ceil((perItem.high * failed.length) / 1_000_000)) }
        : {
            maxTokens:
              ((run.perItem?.inputTokens.high ?? 0) + (run.perItem?.outputTokens.high ?? 0)) *
              failed.length,
          };
      const result = await api.batchRuns.retry(
        tenant,
        serviceId,
        run.id,
        { ...cap, items: failed },
        `Kjørte ${failed.length} feilede dokumenter på nytt`,
      );
      setFlash(tRef.current('batch.retryFlash', { count: result.retried }), 'info');
      onChanged();
    });

  const openRaise = () => {
    const spent = (run.costMicroNok ?? 0) / 1_000_000;
    const more = perItem ? (perItem.high * left) / 1_000_000 : 0;
    setLimit(String(Math.ceil(spent + more)));
    setLimitError('');
    setWhy('');
    setWhyError('');
    setRaising(true);
  };

  const saveLimit = () => {
    const value = Number(limit.replace(',', '.'));
    const spent = (run.costMicroNok ?? 0) / 1_000_000;
    const valueError =
      !Number.isFinite(value) || value <= spent
        ? t('batch.limitTooLow', { spent: kroner(t, f, run.costMicroNok) })
        : '';
    const reason = reasonError(t, why);
    setLimitError(valueError);
    setWhyError(reason);
    if (valueError || reason) return;
    void act(async () => {
      await api.batchRuns.retry(
        tenant,
        serviceId,
        run.id,
        { maxCostNok: value - spent },
        why.trim(),
      );
      setRaising(false);
      setFlash(
        tRef.current('batch.limitSaved', { limit: kroner(tRef.current, f, value * 1_000_000) }),
        'success',
      );
      onChanged();
    });
  };

  const download = async (format: 'csv' | 'json') => {
    try {
      const blob = await api.batchRuns.download(tenant, serviceId, run.id, format);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `samlet-jobb-${serviceId}-${run.id.slice(0, 8)}.${format}`;
      a.click();
    } catch (e) {
      setFlash(problemTitle(e, tRef.current), 'danger');
    }
  };

  const cost = kroner(t, f, run.costMicroNok);
  const costText = active
    ? `${t('batch.costActive', { cost })}${estimate ? t('batch.costActiveEstimate', { estimate }) : ''}${capNok ? t('batch.costActiveCap', { cap: kroner(t, f, capNok) }) : ''}`
    : `${t('batch.costDone', { cost })}${estimate ? t('batch.costDoneEstimate', { estimate }) : ''}${capNok ? t('batch.costDoneCap', { cap: kroner(t, f, capNok) }) : ''}`;

  const doneAlert =
    run.status === 'succeeded'
      ? counts.failed > 0
        ? {
            color: 'warning' as const,
            text: t(
              !costShown
                ? 'batch.doneWithErrorsNoCost'
                : estimate
                  ? 'batch.doneWithErrorsEstimate'
                  : 'batch.doneWithErrors',
              {
                done: counts.succeeded,
                total,
                failed: counts.failed,
                cost,
                estimate,
              },
            ),
          }
        : {
            color: 'success' as const,
            text: t(
              !costShown
                ? 'batch.doneAllNoCost'
                : estimate
                  ? 'batch.doneAllEstimate'
                  : 'batch.doneAll',
              {
                total,
                cost,
                estimate,
              },
            ),
          }
      : undefined;

  return (
    <section aria-labelledby="batch-run-h" className="stack batch-job">
      <div className="batch-run-head">
        <Heading level={3} data-size="sm" id="batch-run-h">
          {selectionName(t, run, sources)}
        </Heading>
        <span className="meta">
          {t(run.model ? 'batch.jobStartedByModel' : 'batch.jobStartedBy', {
            by: startedByLabel(t, run.startedBy, run.startedByName),
            when: f.dateTime(run.startedAt, 'medium'),
            documents: t('batch.documents', { count: total }),
            version: run.version,
            model: run.model ?? '',
          })}
        </span>
      </div>
      {run.status === 'stopped' ? (
        <Alert data-color="warning">
          <Heading level={4} data-size="2xs">
            {t('batch.pausedHeading')}
          </Heading>
          <Paragraph>
            {t(
              !costShown
                ? 'batch.pausedBodyNoCost'
                : capNok
                  ? 'batch.pausedBodyCap'
                  : 'batch.pausedBody',
              {
                spent: cost,
                cap: kroner(t, f, capNok),
                done: finished,
                total,
              },
            )}
          </Paragraph>
          {canManage && costShown ? (
            <div className="actions">
              <Button data-size="sm" onClick={openRaise}>
                {t('batch.continueNewLimit')}
              </Button>
              <Button
                variant="secondary"
                data-size="sm"
                onClick={() => setFlash(t('batch.endedFlash', { count: counts.succeeded }))}
              >
                {t('batch.endKeep')}
              </Button>
            </div>
          ) : null}
        </Alert>
      ) : null}
      {run.status === 'cancelled' ? (
        <Alert data-color="info">
          {t(
            !costShown
              ? 'batch.cancelledNoCost'
              : run.endedAt
                ? 'batch.cancelledAt'
                : 'batch.cancelledNoTime',
            {
              when: run.endedAt ? f.dateTime(run.endedAt, 'medium') : '',
              done: counts.succeeded,
              total,
              cost,
            },
          )}
        </Alert>
      ) : null}
      {run.status === 'failed' ? (
        <Alert data-color="danger">
          {failureText(t, run.errorCode, run.error ?? t('batch.stoppedWithError'))}
        </Alert>
      ) : null}
      {doneAlert ? <Alert data-color={doneAlert.color}>{doneAlert.text}</Alert> : null}
      {run.costApproval ? (
        <Paragraph data-size="sm" className="meta">
          {t('batch.approvedOver', {
            limit: run.costApproval.limitNok,
            by: startedByLabel(t, run.costApproval.by),
            reason: run.costApproval.reason,
          })}
        </Paragraph>
      ) : null}

      <div className="batch-box stack-sm">
        <div className="batch-progress-head">
          <span className="log-strong" id="batch-progress-l">
            {t('batch.progress')}
          </span>
          <span className="numeric">
            <span aria-live="polite">{t('batch.percentDone', { pct: live })}</span>{' '}
            {t('batch.progressOf', { done: finished, total })}
          </span>
        </div>
        <div
          role="progressbar"
          aria-labelledby="batch-progress-l"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={finished}
          aria-valuetext={t('batch.progressValueText', { pct, done: finished, total })}
          className="batch-progress"
        >
          <div style={{ width: `${pct}%` }} />
        </div>
        <div className="tag-row">
          <Tag data-size="sm" data-color="success">
            {t('batch.tagSucceeded', { count: counts.succeeded })}
          </Tag>
          {counts.notFound ? (
            <Tag data-size="sm" data-color="warning">
              {t('batch.tagNotFound', { count: counts.notFound })}
            </Tag>
          ) : null}
          <Tag data-size="sm" data-color="danger">
            {t('batch.tagFailed', { count: counts.failed })}
          </Tag>
          <Tag data-size="sm" data-color="info">
            {t('batch.tagRunning', { count: counts.running })}
          </Tag>
          <Tag data-size="sm" data-color="neutral">
            {t('batch.tagQueued', { count: active ? counts.queued : left })}
          </Tag>
        </div>
        {costShown ? <span>{costText}</span> : null}
        {active && canManage ? (
          <div className="actions">
            <span className="small">{t('batch.leavePage')}</span>
            <Button
              variant="secondary"
              data-color="danger"
              data-size="sm"
              aria-disabled={busy || undefined}
              onClick={() => !busy && void cancel()}
            >
              {t('batch.cancelJob')}
            </Button>
          </div>
        ) : null}
      </div>

      {!active && groups.length > 0 ? (
        <section aria-labelledby="batch-failed-h" className="batch-box batch-failed stack-sm">
          <Heading level={4} data-size="2xs" id="batch-failed-h">
            {t('batch.failedHeading', { count: failed.length })}
          </Heading>
          <ul className="plain-list batch-fail-groups">
            {groups.map((g) => (
              <li key={g.error}>
                <span>{t('batch.failGroup', { count: g.indexes.length, error: g.error })}</span>
                <Tag data-size="sm" data-color="warning">
                  {t('batch.canRetry')}
                </Tag>
              </li>
            ))}
          </ul>
          {canManage && costShown ? (
            <div className="actions">
              <Button
                data-size="sm"
                aria-disabled={busy || undefined}
                onClick={() => !busy && void retryFailed()}
              >
                {t('batch.retryFailed', { count: failed.length })}
              </Button>
              {perItem ? (
                <span className="small">
                  {t('batch.estimatedRange', {
                    low: kroner(t, f, perItem.low * failed.length),
                    high: kroner(t, f, perItem.high * failed.length),
                  })}
                </span>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {!active && counts.succeeded + (counts.notFound ?? 0) > 0 ? (
        <section aria-labelledby="batch-results-h" className="batch-box stack-sm">
          <div className="tag-row">
            <Heading level={4} data-size="2xs" id="batch-results-h">
              {t('batch.results')}
            </Heading>
            <Tag data-size="sm" data-color="warning">
              {t('batch.aiDraft')}
            </Tag>
          </div>
          <Paragraph data-size="sm">{t('batch.resultsNote')}</Paragraph>
          <div className="actions">
            <Button variant="secondary" data-size="sm" onClick={() => void download('csv')}>
              {t('batch.downloadCsv')}
            </Button>
            <Button variant="secondary" data-size="sm" onClick={() => void download('json')}>
              {t('batch.downloadJson')}
            </Button>
          </div>
          <Details>
            <Details.Summary>{t('batch.downloadWhat')}</Details.Summary>
            <Details.Content>
              <div className="stack-sm">
                <Paragraph data-size="sm">{t('batch.downloadWhatBody')}</Paragraph>
                <Paragraph data-size="sm">
                  {t('batch.downloadFilters', { filters: filterText(t, run) })}
                </Paragraph>
                <Paragraph data-size="sm" className="tag-row">
                  {t('batch.retention')}{' '}
                  <Tag data-color="warning" data-size="sm">
                    {t('batch.undecided')}
                  </Tag>
                </Paragraph>
              </div>
            </Details.Content>
          </Details>
        </section>
      ) : null}

      <section aria-labelledby="batch-items-h" className="stack-sm">
        <div className="batch-items-head">
          <Heading level={4} data-size="xs" id="batch-items-h">
            {t('batch.itemsHeading')}
          </Heading>
          <Fieldset>
            <Fieldset.Legend>{t('batch.show')}</Fieldset.Legend>
            <div className="tag-row">
              {filters.map((fl) => {
                const count = fl === 'all' ? run.items.length : (counts[fl] ?? 0);
                if (fl !== 'all' && count === 0) return null;
                return (
                  <Chip.Radio
                    key={fl}
                    name="batch-item-filter"
                    checked={filter === fl}
                    onChange={() => {
                      setFilter(fl);
                      setShown(pageSize);
                    }}
                  >
                    {fl === 'all' ? t('batch.all') : t(itemStatus[fl][0])} ({f.number(count)})
                  </Chip.Radio>
                );
              })}
            </div>
          </Fieldset>
        </div>
        {visible.length === 0 ? (
          <p className="meta">{t('batch.noneStatus')}</p>
        ) : narrow ? (
          <ul className="plain-list batch-item-cards">
            {visible.map((i) => (
              <li key={i.index}>
                <dl>
                  <dt>{t('batch.colDocument')}</dt>
                  <dd>{i.document.title}</dd>
                  <dt>{t('batch.colStatus')}</dt>
                  <dd>
                    <ItemStatusCell item={i} />
                  </dd>
                  {costShown ? (
                    <>
                      <dt>{t('batch.colCost')}</dt>
                      <dd>
                        {i.status === 'succeeded' || i.status === 'notFound'
                          ? kroner(t, f, run.priced ? i.costMicroNok : null)
                          : '–'}
                      </dd>
                    </>
                  ) : null}
                </dl>
                {runLink(t, i)}
              </li>
            ))}
          </ul>
        ) : (
          <div tabIndex={0} role="region" aria-labelledby="batch-items-h" className="table-scroll">
            <Table data-size="sm" className="batch-items">
              <Table.Head>
                <Table.Row>
                  <Table.HeaderCell scope="col">{t('batch.colDocument')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('batch.colStatus')}</Table.HeaderCell>
                  {costShown ? (
                    <>
                      <Table.HeaderCell scope="col" className="numeric-cell">
                        {t('batch.colTokens')}
                      </Table.HeaderCell>
                      <Table.HeaderCell scope="col" className="numeric-cell">
                        {t('batch.colCost')}
                      </Table.HeaderCell>
                    </>
                  ) : null}
                  <Table.HeaderCell scope="col">
                    <span className="visually-hidden">{t('batch.colRun')}</span>
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {visible.map((i) => {
                  const tokens = (i.tokens?.input ?? 0) + (i.tokens?.output ?? 0);
                  return (
                    <Table.Row key={i.index}>
                      <Table.Cell>{i.document.title}</Table.Cell>
                      <Table.Cell>
                        <ItemStatusCell item={i} />
                      </Table.Cell>
                      {costShown ? (
                        <>
                          <Table.Cell className="numeric-cell">
                            {tokens ? f.number(tokens) : '–'}
                          </Table.Cell>
                          <Table.Cell className="numeric-cell">
                            {i.status === 'succeeded' || i.status === 'notFound'
                              ? kroner(t, f, run.priced ? i.costMicroNok : null)
                              : '–'}
                          </Table.Cell>
                        </>
                      ) : null}
                      <Table.Cell>{runLink(t, i)}</Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </div>
        )}
        <div className="actions">
          <span className="meta">
            {t('batch.shown', { shown: visible.length, total: list.length })}
          </span>
          {visible.length < list.length ? (
            <Button
              variant="secondary"
              data-size="sm"
              onClick={() => setShown((n) => n + pageSize)}
            >
              {t('batch.showMore', { count: pageSize })}
            </Button>
          ) : null}
        </div>
      </section>

      <Dialog
        open={raising}
        onClose={() => setRaising(false)}
        closeButton={t('batch.close')}
        aria-labelledby="batch-limit-h"
      >
        <div className="stack-sm">
          <Heading level={2} data-size="xs" id="batch-limit-h">
            {t('batch.limitHeading')}
          </Heading>
          <Paragraph>
            {t('batch.remaining', { count: left })}
            {perItem
              ? t('batch.remainingEstimate', {
                  low: kroner(t, f, perItem.low * left),
                  high: kroner(t, f, perItem.high * left),
                })
              : ''}
          </Paragraph>
          <Textfield
            className="batch-cap"
            label={t('batch.newLimit')}
            description={t('batch.newLimitHint')}
            inputMode="decimal"
            value={limit}
            error={limitError || undefined}
            onChange={(e) => {
              setLimit(e.target.value);
              setLimitError('');
            }}
          />
          <Textfield
            multiline
            rows={2}
            label={t('batch.reason')}
            description={t('batch.reasonHint')}
            value={why}
            error={whyError || undefined}
            onChange={(e) => {
              setWhy(e.target.value);
              setWhyError('');
            }}
          />
          <div className="actions">
            <Button aria-disabled={busy || undefined} onClick={() => !busy && saveLimit()}>
              {t('batch.continueJob')}
            </Button>
            <Button variant="secondary" onClick={() => setRaising(false)}>
              {t('batch.cancel')}
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
};
