import { Button, Dialog, Heading, Paragraph } from '@digdir/designsystemet-react';
import type { ApiClient } from '../../api';
import { navigate, useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { needsRight, useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import { servicePath } from '../service/sections';
import { BatchWizard } from './BatchWizard';
import './batch.css';

export const BatchDialog = ({
  api,
  tenant,
  id,
  onClose,
  onStarted,
}: {
  api: ApiClient;
  tenant: string;
  id: string;
  onClose: () => void;
  onStarted?: (run: string) => void;
}) => {
  const t = useT();
  const canManage = useRights().has('manage-services');
  const [sources, retry] = useAsync(
    (signal) => api.batchRuns.sources(tenant, id, signal),
    [api, tenant, id],
  );
  return (
    <Dialog
      open
      modal
      closeButton={false}
      onClose={onClose}
      aria-labelledby="batch-dialog-h"
      className="batch-dialog"
    >
      <div className="stack">
        <div className="row-wrap spread">
          <Heading level={2} data-size="sm" id="batch-dialog-h">
            {t('batch.dialogTitle')}
          </Heading>
          <Button variant="tertiary" data-size="sm" onClick={onClose}>
            {t('batch.close')}
          </Button>
        </div>
        {!canManage ? (
          <Paragraph data-size="sm">{needsRight('manage-services')}</Paragraph>
        ) : sources.status === 'loading' ? (
          <Loading
            label={t('batch.loadingSources')}
            shape="form"
            headingLevel={3}
            onRetry={retry}
          />
        ) : sources.status === 'error' ? (
          <ErrorState error={sources.error} onRetry={retry} headingLevel={3} />
        ) : (
          <BatchWizard
            api={api}
            tenant={tenant}
            serviceId={id}
            sources={sources.data}
            onCancel={onClose}
            onStarted={(run) => {
              onClose();
              if (onStarted) onStarted(run);
              else navigate(servicePath(id, 'batch', `/${encodeURIComponent(run)}`));
            }}
          />
        )}
      </div>
    </Dialog>
  );
};
