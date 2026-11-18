import {
  Alert,
  Button,
  Paragraph,
  Switch,
  Table,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { createFormat, type Format } from '@genai/i18n';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import type { ApiClient } from '../../api';
import type { TriggerRunView, TriggerView } from '../../api/triggers';
import { reasonProblem } from '../../components/ReasonField';
import { translator, useT, type PlainKey, type T } from '../../i18n';
import { useRights } from '../../Shell';
import { problemText } from '../service/ServiceKeys';

export const kindKeys: Record<TriggerView['kind'], PlainKey> = {
  'document-arrives': 'integTriggers.kindDocument',
  'queue-message': 'integTriggers.kindQueue',
  schedule: 'integTriggers.kindSchedule',
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

export const problemOf = (tr: TriggerView, t: T = nbT, f: Format = nbFormat) =>
  t('integTriggers.problem', { name: triggerName(tr, t, f) });

const timelineHref = (run: TriggerRunView) =>
  run.task ? `#/log/${encodeURIComponent(run.task)}` : undefined;

const lastRunTag = (tr: TriggerView): { key: PlainKey; color: 'danger' | 'success' | 'warning' } =>
  tr.status === 'failing'
    ? { key: 'devTriggers.lastFailed', color: 'danger' }
    : tr.lastRun?.outcome === 'failed'
      ? { key: 'devTriggers.runFailed', color: 'warning' }
      : { key: 'devTriggers.lastDone', color: 'success' };

export const Triggers = ({
  api,
  tenant,
  triggers,
  onChanged,
}: {
  api: ApiClient;
  tenant: string;
  triggers: TriggerView[];
  onChanged: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const { has } = useRights();
  const canManage = has('manage-services');
  const [pausing, setPausing] = useState<TriggerView>();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState('');
  const [saved, setSaved] = useState<Record<string, string>>({});

  const togglePause = async () => {
    if (!pausing) return;
    const problem = reasonProblem(reason, t);
    if (problem) return setReasonError(problem);
    const resume = pausing.status === 'paused';
    try {
      await api.triggers.pause(tenant, pausing.id, !resume, reason.trim());
      setSaved((all) => ({
        ...all,
        [pausing.id]: t(resume ? 'devTriggers.savedOn' : 'devTriggers.savedPaused'),
      }));
      setPausing(undefined);
      onChanged();
    } catch (e) {
      setReasonError(problemText(e, t));
    }
  };

  const failing = triggers.filter((tr) => tr.status === 'failing');
  return (
    <div className="stack-md">
      {failing.map((tr) => (
        <Alert key={tr.id} data-color="danger" data-size="sm" className="int-sync-attention">
          <span className="int-sync-badge">{t('connectionSync.attention')}</span>
          <span>
            {t('devTriggers.failedStart', {
              name: triggerName(tr, t, f),
              at: tr.lastRun ? f.dateTime(tr.lastRun.at, 'medium') : '',
            })}{' '}
            <a href={`#/services/${encodeURIComponent(tr.service)}`}>{tr.serviceName}</a>
          </span>
        </Alert>
      ))}
      <Table className="dev-table" data-size="sm">
        <Table.Head>
          <Table.Row>
            <Table.HeaderCell scope="col">{t('devTriggers.when')}</Table.HeaderCell>
            <Table.HeaderCell scope="col">{t('devTriggers.starts')}</Table.HeaderCell>
            <Table.HeaderCell scope="col">{t('devTriggers.lastRun')}</Table.HeaderCell>
            <Table.HeaderCell scope="col">{t('devTriggers.active')}</Table.HeaderCell>
          </Table.Row>
        </Table.Head>
        <Table.Body>
          {triggers.map((tr) => {
            const last = tr.lastRun;
            const tag = lastRunTag(tr);
            const href = last ? timelineHref(last) : undefined;
            const paused = tr.status === 'paused';
            return (
              <Table.Row key={tr.id}>
                <Table.Cell>
                  <span className="stack-xs">
                    <strong>{triggerName(tr, t, f)}</strong>
                    <span className="meta">{sourceOf(tr, t)}</span>
                  </span>
                </Table.Cell>
                <Table.Cell>
                  <a href={`#/services/${encodeURIComponent(tr.service)}`}>{tr.serviceName}</a>
                </Table.Cell>
                <Table.Cell>
                  {last ? (
                    <span className="stack-xs">
                      <Tag data-size="sm" data-color={tag.color}>
                        {t(tag.key)}
                      </Tag>
                      {href ? (
                        <a href={href}>{f.dateTime(last.at, 'medium')}</a>
                      ) : (
                        <span className="meta">{f.dateTime(last.at, 'medium')}</span>
                      )}
                      {last.outcome === 'failed' && last.error ? (
                        <span className="meta">{last.error}</span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="meta">{t('devTriggers.notRunYet')}</span>
                  )}
                </Table.Cell>
                <Table.Cell>
                  <Switch
                    data-size="sm"
                    label={
                      <>
                        {t(paused ? 'devTriggers.paused' : 'devTriggers.on')}
                        <span className="visually-hidden">
                          {' '}
                          {t('devTriggers.activeFor', { name: triggerName(tr, t, f) })}
                        </span>
                      </>
                    }
                    checked={!paused}
                    disabled={!canManage}
                    onChange={() => {
                      setPausing(tr);
                      setReason('');
                      setReasonError('');
                    }}
                  />
                  <span role="status" className="dev-msg-ok">
                    {saved[tr.id]}
                  </span>
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>
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
