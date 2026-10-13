import { Alert, Button, Heading, Paragraph, Spinner } from '@digdir/designsystemet-react';
import type { Format } from '@genai/i18n';
import { useFormat } from '@genai/i18n/react';
import { ApiError } from '../api';
import { useAsync } from '../hooks';
import { useT, type T } from '../i18n';
import type { FailedRun, WorkspaceApi } from '../types';

interface Props {
  api: WorkspaceApi;
  tenant: string;
  now: Date;
  retryHref: (run: FailedRun) => string;
}

const windowDays = 30;

const refused = (error: unknown) => error instanceof ApiError && error.status === 403;

const whenText = (at: Date, now: Date, t: T, f: Format) => {
  const yesterday = new Date(now.getTime() - 86_400_000);
  const time = f.time(at);
  if (f.date(at) === f.date(now)) return t('errors.today', { time });
  if (f.date(at) === f.date(yesterday)) return t('errors.yesterday', { time });
  return t('errors.onDay', { day: f.date(at).replace(/ \d{4}$/, ''), time });
};

export const splitReason = (reason: string) => {
  const match = /^(.+?[.!?])\s+(.+)$/s.exec(reason.trim());
  return match ? { lead: match[1] ?? '', rest: match[2] ?? '' } : { lead: reason.trim(), rest: '' };
};

export const FailedRuns = ({ api, tenant, now, retryHref }: Props) => {
  const t = useT();
  const f = useFormat();
  const [state, retry] = useAsync(
    (signal) => api.failedRuns?.(tenant, signal) ?? Promise.resolve([]),
    [api, tenant],
  );
  const since = now.getTime() - windowDays * 86_400_000;
  const runs =
    state.status === 'ready' ? state.data.filter((r) => new Date(r.at).getTime() >= since) : [];
  return (
    <div className="errors-page">
      <div className="page-head">
        <Heading level={1} data-size="lg">
          {t('errors.heading')}
        </Heading>
        <Paragraph className="subtle">{t('errors.intro')}</Paragraph>
      </div>
      {state.status === 'loading' ? (
        <Spinner aria-label={t('errors.loading')} data-size="md" />
      ) : state.status === 'error' && refused(state.error) ? (
        <Alert data-color="info" data-size="sm">
          <Paragraph data-size="sm">{t('errors.noAccess')}</Paragraph>
        </Alert>
      ) : state.status === 'error' ? (
        <Alert data-color="danger" data-size="sm">
          <Paragraph data-size="sm">{t('errors.loadFailed')}</Paragraph>
          <Button variant="secondary" data-size="sm" onClick={retry}>
            {t('errors.tryAgain')}
          </Button>
        </Alert>
      ) : runs.length === 0 ? (
        <div className="panel narrow-panel">
          <Paragraph>{t('errors.empty')}</Paragraph>
        </div>
      ) : (
        <ul className="failed-runs">
          {runs.map((run) => {
            const { lead, rest } = splitReason(run.reason);
            return (
              <li key={run.id} className="failed-run">
                <div className="failed-run-head">
                  <Heading level={2} data-size="2xs">
                    {run.serviceName ?? run.service}
                  </Heading>
                  <span className="subtle-sm">{whenText(new Date(run.at), now, t, f)}</span>
                </div>
                <Paragraph>
                  <strong>{lead}</strong>
                  {rest ? ` ${rest}` : ''}
                </Paragraph>
                <div>
                  <a
                    className="ds-button"
                    data-variant="secondary"
                    data-size="sm"
                    href={retryHref(run)}
                    aria-label={t('errors.retryWith', { service: run.serviceName ?? run.service })}
                  >
                    {t('errors.tryAgain')}
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
