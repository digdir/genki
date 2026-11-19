import { Alert, Button, Heading, Paragraph, Tag } from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { ApiClient } from '../../api';
import { useFormat } from '@genai/i18n/react';
import { useT } from '../../i18n';
import { useAsync } from '../../hooks';
import { ErrorState, Loading } from '../../states';
import type { RunErasure, TaskStatus, TaskTimeline, TimelineStep } from '../../types';
import { actorText, formatDuration, relativeTime, whole } from './format';
import { notPricedLabel, serviceLabel, statusOf } from '../../format';
import { Steps } from './Steps';

export const ErasedNotice = ({ erasure }: { erasure: RunErasure }) => {
  const t = useT();
  const f = useFormat();
  const when = erasure.at ? f.dateTime(erasure.at) : undefined;
  const reason =
    erasure.reason === 'conversation-deleted'
      ? when
        ? t('logRun.erasedConversation', { when })
        : t('logRun.erasedConversationUndated')
      : erasure.reason === 'retention'
        ? when
          ? t('logRun.erasedRetention', { when })
          : t('logRun.erasedRetentionUndated')
        : when
          ? t('logRun.erasedOther', { when })
          : t('logRun.erasedOtherUndated');
  return (
    <Alert data-color="info" data-size="sm" role="note" aria-labelledby="erased-h">
      <Heading level={3} data-size="2xs" id="erased-h">
        {t('logRun.erasedTitle')}
      </Heading>
      <Paragraph data-size="sm">
        {reason} {t('logRun.erasedKept')}
      </Paragraph>
    </Alert>
  );
};

export const RunDetail = ({
  api,
  tenant,
  runId,
  live = false,
}: {
  api: ApiClient;
  tenant: string;
  runId: string;
  live?: boolean;
}) => {
  const t = useT();
  const f = useFormat();
  const ore = (n: number | null) =>
    n === null ? notPricedLabel(t) : t('common.ore', { value: f.decimal(n, n % 1 ? 1 : 0) });
  const [state, retry] = useAsync(
    (signal) => api.getTaskTimeline(tenant, runId, signal),
    [api, tenant, runId],
  );
  const [header] = useAsync(
    async (signal) =>
      live ? await api.task(tenant, runId, signal).catch(() => undefined) : undefined,
    [api, tenant, runId, live],
  );
  const [open, setOpen] = useState<Record<string, boolean>>({});

  if (state.status === 'loading')
    return <Loading label={t('logRun.loading')} shape="detail" onRetry={retry} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const run: TaskTimeline = state.data;
  const started = relativeTime(run.startedAt, t, f);
  const status: TaskStatus = run.status;

  const steps = run.steps;
  const key = (i: number) => `run:${i}`;
  const isOpen = (step: TimelineStep, i: number) =>
    open[key(i)] ?? (step.type === 'approval' && step.state === 'waiting');
  const allOpen = steps.length > 0 && steps.every((s, i) => isOpen(s, i));

  const usageShown = run.inputTokens !== undefined && run.outputTokens !== undefined;
  const tokens = (run.inputTokens ?? 0) + (run.outputTokens ?? 0);
  const facts: { l: string; v: string; sub?: string }[] = [
    {
      l: t('logRun.totalTime'),
      v:
        run.status === 'running' || run.status === 'interrupted'
          ? t('logRun.soFar', { value: formatDuration(run.durationSeconds, f, t) })
          : formatDuration(run.durationSeconds, f, t),
    },
    ...(usageShown
      ? [
          {
            l: t('logRun.tokens'),
            v: whole(tokens, f),
            sub: t('logRun.tokensSplit', {
              input: whole(run.inputTokens ?? 0, f),
              output: whole(run.outputTokens ?? 0, f),
            }),
          },
          {
            l: t('logRun.cost'),
            v: ore(
              live && header.status === 'ready' && header.data?.usage
                ? header.data.usage.costMicroNok === null ||
                  header.data.usage.costMicroNok === undefined
                  ? null
                  : header.data.usage.costMicroNok / 10_000
                : run.costMicroNok !== undefined
                  ? run.costMicroNok === null
                    ? null
                    : run.costMicroNok / 10_000
                  : (run.costOre ?? null),
            ),
          },
        ]
      : []),
    { l: t('logRun.steps'), v: String(steps.length) },
  ];

  const meta = live
    ? header.status === 'ready' && header.data
      ? t('logRun.metaLive', { actor: actorText(header.data.actor, t), started })
      : started
    : `${run.trigger} · ${run.caller} · ${started}`;
  const excerpt = header.status === 'ready' ? header.data?.excerpt : undefined;
  const name = live
    ? ((header.status === 'ready' ? header.data?.serviceName : undefined) ??
      run.serviceName ??
      serviceLabel(run.service))
    : run.service;
  const skippedSteps = steps.filter((s) => s.state === 'skipped').length;
  const display =
    status === 'completed' && skippedSteps > 0
      ? {
          text: t('logRun.completedSkipped', { count: skippedSteps }),
          color: 'warning' as const,
          running: false,
        }
      : { ...statusOf(status, t), running: status === 'running' };
  const hasApproval = run.steps.some((s) => s.type === 'approval');

  return (
    <>
      <div className="log-run-head">
        <div className="log-run-title">
          <div className="row-wrap">
            <Heading level={2} data-size="xs" id="detalj-h">
              {name}
            </Heading>
            <Tag data-color={display.color}>{display.text}</Tag>
          </div>
          <div className="tag-row">
            {steps.length > 0 ? (
              <Button
                variant="tertiary"
                data-size="sm"
                onClick={() =>
                  setOpen((o) => {
                    const next = { ...o };
                    steps.forEach((_, i) => (next[key(i)] = !allOpen));
                    return next;
                  })
                }
              >
                {allOpen ? t('logRun.closeAll') : t('logRun.openAll')}
              </Button>
            ) : null}
          </div>
        </div>
        <span className="log-meta">{meta}</span>
        {run.erasure ? <ErasedNotice erasure={run.erasure} /> : null}
        {excerpt && !run.erasure ? <p className="meta">{excerpt}</p> : null}
        {hasApproval ? <p className="meta log-approval-note">{t('logRun.approvalNote')}</p> : null}
        <dl className="log-facts">
          {facts.map((f) => (
            <div key={f.l}>
              <dt>{f.l}</dt>
              <dd className="log-fact-value">{f.v}</dd>
              {f.sub ? <dd className="meta">{f.sub}</dd> : null}
            </div>
          ))}
        </dl>
      </div>
      {steps.length > 0 ? (
        <Steps
          steps={steps}
          media={{ task: runId, load: api.media }}
          isOpen={isOpen}
          onToggle={(i) => {
            const step = steps[i] as TimelineStep;
            setOpen((o) => ({ ...o, [key(i)]: !isOpen(step, i) }));
          }}
          {...(live ? { approvalDetails: [] } : {})}
        />
      ) : null}
    </>
  );
};
