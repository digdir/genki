import { Alert, Button, Paragraph } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import type { ApiClient } from '../../api';
import { actorLabel } from '../../format';
import { useT } from '../../i18n';
import { useRights } from '../../Shell';
import type { PublishedDefinition } from '../../types';
import { useServiceLifecycle } from './lifecycle';
import { LifecycleDialog } from './ServiceLifecycle';

export const PausedBanner = ({
  api,
  tenant,
  id,
  name,
  published,
}: {
  api: ApiClient;
  tenant: string;
  id: string;
  name: string;
  published?: PublishedDefinition | undefined;
}) => {
  const t = useT();
  const f = useFormat();
  const canResume = useRights().has('manage-services');
  const view = useServiceLifecycle(api, tenant, id);
  const [resuming, setResuming] = useState(false);
  if (view?.state !== 'paused') return null;
  const who = view.by
    ? actorLabel(
        view.by,
        t,
        view.by === published?.publishedBy ? published.publishedByName : undefined,
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
        />
      ) : null}
    </>
  );
};
