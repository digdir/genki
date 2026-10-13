import { Button, Chip, Fieldset, Tag } from '@digdir/designsystemet-react';
import { useState } from 'react';
import { BATCH_TOTAL, batchStatusColors, batchStatusKeys, type BatchItem } from '../../data/log';
import { useT } from '../../i18n';

const filters = ['alle', 'Fullført', 'Feilet', 'Kjører', 'Venter'] as const;

export const BatchView = ({
  items,
  status,
  cancelled,
  runId,
}: {
  items: BatchItem[];
  status: string;
  cancelled: boolean;
  runId: string;
}) => {
  const t = useT();
  const [filter, setFilter] = useState<(typeof filters)[number]>('alle');
  const [shown, setShown] = useState(12);
  const finished = items.filter((i) => i.status === 'Fullført');
  const failed = items.filter((i) => i.status === 'Feilet');
  const running = items.filter((i) => i.status === 'Kjører');
  const waiting = items.filter((i) => i.status === 'Venter' || i.status === 'Avbrutt');
  const done = finished.length + failed.length;
  const pct = (n: number) => `${(n / BATCH_TOTAL) * 100}%`;
  const progressLabel = t('logBatch.progress', {
    done,
    total: BATCH_TOTAL,
    percent: Math.round((done / BATCH_TOTAL) * 100),
  });
  const eta =
    status === 'running'
      ? t('logBatch.etaRunning', { minutes: Math.max(1, Math.round((BATCH_TOTAL - done) * 0.5)) })
      : status === 'cancelled'
        ? t('logBatch.etaCancelled', { count: waiting.length })
        : t('logBatch.etaDone');
  const counts: Record<(typeof filters)[number], number> = {
    alle: items.length,
    Fullført: finished.length,
    Feilet: failed.length,
    Kjører: running.length,
    Venter: waiting.length,
  };
  const list = items.filter(
    (i) =>
      filter === 'alle' || i.status === filter || (filter === 'Venter' && i.status === 'Avbrutt'),
  );
  const visible = list.slice(0, shown);

  return (
    <div className="stack-sm log-batch">
      <div className="stack-sm">
        <div className="log-batch-progress-head">
          <span className="log-strong">{progressLabel}</span>
          <span className="meta">{eta}</span>
        </div>
        <p role="status" className="log-live">
          {t('logBatch.roughly', { percent: Math.floor((done / BATCH_TOTAL) * 10) * 10 })}
        </p>
        <div
          role="progressbar"
          aria-label={t('logBatch.progressLabel')}
          aria-valuemin={0}
          aria-valuemax={BATCH_TOTAL}
          aria-valuenow={done}
          aria-valuetext={progressLabel}
          className="log-progress"
        >
          <div className="seg ok" style={{ width: pct(finished.length) }} />
          <div className="seg fail" style={{ width: pct(failed.length) }} />
          <div className="seg run" style={{ width: pct(running.length) }} />
        </div>
      </div>
      <Fieldset>
        <Fieldset.Legend>{t('logBatch.show')}</Fieldset.Legend>
        <div className="tag-row">
          {filters.map((option) => (
            <Chip.Radio
              key={option}
              name="elementfilter"
              checked={filter === option}
              onChange={() => {
                setFilter(option);
                setShown(12);
              }}
            >
              {t('logBatch.filter', {
                label:
                  option === 'alle'
                    ? t('logBatch.all')
                    : option === 'Venter' && cancelled
                      ? t(batchStatusKeys.Avbrutt)
                      : t(batchStatusKeys[option]),
                count: counts[option],
              })}
            </Chip.Radio>
          ))}
        </div>
      </Fieldset>
      {visible.length > 0 ? (
        <ul className="plain-list log-batch-items">
          {visible.map((i) => (
            <li key={i.i}>
              <span className="log-batch-n numeric">{i.i}</span>
              <span className="log-batch-name">
                <span className="log-strong">{i.name}</span>
                <span className="meta">
                  {i.org}
                  {i.err ? ` · ${i.err}` : ''}
                </span>
              </span>
              <Tag data-size="sm" data-color={batchStatusColors[i.status]}>
                {t(batchStatusKeys[i.status])}
              </Tag>
              <span className="log-batch-tokens meta numeric">
                {i.tokens ? t('logBatch.tokens', { count: i.tokens }) : ''}
              </span>
              <Button
                asChild
                variant="tertiary"
                data-size="sm"
                aria-label={t('logBatch.openFor', { name: i.name })}
              >
                <a href={`#/log/${runId}/${i.i}`}>{t('logBatch.open')}</a>
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="meta">{t('logBatch.none')}</p>
      )}
      <div className="actions">
        <span className="meta">
          {t('logBatch.showing', { shown: visible.length, total: list.length })}
        </span>
        {visible.length < list.length ? (
          <Button variant="secondary" data-size="sm" onClick={() => setShown((n) => n + 12)}>
            {t('logBatch.more', { count: 12 })}
          </Button>
        ) : null}
      </div>
    </div>
  );
};
