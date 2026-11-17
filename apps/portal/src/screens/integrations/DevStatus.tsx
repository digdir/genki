import { Alert, Button, Heading, Paragraph, Tag } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import type { ReactNode } from 'react';
import type { ApiClient } from '../../api';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { Loading } from '../../states';

const link = (href: string) => (chunks: ReactNode) => <a href={href}>{chunks}</a>;

export const shortVersion = (version: string) =>
  /^[0-9a-f]{8,40}$/i.test(version) ? version.slice(0, 7) : version;

export const DevStatus = ({
  api,
  now = () => new Date(),
}: {
  api: Pick<ApiClient, 'getHealth' | 'cache'>;
  now?: () => Date;
}) => {
  const t = useT();
  const f = useFormat();
  const [health, retry] = useAsync(
    async (signal) => {
      const started = performance.now();
      const result = await api.getHealth(signal);
      return { ...result, ms: Math.round(performance.now() - started), at: now() };
    },
    [api],
  );
  const checkNow = () => {
    api.cache.invalidate();
    retry();
  };
  return (
    <div className="stack-md">
      <div className="int-intro">
        <Paragraph className="meta int-intro-text">
          {health.status === 'ready'
            ? t('devTools.statusChecked', { time: f.time(health.data.at) })
            : t('app.statusIntro')}
        </Paragraph>
        <Button
          variant="secondary"
          aria-disabled={health.status === 'loading' || undefined}
          onClick={() => health.status !== 'loading' && checkNow()}
        >
          {t('devTools.statusCheckNow')}
        </Button>
      </div>
      {health.status === 'loading' ? (
        <Loading label={t('app.statusChecking')} />
      ) : health.status === 'error' ? (
        <Alert data-color="danger">
          <Heading level={3} data-size="xs">
            {t('devTools.statusNoContact')}
          </Heading>
          <Paragraph>{t('devTools.statusNoContactText')}</Paragraph>
          <Button variant="secondary" data-size="sm" onClick={checkNow}>
            {t('app.statusCheckAgain')}
          </Button>
        </Alert>
      ) : (
        <>
          <section aria-labelledby="ds-checks" className="stack-sm">
            <Heading level={3} data-size="2xs" id="ds-checks">
              {t('devTools.statusWhatWeCheck')}
            </Heading>
            <ul className="plain-list dev-status-checks">
              <li>
                <span className="stack-xs">
                  <strong>{t('devTools.statusApiCheck')}</strong>
                  <span className="meta">{t('devTools.statusApiHow')}</span>
                </span>
                <Tag data-size="sm" data-color="success">
                  {t('app.statusUp')}
                </Tag>
                <span className="meta">
                  {t('devTools.statusAnsweredIn', { ms: health.data.ms })}
                </span>
              </li>
            </ul>
          </section>
          <dl className="kv">
            <dt>{t('app.statusVersion')}</dt>
            <dd>
              <code>{shortVersion(health.data.version)}</code>
            </dd>
          </dl>
        </>
      )}
      <Paragraph>
        {t.rich('app.statusScope', { services: link('#/services'), log: link('#/log') })}
      </Paragraph>
    </div>
  );
};
