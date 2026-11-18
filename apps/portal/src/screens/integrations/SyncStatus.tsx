import { Alert, Button } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useT } from '../../i18n';
import type { ToolConnectionView } from '../../types';

type LastSync = ToolConnectionView['lastSync'];

export const SyncLine = ({ sync }: { sync: LastSync }) => {
  const t = useT();
  const f = useFormat();
  if (!sync) return <span className="meta">{t('connectionSync.never')}</span>;
  if (sync.ok)
    return (
      <span className="meta">{t('connectionSync.synced', { when: f.dateTime(sync.at) })}</span>
    );
  return (
    <span className="int-sync-failed">
      <strong>{t('connectionSync.failed', { when: f.dateTime(sync.at) })}</strong>
      {sync.message ? <span>{sync.message}</span> : null}
    </span>
  );
};

export const SyncAttention = ({
  name,
  sync,
  panel,
}: {
  name: string;
  sync: LastSync;
  panel: string;
}) => {
  const t = useT();
  const f = useFormat();
  if (!sync || sync.ok) return null;
  return (
    <Alert data-color="danger" data-size="sm" className="int-sync-attention">
      <span className="int-sync-badge">{t('connectionSync.attention')}</span>
      <span>
        <strong>{name}</strong> {t('connectionSync.attentionText', { when: f.dateTime(sync.at) })}
      </span>
      <Button
        variant="tertiary"
        data-size="sm"
        onClick={() => {
          const target = document.getElementById(panel);
          target?.scrollIntoView?.({ block: 'center' });
          target?.focus();
        }}
      >
        {t('connectionSync.seeError')}
      </Button>
    </Alert>
  );
};
