import { Alert, Button, Heading, Spinner, Tag } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import type {
  DatasetEngine,
  EngineSwitch as Switch,
  SearchEngineInfo,
  SwitchEstimate,
  SwitchMethod,
} from '../../api/search-engines';
import { ApiCallLink } from '../../components/ApiCall';
import { DataLocationTag } from '../../components/DataLocationTag';
import { NotDecided } from '../../components/NotDecided';
import { reasonProblem, ReasonField } from '../../components/ReasonField';
import { StepList } from '../../components/StepList';
import {
  costText,
  datasetEnginePath,
  decimal,
  durationText,
  engineCapabilities,
  locationNames,
  seconds,
  switchSteps,
  verdictColors,
  verdictLabels,
} from '../../data/search-engines';
import { useT, type T } from '../../i18n';

export type SwitchOutcome =
  | { kind: 'cancelled' }
  | { kind: 'failed'; target: string }
  | { kind: 'activated'; target: string };

interface Props {
  api: ApiClient;
  tenant: string;
  datasetId: string;
  datasetName: string;
  tenantName: string;
  docs: string;
  chunks: string;
  current: DatasetEngine;
  engines: SearchEngineInfo[];
  initial?: Switch;
  pollMs?: number;
  onClose: (outcome: SwitchOutcome) => void;
}

const refusal = (t: T, error: unknown) =>
  error instanceof ApiError && error.status === 409 && error.problem?.title
    ? error.problem.title
    : t('searchEngine.swFailed');

const stepOf = (sw: Switch | undefined) =>
  !sw ? 1 : sw.state === 'running' || sw.state === 'failed' ? 3 : 4;

export const canCopy = (from: SearchEngineInfo, to: SearchEngineInfo) =>
  !to.embeddingModel || to.embeddingModel.name === from.embeddingModel?.name;

export const EngineSwitch = ({
  api,
  tenant,
  datasetId,
  datasetName,
  tenantName,
  docs,
  chunks,
  current,
  engines,
  initial,
  pollMs = 1000,
  onClose,
}: Props) => {
  const t = useT();
  const f = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const right = t('rights.manageDatasets');
  const rank = (n: number | null) => (n === null ? '–' : decimal(f, n));
  const now = current.engine;
  const targets = engines.filter((e) => e.id !== now.id);
  const [step, setStep] = useState(stepOf(initial));
  const [target, setTarget] = useState(initial?.to ?? targets[0]?.id ?? '');
  const [method, setMethod] = useState<SwitchMethod>(initial?.method ?? 'copy');
  const [sw, setSw] = useState<Switch | undefined>(initial);
  const [estimate, setEstimate] = useState<SwitchEstimate | 'loading' | 'error'>('loading');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const dest = engines.find((e) => e.id === target) ?? (targets[0] as SearchEngineInfo);
  const sameModel = canCopy(now, dest);
  const lose = engineCapabilities.filter(
    (c) => c.has(now.capabilities) && !c.has(dest.capabilities),
  );
  const comparison = sw?.comparison;
  const worse = comparison?.verdict === 'worse';
  const minimumReason = sw?.minimumReasonLength ?? (worse ? 20 : 10);
  const compared = Boolean(comparison ?? (sw?.state === 'ready' && sw.comparisonNote));
  const running = step === 3 && sw?.state === 'running';
  const failed = sw?.state === 'failed';
  const base = datasetEnginePath(tenant, datasetId);

  useEffect(() => {
    if (!sw || (sw.state !== 'running' && sw.state !== 'comparing')) return;
    const timer = setTimeout(() => {
      api.searchEngines.getSwitch(tenant, datasetId, sw.id).then(
        (next) => {
          setSw(next);
          if (next.state === 'comparing' || next.state === 'ready')
            setStep((s) => (s === 3 ? 4 : s));
        },
        () => undefined,
      );
    }, pollMs);
    return () => clearTimeout(timer);
  }, [api, tenant, datasetId, sw, pollMs]);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem('');
    try {
      await work();
    } catch (error) {
      setProblem(refusal(tRef.current, error));
    } finally {
      setBusy(false);
    }
  };

  const goStep = (n: number) => {
    setStep(n);
    setReason('');
    setTried(false);
    setProblem('');
  };

  const toMethods = () => {
    setMethod(sameModel ? 'copy' : 'reingest');
    goStep(2);
    setEstimate('loading');
    api.searchEngines.estimate(tenant, datasetId, dest.id).then(
      (e) => setEstimate(e),
      (error: unknown) => {
        setEstimate('error');
        if (error instanceof ApiError && error.status === 409)
          setProblem(refusal(tRef.current, error));
      },
    );
  };

  const cancel = () =>
    act(async () => {
      if (sw)
        await api.searchEngines.cancelSwitch(
          tenant,
          datasetId,
          sw.id,
          tRef.current('searchEngine.switchCancelReason'),
        );
      onClose({ kind: 'cancelled' });
    });

  const giveUp = () =>
    act(async () => {
      if (sw)
        await api.searchEngines.cancelSwitch(
          tenant,
          datasetId,
          sw.id,
          tRef.current('searchEngine.switchCancelReason'),
        );
      onClose({ kind: 'failed', target: dest.title });
    });

  const start = () =>
    act(async () => {
      const chosen = copyOk ? method : 'reingest';
      const created = await api.searchEngines.startSwitch(
        tenant,
        datasetId,
        dest.id,
        chosen,
        tRef.current('searchEngine.switchStartReason'),
      );
      setMethod(chosen);
      setSw(created);
      goStep(3);
    });

  const retry = () =>
    act(async () => {
      if (sw)
        setSw(
          await api.searchEngines.retrySwitch(
            tenant,
            datasetId,
            sw.id,
            tRef.current('searchEngine.switchRetryReason'),
          ),
        );
    });

  const adopt = () => {
    setTried(true);
    if (!sw || reasonProblem(reason, t, minimumReason)) return;
    void act(async () => {
      await api.searchEngines.activateSwitch(tenant, datasetId, sw.id, reason.trim());
      onClose({ kind: 'activated', target: dest.title });
    });
  };

  const estimateFor = (m: SwitchMethod) =>
    typeof estimate === 'object' ? estimate.methods.find((x) => x.method === m) : undefined;
  const estimateText = (m: SwitchMethod) => {
    if (estimate === 'loading') return t('searchEngine.swEstimateLoading');
    const e = estimateFor(m);
    if (!e) return t('searchEngine.swEstimateMissing');
    return t(m === 'copy' ? 'searchEngine.swEstimateCopy' : 'searchEngine.swEstimateReingest', {
      cost: costText(t, f, e.costNok),
      duration: durationText(t, f, e.durationMinutes),
      amount: m === 'copy' ? chunks : docs,
    });
  };
  const copyReason = estimateFor('copy')?.reason;
  const copyOk = sameModel && estimateFor('copy')?.available !== false;

  const pct = sw?.progress ?? 0;
  const pctStep = Math.floor(pct / 10) * 10;
  const progTitle = t(
    method === 'copy' ? 'searchEngine.swCopyingTo' : 'searchEngine.swReingestingTo',
    {
      engine: dest.title,
    },
  );
  const progText = failed
    ? t('searchEngine.swStoppedAt', { percent: pct })
    : pct >= 100
      ? t('searchEngine.swDoneTesting')
      : t(method === 'copy' ? 'searchEngine.swProgressCopy' : 'searchEngine.swProgressReingest', {
          percent: pctStep,
        });

  const summary = [
    current.usedBy.length
      ? t('searchEngine.swSummaryUsed', {
          services: f.list(current.usedBy.map((u) => u.name)),
          engine: dest.title,
        })
      : t('searchEngine.swSummaryNone'),
    t('searchEngine.swSummaryNext', { engine: dest.title }),
    ...(lose.length
      ? [
          t('searchEngine.swSummaryLose', {
            list: lose.map((c) => t(c.name).toLowerCase()).join(', '),
          }),
        ]
      : []),
  ];

  const hit = comparison
    ? comparison.hitAt5[1] > comparison.hitAt5[0]
      ? { tag: t('searchEngine.verdictBetter'), color: 'success' as const }
      : comparison.hitAt5[1] < comparison.hitAt5[0]
        ? { tag: t('searchEngine.verdictWorse'), color: 'warning' as const }
        : undefined
    : undefined;

  return (
    <section aria-labelledby="bytt-h" className="engine-block engine-switch">
      <div className="engine-head">
        <div className="stack-xs">
          <span className="subtle small-text">{t('searchEngine.swStep', { step })}</span>
          <Heading level={2} data-size="xs" id="bytt-h">
            {t('searchEngine.swHeading', { dataset: datasetName })}
          </Heading>
        </div>
        <Button
          variant="tertiary"
          data-size="sm"
          aria-disabled={running || busy || undefined}
          onClick={() => {
            if (!running && !busy) void cancel();
          }}
        >
          {t('searchEngine.swCancel')}
        </Button>
      </div>
      <StepList
        steps={switchSteps.map((s) => t(s))}
        current={step}
        label={t('searchEngine.swStepsLabel')}
      />
      <Alert data-color="info" data-size="sm">
        {t('searchEngine.swNothingChanges', { engine: now.title })}
      </Alert>
      {problem ? (
        <Alert data-color="danger" data-size="sm">
          {problem}
        </Alert>
      ) : null}

      {step === 1 ? (
        <div className="stack">
          <fieldset className="engine-fieldset">
            <legend className="ds-heading" data-size="2xs">
              {t('searchEngine.stepEngine')}
            </legend>
            <div className="choice-grid">
              {targets.map((e) => (
                <label
                  key={e.id}
                  className="choice-card"
                  data-checked={e.id === dest.id || undefined}
                >
                  <input
                    className="ds-input"
                    type="radio"
                    name="motor-mal"
                    checked={e.id === dest.id}
                    onChange={() => setTarget(e.id)}
                  />
                  <span className="choice-body">
                    <span className="choice-name">{e.title}</span>
                    <span className="subtle choice-desc">{e.runsAt ?? e.tech}</span>
                    {e.dataLocation ? (
                      <span className="align-start">
                        <DataLocationTag location={e.dataLocation} />
                      </span>
                    ) : null}
                    {e.writeKeyRequired ? (
                      <Tag data-size="sm" data-color="warning" className="align-start">
                        {t('searchEngine.swWriteKey')}
                      </Tag>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div
            className="table-scroll engine-table"
            tabIndex={0}
            role="region"
            aria-label={t('searchEngine.swEngineTable')}
          >
            <table className="ds-table" data-size="sm">
              <thead>
                <tr>
                  <th scope="col">{t('searchEngine.swWhatSearchCan')}</th>
                  {engines.map((e) => (
                    <th key={e.id} scope="col" data-target={e.id === dest.id || undefined}>
                      {e.title}
                      {e.id === now.id ? (
                        <span className="engine-now">{t('searchEngine.swNow')}</span>
                      ) : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {engineCapabilities.map((c) => (
                  <tr key={c.id}>
                    <th scope="row">{t(c.name)}</th>
                    {engines.map((e) => {
                      const y = c.has(e.capabilities);
                      return (
                        <td key={e.id} data-target={e.id === dest.id || undefined}>
                          <Tag data-size="sm" data-color={y ? 'success' : 'warning'}>
                            {y ? t('common.yes') : t('common.no')}
                          </Tag>
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr>
                  <th scope="row">{t('searchEngine.swProcessedIn')}</th>
                  {engines.map((e) => (
                    <td key={e.id} data-target={e.id === dest.id || undefined}>
                      <Tag
                        data-size="sm"
                        data-color={e.dataLocation === 'global' ? 'warning' : 'neutral'}
                      >
                        {e.dataLocation ? t(locationNames[e.dataLocation]) : t('common.unknown')}
                      </Tag>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          {lose.length ? (
            <Alert data-color="warning">
              <Heading level={3} data-size="2xs">
                {t('searchEngine.swLoses', { engine: dest.title, count: lose.length })}
              </Heading>
              <ul className="engine-lose">
                {lose.map((c) => (
                  <li key={c.id}>
                    <strong>{t(c.name)}:</strong> {t(c.consequence)}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}
          <div className="actions">
            <Button variant="primary" onClick={toMethods}>
              {t('common.next')}
            </Button>
          </div>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="stack">
          <fieldset className="engine-fieldset stack-sm">
            <legend className="ds-heading" data-size="2xs">
              {t('searchEngine.swHow', { engine: dest.title })}
            </legend>
            {(
              [
                ['copy', t('searchEngine.swCopyLabel'), t('searchEngine.swCopyDescription')],
                [
                  'reingest',
                  t('searchEngine.swReingestLabel'),
                  t('searchEngine.swReingestDescription', { engine: dest.title }),
                ],
              ] as const
            ).map(([id, label, desc]) => {
              const disabled = id === 'copy' && !copyOk;
              const chosen = (disabled ? 'reingest' : method) === id;
              return (
                <label
                  key={id}
                  className="choice-card method-card"
                  data-checked={chosen || undefined}
                  data-disabled={disabled || undefined}
                >
                  <input
                    className="ds-input"
                    type="radio"
                    name="motor-metode"
                    checked={chosen}
                    disabled={disabled}
                    onChange={() => setMethod(id)}
                  />
                  <span className="choice-body">
                    <span className="choice-name">{label}</span>
                    <span className="choice-text">{desc}</span>
                    <span className="choice-estimate">{estimateText(id)}</span>
                    {disabled ? (
                      <span className="choice-why">
                        {sameModel
                          ? t('searchEngine.swNotPossible', {
                              reason: copyReason ?? t('searchEngine.swCannotCopy'),
                            })
                          : t('searchEngine.swOtherModel', { engine: dest.title })}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </fieldset>
          <p className="subtle small-text engine-p">
            {t('searchEngine.swCostNote', { tenant: tenantName })}
          </p>
          <div className="actions">
            <Button variant="secondary" onClick={() => goStep(1)}>
              {t('common.back')}
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void start()}>
              {t('searchEngine.swStart')}
            </Button>
            <ApiCallLink
              call={{
                action: t('searchEngine.swStart'),
                method: 'POST',
                path: `${base}/engine-switches`,
                body: { to: dest.id, method: copyOk ? method : 'reingest' },
                right,
              }}
            />
          </div>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="stack-sm">
          <Heading level={3} data-size="2xs">
            {progTitle}
          </Heading>
          <div
            role="progressbar"
            aria-label={progTitle}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-valuetext={t('searchEngine.swPercent', { percent: pct })}
            className="engine-bar"
            data-failed={failed || undefined}
          >
            <div style={{ width: `${pct}%` }} />
          </div>
          <p aria-live="polite" className="engine-p">
            {progText}
          </p>
          {failed ? (
            <Alert data-color="danger">
              <Heading level={4} data-size="2xs">
                {t('searchEngine.swStoppedHeading', { percent: pct })}
              </Heading>
              <p className="alert-text">
                {t('searchEngine.swStoppedText', { target: dest.title, current: now.title })}
              </p>
              {sw?.failure?.message ? (
                <p className="meta">
                  {t('searchEngine.swTechnical', { message: sw.failure.message })}
                </p>
              ) : null}
              <div className="actions">
                <Button variant="primary" data-size="sm" onClick={() => void retry()}>
                  {t('common.tryAgain')}
                </Button>
                <Button variant="secondary" data-size="sm" onClick={() => void giveUp()}>
                  {t('searchEngine.swCancel')}
                </Button>
              </div>
            </Alert>
          ) : null}
          {running ? (
            <span className="engine-leave subtle small-text">
              <Spinner aria-hidden="true" data-size="xs" />
              {t('searchEngine.swMayClose')}
            </span>
          ) : null}
        </div>
      ) : null}

      {step === 4 ? (
        <div className="stack">
          <div className="stack-xs">
            <Heading level={3} data-size="2xs">
              {t('searchEngine.swQuality')}
            </Heading>
            {comparison ? (
              <span className="subtle">
                {t('searchEngine.swSameQuestions', { testSet: comparison.testSet })}
              </span>
            ) : null}
          </div>
          {!comparison && compared ? (
            <Alert data-color="info" data-size="sm">
              {sw?.comparisonNote}
            </Alert>
          ) : null}
          {!comparison && !compared ? (
            <span className="engine-leave subtle" role="status">
              <Spinner aria-hidden="true" data-size="xs" />
              {t('searchEngine.swTesting')}
            </span>
          ) : null}
          {!comparison ? null : (
            <>
              {worse ? (
                <Alert data-color="warning">
                  <p className="alert-text">
                    {t.rich('searchEngine.swWorse', {
                      b: (c) => <strong>{c}</strong>,
                      engine: dest.title,
                      after: comparison.hitAt5[1],
                      before: comparison.hitAt5[0],
                    })}
                  </p>
                </Alert>
              ) : null}
              <div
                className="table-scroll"
                tabIndex={0}
                role="region"
                aria-label={t('searchEngine.swComparison')}
              >
                <table className="ds-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('searchEngine.swMeasure')}</th>
                      <th scope="col">{t('searchEngine.swEngineNow', { engine: now.title })}</th>
                      <th scope="col">{dest.title}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row">{t('searchEngine.swHitAt5')}</th>
                      <td className="numeric">
                        {t('searchEngine.swPct', { value: comparison.hitAt5[0] })}
                      </td>
                      <td className="numeric">
                        <span className="tag-row">
                          {t('searchEngine.swPct', { value: comparison.hitAt5[1] })}
                          {hit ? (
                            <Tag data-size="sm" data-color={hit.color}>
                              {hit.tag}
                            </Tag>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">{t('searchEngine.swMeanRank')}</th>
                      <td className="numeric">{rank(comparison.meanRank[0])}</td>
                      <td className="numeric">{rank(comparison.meanRank[1])}</td>
                    </tr>
                    <tr>
                      <th scope="row">{t('searchEngine.swLatency')}</th>
                      <td className="numeric">{seconds(t, f, comparison.latencyMs[0])}</td>
                      <td className="numeric">{seconds(t, f, comparison.latencyMs[1])}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="stack-xs">
                <h4 className="engine-sub">{t('searchEngine.swExamples')}</h4>
                <ul className="engine-examples">
                  {comparison.examples.map((x) => (
                    <li key={x.question}>
                      <span className="tag-row">
                        <span className="engine-q">«{x.question}»</span>
                        <Tag data-size="sm" data-color={verdictColors[x.verdict]}>
                          {t(verdictLabels[x.verdict])}
                        </Tag>
                      </span>
                      <span className="engine-hits">
                        <span>
                          <span className="subtle">{t('searchEngine.swFirstNow')}</span>{' '}
                          {x.before ?? t('searchEngine.swNotFound')}
                        </span>
                        <span>
                          <span className="subtle">
                            {t('searchEngine.swFirstWith', { engine: dest.title })}
                          </span>{' '}
                          {x.after ?? t('searchEngine.swNotFound')}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
          <div className="actions">
            <Button
              variant="primary"
              aria-disabled={!compared || undefined}
              onClick={() => {
                if (compared) goStep(5);
              }}
            >
              {t('common.next')}
            </Button>
          </div>
        </div>
      ) : null}

      {step === 5 ? (
        <div className="stack-sm engine-adopt">
          <Heading level={3} data-size="2xs">
            {t('searchEngine.swAdoptHeading', { engine: dest.title })}
          </Heading>
          <ul className="engine-summary">
            {summary.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <p className="engine-p">
            {t.rich('searchEngine.swRetained', {
              engine: now.title,
              days: current.retentionDays,
              undecided: () => <NotDecided />,
            })}
          </p>
          <ReasonField
            value={reason}
            onChange={setReason}
            minLength={minimumReason}
            showError={tried}
            rows={3}
            {...(worse
              ? {
                  description: t('searchEngine.swWorseReason'),
                }
              : {})}
          />
          <div className="actions">
            <Button variant="secondary" onClick={() => goStep(4)}>
              {t('common.back')}
            </Button>
            <Button variant="primary" loading={busy} onClick={adopt}>
              {t('searchEngine.swAdopt')}
            </Button>
            <ApiCallLink
              call={{
                action: t('searchEngine.swAdopt'),
                method: 'POST',
                path: `${base}/engine-switches/${encodeURIComponent(sw?.id ?? '{id}')}/activate`,
                body: { reason: reason.trim() || '…' },
                right,
              }}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
};
