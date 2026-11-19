import {
  Button,
  Chip,
  Heading,
  Link,
  Paragraph,
  Skeleton,
  Tag,
} from '@digdir/designsystemet-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { ApiClient } from '../../api';
import type { EvalRun, ServiceDraft, ServiceTestSet } from '../../api/quality';
import { usePortalFormat } from '../../format';
import { useAsync } from '../../hooks';
import type { PlainKey, T } from '../../i18n';
import type { FeedbackItem } from '../../types';
import { servicePath } from '../service/sections';
import { active, versionText } from './RunHistory';
import {
  CasesSection,
  CompareSection,
  GatesCard,
  JudgesCard,
  LiveQualityComing,
  measuredRun,
  QualityNow,
  RunningCard,
  whenText,
} from './QualityOverview';
import { problemTitle, type SetFlash } from './shared';

const pollMs = 2000;
const feedbackDays = 30;
const feedbackShown = 20;
const hourMs = 3_600_000;

export const qualityAddress = (serviceId: string, query = '') =>
  `#${servicePath(serviceId, 'quality', query ? `?${query}` : '')}`;

const setMeta = (t: T, set: ServiceTestSet, last: EvalRun | undefined) => {
  const metrics = Object.keys(last?.metrics ?? {});
  const cases = t('qualityTabs.setCases', { count: set.cases });
  const meta =
    metrics.length === 1 && metrics[0] === 'refusal'
      ? t('qualityTabs.setRejects', { count: set.cases })
      : set.split?.locked
        ? t('qualityTabs.setLocked', { cases, locked: set.split.locked })
        : cases;
  return meta;
};

const TestSetCards = ({
  api,
  tenant,
  serviceId,
  quality,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  quality: Quality;
}) => {
  const { t, f } = usePortalFormat();
  const data = quality.data;
  const runs = data?.runs ?? [];
  const current = measuredRun(runs)?.testSet;
  const [candidates] = useAsync(
    (signal) => api.quality.candidates(tenant, serviceId, signal),
    [api, tenant, serviceId],
  );
  const proposals =
    candidates.status === 'ready'
      ? candidates.data.filter((c) => c.status === 'pending-review').length
      : undefined;
  return (
    <section aria-labelledby="q-sets" className="quality-section q-sets">
      <div className="row-between">
        <Heading level={2} data-size="xs" id="q-sets">
          {t('qualityPage.testSetsTitle')}
        </Heading>
        <div className="row-wrap">
          <Link href={qualityAddress(serviceId, 'view=feedback')}>
            {proposals === undefined
              ? t('qualityPage.allFeedback')
              : t('qualityTabs.fromFeedback', { count: proposals })}
          </Link>
          <Link href={qualityAddress(serviceId, 'view=testsets')}>{t('qualityTabs.newSet')}</Link>
        </div>
      </div>
      {quality.failed ? (
        <SectionError retry={quality.reload} t={t} loading={false} />
      ) : !data ? (
        <div className="quality-set-cards" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} variant="rectangle" height={64} />
          ))}
        </div>
      ) : data.sets.length === 0 ? (
        <div className="quality-empty">
          <Heading level={3} data-size="2xs">
            {t('qualityPage.noSets')}
          </Heading>
          <Paragraph>{t('qualityPage.noSetsText')}</Paragraph>
          <Button asChild variant="primary">
            <a href={qualityAddress(serviceId, 'view=testsets')}>{t('qualityPage.createSet')}</a>
          </Button>
        </div>
      ) : (
        <ul className="plain-list quality-set-cards" aria-busy={quality.refreshing || undefined}>
          {data.sets.map((s) => {
            const last = measuredRun(runs.filter((r) => r.testSet === s.id));
            const meta = setMeta(t, s, last);
            return (
              <li key={s.id}>
                <a
                  className="quality-set-card"
                  href={qualityAddress(serviceId, `set=${encodeURIComponent(s.id)}`)}
                  aria-current={s.id === current || undefined}
                >
                  <span className="row-between">
                    <strong>{s.name}</strong>
                    <span className="meta">{last ? f.percent(last.score ?? 0, 0) : ''}</span>
                  </span>
                  <span className="meta">
                    {last
                      ? t('qualityTabs.setRun', {
                          meta,
                          when: whenText(t, f, last.endedAt ?? last.startedAt),
                        })
                      : t('qualityTabs.setNotRun', { meta })}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export interface QualityData {
  sets: ServiceTestSet[];
  runs: EvalRun[];
  draft: ServiceDraft | undefined;
}

const useQualityData = (api: ApiClient, tenant: string, serviceId: string, setFlash: SetFlash) => {
  const { t } = usePortalFormat();
  const [round, setRound] = useState(0);
  const [state] = useAsync(
    async (signal): Promise<QualityData> => {
      const [sets, runs, draft] = await Promise.all([
        api.quality.testSets(tenant, serviceId, signal),
        api.quality.runs(tenant, serviceId, signal),
        api.quality.draft(tenant, serviceId, signal).catch(() => undefined),
      ]);
      return { sets, runs, draft };
    },
    [api, tenant, serviceId, round],
  );
  const seen = useRef<QualityData>(undefined);
  if (state.status === 'ready') seen.current = state.data;
  const [starting, setStarting] = useState<string>();
  const runs = seen.current?.runs ?? [];
  const running = runs.some(active);
  const reload = () => setRound((r) => r + 1);

  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => setRound((r) => r + 1), pollMs);
    return () => clearTimeout(timer);
  }, [running, round]);

  const run = async (set: ServiceTestSet) => {
    if (starting) return;
    setStarting(set.id);
    const version = seen.current?.draft ? 'draft' : 'published';
    try {
      await api.quality.startRun(
        tenant,
        serviceId,
        { testSet: set.id, version },
        t('quality.runReason', { name: set.name, version: versionText(t, version).toLowerCase() }),
      );
      reload();
    } catch (error) {
      setFlash({ text: problemTitle(error, t), color: 'danger' });
    } finally {
      setStarting(undefined);
    }
  };

  return {
    data: seen.current,
    failed: state.status === 'error' && !seen.current,
    refreshing: state.status === 'loading' && seen.current !== undefined && !running,
    starting,
    run,
    reload,
  };
};

type Quality = ReturnType<typeof useQualityData>;

const SectionError = ({
  t,
  retry,
  loading,
  title,
  text,
}: {
  t: T;
  retry: () => void;
  loading: boolean;
  title?: string;
  text?: string;
}) => (
  <div role="alert" className="quality-error">
    <Heading level={3} data-size="2xs">
      {title ?? t('states.couldNotFetch')}
    </Heading>
    {text ? <Paragraph>{text}</Paragraph> : null}
    <Button
      variant="secondary"
      data-size="sm"
      aria-disabled={loading || undefined}
      onClick={() => !loading && retry()}
    >
      {loading ? t('qualityPage.retrying') : t('qualityPage.retry')}
    </Button>
  </div>
);

type FeedbackFilter = 'all' | 'down' | 'comment';

const filters: [FeedbackFilter, PlainKey][] = [
  ['all', 'qualityPage.filterAll'],
  ['down', 'qualityPage.filterDown'],
  ['comment', 'qualityPage.filterComment'],
];

const feedbackRowsKey = (tenant: string, serviceId: string) =>
  `genki.feedbackRows.${tenant}/${serviceId}`;

export const feedbackRowsToReserve = (tenant: string, serviceId: string) => {
  try {
    const seen = Number(sessionStorage.getItem(feedbackRowsKey(tenant, serviceId)));
    return seen > 0 ? Math.min(seen, feedbackShown) : 4;
  } catch {
    return 4;
  }
};

export const rememberFeedbackRows = (tenant: string, serviceId: string, rows: number) => {
  try {
    sessionStorage.setItem(feedbackRowsKey(tenant, serviceId), String(rows));
  } catch {
    // Without storage the next visit reserves the default.
  }
};

export const FeedbackSection = ({
  api,
  tenant,
  serviceId,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
}) => {
  const { t, dateTime, date } = usePortalFormat();
  const [now] = useState(() => Math.floor(Date.now() / hourMs) * hourMs);
  const since = now - feedbackDays * 24 * 60 * 60 * 1000;
  const [filter, setFilter] = useState<FeedbackFilter>('all');
  const [state, retry] = useAsync(
    async (signal) => {
      const items = (await api.listFeedback(tenant, serviceId, signal))
        .filter((item) => Date.parse(item.at) >= since)
        .sort((a, b) => b.at.localeCompare(a.at));
      const questions = new Map<string, string>();
      if (items.some((item) => item.task)) {
        const tasks = await api
          .tasks(
            tenant,
            { service: serviceId, from: new Date(since).toISOString(), limit: 500 },
            signal,
          )
          .catch(() => undefined);
        for (const task of tasks?.data ?? [])
          if (task.excerpt && !task.erasure) questions.set(task.id, task.excerpt);
      }
      return { items, questions };
    },
    [api, tenant, serviceId, since],
  );
  const failed = useRef(false);
  if (state.status !== 'loading') failed.current = state.status === 'error';
  const radios = useId();
  const [reserved] = useState(() => feedbackRowsToReserve(tenant, serviceId));
  const tallest = useRef(0);
  const listed = state.status === 'ready' ? Math.min(state.data.items.length, feedbackShown) : 0;
  useEffect(() => {
    if (state.status === 'ready') rememberFeedbackRows(tenant, serviceId, listed);
  }, [state.status, tenant, serviceId, listed]);

  const shown = (item: FeedbackItem) =>
    filter === 'all' ||
    (filter === 'down' && item.rating === 'down') ||
    (filter === 'comment' && Boolean(item.comment));

  return (
    <section aria-labelledby="quality-feedback-h" className="quality-section">
      <div className="row-between">
        <Heading level={2} data-size="sm" id="quality-feedback-h">
          {t('qualityPage.feedbackTitle')}
        </Heading>
        <div role="radiogroup" aria-label={t('qualityPage.feedbackShow')} className="tag-row">
          {filters.map(([value, label]) => (
            <Chip.Radio
              key={value}
              name={radios}
              checked={filter === value}
              onChange={() => setFilter(value)}
            >
              {t(label)}
            </Chip.Radio>
          ))}
        </div>
      </div>
      {state.status === 'error' || (state.status === 'loading' && failed.current) ? (
        <SectionError
          t={t}
          retry={retry}
          loading={state.status === 'loading'}
          title={t('qualityPage.feedbackError')}
          text={t('qualityPage.feedbackErrorText')}
        />
      ) : state.status === 'loading' ? (
        <div className="stack-sm" role="status" aria-label={t('qualityPage.feedbackLoading')}>
          <Skeleton variant="text" width="40%" />
          {Array.from({ length: reserved }, (_, i) => (
            <Skeleton key={i} variant="rectangle" height={40} />
          ))}
        </div>
      ) : state.data.items.length === 0 ? (
        <Paragraph>{t('qualityPage.feedbackNone')}</Paragraph>
      ) : (
        <>
          <Paragraph data-size="sm" className="meta">
            {t('qualityPage.feedbackSummary', {
              up: state.data.items.filter((i) => i.rating === 'up').length,
              down: state.data.items.filter((i) => i.rating === 'down').length,
            })}
          </Paragraph>
          <div
            ref={(el) => {
              if (el && filter === 'all')
                tallest.current = Math.max(tallest.current, el.offsetHeight);
            }}
            style={tallest.current ? { minHeight: tallest.current } : undefined}
          >
            {state.data.items.some(shown) ? (
              <ul className="quality-rows">
                {state.data.items
                  .filter(shown)
                  .slice(0, feedbackShown)
                  .map((item, i) => {
                    const question = item.task ? state.data.questions.get(item.task) : undefined;
                    return (
                      <li
                        key={`${item.task ?? 'anon'}-${item.at}-${i}`}
                        className="quality-feedback"
                      >
                        <Tag
                          data-size="sm"
                          data-color={item.rating === 'up' ? 'success' : 'warning'}
                        >
                          {t(
                            item.rating === 'up' ? 'qualityPage.thumbUp' : 'qualityPage.thumbDown',
                          )}
                        </Tag>
                        <span className="quality-feedback-text">
                          {item.task ? (
                            <Link href={`#/log/${encodeURIComponent(item.task)}`}>
                              {question ?? t('qualityPage.openRun')}
                            </Link>
                          ) : (
                            <span className="meta">{t('qualityPage.hiddenQuestion')}</span>
                          )}
                          {item.comment ? (
                            <span className="quality-feedback-comment">«{item.comment}»</span>
                          ) : null}
                        </span>
                        <span className="meta nowrap">
                          {/^\d{4}-\d{2}-\d{2}$/.test(item.at) ? date(item.at) : dateTime(item.at)}
                        </span>
                      </li>
                    );
                  })}
              </ul>
            ) : (
              <Paragraph data-size="sm">{t('qualityPage.feedbackNoneInFilter')}</Paragraph>
            )}
          </div>
        </>
      )}
      <Link href={qualityAddress(serviceId, 'view=feedback-all')}>
        {t('qualityPage.allFeedback')}
      </Link>
    </section>
  );
};

const publishedVersionOf = (draft: ServiceDraft | undefined, runs: EvalRun[]) =>
  draft?.latestVersion ??
  draft?.baseVersion ??
  runs.reduce<number | undefined>(
    (n, r) => (typeof r.version === 'number' && r.version > (n ?? 0) ? r.version : n),
    undefined,
  );

export const QualityPage = ({
  api,
  tenant,
  tenantName,
  serviceId,
  setFlash,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  serviceId: string;
  setFlash: SetFlash;
}) => {
  const { t } = usePortalFormat();
  const quality = useQualityData(api, tenant, serviceId, setFlash);
  const data = quality.data;
  const runs = data?.runs ?? [];
  const running = runs.find(active);
  const shown = running ?? measuredRun(runs);
  const publishedVersion = publishedVersionOf(data?.draft, runs);
  return (
    <>
      <div className="q-top">
        {!data ? (
          <section aria-label={t('qualityTabs.nowTitle')} className="q-card" aria-busy="true">
            <Skeleton variant="text" width="40%" />
            <Skeleton variant="rectangle" width="30%" height={48} />
            <Skeleton variant="text" width="60%" />
          </section>
        ) : running ? (
          <RunningCard
            api={api}
            tenant={tenant}
            serviceId={serviceId}
            run={running}
            setFlash={setFlash}
            onChanged={quality.reload}
          />
        ) : (
          <QualityNow
            sets={data.sets}
            runs={runs}
            hasDraft={data.draft !== undefined}
            onRun={(set) => void quality.run(set)}
          />
        )}
        <GatesCard
          api={api}
          tenant={tenant}
          tenantName={tenantName}
          serviceId={serviceId}
          runs={runs}
          draft={data?.draft}
          publishedVersion={publishedVersion}
        />
      </div>
      <TestSetCards api={api} tenant={tenant} serviceId={serviceId} quality={quality} />
      <CasesSection
        api={api}
        tenant={tenant}
        serviceId={serviceId}
        run={shown}
        runs={runs}
        setName={data?.sets.find((s) => s.id === shown?.testSet)?.name}
      />
      <div className="q-pair">
        <JudgesCard api={api} run={measuredRun(runs)} />
        <CompareSection
          api={api}
          tenant={tenant}
          serviceId={serviceId}
          runs={runs}
          publishedVersion={publishedVersion}
        />
      </div>
      <LiveQualityComing />
    </>
  );
};
