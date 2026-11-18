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
import type { ApiClient } from '../../api';
import type { EvalRun, ServiceTestSet } from '../../api/quality';
import type { CaseChange, ComparedCase } from '../../api/service-tabs';
import { usePortalFormat } from '../../format';
import { useAsync } from '../../hooks';
import type { PlainKey, T } from '../../i18n';
import { needsRight, useRights } from '../../Shell';
import type { ConfigEntry } from '../../api';
import { servicePath } from '../service/sections';
import { active, RunEstimate } from './RunHistory';

const casesPerPage = 8;
const comparePage = 200;

type Color = 'success' | 'danger' | 'warning' | 'info' | 'neutral';

const ended = (r: EvalRun) => r.endedAt ?? r.startedAt;

export const completedRuns = (runs: EvalRun[]) =>
  runs
    .filter((r) => r.status === 'completed' && typeof r.score === 'number')
    .sort((a, b) => ended(b).localeCompare(ended(a)));

const typeKeys: Record<string, PlainKey> = {
  criteria: 'qualityTabs.typeCriteria',
  exact: 'qualityTabs.typeExact',
  must_reject: 'qualityTabs.typeReject',
};

const typeText = (t: T, type: string) => (typeKeys[type] ? t(typeKeys[type]) : type);

const versionLabel = (t: T, v: EvalRun['version']) =>
  v === 'draft'
    ? t('qualityTabs.draft')
    : v === 'published'
      ? t('qualityTabs.published')
      : t('qualityTabs.versionN', { n: v });

const percent = (f: ReturnType<typeof usePortalFormat>['f'], n: number | null | undefined) =>
  typeof n === 'number' ? f.percent(n, 0) : '–';

const RunConfirm = ({
  api,
  tenant,
  serviceId,
  set,
  runs,
  onRun,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  set: ServiceTestSet;
  runs: EvalRun[];
  onRun: () => void;
}) => {
  const { t } = usePortalFormat();
  const [open, setOpen] = useState(false);
  const canManage = useRights().has('manage-services');
  if (!canManage) return <span className="meta">{needsRight('manage-services', t)}</span>;
  if (!open)
    return (
      <Button variant="primary" data-size="sm" aria-expanded={false} onClick={() => setOpen(true)}>
        {t('qualityTabs.testAgain')}
      </Button>
    );
  return (
    <Alert data-color="info" data-size="sm" className="quality-confirm">
      <Heading level={3} data-size="2xs">
        {t('quality.confirmRunTitle', { count: set.cases })}
      </Heading>
      <RunEstimate
        api={api}
        tenant={tenant}
        serviceId={serviceId}
        runs={runs.filter((r) => r.testSet === set.id)}
        cases={set.cases}
      />
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
  );
};

export const QualityNow = ({
  api,
  tenant,
  serviceId,
  sets,
  runs,
  hasDraft,
  onRun,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  sets: ServiceTestSet[];
  runs: EvalRun[];
  hasDraft: boolean;
  onRun: (set: ServiceTestSet) => void;
}) => {
  const { t, f, dateTime } = usePortalFormat();
  const done = completedRuns(runs);
  const latest = done[0];
  const set = sets.find((s) => s.id === latest?.testSet) ?? sets[0];
  const same = done.filter((r) => r.testSet === latest?.testSet && typeof r.version === 'number');
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
              when: dateTime(ended(latest)),
            })}
          </span>
        ) : null}
      </div>
      {latest ? (
        <div className="q-now">
          <div className="stack-xs">
            <span className="q-score">{percent(f, latest.score)}</span>
            <span className="meta">
              {t('qualityTabs.passedOf', {
                passed: latest.passed ?? 0,
                total: latest.total ?? 0,
                version: versionLabel(t, latest.version),
              })}
            </span>
            {previous ? (
              <span className={delta >= 0 ? 'success-text' : 'danger-text'}>
                {t(delta >= 0 ? 'qualityTabs.upFrom' : 'qualityTabs.downFrom', {
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
                    <span className="q-trend-fill" style={{ height: `${Math.max(4, s * 70)}px` }} />
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
      {set ? (
        <div className="q-card-foot">
          <RunConfirm
            api={api}
            tenant={tenant}
            serviceId={serviceId}
            set={set}
            runs={runs}
            onRun={() => onRun(set)}
          />
          <span className="meta">
            {t(hasDraft ? 'qualityTabs.runsDraft' : 'qualityTabs.runsPublished', {
              count: set.cases,
            })}
          </span>
        </div>
      ) : null}
    </section>
  );
};

export const RunningCard = ({
  api,
  tenant,
  serviceId,
  run,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  run: EvalRun;
}) => {
  const { t, f } = usePortalFormat();
  const total = run.total ?? 0;
  const finished = run.finished ?? 0;
  const [compared] = useAsync(
    (signal) =>
      api.serviceTabs.compare(tenant, serviceId, { candidate: run.id, limit: comparePage }, signal),
    [api, tenant, serviceId, run.id, finished],
  );
  const cases = compared.status === 'ready' ? compared.data.data : [];
  const scored = cases.filter((c) => c.candidate);
  const passed = scored.filter((c) => c.candidate?.pass).length;
  const before = scored.filter((c) => c.baseline?.pass).length;
  return (
    <section aria-labelledby="q-run" aria-live="polite" className="q-card q-card-running">
      <div className="row-between">
        <Heading level={2} data-size="xs" id="q-run">
          {t(run.version === 'draft' ? 'qualityTabs.testingDraft' : 'qualityTabs.testingService')}
        </Heading>
        <span className="meta">{t('qualityTabs.startedAt', { time: f.time(run.startedAt) })}</span>
      </div>
      <div className="stack-xs">
        <div className="row-between">
          <strong>{t('qualityTabs.doneOf', { done: finished, total })}</strong>
          {run.endsAt ? (
            <span className="meta">{t('qualityTabs.endsAt', { time: f.time(run.endsAt) })}</span>
          ) : null}
        </div>
        <progress max={total || 1} value={finished} aria-label={t('qualityTabs.progress')} />
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
                version: versionLabel(t, compared.data.baseline.version),
              })}
            </dt>
            <dd>{t('qualityTabs.nOfM', { n: before, m: scored.length })}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t('qualityTabs.runningNow')}</dt>
          <dd>{t('qualityTabs.casesCount', { count: run.current?.length ?? 0 })}</dd>
        </div>
      </dl>
      <p className="meta q-card-foot">{t('qualityTabs.canLeave')}</p>
    </section>
  );
};

const gateText = (t: T, spec: Record<string, unknown>) => {
  const metric = typeof spec.metric === 'string' ? spec.metric : '';
  return spec.kind === 'threshold'
    ? t('qualityTabs.gateAtLeast', {
        metric,
        threshold: Math.round(Number(spec.threshold ?? 0) * 100),
      })
    : t('qualityTabs.gateNoRegression', {
        metric,
        points: Math.round(Number(spec.maxRegression ?? 0) * 100),
      });
};

type GateState = 'passes' | 'stops' | 'unchecked';

const gateTags: Record<GateState, [PlainKey, Color]> = {
  passes: ['qualityTabs.gatePasses', 'success'],
  stops: ['qualityTabs.gateStops', 'danger'],
  unchecked: ['qualityTabs.gateUnchecked', 'neutral'],
};

export const GatesCard = ({
  api,
  tenant,
  serviceId,
  draft,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  draft: { definition: Record<string, unknown>; revision: number } | undefined;
}) => {
  const { t } = usePortalFormat();
  const listed =
    (draft?.definition.spec as { evaluation?: { gates?: string[] } } | undefined)?.evaluation
      ?.gates ?? [];
  const [state] = useAsync(
    async (signal) => {
      const [gates, checks] = await Promise.all([
        api.configList(`/tenants/${encodeURIComponent(tenant)}/gates`, signal),
        draft
          ? api.serviceTabs.draftChecks(tenant, serviceId, signal).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      return { gates: gates.data, checks };
    },
    [api, tenant, serviceId, draft?.revision],
  );
  const stateOf = (gate: ConfigEntry): GateState => {
    if (state.status !== 'ready' || !state.data.checks) return 'unchecked';
    const { checks } = state.data;
    if (checks.ready) return 'passes';
    const refused = checks.problems.filter((p) => p.path.startsWith('spec.evaluation'));
    if (refused.some((p) => p.message.includes(gate.id))) return 'stops';
    return refused.length || checks.problems.length ? 'unchecked' : 'passes';
  };
  const gates =
    state.status === 'ready'
      ? state.data.gates.filter((g) => g.mandatory || listed.includes(g.id))
      : [];
  return (
    <section
      aria-labelledby="q-gates"
      aria-busy={state.status === 'loading' || undefined}
      className="q-card"
    >
      <div className="row-between">
        <Heading level={2} data-size="xs" id="q-gates">
          {t('qualityTabs.gatesTitle')}
        </Heading>
        <Link href={`#${servicePath(serviceId, 'quality', '?view=gates')}`}>
          {t('qualityTabs.editGates')}
        </Link>
      </div>
      <Paragraph data-size="sm">
        {draft ? t('qualityTabs.gatesLead') : t('qualityTabs.gatesNoDraft')}
      </Paragraph>
      {state.status === 'loading' ? (
        <div className="stack-sm">
          <Skeleton variant="text" width="80%" />
          <Skeleton variant="text" width="70%" />
          <Skeleton variant="text" width="75%" />
        </div>
      ) : state.status === 'error' ? (
        <Paragraph data-size="sm">{t('serviceOverview.notAvailable')}</Paragraph>
      ) : gates.length === 0 ? (
        <Paragraph data-size="sm">{t('qualityTabs.noGates')}</Paragraph>
      ) : (
        <ul className="plain-list q-gates">
          {gates.map((g) => {
            const [key, color] = gateTags[stateOf(g)];
            return (
              <li key={g.id}>
                <span className="stack-xs">
                  <strong>{g.id}</strong>
                  <span className="meta">
                    {gateText(t, g.spec)}
                    {g.mandatory ? ` ${t('qualityTabs.gateMandatory')}` : ''}
                  </span>
                </span>
                <Tag data-size="sm" data-color={color}>
                  {t(key)}
                </Tag>
              </li>
            );
          })}
        </ul>
      )}
      {state.status === 'ready' && state.data.checks?.hooksSkipped ? (
        <Paragraph data-size="sm" className="meta">
          {t('qualityTabs.hooksSkipped')}
        </Paragraph>
      ) : null}
    </section>
  );
};

type CaseFilter = 'all' | 'failed' | 'passed' | 'done' | 'running' | 'waiting';

interface CaseRow {
  id: string;
  input: string;
  type: string | undefined;
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

export const CasesSection = ({
  api,
  tenant,
  serviceId,
  run,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  run: EvalRun | undefined;
}) => {
  const { t, f } = usePortalFormat();
  const [filter, setFilter] = useState<CaseFilter>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const runningNow = run ? active(run) : false;
  const [state, retry] = useAsync(
    async (signal) => {
      if (!run) return undefined;
      const current = new Set((run.current ?? []).map((c) => c.case));
      try {
        const compared = await api.serviceTabs.compare(
          tenant,
          serviceId,
          { candidate: run.id, limit: comparePage },
          signal,
        );
        return {
          rows: rowsFromCompare(compared.data, current),
          baseline: compared.baseline.version,
        };
      } catch {
        const detail = await api.quality.run(tenant, run.id, signal);
        return {
          rows: detail.cases.map((c): CaseRow => ({
            id: c.caseId,
            input: c.input,
            type: undefined,
            result: c.pass ? 'passed' : 'failed',
            reason: c.reason,
            before: undefined,
          })),
          baseline: undefined,
        };
      }
    },
    [api, tenant, serviceId, run?.id, run?.finished],
    { keepPreviousFor: run?.id },
  );
  const data = state.status === 'ready' ? state.data : undefined;
  const rows = data?.rows ?? [];
  const count = (which: CaseFilter) =>
    which === 'all'
      ? rows.length
      : which === 'done'
        ? rows.filter((r) => r.result === 'passed' || r.result === 'failed').length
        : rows.filter((r) => r.result === which).length;
  const filters: [CaseFilter, PlainKey][] = runningNow
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
  const shown = rows
    .filter((r) =>
      filter === 'all'
        ? true
        : filter === 'done'
          ? r.result === 'passed' || r.result === 'failed'
          : r.result === filter,
    )
    .filter((r) => !needle || r.input.toLocaleLowerCase().includes(needle))
    .sort((a, b) => Number(b.result === 'failed') - Number(a.result === 'failed'));
  const pages = Math.max(1, Math.ceil(shown.length / casesPerPage));
  const at = Math.min(page, pages - 1);
  const slice = shown.slice(at * casesPerPage, at * casesPerPage + casesPerPage);
  const hasType = rows.some((r) => r.type);
  const baseline = data?.baseline;

  return (
    <section aria-labelledby="q-cases" className="quality-section">
      <div className="row-between">
        <Heading level={2} data-size="sm" id="q-cases">
          {t(runningNow ? 'qualityTabs.casesRunningTitle' : 'qualityTabs.casesTitle')}
        </Heading>
        {run ? (
          <span className="meta">
            {t(runningNow ? 'qualityTabs.casesRunningMeta' : 'qualityTabs.casesMeta', {
              version: versionLabel(t, run.version),
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
                  variant={filter === value ? 'primary' : 'secondary'}
                  data-size="sm"
                  aria-pressed={filter === value}
                  onClick={() => {
                    setFilter(value);
                    setPage(0);
                  }}
                >
                  {t(label)}
                  {data ? ` (${f.number(count(value))})` : ''}
                </Button>
              ))}
            </div>
            <Field className="q-case-search">
              <Label className="visually-hidden">{t('qualityTabs.searchLabel')}</Label>
              <Search>
                <Search.Input
                  aria-label={t('qualityTabs.searchLabel')}
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
                  {hasType ? (
                    <Table.HeaderCell scope="col">{t('qualityTabs.colCheckedOn')}</Table.HeaderCell>
                  ) : null}
                  <Table.HeaderCell scope="col">{t('qualityTabs.colResult')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('qualityTabs.colReason')}</Table.HeaderCell>
                  {baseline !== undefined ? (
                    <Table.HeaderCell scope="col">{versionLabel(t, baseline)}</Table.HeaderCell>
                  ) : null}
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {!data
                  ? Array.from({ length: casesPerPage }, (_, i) => (
                      <Table.Row key={i}>
                        <Table.Cell colSpan={4}>
                          <Skeleton variant="text" width={`${60 + ((i * 7) % 30)}%`} />
                        </Table.Cell>
                      </Table.Row>
                    ))
                  : slice.map((r) => {
                      const [key, color] = resultTags[r.result];
                      return (
                        <Table.Row key={r.id}>
                          <Table.Cell>{r.input}</Table.Cell>
                          {hasType ? (
                            <Table.Cell className="meta nowrap">
                              {r.type ? typeText(t, r.type) : ''}
                            </Table.Cell>
                          ) : null}
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
                          <Table.Cell className="meta">{r.reason ?? ''}</Table.Cell>
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
                  ? t('qualityTabs.pageText', {
                      from: f.number(at * casesPerPage + 1),
                      to: f.number(at * casesPerPage + slice.length),
                      total: f.number(shown.length),
                    })
                  : t('qualityTabs.noMatch')}
              </span>
              <span className="row-wrap">
                <Button
                  variant="secondary"
                  data-size="sm"
                  aria-disabled={at === 0 || undefined}
                  onClick={() => at > 0 && setPage(at - 1)}
                >
                  {t('qualityTabs.previous')}
                </Button>
                <Button
                  variant="secondary"
                  data-size="sm"
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

const changeKeys: Record<CaseChange, [PlainKey, Color]> = {
  worse: ['qualityTabs.changeWorse', 'danger'],
  better: ['qualityTabs.changeBetter', 'success'],
  new: ['qualityTabs.changeNew', 'info'],
  missing: ['qualityTabs.changeMissing', 'warning'],
  pending: ['qualityTabs.changePending', 'neutral'],
  same: ['qualityTabs.changeSame', 'neutral'],
};

const shownChanges: CaseChange[] = ['worse', 'better', 'new', 'missing', 'pending'];

export const CompareSection = ({
  api,
  tenant,
  serviceId,
  runs,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  runs: EvalRun[];
}) => {
  const { t, f, dateTime } = usePortalFormat();
  const done = completedRuns(runs);
  const latest = done[0];
  const comparable = done.filter((r) => r.testSet === latest?.testSet);
  const [candidate, setCandidate] = useState<string>();
  const [baseline, setBaseline] = useState<string>();
  const [change, setChange] = useState<CaseChange>('worse');
  const b = comparable.find((r) => r.id === candidate) ?? latest;
  const a =
    comparable.find((r) => r.id === baseline) ??
    comparable.find((r) => r.id !== b?.id && r.version !== b?.version) ??
    comparable.find((r) => r.id !== b?.id);
  const [state, retry] = useAsync(
    async (signal) =>
      b && a
        ? api.serviceTabs.compare(
            tenant,
            serviceId,
            { candidate: b.id, baseline: a.id, change, limit: 5 },
            signal,
          )
        : undefined,
    [api, tenant, serviceId, b?.id, a?.id, change],
    { keepPreviousFor: `${b?.id}/${a?.id}` },
  );
  const label = (r: EvalRun) =>
    t('qualityTabs.runOption', {
      version: versionLabel(t, r.version),
      when: dateTime(ended(r)),
      score: percent(f, r.score),
    });
  const data = state.status === 'ready' ? state.data : undefined;
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
            <Alert data-color="warning" data-size="sm">
              {t('qualityTabs.compareUnavailable')}{' '}
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
                      {data ? (
                        f.number(data.counts[c] ?? 0)
                      ) : (
                        <Skeleton variant="text" width="2em" />
                      )}
                    </dd>
                    <dt>{t(`qualityTabs.count_${c}`)}</dt>
                  </div>
                ))}
              </dl>
              <div role="group" aria-label={t('qualityTabs.changeLabel')} className="tag-row">
                {shownChanges.map((c) => (
                  <Button
                    key={c}
                    variant={change === c ? 'primary' : 'secondary'}
                    data-size="sm"
                    aria-pressed={change === c}
                    onClick={() => setChange(c)}
                  >
                    {t(changeKeys[c][0])} {data ? `(${f.number(data.counts[c] ?? 0)})` : ''}
                  </Button>
                ))}
              </div>
              <ul
                className="plain-list q-cmp-cases"
                aria-busy={state.status === 'loading' || undefined}
              >
                {data?.data.length === 0 ? (
                  <li className="meta">{t('qualityTabs.compareNone')}</li>
                ) : (
                  data?.data.map((c) => {
                    const [key, color] = changeKeys[c.change];
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
              {data && data.total > data.data.length ? (
                <span className="meta">
                  {t('qualityTabs.compareMore', { count: data.total - data.data.length })}
                </span>
              ) : null}
            </>
          )}
          <Link href={`#${servicePath(serviceId, 'versions')}`}>
            {t('qualityTabs.seeSetupDiff')}
          </Link>
        </>
      )}
    </section>
  );
};

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
      <Paragraph data-size="sm">{t('qualityTabs.liveText')}</Paragraph>
    </section>
  );
};
