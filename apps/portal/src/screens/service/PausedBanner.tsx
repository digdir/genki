import { Alert, Button, Link, Paragraph } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api';
import type { DatasetView } from '../../api/datasets';
import { actorLabel, formatDateTime } from '../../format';
import { useT } from '../../i18n';
import { useRights } from '../../Shell';
import type { PublishedDefinition } from '../../types';
import { lifecycleChanged, useServiceLifecycle } from './lifecycle';
import { LifecycleDialog } from './ServiceLifecycle';

export const PausedBanner = ({
  api,
  tenant,
  id,
  name,
  published,
  datasets = [],
  undoSeconds = 10,
}: {
  api: ApiClient;
  tenant: string;
  id: string;
  name: string;
  published?: PublishedDefinition | undefined;
  datasets?: DatasetView[];
  undoSeconds?: number;
}) => {
  const t = useT();
  const f = useFormat();
  const canResume = useRights().has('manage-services');
  const view = useServiceLifecycle(api, tenant, id);
  const [resuming, setResuming] = useState(false);
  const [resumed, setResumed] = useState<{ reason: string; left: number }>();
  const [undoFailed, setUndoFailed] = useState(false);
  const pausedReason = useRef('');
  if (view?.state === 'paused') pausedReason.current = view.reason ?? '';

  useEffect(() => {
    if (!resumed) return;
    if (resumed.left <= 0) {
      setResumed(undefined);
      return;
    }
    const timer = setTimeout(() => setResumed((r) => (r ? { ...r, left: r.left - 1 } : r)), 1000);
    return () => clearTimeout(timer);
  }, [resumed]);

  const undo = async () => {
    if (!resumed) return;
    setUndoFailed(false);
    try {
      await api.setServiceLifecycle(
        tenant,
        id,
        'paused',
        resumed.reason || t('serviceLifecycle.undoResumeReason'),
      );
      setResumed(undefined);
      lifecycleChanged(tenant, id);
    } catch {
      setUndoFailed(true);
    }
  };

  if (view?.state !== 'paused')
    return resumed && view?.state === 'active' ? (
      <Alert data-color="success" data-size="sm" role="status" className="service-banner">
        <div className="service-banner-row">
          <Paragraph data-size="sm">
            {t('serviceLifecycle.resumedNotice', { name })}
            {undoFailed ? ` ${t('serviceLifecycle.undoFailed')}` : ''}
          </Paragraph>
          <Button variant="secondary" data-size="sm" onClick={() => void undo()}>
            {t('serviceLifecycle.undoCountdown', { seconds: resumed.left })}
          </Button>
        </div>
      </Alert>
    ) : null;
  const failedIngests = datasets.filter((d) => d.lastExecution?.status === 'failed');
  const who = view.by
    ? actorLabel(
        view.by,
        t,
        view.byName ?? (view.by === published?.publishedBy ? published.publishedByName : undefined),
      )
    : undefined;
  const when = view.at ? f.date(view.at, 'long') : undefined;
  const why = view.reason?.trim();
  return (
    <>
      <Alert data-color="warning" data-size="sm" role="status" className="service-banner">
        <div className="service-banner-row">
          <Paragraph data-size="sm">
            <strong>{t('serviceLifecycle.pausedTitle')}</strong>{' '}
            {who && when
              ? why
                ? t('serviceLifecycle.pausedByWhy', { who, when, why })
                : t('serviceLifecycle.pausedBy', { who, when })
              : ''}{' '}
            {t('serviceLifecycle.pausedUsers')}
          </Paragraph>
          {failedIngests.map((d) => (
            <Paragraph key={d.fullId} data-size="sm">
              {t('serviceLifecycle.ingestFailedBefore')}{' '}
              <Link href={`#/datasets/${encodeURIComponent(d.id)}`}>{d.name}</Link>{' '}
              {t('serviceLifecycle.ingestFailedAfter', {
                when: formatDateTime(
                  d.lastExecution?.endedAt ?? d.lastExecution?.startedAt ?? '',
                  f,
                ),
              })}
            </Paragraph>
          ))}
          {canResume ? (
            <Button variant="secondary" data-size="sm" onClick={() => setResuming(true)}>
              {t('serviceLifecycle.resume')}
            </Button>
          ) : null}
        </div>
      </Alert>
      {resuming ? (
        <LifecycleDialog
          api={api}
          tenant={tenant}
          id={id}
          name={name}
          change="resume"
          onClose={() => setResuming(false)}
          onChanged={() => {
            setUndoFailed(false);
            setResumed({ reason: pausedReason.current, left: undoSeconds });
          }}
        />
      ) : null}
    </>
  );
};
