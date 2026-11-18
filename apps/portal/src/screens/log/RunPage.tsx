import { Alert, Button, Heading, Paragraph, Spinner, Tag } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import type { ApiClient } from '../../api';
import { ApiError } from '../../api/error';
import { BackLink } from '../../components/BackLink';
import { formatKroner, isTrialService, serviceLabel, statusOf } from '../../format';
import { useAsync } from '../../hooks';
import { useT, type PlainKey } from '../../i18n';
import { Loading } from '../../states';
import type { Residency, TaskTimeline, TimelineBlock, TimelineStep } from '../../types';
import { dayText } from './DateRange';
import { hasRunFilters, periodDays, trialRuns, type RunFilters } from './filters';
import { actorText, dateKey, formatDuration, relativeTime, whole } from './format';
import { ErasedNotice } from './RunDetail';
import { logHash, trialLabel, useServiceNames } from './RunsTab';
import { Steps } from './Steps';

const residencyKeys: Record<Residency, PlainKey> = {
  norway: 'logRun.residencyNorway',
  eu: 'logRun.residencyEu',
  global: 'logRun.residencyGlobal',
};

/** The Langfuse trace of a run, once the timeline names it. */
export type TracedTimeline = TaskTimeline & { trace?: { id: string; url?: string } };

const short = (text: string) => {
  const plain = text.replace(/\s+/g, ' ').trim();
  return plain.length > 90 ? `${plain.slice(0, 89)}…` : plain;
};

const questionOf = (steps: TimelineStep[]) =>
  steps
    .find((s) => s.type === 'trigger')
    ?.blocks.find((b) => b.kind === 'quote' && !b.label && b.text)?.text;

const resultOf = (steps: TimelineStep[]) =>
  steps
    .findLast((s) => s.type === 'result')
    ?.blocks.find((b) => b.kind === 'answer' || b.kind === 'kv' || b.kind === 'fields');

const Crumb = ({ filters, names }: { filters: RunFilters; names: Record<string, string> }) => {
  const t = useT();
  const days = periodDays(filters, new Date());
  const parts = [
    filters.q ? `«${filters.q}»` : '',
    filters.service === trialRuns
      ? t('logRuns.trialOption')
      : filters.service
        ? (names[filters.service] ?? serviceLabel(filters.service))
        : '',
    filters.status ? statusOf(filters.status, t).text.toLowerCase() : '',
    filters.period === 'today'
      ? t('logRun.crumbToday')
      : filters.period === '7'
        ? t('logRun.crumb7')
        : filters.period === '30'
          ? t('logRun.crumb30')
          : days.from !== days.to
            ? t('logRun.crumbRange', { from: dayText(days.from), to: dayText(days.to) })
            : days.from === dateKey(new Date())
              ? t('logRun.crumbToday')
              : dayText(days.from),
  ].filter(Boolean);
  return (
    <BackLink
      href={logHash(filters)}
      label={
        hasRunFilters(filters)
          ? t('logRun.crumbFiltered', { filters: parts.join(', ') })
          : t('logRun.crumbRuns')
      }
    />
  );
};

const Answer = ({ block }: { block: TimelineBlock }) => {
  const t = useT();
  if (block.kind !== 'answer')
    return (
      <dl className="log-kv">
        {(block.rows ?? []).map(([k, v]) => (
          <div key={k} className="log-kv-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    );
  return (
    <>
      <p className="log-answer-full">{block.text}</p>
      {block.sources?.length ? (
        <>
          <Heading level={3} data-size="2xs">
            {t('logRun.sources')}
          </Heading>
          <ol className="log-sources">
            {block.sources.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </>
      ) : null}
    </>
  );
};

export const RunPage = ({
  api,
  tenant,
  runId,
  filters,
  live = false,
}: {
  api: ApiClient;
  tenant: string;
  runId: string;
  filters: RunFilters;
  live?: boolean;
}) => {
  const t = useT();
  const f = useFormat();
  const names = useServiceNames(api, tenant, live);
  const [state, retry] = useAsync(
    (signal) => api.getTaskTimeline(tenant, runId, signal),
    [api, tenant, runId],
  );
  const [header] = useAsync(
    async (signal) => await api.task(tenant, runId, signal).catch(() => undefined),
    [api, tenant, runId],
  );
  const [catalogue] = useAsync(
    async (signal) => await api.listModels({ all: true }, signal).catch(() => []),
    [api],
  );
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [copy, setCopy] = useState<'' | 'ok' | 'fail'>('');
  const crumb = <Crumb filters={filters} names={names} />;

  if (state.status === 'loading')
    return (
      <div className="stack log-run-page">
        {crumb}
        <Loading label={t('logRun.loading')} />
      </div>
    );
  if (state.status === 'error') {
    const gone = state.error instanceof ApiError && state.error.status === 404;
    return (
      <div className="stack log-run-page">
        {crumb}
        {gone ? (
          <>
            <Heading level={1} data-size="lg">
              {t('logRun.notFoundTitle')}
            </Heading>
            <Paragraph>{t('logRun.notFoundText')}</Paragraph>
          </>
        ) : (
          <>
            <Heading level={1} data-size="lg">
              {t('logRun.run')}
            </Heading>
            <Alert data-color="danger" className="log-alert">
              <Heading level={2} data-size="xs">
                {t('logRun.errorTitle')}
              </Heading>
              <Paragraph>{t('logRun.errorText')}</Paragraph>
              <Button variant="secondary" data-size="sm" onClick={retry}>
                {t('common.tryAgain')}
              </Button>
            </Alert>
          </>
        )}
      </div>
    );
  }

  const run: TracedTimeline = state.data;
  const row = header.status === 'ready' ? header.data : undefined;
  const trial = isTrialService(row?.service ?? run.service);
  const service = row?.service ?? run.service;
  const name = trial
    ? (run.serviceName ?? (row ? trialLabel(row, t) : t('usage.trialRuns')))
    : (names[service] ?? row?.serviceName ?? run.serviceName ?? serviceLabel(service));
  const question = run.erasure ? undefined : questionOf(run.steps);
  const headline = question ?? (run.erasure ? undefined : row?.excerpt);
  const result = resultOf(run.steps);
  const failure = run.steps.findLast((s) => s.type === 'error');
  const running = run.status === 'running' || run.status === 'interrupted';
  const status = statusOf(run.status, t);
  const micro =
    row?.usage !== undefined
      ? row.usage.costMicroNok
      : run.costMicroNok !== undefined
        ? run.costMicroNok
        : run.costOre === undefined
          ? undefined
          : run.costOre === null
            ? null
            : run.costOre * 10_000;
  const costText = running
    ? t('logRun.costPending')
    : micro === undefined
      ? undefined
      : formatKroner(micro, f, t);
  const durationText = running
    ? t('logRun.runningFor', { value: formatDuration(run.durationSeconds, f, t) })
    : formatDuration(run.durationSeconds, f, t);
  const models = [
    ...new Set([
      ...(run.stats?.byModel ?? []).map((m) => m.model),
      ...run.steps.flatMap((s) => (s.model ? [s.model] : [])),
    ]),
  ];
  const known = catalogue.status === 'ready' ? catalogue.data : [];
  const modelText = (id: string) => {
    const found = known.find((m) => m.id === id);
    return found
      ? t('logRun.modelWhere', {
          model: found.name ?? id,
          where: t(residencyKeys[found.residency]),
        })
      : id;
  };
  const isOpen = (step: TimelineStep, i: number) =>
    open[i] ?? (step.type === 'approval' && step.state === 'waiting');
  const allOpen = run.steps.length > 0 && run.steps.every((s, i) => isOpen(s, i));
  const copyId = () => {
    const fail = () => setCopy('fail');
    try {
      if (!navigator.clipboard) return fail();
      navigator.clipboard.writeText(run.trace?.id ?? run.id).then(() => setCopy('ok'), fail);
    } catch {
      fail();
    }
  };

  return (
    <div className="stack log-run-page">
      <div className="stack-sm">
        {crumb}
        <div className="log-run-top-row">
          <div className="stack-sm log-run-heading">
            <Heading level={1} data-size="lg">
              {headline ? t('logRun.title', { service: name, question: short(headline) }) : name}
            </Heading>
            <div className="log-run-meta">
              <Tag data-color={status.color}>
                {running ? <Spinner aria-hidden="true" data-size="2xs" /> : null}
                {status.text}
              </Tag>
              <span>{relativeTime(run.startedAt, t, f)}</span>
              <span>{durationText}</span>
              {costText ? <span>{costText}</span> : null}
              {!trial ? (
                <span>
                  <a href={`#/services/${encodeURIComponent(service)}`}>
                    {row?.version
                      ? t('logRun.serviceVersion', { service: name, version: row.version })
                      : name}
                  </a>
                </span>
              ) : null}
              {row?.actor ? (
                <span>{t('logRun.startedBy', { actor: actorText(row.actor, t) })}</span>
              ) : null}
            </div>
          </div>
          <div className="tag-row">
            <Button variant="secondary" data-size="sm" onClick={copyId}>
              {t('logRun.copyTraceId')}
            </Button>
            {!trial ? (
              <Button asChild variant="primary" data-size="sm">
                <a href={`#/services/${encodeURIComponent(service)}`}>{t('logRun.openService')}</a>
              </Button>
            ) : null}
          </div>
        </div>
        {copy ? (
          <p role="status" className={copy === 'ok' ? 'log-copy-ok' : 'log-copy-fail'}>
            {copy === 'fail'
              ? t('logRun.copyFailed')
              : run.trace
                ? t('logRun.copiedTrace')
                : t('logRun.copied')}
          </p>
        ) : null}
        {run.erasure ? <ErasedNotice erasure={run.erasure} /> : null}
      </div>

      {question ? (
        <section aria-labelledby="run-q" className="log-section">
          <Heading level={2} data-size="sm" id="run-q">
            {t('logRun.question')}
          </Heading>
          <p className="log-question">{question}</p>
        </section>
      ) : null}

      {!run.erasure ? (
        <section aria-labelledby="run-a" className="log-section">
          <Heading level={2} data-size="sm" id="run-a">
            {t('logRun.answer')}
          </Heading>
          {run.status === 'failed' ? (
            <Alert data-color="danger" data-size="sm">
              <Heading level={3} data-size="2xs">
                {t('logRun.failed')}
              </Heading>
              <Paragraph data-size="sm">{failure?.summary ?? t('logRun.failedNoCause')}</Paragraph>
            </Alert>
          ) : null}
          {result ? (
            <Answer block={result} />
          ) : running ? (
            <Paragraph>{t('logRun.answerRunning')}</Paragraph>
          ) : run.status !== 'failed' ? (
            <Paragraph>{t('logRun.noAnswer')}</Paragraph>
          ) : null}
        </section>
      ) : null}

      {run.steps.length > 0 ? (
        <section aria-labelledby="run-steps" className="log-section">
          <div className="log-steps-head">
            <Heading level={2} data-size="sm" id="run-steps">
              {t('logRun.stepsTitle')}
            </Heading>
            <Button
              variant="tertiary"
              data-size="sm"
              onClick={() => setOpen(Object.fromEntries(run.steps.map((_, i) => [i, !allOpen])))}
            >
              {allOpen ? t('logRun.closeAll') : t('logRun.openAll')}
            </Button>
          </div>
          <Paragraph data-size="sm" className="meta">
            {t('logRun.stepsLead')}
          </Paragraph>
          <Steps
            steps={run.steps}
            media={{ task: runId, load: api.media }}
            isOpen={isOpen}
            onToggle={(i) =>
              setOpen((o) => ({ ...o, [i]: !isOpen(run.steps[i] as TimelineStep, i) }))
            }
            {...(live ? { approvalDetails: [] } : {})}
          />
        </section>
      ) : null}

      <details className="log-technical">
        <summary>{t('logRun.technical')}</summary>
        <dl>
          {run.trace ? (
            <>
              <dt>{t('logRun.traceId')}</dt>
              <dd className="log-mono">{run.trace.id}</dd>
            </>
          ) : null}
          <dt>{t('logRun.runId')}</dt>
          <dd className="log-mono">{run.id}</dd>
          {run.inputTokens !== undefined && run.outputTokens !== undefined ? (
            <>
              <dt>{t('logRun.tokens')}</dt>
              <dd>
                {t('logRun.tokensSplit', {
                  input: whole(run.inputTokens, f),
                  output: whole(run.outputTokens, f),
                })}
              </dd>
            </>
          ) : null}
          {models.length > 0 ? (
            <>
              <dt>{t('logRun.model')}</dt>
              <dd>{models.map(modelText).join('; ')}</dd>
            </>
          ) : null}
          {run.trace?.url ? (
            <>
              <dt>{t('logRun.traceTool')}</dt>
              <dd>
                <a href={run.trace.url} target="_blank" rel="noreferrer">
                  {t('logRun.openInLangfuse')}
                </a>
              </dd>
            </>
          ) : null}
        </dl>
      </details>
    </div>
  );
};
