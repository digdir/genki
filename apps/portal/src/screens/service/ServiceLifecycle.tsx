import { Alert, Button, Dialog, Heading, Paragraph, Tag } from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { ApiClient } from '../../api';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import { useAsync } from '../../hooks';
import { useT, type PlainKey } from '../../i18n';
import type { ServiceLifecycleView } from '../../types';

type Change = 'pause' | 'resume' | 'archive' | 'restore';

const target: Record<Change, ServiceLifecycleView['state']> = {
  pause: 'paused',
  resume: 'active',
  archive: 'archived',
  restore: 'active',
};

const infoKey: Record<Change, PlainKey> = {
  pause: 'serviceLifecycle.pauseInfo',
  resume: 'serviceLifecycle.resumeInfo',
  archive: 'serviceLifecycle.archiveInfo',
  restore: 'serviceLifecycle.restoreInfo',
};

const actionKey: Record<Change, PlainKey> = {
  pause: 'serviceLifecycle.pause',
  resume: 'serviceLifecycle.resume',
  archive: 'serviceLifecycle.archive',
  restore: 'serviceLifecycle.restore',
};

export const ServiceLifecycle = ({
  api,
  tenant,
  id,
  name,
  onChanged,
}: {
  api: ApiClient;
  tenant: string;
  id: string;
  name: string;
  onChanged?: () => void;
}) => {
  const t = useT();
  const [version, setVersion] = useState(0);
  const [state] = useAsync(
    (signal) => api.serviceLifecycle(tenant, id, signal),
    [api, tenant, id, version],
  );
  const [change, setChange] = useState<Change>();
  const [reason, setReason] = useState('');
  const [showError, setShowError] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  if (state.status !== 'ready') return null;
  const current = state.data.state;
  const offered: Change[] =
    current === 'active'
      ? ['pause', 'archive']
      : current === 'paused'
        ? ['resume', 'archive']
        : ['restore'];

  const titleOf = (c: Change) =>
    c === 'pause'
      ? t('serviceLifecycle.pauseTitle', { name })
      : c === 'resume'
        ? t('serviceLifecycle.resumeTitle', { name })
        : c === 'archive'
          ? t('serviceLifecycle.archiveTitle', { name })
          : t('serviceLifecycle.restoreTitle', { name });

  const close = () => {
    setChange(undefined);
    setReason('');
    setShowError(false);
    setFailed(false);
  };

  const confirm = async () => {
    if (!change) return;
    if (reasonProblem(reason, t)) {
      setShowError(true);
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      await api.setServiceLifecycle(tenant, id, target[change], reason.trim());
      close();
      setVersion((v) => v + 1);
      onChanged?.();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {current === 'paused' ? (
        <Tag data-size="sm" data-color="warning">
          {t('serviceLifecycle.tagPaused')}
        </Tag>
      ) : null}
      {current === 'archived' ? (
        <Tag data-size="sm" data-color="neutral">
          {t('serviceLifecycle.tagArchived')}
        </Tag>
      ) : null}
      {offered.map((c) => (
        <Button key={c} variant="tertiary" data-size="sm" onClick={() => setChange(c)}>
          {t(actionKey[c])}
        </Button>
      ))}
      {change ? (
        <Dialog
          open
          modal
          closeButton={t('serviceLifecycle.close')}
          onClose={close}
          aria-labelledby="lifecycle-h"
        >
          <div className="stack">
            <Heading level={2} data-size="sm" id="lifecycle-h">
              {titleOf(change)}
            </Heading>
            <Paragraph>{t(infoKey[change])}</Paragraph>
            <ReasonField value={reason} onChange={setReason} showError={showError} />
            {failed ? (
              <Alert data-color="danger" data-size="sm" role="alert">
                {t('serviceLifecycle.failed')}
              </Alert>
            ) : null}
            <div className="actions">
              <Button
                variant="primary"
                data-size="sm"
                disabled={busy}
                onClick={() => void confirm()}
              >
                {t(actionKey[change])}
              </Button>
              <Button variant="secondary" data-size="sm" onClick={close}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </>
  );
};
