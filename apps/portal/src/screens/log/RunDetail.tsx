import {
  Alert,
  Button,
  Field,
  Heading,
  Label,
  Select,
  Spinner,
  Tag,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api';
import { Icon } from '../../components/Icon';
import { useFormat } from '@genai/i18n/react';
import {
  approver,
  BATCH_TOTAL,
  batchItems,
  batchItemSteps,
  batchStatusColors,
  batchStatusKeys,
  revealReasonKeys,
  revealReasons,
  runExtras,
  type ChangeEntry,
} from '../../data/log';
import { useT } from '../../i18n';
import { useAsync } from '../../hooks';
import { ErrorState, Loading } from '../../states';
import type { TaskStatus, TaskTimeline, TimelineStep } from '../../types';
import { actorText, formatDuration, relativeTime, whole } from './format';
import { notPricedLabel, serviceLabel, statusOf } from '../../format';
import { BatchView } from './BatchView';
import { Steps } from './Steps';

type Flash = { text: string; color: 'success' | 'info' } | undefined;

const pseudonymOf = (caller: string) => /\((A-[A-Z0-9]{4})\)/.exec(caller)?.[1];

const traceIcon = 'M4 12h4l3-7 4 14 3-7h2';

export const RunDetail = ({
  api,
  tenant,
  runId,
  itemIndex,
  canReveal,
  live = false,
  onStatus,
  onChange,
}: {
  api: ApiClient;
  tenant: string;
  runId: string;
  itemIndex: number | undefined;
  canReveal: boolean;
  live?: boolean;
  onStatus: (runId: string, status: TaskStatus) => void;
  onChange: (entry: ChangeEntry) => void;
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
  const extras = live ? undefined : runExtras[runId];
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [decision, setDecision] = useState<
    { ok: boolean; comment: string; by: string; at: string } | undefined
  >();
  const [comment, setComment] = useState('');
  const [commentError, setCommentError] = useState('');
  const [flash, setFlash] = useState<Flash>();
  const [retried, setRetried] = useState(false);
  const [done, setDone] = useState(138);
  const [cancelled, setCancelled] = useState(false);
  const [reveal, setReveal] = useState<{
    open: boolean;
    reason: string;
    error: string;
    shown?: string;
  }>({ open: false, reason: '', error: '' });

  const batchRunning = Boolean(extras?.batch) && !cancelled && done < BATCH_TOTAL;
  useEffect(() => {
    if (!batchRunning) return;
    const timer = setInterval(() => setDone((d) => Math.min(BATCH_TOTAL, d + 1)), 1200);
    return () => clearInterval(timer);
  }, [batchRunning]);

  if (state.status === 'loading') return <Loading label={t('logRun.loading')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const run: TaskTimeline = state.data;
  const isBatch = Boolean(extras?.batch);
  const items = isBatch ? batchItems(done, cancelled) : [];
  const child = itemIndex !== undefined && isBatch ? items[itemIndex - 1] : undefined;
  const pseudonym = pseudonymOf(run.caller);
  const started = relativeTime(run.startedAt, t, f);

  const status: TaskStatus = isBatch
    ? cancelled
      ? 'cancelled'
      : done >= BATCH_TOTAL
        ? 'completed'
        : 'running'
    : decision
      ? decision.ok
        ? 'completed'
        : 'cancelled'
      : retried
        ? 'running'
        : run.status;

  const runSteps = (): TimelineStep[] => {
    if (retried) {
      const failedAt = run.steps.findIndex((s) => s.state === 'failed');
      if (failedAt > 0) {
        const last = run.steps[failedAt - 1] as TimelineStep;
        const rest = { ...last, state: 'running' as const };
        delete rest.durationSeconds;
        delete rest.tokens;
        return [...run.steps.slice(0, failedAt - 1), rest];
      }
    }
    if (!decision) return run.steps;
    const approvalAt = run.steps.findIndex((s) => s.type === 'approval');
    const after = extras?.afterApproval;
    return run.steps.map((s, i) => {
      if (i === approvalAt)
        return {
          ...s,
          state: decision.ok ? 'ok' : 'rejected',
          summary: `${t(decision.ok ? 'logRun.approvedBy' : 'logRun.rejectedBy', { by: decision.by })}${decision.comment ? t('logRun.withComment', { comment: decision.comment }) : ''}`,
        };
      if (i > approvalAt && s.state === 'pending')
        return decision.ok
          ? {
              ...s,
              title: after?.approvedTitle ?? s.title,
              summary: after?.approvedSummary ?? t('logRun.deliveredAfterApproval'),
              state: 'ok',
              at: run.durationSeconds + 21,
              blocks: after ? [{ kind: 'kv', rows: after.approvedRows }] : s.blocks,
            }
          : {
              ...s,
              title: t('logRun.notDelivered'),
              summary: t('logRun.stoppedRejected'),
              state: 'cancelled',
              at: run.durationSeconds + 21,
            };
      return s;
    });
  };

  const steps = child ? batchItemSteps(child) : isBatch ? [] : runSteps();
  const key = (i: number) => `${child ? child.i : 'run'}:${i}`;
  const isOpen = (step: TimelineStep, i: number) =>
    open[key(i)] ?? (step.type === 'approval' && step.state === 'waiting' && !decision);
  const allOpen = steps.length > 0 && steps.every((s, i) => isOpen(s, i));

  const tokens = run.inputTokens + run.outputTokens;
  const finished = items.filter((i) => i.status === 'Fullført');
  const batchTokens = finished.reduce((a, i) => a + i.tokens, 0);
  const facts: { l: string; v: string; sub?: string }[] = child
    ? [
        {
          l: t('logRun.totalTime'),
          v:
            child.status === 'Fullført'
              ? `${f.decimal(2.1)} s`
              : child.status === 'Kjører'
                ? t('logRun.inProgress')
                : '–',
        },
        child.tokens
          ? {
              l: t('logRun.tokens'),
              v: whole(child.tokens, f),
              sub: t('logRun.tokensSplit', {
                input: whole(child.tokens - 180, f),
                output: whole(180, f),
              }),
            }
          : { l: t('logRun.tokens'), v: '–' },
        { l: t('logRun.cost'), v: child.tokens ? t('common.ore', { value: f.decimal(1.4) }) : '–' },
        { l: t('logRun.steps'), v: String(steps.length) },
      ]
    : isBatch
      ? [
          {
            l: t('logRun.totalTime'),
            v:
              status === 'running'
                ? t('logRun.soFar', { value: formatDuration(run.durationSeconds, f) })
                : t('logRun.batchDuration', { hours: 1, minutes: 58 }),
          },
          {
            l: t('logRun.tokens'),
            v: whole(batchTokens, f),
            sub: t('logRun.average', {
              value: whole(finished.length ? batchTokens / finished.length : 0, f),
            }),
          },
          {
            l: t('logRun.costSoFar'),
            v: t('common.ore', { value: whole((batchTokens / 1000) * 0.52, f) }),
          },
          { l: t('logRun.items'), v: String(BATCH_TOTAL) },
        ]
      : [
          {
            l: t('logRun.totalTime'),
            v:
              decision && extras?.afterApproval
                ? extras.afterApproval.totalTime
                : run.status === 'running' || run.status === 'interrupted'
                  ? t('logRun.soFar', { value: formatDuration(run.durationSeconds, f) })
                  : formatDuration(run.durationSeconds, f),
          },
          {
            l: t('logRun.tokens'),
            v: whole(tokens, f),
            sub: t('logRun.tokensSplit', {
              input: whole(run.inputTokens, f),
              output: whole(run.outputTokens, f),
            }),
          },
          {
            l: t('logRun.cost'),
            v: ore(
              live && header.status === 'ready' && header.data
                ? header.data.usage.costMicroNok === null ||
                  header.data.usage.costMicroNok === undefined
                  ? null
                  : header.data.usage.costMicroNok / 10_000
                : run.costOre,
            ),
          },
          { l: t('logRun.steps'), v: String(steps.length) },
        ];

  const detail = extras?.triggerDetail ?? `${run.trigger} · ${run.caller}`;
  const meta = child
    ? t('logRun.metaItem', {
        index: child.i,
        total: BATCH_TOTAL,
        service: run.service,
        org: child.org,
      })
    : isBatch
      ? t('logRun.metaBatch', { caller: run.caller, started: started.toLowerCase(), detail })
      : live
        ? header.status === 'ready' && header.data
          ? t('logRun.metaLive', { actor: actorText(header.data.actor, t), started })
          : started
        : `${detail} · ${started}`;
  const excerpt = header.status === 'ready' ? header.data?.excerpt : undefined;
  const name = child
    ? child.name
    : live
      ? ((header.status === 'ready' ? header.data?.serviceName : undefined) ??
        (state.status === 'ready' ? state.data.serviceName : undefined) ??
        serviceLabel(run.service))
      : run.service;
  const skippedSteps = steps.filter((s) => s.state === 'skipped').length;
  const display = child
    ? {
        text: t(batchStatusKeys[child.status]),
        color: batchStatusColors[child.status],
        running: child.status === 'Kjører',
      }
    : status === 'completed' && skippedSteps > 0
      ? {
          text: t('logRun.completedSkipped', { count: skippedSteps }),
          color: 'warning' as const,
          running: false,
        }
      : { ...statusOf(status, t), running: status === 'running' };
  const traces = extras?.traces ?? [{ note: t('logRun.defaultTrace') }];
  const hasApproval = run.steps.some((s) => s.type === 'approval');
  const revealable = canReveal && Boolean(pseudonym) && Boolean(extras?.revealedName) && !child;

  const decide = (ok: boolean) => {
    if (!ok && !comment.trim()) {
      setCommentError(t('logRun.rejectProblem'));
      return;
    }
    const at = relativeTime(new Date().toISOString(), t, f);
    setDecision({ ok, comment: comment.trim(), by: approver, at });
    onStatus(runId, ok ? 'completed' : 'cancelled');
    setFlash({
      text: ok
        ? (extras?.afterApproval?.approvedFlash ?? t('logRun.approvedFlash'))
        : (extras?.afterApproval?.rejectedFlash ?? t('logRun.rejectedFlash')),
      color: ok ? 'success' : 'info',
    });
  };

  const confirmReveal = () => {
    if (!reveal.reason) {
      setReveal((r) => ({ ...r, error: t('logRun.reasonProblem') }));
      return;
    }
    const person = extras?.revealedName ?? '';
    const reason = t(revealReasonKeys[reveal.reason as (typeof revealReasons)[number]]);
    setReveal({
      open: false,
      reason: '',
      error: '',
      shown: t('logRun.revealed', { pseudonym: pseudonym ?? '', person, reason }),
    });
    onChange({
      when: relativeTime(new Date().toISOString(), t, f),
      type: 'Tilgang',
      what: t('logRun.revealedChange', { pseudonym: pseudonym ?? '', runId, service: run.service }),
      who: approver,
      why: reason,
    });
  };

  return (
    <>
      {child ? (
        <nav aria-label={t('logRun.breadcrumbs')} className="crumbs">
          <a href={`#/log/${runId}`} className="log-back">
            <Icon d="M15 6l-6 6 6 6" size={16} />
            {run.service}
          </a>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{child.name}</span>
        </nav>
      ) : null}
      <div className="log-run-head">
        <div className="log-run-title">
          <div className="row-wrap">
            <Heading level={2} data-size="xs" id="detalj-h">
              {name}
            </Heading>
            <Tag data-color={display.color}>
              {display.running ? <Spinner aria-hidden="true" data-size="2xs" /> : null}
              {display.text}
            </Tag>
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
            {isBatch && !child && status === 'running' ? (
              <Button
                variant="secondary"
                data-size="sm"
                onClick={() => {
                  setCancelled(true);
                  onStatus(runId, 'cancelled');
                  setFlash({
                    text: t('logRun.cancelledFlash', { count: BATCH_TOTAL - done }),
                    color: 'info',
                  });
                }}
              >
                {t('logRun.cancelJob')}
              </Button>
            ) : null}
            {!child && status === 'failed' ? (
              <Button
                variant="primary"
                data-size="sm"
                onClick={() => {
                  setRetried(true);
                  onStatus(runId, 'running');
                  setFlash({ text: t('logRun.retriedFlash'), color: 'info' });
                }}
              >
                {t('logRun.retry')}
              </Button>
            ) : null}
          </div>
        </div>
        <span className="log-meta">{meta}</span>
        {excerpt ? <p className="meta">{excerpt}</p> : null}
        <ul aria-label={t('logRun.tracing')} className="plain-list log-traces">
          {traces.map((t) => (
            <li key={t.note}>
              <Icon d={traceIcon} size={16} strokeWidth={1.6} />
              <span>{t.note}</span>
              {t.link ? <a href="#/developer/runs">{t.link}</a> : null}
            </li>
          ))}
        </ul>
        <div className="stack-sm">
          {revealable && !reveal.shown && !reveal.open ? (
            <Button
              variant="tertiary"
              data-size="sm"
              aria-expanded={false}
              className="log-self-start"
              onClick={() => setReveal((r) => ({ ...r, open: true }))}
            >
              {t('logRun.reveal')}
            </Button>
          ) : null}
          {revealable && reveal.open && !reveal.shown ? (
            <div className="log-reveal">
              <p>{t('logRun.revealIntro')}</p>
              <Field>
                <Label htmlFor="rv-grunn">{t('logRun.reason')}</Label>
                <Select
                  id="rv-grunn"
                  value={reveal.reason}
                  aria-invalid={reveal.error ? true : undefined}
                  onChange={(e) => setReveal((r) => ({ ...r, reason: e.target.value, error: '' }))}
                >
                  <Select.Option value="">{t('logRun.choose')}</Select.Option>
                  {revealReasons.map((r) => (
                    <Select.Option key={r} value={r}>
                      {t(revealReasonKeys[r])}
                    </Select.Option>
                  ))}
                </Select>
                {reveal.error ? <ValidationMessage>{reveal.error}</ValidationMessage> : null}
              </Field>
              <div className="tag-row">
                <Button variant="primary" data-size="sm" onClick={confirmReveal}>
                  {t('logRun.reveal')}
                </Button>
                <Button
                  variant="secondary"
                  data-size="sm"
                  onClick={() => setReveal({ open: false, reason: '', error: '' })}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          ) : null}
          {reveal.shown ? (
            <Alert data-color="warning" data-size="sm">
              {reveal.shown}
            </Alert>
          ) : null}
          {hasApproval && !child ? (
            <p className="meta log-approval-note">{t('logRun.approvalNote')}</p>
          ) : null}
        </div>
        <dl className="log-facts">
          {facts.map((f) => (
            <div key={f.l}>
              <dt>{f.l}</dt>
              <dd className="log-fact-value">{f.v}</dd>
              {f.sub ? <dd className="meta">{f.sub}</dd> : null}
            </div>
          ))}
        </dl>
        <div aria-live="polite">
          {flash ? (
            <Alert data-color={flash.color} data-size="sm">
              {flash.text}
            </Alert>
          ) : null}
        </div>
      </div>
      {isBatch && !child ? (
        <BatchView items={items} status={status} cancelled={cancelled} runId={runId} />
      ) : null}
      {steps.length > 0 ? (
        <Steps
          steps={steps}
          isOpen={isOpen}
          onToggle={(i) => {
            const step = steps[i] as TimelineStep;
            setOpen((o) => ({ ...o, [key(i)]: !isOpen(step, i) }));
          }}
          approval={{
            ...(live ? { details: [] } : {}),
            decision,
            comment,
            error: commentError,
            onComment: (v) => {
              setComment(v);
              setCommentError('');
            },
            onApprove: () => decide(true),
            onReject: () => decide(false),
          }}
        />
      ) : null}
    </>
  );
};
