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
import { useT } from '../../i18n';
import { navigate, useAsync } from '../../hooks';
import { needsRight, useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import { servicePath } from '../service/sections';
import { BatchJob } from './BatchJob';
import { jobStatus, kroner, selectionName, startedByLabel } from './shared';
import { BatchWizard } from './BatchWizard';
import './batch.css';

const pollMs = 2000;

export type Flash = { text: string; color: 'success' | 'info' | 'danger' | 'warning' };

const RunList = ({
  runs,
  sources,
  current,
  onOpen,
}: {
  runs: BatchRun[];
  sources: BatchSourceDataset[];
  current: string | undefined;
  onOpen: (id: string) => void;
}) => {
  const t = useT();
  const f = useFormat();
  return (
    <div tabIndex={0} role="region" aria-labelledby="batch-history-h" className="table-scroll">
      <Table className="batch-jobs">
        <Table.Head>
          <Table.Row>
            <Table.HeaderCell scope="col">{t('batch.colSelection')}</Table.HeaderCell>
            <Table.HeaderCell scope="col">{t('batch.colStartedBy')}</Table.HeaderCell>
            <Table.HeaderCell scope="col" className="numeric-cell">
              {t('batch.colDocuments')}
            </Table.HeaderCell>
            <Table.HeaderCell scope="col">{t('batch.colStatus')}</Table.HeaderCell>
            <Table.HeaderCell scope="col" className="numeric-cell">
              {t('batch.colCost')}
            </Table.HeaderCell>
          </Table.Row>
        </Table.Head>
        <Table.Body>
          {runs.map((r) => {
            const [text, color] = jobStatus(r);
            return (
              <Table.Row key={r.id}>
                <Table.HeaderCell scope="row" className="batch-job-name">
                  <a
                    href={`#${servicePath(r.service, 'batch', `/${encodeURIComponent(r.id)}`)}`}
                    aria-current={r.id === current || undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      onOpen(r.id);
                    }}
                  >
                    {selectionName(t, r, sources)}
                  </a>
                  <span className="meta">{f.dateTime(r.startedAt, 'medium')}</span>
                </Table.HeaderCell>
                <Table.Cell>{startedByLabel(t, r.startedBy, r.startedByName)}</Table.Cell>
                <Table.Cell className="numeric-cell">{f.number(r.total)}</Table.Cell>
                <Table.Cell>
                  <Tag data-size="sm" data-color={color}>
                    {t(text)}
                  </Tag>
                </Table.Cell>
                <Table.Cell className="numeric-cell">
                  {isActiveBatch(r)
                    ? t('batch.costSoFarCell', { cost: kroner(t, f, r.costMicroNok) })
                    : kroner(t, f, r.costMicroNok)}
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
}: {
  api: ApiClient;
  tenant: string;
  id: string;
  runId: string | undefined;
}) => {
  const t = useT();
  const canManage = useRights().has('manage-services');
  const [round, setRound] = useState(0);
  const [flash, setFlash] = useState<Flash>();
  const [wizard, setWizard] = useState(false);
  const [sources, retrySources] = useAsync(
    (signal) => api.batchRuns.sources(tenant, id, signal),
    [api, tenant, id],
  );
  const [runs, retryRuns] = useAsync(
    (signal) => api.batchRuns.list(tenant, id, signal),
    [api, tenant, id, round],
  );
  const [detail] = useAsync(
    async (signal): Promise<BatchRunDetail | undefined> =>
      runId ? api.batchRuns.run(tenant, id, runId, signal) : undefined,
    [api, tenant, id, runId, round],
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
  const showList = !wizard && !runId;

  return (
    <div className="stack batch">
      <div className="batch-head">
        <div className="stack-xs">
          <Heading level={2} data-size="sm">
            {t('batch.heading')}
          </Heading>
          <Paragraph className="meta">{t('batch.intro')}</Paragraph>
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
        sources.status === 'loading' ? (
          <Loading label={t('batch.loadingSources')} />
        ) : sources.status === 'error' ? (
          <ErrorState error={sources.error} onRetry={retrySources} headingLevel={3} />
        ) : (
          <BatchWizard
            api={api}
            tenant={tenant}
            serviceId={id}
            sources={sources.data}
            onCancel={() => setWizard(false)}
            onStarted={(run) => {
              setFlash({ text: t('batch.started'), color: 'info' });
              setRound((r) => r + 1);
              open(run);
            }}
          />
        )
      ) : null}
      {!wizard && runId ? (
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
          <Loading label={t('batch.loadingJob')} />
        )
      ) : null}
      {showList ? (
        <section aria-labelledby="batch-history-h" className="stack-sm">
          <Heading level={3} data-size="xs" id="batch-history-h">
            {t('batch.history')}
          </Heading>
          {runs.status === 'loading' && !seenRuns.current ? (
            <Loading label={t('batch.loadingJobs')} />
          ) : runs.status === 'error' ? (
            <ErrorState error={runs.error} onRetry={retryRuns} headingLevel={4} />
          ) : (seenRuns.current ?? []).length === 0 ? (
            <div className="batch-empty stack-sm">
              <Heading level={4} data-size="2xs">
                {t('batch.emptyHeading')}
              </Heading>
              <Paragraph>{t('batch.emptyBody')}</Paragraph>
              {canManage ? (
                <div>
                  <Button data-size="sm" onClick={() => setWizard(true)}>
                    {t('batch.newJob')}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <RunList runs={seenRuns.current ?? []} sources={known} current={runId} onOpen={open} />
          )}
        </section>
      ) : null}
    </div>
  );
};
