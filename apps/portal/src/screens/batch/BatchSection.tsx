import { Alert, Button, Heading, Paragraph, Table, Tag } from '@digdir/designsystemet-react';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api';
import {
  isActiveBatch,
  type BatchRun,
  type BatchRunDetail,
  type BatchSourceDataset,
} from '../../api/batch-runs';
import { useFormat } from '@genai/i18n/react';
import { useT, type T } from '../../i18n';
import { navigate, useAsync } from '../../hooks';
import { needsRight, useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import { servicePath } from '../service/sections';
import { BatchJob } from './BatchJob';
import { clock, sameDay, shortDay, shortWhen } from '../service/dev-format';
import { jobStatus, kroner, selectionName, startedByLabel, type Color } from './shared';
import { BatchDialog } from './BatchDialog';
import { problemTitle } from '../quality/shared';
import './batch.css';

const pollMs = 2000;

export type Flash = { text: string; color: 'success' | 'info' | 'danger' | 'warning' };

const progressOf = (r: BatchRun) => {
  const failed = r.counts.failed;
  const done = r.counts.succeeded + r.counts.notFound + r.counts.skipped;
  return { done, failed, share: r.total ? Math.round((done / r.total) * 100) : 0 };
};

const statusOf = (t: T, r: BatchRun): [string, Color] => {
  if (isActiveBatch(r)) return [t('serviceDev.jobRunning'), 'info'];
  if (r.status === 'succeeded')
    return r.counts.failed > 0
      ? [t('serviceDev.jobPartly'), 'danger']
      : [t('serviceDev.jobDone'), 'success'];
  const [key, color] = jobStatus(r);
  return [t(key), color];
};

const RunList = ({
  runs,
  sources,
  current,
  onOpen,
  onDownload,
  now,
}: {
  runs: BatchRun[];
  sources: BatchSourceDataset[];
  current: string | undefined;
  onOpen: (id: string) => void;
  onDownload: (id: string) => void;
  now: Date;
}) => {
  const t = useT();
  const f = useFormat();
  const when = (iso: string) =>
    sameDay(iso, now) ? t('serviceDev.todayAt', { time: clock(iso, f) }) : shortWhen(iso, f);
  return (
    <div tabIndex={0} role="region" aria-label={t('serviceDev.batchJobs')} className="table-scroll">
      <Table className="batch-jobs" data-size="sm">
        <Table.Head>
          <Table.Row>
            <Table.HeaderCell scope="col">{t('serviceDev.colJob')}</Table.HeaderCell>
            <Table.HeaderCell scope="col">{t('serviceDev.colProgress')}</Table.HeaderCell>
            <Table.HeaderCell scope="col">{t('serviceDev.colStatus')}</Table.HeaderCell>
            <Table.HeaderCell scope="col">{t('serviceDev.colCost')}</Table.HeaderCell>
            <Table.HeaderCell scope="col">
              <span className="visually-hidden">{t('serviceDev.colActions')}</span>
            </Table.HeaderCell>
          </Table.Row>
        </Table.Head>
        <Table.Body>
          {runs.map((r) => {
            const [text, color] = statusOf(t, r);
            const name = r.name ?? selectionName(t, r, sources);
            const active = isActiveBatch(r);
            const progress = progressOf(r);
            const meta = active
              ? r.startedByName || r.startedBy
                ? t('serviceDev.jobStarted', {
                    when: when(r.startedAt),
                    who: startedByLabel(t, r.startedBy, r.startedByName),
                    version: r.version,
                  })
                : t('serviceDev.jobStartedAt', { when: when(r.startedAt), version: r.version })
              : t('serviceDev.jobEnded', { when: shortDay(r.startedAt, f), version: r.version });
            const action =
              active || (r.status !== 'succeeded' && r.counts.failed === 0)
                ? 'serviceDev.jobOpen'
                : r.counts.failed > 0
                  ? 'serviceDev.jobRetry'
                  : 'serviceDev.jobDownload';
            const href = `#${servicePath(r.service, 'batch', `/${encodeURIComponent(r.id)}`)}`;
            return (
              <Table.Row key={r.id}>
                <Table.Cell className="batch-job-name">
                  <strong>{name}</strong>
                  <span className="meta">{meta}</span>
                </Table.Cell>
                <Table.Cell>
                  <span className="batch-list-progress">
                    <span className="nowrap">
                      {progress.failed
                        ? t('serviceDev.progressFailed', {
                            done: f.number(progress.done),
                            total: f.number(r.total),
                            failed: f.number(progress.failed),
                          })
                        : t('serviceDev.progress', {
                            done: f.number(progress.done),
                            total: f.number(r.total),
                          })}
                    </span>
                    <span className="batch-list-bar" aria-hidden="true">
                      <span style={{ width: `${progress.share}%` }} />
                    </span>
                  </span>
                </Table.Cell>
                <Table.Cell>
                  <Tag data-size="sm" data-color={color}>
                    {text}
                  </Tag>
                </Table.Cell>
                <Table.Cell className="nowrap">
                  {r.tokens === undefined && r.costMicroNok === undefined
                    ? ''
                    : active
                      ? t('serviceDev.costSoFar', { cost: kroner(t, f, r.costMicroNok) })
                      : kroner(t, f, r.costMicroNok)}
                </Table.Cell>
                <Table.Cell className="nowrap">
                  <a
                    href={href}
                    aria-current={r.id === current || undefined}
                    aria-label={t('serviceDev.jobActionLabel', { action: t(action), name })}
                    onClick={(e) => {
                      e.preventDefault();
                      if (action === 'serviceDev.jobDownload') onDownload(r.id);
                      else onOpen(r.id);
                    }}
                  >
                    {t(action)}
                  </a>
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>
    </div>
  );
};

export const BatchSection = ({
  api,
  tenant,
  id,
  runId,
  now = () => new Date(),
}: {
  api: ApiClient;
  tenant: string;
  id: string;
  runId: string | undefined;
  now?: () => Date;
}) => {
  const t = useT();
  const canManage = useRights().has('manage-services');
  const [round, setRound] = useState(0);
  const [flash, setFlash] = useState<Flash>();
  const [wizard, setWizard] = useState(false);
  const [sources] = useAsync(
    (signal) => api.batchRuns.sources(tenant, id, signal),
    [api, tenant, id],
  );
  const [runs, retryRuns] = useAsync(
    (signal) => api.batchRuns.list(tenant, id, signal),
    [api, tenant, id, round],
    { keepPreviousFor: `${tenant}/${id}` },
  );
  const [detail] = useAsync(
    async (signal): Promise<BatchRunDetail | undefined> =>
      runId ? api.batchRuns.run(tenant, id, runId, signal) : undefined,
    [api, tenant, id, runId, round],
    { keepPreviousFor: `${tenant}/${id}/${runId}` },
  );
  const seenRuns = useRef<BatchRun[]>(undefined);
  if (runs.status === 'ready') seenRuns.current = runs.data;
  const seenDetail = useRef<BatchRunDetail>(undefined);
  if (detail.status === 'ready') seenDetail.current = detail.data;
  const selected = seenDetail.current?.id === runId ? seenDetail.current : undefined;
  const polling = (seenRuns.current ?? []).some(isActiveBatch);
  const known = sources.status === 'ready' ? sources.data : [];

  useEffect(() => {
    if (!polling) return;
    const timer = setTimeout(() => setRound((r) => r + 1), pollMs);
    return () => clearTimeout(timer);
  }, [polling, round]);

  const open = (run: string | undefined) => {
    setWizard(false);
    navigate(servicePath(id, 'batch', run ? `/${encodeURIComponent(run)}` : ''));
  };
  const showList = !runId;

  const download = async (run: string) => {
    try {
      const blob = await api.batchRuns.download(tenant, id, run, 'csv');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `samlet-jobb-${id}-${run.slice(0, 8)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setFlash({ text: problemTitle(e, t), color: 'danger' });
    }
  };

  return (
    <div className="stack batch">
      <div className="batch-head">
        <div className="stack-xs">
          <Heading level={2} data-size="md">
            {t('serviceDev.batchTitle')}
          </Heading>
          <Paragraph className="meta dv-lead">{t('serviceDev.batchLead')}</Paragraph>
        </div>
        {showList && canManage ? (
          <Button
            onClick={() => {
              setFlash(undefined);
              setWizard(true);
            }}
          >
            {t('batch.newJob')}
          </Button>
        ) : null}
      </div>
      <div aria-live="polite">
        {flash ? (
          <Alert data-color={flash.color} data-size="sm">
            {flash.text}
          </Alert>
        ) : null}
      </div>
      {!canManage ? <Paragraph data-size="sm">{needsRight('manage-services')}</Paragraph> : null}
      {wizard && canManage ? (
        <BatchDialog
          api={api}
          tenant={tenant}
          id={id}
          onClose={() => setWizard(false)}
          onStarted={(run) => {
            setFlash({ text: t('batch.started'), color: 'info' });
            setRound((r) => r + 1);
            open(run);
          }}
        />
      ) : null}
      {runId ? (
        selected ? (
          <>
            <BatchJob
              api={api}
              tenant={tenant}
              serviceId={id}
              run={selected}
              sources={known}
              canManage={canManage}
              onChanged={() => setRound((r) => r + 1)}
              setFlash={(text, color = 'success') => setFlash({ text, color })}
            />
            <div>
              <Button variant="tertiary" data-size="sm" onClick={() => open(undefined)}>
                {t('batch.backToJobs')}
              </Button>
            </div>
          </>
        ) : detail.status === 'error' ? (
          <ErrorState error={detail.error} headingLevel={3} />
        ) : (
          <Loading label={t('batch.loadingJob')} shape="detail" headingLevel={3} />
        )
      ) : null}
      {showList ? (
        <div className="stack-sm">
          {runs.status === 'loading' && !seenRuns.current ? (
            <Loading
              label={t('batch.loadingJobs')}
              shape="table"
              columns={[
                t('serviceDev.colJob'),
                t('serviceDev.colProgress'),
                t('serviceDev.colStatus'),
                t('serviceDev.colCost'),
              ]}
              headingLevel={3}
              onRetry={retryRuns}
            />
          ) : runs.status === 'error' ? (
            <ErrorState error={runs.error} onRetry={retryRuns} headingLevel={3} />
          ) : (seenRuns.current ?? []).length === 0 ? (
            <div className="batch-empty stack-sm">
              <Heading level={3} data-size="2xs">
                {t('batch.emptyHeading')}
              </Heading>
              <Paragraph>{t('batch.emptyBody')}</Paragraph>
            </div>
          ) : (
            <RunList
              runs={seenRuns.current ?? []}
              sources={known}
              current={runId}
              onOpen={open}
              onDownload={(run) => void download(run)}
              now={now()}
            />
          )}
        </div>
      ) : null}
    </div>
  );
};
