import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Fieldset,
  Heading,
  Link,
  Paragraph,
  Table,
  Tag,
} from '@digdir/designsystemet-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api';
import type {
  CaseJudgement,
  EvalRun,
  RunSending,
  RunVersion,
  ServiceTestSet,
} from '../../api/quality';
import { storageLabels } from '../../data/building-blocks';
import { formatKroner, usePortalFormat } from '../../format';
import { useAsync } from '../../hooks';
import type { Format, PlainKey, T } from '../../i18n';
import { needsRight, useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import { problemTitle, type SetFlash } from './shared';

const pollMs = 2000;

const versionText = (t: T, v: RunVersion) =>
  v === 'draft'
    ? t('quality.versionDraft')
    : v === 'published'
      ? t('quality.versionPublished')
      : t('quality.versionN', { version: v });

const statusTag = (t: T, r: EvalRun): [string, 'success' | 'danger' | 'info' | 'neutral'] =>
  r.status === 'completed'
    ? [t('quality.runDone'), 'success']
    : r.status === 'failed'
      ? [t('quality.runFailed'), 'danger']
      : r.status === 'interrupted'
        ? [t('quality.runInterrupted'), 'danger']
        : r.status === 'waiting-for-scores'
          ? [t('quality.runWaiting'), 'info']
          : r.status === 'running'
            ? [t('quality.runRunning'), 'info']
            : [r.status, 'neutral'];

const percent = (f: Format, score: number | null | undefined) =>
  typeof score === 'number' ? f.percent(score) : '–';

const passedText = (t: T, r: EvalRun) =>
  typeof r.passed === 'number' && typeof r.total === 'number'
    ? t('quality.passedOf', { passed: r.passed, total: r.total })
    : '–';

const costText = (t: T, f: Format, cost: number | null | undefined) =>
  typeof cost === 'number' ? formatKroner(cost, f, t) : t('quality.notPricedLower');

const active = (r: EvalRun) => r.status === 'running' || r.status === 'waiting-for-scores';

const metricKeys: Record<string, PlainKey> = {
  'exact-text': 'quality.metricExactText',
  'non-empty-answer': 'quality.metricNonEmpty',
  refusal: 'quality.metricRefusal',
  'judge.criteria': 'quality.metricCriteria',
  'answer-pattern': 'quality.metricAnswerPattern',
};

const metricLabel = (t: T, metric: string) => {
  const key = metricKeys[metric];
  return key ? t(key) : metric;
};

/** What a judge left unscored, said from the counts so it reads in the person's language. */
const incompleteText = (t: T, i: NonNullable<EvalRun['incomplete']>[number]) =>
  i.of === undefined
    ? i.reason
    : [
        ...(i.missing
          ? [t('quality.runMissing', { judge: i.evaluator, count: i.missing, of: i.of })]
          : []),
        ...(i.failed
          ? [t('quality.runJudgeFailed', { judge: i.evaluator, count: i.failed, of: i.of })]
          : []),
      ].join(' ');

/** A Langfuse judge's name on a case: its rule, as the run's summary names it. */
const sinkJudgeName = (run: EvalRun, judge: string) =>
  run.sinkJudges?.find((j) => j.id === judge)?.name ?? judge.slice(judge.indexOf('/') + 1);

const verdictText = (t: T, f: Format, j: CaseJudgement) => {
  if (j.state === 'not-applicable') return t('quality.verdictNotApplicable');
  if (j.state === 'pending') return t('quality.verdictPending');
  if (j.state === 'missing') return t('quality.verdictMissing');
  if (j.state === 'failed') return t('quality.verdictFailed');
  if (j.asItCame !== undefined) return String(j.asItCame);
  if (j.dataType === 'BOOLEAN')
    return t(j.value === 1 ? 'quality.verdictYes' : 'quality.verdictNo');
  return j.value === null ? '' : f.percent(j.value);
};

/** Langfuse judges are advisory: shown apart from genki's metrics and never in a gate. */
const SinkJudges = ({ run }: { run: EvalRun }) => {
  const { t, f } = usePortalFormat();
  const judges = run.sinkJudges ?? [];
  if (judges.length === 0) return null;
  return (
    <section aria-labelledby="sink-judges-h" className="stack-sm">
      <Heading level={4} data-size="2xs" id="sink-judges-h">
        {t('quality.sinkJudgesTitle')}
      </Heading>
      <Paragraph data-size="sm">{t('quality.sinkJudgesAdvisory')}</Paragraph>
      {judges.map((j) => (
        <div key={j.id} className="stack-xs">
          <Heading level={5} data-size="2xs">
            {j.name}
          </Heading>
          {j.metric ? (
            <Paragraph data-size="sm">
              {t(j.dataType === 'BOOLEAN' ? 'quality.sinkJudgeYes' : 'quality.sinkJudgeMean', {
                mean: f.percent(j.metric.mean),
                low: f.percent(j.metric.ci[0]),
                high: f.percent(j.metric.ci[1]),
                n: j.metric.n,
              })}
            </Paragraph>
          ) : null}
          {j.categories ? (
            <Paragraph data-size="sm">
              {t('quality.sinkJudgeCategories', {
                categories: Object.entries(j.categories)
                  .map(([answer, count]) => `${answer}: ${count}`)
                  .join(', '),
              })}
            </Paragraph>
          ) : null}
          {j.notApplicable > 0 ? (
            <Paragraph data-size="sm">
              {t('quality.sinkJudgeNotApplicable', { count: j.notApplicable })}
            </Paragraph>
          ) : null}
          {j.missing > 0 ? (
            <Paragraph data-size="sm" className="danger-text">
              {t('quality.runMissing', { judge: j.name, count: j.missing, of: j.of })}
            </Paragraph>
          ) : null}
          {j.failed > 0 ? (
            <Paragraph data-size="sm" className="danger-text">
              {t('quality.runJudgeFailed', { judge: j.name, count: j.failed, of: j.of })}
            </Paragraph>
          ) : null}
          {j.changed.length > 0 ? (
            <Paragraph data-size="sm">{t('quality.sinkJudgeChanged')}</Paragraph>
          ) : null}
        </div>
      ))}
      {run.experiment ? (
        <Paragraph data-size="sm">
          <Link href={run.experiment} target="_blank" rel="noreferrer">
            {t('quality.sinkJudgeExperiment')}
          </Link>
        </Paragraph>
      ) : null}
    </section>
  );
};

const RunMetrics = ({ run }: { run: EvalRun }) => {
  const { t, f } = usePortalFormat();
  const sink = new Set((run.sinkJudges ?? []).map((j) => j.id));
  const metrics = Object.entries(run.metrics ?? {}).filter(([m]) => !sink.has(m));
  const judges = (run.judges ?? []).filter((j) => !j.startsWith('langfuse:'));
  if (metrics.length === 0) return null;
  return (
    <>
      <Heading level={4} data-size="2xs">
        {t('quality.runMetrics')}
      </Heading>
      {judges.length ? (
        <Paragraph data-size="sm">
          {t('quality.runJudges', { judges: judges.join(', ') })}
        </Paragraph>
      ) : null}
      {(run.incomplete ?? [])
        .filter((i) => !sink.has(i.evaluator))
        .map((i) => (
          <Paragraph key={i.evaluator} data-size="sm" className="danger-text">
            {incompleteText(t, i)}
          </Paragraph>
        ))}
      <Table data-size="sm" zebra>
        <Table.Head>
          <Table.Row>
            <Table.HeaderCell scope="col">{t('quality.runMetric')}</Table.HeaderCell>
            <Table.HeaderCell scope="col">{t('quality.runMean')}</Table.HeaderCell>
            <Table.HeaderCell scope="col">{t('quality.runInterval')}</Table.HeaderCell>
            <Table.HeaderCell scope="col">{t('quality.runCases')}</Table.HeaderCell>
          </Table.Row>
        </Table.Head>
        <Table.Body>
          {metrics.map(([metric, m]) => (
            <Table.Row key={metric}>
              <Table.Cell>{metricLabel(t, metric)}</Table.Cell>
              <Table.Cell>{f.percent(m.mean)}</Table.Cell>
              <Table.Cell>
                {f.percent(m.ci[0])} – {f.percent(m.ci[1])}
              </Table.Cell>
              <Table.Cell>{m.n}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </>
  );
};

/** Why a run that a Langfuse judge scores cannot start, before it is started. */
const sendingRefusal = (t: T, plan: RunSending | undefined, judges: string) => {
  const refused = plan?.refused;
  if (!refused) return undefined;
  if (refused.reason === 'covered-twice')
    return t('quality.judgeCoveredTwice', { judges, connections: refused.connections.join(', ') });
  return t('quality.judgeResidencyRefused', {
    connection: plan.connection?.id ?? '',
    judges,
    where: t(storageLabels[refused.connection]),
    service: t(storageLabels[refused.service]),
  });
};

const usageDays = 30;

const perCaseFromRuns = (runs: EvalRun[]) => {
  const priced = runs.filter(
    (r) => !active(r) && typeof r.cost === 'number' && typeof r.total === 'number' && r.total > 0,
  );
  const cases = priced.reduce((n, r) => n + (r.total ?? 0), 0);
  return cases > 0 ? priced.reduce((n, r) => n + (r.cost ?? 0), 0) / cases : undefined;
};

const RunEstimate = ({
  api,
  tenant,
  serviceId,
  runs,
  cases,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  runs: EvalRun[];
  cases: number;
}) => {
  const { t, f } = usePortalFormat();
  const fromRuns = perCaseFromRuns(runs);
  const canSeeUsage = useRights().has('view-usage');
  const [usage] = useAsync(
    async (signal) => {
      if (fromRuns !== undefined || !canSeeUsage) return undefined;
      const report = await api.usage(tenant, usageDays, signal).catch(() => undefined);
      const own = report?.byService.find((s) => s.service === serviceId)?.usage;
      const count = own?.runs ?? own?.requests ?? 0;
      return own && typeof own.costMicroNok === 'number' && count > 0
        ? own.costMicroNok / count
        : undefined;
    },
    [api, tenant, serviceId, fromRuns, canSeeUsage],
  );
  if (fromRuns === undefined && usage.status === 'loading')
    return <Loading label={t('quality.estimateLoading')} />;
  const perCase = fromRuns ?? (usage.status === 'ready' ? usage.data : undefined);
  if (perCase === undefined)
    return <Paragraph data-size="sm">{t('quality.estimateUnknown', { count: cases })}</Paragraph>;
  return (
    <Paragraph data-size="sm">
      {t(fromRuns === undefined ? 'quality.estimateFromUsage' : 'quality.estimateFromRuns', {
        cost: formatKroner(perCase * cases, f, t),
        count: cases,
        days: usageDays,
      })}
    </Paragraph>
  );
};

const RunDetail = ({
  api,
  tenant,
  runId,
  onClose,
}: {
  api: ApiClient;
  tenant: string;
  runId: string;
  onClose: () => void;
}) => {
  const { t, f } = usePortalFormat();
  const [state, retry] = useAsync(
    (signal) => api.quality.run(tenant, runId, signal),
    [api, tenant, runId],
  );
  return (
    <section aria-labelledby="run-detail-h" className="quality-panel">
      <div className="row-between">
        <Heading level={3} data-size="xs" id="run-detail-h">
          {t('quality.resultPerCase')}
        </Heading>
        <Button variant="tertiary" data-size="sm" onClick={onClose}>
          {t('quality.close')}
        </Button>
      </div>
      {state.status === 'loading' ? (
        <Loading label={t('quality.runLoading')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} headingLevel={4} />
      ) : state.data.cases.length === 0 ? (
        <Paragraph data-size="sm" className={state.data.error ? 'danger-text' : undefined}>
          {state.data.error
            ? t('quality.runStopped', { error: state.data.error })
            : t('quality.runNoResults')}
        </Paragraph>
      ) : (
        <>
          <RunMetrics run={state.data} />
          <SinkJudges run={state.data} />
          <ul className="live-case-list">
            {state.data.cases.map((c) => (
              <li key={c.caseId}>
                <dl className="case-detail run-case">
                  <dt>{t('quality.input')}</dt>
                  <dd>{c.input}</dd>
                  <dt>{t('quality.goodAnswer')}</dt>
                  <dd>{c.expected}</dd>
                  <dt>{t('quality.theAnswer')}</dt>
                  <dd>{c.output}</dd>
                  <dt>{t('quality.result')}</dt>
                  <dd>
                    <Tag data-size="sm" data-color={c.pass ? 'success' : 'danger'}>
                      {t(c.pass ? 'quality.passed' : 'quality.notPassed')}
                    </Tag>
                  </dd>
                  {c.reason ? (
                    <>
                      <dt>{t('quality.reasoning')}</dt>
                      <dd className={c.pass ? undefined : 'danger-text'}>{c.reason}</dd>
                    </>
                  ) : null}
                  {(c.judges ?? []).map((j) => (
                    <Fragment key={j.judge}>
                      <dt>
                        {t('quality.sinkJudgeOnCase', { name: sinkJudgeName(state.data, j.judge) })}
                      </dt>
                      <dd>
                        <strong>{verdictText(t, f, j)}</strong>
                        {j.state === 'scored' && j.reason ? (
                          <>
                            {' '}
                            <span>{j.reason}</span>
                          </>
                        ) : null}
                      </dd>
                    </Fragment>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
};

export const RunHistory = ({
  api,
  tenant,
  serviceId,
  testSet,
  cases,
  setFlash,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  testSet: ServiceTestSet;
  cases: number;
  setFlash: SetFlash;
}) => {
  const { t, f, dateTime } = usePortalFormat();
  const canManage = useRights().has('manage-services');
  const canRun = canManage && cases > 0;
  const [confirming, setConfirming] = useState(false);
  const [round, setRound] = useState(0);
  const [version, setVersion] = useState<'draft' | 'published'>('draft');
  const [starting, setStarting] = useState(false);
  const [trace, setTrace] = useState(false);
  const [sinks] = useAsync(
    (signal) => api.tracing.list(tenant, signal).catch(() => []),
    [api, tenant],
  );
  const sink =
    sinks.status === 'ready'
      ? sinks.data.find((c) => !c.removing && c.services.includes(serviceId))
      : undefined;
  // A service that uses a Langfuse judge is always sent: the dialog says so before the run starts.
  const [sending] = useAsync(
    (signal) =>
      confirming && sink
        ? api.quality.sending(tenant, serviceId, version, signal).catch(() => undefined)
        : Promise.resolve(undefined),
    [api, tenant, serviceId, version, confirming, sink?.id],
  );
  const plan = sending.status === 'ready' ? sending.data : undefined;
  const judgeNames = (plan?.judges ?? []).map((j) => j.name).join(', ');
  const judged = (plan?.judges.length ?? 0) > 0;
  const refusedText = judged ? sendingRefusal(t, plan, judgeNames) : undefined;
  const [startedId, setStartedId] = useState<string>();
  const [open, setOpen] = useState<string>();
  const [state, retry] = useAsync(
    (signal) => api.quality.runs(tenant, serviceId, signal),
    [api, tenant, serviceId, round],
  );
  const seen = useRef<EvalRun[] | undefined>(undefined);
  if (state.status === 'ready') seen.current = state.data;
  const runs = (seen.current ?? []).filter((r) => r.testSet === testSet.id);
  const costShown = runs.some((r) => r.cost !== undefined);
  const running = runs.some(active);

  const startedDone = runs.some((r) => r.id === startedId && !active(r));
  useEffect(() => {
    if (!startedDone) return;
    setStartedId(undefined);
    setFlash({ text: t('quality.runFinished'), color: 'success' });
  }, [startedDone]);

  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => setRound((r) => r + 1), pollMs);
    return () => clearTimeout(timer);
  }, [running, round]);

  const start = async () => {
    if (starting || running || !canRun || refusedText) return;
    setConfirming(false);
    setStarting(true);
    try {
      const started = await api.quality.startRun(
        tenant,
        serviceId,
        { testSet: testSet.id, version, ...((trace || judged) && sink ? { trace: true } : {}) },
        t('quality.runReason', {
          name: testSet.name,
          version: versionText(t, version).toLowerCase(),
        }),
      );
      setStartedId(started.id);
      setFlash({ text: t('quality.runStarted'), color: 'info' });
      setRound((r) => r + 1);
    } catch (error) {
      setFlash({ text: problemTitle(error, t), color: 'danger' });
    } finally {
      setStarting(false);
    }
  };

  const blocked = starting || running || !canRun;

  return (
    <section aria-labelledby="kj-h" className="stack-sm">
      <Heading level={2} data-size="xs" id="kj-h">
        {t('quality.runsTitle')}
      </Heading>
      <div className="filter-row align-end">
        <Fieldset>
          <Fieldset.Legend>{t('quality.runOn')}</Fieldset.Legend>
          <div className="tag-row">
            {(['draft', 'published'] as const).map((v) => (
              <Chip.Radio
                key={v}
                name="run-version"
                checked={version === v}
                onChange={() => setVersion(v)}
              >
                {versionText(t, v)}
              </Chip.Radio>
            ))}
          </div>
        </Fieldset>
        <Button
          variant="secondary"
          aria-disabled={blocked || undefined}
          aria-describedby={!canRun ? 'run-hint' : undefined}
          aria-expanded={canRun ? confirming : undefined}
          onClick={() => {
            if (blocked) return;
            // Each run is sent to Langfuse only when the person ticks it for that run.
            setTrace(false);
            setConfirming(true);
          }}
        >
          {t('quality.runSet')}
        </Button>
        {!canRun ? (
          <span id="run-hint" className="small">
            {canManage ? t('quality.addCasesFirst') : needsRight('manage-services', t)}
          </span>
        ) : null}
      </div>
      {confirming && canRun ? (
        <Alert data-color="info" data-size="sm">
          <Heading level={3} data-size="2xs">
            {t('quality.confirmRunTitle', { count: cases })}
          </Heading>
          <RunEstimate api={api} tenant={tenant} serviceId={serviceId} runs={runs} cases={cases} />
          {sink ? (
            <Checkbox
              data-size="sm"
              label={t('quality.sendToTrace', { connection: sink.id })}
              checked={trace || judged}
              aria-disabled={judged || undefined}
              {...(judged
                ? { description: t('quality.sendBecauseJudges', { judges: judgeNames }) }
                : {})}
              onChange={(e) => {
                if (!judged) setTrace(e.target.checked);
              }}
            />
          ) : null}
          {refusedText ? (
            <Alert data-color="danger" data-size="sm">
              <Paragraph data-size="sm">{refusedText}</Paragraph>
            </Alert>
          ) : null}
          <div className="actions">
            <Button
              variant="primary"
              data-size="sm"
              aria-disabled={blocked || refusedText !== undefined || undefined}
              onClick={() => void start()}
            >
              {t('quality.confirmRun')}
            </Button>
            <Button variant="tertiary" data-size="sm" onClick={() => setConfirming(false)}>
              {t('quality.cancel')}
            </Button>
          </div>
        </Alert>
      ) : null}
      {state.status === 'loading' && !seen.current ? (
        <Loading label={t('quality.runsLoading')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} headingLevel={3} />
      ) : runs.length === 0 ? (
        <Paragraph data-size="sm">{t('quality.notRunYet')}</Paragraph>
      ) : (
        <div tabIndex={0} role="region" aria-labelledby="kj-h" className="table-scroll">
          <Table className="runs-table">
            <Table.Head>
              <Table.Row>
                <Table.HeaderCell scope="col">{t('quality.started')}</Table.HeaderCell>
                <Table.HeaderCell scope="col">{t('quality.version')}</Table.HeaderCell>
                <Table.HeaderCell scope="col">{t('quality.status')}</Table.HeaderCell>
                <Table.HeaderCell scope="col" className="right">
                  {t('quality.score')}
                </Table.HeaderCell>
                <Table.HeaderCell scope="col">{t('quality.passed')}</Table.HeaderCell>
                {costShown ? (
                  <Table.HeaderCell scope="col">{t('quality.cost')}</Table.HeaderCell>
                ) : null}
                <Table.HeaderCell scope="col">
                  <span className="visually-hidden">{t('quality.details')}</span>
                </Table.HeaderCell>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {runs.map((r) => {
                const [text, color] = statusTag(t, r);
                return (
                  <Table.Row key={r.id}>
                    <Table.Cell>{dateTime(r.startedAt)}</Table.Cell>
                    <Table.Cell>{versionText(t, r.version)}</Table.Cell>
                    <Table.Cell>
                      <Tag data-size="sm" data-color={color}>
                        {text}
                      </Tag>
                    </Table.Cell>
                    <Table.Cell className="right numeric">{percent(f, r.score)}</Table.Cell>
                    <Table.Cell>{passedText(t, r)}</Table.Cell>
                    {costShown ? <Table.Cell>{costText(t, f, r.cost)}</Table.Cell> : null}
                    <Table.Cell>
                      {active(r) ? null : (
                        <Button
                          variant="tertiary"
                          data-size="sm"
                          aria-expanded={open === r.id}
                          aria-label={t('quality.showResultFrom', { when: dateTime(r.startedAt) })}
                          onClick={() => setOpen(open === r.id ? undefined : r.id)}
                        >
                          {t('quality.showResult')}
                        </Button>
                      )}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </div>
      )}
      {open ? (
        <RunDetail api={api} tenant={tenant} runId={open} onClose={() => setOpen(undefined)} />
      ) : null}
    </section>
  );
};
