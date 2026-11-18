import {
  Alert,
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
import type { EvalRun, ServiceTestSet } from '../../api/quality';
import { usePortalFormat } from '../../format';
import { useAsync } from '../../hooks';
import type { PlainKey, T } from '../../i18n';
import { needsRight, useRights } from '../../Shell';
import { Loading } from '../../states';
import type { FeedbackItem } from '../../types';
import { servicePath } from '../service/sections';
import { Improvements } from './Improvements';
import { active, metricLabel, RunEstimate, versionText } from './RunHistory';
import { problemTitle, type SetFlash } from './shared';

const pollMs = 2000;
const feedbackDays = 30;
const feedbackShown = 20;
const hourMs = 3_600_000;

export const qualityAddress = (serviceId: string, query = '') =>
  `#${servicePath(serviceId, 'quality', query ? `?${query}` : '')}`;

const ruleKeys: Record<string, PlainKey> = {
  'exact-text': 'qualityPage.ruleExactText',
  'non-empty-answer': 'qualityPage.ruleNonEmpty',
  refusal: 'qualityPage.ruleRefusal',
  'judge.criteria': 'qualityPage.ruleCriteria',
  'answer-pattern': 'qualityPage.ruleAnswerPattern',
};

const newestFirst = (a: EvalRun, b: EvalRun) =>
  (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt);

const completed = (runs: EvalRun[]) =>
  runs.filter((r) => r.status === 'completed' && typeof r.total === 'number').sort(newestFirst);

/** Pass share and failures per genki rule in a run; Langfuse judges are left to the run detail. */
export const rulesOf = (run: EvalRun) => {
  const sink = new Set((run.sinkJudges ?? []).map((j) => j.id));
  return Object.entries(run.metrics ?? {})
    .filter(([metric]) => !sink.has(metric) && !metric.startsWith('langfuse:'))
    .map(([metric, m]) => ({
      metric,
      share: m.mean,
      failed: Math.round((1 - m.mean) * m.n),
    }));
};

const TestSetRow = ({
  api,
  tenant,
  set,
  runs,
  started,
  starting,
  canManage,
  serviceId,
  onRun,
}: {
  api: ApiClient;
  tenant: string;
  set: ServiceTestSet;
  runs: EvalRun[];
  started: { run: string; before?: number } | undefined;
  starting: boolean;
  canManage: boolean;
  serviceId: string;
  onRun: () => void;
}) => {
  const { t, dateTime } = usePortalFormat();
  const hintId = useId();
  const [confirming, setConfirming] = useState(false);
  const own = runs.filter((r) => r.testSet === set.id);
  const last = completed(own)[0];
  const running = own.find(active);
  const busy = starting || running !== undefined;
  const total = running?.total || set.cases;
  const done = running?.finished ?? 0;
  const fresh = started && last?.id === started.run && typeof started.before === 'number';
  const result = busy
    ? t('qualityPage.runningResult', { done, total })
    : fresh
      ? t('qualityPage.newResult', {
          passed: last.passed ?? 0,
          total: last.total ?? 0,
          before: started.before ?? 0,
        })
      : last
        ? t('qualityPage.lastResult', { passed: last.passed ?? 0, total: last.total ?? 0 })
        : t('qualityPage.notRun');
  const resultClass = fresh
    ? (last.passed ?? 0) >= (started.before ?? 0)
      ? 'success-text'
      : 'danger-text'
    : undefined;
  const hint = !canManage
    ? needsRight('manage-services', t)
    : set.cases === 0
      ? t('quality.addCasesFirst')
      : undefined;
  return (
    <li className="quality-set">
      <div className="quality-set-name">
        <Link href={qualityAddress(serviceId, `set=${encodeURIComponent(set.id)}`)}>
          {set.name}
        </Link>
        <span className="meta">
          {last
            ? t('qualityPage.setMetaRun', {
                count: set.cases,
                when: dateTime(last.endedAt ?? last.startedAt),
              })
            : t('qualityPage.setMeta', { count: set.cases })}
        </span>
      </div>
      <div className="quality-set-result" aria-live="polite">
        <span className={resultClass}>{result}</span>
        {busy ? (
          <progress
            max={total}
            value={done}
            aria-label={t('qualityPage.progress', { name: set.name })}
          />
        ) : null}
      </div>
      <div className="quality-set-action">
        <Button
          variant="secondary"
          data-size="sm"
          aria-disabled={busy || hint !== undefined || undefined}
          aria-describedby={hint ? hintId : undefined}
          aria-expanded={hint ? undefined : confirming}
          onClick={() => !busy && !hint && setConfirming(true)}
        >
          {busy ? t('qualityPage.running') : t('quality.runSet')}
        </Button>
        {hint ? (
          <span id={hintId} className="meta">
            {hint}
          </span>
        ) : null}
      </div>
      {confirming && !busy && !hint ? (
        <Alert data-color="info" data-size="sm" className="quality-confirm">
          <Heading level={3} data-size="2xs">
            {t('quality.confirmRunTitle', { count: set.cases })}
          </Heading>
          <RunEstimate
            api={api}
            tenant={tenant}
            serviceId={serviceId}
            runs={own}
            cases={set.cases}
          />
          <div className="actions">
            <Button
              variant="primary"
              data-size="sm"
              onClick={() => {
                setConfirming(false);
                onRun();
              }}
            >
              {t('quality.confirmRun')}
            </Button>
            <Button variant="tertiary" data-size="sm" onClick={() => setConfirming(false)}>
              {t('quality.cancel')}
            </Button>
          </div>
        </Alert>
      ) : null}
    </li>
  );
};

const RulesSection = ({ run, serviceId }: { run: EvalRun | undefined; serviceId: string }) => {
  const { t, f, dateTime } = usePortalFormat();
  const rules = run ? rulesOf(run) : [];
  return (
    <section aria-labelledby="quality-rules-h" className="quality-section">
      <div className="stack-xs">
        <Heading level={2} data-size="sm" id="quality-rules-h">
          {t('qualityPage.judgesTitle')}
        </Heading>
        {run && rules.length > 0 ? (
          <Paragraph>
            {t('qualityPage.judgesLead', { when: dateTime(run.endedAt ?? run.startedAt) })}
          </Paragraph>
        ) : (
          <Paragraph>{t('qualityPage.judgesNone')}</Paragraph>
        )}
      </div>
      {run && rules.length > 0 ? (
        <ul className="quality-rows">
          {rules.map((r) => {
            const about = ruleKeys[r.metric];
            return (
              <li key={r.metric} className="quality-rule">
                <span className="quality-rule-name">
                  <strong>{metricLabel(t, r.metric)}</strong>
                  {about ? <span className="meta">{t(about)}</span> : null}
                </span>
                <span className="quality-rule-share">{f.percent(r.share)}</span>
                {r.failed > 0 ? (
                  <Link
                    href={qualityAddress(
                      serviceId,
                      `set=${encodeURIComponent(run.testSet)}&run=${encodeURIComponent(run.id)}`,
                    )}
                  >
                    {t('qualityPage.seeFailed', { count: r.failed })}
                  </Link>
                ) : (
                  <span className="meta">{t('qualityPage.allPassed')}</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
};

const TestSetsAndRules = ({
  api,
  tenant,
  serviceId,
  setFlash,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  setFlash: SetFlash;
}) => {
  const { t } = usePortalFormat();
  const canManage = useRights().has('manage-services');
  const [round, setRound] = useState(0);
  const [state] = useAsync(
    async (signal) => {
      const [sets, runs, draft] = await Promise.all([
        api.quality.testSets(tenant, serviceId, signal),
        api.quality.runs(tenant, serviceId, signal),
        api.quality.draft(tenant, serviceId, signal).catch(() => undefined),
      ]);
      return { sets, runs, hasDraft: draft !== undefined };
    },
    [api, tenant, serviceId, round],
  );
  const seen = useRef<{ sets: ServiceTestSet[]; runs: EvalRun[]; hasDraft: boolean }>(undefined);
  if (state.status === 'ready') seen.current = state.data;
  const [starting, setStarting] = useState<string>();
  const [started, setStarted] = useState<Record<string, { run: string; before?: number }>>({});
  const runs = seen.current?.runs ?? [];
  const running = runs.some(active);

  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => setRound((r) => r + 1), pollMs);
    return () => clearTimeout(timer);
  }, [running, round]);

  const run = async (set: ServiceTestSet) => {
    if (starting) return;
    setStarting(set.id);
    const version = seen.current?.hasDraft ? 'draft' : 'published';
    const before = completed(runs.filter((r) => r.testSet === set.id))[0]?.passed ?? undefined;
    try {
      const { id } = await api.quality.startRun(
        tenant,
        serviceId,
        { testSet: set.id, version },
        t('quality.runReason', { name: set.name, version: versionText(t, version).toLowerCase() }),
      );
      setStarted((all) => ({
        ...all,
        [set.id]: { run: id, ...(before === undefined ? {} : { before }) },
      }));
      setRound((r) => r + 1);
    } catch (error) {
      setFlash({ text: problemTitle(error, t), color: 'danger' });
    } finally {
      setStarting(undefined);
    }
  };

  const data = seen.current;
  return (
    <>
      <section aria-labelledby="quality-sets-h" className="quality-section">
        <div className="stack-xs">
          <Heading level={2} data-size="sm" id="quality-sets-h">
            {t('qualityPage.testSetsTitle')}
          </Heading>
          <Paragraph>{t('qualityPage.testSetsLead')}</Paragraph>
        </div>
        {!data && state.status === 'error' ? (
          <SectionError retry={() => setRound((r) => r + 1)} t={t} loading={false} />
        ) : !data ? (
          <Loading label={t('quality.setsLoading')} />
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
          <ul className="quality-rows">
            {data.sets.map((s) => (
              <TestSetRow
                key={s.id}
                api={api}
                tenant={tenant}
                set={s}
                runs={runs}
                started={started[s.id]}
                starting={starting === s.id}
                canManage={canManage}
                serviceId={serviceId}
                onRun={() => void run(s)}
              />
            ))}
          </ul>
        )}
      </section>
      <RulesSection run={completed(runs)[0]} serviceId={serviceId} />
    </>
  );
};

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

const FeedbackSection = ({
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
          {[0, 1, 2, 3].map((i) => (
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
          {state.data.items.some(shown) ? (
            <ul className="quality-rows">
              {state.data.items
                .filter(shown)
                .slice(0, feedbackShown)
                .map((item, i) => {
                  const question = item.task ? state.data.questions.get(item.task) : undefined;
                  return (
                    <li key={`${item.task ?? 'anon'}-${item.at}-${i}`} className="quality-feedback">
                      <Tag data-size="sm" data-color={item.rating === 'up' ? 'success' : 'warning'}>
                        {t(item.rating === 'up' ? 'qualityPage.thumbUp' : 'qualityPage.thumbDown')}
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
        </>
      )}
      <Link href={qualityAddress(serviceId, 'view=feedback')}>{t('qualityPage.allFeedback')}</Link>
    </section>
  );
};

export const QualityPage = ({
  api,
  tenant,
  serviceId,
  setFlash,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  setFlash: SetFlash;
}) => {
  const { t } = usePortalFormat();
  return (
    <>
      <TestSetsAndRules api={api} tenant={tenant} serviceId={serviceId} setFlash={setFlash} />
      <FeedbackSection api={api} tenant={tenant} serviceId={serviceId} />
      <Improvements api={api} tenant={tenant} serviceId={serviceId} setFlash={setFlash} />
      <details className="quality-technical">
        <summary>{t('qualityPage.technical')}</summary>
        <Link href={qualityAddress(serviceId, 'view=gates')}>{t('qualityPage.gatesLink')}</Link>
      </details>
    </>
  );
};
