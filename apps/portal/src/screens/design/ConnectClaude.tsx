import { Button, Heading, Paragraph } from '@digdir/designsystemet-react';
import { useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { BusyButton } from '../../components/BusyButton';
import { CopyButton } from '../../components/CopyButton';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { Loading } from '../../states';
import { Problems } from './Problems';

/** «Koble til Claude»: the connector's address, what Claude may do, and how to add it. */
export const ConnectClaude = ({
  api,
  tenant,
  tenantName,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
}) => {
  const t = useT();
  const [state] = useAsync((signal) => api.design.connector(tenant, signal), [api, tenant]);
  const [busy, setBusy] = useState(false);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  if (state.status === 'loading') return <Loading label={t('design.connectClaude')} />;
  if (state.status === 'error')
    return state.error instanceof ApiError && state.error.status === 404 ? (
      <Paragraph data-size="sm">{t('design.connectOff')}</Paragraph>
    ) : (
      <Problems error={state.error} />
    );
  const { url } = state.data;
  const command = `claude mcp add --transport http genki-design ${url}`;
  const disconnect = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.design.disconnect(tenant);
      setEnded(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack design-connect">
      <Paragraph data-size="sm">{t('design.connectLead', { org: tenantName })}</Paragraph>
      <div className="stack-xs">
        <Heading level={3} data-size="2xs">
          {t('design.connectAddress')}
        </Heading>
        <div className="design-connect-copy">
          <code>{url}</code>
          <CopyButton text={url} ariaLabel={t('design.copyAddress')} />
        </div>
      </div>
      <ol className="design-connect-steps">
        <li>{t('design.connectStep1')}</li>
        <li>{t('design.connectStep2')}</li>
        <li>{t('design.connectStep3')}</li>
      </ol>
      <Paragraph data-size="sm" className="meta">
        {t('design.connectOrgNote')}
      </Paragraph>
      <div className="stack-xs">
        <Heading level={3} data-size="2xs">
          {t('design.connectCode')}
        </Heading>
        <div className="design-connect-copy">
          <code>{command}</code>
          <CopyButton text={command} ariaLabel={t('design.copyCommand')} />
        </div>
      </div>
      <div className="design-actions">
        <BusyButton
          variant="secondary"
          data-size="sm"
          busy={busy}
          busyLabel={t('design.disconnecting')}
          onClick={() => void disconnect()}
        >
          {t('design.disconnect')}
        </BusyButton>
        {ended ? (
          <Paragraph data-size="sm" role="status">
            {t('design.disconnected')}
          </Paragraph>
        ) : null}
      </div>
      {error ? <Problems error={error} /> : null}
    </div>
  );
};

/** The toggle in Block Studio's header that opens the guide. */
export const ConnectClaudeToggle = ({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) => {
  const t = useT();
  return (
    <Button
      variant="secondary"
      aria-expanded={open}
      aria-controls="design-connect-claude"
      onClick={onToggle}
    >
      {t('design.connectClaude')}
    </Button>
  );
};
