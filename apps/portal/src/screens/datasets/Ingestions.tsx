import { ChevronDownIcon } from '@navikt/aksel-icons';
import {
  Button,
  Dialog,
  Heading,
  Paragraph,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import {
  isOpen,
  skippedCount,
  skippedOf,
  type ExecutionView,
  type PipelineView,
  type SkippedDocument,
} from '../../api/datasets';
import { Icon } from '../../components/Icon';
import { useT, type Format, type T } from '../../i18n';
import { executionStatus, reasonText } from './live-model';

const scheduledActor = 'platform:ingestion-schedule';

export const Skipped = ({ list }: { list: SkippedDocument[] }) => {
  const t = useT();
  return (
    <div className="stack-xs">
      <Heading level={3} data-size="2xs">
        {t('datasets.skippedHeading', { count: list.length })}
      </Heading>
      <div className="table-scroll">
        <Table data-size="sm" aria-label={t('datasets.skipped')}>
          <TableHead>
            <TableRow>
              <TableHeaderCell scope="col">{t('datasets.columnFile')}</TableHeaderCell>
              <TableHeaderCell scope="col">{t('datasets.columnWhySkipped')}</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {list.map((s) => (
              <TableRow key={s.document}>
                <TableCell className="wrap">{s.document}</TableCell>
                <TableCell>{reasonText(t, s.reason)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
};

export const scheduleLine = (
  t: T,
  f: Format,
  pipeline: PipelineView | undefined,
  nextRun: string | null | undefined,
) => {
  if (!pipeline) return '';
  const kind = pipeline.spec.source.kind;
  const schedule = pipeline.spec.schedule;
  const base =
    kind === 'upload'
      ? t('datasets.scheduleLineUpload')
      : schedule === 'daily'
        ? t('datasets.scheduleLineDaily')
        : schedule === 'weekly'
          ? t('datasets.scheduleLineWeekly')
          : t('datasets.scheduleLineManual');
  return nextRun ? `${base} ${t('datasets.nextRunAt', { when: f.dateTime(nextRun) })}` : base;
};

const durationText = (t: T, run: ExecutionView) => {
  if (!run.endedAt) return t('datasets.stillRunning');
  const seconds = Math.max(
    0,
    Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000),
  );
  const minutes = Math.floor(seconds / 60);
  return minutes > 0
    ? t('datasets.durationMinutes', { minutes, seconds: seconds % 60 })
    : t('datasets.durationSeconds', { seconds });
};

export const Run = ({
  run,
  open,
  onToggle,
  onCancel,
}: {
  run: ExecutionView;
  open: boolean;
  onToggle: () => void;
  onCancel?: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const status = executionStatus(t, run);
  const skipped = skippedOf(run);
  const running = isOpen(run);
  const stored = run.report?.stored ?? 0;
  const pending = pendingText(t, run);
  return (
    <li id={`run-${run.id}`} className={open ? 'run open' : 'run'}>
      <button type="button" className="run-toggle" aria-expanded={open} onClick={onToggle}>
        <span className="run-when">
          <strong>{f.dateTime(run.startedAt)}</strong>
          <span className="meta">
            {run.endedAt
              ? t('datasets.finishedAt', { when: f.dateTime(run.endedAt) })
              : t('datasets.stillRunning')}
          </span>
        </span>
        <Tag data-size="sm" data-color={status.color}>
          {status.text}
        </Tag>
        <span className="run-counts numeric">
          <span>{t('datasets.storedCount', { amount: f.number(stored) })}</span>
          <span>{t('datasets.skippedCount', { amount: f.number(skippedCount(run)) })}</span>
        </span>
        <span className="run-toggle-label meta">
          {open ? t('datasets.hideDetails') : t('datasets.showDetails')}
          <span className={open ? 'chevron up' : 'chevron'}>
            <Icon icon={ChevronDownIcon} size={18} />
          </span>
        </span>
      </button>
      {running ? (
        <div className="run-live">
          <progress aria-label={t('datasets.storedSoFarLabel')} />
          <span className="meta">
            {pending ?? t('datasets.storedSoFar', { amount: f.number(stored) })}
          </span>
          {onCancel && !run.cancelRequestedAt ? (
            <Button variant="secondary" data-color="danger" data-size="sm" onClick={onCancel}>
              {t('datasets.cancelIngestion')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {open ? (
        <div className="run-body">
          <dl className="run-facts">
            <div>
              <dt>{t('datasets.startedBy')}</dt>
              <dd>{startedByText(t, run)}</dd>
            </div>
            <div>
              <dt>{t('datasets.durationLabel')}</dt>
              <dd>{durationText(t, run)}</dd>
            </div>
            <div>
              <dt>{t('datasets.storedLabel')}</dt>
              <dd>
                {t('datasets.storedOf', {
                  stored: f.number(stored),
                  total: f.number(stored + skippedCount(run)),
                })}
              </dd>
            </div>
          </dl>
          {running ? <p className="meta">{t('datasets.runningSelfUpdates')}</p> : null}
          {run.status === 'failed' ? (
            <div className="run-error fatal">
              <strong>{t('datasets.ingestionFailed')}</strong>
              <p className="why">{t('datasets.nothingChanged')}</p>
              {run.error ? (
                <span className="code">
                  {t('datasets.technicalMessage', { message: run.error })}
                </span>
              ) : null}
            </div>
          ) : null}
          {skipped.length > 0 ? <Skipped list={skipped} /> : null}
          {!running && run.status !== 'failed' && skipped.length === 0 ? (
            <p className="no-errors">{t('datasets.noneSkipped')}</p>
          ) : null}
          {run.report?.failed.length ? (
            <p className="meta">
              {t('datasets.documentsFailed', {
                count: run.report.failed.length,
                names: run.report.failed.join(', '),
              })}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
};

const pendingText = (t: T, run: ExecutionView) =>
  run.status === 'queued'
    ? t('datasets.runQueuedText')
    : run.status === 'waiting'
      ? t('datasets.runWaitingText')
      : undefined;

const startedByText = (t: T, run: ExecutionView) =>
  run.startedBy === scheduledActor
    ? t('datasets.startedBySchedule')
    : (run.startedByName ?? run.startedBy ?? t('datasets.notAvailable'));

const whatHappened = (t: T, f: Format, run: ExecutionView) => {
  const stored = f.number(run.report?.stored ?? 0);
  const pending = pendingText(t, run);
  if (pending) return pending;
  if (run.status === 'running') return t('datasets.pagesSoFar', { amount: stored });
  if (run.status === 'failed')
    return [run.error, t('datasets.noPagesChanged')].filter(Boolean).join('. ');
  if (run.status === 'cancelled') return t('datasets.runCancelledText', { amount: stored });
  const skipped = skippedCount(run);
  return skipped
    ? t('datasets.pagesWithSkipped', { amount: stored, skipped: f.number(skipped) })
    : t('datasets.pagesStored', { amount: stored });
};

export const RunTable = ({
  runs,
  onCancel,
}: {
  runs: ExecutionView[];
  onCancel?: (run: ExecutionView) => void;
}) => {
  const t = useT();
  const f = useFormat();
  return (
    <div className="table-scroll">
      <Table aria-label={t('datasets.tabIngestions')}>
        <TableHead>
          <TableRow>
            <TableHeaderCell scope="col">{t('datasets.columnStarted')}</TableHeaderCell>
            <TableHeaderCell scope="col">{t('datasets.columnStatus')}</TableHeaderCell>
            <TableHeaderCell scope="col">{t('datasets.columnWhat')}</TableHeaderCell>
            <TableHeaderCell scope="col">{t('datasets.startedBy')}</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {runs.map((run) => {
            const status = executionStatus(t, run);
            const running = isOpen(run);
            return (
              <TableRow key={run.id} id={`run-${run.id}`}>
                <TableCell>{f.dateTime(run.startedAt)}</TableCell>
                <TableCell>
                  <Tag data-size="sm" data-color={status.color}>
                    {status.text}
                  </Tag>
                </TableCell>
                <TableCell className="wrap">
                  <span>{whatHappened(t, f, run)}</span>
                  {running ? (
                    <span className="run-live">
                      <progress aria-label={t('datasets.storedSoFarLabel')} />
                      {onCancel && !run.cancelRequestedAt ? (
                        <Button
                          variant="secondary"
                          data-color="danger"
                          data-size="sm"
                          onClick={() => onCancel(run)}
                        >
                          {t('datasets.cancelIngestion')}
                        </Button>
                      ) : null}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>{startedByText(t, run)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
};

export const CancelDialog = ({
  run,
  onKeep,
  onCancel,
}: {
  run: ExecutionView;
  onKeep: () => void;
  onCancel: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  return (
    <Dialog
      open
      modal
      onClose={onKeep}
      aria-labelledby="cancel-run-h"
      closeButton={t('common.close')}
    >
      <Heading level={2} data-size="xs" id="cancel-run-h">
        {t('datasets.cancelQuestion')}
      </Heading>
      <Paragraph>
        {t('datasets.cancelText', { amount: f.number(run.report?.stored ?? 0) })}
      </Paragraph>
      <div className="actions">
        <Button variant="primary" autoFocus onClick={onKeep}>
          {t('datasets.stopNo')}
        </Button>
        <Button variant="secondary" data-color="danger" onClick={onCancel}>
          {t('datasets.cancelIngestion')}
        </Button>
      </div>
    </Dialog>
  );
};
