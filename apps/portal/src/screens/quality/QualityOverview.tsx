import {
  Alert,
  Button,
  Field,
  Heading,
  Label,
  Link,
  Paragraph,
  Search,
  Select,
  Skeleton,
  Table,
  Tag,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import { ApiError, type ApiClient, type ConfigEntry } from '../../api';
import type { EvalRun, ServiceTestSet } from '../../api/quality';
import type { CaseChange, ComparedCase, EvalComparison } from '../../api/service-tabs';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import { usePortalFormat } from '../../format';
import { useAsync } from '../../hooks';
import type { Format, PlainKey, T } from '../../i18n';
import { modelLabel } from '../../models';
import type { ModelOption } from '../../types';
import { needsRight, useRights } from '../../Shell';
import { servicePath } from '../service/sections';
import { active, perCaseFromRuns } from './RunHistory';
import { problemTitle, type SetFlash } from './shared';

const casesPerPage = 8;
const comparePage = 200;
const compareShown = 3;

type Color = 'success' | 'danger' | 'warning' | 'info' | 'neutral';

const ended = (r: EvalRun) => r.endedAt ?? r.startedAt;

export const completedRuns = (runs: EvalRun[]) =>
  runs
    .filter((r) => r.status === 'completed' && typeof r.score === 'number')
    .sort((a, b) => ended(b).localeCompare(ended(a)));

export const measuredRun = (runs: EvalRun[]) => {
  const done = completedRuns(runs);
  return done.find((r) => r.version !== 'draft') ?? done[0];
};

export const latestDraftRun = (runs: EvalRun[], testSet: string | undefined) =>
  completedRuns(runs).find((r) => r.version === 'draft' && r.testSet === testSet);

const typeKeys: Record<string, PlainKey> = {
  criteria: 'qualityTabs.typeCriteria',
  exact: 'qualityTabs.typeExact',
  must_reject: 'qualityTabs.typeReject',
};

const typeText = (t: T, type: string) => (typeKeys[type] ? t(typeKeys[type]) : type);

export const versionLabel = (t: T, v: EvalRun['version']) =>
  typeof v === 'number' ? t('qualityTabs.versionN', { n: v }) : t('qualityTabs.draft');

export const versionTitle = (t: T, v: EvalRun['version']) =>
  typeof v === 'number' ? t('qualityTabs.versionTitle', { n: v }) : t('qualityTabs.draftTitle');

const percent = (f: Format, n: number | null | undefined) =>
  typeof n === 'number' ? f.percent(n, 0) : '–';

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

export const whenText = (t: T, f: Format, iso: string) =>
  sameDay(new Date(iso), new Date())
    ? t('qualityTabs.todayAt', { time: f.time(iso) })
    : new Intl.DateTimeFormat(f.locale === 'en' ? 'en-GB' : 'nb-NO', {
        day: 'numeric',
        month: 'short',
        timeZone: 'Europe/Oslo',
      })
        .format(new Date(iso))
        .replace(/\.$/, '');

const minutesOf = (runs: EvalRun[]) => {
  const timed = runs.filter((r) => r.endedAt && (r.total ?? 0) > 0 && !active(r));
  const seconds = timed.reduce(
    (n, r) => n + (Date.parse(r.endedAt ?? r.startedAt) - Date.parse(r.startedAt)) / 1000,
    0,
  );
  const cases = timed.reduce((n, r) => n + (r.total ?? 0), 0);
  return cases > 0 ? seconds / cases : undefined;
};

const estimateOf = (t: T, f: Format, runs: EvalRun[], count: number) => {
  const perCase = minutesOf(runs);
  if (perCase === undefined) return {};
  const time = t('qualityTabs.minutes', { count: Math.max(1, Math.round((perCase * count) / 60)) });
  const cost = perCaseFromRuns(runs);
  return cost === undefined
    ? { time }
    : {
        time,
        cost: f.currency(Math.max(1, Math.round((cost * count) / 1_000_000)), { digits: 0 }),
      };
};

const estimateText = (t: T, f: Format, runs: EvalRun[], count: number) => {
  const cases = t('qualityTabs.caseCount', { count });
  const { time, cost } = estimateOf(t, f, runs, count);
  if (time === undefined) return cases;
  return cost === undefined
    ? t('qualityTabs.estimateTime', { cases, time })
    : t('qualityTabs.estimateAll', { cases, time, cost });
};

const confirmText = (t: T, f: Format, runs: EvalRun[], count: number) => {
  const { time, cost } = estimateOf(t, f, runs, count);
  if (time === undefined) return t('quality.confirmRunPaid');
  return cost === undefined
    ? t('quality.confirmRunTime', { time })
    : t('quality.confirmRunCost', { time, cost });
};

const RunAgain = ({
  set,
  runs,
  hasDraft,
  onRun,
}: {
  set: ServiceTestSet;
  runs: EvalRun[];
  hasDraft: boolean;
  onRun: () => void;
}) => {
  const { t, f } = usePortalFormat();
  const [open, setOpen] = useState(false);
  const canManage = useRights().has('manage-services');
  const own = runs.filter((r) => r.testSet === set.id);
  const estimate = estimateText(t, f, own, set.cases);
  return (
    <div className="q-card-foot">
      {canManage ? (
        <Button
          variant="primary"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          disabled={set.cases === 0}
        >
          {t(hasDraft ? 'qualityTabs.testDraftAgain' : 'qualityTabs.testAgain')}
        </Button>
      ) : null}
      <span className="meta">
        {canManage ? estimate : `${estimate}. ${needsRight('manage-services', t)}`}
      </span>
      {open && canManage ? (
        <Alert data-color="info" data-size="sm" className="quality-confirm">
          <Heading level={3} data-size="2xs">
            {t('quality.confirmRunTitle', { count: set.cases })}
          </Heading>
          <Paragraph data-size="sm">{confirmText(t, f, own, set.cases)}</Paragraph>
          <div className="actions">
            <Button
              variant="primary"
              data-size="sm"
              onClick={() => {
                setOpen(false);
                onRun();
              }}
            >
              {t('quality.confirmRun')}
            </Button>
            <Button variant="tertiary" data-size="sm" onClick={() => setOpen(false)}>
              {t('quality.cancel')}
            </Button>
          </div>
        </Alert>
      ) : null}
    </div>
  );
};

const barHeight = (score: number) =>
  Math.min(80, Math.max(6, Math.round(((score * 100 - 60) / 30) * 70)));

export const QualityNow = ({
  sets,
  runs,
  hasDraft,
  onRun,
}: {
  sets: ServiceTestSet[];
  runs: EvalRun[];
  hasDraft: boolean;
  onRun: (set: ServiceTestSet) => void;
}) => {
  const { t, f } = usePortalFormat();
  const latest = measuredRun(runs);
  const set = sets.find((s) => s.id === latest?.testSet) ?? sets[0];
  const same = completedRuns(runs).filter(
    (r) => r.testSet === latest?.testSet && typeof r.version === 'number',
  );
  const perVersion = new Map<number, number>();
  for (const r of [...same].reverse()) perVersion.set(r.version as number, r.score ?? 0);
  const points = [...perVersion].sort((a, b) => a[0] - b[0]).slice(-7);
  const previous = latest
    ? same.find((r) => r.version !== latest.version && r.id !== latest.id)
    : undefined;
  const delta =
    latest && previous ? Math.round(((latest.score ?? 0) - (previous.score ?? 0)) * 100) : 0;
  return (
    <section aria-labelledby="q-now" className="q-card">
      <div className="row-between">
        <Heading level={2} data-size="xs" id="q-now">
          {t('qualityTabs.nowTitle')}
        </Heading>
        {latest ? (
          <span className="meta">
            {t('qualityTabs.nowMeta', {
              set: set?.name ?? latest.testSet,
              when: whenText(t, f, ended(latest)),
            })}
          </span>
        ) : null}
      </div>
      {latest ? (
        <div className="q-now">
          <div className="q-now-score">
            <span className="q-score">{percent(f, latest.score)}</span>
            <span className="meta">
              {t('qualityTabs.passedOf', {
                passed: latest.passed ?? 0,
                total: latest.total ?? 0,
                version: versionLabel(t, latest.version),
              })}
            </span>
            {previous ? (
              <span className={delta > 0 ? 'success-text' : delta < 0 ? 'danger-text' : 'meta'}>
                {delta === 0
                  ? t('qualityTabs.sameAs', { version: versionLabel(t, previous.version) })
                  : t(delta > 0 ? 'qualityTabs.upFrom' : 'qualityTabs.downFrom', {
                      points: Math.abs(delta),
                      version: versionLabel(t, previous.version),
                    })}
              </span>
            ) : null}
          </div>
          {points.length > 1 ? (
            <figure className="q-trend">
              <div
                role="img"
                className="q-trend-bars"
                aria-label={t('qualityTabs.trendLabel', {
                  points: points
                    .map(([v, s]) =>
                      t('qualityTabs.trendPoint', { version: v, score: percent(f, s) }),
                    )
                    .join(', '),
                })}
              >
                {points.map(([v, s], i) => (
                  <span
                    key={v}
                    className="q-trend-bar"
                    data-last={i === points.length - 1 || undefined}
                  >
                    <span className="q-trend-value">{percent(f, s)}</span>
                    <span className="q-trend-fill" style={{ height: `${barHeight(s)}px` }} />
                  </span>
                ))}
              </div>
              <figcaption className="q-trend-labels" aria-hidden="true">
                {points.map(([v]) => (
                  <span key={v}>{t('qualityTabs.versionShort', { n: v })}</span>
                ))}
              </figcaption>
            </figure>
          ) : null}
        </div>
      ) : (
        <Paragraph>{t('qualityTabs.notMeasured')}</Paragraph>
      )}
      {set ? <RunAgain set={set} runs={runs} hasDraft={hasDraft} onRun={() => onRun(set)} /> : null}
    </section>
  );
};

const CancelRun = ({
  api,
  tenant,
  serviceId,
  run,
  setFlash,
  onChanged,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  run: EvalRun;
  setFlash: SetFlash;
  onChanged: () => void;
}) => {
  const { t } = usePortalFormat();
  const rights = useRights();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string>();
  const allowed =
    rights.has('manage-services') || (run.startedByYou === true && rights.has('use-services'));
  if (!allowed) return null;
  if (cancelling) return <span className="meta">{t('qualityTabs.cancelling')}</span>;
  if (!open)
    return (
      <Button
        variant="secondary"
        data-color="danger"
        aria-expanded={false}
        onClick={() => setOpen(true)}
      >
        {t('qualityTabs.cancelRun')}
      </Button>
    );
  const confirm = async () => {
    setTried(true);
    if (reasonProblem(reason, t) || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const done = await api.serviceTabs.cancelEvalRun(tenant, serviceId, run.id, reason.trim());
      if (done.status === 'cancelled') {
        setFlash({ text: t('qualityTabs.cancelled'), color: 'success' });
      } else setCancelling(true);
      setOpen(false);
      onChanged();
    } catch (e) {
      setError(problemTitle(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Alert data-color="warning" data-size="sm" className="quality-confirm">
      <Heading level={3} data-size="2xs">
        {t('qualityTabs.cancelTitle')}
      </Heading>
      <Paragraph data-size="sm">{t('qualityTabs.cancelText')}</Paragraph>
      <ReasonField value={reason} onChange={setReason} showError={tried} disabled={busy} />
      {error ? (
        <Paragraph data-size="sm" className="danger-text" role="alert">
          {error}
        </Paragraph>
      ) : null}
      <div className="actions">
        <Button
          variant="primary"
          data-color="danger"
          data-size="sm"
          aria-disabled={busy || undefined}
          onClick={() => void confirm()}
        >
          {t('qualityTabs.cancelRun')}
        </Button>
        <Button variant="tertiary" data-size="sm" onClick={() => setOpen(false)}>
          {t('qualityTabs.keepRunning')}
        </Button>
      </div>
    </Alert>
  );
};

export const RunningCard = ({
  api,
  tenant,
  serviceId,
  run,
  setFlash,
  onChanged,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  run: EvalRun;
  setFlash: SetFlash;
  onChanged: () => void;
}) => {
  const { t, f } = usePortalFormat();
  const total = run.total ?? 0;
  const finished = run.finished ?? 0;
  const [compared] = useAsync(
    (signal) =>
      api.serviceTabs.compare(tenant, serviceId, { candidate: run.id, limit: comparePage }, signal),
    [api, tenant, serviceId, run.id, finished],
    { keepPreviousFor: run.id },
  );
  const cases = compared.status === 'ready' ? compared.data.data : [];
  const scored = cases.filter((c) => c.candidate);
  const passed = scored.filter((c) => c.candidate?.pass).length;
  const before = scored.filter((c) => c.baseline?.pass).length;
  const time = f.time(run.startedAt);
  return (
    <section aria-labelledby="q-run" aria-live="polite" className="q-card q-card-running">
      <div className="row-between">
        <Heading level={2} data-size="xs" id="q-run">
          {t(run.version === 'draft' ? 'qualityTabs.testingDraft' : 'qualityTabs.testingService')}
        </Heading>
        <span className="meta">
          {run.startedByName
            ? t('qualityTabs.startedBy', { time, name: run.startedByName })
            : run.startedByYou
              ? t('qualityTabs.startedByYou', { time })
              : t('qualityTabs.startedAt', { time })}
        </span>
      </div>
      <div className="stack-xs">
        <div className="row-between">
          <strong>{t('qualityTabs.doneOf', { done: finished, total })}</strong>
          {run.endsAt ? (
            <span className="meta">{t('qualityTabs.endsAt', { time: f.time(run.endsAt) })}</span>
          ) : null}
        </div>
        <progress
          className="q-progress"
          max={total || 1}
          value={finished}
          aria-label={t('qualityTabs.progress')}
        />
      </div>
      <dl className="q-running-facts">
        <div>
          <dt>{t('qualityTabs.passedSoFar')}</dt>
          <dd>
            {compared.status === 'ready'
              ? t('qualityTabs.nOfM', { n: passed, m: scored.length })
              : typeof run.passed === 'number'
                ? t('qualityTabs.nOfM', { n: run.passed, m: finished })
                : '–'}
          </dd>
        </div>
        {compared.status === 'ready' ? (
          <div>
            <dt>
              {t('qualityTabs.baselineSame', {
                version: versionTitle(t, compared.data.baseline.version),
              })}
            </dt>
            <dd>{t('qualityTabs.nOfM', { n: before, m: scored.length })}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t('qualityTabs.runningNow')}</dt>
          <dd>{t('qualityTabs.caseCount', { count: run.current?.length ?? 0 })}</dd>
        </div>
      </dl>
      <div className="q-card-foot">
        <CancelRun
          api={api}
          tenant={tenant}
          serviceId={serviceId}
          run={run}
          setFlash={setFlash}
          onChanged={onChanged}
        />
        <span className="meta">{t('qualityTabs.canLeave')}</span>
      </div>
    </section>
  );
};

type GateState = 'passes' | 'stops' | 'waiting';

const gateTags: Record<GateState, [PlainKey, Color]> = {
  passes: ['qualityTabs.gatePasses', 'success'],
  stops: ['qualityTabs.gateStops', 'danger'],
  waiting: ['qualityTabs.gateWaiting', 'neutral'],
};

interface GateSpec {
  metric?: string;
  kind?: string;
  threshold?: number;
  maxRegression?: number;
}

const gateName = (t: T, spec: GateSpec) => {
  const threshold = Math.round(Number(spec.threshold ?? 0) * 100);
  if (spec.kind !== 'threshold')
    return t('qualityTabs.gateNoRegression', {
      points: Math.round(Number(spec.maxRegression ?? 0) * 100),
    });
  if (spec.metric === 'judge.criteria') return t('qualityTabs.gateShare', { threshold });
  const metric =
    spec.metric === 'refusal'
      ? t('qualityTabs.gateRefusal')
      : spec.metric === 'exact-text'
        ? t('qualityTabs.judgeExact')
        : (spec.metric ?? '');
  return t('qualityTabs.gateAtLeast', { metric, threshold });
};

const judgeOf = (
  spec: GateSpec,
  draftRun: EvalRun | undefined,
  baseline: EvalRun | undefined,
): { state: GateState; value?: number; delta?: number; n?: number } => {
  const metric = spec.metric ? draftRun?.metrics?.[spec.metric] : undefined;
  if (!metric) return { state: 'waiting' };
  if (spec.kind === 'threshold')
    return {
      state: metric.mean >= Number(spec.threshold ?? 0) ? 'passes' : 'stops',
      value: metric.mean,
      n: metric.n,
    };
  const before = spec.metric ? baseline?.metrics?.[spec.metric] : undefined;
  if (!before) return { state: 'waiting' };
  const delta = Math.round((metric.mean - before.mean) * 100);
  return {
    state: delta >= -Math.round(Number(spec.maxRegression ?? 0) * 100) ? 'passes' : 'stops',
    delta,
  };
};

const judgeDraft = (gate: ConfigEntry, runs: EvalRun[], publishedVersion: number | undefined) => {
  const testSet = measuredRun(runs)?.testSet ?? completedRuns(runs)[0]?.testSet;
  const baseline = completedRuns(runs).find(
    (r) => r.testSet === testSet && r.version === publishedVersion,
  );
  return judgeOf(gate.spec as GateSpec, latestDraftRun(runs, testSet), baseline);
};

export const gateStops = (
  gate: ConfigEntry,
  runs: EvalRun[],
  publishedVersion: number | undefined,
) => judgeDraft(gate, runs, publishedVersion).state === 'stops';

export const gateStopReason = (
  t: T,
  f: Format,
  gate: ConfigEntry,
  runs: EvalRun[],
  publishedVersion: number | undefined,
) => {
  const spec = gate.spec as GateSpec;
  const judged = judgeDraft(gate, runs, publishedVersion);
  if (spec.kind === 'threshold' && judged.value !== undefined)
    return t('qualityTabs.gateBelow', {
      metric:
        spec.metric === 'refusal'
          ? t('qualityTabs.gateRefusal')
          : spec.metric === 'exact-text'
            ? t('qualityTabs.judgeExact')
            : spec.metric === 'judge.criteria'
              ? t('qualityTabs.gateShareName')
              : (spec.metric ?? gate.id),
      value: percent(f, judged.value),
      threshold: `${f.number(Math.round(Number(spec.threshold ?? 0) * 100))} %`,
    });
  return gateName(t, spec);
};

export const GatesCard = ({
  api,
  tenant,
  tenantName,
  serviceId,
  runs,
  draft,
  publishedVersion,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  serviceId: string;
  runs: EvalRun[];
  draft: { definition: Record<string, unknown>; revision: number } | undefined;
  publishedVersion: number | undefined;
}) => {
  const { t, f } = usePortalFormat();
  const listed =
    (draft?.definition.spec as { evaluation?: { gates?: string[] } } | undefined)?.evaluation
      ?.gates ?? [];
  const [state, retry] = useAsync(
    async (signal) =>
      (await api.configList(`/tenants/${encodeURIComponent(tenant)}/gates`, signal)).data,
    [api, tenant],
  );
  const measured = measuredRun(runs);
  const testSet = measured?.testSet ?? completedRuns(runs)[0]?.testSet;
  const draftRunning = runs.some((r) => active(r) && r.version === 'draft');
  const draftRun = draftRunning ? undefined : latestDraftRun(runs, testSet);
  const baseline = completedRuns(runs).find(
    (r) => r.testSet === testSet && r.version === publishedVersion,
  );
  const gates =
    state.status === 'ready' ? state.data.filter((g) => g.mandatory || listed.includes(g.id)) : [];
  const against = publishedVersion === undefined ? '' : versionLabel(t, publishedVersion);
  const lead = !draft
    ? t('qualityTabs.gatesNoDraft')
    : draftRunning
      ? `${t('qualityTabs.gatesLead')} ${t('qualityTabs.gatesRunning')}`
      : !draftRun
        ? `${t('qualityTabs.gatesLead')} ${t('qualityTabs.gatesNotRun')}`
        : `${t('qualityTabs.gatesLead')} ${t(
            (draftRun.draftRevision ?? draft.revision) < draft.revision
              ? 'qualityTabs.gatesChangedSince'
              : 'qualityTabs.gatesChecked',
            { time: f.time(ended(draftRun)) },
          )}`;
  const metaOf = (g: ConfigEntry, judged: ReturnType<typeof judgeOf>) => {
    const spec = g.spec as GateSpec;
    const parts: string[] = [];
    if (g.mandatory)
      parts.push(
        g.scope === 'platform'
          ? t('qualityTabs.gateRequiredByPlatform')
          : t('qualityTabs.gateRequiredBy', { org: tenantName }),
      );
    if (spec.kind !== 'threshold' && against)
      parts.push(
        judged.state === 'waiting'
          ? t('qualityTabs.gateAgainstLive', { version: against })
          : t('qualityTabs.gateAgainst', { version: against }),
      );
    if (judged.state === 'waiting') {
      if (spec.metric === 'refusal' && !g.mandatory) parts.push(t('qualityTabs.gateRefusalCases'));
    } else if (spec.kind !== 'threshold')
      parts.push(
        t('qualityTabs.gateDraftDelta', {
          delta: `${(judged.delta ?? 0) > 0 ? '+' : ''}${f.number(judged.delta ?? 0)}`,
        }),
      );
    else if (spec.metric === 'refusal' && judged.n !== undefined)
      parts.push(
        t('qualityTabs.gateRefused', {
          n: Math.round((judged.value ?? 0) * judged.n),
          m: judged.n,
          score: percent(f, judged.value),
        }),
      );
    else parts.push(t('qualityTabs.gateDraftScore', { score: percent(f, judged.value) }));
    return parts.join('. ');
  };
  return (
    <section
      aria-labelledby="q-gates"
      aria-busy={state.status === 'loading' || undefined}
      className="q-card q-card-gates"
    >
      <div className="row-between">
        <Heading level={2} data-size="xs" id="q-gates">
          {t('qualityTabs.gatesTitle')}
        </Heading>
        <Link href={`#${servicePath(serviceId, 'quality', '?view=gates')}`} data-size="sm">
          {t('qualityTabs.editGates')}
        </Link>
      </div>
      <Paragraph data-size="sm" className="meta">
        {lead}
      </Paragraph>
      {state.status === 'loading' ? (
        <div className="stack-sm">
          <Skeleton variant="text" width="80%" />
          <Skeleton variant="text" width="70%" />
          <Skeleton variant="text" width="75%" />
        </div>
      ) : state.status === 'error' ? (
        <Alert data-color="danger" data-size="sm">
          {t('qualityTabs.gatesFailed')}{' '}
          <Button variant="tertiary" data-size="sm" onClick={retry}>
            {t('qualityPage.retry')}
          </Button>
        </Alert>
      ) : gates.length === 0 ? (
        <Paragraph data-size="sm">{t('qualityTabs.noGates')}</Paragraph>
      ) : (
        <ul className="plain-list q-gates">
          {gates.map((g) => {
            const judged = draft
              ? judgeOf(g.spec as GateSpec, draftRun, baseline)
              : { state: 'waiting' as const };
            const [key, color] = gateTags[judged.state];
            return (
              <li key={g.id} data-state={judged.state}>
                <span className="q-dot" aria-hidden="true" />
                <span className="q-gate-text">
                  <strong>{gateName(t, g.spec as GateSpec)}</strong>
                  <span className="meta">{metaOf(g, judged)}</span>
                </span>
                <Tag data-size="sm" data-color={color}>
                  {t(key)}
                </Tag>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

type CaseFilter = 'all' | 'failed' | 'passed' | 'done' | 'running' | 'waiting';

type FilterKey =
  | 'qualityTabs.filterAll'
  | 'qualityTabs.filterFailed'
  | 'qualityTabs.filterPassed'
  | 'qualityTabs.filterDone'
  | 'qualityTabs.filterRunning'
  | 'qualityTabs.filterWaiting';

interface CaseRow {
  id: string;
  input: string;
  type: string;
  result: 'passed' | 'failed' | 'running' | 'waiting';
  reason: string | undefined;
  before: boolean | undefined;
}

const resultTags: Record<CaseRow['result'], [PlainKey, Color]> = {
  passed: ['qualityTabs.passed', 'success'],
  failed: ['qualityTabs.failed', 'danger'],
  running: ['qualityTabs.running', 'info'],
  waiting: ['qualityTabs.waiting', 'neutral'],
};

const rowsFromCompare = (cases: ComparedCase[], current: Set<string>): CaseRow[] =>
  cases.map((c) => ({
    id: c.case,
    input: c.input,
    type: c.type,
    result: c.candidate
      ? c.candidate.pass
        ? 'passed'
        : 'failed'
      : current.has(c.case)
        ? 'running'
        : 'waiting',
    reason: c.candidate?.reason,
    before: c.baseline ? c.baseline.pass : undefined,
  }));

const noPublishedRun = (error: unknown) =>
  error instanceof ApiError &&
  error.status === 404 &&
  (error.problem?.errors ?? []).some((e) => e.path === 'baseline');

const matches = (filter: CaseFilter, r: CaseRow) =>
  filter === 'all'
    ? true
    : filter === 'done'
      ? r.result === 'passed' || r.result === 'failed'
      : r.result === filter;

export const baselineFor = (run: EvalRun, runs: EvalRun[]) => {
  if (active(run) || typeof run.version !== 'number') return undefined;
  const version = run.version;
  return (
    completedRuns(runs).find(
      (r) => r.testSet === run.testSet && typeof r.version === 'number' && r.version < version,
    )?.id ?? run.id
  );
};

export const CasesSection = ({
  api,
  tenant,
  serviceId,
  run,
  runs,
  setName,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  run: EvalRun | undefined;
  runs: EvalRun[];
  setName: string | undefined;
}) => {
  const { t, f } = usePortalFormat();
  const [filter, setFilter] = useState<CaseFilter>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const runningNow = run ? active(run) : false;
  const baselineId = run ? baselineFor(run, runs) : undefined;
  const [state, retry] = useAsync(
    async (signal) => {
      if (!run) return undefined;
      const current = new Set((run.current ?? []).map((c) => c.case));
      const compare = (baseline: string | undefined) =>
        api.serviceTabs.compare(
          tenant,
          serviceId,
          { candidate: run.id, baseline, limit: comparePage },
          signal,
        );
      const [compared, detail] = await Promise.all([
        compare(baselineId).catch((error: unknown) => {
          if (baselineId === undefined && noPublishedRun(error)) return compare(run.id);
          throw error;
        }),
        api.quality.run(tenant, run.id, signal).catch(() => undefined),
      ]);
      const tasks = new Map(
        (detail?.cases ?? []).flatMap((c) => (c.task ? [[c.caseId, c.task] as const] : [])),
      );
      return {
        rows: rowsFromCompare(compared.data, current),
        baseline: compared.baseline.id === run.id ? undefined : compared.baseline.version,
        total: compared.total,
        tasks,
      };
    },
    [api, tenant, serviceId, run?.id, run?.finished, baselineId],
    { keepPreviousFor: run?.id },
  );
  const data = state.status === 'ready' ? state.data : undefined;
  const rows = data?.rows ?? [];
  const count = (which: CaseFilter) => rows.filter((r) => matches(which, r)).length;
  const filters: [CaseFilter, FilterKey][] = runningNow
    ? [
        ['all', 'qualityTabs.filterAll'],
        ['done', 'qualityTabs.filterDone'],
        ['running', 'qualityTabs.filterRunning'],
        ['waiting', 'qualityTabs.filterWaiting'],
      ]
    : [
        ['all', 'qualityTabs.filterAll'],
        ['failed', 'qualityTabs.filterFailed'],
        ['passed', 'qualityTabs.filterPassed'],
      ];
  const needle = query.trim().toLocaleLowerCase();
  const rank = (r: CaseRow) => (runningNow ? 0 : Number(r.result !== 'failed'));
  const shown = rows
    .filter((r) => matches(filter, r))
    .filter((r) => !needle || r.input.toLocaleLowerCase().includes(needle))
    .sort((a, b) => rank(a) - rank(b));
  const pages = Math.max(1, Math.ceil(shown.length / casesPerPage));
  const at = Math.min(page, pages - 1);
  const slice = shown.slice(at * casesPerPage, at * casesPerPage + casesPerPage);
  const baseline = data?.baseline;
  const columns = baseline !== undefined ? 5 : 4;

  return (
    <section aria-labelledby="q-cases" className="quality-section">
      <div className="row-between">
        <Heading level={2} data-size="xs" id="q-cases">
          {t(
            !runningNow
              ? 'qualityTabs.casesTitle'
              : run?.version === 'draft'
                ? 'qualityTabs.casesRunningTitle'
                : 'qualityTabs.casesRunningServiceTitle',
          )}
        </Heading>
        {run ? (
          <span className="meta">
            {runningNow
              ? t('qualityTabs.casesRunningMeta')
              : t('qualityTabs.casesMeta', {
                  version: versionTitle(t, run.version),
                  set: setName ?? run.testSet,
                })}
          </span>
        ) : null}
      </div>
      {!run ? (
        <Paragraph data-size="sm">{t('qualityTabs.noCases')}</Paragraph>
      ) : (
        <>
          <div className="q-case-tools">
            <div role="group" aria-label={t('qualityTabs.filterLabel')} className="tag-row">
              {filters.map(([value, label]) => (
                <Button
                  key={value}
                  className="q-chip"
                  variant={filter === value ? 'primary' : 'secondary'}
                  data-size="sm"
                  aria-pressed={filter === value}
                  onClick={() => {
                    setFilter(value);
                    setPage(0);
                  }}
                >
                  {t(label, { count: count(value) })}
                </Button>
              ))}
            </div>
            <Field className="q-case-search">
              <Label htmlFor="q-search" className="visually-hidden">
                {t('qualityTabs.searchLabel')}
              </Label>
              <Search>
                <Search.Input
                  id="q-search"
                  placeholder={t('qualityTabs.searchPlaceholder')}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(0);
                  }}
                />
              </Search>
            </Field>
          </div>
          {state.status === 'error' ? (
            <Alert data-color="danger" data-size="sm">
              {t('qualityTabs.casesFailed')}{' '}
              <Button variant="tertiary" data-size="sm" onClick={retry}>
                {t('qualityPage.retry')}
              </Button>
            </Alert>
          ) : null}
          <div tabIndex={0} role="region" aria-labelledby="q-cases" className="scroll-x">
            <Table data-size="sm" aria-busy={state.status === 'loading' || undefined}>
              <Table.Head>
                <Table.Row>
                  <Table.HeaderCell scope="col">{t('qualityTabs.colQuestion')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('qualityTabs.colCheckedOn')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('qualityTabs.colResult')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('qualityTabs.colReason')}</Table.HeaderCell>
                  {baseline !== undefined ? (
                    <Table.HeaderCell scope="col">{versionTitle(t, baseline)}</Table.HeaderCell>
                  ) : null}
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {!data
                  ? Array.from({ length: casesPerPage }, (_, i) => (
                      <Table.Row key={i}>
                        <Table.Cell colSpan={columns}>
                          <Skeleton variant="text" width={`${60 + ((i * 7) % 30)}%`} />
                        </Table.Cell>
                      </Table.Row>
                    ))
                  : slice.map((r) => {
                      const [key, color] = resultTags[r.result];
                      const task = data.tasks.get(r.id);
                      return (
                        <Table.Row key={r.id}>
                          <Table.Cell className="q-case-question">
                            {task ? (
                              <Link href={`#/log/${encodeURIComponent(task)}`}>{r.input}</Link>
                            ) : (
                              r.input
                            )}
                          </Table.Cell>
                          <Table.Cell className="meta nowrap">{typeText(t, r.type)}</Table.Cell>
                          <Table.Cell className="nowrap">
                            {r.result === 'running' ? (
                              <Skeleton variant="rectangle" width={72} height={20} />
                            ) : null}
                            <Tag
                              data-size="sm"
                              data-color={color}
                              className={r.result === 'running' ? 'visually-hidden' : undefined}
                            >
                              {t(key)}
                            </Tag>
                          </Table.Cell>
                          <Table.Cell className="meta q-case-reason">{r.reason ?? ''}</Table.Cell>
                          {baseline !== undefined ? (
                            <Table.Cell className="meta nowrap">
                              {r.before === undefined
                                ? '–'
                                : t(r.before ? 'qualityTabs.passed' : 'qualityTabs.failed')}
                            </Table.Cell>
                          ) : null}
                        </Table.Row>
                      );
                    })}
              </Table.Body>
            </Table>
          </div>
          {data ? (
            <nav aria-label={t('qualityTabs.pages')} className="row-between">
              <span className="meta">
                {shown.length
                  ? t(runningNow ? 'qualityTabs.pageTextRunning' : 'qualityTabs.pageText', {
                      from: f.number(at * casesPerPage + 1),
                      to: f.number(at * casesPerPage + slice.length),
                      total: f.number(shown.length),
                    })
                  : t('qualityTabs.noMatch')}
              </span>
              <span className="row-wrap">
                <Button
                  variant="secondary"
                  aria-disabled={at === 0 || undefined}
                  onClick={() => at > 0 && setPage(at - 1)}
                >
                  {t('qualityTabs.previous')}
                </Button>
                <Button
                  variant="secondary"
                  aria-disabled={at >= pages - 1 || undefined}
                  onClick={() => at < pages - 1 && setPage(at + 1)}
                >
                  {t('qualityTabs.next')}
                </Button>
              </span>
            </nav>
          ) : null}
        </>
      )}
    </section>
  );
};

const judgeKinds: Record<
  string,
  [PlainKey, 'qualityTabs.judgeExactMeta' | 'qualityTabs.judgeRefusalMeta' | undefined]
> = {
  'judge.criteria': ['qualityTabs.judgeCriteria', undefined],
  'exact-text': ['qualityTabs.judgeExact', 'qualityTabs.judgeExactMeta'],
  refusal: ['qualityTabs.judgeRefusal', 'qualityTabs.judgeRefusalMeta'],
};

const tail = (id: string) => id.slice(id.lastIndexOf('/') + 1);

const judgeModelLabel = (id: string, catalog: Pick<ModelOption, 'id' | 'name'>[]) =>
  catalog.some((m) => m.id === id)
    ? modelLabel(id, catalog)
    : (catalog.find((m) => tail(m.id) === tail(id))?.name ?? modelLabel(id, catalog));

const capitalized = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1);

export const JudgesCard = ({ api, run }: { api: ApiClient; run: EvalRun | undefined }) => {
  const { t, f } = usePortalFormat();
  const [models] = useAsync((signal) => api.models.catalog(signal).catch(() => []), [api]);
  const catalog = models.status === 'ready' ? models.data : [];
  const sink = new Set((run?.sinkJudges ?? []).map((j) => j.id));
  const genki = Object.entries(run?.metrics ?? {}).filter(
    ([metric]) => !sink.has(metric) && !metric.startsWith('langfuse:'),
  );
  const rows = [
    ...genki.map(([metric, m]) => {
      const [nameKey, metaKey] = judgeKinds[metric] ?? [undefined, undefined];
      const cases = t('qualityTabs.caseCount', { count: m.n });
      const id = metric.startsWith('judge.') ? metric.slice('judge.'.length) : undefined;
      const judge = id ? (run?.judges ?? []).find((j) => j.startsWith(`judge:${id}@`)) : undefined;
      const match = judge ? /^judge:([^@]+)@([^+]+)\+(.+)$/.exec(judge) : null;
      const meta = metaKey
        ? t(metaKey, { cases })
        : match
          ? t('qualityTabs.judgeGenki', {
              judge: `${id === 'criteria' ? t('qualityTabs.judgeCriteriaId') : match[1]}@${match[2]}`,
              model: modelLabel(match[3] ?? '', catalog),
              cases,
            })
          : cases;
      return {
        id: metric,
        name: nameKey ? t(nameKey) : metric,
        meta,
        share: f.percent(m.mean, 0),
      };
    }),
    ...(run?.sinkJudges ?? []).map((j) => {
      const [version, model] = j.version.replace(/^v/, '').split('+');
      const cases =
        j.metric && j.metric.n < j.of
          ? t('qualityTabs.caseCount', { count: j.metric.n })
          : t('qualityTabs.judgeAllCases');
      return {
        id: j.id,
        name: capitalized(j.name),
        meta: t('qualityTabs.judgeLangfuse', {
          judge: `${j.name}@${version ?? ''}`,
          model: judgeModelLabel(model ?? '', catalog),
          cases,
        }),
        share: j.metric ? t('qualityTabs.judgeMean', { mean: f.decimal(j.metric.mean, 2) }) : '–',
      };
    }),
  ];
  return (
    <section aria-labelledby="q-judges" className="q-card">
      <div className="row-between">
        <Heading level={2} data-size="xs" id="q-judges">
          {t('qualityTabs.judgesTitle')}
        </Heading>
        <Link href="#/developer/runs" data-size="sm">
          {t('qualityTabs.judgesLink')}
        </Link>
      </div>
      <Paragraph data-size="sm" className="meta">
        {rows.length ? t('qualityTabs.judgesLead') : t('qualityTabs.judgesNone')}
      </Paragraph>
      {rows.length ? (
        <ul className="plain-list q-judges">
          {rows.map((r) => (
            <li key={r.id}>
              <span className="q-judge-text">
                <strong>{r.name}</strong>
                <span className="meta">{r.meta}</span>
              </span>
              <span className="q-judge-share">{r.share}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
};

const changeKeys: Partial<Record<CaseChange, [PlainKey, Color]>> = {
  worse: ['qualityTabs.changeWorse', 'danger'],
  better: ['qualityTabs.changeBetter', 'success'],
};

export const CompareSection = ({
  api,
  tenant,
  serviceId,
  runs,
  publishedVersion,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  runs: EvalRun[];
  publishedVersion: number | undefined;
}) => {
  const { t, f } = usePortalFormat();
  const measured = measuredRun(runs);
  const comparable = completedRuns(runs).filter((r) => r.testSet === measured?.testSet);
  const [candidate, setCandidate] = useState<string>();
  const [baseline, setBaseline] = useState<string>();
  const live = comparable.find((r) => r.version === publishedVersion) ?? measured;
  const b =
    comparable.find((r) => r.id === candidate) ??
    comparable.find((r) => r.version === 'draft' && r.id !== live?.id) ??
    comparable.find((r) => r.id !== live?.id);
  const a =
    comparable.find((r) => r.id === baseline) ??
    (live && live.id !== b?.id ? live : undefined) ??
    comparable.find((r) => r.id !== b?.id);
  const [state, retry] = useAsync(
    async (signal): Promise<{ worse: EvalComparison; better: EvalComparison } | undefined> => {
      if (!a || !b) return undefined;
      const ask = (change: CaseChange) =>
        api.serviceTabs.compare(
          tenant,
          serviceId,
          { candidate: b.id, baseline: a.id, change, limit: compareShown },
          signal,
        );
      const [worse, better] = await Promise.all([ask('worse'), ask('better')]);
      return { worse, better };
    },
    [api, tenant, serviceId, b?.id, a?.id],
    { keepPreviousFor: `${b?.id}/${a?.id}` },
  );
  const label = (r: EvalRun) =>
    r.version === 'draft'
      ? t('qualityTabs.optionDraft', { when: whenText(t, f, ended(r)), score: percent(f, r.score) })
      : t(r.version === publishedVersion ? 'qualityTabs.optionLive' : 'qualityTabs.optionVersion', {
          version: versionTitle(t, r.version),
          score: percent(f, r.score),
        });
  const data = state.status === 'ready' ? state.data : undefined;
  const counts = data?.worse.counts;
  const listed = data ? [...data.worse.data, ...data.better.data] : [];
  return (
    <section aria-labelledby="q-cmp" className="q-card">
      <Heading level={2} data-size="xs" id="q-cmp">
        {t('qualityTabs.compareTitle')}
      </Heading>
      {comparable.length < 2 || !a || !b ? (
        <Paragraph data-size="sm">{t('qualityTabs.compareNeedsTwo')}</Paragraph>
      ) : (
        <>
          <div className="row-wrap align-end">
            <Field className="q-cmp-field">
              <Label htmlFor="q-a">A</Label>
              <Select id="q-a" value={a.id} onChange={(e) => setBaseline(e.target.value)}>
                {comparable
                  .filter((r) => r.id !== b.id)
                  .map((r) => (
                    <Select.Option key={r.id} value={r.id}>
                      {label(r)}
                    </Select.Option>
                  ))}
              </Select>
            </Field>
            <Field className="q-cmp-field">
              <Label htmlFor="q-b">B</Label>
              <Select id="q-b" value={b.id} onChange={(e) => setCandidate(e.target.value)}>
                {comparable
                  .filter((r) => r.id !== a.id)
                  .map((r) => (
                    <Select.Option key={r.id} value={r.id}>
                      {label(r)}
                    </Select.Option>
                  ))}
              </Select>
            </Field>
          </div>
          {state.status === 'error' ? (
            <Alert data-color="danger" data-size="sm">
              {t('qualityTabs.compareFailed')}{' '}
              <Button variant="tertiary" data-size="sm" onClick={retry}>
                {t('qualityPage.retry')}
              </Button>
            </Alert>
          ) : (
            <>
              <dl className="q-cmp-counts" aria-busy={!data || undefined}>
                {(['better', 'same', 'worse'] as const).map((c) => (
                  <div key={c} data-change={c}>
                    <dd>
                      {counts ? f.number(counts[c] ?? 0) : <Skeleton variant="text" width="2em" />}
                    </dd>
                    <dt>{t(`qualityTabs.count_${c}`)}</dt>
                  </div>
                ))}
              </dl>
              {data ? (
                <ul className="plain-list q-cmp-cases">
                  {listed.length === 0 ? (
                    <li className="meta">{t('qualityTabs.compareNone')}</li>
                  ) : (
                    listed.map((c) => {
                      const [key, color] = changeKeys[c.change] ?? [
                        'qualityTabs.changeWorse',
                        'danger',
                      ];
                      return (
                        <li key={c.case}>
                          <Tag data-size="sm" data-color={color}>
                            {t(key)}
                          </Tag>
                          <span>
                            «{c.input}»{c.candidate?.reason ? ` ${c.candidate.reason}` : ''}
                          </span>
                        </li>
                      );
                    })
                  )}
                </ul>
              ) : null}
            </>
          )}
          <Link
            href={`#${
              a?.version === 'draft' || b?.version === 'draft'
                ? servicePath(serviceId, 'setup', '/publish')
                : servicePath(serviceId, 'versions')
            }`}
          >
            {t('qualityTabs.seeSetupDiff')}
          </Link>
        </>
      )}
    </section>
  );
};

const ghostBars = [3, 4, 4, 5, 4, 3, 5, 6, 5, 4, 5, 5, 6, 5, 4, 6, 5, 6, 6, 5];

export const LiveQualityComing = () => {
  const { t } = usePortalFormat();
  return (
    <section aria-labelledby="q-live" className="q-coming">
      <div className="row-wrap">
        <Heading level={2} data-size="xs" id="q-live">
          {t('qualityTabs.liveTitle')}
        </Heading>
        <Tag data-size="sm" data-color="neutral">
          {t('qualityTabs.coming')}
        </Tag>
      </div>
      <Paragraph data-size="sm" className="q-coming-text">
        {t('qualityTabs.liveText')}
      </Paragraph>
      <div className="q-ghost" aria-hidden="true">
        {ghostBars.map((h, i) => (
          <span key={i} style={{ height: `${h * 7}px` }} />
        ))}
      </div>
    </section>
  );
};
