import { CheckmarkIcon } from '@navikt/aksel-icons';
import { Heading } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import type { ApiClient, AuditRow } from '../api';
import type { DatasetView } from '../api/datasets';
import { Icon } from '../components/Icon';
import { useT, type PlainKey, type T } from '../i18n';
import { needsRight, useRights } from '../Shell';
import type { Overview, PortalRight, TaskRow } from '../types';
import { areaOf, serviceOfTarget } from './changes/changes';

export interface StartFacts {
  datasets: DatasetView[];
  services: Overview['services'];
  trialTokens: number;
}

export const ownDataset = (tenant: string) => (d: DatasetView) =>
  d.editable ?? d.fullId.startsWith(`${tenant}/`);

export const startProgress = (tenant: string, facts: StartFacts) => {
  const services = facts.services;
  return {
    dataset: facts.datasets.some(ownDataset(tenant)),
    service: services.length > 0,
    tried: facts.trialTokens > 0 || services.some((s) => (s.runsThisWeek ?? 0) > 0),
    published: services.some((s) => s.latestVersion !== null),
  };
};

export type Progress = ReturnType<typeof startProgress>;

export interface StepDone {
  at?: string;
  by?: string;
  service?: string;
  trialRuns?: number;
}

export type StepHistory = Partial<Record<keyof Progress, StepDone>>;

/** When and by whom each step was first done, from the audit log (oldest first). */
export const stepHistory = (audit: readonly AuditRow[]): StepHistory => {
  const history: StepHistory = {};
  const note = (step: keyof Progress, row: AuditRow, service?: string) => {
    history[step] ??= {
      at: row.at,
      ...(row.actorName ? { by: row.actorName } : {}),
      ...(service ? { service } : {}),
    };
  };
  for (const row of audit) {
    if (row.outcome !== 'applied') continue;
    const service = serviceOfTarget(row.target);
    if (areaOf(row.action) === 'datasets') note('dataset', row);
    if (row.action.startsWith('platform.service.') && service) note('service', row, service);
    if (row.action === 'platform.service.publish' && service) note('published', row, service);
  }
  return history;
};

const auditSteps = ['dataset', 'service', 'published'] as const;

/** Pages the audit log from its oldest end until every audited step is found. */
export const fetchStepHistory = async (
  api: Pick<ApiClient, 'auditPage'>,
  tenant: string,
  signal?: AbortSignal,
  pageSize = 200,
): Promise<StepHistory> => {
  let end = (await api.auditPage(tenant, { limit: 1, offset: 0 }, signal)).total;
  const oldestFirst: AuditRow[] = [];
  let history: StepHistory = {};
  while (end > 0) {
    const offset = Math.max(0, end - pageSize);
    const page = await api.auditPage(tenant, { limit: end - offset, offset }, signal);
    oldestFirst.push(...[...page.data].reverse());
    history = stepHistory(oldestFirst);
    if (auditSteps.every((step) => history[step])) break;
    end = offset;
  }
  return history;
};

/** The try step from the playground runs: how many, and the first one when the page reaches it. */
export const trialHistory = (runs: { data: TaskRow[]; total: number }): StepDone | undefined => {
  if (runs.total === 0) return undefined;
  const first = runs.data.length >= runs.total ? runs.data.at(-1) : undefined;
  const by = first?.actor?.kind === 'person' ? first.actor.name : undefined;
  return {
    trialRuns: runs.total,
    ...(first ? { at: first.createdAt } : {}),
    ...(by ? { by } : {}),
  };
};

const doneLine = (
  t: T,
  when: string | undefined,
  done: StepDone,
  step: keyof Progress,
  serviceName: (id: string) => string,
) => {
  const what =
    done.trialRuns !== undefined
      ? t('getStarted.trialRuns', { count: done.trialRuns })
      : done.service
        ? step === 'published'
          ? t('getStarted.publishedWhat', { service: serviceName(done.service) })
          : serviceName(done.service)
        : undefined;
  if (!when) return what ? t('getStarted.doneWhat', { what }) : undefined;
  if (done.by && what) return t('getStarted.doneAtByWhat', { when, by: done.by, what });
  if (done.by) return t('getStarted.doneAtBy', { when, by: done.by });
  if (what) return t('getStarted.doneAtWhat', { when, what });
  return t('getStarted.doneAt', { when });
};

interface StepDef {
  id: keyof Progress;
  title: PlainKey;
  body: PlainKey;
  action: PlainKey;
  href: string;
  doneAction: PlainKey;
  doneHref: string;
  right?: PortalRight;
}

const steps: readonly StepDef[] = [
  {
    id: 'dataset',
    title: 'getStarted.datasetTitle',
    body: 'getStarted.datasetBody',
    action: 'getStarted.datasetAction',
    href: '#/datasets/new',
    doneAction: 'getStarted.datasetDone',
    doneHref: '#/datasets',
    right: 'manage-datasets',
  },
  {
    id: 'service',
    title: 'getStarted.serviceTitle',
    body: 'getStarted.serviceBody',
    action: 'getStarted.serviceAction',
    href: '#/services/new',
    doneAction: 'getStarted.serviceDone',
    doneHref: '#/services',
    right: 'manage-services',
  },
  {
    id: 'tried',
    title: 'getStarted.tryTitle',
    body: 'getStarted.tryBody',
    action: 'getStarted.tryAction',
    href: '#/playground',
    doneAction: 'getStarted.tryAction',
    doneHref: '#/playground',
  },
  {
    id: 'published',
    title: 'getStarted.publishTitle',
    body: 'getStarted.publishBody',
    action: 'getStarted.publishAction',
    href: '#/services',
    doneAction: 'getStarted.publishDone',
    doneHref: '#/access',
    right: 'manage-services',
  },
];

export const doneCount = (progress: Progress) => steps.filter((s) => progress[s.id]).length;

export const allDone = (progress: Progress) => doneCount(progress) === steps.length;

export const StartSteps = ({
  progress,
  headingLevel,
  long = false,
  history = {},
  serviceName = (id) => id,
}: {
  progress: Progress | undefined;
  headingLevel: 2 | 3;
  long?: boolean;
  history?: StepHistory;
  serviceName?: (id: string) => string;
}) => {
  const t = useT();
  const f = useFormat();
  const rights = useRights();
  const next = progress ? steps.findIndex((s) => !progress[s.id]) : -1;
  return (
    <ol className="plain-list start-steps">
      {steps.map((s, i) => {
        const done = progress?.[s.id] ?? false;
        const allowed = !s.right || rights.has(s.right);
        const record = done ? history[s.id] : undefined;
        return (
          <li key={s.id} className={done ? 'start-step done' : 'start-step'}>
            <span aria-hidden="true" className={i === next ? 'start-mark next' : 'start-mark'}>
              {done ? <Icon icon={CheckmarkIcon} size={18} /> : i + 1}
            </span>
            <div className="start-step-text">
              <Heading level={headingLevel} data-size="2xs">
                {t('getStarted.stepTitle', { n: i + 1, title: t(s.title) })}{' '}
                <span className="visually-hidden">
                  {progress ? t(done ? 'getStarted.done' : 'getStarted.notDone') : ''}
                </span>
              </Heading>
              {long || !done ? <p className="meta-15">{t(s.body)}</p> : null}
              {record ? (
                <p className="meta">
                  {doneLine(
                    t,
                    record.at ? f.date(record.at, 'long') : undefined,
                    record,
                    s.id,
                    serviceName,
                  )}
                </p>
              ) : null}
            </div>
            {done ? (
              <a href={s.doneHref}>{t(s.doneAction)}</a>
            ) : allowed ? (
              <a
                href={s.href}
                className={i === next ? 'ds-button' : undefined}
                data-variant={i === next ? 'primary' : undefined}
                data-size={i === next ? 'sm' : undefined}
              >
                {t(s.action)}
              </a>
            ) : (
              <span className="meta">{needsRight(s.right ?? 'manage-services', t)}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
};
