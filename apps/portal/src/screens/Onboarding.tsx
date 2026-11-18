import { daysThisMonth } from '../usage-window';
import { Alert, Button, Heading, Paragraph } from '@digdir/designsystemet-react';
import { useT } from '../i18n';
import { useAsync } from '../hooks';
import type { ScreenProps } from '../screen';
import { allDone, startProgress, StartSteps } from './start-progress';
import { monthUsage, tokensOf, withTrialRows } from './usage/model';
import './overview.css';

export const Onboarding = ({ api, tenant, tenantName }: ScreenProps) => {
  const t = useT();
  const [facts, retry] = useAsync(
    async (signal) => {
      const [overview, datasets, usage] = await Promise.all([
        api.overview(tenant, signal),
        api.datasets.list(tenant, signal),
        api.usage(tenant, daysThisMonth(), signal).catch(() => undefined),
      ]);
      const trialTokens = usage ? tokensOf(monthUsage(withTrialRows(usage)).trial) : 0;
      return startProgress(tenant, { datasets, services: overview.services, trialTokens });
    },
    [api, tenant],
  );
  const progress = facts.status === 'ready' ? facts.data : undefined;
  return (
    <div className="stack">
      <div className="stack-xs">
        <Heading level={1} data-size="lg">
          {t('getStarted.title')}
        </Heading>
        <p className="lead">{t('getStarted.lead')}</p>
      </div>
      {progress && allDone(progress) ? (
        <p role="status">{t('getStarted.allDone', { name: tenantName })}</p>
      ) : null}
      {facts.status === 'error' ? (
        <Alert data-color="warning">
          <Paragraph>
            <strong>{t('getStarted.failed')}</strong> {t('getStarted.failedText')}
          </Paragraph>
          <Button variant="secondary" data-size="sm" onClick={retry}>
            {t('common.tryAgain')}
          </Button>
        </Alert>
      ) : null}
      {facts.status === 'loading' ? (
        <span role="status" className="visually-hidden">
          {t('getStarted.checking')}
        </span>
      ) : null}
      <StartSteps progress={progress} headingLevel={2} long />
      <p>
        {t.rich('getStarted.dataHandling', {
          link: (c) => <a href="#/data-handling">{c}</a>,
        })}
      </p>
    </div>
  );
};
