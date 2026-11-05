import {
  Alert,
  Button,
  Field,
  Heading,
  Label,
  Paragraph,
  Select,
  SelectOption,
  Textfield,
} from '@digdir/designsystemet-react';
import { intlLocale } from '@genai/i18n';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useId, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { useAsync } from '../../hooks';
import { useT, type PlainKey } from '../../i18n';
import { minimumReasonLength, reasonProblem } from '../../reason';
import { ErrorState, Loading } from '../../states';
import type {
  ConfigEntry,
  DatasetEngine,
  EngineSwitch,
  EngineSwitchState,
  SwitchEstimate,
  ValidationProblem,
} from '../../types';

const stateLabels: Record<EngineSwitchState, PlainKey> = {
  running: 'engineSwitch.stateRunning',
  failed: 'engineSwitch.stateFailed',
  comparing: 'engineSwitch.stateComparing',
  ready: 'engineSwitch.stateReady',
  activating: 'engineSwitch.stateActivating',
  active: 'engineSwitch.stateActive',
  rolled_back: 'engineSwitch.stateRolledBack',
  cancelled: 'engineSwitch.stateCancelled',
};

/** States the platform moves on by itself, so the section reads the switch again. */
const moving = new Set<EngineSwitchState>(['running', 'comparing', 'activating']);
/** States a switch has left for good; the dataset's engine is read again. */
const ended = new Set<EngineSwitchState>(['active', 'rolled_back', 'cancelled']);

/** A pgvector endpoint on the knowledge server: the only target this section offers (#151). */
const onKnowledgeServer = (e: ConfigEntry) => {
  const spec = e.spec as { engine?: string; options?: { connection?: string } };
  return spec.engine === 'pgvector' && spec.options?.connection === 'knowledge';
};

const sidOf = (id: string) => id.slice(id.lastIndexOf(':') + 1);

/** The organisation a `/tenants/{org}/...` dataset path belongs to; a platform path has none. */
const orgOf = (base: string) => /^\/tenants\/([^/]+)\//.exec(base)?.[1];

/** An agency may only switch to an endpoint the platform shares with it. */
const sharedWith = (e: ConfigEntry, org: string | undefined) => {
  if (!org) return true;
  const tenants = (e.spec as { sharing?: { tenants?: '*' | string[] } }).sharing?.tenants;
  return tenants === '*' || (Array.isArray(tenants) && tenants.includes(decodeURIComponent(org)));
};

const messageOf = (error: unknown) => {
  if (!(error instanceof ApiError)) return undefined;
  const problem = error.problem as (ValidationProblem & { title?: string }) | undefined;
  // The API often repeats its title as the first error's message; show each text once.
  const texts = [problem?.title, ...(problem?.errors?.map((e) => e.message) ?? [])];
  const unique = [...new Set(texts.filter((x): x is string => Boolean(x)))];
  return unique.join(' ') || undefined;
};

type Action = 'retry' | 'cancel' | 'activate' | 'rollback';

const Loaded = ({
  api,
  base,
  engine,
  targets,
  pollMs,
  reload,
}: {
  api: ApiClient;
  base: string;
  engine: DatasetEngine;
  targets: string[];
  pollMs: number;
  reload: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const targetId = useId();
  const [current, setCurrent] = useState<EngineSwitch | undefined>(engine.activeSwitch);
  const [choosing, setChoosing] = useState(false);
  const [target, setTarget] = useState(targets[0] ?? '');
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();
  const [refused, setRefused] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [estimate, setEstimate] = useState<SwitchEstimate | undefined>();
  const modelId = useId();
  // A dataset with no embedding of its own, such as one on Typesense, gets one chosen here (#366).
  const [model, setModel] = useState('');

  useEffect(() => {
    if (!choosing || !target) return;
    const controller = new AbortController();
    setEstimate(undefined);
    api.engineSwitchEstimate(base, target, controller.signal, model || undefined).then(
      (next) => {
        setRefused(undefined);
        setEstimate(next);
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setRefused(messageOf(error) ?? t('engineSwitch.noEstimate'));
      },
    );
    return () => controller.abort();
  }, [api, base, choosing, target, model, t]);

  useEffect(() => setCurrent(engine.activeSwitch), [engine.activeSwitch]);

  const settle = (next: EngineSwitch) => {
    if (ended.has(next.state)) {
      setCurrent(undefined);
      reload();
    } else setCurrent(next);
  };

  useEffect(() => {
    if (!current || !moving.has(current.state)) return;
    const timer = setTimeout(() => {
      api.engineSwitch(base, current.sid).then(settle, () => setCurrent({ ...current }));
    }, pollMs);
    return () => clearTimeout(timer);
  });

  /** Runs one change with the reason, after checking its length. */
  const act = async (min: number, change: (reason: string) => Promise<EngineSwitch>) => {
    const problem = reasonProblem(t, reason, min);
    setReasonError(problem);
    if (problem) return;
    setBusy(true);
    setRefused(undefined);
    try {
      const next = await change(reason.trim());
      setReason('');
      setChoosing(false);
      settle(next);
    } catch (error) {
      setRefused(messageOf(error) ?? t('engineSwitch.failed'));
    } finally {
      setBusy(false);
    }
  };

  const action = (sid: string, name: Action, min = minimumReasonLength) =>
    void act(min, (r) => api.engineSwitchAction(base, sid, name, r));

  const reasonField = (
    <Textfield
      className="reason"
      label={t('common.reason')}
      value={reason}
      onChange={(e) => {
        setReason(e.target.value);
        setReasonError(undefined);
      }}
      error={reasonError}
    />
  );

  const previous = engine.previous;
  const keptUntil = previous
    ? new Intl.DateTimeFormat(intlLocale(f.locale), {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: 'Europe/Oslo',
      }).format(new Date(previous.keptUntil))
    : '';

  // Copy only when re-ingest cannot run and copy can, as for a dataset no pipeline fills.
  const copying = Boolean(estimate && !estimate.reingest.available && estimate.copy?.available);
  const chosen = estimate?.embeddings?.find((e) => e.model === model);
  const embedding = engine.embedding ?? chosen;
  const needsModel = !engine.embedding;
  const offer = copying ? estimate?.copy : estimate?.reingest;

  const start = () =>
    void act(minimumReasonLength, (r) =>
      api.startEngineSwitch(
        base,
        {
          to: target,
          method: copying ? 'copy' : 'reingest',
          ...(embedding ? { embedding } : {}),
        },
        r,
      ),
    );

  const skipLabel = (reason: string, count: number) =>
    reason === 'no_uuid'
      ? t('engineSwitch.skipNoUuid', { count })
      : reason === 'same_uuid'
        ? t('engineSwitch.skipSameUuid', { count })
        : reason === 'no_text'
          ? t('engineSwitch.skipNoText', { count })
          : `${count} ${reason}`;
  const copyCounts = (copy: NonNullable<EngineSwitch['copy']>) => {
    const reasons = Object.entries(copy.skipped).filter(([, n]) => n > 0);
    const total = reasons.reduce((sum, [, n]) => sum + n, 0);
    const named = reasons.map(([reason, count]) => skipLabel(reason, count)).join(', ');
    return t('engineSwitch.copyCounts', {
      copied: copy.copied,
      skipped: total,
      reasons: named ? ` (${named})` : '',
      failed: copy.failed,
    });
  };

  /** Activate when ready, retry when failed; a running or comparing move offers only cancel. */
  const primary =
    current?.state === 'ready' ? (
      <Button
        data-size="sm"
        disabled={busy}
        onClick={() => action(current.sid, 'activate', current.minimumReasonLength)}
      >
        {t('engineSwitch.activate')}
      </Button>
    ) : current?.state === 'failed' ? (
      <Button data-size="sm" disabled={busy} onClick={() => action(current.sid, 'retry')}>
        {t('engineSwitch.retry')}
      </Button>
    ) : null;

  const body = current ? (
    <div className="stack-sm" aria-live="polite">
      <Paragraph data-size="sm">
        {t('engineSwitch.route', { from: current.from, to: current.to })}
      </Paragraph>
      <Paragraph data-size="sm">
        <strong>{t(stateLabels[current.state])}</strong>
        {current.state === 'running'
          ? ` · ${t('engineSwitch.progress', {
              percent: current.progress.percent,
              documents: current.progress.documents,
            })}`
          : ''}
      </Paragraph>
      {current.generation ? (
        <Paragraph data-size="sm">
          {t('engineSwitch.generation', { generation: current.generation })}
        </Paragraph>
      ) : null}
      {current.copy ? (
        <Paragraph data-size="sm">{copyCounts(current.copy)}</Paragraph>
      ) : current.failedDocuments ? (
        <Paragraph data-size="sm">
          {t('engineSwitch.failedDocuments', { count: current.failedDocuments })}
        </Paragraph>
      ) : null}
      {current.subset ? (
        <Paragraph data-size="sm">{t('engineSwitch.subset', { count: current.subset })}</Paragraph>
      ) : null}
      {current.state === 'ready' && current.comparison ? (
        <>
          <Paragraph data-size="sm">
            {t('engineSwitch.comparison', {
              from: current.from,
              to: current.to,
              before: Math.round(current.comparison.hitAt5[0] * 100),
              after: Math.round(current.comparison.hitAt5[1] * 100),
              cases: current.comparison.cases,
            })}
          </Paragraph>
          {current.comparison.verdict === 'worse' ? (
            <Alert data-color="warning" data-size="sm">
              {t('engineSwitch.worse', { min: current.minimumReasonLength })}
            </Alert>
          ) : null}
        </>
      ) : current.state === 'ready' && current.comparisonNote ? (
        <Paragraph data-size="sm">{current.comparisonNote}</Paragraph>
      ) : null}
      {current.error ? (
        <Alert data-color="warning" data-size="sm">
          <Paragraph data-size="sm">{t('engineSwitch.errorLead')}</Paragraph>
          <Paragraph data-size="sm">{current.error.message}</Paragraph>
        </Alert>
      ) : null}
      {current.state !== 'activating' ? (
        <>
          {reasonField}
          <div className="actions-row">
            {primary}
            <Button
              variant="secondary"
              data-size="sm"
              disabled={busy}
              onClick={() => action(current.sid, 'cancel')}
            >
              {t('engineSwitch.cancel')}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  ) : previous ? (
    <div className="stack-sm">
      <Paragraph data-size="sm">
        {t('engineSwitch.keptUntil', { endpoint: previous.endpoint, date: keptUntil })}
      </Paragraph>
      {reasonField}
      <Button
        variant="secondary"
        data-size="sm"
        className="align-start"
        disabled={busy}
        onClick={() => action(sidOf(previous.switch), 'rollback')}
      >
        {t('engineSwitch.rollback', { endpoint: previous.endpoint })}
      </Button>
    </div>
  ) : !engine.canSwitch ? null : targets.length === 0 ? (
    <Paragraph data-size="sm">{t('engineSwitch.noTargets')}</Paragraph>
  ) : choosing ? (
    <div className="stack-sm">
      <Field>
        <Label htmlFor={targetId}>{t('engineSwitch.target')}</Label>
        <Select id={targetId} value={target} onChange={(e) => setTarget(e.target.value)}>
          {targets.map((id) => (
            <SelectOption key={id} value={id}>
              {id}
            </SelectOption>
          ))}
        </Select>
      </Field>
      <Paragraph data-size="sm">
        {t(copying ? 'engineSwitch.copyNote' : 'engineSwitch.reingestNote')}
      </Paragraph>
      {needsModel && estimate?.embeddings?.length ? (
        <Field>
          <Label htmlFor={modelId}>{t('engineSwitch.model')}</Label>
          <Select id={modelId} value={model} onChange={(e) => setModel(e.target.value)}>
            <SelectOption value="">{t('engineSwitch.chooseModel')}</SelectOption>
            {estimate.embeddings.map((e) => (
              <SelectOption key={e.model} value={e.model}>
                {`${e.model} (${e.dimensions})`}
              </SelectOption>
            ))}
          </Select>
        </Field>
      ) : null}
      {offer?.available && estimate ? (
        <Paragraph data-size="sm">
          {t(copying ? 'engineSwitch.copyEstimate' : 'engineSwitch.estimate', {
            costMin: offer.costNok.min,
            costMax: offer.costNok.max,
            minutesMin: offer.durationMinutes.min,
            minutesMax: offer.durationMinutes.max,
            documents: estimate.basis.documents,
            chunks: estimate.basis.chunks ?? 0,
          })}
        </Paragraph>
      ) : estimate ? (
        <Alert data-color="warning" data-size="sm">
          {estimate.reingest.reason ?? t('engineSwitch.notAvailable')}
        </Alert>
      ) : (
        <Loading label={t('engineSwitch.loadingEstimate')} />
      )}
      {reasonField}
      <div className="actions-row">
        <Button
          data-size="sm"
          disabled={busy || !offer?.available || (needsModel && !embedding)}
          onClick={start}
        >
          {t('engineSwitch.start')}
        </Button>
        <Button variant="tertiary" data-size="sm" onClick={() => setChoosing(false)}>
          {t('engineSwitch.close')}
        </Button>
      </div>
    </div>
  ) : (
    <Button
      variant="secondary"
      data-size="sm"
      className="align-start"
      onClick={() => setChoosing(true)}
    >
      {t('engineSwitch.move')}
    </Button>
  );

  return (
    <div className="stack-sm">
      <Paragraph data-size="sm">
        {t('engineSwitch.current', { endpoint: engine.endpoint })}
      </Paragraph>
      {refused ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          {refused}
        </Alert>
      ) : null}
      {body}
    </div>
  );
};

/**
 * A platform dataset's search engine, and its move into the knowledge database (ADR 0025, ADR
 * 0042): start, follow, retry, cancel, activate and roll back a re-ingesting switch.
 */
export const EngineSwitchSection = ({
  api,
  base,
  pollMs = 2000,
}: {
  api: ApiClient;
  /** The dataset's path: `/operator/datasets/{id}`, or `/tenants/{org}/datasets/{id}` under a support session. */
  base: string;
  pollMs?: number;
}) => {
  const t = useT();
  const [state, retry] = useAsync(
    async (signal) => {
      const [engine, endpoints] = await Promise.all([
        api.datasetEngine(base, signal),
        api.configList('/operator/catalog/entries?kind=knowledge-endpoint', signal),
      ]);
      const targets = endpoints.data
        .filter(
          (e) => onKnowledgeServer(e) && sharedWith(e, orgOf(base)) && e.id !== engine.endpoint,
        )
        .map((e) => e.id);
      return { engine, targets };
    },
    [api, base],
  );
  return (
    <section className="stack-sm" aria-label={t('engineSwitch.title')}>
      <Heading level={4} data-size="2xs">
        {t('engineSwitch.title')}
      </Heading>
      {state.status === 'loading' ? (
        <Loading label={t('engineSwitch.loading')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : (
        <Loaded
          api={api}
          base={base}
          engine={state.data.engine}
          targets={state.data.targets}
          pollMs={pollMs}
          reload={retry}
        />
      )}
    </section>
  );
};
