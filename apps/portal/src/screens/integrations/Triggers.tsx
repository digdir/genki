import { Alert, Button, Paragraph, Textfield } from '@digdir/designsystemet-react';
import { createFormat, type Format } from '@genai/i18n';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import type { ApiClient } from '../../api';
import type { TriggerRunView, TriggerView } from '../../api/triggers';
import { reasonProblem } from '../../components/ReasonField';
import { navigate, useAsync } from '../../hooks';
import { translator, useT, type PlainKey, type T } from '../../i18n';
import { useRights } from '../../Shell';
import { problemText } from '../service/ServiceKeys';
import type { ItemStatus } from '../../data/integrations';
import { ItemList, type ItemRowData } from './ItemList';

type Flash = (text: string, color?: 'success' | 'info' | 'danger') => void;

const kindKeys: Record<TriggerView['kind'], PlainKey> = {
  'document-arrives': 'integTriggers.kindDocument',
  'queue-message': 'integTriggers.kindQueue',
  schedule: 'integTriggers.kindSchedule',
};

const statusIds: Record<TriggerView['status'], ItemStatus> = {
  active: 'Aktiv',
  failing: 'Feiler',
  paused: 'Satt på pause',
};

const weekdayKeys: PlainKey[] = [
  'integTriggers.sunday',
  'integTriggers.monday',
  'integTriggers.tuesday',
  'integTriggers.wednesday',
  'integTriggers.thursday',
  'integTriggers.friday',
  'integTriggers.saturday',
];
const pad = (n: string) => n.padStart(2, '0');

const nbT = translator('nb');
const nbFormat = createFormat('nb');

export const describeSchedule = (cron: string, t: T = nbT, f: Format = nbFormat) => {
  const [minute, hour, day, month, weekday, ...rest] = cron.trim().split(/\s+/);
  const plain = (v?: string) => v !== undefined && /^\d+$/.test(v);
  const other = t('integTriggers.scheduleOther', { cron });
  if (rest.length || day !== '*' || month !== '*' || !plain(minute)) return other;
  if (hour === '*' && weekday === '*') return t('integTriggers.everyHour');
  if (!plain(hour)) return other;
  const time = `${pad(hour ?? '')}${f.locale === 'en' ? ':' : '.'}${pad(minute ?? '')}`;
  if (weekday === '*')
    return t(Number(hour) < 6 ? 'integTriggers.everyNight' : 'integTriggers.everyDay', { time });
  if (plain(weekday)) {
    const key = weekdayKeys[Number(weekday) % 7];
    return key ? t('integTriggers.everyWeekday', { weekday: t(key), time }) : other;
  }
  return other;
};

export const triggerName = (tr: TriggerView, t: T = nbT, f: Format = nbFormat) =>
  tr.kind === 'schedule'
    ? describeSchedule(tr.target, t, f)
    : tr.kind === 'queue-message'
      ? t('integTriggers.queueName', { target: tr.target })
      : t('integTriggers.folderName', { target: tr.target });

const sourceOf = (tr: TriggerView, t: T) =>
  tr.kind === 'schedule'
    ? t('integTriggers.sourceSchedule')
    : tr.kind === 'queue-message'
      ? t('integTriggers.sourceQueue', { target: tr.target })
      : t('integTriggers.sourceFolder', { target: tr.target });

const countText = (tr: TriggerView, t: T, f: Format) =>
  tr.nextRunAt
    ? t('integTriggers.nextRun', { at: f.dateTime(tr.nextRunAt, 'medium') })
    : t('integTriggers.runs7d', { count: tr.runs7d });

export const problemOf = (tr: TriggerView, t: T = nbT, f: Format = nbFormat) =>
  t('integTriggers.problem', { name: triggerName(tr, t, f) });

const timelineHref = (run: TriggerRunView) =>
  run.task ? `#/log/${encodeURIComponent(run.task)}` : undefined;

export const Triggers = ({
  api,
  tenant,
  triggers,
  open,
  onToggle,
  onChanged,
  onFlash,
}: {
  api: ApiClient;
  tenant: string;
  triggers: TriggerView[];
  open: string | undefined;
  onToggle: (id: string) => void;
  onChanged: () => void;
  onFlash: Flash;
}) => {
  const t = useT();
  const f = useFormat();
  const { has } = useRights();
  const canManage = has('manage-services');
  const [pausing, setPausing] = useState<TriggerView>();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState('');
  const runs = useRuns(api, tenant, open);

  const togglePause = async () => {
    if (!pausing) return;
    const problem = reasonProblem(reason, t);
    if (problem) return setReasonError(problem);
    const resume = pausing.status === 'paused';
    try {
      await api.triggers.pause(tenant, pausing.id, !resume, reason.trim());
      onFlash(
        t(resume ? 'integTriggers.resumed' : 'integTriggers.paused', {
          name: triggerName(pausing, t, f),
        }),
      );
      setPausing(undefined);
      onChanged();
    } catch (e) {
      setReasonError(problemText(e, t));
    }
  };

  const items: ItemRowData[] = triggers.map((tr) => {
    const last = tr.lastRun;
    const href = last ? timelineHref(last) : undefined;
    const error: ItemRowData['error'] =
      tr.status === 'failing' && last
        ? {
            what: t('integTriggers.failedToStart'),
            why: t('integTriggers.failedToStartWhy'),
            code: last.error ?? t('common.unknown'),
            color: 'danger',
            actions: [
              {
                label: t('integTriggers.goToService'),
                variant: 'primary',
                onClick: () => navigate(`#/services/${encodeURIComponent(tr.service)}`),
              },
            ],
          }
        : last?.outcome === 'failed' && href
          ? {
              what: t('integrations.lastRunFailed'),
              why: t('integTriggers.triggerWorks'),
              code: last.error ?? t('common.unknown'),
              color: 'info',
              actions: [
                {
                  label: t('integTriggers.seeRun'),
                  variant: 'secondary',
                  onClick: () => navigate(href),
                },
              ],
            }
          : undefined;
    const paused = tr.status === 'paused';
    const loaded = open === tr.id ? runs : undefined;
    return {
      id: tr.id,
      name: triggerName(tr, t, f),
      status: statusIds[tr.status],
      sub: t('integrations.triggerSub', { kind: t(kindKeys[tr.kind]), service: tr.serviceName }),
      metaLabel: t('integrations.lastEvent'),
      meta: `${
        last
          ? t(last.outcome === 'failed' ? 'integTriggers.lastFailed' : 'integTriggers.lastAt', {
              at: f.dateTime(last.at, 'medium'),
            })
          : t('integrations.noneYet')
      } · ${countText(tr, t, f)}`,
      ...(error ? { error } : {}),
      rows: [
        { k: t('integrations.rowType'), v: t(kindKeys[tr.kind]) },
        { k: t('integrations.rowSource'), v: sourceOf(tr, t) },
        { k: t('integrations.rowStarts'), v: tr.serviceName },
        ...(paused && tr.pausedAt
          ? [{ k: t('integTriggers.pausedAt'), v: f.dateTime(tr.pausedAt, 'medium') }]
          : []),
      ],
      ...(loaded
        ? {
            events: loaded.map((r) => {
              const link = timelineHref(r);
              return {
                when: f.dateTime(r.at, 'medium'),
                text: `${
                  r.code === 'quota_exhausted'
                    ? t('integTriggers.runQuota')
                    : (r.error ??
                      t(
                        r.outcome === 'completed'
                          ? 'integTriggers.runCompleted'
                          : 'taskStatus.failed',
                      ))
                }${
                  r.costMicroNok === undefined
                    ? ''
                    : t('integTriggers.runCost', {
                        cost: f.currency(r.costMicroNok / 1_000_000, { digits: 2 }),
                      })
                }`,
                status: r.outcome === 'completed' ? 'Fullført' : 'Feilet',
                ...(link ? { href: link, link: t('integTriggers.seeRun') } : {}),
              };
            }),
          }
        : {}),
      actions: canManage
        ? [
            {
              label: paused ? t('integrations.startAgain') : t('integrations.pause'),
              variant: 'secondary',
              onClick: () => {
                setPausing(tr);
                setReason('');
                setReasonError('');
              },
            },
          ]
        : [],
    };
  });

  return (
    <div className="stack-md">
      <ItemList
        items={items}
        open={open}
        onToggle={onToggle}
        empty={{
          title: t('integrations.noTriggers'),
          text: t('integrations.noTriggersText'),
        }}
      />
      {pausing ? (
        <Alert data-color="warning" data-size="sm">
          <Paragraph data-size="sm">
            {t(
              pausing.status === 'paused'
                ? 'integTriggers.resumeWarning'
                : 'integTriggers.pauseWarning',
              {
                name: triggerName(pausing, t, f),
                service: pausing.serviceName,
              },
            )}
          </Paragraph>
          <Textfield
            className="int-field-md"
            data-size="sm"
            label={t('common.reason')}
            value={reason}
            error={reasonError || undefined}
            onChange={(e) => {
              setReason(e.target.value);
              setReasonError('');
            }}
          />
          <div className="actions">
            <Button variant="primary" data-size="sm" onClick={() => void togglePause()}>
              {pausing.status === 'paused' ? t('integrations.startAgain') : t('integrations.pause')}
            </Button>
            <Button variant="secondary" data-size="sm" onClick={() => setPausing(undefined)}>
              {t('common.cancel')}
            </Button>
          </div>
        </Alert>
      ) : null}
    </div>
  );
};

const useRuns = (api: ApiClient, tenant: string, id: string | undefined) => {
  const [state] = useAsync(
    async (signal) => (id ? api.triggers.runs(tenant, id, signal) : []),
    [api, tenant, id],
  );
  return state.status === 'ready' ? state.data : undefined;
};
