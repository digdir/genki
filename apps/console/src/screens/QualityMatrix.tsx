import {
  Alert,
  Button,
  Chip,
  Details,
  DetailsContent,
  DetailsSummary,
  Fieldset,
  FieldsetLegend,
  Heading,
  Label,
  Paragraph,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  Tag,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../api';
import { useT, type Format, type PlainKey, type T } from '../i18n';
import { navigate, useAsync } from '../hooks';
import { EmptyState, ErrorState, Loading } from '../states';
import type {
  JudgeCalibration,
  LabelItem,
  MatrixColumnStatus,
  MatrixEstimate,
  MatrixRun,
  MatrixRunDetail,
  QualityMatrix as Matrix,
  QualityOverview,
  Verdict,
} from '../types';
import { Flash, PageHeader, TableRegion, useFlash } from '../ui';

const statusTag: Record<MatrixColumnStatus, [PlainKey, 'success' | 'info' | 'neutral']> = {
  in_use: ['qualityMatrix.statusInUse', 'success'],
  new: ['qualityMatrix.statusNew', 'info'],
  allowed: ['qualityMatrix.statusAllowed', 'neutral'],
  review: ['qualityMatrix.statusReview', 'info'],
};

const kappaText = (n: number | null | undefined, f: Format) => (n == null ? '–' : f.decimal(n, 2));

const kroner = (n: number, f: Format) =>
  f.number(n, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const runStatus: Record<
  MatrixRun['status'],
  [PlainKey, 'neutral' | 'info' | 'success' | 'danger']
> = {
  queued: ['qualityMatrix.runQueued', 'neutral'],
  running: ['qualityMatrix.runRunning', 'info'],
  succeeded: ['qualityMatrix.runSucceeded', 'success'],
  failed: ['qualityMatrix.runFailed', 'danger'],
};

const verdictLabel: Record<Verdict, PlainKey> = {
  Ja: 'qualityMatrix.yes',
  Delvis: 'qualityMatrix.partly',
  Nei: 'qualityMatrix.no',
};

const minimumReason = 20;
const runReasonMinimum = 10;
const maxDrop = 3;
const pollMs = 2000;

const reasonError = (t: T, text: string, min: number) => {
  const length = text.trim().length;
  return length < min ? t('qualityMatrix.reasonTooShort', { min, length }) : undefined;
};

const points = (score: { score: number | null } | null) =>
  score?.score == null ? null : score.score * 100;

const problemTitle = (error: unknown) =>
  error instanceof ApiError && error.problem?.title ? error.problem.title : undefined;

const ApiCall = ({ line, body }: { line: string; body: unknown }) => {
  const t = useT();
  return (
    <Details>
      <DetailsSummary>{t('common.showApiCall')}</DetailsSummary>
      <DetailsContent>
        <div className="stack">
          <code>{line}</code>
          <pre className="code">{JSON.stringify(body, null, 2)}</pre>
        </div>
      </DetailsContent>
    </Details>
  );
};

const ReleaseModel = ({
  api,
  model,
  min,
  hint,
  onReleased,
}: {
  api: ApiClient;
  model: string;
  min: number;
  hint: string;
  onReleased: (model: string) => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [failed, setFailed] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const release = async () => {
    const problem = reasonError(t, reason, min);
    setError(problem);
    if (problem) return;
    setBusy(true);
    setFailed(undefined);
    try {
      await api.releaseMatrixColumn('models', model, reason.trim());
      onReleased(model);
    } catch (e) {
      setFailed(problemTitle(e) ?? tRef.current('qualityMatrix.releaseFailed', { model }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card stack form-card" aria-labelledby="release-h">
      <Heading level={2} data-size="xs" id="release-h">
        {t('qualityMatrix.releaseTitle')}
      </Heading>
      <Paragraph data-size="sm">{t('qualityMatrix.releaseText')}</Paragraph>
      <Textfield
        label={t('common.reason')}
        description={hint}
        multiline
        rows={2}
        value={reason}
        error={error}
        onChange={(e) => {
          setReason(e.target.value);
          setError(undefined);
        }}
      />
      <ApiCall
        line="POST /operator/quality/matrix/release"
        body={{ kind: 'models', name: model }}
      />
      {failed ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          {failed}
        </Alert>
      ) : null}
      <div>
        <Button
          aria-disabled={busy || undefined}
          onClick={() => void (busy ? undefined : release())}
        >
          {t('qualityMatrix.releaseTitle')}
        </Button>
      </div>
    </section>
  );
};

const RunProgress = ({ run }: { run: MatrixRunDetail }) => {
  const t = useT();
  const f = useFormat();
  const firstOpen = run.rows.findIndex((r) => r.candidate === null);
  const state = (i: number, done: boolean) =>
    done
      ? (['qualityMatrix.done', 'success'] as const)
      : run.status === 'running' && i === firstOpen
        ? (['qualityMatrix.runRunning', 'info'] as const)
        : (['qualityMatrix.runQueued', 'neutral'] as const);
  const cost =
    run.status === 'succeeded'
      ? t('qualityMatrix.runDone', {
          cost: kroner(run.costNok ?? 0, f),
          estimate: kroner(run.estimatedCostNok, f),
        })
      : run.status === 'failed'
        ? run.error
          ? t('qualityMatrix.runFailedWith', { error: run.error })
          : t('qualityMatrix.runFailedPlain')
        : run.costNok === null
          ? t('qualityMatrix.runEstimate', { estimate: kroner(run.estimatedCostNok, f) })
          : t('qualityMatrix.runSoFar', {
              cost: kroner(run.costNok, f),
              estimate: kroner(run.estimatedCostNok, f),
            });
  return (
    <section className="stack" aria-labelledby="kj-h">
      <Heading level={2} data-size="xs" id="kj-h">
        {t('qualityMatrix.runsTitle')}
      </Heading>
      <ul className="plain run-chips">
        {run.rows.map((r, i) => {
          const [label, color] = state(i, r.candidate !== null);
          return (
            <li key={`${r.tenant}/${r.service}/${r.testSet}`}>
              {r.name}: {r.testSet}
              <Tag data-size="sm" data-color={color}>
                {t(label)}
              </Tag>
            </li>
          );
        })}
      </ul>
      <span aria-live="polite" className="meta">
        {cost}
      </span>
    </section>
  );
};

const RunResult = ({ run }: { run: MatrixRunDetail }) => {
  const t = useT();
  const f = useFormat();
  const rows = run.rows.map((r) => {
    const before = points(r.current);
    const after = points(r.candidate);
    const delta = before === null || after === null ? null : after - before;
    return { r, before, after, delta };
  });
  const worst = rows
    .filter((x) => x.delta !== null && x.delta < -maxDrop)
    .sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0))[0];
  return (
    <>
      <section className="stack" aria-labelledby="mx-h">
        <Heading level={2} data-size="xs" id="mx-h">
          {t('qualityMatrix.resultTitle')}
        </Heading>
        <TableRegion label={t('qualityMatrix.resultLabel')}>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('qualityMatrix.colTestSet')}</TableHeaderCell>
                <TableHeaderCell scope="col" className="num">
                  {run.current}
                </TableHeaderCell>
                <TableHeaderCell scope="col" className="num">
                  {run.model}
                </TableHeaderCell>
                <TableHeaderCell scope="col" className="num">
                  {t('qualityMatrix.colChange')}
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map(({ r, before, after, delta }) => (
                <TableRow key={`${r.tenant}/${r.service}/${r.testSet}`}>
                  <TableHeaderCell scope="row" className="row-head">
                    <span className="two-line">
                      <span>{r.testSet}</span>
                      <span className="meta">{r.name}</span>
                    </span>
                  </TableHeaderCell>
                  <TableCell className="num">
                    {before === null ? '–' : f.decimal(before, 1)}
                  </TableCell>
                  <TableCell className="num">
                    {after === null ? '–' : f.decimal(after, 1)}
                  </TableCell>
                  <TableCell className="num">
                    {delta === null ? (
                      '–'
                    ) : (
                      <Tag
                        data-size="sm"
                        data-color={delta < -maxDrop ? 'danger' : delta < 0 ? 'warning' : 'success'}
                      >
                        {`${delta > 0 ? '+' : delta < 0 ? '−' : ''}${f.decimal(Math.abs(delta), 1)}`}
                      </Tag>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableRegion>
      </section>
      {worst ? (
        <Alert data-color="danger">
          <Heading level={3} data-size="2xs">
            {t('qualityMatrix.cannotRelease')}
          </Heading>
          <Paragraph>
            {t('qualityMatrix.cannotReleaseText', {
              testSet: worst.r.testSet,
              drop: f.decimal(-(worst.delta ?? 0), 1),
              max: maxDrop,
            })}
          </Paragraph>
        </Alert>
      ) : null}
    </>
  );
};

const RunMatrix = ({
  api,
  quality,
  onRefresh,
}: {
  api: ApiClient;
  quality: QualityOverview;
  onRefresh: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const candidates = quality.candidates ?? [];
  const inUse = quality.modelsInUse ?? [];
  const [model, setModel] = useState(candidates[0]?.id ?? '');
  const [current, setCurrent] = useState(inUse[0]?.id ?? '');
  const [estimate, setEstimate] = useState<MatrixEstimate | undefined>();
  const [started, setStarted] = useState<MatrixRun[]>([]);
  const [active, setActive] = useState<MatrixRunDetail | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [runReason, setRunReason] = useState('');
  const [runReasonError, setRunReasonError] = useState<string | undefined>();
  const [released, setReleased] = useState<string | undefined>();
  const runs = [...started, ...(quality.matrixRuns ?? [])];
  const nothingToCompare = candidates.find((c) => c.id === model)?.testSets === 0;
  const activeId = active?.id;
  const finished = active?.status === 'succeeded' || active?.status === 'failed';

  useEffect(() => {
    if (!activeId || finished) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.matrixRun(activeId, controller.signal).then(
        (next) => {
          if (!controller.signal.aborted) setActive(next);
        },
        () => undefined,
      );
    }, pollMs);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, activeId, active, finished]);

  const choose = (set: (v: string) => void) => (value: string) => {
    set(value);
    setEstimate(undefined);
    setActive(undefined);
    setReleased(undefined);
  };
  const price = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setEstimate(await api.estimateMatrix(model, current));
    } catch (e) {
      setError(problemTitle(e) ?? tRef.current('qualityMatrix.estimateFailed'));
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    if (!estimate) return;
    const problem = reasonError(t, runReason, runReasonMinimum);
    setRunReasonError(problem);
    if (problem) return;
    setBusy(true);
    setError(undefined);
    try {
      const run = await api.startMatrix(
        estimate.model,
        estimate.current,
        estimate.estimatedCostNok,
        runReason.trim(),
      );
      setStarted((all) => [run, ...all]);
      setEstimate(undefined);
      setRunReason('');
      setActive(await api.matrixRun(run.id).catch(() => ({ ...run, rows: [] })));
    } catch (e) {
      setError(problemTitle(e) ?? tRef.current('qualityMatrix.startFailed'));
    } finally {
      setBusy(false);
    }
  };
  const blocked =
    active?.status === 'succeeded' &&
    active.rows.some((r) => {
      const before = points(r.current);
      const after = points(r.candidate);
      return before !== null && after !== null && after - before < -maxDrop;
    });
  return (
    <div className="stack">
      <section className="card stack form-card" aria-labelledby="matrix-run-h">
        <Heading level={2} data-size="xs" id="matrix-run-h">
          {t('qualityMatrix.runMatrixTitle')}
        </Heading>
        <Paragraph data-size="sm">{t('qualityMatrix.runMatrixText')}</Paragraph>
        {candidates.length === 0 ? (
          <Paragraph data-size="sm" className="meta">
            {t('qualityMatrix.noCandidates')}
          </Paragraph>
        ) : (
          <div className="toolbar">
            <div className="field">
              <Label htmlFor="matrix-model">{t('qualityMatrix.newModel')}</Label>
              <Select
                id="matrix-model"
                value={model}
                onChange={(e) => choose(setModel)(e.target.value)}
              >
                {candidates.map((c) => (
                  <Select.Option key={c.id} value={c.id}>
                    {c.testSets === 0
                      ? t('qualityMatrix.candidateNoSets', { id: c.id })
                      : t('qualityMatrix.candidate', { id: c.id })}
                  </Select.Option>
                ))}
              </Select>
            </div>
            <div className="field">
              <Label htmlFor="matrix-current">{t('qualityMatrix.compareWith')}</Label>
              <Select
                id="matrix-current"
                value={current}
                onChange={(e) => choose(setCurrent)(e.target.value)}
              >
                {inUse.map((m) => (
                  <Select.Option key={m.id} value={m.id}>
                    {t('qualityMatrix.inUseOption', { id: m.id, count: m.services })}
                  </Select.Option>
                ))}
              </Select>
            </div>
            {nothingToCompare ? null : (
              <Button
                variant="secondary"
                aria-disabled={busy || !model || !current || undefined}
                onClick={() => void (busy || !model || !current ? undefined : price())}
              >
                {t('qualityMatrix.estimateCost')}
              </Button>
            )}
          </div>
        )}
        {nothingToCompare && !released ? (
          <Alert data-color="warning" data-size="sm">
            <Paragraph data-size="sm">
              <strong>{t('qualityMatrix.nothingToCompare')}</strong>
              {t('qualityMatrix.nothingToCompareText', { model, min: minimumReason })}
            </Paragraph>
          </Alert>
        ) : null}
        {estimate ? (
          <div className="stack">
            <Paragraph data-size="sm">
              {t('qualityMatrix.estimateSummary', {
                sets: estimate.testSets.length,
                cases: estimate.cases,
                cost: kroner(estimate.estimatedCostNok, f),
              })}
              {estimate.unpriced.length > 0
                ? t('qualityMatrix.missingPrice', { models: estimate.unpriced.join(', ') })
                : ''}
            </Paragraph>
            <Textfield
              label={t('common.reason')}
              description={t('qualityMatrix.reasonHintAudited', { min: runReasonMinimum })}
              multiline
              rows={2}
              value={runReason}
              error={runReasonError}
              onChange={(e) => {
                setRunReason(e.target.value);
                setRunReasonError(undefined);
              }}
            />
            <ApiCall
              line="POST /operator/quality/matrix/runs"
              body={{
                model: estimate.model,
                current: estimate.current,
                confirmedCostNok: estimate.estimatedCostNok,
              }}
            />
            <div>
              <Button aria-disabled={busy || undefined} onClick={() => void start()}>
                {t('qualityMatrix.startRun', { cost: kroner(estimate.estimatedCostNok, f) })}
              </Button>
            </div>
          </div>
        ) : null}
        {error ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {error}
          </Alert>
        ) : null}
      </section>
      {released ? (
        <Alert data-color="success" data-size="sm" role="status">
          {t('qualityMatrix.released', { model: released })}
        </Alert>
      ) : null}
      {active && active.rows.length > 0 ? <RunProgress run={active} /> : null}
      {active?.status === 'succeeded' ? <RunResult run={active} /> : null}
      {!released && (nothingToCompare || (active?.status === 'succeeded' && !blocked)) ? (
        <ReleaseModel
          key={model}
          api={api}
          model={nothingToCompare ? model : (active?.model ?? model)}
          min={nothingToCompare ? minimumReason : runReasonMinimum}
          hint={
            nothingToCompare
              ? t('qualityMatrix.reasonHintNoSets', { min: minimumReason })
              : t('qualityMatrix.reasonHintAudited', { min: runReasonMinimum })
          }
          onReleased={setReleased}
        />
      ) : null}
      {runs.length > 0 ? (
        <>
          <TableRegion label={t('qualityMatrix.runsLabel')}>
            <Table data-size="sm">
              <TableHead>
                <TableRow>
                  <TableHeaderCell scope="col">{t('qualityMatrix.colNewModel')}</TableHeaderCell>
                  <TableHeaderCell scope="col">
                    {t('qualityMatrix.colComparedWith')}
                  </TableHeaderCell>
                  <TableHeaderCell scope="col">{t('qualityMatrix.colStatus')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('qualityMatrix.colTestSet')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('qualityMatrix.colCost')}</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.model}</TableCell>
                    <TableCell>{r.current}</TableCell>
                    <TableCell>
                      <Tag data-size="sm" data-color={runStatus[r.status][1]}>
                        {t(runStatus[r.status][0])}
                      </Tag>
                    </TableCell>
                    <TableCell>
                      {t('qualityMatrix.doneOf', { done: r.done, total: r.testSets })}
                    </TableCell>
                    <TableCell>
                      {r.costNok === null
                        ? t('qualityMatrix.estimated', { cost: kroner(r.estimatedCostNok, f) })
                        : t('qualityMatrix.cost', { cost: kroner(r.costNok, f) })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableRegion>
          <div>
            <Button variant="tertiary" data-size="sm" onClick={onRefresh}>
              {t('qualityMatrix.refresh')}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
};

export const fromRuns = (q: QualityOverview, t: T): Matrix => ({
  columns: [{ name: t('qualityMatrix.lastRun'), status: 'in_use' }],
  baseline: [0],
  rows: q.services.map((s) => ({
    testSet: `${s.service} · ${s.testSet}`,
    kind: t('qualityMatrix.sharedTestSet'),
    scores: [Math.round((Object.values(s.metrics)[0]?.mean ?? 0) * 100)],
  })),
});

const MatrixView = ({
  api,
  quality,
  threshold,
  onRefresh,
}: {
  api: ApiClient;
  quality: QualityOverview;
  threshold: number;
  onRefresh: () => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [kind, setKind] = useState<'models' | 'blocks'>('models');
  const flash = useFlash();
  const m = quality.matrix?.[kind] ?? fromRuns(quality, t);
  const advisory = (judgeId?: string) => {
    if (!judgeId) return false;
    const j = quality.judges.find((x) => x.judge === judgeId);
    const nn = j?.kappaByLanguage?.Nynorsk?.[0];
    return nn != null ? nn < threshold : j ? j.kappa < threshold : false;
  };
  const worst = (ci: number) =>
    Math.min(
      0,
      ...m.rows.flatMap((r) => {
        const v = r.scores[ci];
        const base = r.scores[m.baseline[ci] ?? 0];
        return v == null || base == null ? [] : [v - base];
      }),
    );
  const verdicts = m.columns.map((c, ci) => {
    const w = worst(ci);
    const current = c.status === 'in_use';
    const bad = w < -3;
    return {
      ...c,
      verdict: current
        ? t('qualityMatrix.verdictBase')
        : bad
          ? t('qualityMatrix.verdictBlocked')
          : w < 0
            ? t('qualityMatrix.verdictRegression')
            : t('qualityMatrix.verdictAllowed'),
      color: current ? 'neutral' : bad ? 'danger' : w < 0 ? 'warning' : 'success',
      action:
        current || c.status === 'allowed'
          ? ''
          : kind === 'models' && c.status !== 'new'
            ? t('qualityMatrix.actionAllowModel')
            : t('qualityMatrix.actionMakeAvailable'),
      bad,
    } as const;
  });
  const act = async (c: (typeof verdicts)[number]) => {
    if (c.bad) {
      flash.show(t('qualityMatrix.blockedFlash', { name: c.name }), 'danger');
      return;
    }
    try {
      await api.releaseMatrixColumn(kind, c.name);
      flash.show(tRef.current('qualityMatrix.allowedFlash', { name: c.name }));
    } catch (e) {
      flash.show(
        problemTitle(e) ?? tRef.current('qualityMatrix.allowFailed', { name: c.name }),
        'danger',
      );
    }
  };
  return (
    <div className="stack">
      <Flash message={flash.message} />
      <Paragraph>{t('qualityMatrix.matrixIntro')}</Paragraph>
      {quality.matrix ? (
        <Fieldset>
          <FieldsetLegend>{t('qualityMatrix.compare')}</FieldsetLegend>
          <div className="chips">
            <Chip.Radio name="kind" checked={kind === 'models'} onChange={() => setKind('models')}>
              {t('qualityMatrix.kindModels')}
            </Chip.Radio>
            <Chip.Radio name="kind" checked={kind === 'blocks'} onChange={() => setKind('blocks')}>
              {t('qualityMatrix.kindBlocks')}
            </Chip.Radio>
          </div>
        </Fieldset>
      ) : (
        <Alert data-color="info" data-size="sm">
          {t('qualityMatrix.noComparison')}
        </Alert>
      )}
      {quality.candidates && kind === 'models' ? (
        <RunMatrix api={api} quality={quality} onRefresh={onRefresh} />
      ) : null}
      {m.rows.length === 0 ? (
        <EmptyState title={t('qualityMatrix.noTestSets')} />
      ) : (
        <TableRegion label={t('qualityMatrix.matrixLabel')}>
          <Table className="wide-900">
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('qualityMatrix.colTestSet')}</TableHeaderCell>
                {m.columns.map((c) => (
                  <TableHeaderCell scope="col" key={c.name}>
                    <span className="two-line">
                      <span>{c.name}</span>
                      <Tag data-size="sm" data-color={statusTag[c.status][1]}>
                        {t(statusTag[c.status][0])}
                      </Tag>
                    </span>
                  </TableHeaderCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {m.rows.map((r) => (
                <TableRow key={r.testSet}>
                  <TableHeaderCell scope="row" className="row-head">
                    <span className="two-line">
                      <span>{r.testSet}</span>
                      <span className="meta">{r.kind}</span>
                      {advisory(r.advisoryJudge) ? (
                        <Tag data-size="sm" data-color="warning">
                          {t('qualityMatrix.advisoryJudge')}
                        </Tag>
                      ) : null}
                    </span>
                  </TableHeaderCell>
                  {r.scores.map((v, ci) => {
                    if (v == null) return <TableCell key={ci}>–</TableCell>;
                    const base = r.scores[m.baseline[ci] ?? 0] ?? v;
                    const isBase = ci === m.baseline[ci] || m.columns[ci]?.status === 'in_use';
                    const d = v - base;
                    return (
                      <TableCell key={ci} className={!isBase && d < -3 ? 'cell-bad' : undefined}>
                        <span className="two-line">
                          <span className="strong">{v}</span>
                          {isBase ? null : (
                            <span
                              className={d < -3 ? 'delta bad' : d < 0 ? 'delta warn' : 'delta good'}
                            >
                              {d === 0 ? '±0' : d > 0 ? `+${d}` : `−${Math.abs(d)}`}
                              {d < -3 ? t('qualityMatrix.regressionSuffix') : ''}
                            </span>
                          )}
                        </span>
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
              <TableRow>
                <TableHeaderCell scope="row" className="row-head">
                  {t('qualityMatrix.verdictRow')}
                </TableHeaderCell>
                {verdicts.map((c) => (
                  <TableCell key={c.name}>
                    <span className="two-line">
                      <Tag data-size="sm" data-color={c.color}>
                        {c.verdict}
                      </Tag>
                      {c.action ? (
                        <Button
                          variant="secondary"
                          data-size="sm"
                          aria-disabled={c.bad || undefined}
                          aria-label={t('qualityMatrix.actionLabel', {
                            action: c.action,
                            name: c.name,
                          })}
                          onClick={() => void act(c)}
                        >
                          {c.action}
                        </Button>
                      ) : null}
                    </span>
                  </TableCell>
                ))}
              </TableRow>
            </TableBody>
          </Table>
        </TableRegion>
      )}
      <Paragraph data-size="sm" className="meta">
        {t('qualityMatrix.matrixNote')}
      </Paragraph>
    </div>
  );
};

const Judges = ({
  judges,
  threshold,
  thresholdText,
  onThreshold,
  onRate,
}: {
  judges: JudgeCalibration[];
  threshold: number;
  thresholdText: string;
  onThreshold: (text: string) => string | undefined;
  onRate: (judge: string) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const [error, setError] = useState<string | undefined>();
  return (
    <div className="stack">
      <Alert data-color="info" data-size="sm">
        {t.rich('qualityMatrix.judgeIntro', { strong: (c) => <strong>{c}</strong> })}
      </Alert>
      <Textfield
        className="narrow"
        id="terskel"
        label={t('qualityMatrix.threshold')}
        description={t('qualityMatrix.thresholdHint')}
        inputMode="decimal"
        value={thresholdText}
        error={error}
        onChange={(e) => setError(onThreshold(e.target.value))}
      />
      {judges.length === 0 ? (
        <EmptyState title={t('qualityMatrix.noJudgesTitle')}>
          <Paragraph>{t('qualityMatrix.noJudgesText')}</Paragraph>
        </EmptyState>
      ) : null}
      {judges.map((j) => {
        const jobs = j.jobTypes ?? [t('qualityMatrix.allJobTypes')];
        const rows = j.kappaByLanguage ?? { [t('qualityMatrix.allLanguages')]: [j.kappa] };
        const name = j.name ?? j.judge;
        return (
          <section key={j.judge} className="card stack" aria-labelledby={`judge-${j.judge}`}>
            <div className="card-head">
              <span className="two-line">
                <Heading level={2} data-size="2xs" id={`judge-${j.judge}`}>
                  {name}
                </Heading>
                <span className="meta">
                  {[
                    j.model,
                    t('qualityMatrix.humanJudgements', { count: j.n }),
                    j.measuredAt ? t('qualityMatrix.measuredAt', { date: j.measuredAt }) : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <Button variant="secondary" data-size="sm" onClick={() => onRate(j.judge)}>
                {t('qualityMatrix.rateSample')}
              </Button>
            </div>
            <TableRegion label={t('qualityMatrix.kappaFor', { name })}>
              <Table data-size="sm">
                <TableHead>
                  <TableRow>
                    <TableHeaderCell scope="col">{t('qualityMatrix.colLanguage')}</TableHeaderCell>
                    {jobs.map((c) => (
                      <TableHeaderCell scope="col" key={c}>
                        {c}
                      </TableHeaderCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {Object.entries(rows).map(([lang, values]) => (
                    <TableRow key={lang}>
                      <TableHeaderCell scope="row" className="row-head">
                        {lang}
                      </TableHeaderCell>
                      {values.map((v, i) => (
                        <TableCell key={i}>
                          <span className="two-line">
                            <span className="strong">{kappaText(v, f)}</span>
                            <Tag
                              data-size="sm"
                              data-color={
                                v == null ? 'neutral' : v >= threshold ? 'success' : 'warning'
                              }
                            >
                              {v == null
                                ? t('qualityMatrix.notMeasured')
                                : v >= threshold
                                  ? t('qualityMatrix.canStopPublishing')
                                  : t('qualityMatrix.advisoryOnly')}
                            </Tag>
                          </span>
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableRegion>
          </section>
        );
      })}
    </div>
  );
};

type Answers = { correct?: Verdict; grounded?: Exclude<Verdict, 'Delvis'> };

const Rate = ({
  api,
  judges,
  judge,
  onJudge,
}: {
  api: ApiClient;
  judges: JudgeCalibration[];
  judge: string;
  onJudge: (judge: string) => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [state, retry] = useAsync((signal) => api.labelQueue(signal), [api]);
  const [items, setItems] = useState<LabelItem[]>([]);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Answers>({});
  const [tried, setTried] = useState(false);
  const [saved, setSaved] = useState(false);
  const [done, setDone] = useState(0);
  const [failed, setFailed] = useState<string | undefined>();
  useEffect(() => {
    if (state.status === 'ready') setItems(state.data.data);
  }, [state]);
  useEffect(() => {
    setIndex(0);
    setAnswers({});
    setSaved(false);
  }, [judge]);

  const queue = items.filter((i) => i.judge === judge);
  const sample = queue[index % Math.max(1, queue.length)];
  const save = async () => {
    if (!sample) return;
    if (!answers.correct || !answers.grounded) {
      setTried(true);
      return;
    }
    const human = answers.correct === 'Ja' && answers.grounded === 'Ja' ? 'good' : 'bad';
    try {
      await api.addLabel(
        sample,
        human,
        tRef.current('qualityMatrix.labelReason', { judge: sample.judge }),
      );
      setSaved(true);
      setTried(false);
      setFailed(undefined);
    } catch {
      setFailed(tRef.current('qualityMatrix.saveLabelFailed'));
    }
  };
  const compare = (() => {
    if (!saved || !sample) return undefined;
    if (sample.judgeCriteria) {
      const j = sample.judgeCriteria;
      const same = j.correct === answers.correct && j.grounded === answers.grounded;
      return {
        same,
        text: `${t('qualityMatrix.judgeAnswered', {
          correct: t(verdictLabel[j.correct]),
          grounded: t(verdictLabel[j.grounded]),
        })}${same ? t('qualityMatrix.agree') : t('qualityMatrix.disagree')}`,
      };
    }
    const human = answers.correct === 'Ja' && answers.grounded === 'Ja' ? 'good' : 'bad';
    const same = human === sample.judgeLabel;
    return {
      same,
      text: `${t('qualityMatrix.judgeAnsweredLabel', {
        label: sample.judgeLabel === 'good' ? t('qualityMatrix.good') : t('qualityMatrix.bad'),
      })}${sample.reason ? t('qualityMatrix.judgeReason', { reason: sample.reason }) : '.'} ${same ? t('qualityMatrix.agree') : t('qualityMatrix.disagree')}`,
    };
  })();
  const nextSample = () => {
    setItems((all) => all.filter((i) => i !== sample));
    setDone((d) => d + 1);
    setAnswers({});
    setSaved(false);
  };

  const criteria = [
    {
      key: 'correct' as const,
      label: t('qualityMatrix.questionCorrect'),
      options: ['Ja', 'Delvis', 'Nei'] as const,
    },
    {
      key: 'grounded' as const,
      label: t('qualityMatrix.questionGrounded'),
      options: ['Ja', 'Nei'] as const,
    },
  ];

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="field">
          <Label htmlFor="dommer">{t('qualityMatrix.judge')}</Label>
          <Select id="dommer" value={judge} onChange={(e) => onJudge(e.target.value)}>
            {judges.map((j) => (
              <Select.Option key={j.judge} value={j.judge}>
                {j.name ?? j.judge}
              </Select.Option>
            ))}
          </Select>
        </div>
        <span aria-live="polite" className="meta">
          {sample
            ? t('qualityMatrix.progress', {
                current: done + 1,
                total: done + queue.length,
                done,
              })
            : t('qualityMatrix.progressDone', { done })}
        </span>
      </div>
      <Paragraph>{t('qualityMatrix.rateIntro')}</Paragraph>
      {state.status === 'loading' ? (
        <Loading label={t('qualityMatrix.loadingSamples')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : !sample ? (
        <EmptyState title={t('qualityMatrix.nothingToRateTitle')}>
          <Paragraph>{t('qualityMatrix.nothingToRateText')}</Paragraph>
        </EmptyState>
      ) : (
        <>
          <article className="card stack" aria-labelledby="sp-h">
            <span className="meta">
              {sample.meta ??
                t('qualityMatrix.caseMeta', { service: sample.service, case: sample.case })}
            </span>
            <h2 id="sp-h" className="sample-q" lang={sample.lang ?? 'nb'}>
              {sample.question ?? t('qualityMatrix.testCase', { case: sample.case })}
            </h2>
            {sample.answer ? <div lang={sample.lang ?? 'nb'}>{sample.answer}</div> : null}
            {sample.sources?.length ? (
              <div>
                <span className="label-strong">{t('qualityMatrix.sourcesUsed')}</span>
                <ul>
                  {sample.sources.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </article>
          {criteria.map((c) => (
            <Fieldset key={c.key}>
              <FieldsetLegend>{c.label}</FieldsetLegend>
              <div className="chips">
                {c.options.map((o) => (
                  <Chip.Radio
                    key={o}
                    name={`k-${c.key}`}
                    checked={answers[c.key] === o}
                    disabled={saved}
                    onChange={() => setAnswers((a) => ({ ...a, [c.key]: o }))}
                  >
                    {t(verdictLabel[o])}
                  </Chip.Radio>
                ))}
              </div>
              {tried && !answers[c.key] ? (
                <ValidationMessage>{t('qualityMatrix.chooseAnswer')}</ValidationMessage>
              ) : null}
            </Fieldset>
          ))}
          {failed ? (
            <Alert data-color="danger" data-size="sm" role="alert">
              {failed}
            </Alert>
          ) : null}
          {compare ? (
            <Alert data-color={compare.same ? 'success' : 'warning'} data-size="sm">
              {compare.text}
            </Alert>
          ) : null}
          <div>
            {saved ? (
              <Button onClick={nextSample}>{t('qualityMatrix.nextSample')}</Button>
            ) : (
              <Button onClick={() => void save()}>{t('qualityMatrix.saveLabel')}</Button>
            )}
          </div>
        </>
      )}
    </div>
  );
};

const titles: Record<string, [PlainKey, PlainKey]> = {
  matrix: ['qualityMatrix.matrixTitle', 'qualityMatrix.matrixPageIntro'],
  judges: ['qualityMatrix.judgesTitle', 'qualityMatrix.judgesPageIntro'],
  rate: ['qualityMatrix.rateTitle', 'qualityMatrix.ratePageIntro'],
};

export const QualityMatrix = ({
  api,
  tab: initial,
}: {
  api: ApiClient;
  tab: string;
  live?: boolean;
}) => {
  const t = useT();
  const f = useFormat();
  const [state, retry] = useAsync((signal) => api.quality(signal), [api]);
  const [tab, setTabState] = useState(titles[initial] ? initial : 'matrix');
  useEffect(() => {
    setTabState(titles[initial] ? initial : 'matrix');
  }, [initial]);
  const setTab = (next: string) => {
    setTabState(next);
    navigate('/quality-matrix', next === 'matrix' ? undefined : { tab: next });
  };
  const [threshold, setThreshold] = useState(0.6);
  const [thresholdText, setThresholdText] = useState(() => f.decimal(0.6, 2));
  const [judge, setJudge] = useState<string | undefined>();
  const [title, intro] = titles[tab] ??
    titles.matrix ?? ['qualityMatrix.matrixTitle', 'qualityMatrix.matrixPageIntro'];

  const onThreshold = (text: string) => {
    setThresholdText(text);
    const n = Number(text.replace(',', '.'));
    if (Number.isNaN(n) || n < 0.4 || n > 0.9) return t('qualityMatrix.thresholdError');
    setThreshold(n);
    return undefined;
  };

  return (
    <>
      <PageHeader title={t(title)} intro={t(intro)} />
      {state.status === 'loading' ? (
        <Loading label={t('qualityMatrix.loading')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : (
        <Tabs value={tab} onChange={setTab}>
          <TabsList>
            <TabsTab value="matrix">{t('qualityMatrix.tabMatrix')}</TabsTab>
            <TabsTab value="judges">{t('qualityMatrix.tabJudges')}</TabsTab>
            <TabsTab value="rate">{t('qualityMatrix.tabRate')}</TabsTab>
          </TabsList>
          <TabsPanel value="matrix">
            <MatrixView api={api} quality={state.data} threshold={threshold} onRefresh={retry} />
          </TabsPanel>
          <TabsPanel value="judges">
            <Judges
              judges={state.data.judges}
              threshold={threshold}
              thresholdText={thresholdText}
              onThreshold={onThreshold}
              onRate={(j) => {
                setJudge(j);
                setTab('rate');
              }}
            />
          </TabsPanel>
          <TabsPanel value="rate">
            <Rate
              api={api}
              judges={state.data.judges}
              judge={judge ?? state.data.judges[0]?.judge ?? ''}
              onJudge={setJudge}
            />
          </TabsPanel>
        </Tabs>
      )}
    </>
  );
};
