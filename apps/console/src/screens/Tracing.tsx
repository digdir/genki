import { Alert, Heading, Paragraph, Tag } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import type { ApiClient } from '../api';
import { useT } from '../i18n';
import { useAsync } from '../hooks';
import { ErrorState, Loading } from '../states';
import type { TracingStatus } from '../types';
import { PageHeader, Unavailable } from '../ui';

const EnvironmentTracing = ({ status }: { status: TracingStatus }) => {
  const t = useT();
  const f = useFormat();
  return (
    <>
      <section className="card stack-sm" aria-labelledby="miljo-h">
        <div className="card-head">
          <Heading level={2} data-size="xs" id="miljo-h">
            {t('tracing.envTitle')}
          </Heading>
          <Tag data-size="sm" data-color={status.enabled ? 'success' : 'neutral'}>
            {status.enabled ? t('tracing.on') : t('tracing.off')}
          </Tag>
        </div>
        <Paragraph data-size="sm">{t('tracing.envNote')}</Paragraph>
        {status.enabled ? (
          <dl className="def-list">
            {status.endpoint ? (
              <>
                <dt>{t('tracing.target')}</dt>
                <dd>{status.endpoint}</dd>
              </>
            ) : null}
            <dt>{t('tracing.content')}</dt>
            <dd>{status.content ? t('tracing.fullContent') : t('tracing.metaOnly')}</dd>
            {status.sampleRate !== undefined ? (
              <>
                <dt>{t('tracing.shareSent')}</dt>
                <dd>{t('tracing.percent', { value: Math.round(status.sampleRate * 100) })}</dd>
              </>
            ) : null}
            {status.stats ? (
              <>
                <dt>{t('tracing.sent')}</dt>
                <dd>{f.number(status.stats.exported)}</dd>
                <dt>{t('tracing.failed')}</dt>
                <dd>{f.number(status.stats.failed)}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
      </section>
      <Unavailable title={t('tracing.unavailableTitle')}>
        {t('tracing.unavailableText')}
      </Unavailable>
    </>
  );
};

export const Tracing = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const [state, retry] = useAsync((signal) => api.tracing(signal), [api]);

  return (
    <>
      <PageHeader title={t('tracing.title')} intro={t('tracing.intro')} />
      <Alert data-color="info" data-size="sm">
        {t('tracing.sourceNote')}
      </Alert>
      <div className="fixed-rule" role="note">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <path d="M7 11V8a5 5 0 0 1 10 0v3 M5 11h14v10H5z" />
        </svg>
        <span>
          <strong>{t('tracing.fixedRule')}</strong>
          {t('tracing.fixedRuleText')}
        </span>
      </div>
      {state.status === 'loading' ? (
        <Loading label={t('tracing.loading')} shape="detail" onRetry={retry} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : (
        <EnvironmentTracing status={state.data} />
      )}
    </>
  );
};
